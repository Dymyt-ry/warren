// Warren hub: REST + SSE for the dashboard and bridges, MCP over Streamable
// HTTP for agents, A2A (Agent Card + message/send) for agents of other companies.
//
// Who is calling: people sign in with email + password and get a session
// cookie; agents present a bearer token. WARREN_ADMIN_TOKEN is an
// instance-wide bearer token for scripts.
import express, { type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import { closeDb, dbHealthy, tx } from "./db.js";
import { checkPassword, hashPassword, matchingTotpStep, newRecoveryCodes, newSecret, newTotpSecret, totpUri, verifyPassword } from "./auth.js";
import { createMcpServer } from "./mcp.js";
import { seedDemo } from "./seed.js";
import { joinWaitlist, RateLimited, waitlistCount, waitlistEntries } from "./waitlist.js";
import { canEmail, sendHeld, sendInvite, sendReset, sendWaitlistConfirmation } from "./email.js";
import { gateDecision } from "./safety.js";
import {
  ACCOUNT_LIMIT,
  ADMIN_TOKEN,
  CLIENT_IP_HEADER,
  DASHBOARD_OPEN,
  DELIVERY_LEASE_MS,
  DEMO,
  LANDING,
  LOGIN_LIMIT,
  PORT,
  PRODUCTION,
  PUBLIC_URL,
  PUBLIC_URL_OBJECT,
  SEED_DEMO,
  SETUP_TOKEN,
  STREAMS_PER_CALLER,
  STREAMS_TOTAL,
  TRUST_PROXY,
} from "./config.js";

const VERSION = "0.3.0";

// Demo mode (WARREN_DEMO=1) seeds the demo team with fixed tokens into a
// throwaway database, lets the dashboard sign in by picking a person, and
// shows the whole tree to visitors without a token. Off by default: a
// self-hosted hub starts empty and asks for its owner on the first visit.
// WARREN_DASHBOARD=closed (the hosted demo): the dashboard isn't served, and the
// demo's open doors close with it: no anonymous reads, no login by handle, no
// anonymous invites. The seeded team and its fixed tokens still work for invited agents.
const OPEN_DOORS = DEMO && DASHBOARD_OPEN;
const INVITE_DAYS = 7;
const RESET_HOURS = 24;

const app = express();
// Which proxies may set X-Forwarded-For. None by default: a client could otherwise
// rotate the header to dodge rate limits. Behind a reverse proxy, set it to the
// number of proxies in front of the hub (WARREN_TRUST_PROXY=1) or their addresses.
app.set("trust proxy", TRUST_PROXY);
// Behind a CDN that names the client in its own header (Cloudflare: cf-connecting-ip), set
// WARREN_CLIENT_IP_HEADER, and only when the origin accepts traffic from that CDN alone.
const clientIp = (req: Request) => {
  const header = CLIENT_IP_HEADER ? req.headers[CLIENT_IP_HEADER] : undefined;
  const value = Array.isArray(header) ? header[0] : header;
  return value && isIP(value) ? value : req.ip || "unknown";
};
app.disable("x-powered-by");
app.use((req, res, next) => {
  // Bearer-token API: any origin may call it. Cookies are never sent cross-origin (no credentials allowed).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'",
  );
  if (PUBLIC_URL_OBJECT.protocol === "https:") res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  if (req.path.startsWith("/api/") || req.path === "/mcp" || req.path === "/a2a")
    res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return void res.status(204).end();
  next();
});
app.use(express.json({ limit: "1mb" }));

// --- who is calling ------------------------------------------------------------

const COOKIE = "warren_session";

function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {} // malformed encoding: ignore that cookie
  }
  return out;
}

/** Credentials belong in an Authorization header or the httpOnly session cookie, never in a URL. */
function presentedToken(req: Request): string | undefined {
  return req.headers.authorization?.replace(/^Bearer\s+/i, "") || undefined;
}

const sessionId = (req: Request) => cookies(req)[COOKIE];

function sameSecret(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const isAdminToken = (req: Request) => sameSecret(presentedToken(req), ADMIN_TOKEN);

/** The member behind the bearer token (agent token, or a session id for scripts), else the session cookie. */
function caller(req: Request): store.Member | undefined {
  const token = presentedToken(req);
  if (token) return token.startsWith("ws_") ? store.sessionMember(token) : store.byTokenValue(token);
  return store.sessionMember(sessionId(req));
}

// Cookie sessions only work from the hub's own pages: a state-changing request
// carrying a session cookie must come from this origin. Browsers always send
// Origin on POST/PUT/DELETE, so another site can't ride on the cookie. Scripts
// without an Origin must use a bearer token instead of a browser session.
app.use((req, res, next) => {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method) || presentedToken(req) || !sessionId(req)) return next();
  const origin = req.headers.origin;
  let ok = false;
  try {
    ok = !!origin && new URL(origin).origin === PUBLIC_URL_OBJECT.origin;
  } catch {}
  if (!ok) return void res.status(403).json({ error: "cross-origin request refused" });
  next();
});

function requireCaller(req: Request, res: Response): store.Member | undefined {
  const m = caller(req);
  if (!m) res.status(401).json({ error: presentedToken(req) ? "unknown token" : "sign in first" });
  return m;
}

function requirePerson(req: Request, res: Response): store.Member | undefined {
  const m = requireCaller(req, res);
  if (m && m.kind !== "human") return void res.status(403).json({ error: "only a person can do this" });
  return m;
}

/** An owner or admin, or the admin token (returns null then). */
function requireAdmin(req: Request, res: Response): store.Member | null | undefined {
  if (isAdminToken(req)) return null;
  const m = requirePerson(req, res);
  if (m && !store.isAdmin(m)) return void res.status(403).json({ error: "only an owner or admin can do this" });
  return m;
}

/**
 * For read endpoints: the member, or undefined for the full overview (anonymous
 * in demo mode, or the admin token). Answers 401 and returns false for an
 * unknown token, or for an anonymous visitor outside demo mode.
 */
function reader(req: Request, res: Response): store.Member | undefined | false {
  const m = caller(req);
  if (m) return m;
  const token = presentedToken(req);
  if (sameSecret(token, ADMIN_TOKEN) || (OPEN_DOORS && !token)) return undefined;
  res.status(401).json({ error: token ? "unknown token" : "sign in first" });
  return false;
}

const httpError = (res: Response, status: number, e: unknown) => res.status(status).json({ error: (e as Error).message });
const statusFor = (e: unknown, fallback = 400) => ((e as Error).message.startsWith("no such") ? 404 : fallback);

function setSessionCookie(req: Request, res: Response, handle: string, recentlyAuthenticated = true) {
  const { id, expiresAt } = store.createSession(handle, recentlyAuthenticated);
  const secure = req.secure || PUBLIC_URL_OBJECT.protocol === "https:";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Expires=${expiresAt.toUTCString()}${secure ? "; Secure" : ""}`,
  );
  return id;
}

const activeSessionId = (req: Request) => {
  const bearer = presentedToken(req);
  return bearer?.startsWith("ws_") ? bearer : sessionId(req);
};

function clearSessionCookie(res: Response) {
  const secure = PUBLIC_URL_OBJECT.protocol === "https:" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

/**
 * Limits failed attempts at sign-in style endpoints: per client address, and per
 * account (the email tried), so rotating addresses doesn't buy more password
 * guesses. Successful requests don't count, so people behind one proxy address
 * don't lock each other out by signing in.
 */
function limiter(perIp: number, perAccount: number, windowMs: number, accountFor: (req: Request) => string = (req) =>
  typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "") {
  const fails = new Map<string, number[]>();
  const recent = (key: string, now: number) => (fails.get(key) ?? []).filter((t) => now - t < windowMs);
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    const route = req.route?.path ?? req.path;
    const account = accountFor(req);
    const keys = [`${route}|ip|${clientIp(req)}`, ...(account ? [`${route}|acct|${account}`] : [])];
    const limits = [perIp, perAccount];
    if (keys.some((k, i) => recent(k, now).length >= limits[i]))
      return void res.status(429).json({ error: "too many failed attempts, try again in 15 minutes" });
    res.on("finish", () => {
      if (res.statusCode < 400 || res.statusCode === 429 || res.locals.rateLimitNeutral) return;
      for (const k of keys) fails.set(k, [...recent(k, Date.now()), Date.now()]);
      if (fails.size > 50_000) fails.clear();
    });
    next();
  };
}
const signInLimit = limiter(LOGIN_LIMIT, ACCOUNT_LIMIT, 15 * 60_000);
const authenticatedLimit = limiter(
  LOGIN_LIMIT,
  ACCOUNT_LIMIT,
  15 * 60_000,
  (req) => caller(req)?.handle ?? store.approverHandleForKey(presentedToken(req)) ?? "",
);

function useTotp(handle: string, code: unknown): boolean {
  const secret = store.totpSecretOf(handle);
  const step = secret ? matchingTotpStep(secret, code) : null;
  return step !== null && store.useTotpStep(handle, step);
}

/** What a person sees about themselves: their member record with email and settings. */
const self = (m: store.Member) => ({
  ...store.publicMember(m),
  email: m.email,
  prefs: m.prefs,
  ...(m.twoFactor ? { recoveryCodesLeft: store.recoveryCodesLeft(m.handle) } : {}),
});

// --- MCP (stateless: fresh server + transport per request) -----------------
app.post("/mcp", async (req, res) => {
  const m = requireCaller(req, res);
  if (!m) return;
  const server = createMcpServer(m);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.get("/mcp", (_req, res) => void res.status(405).end());

// --- instance and accounts ---------------------------------------------------

app.get("/api/config", (_req, res) =>
  void res.json({
    dashboard: DASHBOARD_OPEN,
    demo: OPEN_DOORS,
    needsSetup: !DEMO && !store.isSetUp(),
    setupToken: !!SETUP_TOKEN,
    instanceName: store.instanceName(),
    email: canEmail(),
    privacyContact: store.privacyContact(),
    retentionDays: store.retentionDays(),
    version: VERSION,
  }),
);

// Instance settings for owners and admins: name, message retention, privacy contact.
app.put("/api/instance", (req, res) => {
  const actor = requireAdmin(req, res);
  if (actor === undefined) return;
  const b = req.body ?? {};
  if (b.name !== undefined) store.setInstanceName(String(b.name));
  if (b.retentionDays !== undefined) {
    const days = Number(b.retentionDays);
    if (!Number.isFinite(days) || days < 0 || days > 36500) return void res.status(400).json({ error: "retentionDays must be 0 (keep) or a number of days" });
    store.setRetentionDays(days);
    store.sweep();
  }
  if (b.privacyContact !== undefined) store.setPrivacyContact(String(b.privacyContact));
  store.audit({ type: "policy", roomId: "*", actor: actor?.handle ?? "admin-token", detail: `changed instance settings: ${Object.keys(b).join(", ")}` });
  res.json({ instanceName: store.instanceName(), retentionDays: store.retentionDays(), privacyContact: store.privacyContact() });
});

// First run: whoever opens the hub first creates the owner account (as in n8n
// or Coolify). Set WARREN_SETUP_TOKEN to require a secret for it.
app.post("/api/setup", signInLimit, (req, res) => {
  if (DEMO) return void res.status(404).json({ error: "a demo hub has no owner" });
  if (store.isSetUp()) return void res.status(409).json({ error: "this hub already has an owner; sign in instead" });
  const b = req.body ?? {};
  if (SETUP_TOKEN && !sameSecret(String(b.setupToken ?? ""), SETUP_TOKEN))
    return void res.status(403).json({ error: "wrong setup token (see WARREN_SETUP_TOKEN in the hub's environment)" });
  try {
    if (!b.email) throw new Error("email is required");
    const passwordHash = hashPassword(checkPassword(b.password));
    const owner = store.addMember({
      handle: b.handle || undefined,
      name: b.name,
      kind: "human",
      org: b.org,
      scopeRoomId: null,
      role: "owner",
      email: b.email,
      passwordHash,
    });
    store.setInstanceName(String(b.instanceName ?? b.org));
    const firstRoom = String(b.room ?? "").trim();
    if (firstRoom) store.createRoom(firstRoom, null, "", owner.handle, true);
    setSessionCookie(req, res, owner.handle);
    console.log(`owner @${owner.handle} created`);
    res.status(201).json(self(owner));
  } catch (e) {
    httpError(res, 400, e);
  }
});

app.post("/api/auth/login", signInLimit, (req, res) => {
  const email = String(req.body?.email ?? "");
  const password = String(req.body?.password ?? "");
  const m = store.memberByEmail(email);
  // Always verify, so a wrong email takes as long as a wrong password.
  const ok = verifyPassword(password, m ? store.passwordHashOf(m.handle) : null);
  if (!m || !ok) return void res.status(401).json({ error: "wrong email or password" });
  if (m.twoFactor) {
    const code = req.body?.code;
    if (!code) {
      res.locals.rateLimitNeutral = true; // The password was right; this is a challenge, not a failed guess.
      return void res.status(401).json({ error: "enter the code from your authenticator app", twoFactor: true });
    }
    if (!useTotp(m.handle, code) && !store.useRecoveryCode(m.handle, code))
      return void res.status(401).json({ error: "that code didn't work; try the next one, or a recovery code", twoFactor: true });
  }
  setSessionCookie(req, res, m.handle);
  res.json(self(m));
});

app.post("/api/auth/logout", (req, res) => {
  const bearer = presentedToken(req);
  const id = bearer?.startsWith("ws_") ? bearer : sessionId(req);
  if (id) store.endSession(id);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// Demo sign-in: pick a person by handle. Only in demo mode.
app.post("/api/login", (req, res) => {
  if (!OPEN_DOORS) return void res.status(404).json({ error: "login by handle is only available in demo mode" });
  const m = store.getMember(String(req.body?.handle ?? ""));
  if (!m || m.kind !== "human" || m.disabled) return void res.status(404).json({ error: "no such person" });
  const token = setSessionCookie(req, res, m.handle, false);
  res.json({ ...self(m), token });
});

app.get("/api/me", (req, res) => {
  const m = requireCaller(req, res);
  if (m) res.json(self(m));
});

app.put("/api/me", (req, res) => {
  const m = requirePerson(req, res);
  if (!m) return;
  try {
    res.json(self(store.updateMember(m.handle, { name: req.body?.name })));
  } catch (e) {
    httpError(res, 400, e);
  }
});

// Change your password: needs the current one; signs you out everywhere else.
app.post("/api/me/password", authenticatedLimit, (req, res) => {
  const m = requirePerson(req, res);
  if (!m) return;
  if (!verifyPassword(String(req.body?.current ?? ""), store.passwordHashOf(m.handle)))
    return void res.status(403).json({ error: "your current password is wrong" });
  try {
    store.setPasswordHash(m.handle, hashPassword(checkPassword(req.body?.password)));
    const current = activeSessionId(req);
    store.endSessions(m.handle, current);
    if (current) store.markSessionAuthenticated(current, m.handle);
    res.json({ ok: true });
  } catch (e) {
    httpError(res, 400, e);
  }
});

// Your settings: language, theme, and how strictly messages to your agents are held.
app.put("/api/me/prefs", (req, res) => {
  const m = requirePerson(req, res);
  if (!m) return;
  try {
    const before = m.prefs.holdAllForeign;
    const updated = store.setPrefs(m.handle, req.body ?? {});
    if (before !== updated.prefs.holdAllForeign)
      store.audit({
        type: "policy",
        roomId: m.scopeRoomId ?? "*",
        actor: m.handle,
        detail: `${updated.prefs.holdAllForeign ? "holds every" : "holds only suspicious"} message from other companies to @${m.handle}'s agents`,
      });
    res.json(self(updated));
  } catch (e) {
    httpError(res, 400, e);
  }
});

// Two-factor sign-in (TOTP). Setup returns a secret to scan; enable confirms it with a code.
app.post("/api/me/2fa/setup", authenticatedLimit, (req, res) => {
  const m = requirePerson(req, res);
  if (!m) return;
  if (m.twoFactor) return void res.status(409).json({ error: "two-factor sign-in is already on" });
  const current = activeSessionId(req);
  if (!current || store.sessionMember(current)?.handle !== m.handle)
    return void res.status(401).json({ error: "sign in with your password before setting up two-factor sign-in" });
  if (!store.sessionRecentlyAuthenticated(current, m.handle)) {
    if (!verifyPassword(String(req.body?.password ?? ""), store.passwordHashOf(m.handle)))
      return void res.status(403).json({ error: "enter your password again before setting up two-factor sign-in" });
    store.markSessionAuthenticated(current, m.handle);
  }
  const secret = newTotpSecret();
  const expiresAt = store.setPendingTotp(m.handle, secret, current);
  res.json({ secret, uri: totpUri(secret, m.email ?? m.handle, `Warren (${store.instanceName()})`), expiresAt });
});

app.post("/api/me/2fa/enable", authenticatedLimit, (req, res) => {
  const m = requirePerson(req, res);
  if (!m) return;
  const current = activeSessionId(req);
  if (!current) return void res.status(409).json({ error: "start the setup again in this signed-in session" });
  const pending = store.pendingTotpOf(m.handle, current);
  if (!pending) return void res.status(409).json({ error: "start the setup again in this signed-in session" });
  const step = matchingTotpStep(pending.secret, req.body?.code);
  if (step === null) return void res.status(400).json({ error: "that code didn't match; check the time on your phone and try the next one" });
  const codes = newRecoveryCodes();
  if (!store.enableTotp(m.handle, pending.secret, codes, step, current))
    return void res.status(409).json({ error: "that setup expired; start it again" });
  store.endSessions(m.handle, current);
  store.audit({ type: "member", roomId: "*", actor: m.handle, target: m.handle, detail: `@${m.handle} turned on two-factor sign-in` });
  res.json({ recoveryCodes: codes });
});

app.post("/api/me/2fa/disable", authenticatedLimit, (req, res) => {
  const m = requirePerson(req, res);
  if (!m) return;
  if (!verifyPassword(String(req.body?.password ?? ""), store.passwordHashOf(m.handle))) return void res.status(403).json({ error: "your password is wrong" });
  if (!useTotp(m.handle, req.body?.code) && !store.useRecoveryCode(m.handle, req.body?.code))
    return void res.status(403).json({ error: "enter a current code or a recovery code" });
  store.disableTotp(m.handle);
  store.audit({ type: "member", roomId: "*", actor: m.handle, target: m.handle, detail: `@${m.handle} turned off two-factor sign-in` });
  res.json(self(m));
});

app.post("/api/me/2fa/recovery-codes", authenticatedLimit, (req, res) => {
  const m = requirePerson(req, res);
  if (!m) return;
  if (!m.twoFactor) return void res.status(409).json({ error: "two-factor sign-in is not on" });
  if (!verifyPassword(String(req.body?.password ?? ""), store.passwordHashOf(m.handle)))
    return void res.status(403).json({ error: "your password is wrong" });
  if (!useTotp(m.handle, req.body?.code) && !store.useRecoveryCode(m.handle, req.body?.code))
    return void res.status(403).json({ error: "enter a current code or a recovery code" });
  const codes = newRecoveryCodes();
  store.replaceRecoveryCodes(m.handle, codes);
  store.audit({ type: "member", roomId: "*", actor: m.handle, target: m.handle, detail: `@${m.handle} regenerated two-factor recovery codes` });
  res.json({ recoveryCodes: codes });
});

// Approver keys: put one next to your agents so you can approve held messages from inside their session.
app.get("/api/me/approver-keys", (req, res) => {
  const m = requirePerson(req, res);
  if (m) res.json(store.approverKeys(m.handle));
});

app.post("/api/me/approver-keys", (req, res) => {
  const m = requirePerson(req, res);
  if (!m) return;
  const { key, id } = store.createApproverKey(m.handle, String(req.body?.label ?? ""));
  store.audit({ type: "member", roomId: "*", actor: m.handle, target: m.handle, detail: `@${m.handle} created an approver key` });
  res.status(201).json({ id, key });
});

app.delete("/api/me/approver-keys/:id", (req, res) => {
  const m = requirePerson(req, res);
  if (!m) return;
  if (!store.deleteApproverKey(m.handle, req.params.id)) return void res.status(404).json({ error: "no such key" });
  res.json({ ok: true });
});

// Your data, as JSON (GDPR art. 15, 20).
app.get("/api/me/export", (req, res) => {
  const m = requirePerson(req, res);
  if (!m) return;
  res.setHeader("Content-Disposition", `attachment; filename="warren-${m.handle}.json"`);
  res.json(store.exportFor(m.handle));
});

// Delete your account (GDPR art. 17). { password, deleteMessages }
app.delete("/api/me", authenticatedLimit, (req, res) => {
  const m = requirePerson(req, res);
  if (!m) return;
  if (m.role === "owner") return void res.status(403).json({ error: "the owner can't leave; hand over ownership in Settings first" });
  if (m.email && !verifyPassword(String(req.body?.password ?? ""), store.passwordHashOf(m.handle)))
    return void res.status(403).json({ error: "your password is wrong" });
  store.eraseMember(m.handle, req.body?.deleteMessages === true, m.handle);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// --- approving held messages from inside an agent's session ----------------------
// The bridge next to your agent holds your approver key (not the agent's token):
// it shows you the held text in a dialog (Claude Code) or its terminal and sends
// your answer here. It can only decide for your own agents.

function approver(req: Request, res: Response): store.Member | undefined {
  const m = store.byApproverKey(presentedToken(req));
  if (!m) res.status(401).json({ error: "missing or unknown approver key" });
  return m;
}

app.get("/api/session-review/:id", authenticatedLimit, (req, res) => {
  const m = approver(req, res);
  if (!m) return;
  const msg = store.getMessage(String(req.params.id));
  const mine = msg && store.decisionsFor(m, msg).keys.length > 0;
  if (!msg || !mine) return void res.status(404).json({ error: "nothing waits for you on that message" });
  const agents = Object.entries(msg.safety.approvals ?? {})
    .filter(([k]) => k === m.handle || k === `org:${m.org}`)
    .flatMap(([, a]) => a.agents);
  res.json({ id: msg.id, roomId: msg.roomId, from: msg.from, fromKind: msg.fromKind, org: msg.org, kind: msg.kind, text: msg.text, flags: msg.safety.flags, at: msg.at, agents });
});

app.post("/api/session-review/:id", authenticatedLimit, (req, res) => {
  const m = approver(req, res);
  if (!m) return;
  const decision = req.body?.decision;
  if (decision !== "release" && decision !== "reject") return void res.status(400).json({ error: 'decision must be "release" or "reject"' });
  try {
    const msg = store.review(m, String(req.params.id), decision, "agents");
    res.json({ id: msg.id, status: msg.safety.status, yours: decision === "release" ? "released" : "rejected" });
  } catch (e) {
    const t = (e as Error).message;
    httpError(res, t.startsWith("no such") ? 404 : t.includes("not held") ? 409 : 403, e);
  }
});

// Email the people a held message waits for (when they want that and SMTP is set up).
store.events.on("held", (msg: store.Message) => {
  for (const key of Object.keys(msg.safety.approvals ?? {})) {
    const person = key.startsWith("org:") ? undefined : store.getMember(key);
    if (!person?.email || !person.prefs.emailOnHold || person.disabled) continue;
    void sendHeld(person.email, {
      url: `${PUBLIC_URL}/app?review=${msg.id}`,
      instance: store.instanceName(),
      from: `@${msg.from} (${msg.org})`,
      agents: msg.safety.approvals![key].agents.map((a) => "@" + a).join(", "),
      flags: msg.safety.flags.join(", "),
    });
  }
});

// --- people: invites, joining, password resets, management ----------------------

const linkUrl = (kind: "invite" | "reset", code: string) => `${PUBLIC_URL}/app?${kind}=${code}`;

/** An invite as its creator and admins see it (never the code: that's shown once). */
function inviteView(l: store.Link) {
  return {
    id: l.id,
    email: l.email,
    org: l.org,
    room: l.scopeRoomId,
    roomName: l.scopeRoomId ? store.getRoom(l.scopeRoomId)?.name ?? null : null,
    role: l.role,
    invitedBy: l.createdBy,
    createdAt: l.createdAt,
    expiresAt: l.expiresAt,
  };
}

/**
 * Invite a person: returns a one-time link (and emails it when SMTP is set up).
 * Who may invite whom:
 *  - any person, into a room they see, into their own company;
 *  - owners and admins anywhere, any company, also as admins (who see every room).
 * A guest can't invite someone "from" the host company: org is a trust boundary.
 */
async function invitePerson(req: Request, res: Response, inviter: store.Member | null) {
  const b = req.body ?? {};
  const admin = inviter === null || store.isAdmin(inviter);
  const role: store.Role = b.role === "admin" ? "admin" : "member";
  const room: string | null = role === "admin" ? null : b.room || inviter?.scopeRoomId || null;
  const org = String(b.org ?? inviter?.org ?? "").trim();
  if (!org) return void res.status(400).json({ error: "org is required" });
  if (role === "admin" && !admin) return void res.status(403).json({ error: "only an owner or admin can invite admins" });
  if (room === null && role === "member") return void res.status(400).json({ error: "pick a room to invite into; only admins see every room" });
  if (room !== null && !store.getRoom(room)) return void res.status(404).json({ error: `no such room ${room}` });
  if (room !== null && inviter && !store.canSee(inviter, room)) return void res.status(403).json({ error: `no access to room ${room}` });
  if (!admin && org !== inviter!.org)
    return void res.status(403).json({ error: `you can invite people of ${inviter!.org} only; ask an admin to invite another company` });
  const email = String(b.email ?? "").trim().toLowerCase() || null;
  if (email && store.memberByEmail(email)) return void res.status(409).json({ error: "someone with that email is already here" });
  const { link, code } = store.createLink(
    { purpose: "invite", email, org, scopeRoomId: room, role, handle: null, createdBy: inviter?.handle ?? null },
    INVITE_DAYS,
  );
  const url = linkUrl("invite", code);
  const emailed = email
    ? await sendInvite(email, {
        url,
        instance: store.instanceName(),
        invitedBy: inviter?.name ?? "An admin",
        room: room ? store.getRoom(room)!.name : "every room",
        expiresAt: link.expiresAt,
      })
    : false;
  res.status(201).json({ ...inviteView(link), url, emailed });
}

// Invite a person (kind: "human"), or add an agent (any other kind: the older
// shape of POST /api/agents, kept for scripts).
app.post("/api/invites", async (req, res) => {
  if (req.body?.kind === "human") {
    if (isAdminToken(req)) return invitePerson(req, res, null);
    const m = requirePerson(req, res);
    if (m) await invitePerson(req, res, m);
    return;
  }
  createAgent(req, res);
});

app.get("/api/invites", (req, res) => {
  if (isAdminToken(req)) return void res.json(store.pendingInvites().map(inviteView));
  const m = requirePerson(req, res);
  if (m) res.json(store.pendingInvites(store.isAdmin(m) ? undefined : m.handle).map(inviteView));
});

app.delete("/api/invites/:id", (req, res) => {
  const m = isAdminToken(req) ? null : requirePerson(req, res);
  if (m === undefined) return;
  const link = store.getLink(req.params.id);
  if (!link || link.purpose !== "invite") return void res.status(404).json({ error: "no such invite" });
  if (m && !store.isAdmin(m) && link.createdBy !== m.handle) return void res.status(403).json({ error: "only who sent it or an admin can revoke an invite" });
  store.deleteLink(link.id);
  res.json({ ok: true });
});

// The invite behind a link, so the join page can say where it leads.
app.get("/api/join/:code", (req, res) => {
  const link = store.findLink(req.params.code, "invite");
  if (!link) return void res.status(404).json({ error: "this invite link is used up, expired or revoked" });
  const by = link.createdBy ? store.getMember(link.createdBy) : undefined;
  res.json({
    instanceName: store.instanceName(),
    org: link.org,
    room: link.scopeRoomId ? store.getRoom(link.scopeRoomId)?.name : null,
    role: link.role,
    email: link.email,
    invitedBy: by?.name ?? null,
    expiresAt: link.expiresAt,
  });
});

app.post("/api/join/:code", signInLimit, (req, res) => {
  const link = store.findLink(req.params.code, "invite");
  if (!link) return void res.status(404).json({ error: "this invite link is used up, expired or revoked" });
  const b = req.body ?? {};
  try {
    const passwordHash = hashPassword(checkPassword(b.password));
    if (!link.email && !b.email) throw new Error("email is required");
    // Claim the link and create the account together: if either fails, neither happens.
    const m = tx(() => {
      if (!store.useLink(link.id, null)) throw new Error("this invite link was just used, revoked or has expired");
      const created = store.addMember({
        handle: b.handle || undefined,
        name: b.name,
        kind: "human",
        org: link.org!,
        scopeRoomId: link.scopeRoomId,
        role: link.role ?? "member",
        email: link.email ?? b.email,
        passwordHash,
      });
      store.markLinkUser(link.id, created.handle);
      return created;
    });
    store.audit({ type: "member", roomId: m.scopeRoomId ?? "*", actor: m.handle, target: link.createdBy ?? undefined, detail: `@${m.handle} (${m.org}) joined` });
    setSessionCookie(req, res, m.handle);
    res.status(201).json(self(m));
  } catch (e) {
    httpError(res, 400, e);
  }
});

app.get("/api/reset/:code", (req, res) => {
  const link = store.findLink(req.params.code, "reset");
  const m = link?.handle ? store.getMember(link.handle) : undefined;
  if (!link || !m || m.disabled) return void res.status(404).json({ error: "this reset link is used up or expired" });
  res.json({ instanceName: store.instanceName(), email: m.email, name: m.name, twoFactor: m.twoFactor });
});

app.post("/api/reset/:code", signInLimit, (req, res) => {
  const link = store.findLink(req.params.code, "reset");
  const m = link?.handle ? store.getMember(link.handle) : undefined;
  if (!link || !m || m.disabled) return void res.status(404).json({ error: "this reset link is used up or expired" });
  try {
    const hash = hashPassword(checkPassword(req.body?.password));
    tx(() => {
      if (!store.useLink(link.id, m.handle)) throw new Error("this reset link was just used or has expired");
      store.setPasswordHash(m.handle, hash);
      store.endSessions(m.handle);
    });
    // A reset link replaces only the password factor. For a 2FA account it
    // must not create a fully authenticated session by itself.
    if (m.twoFactor) {
      clearSessionCookie(res);
      return void res.json({ ok: true, twoFactor: true, requiresLogin: true });
    }
    setSessionCookie(req, res, m.handle);
    res.json(self(m));
  } catch (e) {
    httpError(res, 400, e);
  }
});

// Everyone with an account, for owners and admins.
app.get("/api/users", (req, res) => {
  if (requireAdmin(req, res) === undefined) return;
  res.json(
    store
      .allMembers()
      .filter((m) => m.kind === "human")
      .map((m) => ({ ...self(m), agents: store.allMembers().filter((a) => a.owner === m.handle).length })),
  );
});

// Change someone's role, company, access or name. Making someone owner hands
// over ownership: only the owner can, and becomes an admin.
app.put("/api/users/:handle", (req, res) => {
  const actor = requireAdmin(req, res);
  if (actor === undefined) return;
  const target = store.getMember(req.params.handle);
  if (!target || target.disabled || target.kind !== "human") return void res.status(404).json({ error: "no such person" });
  const b = req.body ?? {};
  const actorHandle = actor?.handle ?? "admin-token";
  try {
    if (target.role === "owner" && actor?.role !== "owner" && actor !== null) throw new Error("only the owner can change the owner's account");
    if (b.role === "owner" && actor?.role !== "owner") throw new Error("only the owner can hand over ownership");
    if (target.handle === actor?.handle && b.role && b.role !== target.role) throw new Error("you can't change your own role");
    const patch: Parameters<typeof store.updateMember>[1] = {};
    if (b.name !== undefined) patch.name = b.name;
    if (b.org !== undefined) patch.org = b.org;
    if (b.role !== undefined) patch.role = b.role;
    if (b.room !== undefined) patch.scopeRoomId = b.room || null;
    const nextRole = patch.role ?? target.role;
    if (nextRole === "admin" || nextRole === "owner") patch.scopeRoomId = null; // admins see every room
    else if ((patch.scopeRoomId ?? target.scopeRoomId) === null) throw new Error("a member needs a room; pick which part of the tree they see");
    // Target first: if the patch is invalid nothing changed; demoting the old owner can't fail after it.
    const updated = store.updateMember(target.handle, patch);
    if (b.role === "owner" && actor) store.updateMember(actor.handle, { role: "admin" });
    store.reconcileAgents(updated.handle, actorHandle);
    store.audit({ type: "member", roomId: "*", actor: actorHandle, target: target.handle, detail: `changed @${target.handle}: ${Object.keys(b).join(", ")}` });
    res.json(self(updated));
  } catch (e) {
    httpError(res, 400, e);
  }
});

app.delete("/api/users/:handle", (req, res) => {
  const actor = requireAdmin(req, res);
  if (actor === undefined) return;
  const target = store.getMember(req.params.handle);
  if (!target || target.disabled || target.kind !== "human") return void res.status(404).json({ error: "no such person" });
  if (target.role === "owner") return void res.status(403).json({ error: "the owner can't be removed; hand over ownership first" });
  if (target.handle === actor?.handle) return void res.status(403).json({ error: "you can't remove yourself" });
  store.disableMember(target.handle, actor?.handle ?? "admin-token");
  res.json({ ok: true });
});

// A password reset link for someone: emailed when SMTP is set up, otherwise
// handed to the admin to pass on (as in n8n without email).
app.post("/api/users/:handle/reset", async (req, res) => {
  const actor = requireAdmin(req, res);
  if (actor === undefined) return;
  const target = store.getMember(req.params.handle);
  if (!target || target.disabled || target.kind !== "human") return void res.status(404).json({ error: "no such person" });
  if (target.role === "owner" && actor && actor.role !== "owner") return void res.status(403).json({ error: "only the owner can reset the owner's password" });
  const { link, code } = store.createLink(
    { purpose: "reset", email: target.email, org: null, scopeRoomId: null, role: null, handle: target.handle, createdBy: actor?.handle ?? null },
    RESET_HOURS / 24,
  );
  const url = linkUrl("reset", code);
  const emailed = target.email ? await sendReset(target.email, { url, instance: store.instanceName(), expiresAt: link.expiresAt }) : false;
  res.status(201).json({ url, emailed, expiresAt: link.expiresAt });
});

// --- agents --------------------------------------------------------------------

/** People manage their own agents; owners and admins manage everyone's. */
function manageableAgent(req: Request, res: Response): { actor: store.Member | null; agent: store.Member } | undefined {
  const actor = isAdminToken(req) ? null : requirePerson(req, res);
  if (actor === undefined) return;
  const agent = store.getMember(req.params.handle as string);
  if (!agent || agent.disabled || agent.kind !== "agent") return void res.status(404).json({ error: "no such agent" });
  if (actor && !store.isAdmin(actor) && (agent.owner !== actor.handle || !store.canSee(actor, agent.scopeRoomId!) || agent.org !== actor.org))
    return void res.status(403).json({ error: `@${agent.handle} belongs to ${agent.owner ? "@" + agent.owner : "nobody"}; only they or an admin can change it` });
  return { actor, agent };
}

/**
 * Add an agent: a member with a bearer token, scoped to one room, owned by the
 * person who added it and of their company. Returns the token once, with setup.
 */
function createAgent(req: Request, res: Response) {
  const b = req.body ?? {};
  const admin = isAdminToken(req);
  const m = admin ? undefined : caller(req);
  if (!admin && presentedToken(req) && !m) return void res.status(401).json({ error: "unknown token" });
  if (!admin && !m && !OPEN_DOORS) return void res.status(401).json({ error: "sign in first" });
  if (m && m.kind !== "human") return void res.status(403).json({ error: "agents can't add members; ask your person" });
  if (!b.room) return void res.status(400).json({ error: "room is required: an agent sees one room and the rooms inside it" });
  if (m && !store.canSee(m, b.room)) return void res.status(403).json({ error: `no access to room ${b.room}` });
  if (m && !store.isAdmin(m) && b.org && b.org !== m.org)
    return void res.status(403).json({ error: `your agents belong to ${m.org}; ask an admin to add another company's agent` });
  try {
    const token = newSecret("wr");
    const agent = store.addMember({
      handle: b.handle || undefined,
      name: b.name ?? b.agentName ?? b.handle,
      kind: "agent",
      // Any owned agent is always in its owner's trust boundary, including
      // agents created by an owner/admin. Only admin-token agents are unowned.
      org: m?.org ?? b.org,
      scopeRoomId: b.room,
      adapter: b.adapter,
      token,
      owner: m?.handle ?? null,
    });
    store.audit({ type: "member", roomId: agent.scopeRoomId!, actor: m?.handle ?? "hub", target: agent.handle, detail: `added agent @${agent.handle}` });
    res.status(201).json({ ...store.publicMember(agent), token, invitedBy: m?.handle ?? null, setup: setupSnippets(agent, token) });
  } catch (e) {
    httpError(res, 400, e);
  }
}

app.post("/api/agents", createAgent);

app.get("/api/agents", (req, res) => {
  const all = isAdminToken(req);
  const m = all ? undefined : requirePerson(req, res);
  if (!all && !m) return;
  res.json(
    store
      .allMembers()
      .filter((a) => a.kind === "agent" && (all || store.isAdmin(m) || a.owner === m!.handle))
      .map(store.publicMember),
  );
});

app.put("/api/agents/:handle", (req, res) => {
  const ok = manageableAgent(req, res);
  if (!ok) return;
  const b = req.body ?? {};
  if (b.room !== undefined && ok.actor && !store.canSee(ok.actor, b.room)) return void res.status(403).json({ error: `no access to room ${b.room}` });
  try {
    res.json(store.publicMember(store.updateMember(ok.agent.handle, { name: b.name, adapter: b.adapter, scopeRoomId: b.room })));
  } catch (e) {
    httpError(res, 400, e);
  }
});

// New token for an agent; the old one stops working at once (open streams are closed).
app.post("/api/agents/:handle/token", (req, res) => {
  const ok = manageableAgent(req, res);
  if (!ok) return;
  const token = store.rotateToken(ok.agent.handle);
  store.audit({ type: "member", roomId: ok.agent.scopeRoomId!, actor: ok.actor?.handle ?? "admin-token", target: ok.agent.handle, detail: `new token for @${ok.agent.handle}` });
  res.json({ ...store.publicMember(ok.agent), token, setup: setupSnippets(ok.agent, token) });
});

app.delete("/api/agents/:handle", (req, res) => {
  const ok = manageableAgent(req, res);
  if (!ok) return;
  store.disableMember(ok.agent.handle, ok.actor?.handle ?? "admin-token");
  res.json({ ok: true });
});

// Members, without credentials. ?room=<id>: that room's members. With a
// token: the members who share at least one room with the caller. Otherwise everyone.
app.get("/api/members", (req, res) => {
  const room = req.query.room as string | undefined;
  const m = reader(req, res);
  if (m === false) return;
  if (room && (!store.getRoom(room) || (m && !store.canSee(m, room)))) return void res.status(404).json({ error: "no such room" });
  const list = room ? store.roomMembers(room) : m ? store.contactsOf(m) : store.allMembers();
  res.json(list.map(store.publicMember));
});

// --- REST: rooms and messages ------------------------------------------------

// With a token: the rooms that member can see. Without: the whole tree (demo overview).
app.get("/api/rooms", (req, res) => {
  const m = reader(req, res);
  if (m === false) return;
  const asked = Math.floor(Number(req.query.history ?? store.HISTORY));
  const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, store.HISTORY) : store.HISTORY;
  res.json((m ? store.visibleRooms(m) : store.allRooms()).map((r) => store.roomView(m, r, limit)));
});

app.get("/api/rooms/:id", (req, res) => {
  const m = reader(req, res);
  if (m === false) return;
  const room = store.getRoom(req.params.id);
  if (!room || (m && !store.canSee(m, room.id))) return void res.status(404).json({ error: "no such room" });
  res.json({ ...store.roomView(m, room), members: store.roomMembers(room.id).map(store.publicMember) });
});

// New room under a room the caller can see. Top-level rooms: owners and admins.
app.post("/api/rooms", (req, res) => {
  const { name, parentId = null, context = "" } = req.body ?? {};
  let by: string | null = null;
  if (!isAdminToken(req)) {
    const m = requireCaller(req, res);
    if (!m) return;
    by = store.responsible(m);
    if (parentId ? !store.canSee(m, parentId) : !(store.isAdmin(m) && m.scopeRoomId === null))
      return void res.status(403).json({ error: parentId ? `no access to room ${parentId}` : "only an owner or admin can add top-level rooms" });
  }
  try {
    res.status(201).json(store.roomView(undefined, store.createRoom(name, parentId, context, by)));
  } catch (e) {
    httpError(res, 400, e);
  }
});

/** May `m` restructure this room? It must be inside their access, not the room their access starts at. */
function canRestructure(m: store.Member, roomId: string): boolean {
  const room = store.getRoom(roomId);
  if (!room || !store.canSee(m, roomId)) return false;
  if (m.scopeRoomId === null) return true;
  return room.id !== m.scopeRoomId;
}

// Rename and/or move a room: { name?, parentId? } (parentId null = top level, admins only).
app.put("/api/rooms/:id", (req, res) => {
  const admin = isAdminToken(req);
  const m = admin ? null : requirePerson(req, res);
  if (m === undefined) return;
  const id = req.params.id;
  if (!store.getRoom(id) || (m && !store.canSee(m, id))) return void res.status(404).json({ error: "no such room" });
  const b = req.body ?? {};
  const actor = m?.handle ?? "admin-token";
  try {
    if (m && !canRestructure(m, id)) throw new Error("the room your access starts at belongs to whoever invited you; ask them to rename or move it");
    if (b.parentId !== undefined) {
      if (b.parentId === null && m && !(store.isAdmin(m) && m.scopeRoomId === null)) throw new Error("only an owner or admin can move a room to the top");
      if (b.parentId !== null && m && !store.canSee(m, b.parentId)) throw new Error(`no access to room ${b.parentId}`);
      if (b.parentId !== store.getRoom(id)!.parentId) store.moveRoom(id, b.parentId, actor);
    }
    if (b.name !== undefined && b.name !== store.getRoom(id)!.name) store.renameRoom(id, b.name, actor);
    res.json(store.roomView(m ?? undefined, store.getRoom(id)!));
  } catch (e) {
    httpError(res, 403, e);
  }
});

// Delete a room with everything inside it: owners and admins, or the person who created it.
app.delete("/api/rooms/:id", (req, res) => {
  const admin = isAdminToken(req);
  const m = admin ? null : requirePerson(req, res);
  if (m === undefined) return;
  const room = store.getRoom(req.params.id);
  if (!room || (m && !store.canSee(m, room.id))) return void res.status(404).json({ error: "no such room" });
  if (m && !canRestructure(m, room.id)) return void res.status(403).json({ error: "you can't delete the room your access starts at" });
  if (m && !store.isAdmin(m) && room.createdBy !== m.handle)
    return void res.status(403).json({ error: "only the person who created this room or an admin can delete it" });
  try {
    res.json({ deleted: store.deleteRoom(room.id, m?.handle ?? "admin-token") });
  } catch (e) {
    httpError(res, 409, e);
  }
});

app.put("/api/rooms/:id/context", (req, res) => {
  const m = requireCaller(req, res);
  if (!m) return;
  try {
    res.json(store.roomView(m, store.updateContext(m, req.params.id, String(req.body?.context ?? ""))));
  } catch (e) {
    httpError(res, 403, e);
  }
});

app.get("/api/rooms/:id/messages", (req, res) => {
  const m = reader(req, res);
  if (m === false) return;
  const room = store.getRoom(req.params.id);
  if (!room || (m && !store.canSee(m, room.id))) return void res.status(404).json({ error: "no such room" });
  res.json(store.recentMessages(room.id).map((x) => store.viewFor(m, x)));
});

app.get("/api/messages/:id", (req, res) => {
  const m = reader(req, res);
  if (m === false) return;
  const msg = store.getMessage(req.params.id);
  if (!msg || (m && !store.canSee(m, msg.roomId))) return void res.status(404).json({ error: "no such message" });
  res.json(store.withDeliveries(m, store.viewFor(m, msg)));
});

app.post("/api/rooms/:id/messages", (req, res) => {
  const m = requireCaller(req, res);
  if (!m) return;
  // Same answer for a room that doesn't exist and one you can't see: no telling them apart.
  if (!store.canSee(m, req.params.id)) return void res.status(404).json({ error: "no such room" });
  try {
    const posted = store.post(m, req.params.id, req.body?.kind ?? "note", req.body?.text);
    res.status(201).json(store.withDeliveries(m, posted));
  } catch (e) {
    httpError(res, store.canSee(m, req.params.id) ? 400 : 403, e);
  }
});

// Claims and file locks. The room's claims ride along on GET /api/rooms and SSE "room" events.
app.post("/api/rooms/:id/claims", (req, res) => {
  const m = requireCaller(req, res);
  if (!m) return;
  try {
    res.status(201).json(store.claim(m, req.params.id, req.body?.task, req.body?.files ?? []));
  } catch (e) {
    const msg = (e as Error).message;
    httpError(res, !store.canSee(m, req.params.id) ? 403 : msg.includes("is locked by") ? 409 : 400, e);
  }
});

// ?force=1 lets a person release an agent's claim.
app.delete("/api/claims/:id", (req, res) => {
  const m = requireCaller(req, res);
  if (!m) return;
  try {
    res.json(store.release(m, req.params.id, req.query.force === "1"));
  } catch (e) {
    httpError(res, 403, e);
  }
});

// A person releases or rejects a message the hub held (possible prompt
// injection from another org, or agents looping without a person).
app.post("/api/messages/:id/review", (req, res) => {
  const m = requireCaller(req, res);
  if (!m) return;
  const decision = req.body?.decision;
  if (decision !== "release" && decision !== "reject")
    return void res.status(400).json({ error: 'decision must be "release" or "reject"' });
  const scope = req.body?.scope === "gate" || req.body?.scope === "agents" ? req.body.scope : undefined;
  try {
    res.json(store.review(m, req.params.id, decision, scope));
  } catch (e) {
    const msg = (e as Error).message;
    httpError(res, msg.startsWith("no such") ? 404 : msg.includes("not held") ? 409 : 403, e);
  }
});

// --- Human in the loop -------------------------------------------------------

// A person stops or resumes an agent of their own org.
app.post("/api/members/:handle/pause", (req, res) => {
  const m = requireCaller(req, res);
  if (!m) return;
  try {
    res.json(store.publicMember(store.setPaused(m, req.params.handle, req.body?.paused !== false)));
  } catch (e) {
    httpError(res, statusFor(e, 403), e);
  }
});

// { approveContractChanges: true }: agents' contract changes wait for a person of their org.
app.put("/api/rooms/:id/policy", (req, res) => {
  const m = requireCaller(req, res);
  if (!m) return;
  try {
    res.json(store.setPolicy(m, req.params.id, req.body ?? {}).policy);
  } catch (e) {
    httpError(res, 403, e);
  }
});

app.get("/api/audit", (req, res) => {
  const m = reader(req, res);
  if (m === false) return;
  res.json(store.auditFor(m));
});

// --- Waitlist (the hosted beta's landing page) ----------------------------------

app.post("/api/waitlist", async (req, res) => {
  const b = req.body ?? {};
  // Honeypot: a field people never see. Bots fill it; pretend it worked.
  if (b.website) return void res.status(201).json({ ok: true, position: waitlistCount() + 1 });
  const ip = clientIp(req);
  try {
    const { position, already, entry } = joinWaitlist(b, ip);
    const confirmationSent = await sendWaitlistConfirmation(entry, position);
    res.status(already ? 200 : 201).json({ ok: true, position, already, confirmationSent });
  } catch (e) {
    httpError(res, e instanceof RateLimited ? 429 : 400, e);
  }
});

app.get("/api/waitlist/count", (_req, res) => void res.json({ count: waitlistCount() }));

// The list itself: admin token only, never in demo mode without one.
app.get("/api/waitlist", (req, res) => {
  if (!isAdminToken(req)) return void res.status(401).json({ error: "admin token required" });
  res.json(waitlistEntries());
});

// Messages addressed to the caller since ?since=<id>; ?all=1 for everything visible.
app.get("/api/inbox", (req, res) => {
  const m = requireCaller(req, res);
  if (m) res.json(store.inbox(m, req.query.since as string | undefined, req.query.all !== "1"));
});

// Bridges acknowledge only after their adapter accepted a message. Until this
// explicit ack, reconnect catch-up keeps the message durable.
const deliveryLeases = new Map<string, { streamId: string; expiresAt: number }>();
let lastDeliveryLeaseSweep = 0;
const deliveryLeaseKey = (messageId: string, handle: string) => `${messageId}\0${handle}`;
const acquireDeliveryLease = (messageId: string, handle: string, streamId: string) => {
  const key = deliveryLeaseKey(messageId, handle);
  const now = Date.now();
  if (now - lastDeliveryLeaseSweep > 60_000) {
    for (const [leasedKey, lease] of deliveryLeases) if (lease.expiresAt <= now) deliveryLeases.delete(leasedKey);
    lastDeliveryLeaseSweep = now;
  }
  const existing = deliveryLeases.get(key);
  if (existing && existing.expiresAt > now) return false;
  deliveryLeases.set(key, { streamId, expiresAt: now + DELIVERY_LEASE_MS });
  return true;
};
const releaseDeliveryLease = (messageId: string, handle: string) => deliveryLeases.delete(deliveryLeaseKey(messageId, handle));

app.post("/api/deliveries/:id/ack", (req, res) => {
  const m = requireCaller(req, res);
  if (!m) return;
  const msg = store.getMessage(req.params.id);
  if (!msg || m.kind !== "agent" || !store.isFor(m, msg)) return void res.status(404).json({ error: "no such delivery" });
  store.markDelivered(msg, m.handle);
  releaseDeliveryLease(msg.id, m.handle);
  res.json({ ok: true });
});

// --- SSE ---------------------------------------------------------------------
// With a token or session: what that member may see, minus their own messages,
// each message flagged `forYou` when it @mentions them. `?mentions=1` keeps only
// those (bridges use this: agents are pushed only what's addressed to them).
// Without: everything (demo overview and the admin token only).
// Open event streams per member (or per address for the demo overview), and in total.
const streams = new Map<string, number>();
const openStreamResponses = new Set<Response>();
let totalStreams = 0;

app.get("/api/events", (req: Request, res: Response) => {
  const m = reader(req, res);
  if (m === false) return;
  const who = m ? `m:${m.handle}` : `ip:${clientIp(req)}`;
  if ((streams.get(who) ?? 0) >= STREAMS_PER_CALLER || totalStreams >= STREAMS_TOTAL)
    return void res.status(429).json({ error: "too many open event streams; close some tabs or bridges" });
  streams.set(who, (streams.get(who) ?? 0) + 1);
  openStreamResponses.add(res);
  totalStreams++;
  res.on("close", () => {
    openStreamResponses.delete(res);
    totalStreams--;
    const n = (streams.get(who) ?? 1) - 1;
    if (n > 0) streams.set(who, n);
    else streams.delete(who);
  });
  const mentionsOnly = req.query.mentions === "1";
  const streamId = randomUUID();
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
  res.write(": connected\n\n");
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  // Access is re-read on every event: a member moved, paused or removed, a session signed out
  // or expired, a token replaced: the stream sees it at once (and closes on the next ping).
  const token = presentedToken(req);
  const credential = () => (token ? (token.startsWith("ws_") ? store.sessionMember(token) : store.byTokenValue(token)) : store.sessionMember(sessionId(req)));
  const live = () => {
    if (!m) return undefined;
    const me = credential();
    return me?.handle === m.handle ? me : undefined;
  };

  const onMessage = (msg: store.Message, late = false) => {
    const me = live();
    if (!m) return send("message", msg);
    if (!me || !store.canSee(me, msg.roomId) || msg.from === me.handle) return;
    const forYou = store.isFor(me, msg);
    if (mentionsOnly) {
      // Delivery is recorded only by POST /api/deliveries/:id/ack after the
      // bridge accepted this frame. A short-lived in-memory lease prevents
      // two concurrent bridges for one agent from both accepting it first.
      if (!forYou || store.wasDelivered(msg.id, me.handle)) return;
      if (!acquireDeliveryLease(msg.id, me.handle, streamId)) return;
    }
    send("message", { ...store.withDeliveries(me, store.viewFor(me, msg)), forYou, ...(late ? { late: true } : {}) });
  };
  // A message to this agent waits for its person: tell the bridge (no text) so it can ask them.
  const onHeld = (msg: store.Message) => {
    const me = live();
    if (!mentionsOnly || !me || me.kind !== "agent" || me.paused || !store.canSee(me, msg.roomId)) return;
    const approval = msg.safety.approvals?.[store.approvalKey(me)];
    const addressed = msg.mentionsRoom || msg.mentions.includes(me.handle);
    const reviewable = approval?.decision === "pending" && approval.agents.includes(me.handle);
    if (!addressed || (!reviewable && gateDecision(msg.safety) !== "pending")) return;
    send("held", {
      id: msg.id,
      roomId: msg.roomId,
      from: msg.from,
      org: msg.org,
      kind: msg.kind,
      flags: msg.safety.flags,
      waitsFor: reviewable ? store.approvalKey(me) : msg.safety.flags.includes("needs-approval") ? `org:${msg.org}` : "a person in the room",
      reviewable,
      reviewUrl: `${PUBLIC_URL}/app?review=${msg.id}`,
    });
  };
  // People see who got a message, live.
  const onDelivery = (d: { messageId: string; roomId: string; handle: string }) => {
    const me = live();
    if (mentionsOnly || (m && !(me && me.kind === "human" && store.canSee(me, d.roomId)))) return;
    send("delivery", d);
  };
  // Safety status changed (a person released or rejected a held message).
  const onMessageUpdate = (msg: store.Message) => {
    const me = live();
    if (mentionsOnly) {
      if (!me || me.kind !== "agent" || me.paused || !store.canSee(me, msg.roomId)) return;
      const approval = msg.safety.approvals?.[store.approvalKey(me)];
      const wasTarget =
        (Array.isArray(approval?.agents) && approval.agents.includes(me.handle)) ||
        msg.mentionsRoom ||
        msg.mentions.includes(me.handle);
      if (wasTarget && (gateDecision(msg.safety) === "rejected" || approval?.decision === "rejected"))
        send("held_resolution", { id: msg.id, roomId: msg.roomId, resolution: "rejected", waitsFor: store.approvalKey(me) });
      return;
    }
    if (m && (!me || !store.canSee(me, msg.roomId))) return;
    send("message_update", me ? store.viewFor(me, msg) : msg);
  };
  const onRoom = (r: store.Room) => {
    const me = live();
    if (!mentionsOnly && (!m || (me && store.canSee(me, r.id)))) send("room", r);
  };
  // The room is gone, so check what was above it: only those who saw it hear that it went.
  const onRoomDeleted = (r: { id: string; parentId: string | null }) => {
    const me = live();
    if (mentionsOnly || (m && !(me && (me.scopeRoomId === null || (r.parentId && store.canSee(me, r.parentId)))))) return;
    send("room_deleted", { id: r.id });
  };
  const onRoomMessagesDeleted = (r: { roomId: string }) => {
    const me = live();
    if (!mentionsOnly && (!m || (me && store.canSee(me, r.roomId)))) send("room_messages_deleted", r);
  };
  // Data-free invalidation is used when the old access topology is needed to
  // know who must remove stale state (room moves and account erasure).
  const onInvalidate = (r: { handles: string[] }) => {
    const me = live();
    if (!mentionsOnly && (!m || (me && r.handles.includes(me.handle)))) send("invalidate", {});
  };
  // Other members are only visible to those who share a room with them.
  const knows = (handle: string) => {
    const me = live();
    const other = store.getMember(handle);
    if (!m) return true;
    if (!me || !other) return false;
    // A removed member is announced to those who shared a room with them while they were active.
    return other.handle === me.handle || store.sharesRoom(me, other.disabled ? { ...other, disabled: false } : other);
  };
  const onMember = (pm: store.PublicMember) => {
    if (!mentionsOnly && knows(pm.handle)) send("member", pm);
  };
  const onPresence = (p: { handle: string; online: boolean }) => {
    if (!mentionsOnly && knows(p.handle)) send("presence", p);
  };
  // People (and the demo overview) see the audit trail of rooms they can see.
  const onAudit = (a: store.AuditEvent) => {
    const me = live();
    if (!mentionsOnly && (!m || (me && me.kind === "human" && store.canSeeAudit(me, a)))) send("audit", a);
  };
  // Credentials changed (removed, new token): end the stream; the client has to sign in again.
  const onKick = (handle: string) => {
    if (m && handle === m.handle) res.end();
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handlers: [string, (x: any) => void][] = [
    ["message", onMessage],
    ["message_update", onMessageUpdate],
    ["room", onRoom],
    ["room_deleted", onRoomDeleted],
    ["room_messages_deleted", onRoomMessagesDeleted],
    ["invalidate", onInvalidate],
    ["member", onMember],
    ["presence", onPresence],
    ["audit", onAudit],
    ["kick", onKick],
    ["held", onHeld],
    ["delivery", onDelivery],
  ];
  const ping = setInterval(() => (m && !live() ? res.end() : res.write(": ping\n\n")), 15_000);
  for (const [e, fn] of handlers) store.events.on(e, fn);
  if (m) store.trackConnection(m, 1);
  // An agent that was offline catches up. Held notices are replayed without
  // text until resolved; normal messages remain pending until the bridge acks.
  if (m && mentionsOnly) {
    let cursor = 0;
    do {
      const page = store.pendingHeld(m, cursor);
      for (const msg of page.messages) onHeld(msg);
      cursor = page.nextSeq ?? 0;
      if (!page.nextSeq) break;
    } while (true);
    cursor = 0;
    do {
      const page = store.undelivered(m, cursor);
      for (const msg of page.messages) onMessage(msg, true);
      cursor = page.nextSeq ?? 0;
      if (!page.nextSeq) break;
    } while (true);
  }
  req.on("close", () => {
    clearInterval(ping);
    for (const [e, fn] of handlers) store.events.off(e, fn);
    for (const [key, lease] of deliveryLeases) if (lease.streamId === streamId) deliveryLeases.delete(key);
    if (m) store.trackConnection(m, -1);
  });
});

// --- A2A ---------------------------------------------------------------------
// Agent Card + JSON-RPC `message/send`: an agent of another company posts into
// the room its invite token is scoped to (or `metadata.room` below it).
app.get("/.well-known/agent-card.json", (_req, res) => {
  res.json({
    protocolVersion: "0.3.0",
    name: `${store.instanceName()} (Warren hub)`,
    description: "Tree of rooms where coding agents and people of different companies coordinate.",
    url: `${PUBLIC_URL}/a2a`,
    preferredTransport: "JSONRPC",
    version: VERSION,
    capabilities: { streaming: false, pushNotifications: false },
    securitySchemes: { bearer: { type: "http", scheme: "bearer" } },
    security: [{ bearer: [] }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "post-to-room",
        name: "Post to a room",
        description:
          "Deliver a message into a Warren room your invite token can see. Use @handle to reach a member. " +
          "Set metadata.room to pick a subroom, metadata.kind to one of note, contract_change, question, done.",
        tags: ["coordination", "coding-agents"],
      },
    ],
  });
});

app.get("/healthz", (_req, res) => {
  const ok = dbHealthy();
  res.status(ok ? 200 : 503).json({ ok, version: VERSION });
});

app.post("/a2a", (req, res) => {
  const { id = null, method, params } = req.body ?? {};
  const rpcError = (code: number, message: string) => res.json({ jsonrpc: "2.0", id, error: { code, message } });
  const m = presentedToken(req) ? caller(req) : undefined;
  if (!m) return void rpcError(-32001, "missing or unknown bearer token");
  if (method !== "message/send") return void rpcError(-32601, `method ${method} not supported`);
  const message = params?.message;
  if (!message || !Array.isArray(message.parts)) return void rpcError(-32602, "params.message.parts must be an array");
  const text = message.parts
    .filter((p: unknown): p is { text: string } => {
      const part = p as { kind?: unknown; type?: unknown; text?: unknown } | null;
      return !!part && typeof part === "object" && (part.kind ?? part.type) === "text" && typeof part.text === "string";
    })
    .map((p: { text: string }) => p.text)
    .join("\n");
  const room = message?.metadata?.room ?? params?.metadata?.room ?? m.scopeRoomId;
  const kind = message?.metadata?.kind ?? params?.metadata?.kind ?? "note";
  try {
    if (!room) throw new Error("set metadata.room: your access isn't limited to one room");
    const posted = store.post(m, room, kind, text);
    res.json({
      jsonrpc: "2.0",
      id,
      result: {
        kind: "message",
        messageId: randomUUID(),
        role: "agent",
        parts: [{ kind: "text", text: `Posted to #${room}. Delivered to: ${deliveredTo(posted)}.` }],
        metadata: { warrenMessageId: posted.id, room },
      },
    });
  } catch (e) {
    rpcError(-32602, (e as Error).message);
  }
});

function deliveredTo(msg: store.Message): string {
  if (msg.safety.status === "held") return `nobody yet: held for human review (${msg.safety.flags.join(", ")})`;
  if (msg.mentionsRoom) return "everyone in the room (@room)";
  return msg.mentions.map((h) => "@" + h).join(", ") || "nobody (no @mention)";
}

// --- Web (landing + dashboard), built by `npm run build` ---------------------
const WEB = fileURLToPath(new URL("../../web/dist", import.meta.url));
// Closed dashboard: "See it live" leads to the waitlist instead.
app.get(["/app", "/app/", "/app.html"], (_req, res) =>
  DASHBOARD_OPEN ? res.sendFile("app.html", { root: WEB }) : res.redirect(302, "/?waitlist=1#waitlist"),
);
// Privacy notice: always served (it reads the hub's name and contact from /api/config); the sandbox demo only on demo hubs.
app.get("/privacy", (_req, res) => res.sendFile("privacy.html", { root: WEB }));
app.get("/demo", (_req, res) => res.sendFile("demo.html", { root: WEB }));
// A self-hosted hub has no use for the marketing landing page: / opens the dashboard.
app.get("/", (req, res, next) => (DEMO || LANDING ? next() : res.redirect(302, "/app")));
app.use(express.static(WEB));

// Keep parser and unexpected route errors in the same non-sensitive JSON shape
// as the API. Expected client errors do not need stack traces in production logs.
app.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(error);
  const e = error as Error & { status?: number; statusCode?: number; type?: string };
  if (e.type === "entity.too.large" || e.status === 413) return void res.status(413).json({ error: "request body is too large" });
  if ((e instanceof SyntaxError && e.status === 400) || e.type === "entity.parse.failed")
    return void res.status(400).json({ error: "malformed JSON body" });
  if (e.type === "charset.unsupported" || e.type === "encoding.unsupported")
    return void res.status(415).json({ error: "unsupported request body format" });
  if (e.type === "request.aborted") return void res.status(400).json({ error: "request body was not completed" });
  const status = e.status ?? e.statusCode;
  if (status && status >= 400 && status < 500) return void res.status(status).json({ error: "invalid request body" });
  console.error("request failed", e.message);
  res.status(500).json({ error: "internal server error" });
});

function setupSnippets(m: store.Member, token: string) {
  return {
    claudeCode: {
      mcpJson: {
        mcpServers: {
          warren: {
            command: "npx",
            args: ["tsx", "bridge/src/index.ts"],
            env: { WARREN_HUB: PUBLIC_URL, WARREN_TOKEN: token, WARREN_ADAPTER: "channel" },
          },
        },
      },
      launch: "claude --dangerously-load-development-channels server:warren",
    },
    codex: {
      mcp: `WARREN_TOKEN=${token} codex mcp add warren --url ${PUBLIC_URL}/mcp --bearer-token-env-var WARREN_TOKEN`,
      wake: `WARREN_HUB=${PUBLIC_URL} WARREN_TOKEN=${token} WARREN_ADAPTER=exec WARREN_EXEC_SESSION=<session-id> npx tsx bridge/src/index.ts`,
    },
    cursor: {
      mcpJson: { mcpServers: { warren: { url: `${PUBLIC_URL}/mcp`, headers: { Authorization: `Bearer ${token}` } } } },
      wake: `WARREN_HUB=${PUBLIC_URL} WARREN_TOKEN=${token} WARREN_ADAPTER=exec WARREN_EXEC_CLIENT=cursor WARREN_EXEC_SESSION=$(cursor-agent create-chat) npx tsx bridge/src/index.ts`,
    },
    a2a: { card: `${PUBLIC_URL}/.well-known/agent-card.json`, auth: `Authorization: Bearer ${token}` },
    handle: m.handle,
  };
}

if (DEMO && SEED_DEMO) seedDemo(PUBLIC_URL);
store.sweep();
setInterval(() => store.sweep(), 60 * 60_000).unref();
if (PRODUCTION && !DEMO && !store.isSetUp()) {
  if (!SETUP_TOKEN) throw new Error("invalid WARREN_SETUP_TOKEN: is required for a production database without an owner");
  if (SETUP_TOKEN.length < 32) throw new Error("invalid WARREN_SETUP_TOKEN: fresh production setup secrets must contain at least 32 characters");
}
if (!DEMO && !store.isSetUp())
  console.log(`no owner yet: open ${PUBLIC_URL}/app to create the owner account${SETUP_TOKEN ? " (needs WARREN_SETUP_TOKEN)" : ""}`);

const httpServer = app.listen(PORT, () => console.log(`warren hub ${VERSION} on ${PUBLIC_URL}  (dashboard: ${PUBLIC_URL}/app)`));
let stopping = false;
const shutdown = (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.log(`${signal}: stopping warren hub`);
  for (const response of openStreamResponses) response.end();
  httpServer.close(() => {
    closeDb();
    process.exit(0);
  });
  setTimeout(() => {
    httpServer.closeAllConnections();
    closeDb();
    process.exit(1);
  }, 10_000).unref();
};
process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));
