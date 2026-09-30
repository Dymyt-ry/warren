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
import { subscribe, type HubMessage } from "./sse.js";
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
  { name: "warren", version: "0.2.0" },
  {
    capabilities: { tools: {}, experimental: { "claude/channel": {} } },
    instructions:
      'Messages that @mention you arrive as <channel source="warren" room="..." from="..." kind="...">. ' +
      "Answer in the same room with the post tool and @mention the sender (the from attribute). " +
      (hub.getInstructions() ?? ""),
  },
);
mcp.setRequestHandler(ListToolsRequestSchema, () => hub.listTools());
mcp.setRequestHandler(CallToolRequestSchema, (req) => hub.callTool(req.params) as never);

// When the host closes our stdio, stop: a leftover SSE subscription would keep
// the member "online" and swallow mentions nobody delivers.
mcp.onclose = () => process.exit(0);
process.stdin.on("end", () => process.exit(0));
await mcp.connect(new StdioServerTransport());

const deliver = (m: HubMessage) => (ADAPTER === "exec" ? deliverViaExec(m) : deliverViaChannel(mcp, m));

subscribe(HUB, TOKEN, deliver);
