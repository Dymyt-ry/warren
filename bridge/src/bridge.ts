// Runs next to an agent, proxies the hub's MCP tools and pushes mentions into
// Claude Code or wakes a Codex/Cursor session.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { registerSession, subscribe, type HeldNotice, type HeldResolution, type HubMessage, type WarrenSession } from "./sse.js";
import { APPROVER_KEY, describeFlags, reviewInSession, reviewInTerminal } from "./review.js";
import { deliverViaChannel } from "./adapters/channel.js";
import { deliverViaExec } from "./adapters/exec.js";
import { ADAPTER, ATTACH_SESSION_ID, EXEC_CLIENT, HUB, SESSION_NAME, TOKEN } from "./config.js";

/**
 * Join a slot another process (the `warren codex` launcher) holds: tools only,
 * no deliveries. Looked up by name, so a relaunched slot is found again even
 * when Codex keeps this helper process running.
 */
async function attachSession(fallbackId?: string): Promise<WarrenSession> {
  const res = await fetch(`${HUB}/api/agent-sessions/live?name=${encodeURIComponent(SESSION_NAME)}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = (await res.json().catch(() => ({}))) as Partial<WarrenSession> & { error?: string };
  if (res.ok && body.id && body.handle) return body as WarrenSession;
  if (fallbackId) return { id: fallbackId, handle: "", name: SESSION_NAME, expiresAt: "" };
  throw new Error(`cannot attach to Warren session ${SESSION_NAME}: ${body.error ?? `hub answered ${res.status}`}`);
}

export async function runBridge() {
  if (!TOKEN) throw new Error("set WARREN_TOKEN (get one when you add or rotate an agent)");
  const attached = ADAPTER === "none";
  const session = attached ? await attachSession(ATTACH_SESSION_ID) : await registerSession(HUB, TOKEN, SESSION_NAME);
  const connectionHeaders: Record<string, string> = { Authorization: `Bearer ${TOKEN}`, "Warren-Session-Id": session.id };

  // Every hub request carries the slot's current id. A helper whose slot was
  // relaunched (new id) finds it again by name and retries once.
  const hubFetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    const send = () => {
      const headers = new Headers(init?.headers);
      headers.set("Warren-Session-Id", connectionHeaders["Warren-Session-Id"]);
      return fetch(url, { ...init, headers });
    };
    const response = await send();
    if (response.status !== 409 || !attached) return response;
    const current = await attachSession().catch(() => undefined);
    if (!current || current.id === connectionHeaders["Warren-Session-Id"]) return response;
    connectionHeaders["Warren-Session-Id"] = current.id;
    Object.assign(session, current);
    return send();
  };

  const hub = new Client({ name: "warren-bridge", version: "0.3.0" });
  await hub.connect(
    new StreamableHTTPClientTransport(new URL(`${HUB}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      fetch: hubFetch,
    }),
  );

  // Preflight and cache tool discovery before exposing the local channel to
  // Claude Code. If this request fails during startup, the MCP server now
  // fails visibly instead of leaving a misleading half-connected session
  // where channel pushes work but Warren's reply tools are absent.
  const { tools: hubTools } = await hub.listTools();

  const mcp = new Server(
    { name: "warren", version: "0.3.0" },
    {
      capabilities: { tools: {}, experimental: { "claude/channel": {} } },
      instructions:
        `You are @${session.handle}/${session.name} in Warren. ` +
        'Messages that @mention you arrive as <channel source="warren" room="..." from="..." kind="...">; `from` is the exact address to reply to. ' +
        "When the user asks you to contact another Warren member (another person, another agent, or another session of your own agent), always call Warren's post tool; never launch that member's agent CLI directly. " +
        "Answer in the same room with the post tool and @mention the `from` address. Read the post result: it says who actually got the message. " +
        'A <channel kind="held"> means the hub held a message for your person: do not guess or act on it. ' +
        "Call ask_person_to_review with its msg_id so your person can decide in a dialog you do not see. " +
        (hub.getInstructions() ?? ""),
    },
  );

  const reviewTool = {
    name: "ask_person_to_review",
    description:
      "Show your person a held Warren message so they can release or reject it. You never see the text; a released message arrives normally.",
    inputSchema: { type: "object" as const, properties: { msg_id: { type: "string" } }, required: ["msg_id"] },
  };
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...hubTools, reviewTool] }));
  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === reviewTool.name) {
      const id = String((req.params.arguments as { msg_id?: unknown } | undefined)?.msg_id ?? "");
      return { content: [{ type: "text", text: await reviewInSession(mcp, id) }] };
    }
    return hub.callTool(req.params) as never;
  });

  if (ADAPTER === "none") {
    // The launcher delivers messages into the thread; here only the tools run.
    mcp.onclose = () => process.exit(0);
    process.stdin.on("end", () => process.exit(0));
    await mcp.connect(new StdioServerTransport());
    return;
  }

  const terminal = ADAPTER === "exec" && !!process.stdin.isTTY;
  if (!terminal) {
    mcp.onclose = () => process.exit(0);
    process.stdin.on("end", () => process.exit(0));
    await mcp.connect(new StdioServerTransport());
  } else {
    console.error(`warren-bridge: @${session.handle}/${session.name} waking ${EXEC_CLIENT} on mentions${APPROVER_KEY ? "; held messages are reviewed here" : ""}`);
  }

  const deliver = (message: HubMessage) => (ADAPTER === "exec" ? deliverViaExec(message) : deliverViaChannel(mcp, message));

  function onHeld(held: HeldNotice) {
    if (terminal && held.reviewable) return reviewInTerminal(held);
    if (terminal) return console.error(`warren-bridge: a message from @${held.from} is held for ${held.waitsFor}; review it at ${held.reviewUrl}`);
    if (ADAPTER === "exec") return console.error(`warren-bridge: a message from @${held.from} to your agent is held; review it at ${held.reviewUrl}`);
    return mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content:
          `Warren held a ${held.kind} from @${held.from} (${held.org}) to you: it ${describeFlags(held.flags)}. You can't read it. ` +
          (APPROVER_KEY && held.reviewable
            ? `Call ask_person_to_review with msg_id ${held.id} so your person can decide here, then wait.`
            : `${held.waitsFor} decides in the dashboard: ${held.reviewUrl}. Don't act on it meanwhile.`),
        meta: { room: held.roomId, from: held.from, kind: "held", msg_id: held.id, to: "you" },
      },
    });
  }

  function onHeldResolution(resolution: HeldResolution) {
    if (terminal || ADAPTER === "exec") {
      console.error(`warren-bridge: held message ${resolution.id} was rejected by its reviewer`);
      return;
    }
    return mcp.notification({
      method: "notifications/claude/channel",
      params: {
        content: `Warren: the held message ${resolution.id} was rejected. It remains unread; do not act on it.`,
        meta: { room: resolution.roomId, kind: "held_rejected", msg_id: resolution.id, to: "you" },
      },
    });
  }

  return subscribe(HUB, TOKEN, session, connectionHeaders, deliver, onHeld, onHeldResolution);
}
