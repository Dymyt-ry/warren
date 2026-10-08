import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Tool } from "./writers.js";

export interface FolderAgent {
  /** Local selector; never sent to the hub. Defaults to the client name. */
  profile?: string;
  tool: Tool;
  hub: string;
  token: string;
  handle: string;
  session?: string;
  cliOnly?: boolean;
  managedMcp?: { command: string; args: string[]; env: { WARREN_CONFIG: string; WARREN_AGENT?: string } };
  cursorPermissionAdded?: boolean;
}

export interface FolderAgents {
  version: 2;
  agents: Record<string, Omit<FolderAgent, "profile">>;
}

export const FOLDER_FILE = ".warren.json";

export function hubOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`invalid hub URL: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("hub URL must use http:// or https://");
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname))
    throw new Error("remote hub URLs must use https://; http:// is allowed only for loopback development");
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== ""))
    throw new Error("hub URL must be an origin without credentials, path, query or fragment");
  return url.origin;
}

export function configPath(dir: string, asked?: string): string {
  return resolve(dir, asked ?? process.env.WARREN_CONFIG ?? FOLDER_FILE);
}

function readConfigValue(dir: string, asked?: string): unknown | undefined {
  const file = configPath(dir, asked);
  if (!existsSync(file)) return undefined;
  if (lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symbolic link; Warren refuses to read credentials through links`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message})`);
  }
}

function validAgent(value: unknown, file: string, expectedTool?: Tool): FolderAgent {
  const agent = value as Partial<FolderAgent>;
  if (
    !agent ||
    !["claude", "codex", "cursor"].includes(String(agent.tool)) ||
    typeof agent.hub !== "string" ||
    typeof agent.token !== "string" ||
    typeof agent.handle !== "string" ||
    !agent.hub ||
    !agent.token ||
    !agent.handle ||
    (agent.session !== undefined && typeof agent.session !== "string") ||
    (agent.cliOnly !== undefined && typeof agent.cliOnly !== "boolean")
  )
    throw new Error(`${file} is not a valid Warren agent config`);
  if (expectedTool && agent.tool !== expectedTool) throw new Error(`${file} has a Warren agent under the wrong client key`);
  return { ...agent, hub: hubOrigin(agent.hub) } as FolderAgent;
}

/** Read every configured identity, accepting the original single-agent format. */
export function readFolderAgents(dir: string, asked?: string): FolderAgent[] | undefined {
  const file = configPath(dir, asked);
  const value = readConfigValue(dir, asked);
  if (value === undefined) return undefined;
  const collection = value as Partial<FolderAgents>;
  if (collection?.version !== 2 || !collection.agents || typeof collection.agents !== "object" || Array.isArray(collection.agents))
    return [validAgent(value, file)];
  const profiles = Object.keys(collection.agents);
  const invalid = profiles.filter((profile) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile));
  if (invalid.length) throw new Error(`${file} has invalid Warren profile names: ${invalid.join(", ")}`);
  const agents = profiles.map((profile) => ({
    ...validAgent(collection.agents![profile], file, (["claude", "codex", "cursor"] as string[]).includes(profile) ? (profile as Tool) : undefined),
    profile,
  }));
  const toolOrder: Tool[] = ["claude", "codex", "cursor"];
  agents.sort((left, right) => toolOrder.indexOf(left.tool) - toolOrder.indexOf(right.tool) || left.profile.localeCompare(right.profile));
  if (!agents.length) throw new Error(`${file} is not a valid Warren agent config`);
  if (new Set(agents.map((agent) => agent.handle)).size !== agents.length)
    throw new Error(`${file} assigns the same Warren agent to more than one client`);
  return agents;
}

export function selectFolderAgent(agents: FolderAgent[], selector?: string): FolderAgent {
  const handleOnly = selector?.startsWith("@") ?? false;
  const selected = selector?.replace(/^@/, "");
  if (selected) {
    // Client names are the stable selectors used by managed MCP wiring. Only
    // fall back to handles so an agent named "codex" cannot steal --as codex;
    // an explicit @handle still selects that handle.
    const byHandle = agents.find((candidate) => candidate.handle === selected);
    const byProfile = agents.find((candidate) => candidate.profile === selected);
    const byTool = agents.filter((candidate) => candidate.tool === selected);
    if (!handleOnly && !byProfile && byTool.length > 1)
      throw new Error(`multiple ${selected} agents are configured here; choose one with --as ${byTool.map((a) => a.profile).join("|--as ")}`);
    const agent = handleOnly ? byHandle : byProfile ?? (byTool.length === 1 ? byTool[0] : undefined) ?? byHandle;
    if (!agent)
      throw new Error(`no ${selector} agent is configured here; choose one of: ${agents.map((a) => a.profile ?? a.tool).join(", ")}`);
    return agent;
  }
  if (agents.length === 1) return agents[0];
  throw new Error(`multiple Warren agents are configured here; choose one with --as ${agents.map((a) => a.profile ?? a.tool).join("|--as ")}`);
}

export function readFolder(dir: string, asked?: string, selector?: string): FolderAgent | undefined {
  const agents = readFolderAgents(dir, asked);
  return agents ? selectFolderAgent(agents, selector) : undefined;
}

export function folderConfig(agents: FolderAgent[]): FolderAgents {
  return {
    version: 2,
    agents: Object.fromEntries(
      agents.map((agent) => {
        const { profile, ...stored } = agent;
        return [profile ?? agent.tool, stored];
      }),
    ),
  };
}

export function bridgeCommand(cliPath: string, node: string, version: string): { command: string; args: string[] } {
  if (/[\\/]_npx[\\/]/.test(cliPath)) return { command: "npx", args: ["-y", `warren-cli@${version}`, "bridge"] };
  if (cliPath.endsWith(".ts")) return { command: "npx", args: ["tsx", cliPath, "bridge"] };
  return { command: node, args: [cliPath, "bridge"] };
}

export function applyAgentEnv(agent: FolderAgent) {
  Object.assign(process.env, {
    WARREN_HUB: agent.hub,
    WARREN_TOKEN: agent.token,
    WARREN_ADAPTER: agent.tool === "claude" ? "channel" : "exec",
    WARREN_EXEC_CLIENT: agent.tool === "cursor" ? "cursor" : "codex",
    ...(agent.session ? { WARREN_EXEC_SESSION: agent.session } : {}),
  });
}
