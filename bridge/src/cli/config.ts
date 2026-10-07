import { existsSync, lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Tool } from "./writers.js";

export interface FolderAgent {
  tool: Tool;
  hub: string;
  token: string;
  handle: string;
  session?: string;
  managedMcp?: { command: string; args: string[]; env: { WARREN_CONFIG: string } };
  cursorPermissionAdded?: boolean;
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

export function readFolder(dir: string, asked?: string): FolderAgent | undefined {
  const file = configPath(dir, asked);
  if (!existsSync(file)) return undefined;
  if (lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symbolic link; Warren refuses to read credentials through links`);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file} is not valid JSON (${(error as Error).message})`);
  }
  const agent = value as Partial<FolderAgent>;
  if (!agent || !["claude", "codex", "cursor"].includes(String(agent.tool)) || !agent.hub || !agent.token || !agent.handle)
    throw new Error(`${file} is not a valid Warren agent config`);
  return { ...agent, hub: hubOrigin(agent.hub) } as FolderAgent;
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
