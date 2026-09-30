// Warren hub: REST + SSE for the dashboard and bridges, MCP over Streamable
// HTTP for agents, an A2A Agent Card for agents of other companies.
import express, { type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { fileURLToPath } from "node:url";
import * as store from "./store.js";
import { createMcpServer } from "./mcp.js";
import { seedDemo } from "./seed.js";

const PORT = Number(process.env.PORT ?? 8790);
const PUBLIC_URL = process.env.PUBLIC_URL ?? `http://localhost:${PORT}`;

const app = express();
app.use(express.json());

function bearer(req: Request): store.Token | undefined {
  const header = req.headers.authorization?.replace(/^Bearer\s+/i, "");
  return store.getToken(header ?? (req.query.token as string | undefined));
}

// --- MCP (stateless: fresh server + transport per request) -----------------
app.post("/mcp", async (req, res) => {
  const t = bearer(req);
  if (!t) return void res.status(401).json({ error: "missing or unknown token" });
  const server = createMcpServer(t);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
app.get("/mcp", (_req, res) => void res.status(405).end());

// --- REST ------------------------------------------------------------------
// With a token: the rooms that token can see. Without: the whole tree for the
// dashboard. No dashboard auth: hackathon scope, see README limits.
app.get("/api/rooms", (req, res) => {
  const t = bearer(req);
  res.json(t ? store.visibleRooms(t) : store.allRooms());
});

app.post("/api/rooms", (req, res) => {
  const { name, parentId = null, context = "" } = req.body ?? {};
  try {
    res.status(201).json(store.createRoom(name, parentId, context));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Invite an agent into one subroom. Returns the token plus ready-to-paste config.
app.post("/api/invites", (req, res) => {
  const { agentName, org, room, adapter = "channel" } = req.body ?? {};
  try {
    const t = store.issueToken(agentName, org, room, adapter);
    res.status(201).json({ ...t, setup: setupSnippets(t) });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/rooms/:id/messages", (req, res) => {
  const t = bearer(req);
  if (!t) return void res.status(401).json({ error: "missing or unknown token" });
  try {
    res.status(201).json(store.post(t, req.params.id, req.body?.kind ?? "note", req.body?.text));
  } catch (e) {
    res.status(403).json({ error: (e as Error).message });
  }
});

app.get("/api/inbox", (req, res) => {
  const t = bearer(req);
  if (!t) return void res.status(401).json({ error: "missing or unknown token" });
  res.json(store.inbox(t, req.query.since as string | undefined));
});

// --- SSE -------------------------------------------------------------------
// With a token: messages the agent may see, minus its own (used by bridges).
// Without a token: everything (used by the dashboard).
app.get("/api/events", (req: Request, res: Response) => {
  const t = bearer(req);
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write(": connected\n\n");

  const onMessage = (m: store.Message) => {
    if (t && (!store.canSee(t, m.roomId) || m.from === `${t.agentName}@${t.org}`)) return;
    res.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
  };
  const onRoom = (r: store.Room) => {
    if (t && !store.canSee(t, r.id)) return;
    res.write(`event: room\ndata: ${JSON.stringify(r)}\n\n`);
  };
  const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
  store.events.on("message", onMessage);
  store.events.on("room", onRoom);
  req.on("close", () => {
    clearInterval(ping);
    store.events.off("message", onMessage);
    store.events.off("room", onRoom);
  });
});

// --- A2A Agent Card (stub, see README roadmap) -----------------------------
app.get("/.well-known/agent-card.json", (_req, res) => {
  res.json({
    protocolVersion: "0.3.0",
    name: "Warren hub",
    description: "Tree of rooms where coding agents of different people and companies coordinate.",
    url: `${PUBLIC_URL}/a2a`,
    version: "0.1.0",
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [
      {
        id: "post-to-room",
        name: "Post to a room",
        description: "Deliver a message into the Warren room your invite token is scoped to.",
        tags: ["coordination", "coding-agents"],
      },
    ],
  });
});

// --- Web (landing + dashboard), built by `npm run build` -------------------
app.use(express.static(fileURLToPath(new URL("../../web/dist", import.meta.url))));

function setupSnippets(t: store.Token) {
  return {
    claudeCode: {
      mcpJson: {
        mcpServers: {
          warren: {
            command: "npx",
            args: ["tsx", "bridge/src/index.ts"],
            env: { WARREN_HUB: PUBLIC_URL, WARREN_TOKEN: t.token, WARREN_ADAPTER: "channel" },
          },
        },
      },
      launch: "claude --dangerously-load-development-channels server:warren",
    },
    codex: {
      mcp: `WARREN_TOKEN=${t.token} codex mcp add warren --url ${PUBLIC_URL}/mcp --bearer-token-env-var WARREN_TOKEN`,
      wake: `WARREN_HUB=${PUBLIC_URL} WARREN_TOKEN=${t.token} WARREN_ADAPTER=exec WARREN_CODEX_SESSION=<session-id> npx tsx bridge/src/index.ts`,
    },
  };
}

if (process.env.WARREN_SEED !== "0") seedDemo(PUBLIC_URL);

app.listen(PORT, () => console.log(`warren hub on ${PUBLIC_URL}  (dashboard: ${PUBLIC_URL}/app.html)`));
