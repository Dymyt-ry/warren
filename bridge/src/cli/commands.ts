import { execFileSync, spawn } from "node:child_process";
import { applyAgentEnv, configPath, hubOrigin, readFolder, readFolderAgents, selectFolderAgent, type FolderAgent } from "./config.js";
import { prepareUnwireFolder, TOOLS, wireClaudeLaunch, wireFolder, writeFolder, type Tool, type Wiring } from "./writers.js";

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
  options: {
    hub?: string;
    token?: string;
    session?: string;
    cliOnly?: boolean;
    profile?: string;
    bridge: Wiring["bridge"];
    wakeCommand: string;
    bindCommand?: string;
    launchCommand?: string;
    promptToken?: () => Promise<string>;
  },
) {
  const tool = asTool(toolValue);
  const configured = readFolderAgents(dir) ?? [];
  const profile = options.profile ?? tool;
  if (configured.some((agent) => agent.profile === profile))
    throw new Error(`this folder already has the Warren profile ${profile}`);
  if (!options.profile && configured.some((agent) => agent.tool === tool))
    throw new Error(`this folder already has a ${tool} agent; add another with --profile <name>`);
  const hub = hubOrigin(options.hub ?? process.env.WARREN_HUB ?? "");
  const token = options.token ?? process.env.WARREN_TOKEN ?? (await options.promptToken?.());
  if (!token) throw new Error("pass --token <agent-token> or set WARREN_TOKEN");
  const member = await hubCall<Member>(hub, "/api/me", token);
  if (member.kind !== "agent") throw new Error("that credential belongs to a person; only an agent token may be wired into a project");
  const expected = tool === "claude" ? "channel" : "exec";
  if (member.adapter !== expected)
    throw new Error(`@${member.handle} uses the ${member.adapter ?? "unknown"} adapter; create or update it as ${expected} for ${tool}`);
  wireFolder(
    dir,
    {
      tool,
      hub,
      token,
      handle: member.handle,
      profile: options.profile,
      session: options.session,
      bridge: options.bridge,
    },
    { cliOnly: options.cliOnly },
  );
  console.log(`This folder's ${tool} is now @${member.handle}.`);
  if (options.cliOnly && (tool === "claude" || tool === "codex"))
    console.log(`No ${tool === "claude" ? "Claude" : "Codex"} project config was changed. Start a connected session with:\n  ${options.launchCommand ?? `warren ${tool}`}`);
  else if (options.cliOnly)
    console.log(
      `No ${tool} project config was changed. Bind from inside the session, then listen in another terminal:\n` +
        `  ${options.bindCommand ?? `warren bind --as ${tool}`}\n  ${options.wakeCommand}`,
    );
  else if (tool === "claude" || tool === "codex") console.log(`Start a connected session with: ${options.launchCommand ?? `warren ${tool}`}`);
  else console.log(`For always-on mention delivery, keep this running in a second terminal:\n  ${options.wakeCommand}`);
}

export async function leave(dir: string, selector?: string) {
  const agent = readFolder(dir, undefined, selector);
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

export async function status(dir: string, selector?: string) {
  const configured = readFolderAgents(dir);
  if (!configured) return void console.log("This folder has no Warren agent. Run `warren add <claude|codex|cursor>`. ");
  const agents = selector ? [selectFolderAgent(configured, selector)] : configured;
  for (const agent of agents) {
    const remote = await hubCall<Member>(agent.hub, "/api/me", agent.token).then(
      (member) => `${member.online ? "online" : "offline"} at ${agent.hub}`,
      (error: Error) => error.message,
    );
    console.log(`@${agent.handle} (${agent.tool}): ${remote}`);
  }
}

async function startBridge(agent: FolderAgent) {
  applyAgentEnv(agent);
  const { runBridge } = await import("../bridge.js");
  await runBridge();
}

export async function bridge(dir: string, config?: string, selector?: string, name?: string) {
  const agent = readFolder(dir, config, selector ?? process.env.WARREN_AGENT);
  if (!agent) throw new Error(`no Warren agent config found in ${dir}`);
  if (name) process.env.WARREN_SESSION_NAME = name;
  await startBridge(agent);
}

export async function wake(dir: string, session?: string, selector?: string, name?: string) {
  const configured = readFolderAgents(dir);
  const wakeable = configured?.filter((agent) => agent.tool !== "claude");
  const agent = configured
    ? selector
      ? selectFolderAgent(configured, selector)
      : wakeable?.length === 1
        ? wakeable[0]
        : selectFolderAgent(configured)
    : undefined;
  if (!agent) throw new Error("this folder has no Warren agent");
  if (agent.tool === "claude") throw new Error("Claude Code receives channel pushes through `warren launch claude`");
  let nextSession = session ?? agent.session;
  if (!nextSession && agent.tool === "cursor") {
    nextSession = execFileSync(process.env.WARREN_EXEC_CMD ?? "cursor-agent", ["create-chat"], { cwd: dir, encoding: "utf8" }).trim();
    console.error(`created Cursor chat ${nextSession}`);
  }
  if (nextSession && nextSession !== agent.session) writeFolder(dir, { ...agent, session: nextSession });
  if (!nextSession) console.error("no session bound: Codex will resume its most recent session; bind one for live `codex queue` delivery");
  if (name) process.env.WARREN_SESSION_NAME = name;
  await startBridge({ ...agent, session: nextSession });
}

export function bindSession(
  dir: string,
  selector?: string,
  session?: string,
  environment: Record<string, string | undefined> = process.env,
  options: { quiet?: boolean } = {},
) {
  const agent = readFolder(dir, undefined, selector);
  if (!agent) throw new Error("this folder has no Warren agent");
  if (agent.tool === "claude") throw new Error("Claude sessions receive pushes through `warren launch claude`; they are not bound to the exec adapter");
  const detected = (
    session ??
    (agent.tool === "codex"
      ? environment.CODEX_THREAD_ID ?? environment.CODEX_SESSION_ID
      : environment.CURSOR_SESSION_ID ?? environment.CURSOR_CHAT_ID)
  )?.trim();
  if (!detected) throw new Error(`no ${agent.tool} session detected; run this inside the agent session or pass --session <id>`);
  writeFolder(dir, { ...agent, session: detected });
  if (!options.quiet) console.log(`@${agent.handle} is bound to ${agent.tool} session ${detected}.`);
}

interface CodexHookEvent {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
}

/** Bind the exact Codex thread announced by the SessionStart hook. */
export function bindCodexHook(dir: string, selector: string | undefined, input: string) {
  let event: CodexHookEvent;
  try {
    event = JSON.parse(input) as CodexHookEvent;
  } catch {
    throw new Error("Codex hook input is not valid JSON");
  }
  if (event.hook_event_name !== "SessionStart" || typeof event.session_id !== "string" || !event.session_id.trim())
    throw new Error("Codex hook did not provide a SessionStart session_id");
  if (typeof event.cwd === "string" && event.cwd && event.cwd !== dir)
    throw new Error(`Codex hook cwd ${event.cwd} does not match ${dir}`);
  bindSession(dir, selector, event.session_id, {}, { quiet: true });
}

export function claudeLaunchArgs(session?: string): string[] {
  return [
    ...(session ? ["--resume", session] : []),
    "--dangerously-load-development-channels",
    "server:warren",
  ];
}

export function claudeLaunchEnv(sessionName: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, WARREN_SESSION_NAME: sessionName };
}

const tomlString = (value: string) => JSON.stringify(value);
const shellWord = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

function bridgeCliArgs(bridgeCommand: Wiring["bridge"], command: string, extra: string[] = []): string[] {
  if (bridgeCommand.args.at(-1) !== "bridge") throw new Error("Warren bridge command is malformed");
  return [...bridgeCommand.args.slice(0, -1), command, ...extra];
}

/** Start Codex with token-free inline MCP wiring and an exact SessionStart binding hook. */
export function codexLaunchArgs(
  configFile: string,
  bridgeCommand: Wiring["bridge"],
  selector = "codex",
  session?: string,
  sessionName = selector,
): string[] {
  const hookCommand = [bridgeCommand.command, ...bridgeCliArgs(bridgeCommand, "codex-hook", ["--as", selector])]
    .map(shellWord)
    .join(" ");
  const hook =
    `[{ matcher = "^(startup|resume)$", hooks = [` +
    `{ type = "command", command = ${tomlString(hookCommand)}, timeout = 10, statusMessage = "Connecting Warren" }` +
    `] }]`;
  return [
    "-c",
    `mcp_servers.warren.command=${tomlString(bridgeCommand.command)}`,
    "-c",
    `mcp_servers.warren.args=${JSON.stringify(bridgeCommand.args)}`,
    "-c",
    `mcp_servers.warren.env={ WARREN_CONFIG = ${tomlString(configFile)}, WARREN_AGENT = ${tomlString(selector)}, WARREN_SESSION_NAME = ${tomlString(sessionName)} }`,
    "-c",
    `hooks.SessionStart=${hook}`,
    "--dangerously-bypass-hook-trust",
    ...(session ? ["resume", session] : []),
  ];
}

export async function launch(
  dir: string,
  toolValue: string | undefined,
  options: { session?: string; bridge: Wiring["bridge"]; command?: string; selector?: string; name?: string },
) {
  const tool = asTool(toolValue);
  const agent = readFolder(dir, undefined, options.selector ?? tool);
  if (!agent) throw new Error(`this folder has no ${tool} Warren agent`);
  if (agent.tool !== tool) throw new Error(`@${agent.handle} is a ${agent.tool} agent, not ${tool}`);
  const requestedSession = options.session?.trim();
  if (options.session !== undefined && !requestedSession) throw new Error(`${tool} session id must not be empty`);
  const nextSession = requestedSession ?? agent.session;
  if (requestedSession && requestedSession !== agent.session) writeFolder(dir, { ...agent, session: requestedSession });
  const selector = agent.profile ?? agent.tool;
  const sessionName = options.name?.trim() || selector;
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(sessionName))
    throw new Error("session name must use 1-64 lowercase letters, numbers, _ or -");
  let args: string[];
  if (tool === "claude") {
    wireClaudeLaunch(dir, agent, options.bridge);
    args = claudeLaunchArgs(nextSession);
  } else {
    args = codexLaunchArgs(configPath(dir), options.bridge, selector, requestedSession, sessionName);
  }
  await new Promise<void>((resolve, reject) => {
    const command =
      options.command ?? (tool === "claude" ? process.env.WARREN_CLAUDE_CMD ?? "claude" : process.env.WARREN_CODEX_CMD ?? "codex");
    const child = spawn(command, args, {
      cwd: dir,
      stdio: "inherit",
      ...(tool === "claude" ? { env: claudeLaunchEnv(sessionName) } : {}),
    });
    child.once("error", (error) => {
      reject(new Error(`cannot launch ${tool === "claude" ? "Claude Code" : "Codex"} (${error.message})`));
    });
    child.once("exit", (code, signal) => {
      if (code === 0 || signal === "SIGINT") resolve();
      else reject(new Error(`${tool === "claude" ? "Claude Code" : "Codex"} exited with ${code ?? signal}`));
    });
  });
}
