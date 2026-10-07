import { execFileSync } from "node:child_process";
import { applyAgentEnv, hubOrigin, readFolder, type FolderAgent } from "./config.js";
import { prepareUnwireFolder, TOOLS, wireFolder, writeFolder, type Tool, type Wiring } from "./writers.js";

interface Member {
  handle: string;
  kind: "human" | "agent";
  adapter?: "channel" | "exec" | "inbox";
  online?: boolean;
}

async function hubCall<T>(hub: string, path: string, token: string, method = "GET"): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${hub}${path}`, { method, headers: { Authorization: `Bearer ${token}` } });
  } catch (error) {
    throw new Error(`cannot reach the hub at ${hub} (${(error as Error).message})`);
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${(body as { error?: string }).error ?? "hub request failed"}`);
  return body as T;
}

function asTool(value: string | undefined): Tool {
  if (!TOOLS.includes(value as Tool)) throw new Error(`tool must be one of: ${TOOLS.join(", ")}`);
  return value as Tool;
}

export async function add(
  dir: string,
  toolValue: string | undefined,
  options: { hub?: string; token?: string; session?: string; bridge: Wiring["bridge"]; wakeCommand: string; promptToken?: () => Promise<string> },
) {
  const tool = asTool(toolValue);
  if (readFolder(dir)) throw new Error("this folder already has a Warren agent; run `warren leave` first");
  const hub = hubOrigin(options.hub ?? process.env.WARREN_HUB ?? "");
  const token = options.token ?? process.env.WARREN_TOKEN ?? (await options.promptToken?.());
  if (!token) throw new Error("pass --token <agent-token> or set WARREN_TOKEN");
  const member = await hubCall<Member>(hub, "/api/me", token);
  if (member.kind !== "agent") throw new Error("that credential belongs to a person; only an agent token may be wired into a project");
  const expected = tool === "claude" ? "channel" : "exec";
  if (member.adapter !== expected)
    throw new Error(`@${member.handle} uses the ${member.adapter ?? "unknown"} adapter; create or update it as ${expected} for ${tool}`);
  wireFolder(dir, {
    tool,
    hub,
    token,
    handle: member.handle,
    session: options.session,
    bridge: options.bridge,
  });
  console.log(`This folder's ${tool} is now @${member.handle}.`);
  if (tool === "claude") console.log("Start Claude Code with: claude --dangerously-load-development-channels server:warren");
  else console.log(`For always-on mention delivery, keep this running in a second terminal:\n  ${options.wakeCommand}`);
}

export async function leave(dir: string) {
  const agent = readFolder(dir);
  if (!agent) throw new Error("this folder has no Warren agent");
  const local = prepareUnwireFolder(dir, agent);
  try {
    await hubCall(agent.hub, "/api/agents/self", agent.token, "DELETE");
  } catch (error) {
    const message = (error as Error).message;
    if (message.startsWith("cannot reach")) {
      local.cancel();
      throw new Error(`${message}; nothing changed, retry when the hub is back`);
    }
    if (!message.startsWith("401:")) {
      local.cancel();
      throw error;
    }
  }
  local.commit();
  console.log(`@${agent.handle} left Warren and this folder was unwired.`);
}

export async function status(dir: string) {
  const agent = readFolder(dir);
  if (!agent) return void console.log("This folder has no Warren agent. Run `warren add <claude|codex|cursor>`. ");
  const remote = await hubCall<Member>(agent.hub, "/api/me", agent.token).then(
    (member) => `${member.online ? "online" : "offline"} at ${agent.hub}`,
    (error: Error) => error.message,
  );
  console.log(`@${agent.handle} (${agent.tool}): ${remote}`);
}

async function startBridge(agent: FolderAgent) {
  applyAgentEnv(agent);
  const { runBridge } = await import("../bridge.js");
  await runBridge();
}

export async function bridge(dir: string, config?: string) {
  const agent = readFolder(dir, config);
  if (!agent) throw new Error(`no Warren agent config found in ${dir}`);
  await startBridge(agent);
}

export async function wake(dir: string, session?: string) {
  const agent = readFolder(dir);
  if (!agent) throw new Error("this folder has no Warren agent");
  if (agent.tool === "claude") throw new Error("Claude Code receives channel pushes; it does not need `warren wake`");
  let nextSession = session ?? agent.session;
  if (!nextSession && agent.tool === "cursor") {
    nextSession = execFileSync(process.env.WARREN_EXEC_CMD ?? "cursor-agent", ["create-chat"], { cwd: dir, encoding: "utf8" }).trim();
    console.error(`created Cursor chat ${nextSession}`);
  }
  if (nextSession && nextSession !== agent.session) writeFolder(dir, { ...agent, session: nextSession });
  if (!nextSession) console.error("no session given: Codex will resume its most recent session");
  await startBridge({ ...agent, session: nextSession });
}
