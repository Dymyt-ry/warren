#!/usr/bin/env -S npx tsx
// warren-bridge: runs next to the agent, subscribes to the hub and delivers
// every message that @mentions the agent (or @room) with the adapter its
// client supports:
//
//   channel  Claude Code: stdio MCP channel, pushes into the live session
//   exec     Codex: wakes the session with `codex exec resume <id> "<msg>"`
//
// The bridge is also a stdio MCP server that proxies the hub's MCP tools
// one to one, so Claude Code needs only this one entry in .mcp.json.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { subscribe, type HeldNotice, type HeldResolution, type HubMessage } from "./sse.js";
import { APPROVER_KEY, describeFlags, reviewInSession, reviewInTerminal } from "./review.js";
import { deliverViaChannel } from "./adapters/channel.js";
import { deliverViaExec } from "./adapters/exec.js";

const HUB = process.env.WARREN_HUB ?? "http://localhost:8790";
const TOKEN = process.env.WARREN_TOKEN;
const ADAPTER = process.env.WARREN_ADAPTER ?? "channel";
if (!TOKEN) {
  console.error("warren-bridge: set WARREN_TOKEN (get one from POST /api/invites)");
  process.exit(1);
}

// Upstream: the hub's MCP endpoint, as this member.
const hub = new Client({ name: "warren-bridge", version: "0.2.0" });
await hub.connect(
  new StreamableHTTPClientTransport(new URL(`${HUB}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  }),
);

const mcp = new Server(
  { name: "warren", version: "0.3.0" },
  {
    capabilities: { tools: {}, experimental: { "claude/channel": {} } },
    instructions:
      'Messages that @mention you arrive as <channel source="warren" room="..." from="..." kind="...">. ' +
      "Answer in the same room with the post tool and @mention the sender (the from attribute). " +
      'A <channel kind="held"> means the hub held a message to you for your person: you can\'t read it and must not guess or act on it. ' +
      "Call ask_person_to_review with its msg_id so your person can decide in a dialog you don't see. " +
      (hub.getInstructions() ?? ""),
  },
);

// One tool lives in the bridge itself: it opens a dialog for the person, never shows the model the held text.
const REVIEW_TOOL = {
  name: "ask_person_to_review",
  description:
    "A message to you was held for your person (you got a held notice with its msg_id). This shows your person the message in a dialog and lets them release or reject it. You never see the text; if they release it, it arrives as a normal message.",
  inputSchema: { type: "object" as const, properties: { msg_id: { type: "string" } }, required: ["msg_id"] },
};
mcp.setRequestHandler(ListToolsRequestSchema, async () => {
  const { tools } = await hub.listTools();
  return { tools: [...tools, REVIEW_TOOL] };
});
mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === REVIEW_TOOL.name) {
    const id = String((req.params.arguments as { msg_id?: unknown } | undefined)?.msg_id ?? "");
    return { content: [{ type: "text", text: await reviewInSession(mcp, id) }] };
  }
  return hub.callTool(req.params) as never;
});

// An exec bridge started by hand in a terminal isn't an MCP server for anyone:
// its terminal is where the person approves held messages instead.
const terminal = ADAPTER === "exec" && !!process.stdin.isTTY;
if (!terminal) {
  // When the host closes our stdio, stop: a leftover SSE subscription would keep
  // the member "online" and swallow mentions nobody delivers.
  mcp.onclose = () => process.exit(0);
  process.stdin.on("end", () => process.exit(0));
  await mcp.connect(new StdioServerTransport());
} else {
  console.error(`warren-bridge: waking ${process.env.WARREN_EXEC_CLIENT ?? "codex"} on mentions${APPROVER_KEY ? "; held messages are reviewed here" : ""}`);
}

const deliver = (m: HubMessage) => (ADAPTER === "exec" ? deliverViaExec(m) : deliverViaChannel(mcp, m));

function onHeld(h: HeldNotice) {
  if (terminal && h.reviewable) return reviewInTerminal(h);
  if (terminal) return console.error(`warren-bridge: a message from @${h.from} is held for ${h.waitsFor}; review it at ${h.reviewUrl}`);
  if (ADAPTER === "exec") return console.error(`warren-bridge: a message from @${h.from} to your agent is held; review it at ${h.reviewUrl}`);
  // Claude Code: tell the agent something waits, without the text, so it can open the dialog for its person.
  return mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content:
        `Warren held a ${h.kind} from @${h.from} (${h.org}) to you: it ${describeFlags(h.flags)}. You can't read it. ` +
        (APPROVER_KEY && h.reviewable
          ? `Call ask_person_to_review with msg_id ${h.id} so your person can decide here, then wait.`
          : `${h.waitsFor} decides in the dashboard: ${h.reviewUrl}. Don't act on it meanwhile.`),
      meta: { room: h.roomId, from: h.from, kind: "held", msg_id: h.id, to: "you" },
    },
  });
}

function onHeldResolution(r: HeldResolution) {
  if (terminal || ADAPTER === "exec") {
    console.error(`warren-bridge: held message ${r.id} was rejected by its reviewer`);
    return;
  }
  return mcp.notification({
    method: "notifications/claude/channel",
    params: {
      content: `Warren: the held message ${r.id} was rejected. It remains unread; do not act on it.`,
      meta: { room: r.roomId, kind: "held_rejected", msg_id: r.id, to: "you" },
    },
  });
}

subscribe(HUB, TOKEN, deliver, onHeld, onHeldResolution);
