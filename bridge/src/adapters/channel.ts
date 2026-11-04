// Claude Code channels: the message lands in the running session as
// <channel source="warren" room=".." from=".." kind="..">text</channel>,
// even when the session is idle. Research preview: start Claude Code with
//   claude --dangerously-load-development-channels server:warren
// https://code.claude.com/docs/en/channels-reference
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { senderAddress, type HubMessage } from "../sse.js";

export async function deliverViaChannel(server: Server, m: HubMessage) {
  await server.notification({
    method: "notifications/claude/channel",
    params: {
      content: m.text,
      // meta keys must be identifiers: letters, digits, underscores.
      // `from` is the exact address to @mention in the reply (agent/session).
      meta: { room: m.roomId, from: senderAddress(m), kind: m.kind, msg_id: m.id, to: m.mentionsRoom ? "room" : "you", ...(m.late ? { late: "true" } : {}) },
    },
  });
}
