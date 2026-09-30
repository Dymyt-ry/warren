// Warren hub: REST + SSE for the dashboard and bridges, MCP over Streamable
// HTTP for agents, A2A (Agent Card + message/send) for agents of other companies.
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import { createMcpServer } from "./mcp.js";
import { seedDemo } from "./seed.js";

const PORT = Number(process.env.PORT ?? 8790);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  if (req.method === "OPTIONS") return void res.status(204).end();
  next();
});

/** The member behind `Authorization: Bearer <token>` or `?token=` (EventSource can't set headers). */
function caller(req: Request): store.Member | undefined {
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return store.byTokenValue(header || (req.query.token as string | undefined));
}

function requireCaller(req: Request, res: Response): store.Member | undefined {
  const m = caller(req);
  if (!m) res.status(401).json({ error: "missing or unknown token" });
  return m;
}

const httpError = (res: Response, status: number, e: unknown) => res.status(status).json({ error: (e as Error).message });

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

// --- REST: identity ----------------------------------------------------------

// Demo login for the dashboard: pick a human by handle, get their token.
// No passwords: hackathon scope, see README limits.
app.post("/api/login", (req, res) => {
  const m = store.getMember(String(req.body?.handle ?? ""));
  if (!m || m.kind !== "human") return void res.status(404).json({ error: "no such person" });
  res.json(m);
});

app.get("/api/me", (req, res) => {
  const m = requireCaller(req, res);
  if (m) res.json(store.publicMember(m));
});

// Members, never with tokens. ?room=<id>: that room's members. With a token:
// the members who share at least one room with the caller. Otherwise everyone.
app.get("/api/members", (req, res) => {
  const room = req.query.room as string | undefined;
  const m = caller(req);
  if (room && m && !store.canSee(m, room)) return void res.status(404).json({ error: "no such room" });
  const list = room ? store.roomMembers(room) : m ? store.contactsOf(m) : store.allMembers();
  res.json(list.map(store.publicMember));
});

// Invite a person or an agent into one subroom. Returns the token plus ready-to-paste setup.
app.post("/api/invites", (req, res) => {
  const b = req.body ?? {};
  try {
    const m = store.addMember({
      handle: b.handle,
      name: b.name ?? b.agentName ?? b.handle,
      kind: b.kind ?? "agent",
      org: b.org,
      scopeRoomId: b.room,
      adapter: b.adapter,
    });
    res.status(201).json({ ...m, setup: setupSnippets(m) });
  } catch (e) {
    httpError(res, 400, e);
  }
});

// --- REST: rooms and messages ------------------------------------------------

// With a token: the rooms that member can see. Without: the whole tree (dashboard overview).
app.get("/api/rooms", (req, res) => {
  const m = caller(req);
  res.json(m ? store.visibleRooms(m) : store.allRooms());
});

app.get("/api/rooms/:id", (req, res) => {
  const m = caller(req);
  const room = store.getRoom(req.params.id);
  if (!room || (m && !store.canSee(m, room.id))) return void res.status(404).json({ error: "no such room" });
  res.json({ ...room, members: store.roomMembers(room.id).map(store.publicMember) });
});

// New subroom under a room the caller can see. Root rooms come from the seed.
app.post("/api/rooms", (req, res) => {
  const { name, parentId = null, context = "" } = req.body ?? {};
  const m = requireCaller(req, res);
  if (!m) return;
  if (!parentId || !store.canSee(m, parentId))
    return void res.status(403).json({ error: `no access to room ${parentId}` });
  try {
    res.status(201).json(store.createRoom(name, parentId, context));
  } catch (e) {
    httpError(res, 400, e);
  }
});

app.put("/api/rooms/:id/context", (req, res) => {
  const m = requireCaller(req, res);
  if (!m) return;
  try {
    res.json(store.updateContext(m, req.params.id, String(req.body?.context ?? "")));
  } catch (e) {
    httpError(res, 403, e);
  }
});

app.get("/api/rooms/:id/messages", (req, res) => {
  const m = caller(req);
  const room = store.getRoom(req.params.id);
  if (!room || (m && !store.canSee(m, room.id))) return void res.status(404).json({ error: "no such room" });
  res.json(room.messages);
});

app.post("/api/rooms/:id/messages", (req, res) => {
  const m = requireCaller(req, res);
  if (!m) return;
  if (!store.getRoom(req.params.id)) return void res.status(404).json({ error: "no such room" });
  try {
    res.status(201).json(store.post(m, req.params.id, req.body?.kind ?? "note", req.body?.text));
  } catch (e) {
    httpError(res, store.canSee(m, req.params.id) ? 400 : 403, e);
  }
});

// Messages addressed to the caller since ?since=<id>; ?all=1 for everything visible.
app.get("/api/inbox", (req, res) => {
  const m = requireCaller(req, res);
  if (m) res.json(store.inbox(m, req.query.since as string | undefined, req.query.all !== "1"));
});

// --- SSE ---------------------------------------------------------------------
// With a token: what that member may see, minus their own messages, each
// message flagged `forYou` when it @mentions them. `?mentions=1` keeps only
// those (bridges use this: agents are pushed only what's addressed to them).
// Without a token: everything (dashboard overview).
app.get("/api/events", (req: Request, res: Response) => {
  const m = caller(req);
  if (req.query.token && !m) return void res.status(401).json({ error: "unknown token" });
  const mentionsOnly = req.query.mentions === "1";
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": connected\n\n");
  const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const onMessage = (msg: store.Message) => {
    if (!m) return send("message", msg);
    if (!store.canSee(m, msg.roomId) || msg.from === m.handle) return;
    const forYou = store.isFor(m, msg);
    if (mentionsOnly && !forYou) return;
    send("message", { ...msg, forYou });
  };
  const onRoom = (r: store.Room) => {
    if (!mentionsOnly && (!m || store.canSee(m, r.id))) send("room", r);
  };
  const onMember = (pm: store.PublicMember) => {
    if (!mentionsOnly) send("member", pm);
  };
  const onPresence = (p: { handle: string; online: boolean }) => {
    if (!mentionsOnly) send("presence", p);
  };
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  store.events.on("message", onMessage);
  store.events.on("room", onRoom);
  store.events.on("member", onMember);
  store.events.on("presence", onPresence);
  if (m) store.trackConnection(m, 1);
  req.on("close", () => {
    clearInterval(ping);
    store.events.off("message", onMessage);
    store.events.off("room", onRoom);
    store.events.off("member", onMember);
    store.events.off("presence", onPresence);
    if (m) store.trackConnection(m, -1);
  });
});

// --- A2A ---------------------------------------------------------------------
// Agent Card + JSON-RPC `message/send`: an agent of another company posts into
// the room its invite token is scoped to (or `metadata.room` below it).
app.get("/.well-known/agent-card.json", (_req, res) => {
  res.json({
    protocolVersion: "0.3.0",
    name: "Warren hub",
    description: "Tree of rooms where coding agents and people of different companies coordinate.",
    url: `${PUBLIC_URL}/a2a`,
    preferredTransport: "JSONRPC",
    version: "0.2.0",
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

app.post("/a2a", (req, res) => {
  const { id = null, method, params } = req.body ?? {};
  const rpcError = (code: number, message: string) => res.json({ jsonrpc: "2.0", id, error: { code, message } });
  const m = caller(req);
  if (!m) return void rpcError(-32001, "missing or unknown bearer token");
  if (method !== "message/send") return void rpcError(-32601, `method ${method} not supported`);
  const message = params?.message;
  const text = (message?.parts ?? [])
    .filter((p: { kind?: string; type?: string }) => (p.kind ?? p.type) === "text")
    .map((p: { text: string }) => p.text)
    .join("\n");
  const room = message?.metadata?.room ?? params?.metadata?.room ?? m.scopeRoomId;
  const kind = message?.metadata?.kind ?? params?.metadata?.kind ?? "note";
  try {
    const posted = store.post(m, room, kind, text);
    res.json({
      jsonrpc: "2.0",
      id,
      result: {
        kind: "message",
        messageId: randomUUID(),
        role: "agent",
        parts: [{ kind: "text", text: `Posted to #${room}. Mentioned: ${posted.mentions.map((h) => "@" + h).join(", ") || "nobody"}.` }],
        metadata: { warrenMessageId: posted.id, room },
      },
    });
  } catch (e) {
    rpcError(-32602, (e as Error).message);
  }
});

// --- Web (landing + dashboard), built by `npm run build` ---------------------
app.use(express.static(fileURLToPath(new URL("../../web/dist", import.meta.url))));

function setupSnippets(m: store.Member) {
  if (m.kind === "human") return { dashboard: `${PUBLIC_URL}/app.html?token=${m.token}` };
  return {
    claudeCode: {
      mcpJson: {
        mcpServers: {
          warren: {
            command: "npx",
            args: ["tsx", "bridge/src/index.ts"],
            env: { WARREN_HUB: PUBLIC_URL, WARREN_TOKEN: m.token, WARREN_ADAPTER: "channel" },
          },
        },
      },
      launch: "claude --dangerously-load-development-channels server:warren",
    },
    codex: {
      mcp: `WARREN_TOKEN=${m.token} codex mcp add warren --url ${PUBLIC_URL}/mcp --bearer-token-env-var WARREN_TOKEN`,
      wake: `WARREN_HUB=${PUBLIC_URL} WARREN_TOKEN=${m.token} WARREN_ADAPTER=exec WARREN_CODEX_SESSION=<session-id> npx tsx bridge/src/index.ts`,
    },
    cursor: { mcpJson: { mcpServers: { warren: { url: `${PUBLIC_URL}/mcp`, headers: { Authorization: `Bearer ${m.token}` } } } } },
    a2a: { card: `${PUBLIC_URL}/.well-known/agent-card.json`, auth: `Authorization: Bearer ${m.token}` },
  };
}

if (process.env.WARREN_SEED !== "0") seedDemo(PUBLIC_URL);

app.listen(PORT, () => console.log(`warren hub on ${PUBLIC_URL}  (dashboard: ${PUBLIC_URL}/app.html)`));
