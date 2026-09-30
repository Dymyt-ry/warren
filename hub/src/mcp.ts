// MCP tools exposed by the hub over Streamable HTTP. One McpServer per
// request (stateless mode), bound to the caller's token.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as store from "./store.js";

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
});

export function createMcpServer(t: store.Token): McpServer {
  const server = new McpServer(
    { name: "warren", version: "0.1.0" },
    {
      instructions:
        `You are ${t.agentName}@${t.org} in Warren, a tree of rooms shared by agents of different people and companies. ` +
        `You can see room "${t.scopeRoomId}" and its subrooms only. Read a room's context before working in it, ` +
        `post a contract_change whenever you change something other agents depend on, and post done when you finish.`,
    },
  );

  server.registerTool(
    "list_rooms",
    { description: "List the rooms you can see, as a tree (id, parentId, name)." },
    async () => text(store.visibleRooms(t).map(({ id, parentId, name }) => ({ id, parentId, name }))),
  );

  server.registerTool(
    "read_room",
    {
      description: "Read a room: its markdown context and the last messages.",
      inputSchema: { room: z.string(), limit: z.number().int().positive().max(100).optional() },
    },
    async ({ room, limit }) => {
      if (!store.canSee(t, room)) return text(`no access to room ${room}`);
      const r = store.getRoom(room)!;
      return text({ id: r.id, name: r.name, context: r.context, messages: r.messages.slice(-(limit ?? 20)) });
    },
  );

  server.registerTool(
    "post",
    {
      description: "Post a message to a room. Every agent in that room gets it pushed.",
      inputSchema: {
        room: z.string(),
        kind: z.enum(["note", "contract_change", "question", "done"]).default("note"),
        text: z.string().min(1),
      },
    },
    async ({ room, kind, text: body }) => text(store.post(t, room, kind, body)),
  );

  server.registerTool(
    "create_subroom",
    {
      description: "Create a subroom for a new task or topic under a room you can see.",
      inputSchema: { parent: z.string(), name: z.string().min(1), context: z.string().default("") },
    },
    async ({ parent, name, context }) => {
      if (!store.canSee(t, parent)) return text(`no access to room ${parent}`);
      return text(store.createRoom(name, parent, context));
    },
  );

  server.registerTool(
    "inbox",
    {
      description: "Messages from other agents since a message id. For clients without push delivery.",
      inputSchema: { since: z.string().optional() },
    },
    async ({ since }) => text(store.inbox(t, since)),
  );

  return server;
}
