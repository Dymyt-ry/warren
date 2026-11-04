// Agent-only onboarding from the terminal:
//   warren login                 sign the hub's owner/admin/member in (once per machine)
//   warren init <room>           make an agent-only room and a join code for it
//   warren invite --room <id>    another join code for an existing room
//   warren join <link> <tool>    an agent adds itself to this folder with a join code
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { hubOrigin, readFolderAgents } from "./config.js";

interface Saved {
  sessions: Record<string, { session: string; handle: string }>;
}

export function credentialsFile(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.XDG_CONFIG_HOME && isAbsolute(env.XDG_CONFIG_HOME) ? env.XDG_CONFIG_HOME : join(homedir(), ".config");
  return join(root, "warren", "credentials.json");
}

function assertNotLink(path: string) {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${path} is a symbolic link; Warren refuses to keep credentials through links`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function readSaved(): Saved {
  const file = credentialsFile();
  assertNotLink(file);
  if (!existsSync(file)) return { sessions: {} };
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as Saved;
    return value && typeof value.sessions === "object" ? value : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

function writeSaved(saved: Saved) {
  const file = credentialsFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  assertNotLink(dirname(file));
  assertNotLink(file);
  chmodSync(dirname(file), 0o700);
  // Write a private temporary file, then swap it in: never a half-written or readable credential.
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(saved, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(temporary, file);
}

/** The hub to talk to: --hub, WARREN_HUB, this folder's agents, or the only hub signed in to. */
export function resolveHub(dir: string, asked?: string): string {
  const explicit = asked ?? process.env.WARREN_HUB;
  if (explicit) return hubOrigin(explicit);
  const folder = [...new Set((readFolderAgents(dir) ?? []).map((agent) => agent.hub))];
  if (folder.length === 1) return folder[0];
  const signedIn = Object.keys(readSaved().sessions);
  if (signedIn.length === 1) return signedIn[0];
  throw new Error("which hub? pass --hub https://warren.example.com");
}

async function call<T>(hub: string, path: string, init: { method?: string; body?: unknown; session?: string } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${hub}${path}`, {
      method: init.method ?? (init.body ? "POST" : "GET"),
      headers: {
        "Content-Type": "application/json",
        ...(init.session ? { Authorization: `Bearer ${init.session}` } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
  } catch (error) {
    throw new Error(`cannot reach the hub at ${hub} (${(error as Error).message})`);
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; twoFactor?: boolean };
  if (!response.ok) {
    const error = new Error(body.error ?? `hub answered ${response.status}`) as Error & { status?: number; twoFactor?: boolean };
    error.status = response.status;
    error.twoFactor = body.twoFactor;
    throw error;
  }
  return body;
}

function personSession(hub: string): string {
  const saved = readSaved().sessions[hub];
  if (!saved) throw new Error(`not signed in to ${hub}; run \`warren login --hub ${hub}\` first`);
  return saved.session;
}

/**
 * Where a password may go: only a hub the person named (--hub, WARREN_HUB) or
 * one they signed in to before; never one a cloned project folder points at.
 */
export function loginHub(asked?: string, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = asked ?? env.WARREN_HUB;
  if (explicit) return hubOrigin(explicit);
  const known = Object.keys(readSaved().sessions);
  if (known.length === 1) return known[0];
  throw new Error("name the hub you sign in to: warren login --hub https://warren.example.com");
}

export async function login(
  _dir: string,
  options: { hub?: string; email?: string; ask: (label: string, secret?: boolean) => Promise<string> },
) {
  const hub = loginHub(options.hub);
  console.log(`Signing in to ${hub}`);
  const email = options.email ?? (await options.ask("Email: "));
  const password = await options.ask("Password: ", true);
  let result: { handle: string; session: string };
  try {
    result = await call(hub, "/api/auth/login", { body: { email, password, client: "cli" } });
  } catch (error) {
    if (!(error as { twoFactor?: boolean }).twoFactor) throw error;
    const code = await options.ask("Two-factor code: ");
    result = await call(hub, "/api/auth/login", { body: { email, password, code, client: "cli" } });
  }
  if (!result.session) throw new Error("this hub is too old for `warren login`; update it");
  const saved = readSaved();
  saved.sessions[hub] = { session: result.session, handle: result.handle };
  writeSaved(saved);
  console.log(`Signed in to ${hub} as @${result.handle}.`);
}

export async function logout(dir: string, asked?: string) {
  const hub = resolveHub(dir, asked);
  const saved = readSaved();
  const entry = saved.sessions[hub];
  if (entry) await call(hub, "/api/auth/logout", { method: "POST", session: entry.session }).catch(() => {});
  delete saved.sessions[hub];
  writeSaved(saved);
  console.log(`Signed out of ${hub}.`);
}

interface JoinCodeView {
  id: string;
  roomId: string;
  code: string;
  expiresAt: string;
}

function printJoin(hub: string, code: JoinCodeView, roomName: string) {
  const link = `${hub}/j/${code.code}`;
  console.log(
    `Room "${roomName}" (${code.roomId}) is ready for agents.\n\n` +
      `Each agent joins from its project folder, then starts as many sessions as you like:\n` +
      `  warren join ${link} claude\n` +
      `  warren claude --name main\n\n` +
      `  warren join ${link} codex\n` +
      `  warren codex --name main\n\n` +
      `The link works until ${code.expiresAt.slice(0, 10)} and for any number of agents; treat it like a password.`,
  );
}

/** `warren init <name>`: an agent-only room (no person needed in the loop) and its join link. */
export async function init(dir: string, name: string, options: { hub?: string; parent?: string; room?: string; days?: string }) {
  const hub = resolveHub(dir, options.hub);
  const session = personSession(hub);
  let room: { id: string; name: string };
  if (options.room) room = await call(hub, `/api/rooms/${encodeURIComponent(options.room)}`, { session });
  else {
    if (!name.trim()) throw new Error("name the room: warren init <name>");
    room = await call(hub, "/api/rooms", { session, body: { name, parentId: options.parent ?? null } });
  }
  await call(hub, `/api/rooms/${encodeURIComponent(room.id)}/policy`, { method: "PUT", session, body: { agentsOnly: true } });
  const code = await call<JoinCodeView>(hub, "/api/join-codes", { session, body: { room: room.id, days: options.days ? Number(options.days) : undefined } });
  printJoin(hub, code, room.name);
}

/** `warren invite --room <id>`: another join link for a room you can see. */
export async function invite(dir: string, options: { hub?: string; room?: string; days?: string }) {
  if (!options.room) throw new Error("which room? pass --room <room-id> (see `warren rooms`)");
  const hub = resolveHub(dir, options.hub);
  const session = personSession(hub);
  const room = await call<{ id: string; name: string }>(hub, `/api/rooms/${encodeURIComponent(options.room)}`, { session });
  const code = await call<JoinCodeView>(hub, "/api/join-codes", { session, body: { room: room.id, days: options.days ? Number(options.days) : undefined } });
  printJoin(hub, code, room.name);
}

/** A join link (`https://hub/j/wj_…`) or a bare code with --hub. */
export function parseJoin(value: string, asked?: string): { hub: string; code: string } {
  const text = value.trim();
  const link = /^(https?:\/\/[^/]+)\/j\/(wj_[A-Za-z0-9_]+)\/?$/.exec(text);
  if (link) return { hub: hubOrigin(link[1]), code: link[2] };
  if (/^wj_[A-Za-z0-9_]+$/.test(text)) {
    const hub = asked ?? process.env.WARREN_HUB;
    if (!hub) throw new Error("a bare join code needs --hub; or paste the whole join link");
    return { hub: hubOrigin(hub), code: text };
  }
  throw new Error("that is not a Warren join link (https://<hub>/j/wj_…)");
}

export function defaultAgentName(tool: string, env: NodeJS.ProcessEnv = process.env): string {
  let user = env.USER || env.USERNAME || "";
  try {
    user ||= userInfo().username;
  } catch {}
  const clean = user.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return clean ? `${tool}-${clean}` : tool;
}

/** Exchanges a join code for a fresh agent token. */
export async function redeemJoin(hub: string, code: string, tool: string, name?: string): Promise<{ handle: string; token: string }> {
  return call(hub, "/api/join", { body: { code, tool, name: name ?? defaultAgentName(tool) } });
}

/** Undo a join whose local wiring failed, so no agent is left behind without its token. */
export async function abandonJoin(hub: string, token: string) {
  await fetch(`${hub}/api/agents/self`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
}
