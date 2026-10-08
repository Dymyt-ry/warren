import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { FOLDER_FILE, folderConfig, readFolderAgents, type FolderAgent } from "./config.js";

export const TOOLS = ["claude", "codex", "cursor"] as const;
export type Tool = (typeof TOOLS)[number];

export interface Wiring extends Omit<FolderAgent, "managedMcp" | "cursorPermissionAdded"> {
  bridge: { command: string; args: string[] };
}

interface Mutation {
  file: string;
  text?: string;
  remove?: boolean;
  mode?: number;
}

interface Snapshot {
  exists: boolean;
  text: string;
  mode: number;
}

export interface PreparedMutation {
  commit(): void;
  cancel(): void;
}

const CODEX_FILE = ".codex/config.toml";
const LOCK_FILE = `${FOLDER_FILE}.lock`;
const BEGIN = "# >>> warren (managed by warren-cli; `warren leave` removes it)";
const END = "# <<< warren";

const managedBridge = (bridge: Wiring["bridge"], selector: string) => ({
  ...bridge,
  env: { WARREN_CONFIG: FOLDER_FILE, WARREN_AGENT: selector },
});

const codexBlock = (managedMcp: ReturnType<typeof managedBridge>) => [
  BEGIN,
  "[mcp_servers.warren]",
  `command = ${tomlString(managedMcp.command)}`,
  `args = ${JSON.stringify(managedMcp.args)}`,
  `env = { "WARREN_CONFIG" = ${tomlString(FOLDER_FILE)}, "WARREN_AGENT" = "codex" }`,
  END,
];

export function wireFolder(dir: string, wiring: Wiring, options: { cliOnly?: boolean } = {}) {
  const releaseLock = acquireFolderLock(dir);
  try {
    assertCredentialUntracked(dir);
    const existing = readFolderAgents(dir) ?? [];
    const profile = wiring.profile ?? wiring.tool;
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(profile))
      throw new Error("profile must use 1-64 letters, digits, underscores or hyphens");
    if (existing.some((agent) => agent.profile === profile))
      throw new Error(`this folder already has the Warren profile ${profile}`);
    if (existing.some((agent) => agent.tool === wiring.tool) && !options.cliOnly)
      throw new Error(`multiple ${wiring.tool} agents require --cli-only and distinct --profile names`);
    if (existing.some((agent) => agent.handle === wiring.handle || agent.token === wiring.token))
      throw new Error(`@${wiring.handle} is already configured here; create a separate Warren agent for ${wiring.tool}`);
    const mutations: Mutation[] = [];
    const migrated = existing.map((agent) => migrateManagedWiring(dir, agent, wiring.bridge, mutations, options.cliOnly ?? false));
    const managedMcp = managedBridge(wiring.bridge, profile);
    let cursorPermissionAdded = false;

    if (options.cliOnly) {
      // The credential file and gitignore entry below are the only project
      // files CLI-only mode owns.
    } else if (wiring.tool === "claude") {
      const file = join(dir, ".mcp.json");
      assertProjectPath(dir, file);
      const config = readJson(file);
      const servers = mcpServers(config, file);
      refuseCollision(servers, file);
      mutations.push(jsonMutation(file, { ...config, mcpServers: { ...servers, warren: managedMcp } }));
    } else if (wiring.tool === "codex") {
      const file = join(dir, CODEX_FILE);
      assertProjectPath(dir, file);
      const rest = stripBlock(readText(file), BEGIN, END, CODEX_FILE);
      if (/^\s*\[\s*mcp_servers\s*\.\s*["']?warren["']?\s*\]/m.test(rest))
        throw new Error(`${CODEX_FILE} already has a Warren server not managed by warren-cli; remove it first`);
      const block = codexBlock(managedMcp);
      mutations.push({ file, text: `${rest}${rest && !rest.endsWith("\n") ? "\n" : ""}${block.join("\n")}\n` });
    } else {
      const mcpFile = join(dir, ".cursor/mcp.json");
      assertProjectPath(dir, mcpFile);
      const mcp = readJson(mcpFile);
      const servers = mcpServers(mcp, mcpFile);
      refuseCollision(servers, mcpFile);

      const cliFile = join(dir, ".cursor/cli.json");
      assertProjectPath(dir, cliFile);
      const cli = readJson(cliFile);
      const permissions = objectValue(cli.permissions, `${cliFile}: permissions`);
      const allow = stringArray(permissions.allow, `${cliFile}: permissions.allow`);
      const deny = stringArray(permissions.deny, `${cliFile}: permissions.deny`);
      cursorPermissionAdded = !allow.includes("Mcp(warren:*)");

      mutations.push(
        jsonMutation(mcpFile, { ...mcp, mcpServers: { ...servers, warren: managedMcp } }),
        jsonMutation(cliFile, {
          ...cli,
          permissions: {
            ...permissions,
            allow: cursorPermissionAdded ? [...allow, "Mcp(warren:*)"] : allow,
            deny,
          },
        }),
      );
    }

    const ignoreFile = join(dir, ".gitignore");
    assertProjectPath(dir, ignoreFile);
    const ignored = withGitignoreEntries(readText(ignoreFile), [FOLDER_FILE, LOCK_FILE]);
    mutations.push({ file: ignoreFile, text: ignored });
    const { bridge: _bridge, ...base } = wiring;
    const agent: FolderAgent = {
      ...base,
      profile,
      ...(options.cliOnly ? { cliOnly: true } : {}),
      ...(!options.cliOnly && (wiring.tool === "claude" || wiring.tool === "cursor") ? { managedMcp } : {}),
      ...(!options.cliOnly && wiring.tool === "cursor" ? { cursorPermissionAdded } : {}),
    };
    const folderFile = join(dir, FOLDER_FILE);
    assertProjectPath(dir, folderFile);
    mutations.push({ file: folderFile, text: JSON.stringify(folderConfig([...migrated, agent]), null, 2) + "\n", mode: 0o600 });
    applyMutations(mutations);
  } finally {
    releaseLock();
  }
}

function migrateManagedWiring(
  dir: string,
  agent: FolderAgent,
  bridge: Wiring["bridge"],
  mutations: Mutation[],
  allowMissing: boolean,
): FolderAgent {
  if (agent.cliOnly) return agent;
  const managedMcp = managedBridge(bridge, agent.profile ?? agent.tool);
  if (agent.tool === "codex") {
    const file = join(dir, CODEX_FILE);
    assertProjectPath(dir, file);
    if (!existsSync(file)) {
      if (allowMissing) return { ...agent, cliOnly: true };
      throw new Error(`${CODEX_FILE} is missing Warren's managed server; restore it before adding another agent`);
    }
    const text = readText(file);
    if (!text.includes(BEGIN)) {
      if (/^\s*\[\s*mcp_servers\s*\.\s*["']?warren["']?\s*\]/m.test(text))
        throw new Error(`${CODEX_FILE} has a Warren server not managed by warren-cli; remove it before adding another agent`);
      if (allowMissing) return { ...agent, cliOnly: true };
      throw new Error(`${CODEX_FILE} no longer has Warren's managed server; restore it before adding another agent`);
    }
    const rest = stripBlock(text, BEGIN, END, CODEX_FILE);
    if (/^\s*\[\s*mcp_servers\s*\.\s*["']?warren["']?\s*\]/m.test(rest))
      throw new Error(`${CODEX_FILE} also has a Warren server outside warren-cli's managed block; remove it before adding another agent`);
    mutations.push({ file, text: `${rest}${rest && !rest.endsWith("\n") ? "\n" : ""}${codexBlock(managedMcp).join("\n")}\n` });
    const { cliOnly: _cliOnly, ...wired } = agent;
    return wired;
  }

  const file = join(dir, agent.tool === "claude" ? ".mcp.json" : ".cursor/mcp.json");
  assertProjectPath(dir, file);
  if (!existsSync(file)) {
    if (allowMissing) return { ...agent, cliOnly: true };
    throw new Error(`${file} is missing Warren's managed server; restore it before adding another agent`);
  }
  const config = readJson(file, false);
  const servers = mcpServers(config, file);
  if (!("warren" in servers)) {
    if (allowMissing) return { ...agent, cliOnly: true };
    throw new Error(`${file} is missing Warren's managed server; restore it before adding another agent`);
  }
  if (!agent.managedMcp || JSON.stringify(servers.warren) !== JSON.stringify(agent.managedMcp))
    throw new Error(`${file}'s Warren server changed after warren-cli added it; restore the managed entry before adding another agent`);
  mutations.push(jsonMutation(file, { ...config, mcpServers: { ...servers, warren: managedMcp } }));
  const { cliOnly: _cliOnly, ...wired } = agent;
  return { ...wired, managedMcp };
}

/**
 * Parse and stage every local change before `leave` deletes the remote agent.
 * A crash before commit leaves the live files and credential untouched; a
 * retry after remote success sees 401 and commits the already-valid local plan.
 */
export function prepareUnwireFolder(dir: string, agent: FolderAgent): PreparedMutation {
  const releaseLock = acquireFolderLock(dir);
  try {
    const folderFile = join(dir, FOLDER_FILE);
    assertProjectPath(dir, folderFile);
    const configured = readFolderAgents(dir) ?? [];
    const current = configured.find((candidate) => candidate.profile === agent.profile && candidate.handle === agent.handle);
    if (!current || current.handle !== agent.handle || current.token !== agent.token || current.hub !== agent.hub)
      throw new Error(`the ${agent.tool} agent changed while this command was starting; retry with its current identity`);
    const remaining = configured.filter((candidate) => candidate.profile !== agent.profile || candidate.handle !== agent.handle);
    const prepared = prepareMutations([
      ...buildUnwireMutations(dir, agent),
      remaining.length
        ? { file: folderFile, text: JSON.stringify(folderConfig(remaining), null, 2) + "\n", mode: 0o600 }
        : { file: folderFile, remove: true },
    ]);
    return lockedMutation(prepared, releaseLock);
  } catch (error) {
    releaseLock();
    throw error;
  }
}

export function unwireFolder(dir: string, agent: FolderAgent) {
  prepareUnwireFolder(dir, agent).commit();
}

export function writeFolder(dir: string, agent: FolderAgent) {
  const releaseLock = acquireFolderLock(dir);
  try {
    const file = join(dir, FOLDER_FILE);
    assertProjectPath(dir, file);
    const configured = readFolderAgents(dir) ?? [];
    const index = configured.findIndex((candidate) => candidate.profile === agent.profile && candidate.handle === agent.handle);
    if (index === -1 || configured[index].handle !== agent.handle || configured[index].token !== agent.token || configured[index].hub !== agent.hub)
      throw new Error(`the ${agent.tool} agent changed while this command was starting; retry with its current identity`);
    configured[index] = agent;
    applyMutations([{ file, text: JSON.stringify(folderConfig(configured), null, 2) + "\n", mode: 0o600 }]);
  } finally {
    releaseLock();
  }
}

function lockedMutation(prepared: PreparedMutation, releaseLock: () => void): PreparedMutation {
  let finished = false;
  const finish = (action: () => void) => {
    if (finished) return action();
    try {
      return action();
    } finally {
      finished = true;
      releaseLock();
    }
  };
  return { commit: () => finish(() => prepared.commit()), cancel: () => finish(() => prepared.cancel()) };
}

function acquireFolderLock(dir: string): () => void {
  const file = join(dir, LOCK_FILE);
  assertProjectPath(dir, file);
  const owner = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 3; attempt++) {
    let descriptor: number | undefined;
    let created = false;
    try {
      descriptor = openSync(file, "wx", 0o600);
      created = true;
      writeFileSync(descriptor, owner);
      closeSync(descriptor);
      descriptor = undefined;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(file, "utf8") === owner) rmSync(file, { force: true });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (descriptor !== undefined) closeSync(descriptor);
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        if (created) rmSync(file, { force: true });
        throw error;
      }
      try {
        if (lstatSync(file).isSymbolicLink()) throw new Error(`${file} is a symbolic link; Warren refuses to use it as a lock`);
      } catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw statError;
      }
      let pid: number | undefined;
      try {
        pid = (JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown }).pid as number | undefined;
      } catch {}
      if (Number.isInteger(pid) && pid! > 0 && !processIsAlive(pid!))
        throw new Error(`${LOCK_FILE} was left by stopped process ${pid}; remove that lock file and retry`);
      if (!Number.isInteger(pid) || pid! <= 0)
        throw new Error(`${LOCK_FILE} is incomplete or stale; if no Warren command is running, remove that lock file and retry`);
      throw new Error(`another Warren command is updating this folder (${LOCK_FILE} is locked)`);
    }
  }
  throw new Error(`cannot acquire ${LOCK_FILE}`);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function buildUnwireMutations(dir: string, agent: FolderAgent): Mutation[] {
  const mutations: Mutation[] = [];
  if (agent.cliOnly) return mutations;
  if (agent.tool === "claude") {
    const file = join(dir, ".mcp.json");
    assertProjectPath(dir, file);
    const mutation = removeOwnedMcp(file, agent);
    if (mutation) mutations.push(mutation);
  } else if (agent.tool === "codex") {
    const file = join(dir, CODEX_FILE);
    assertProjectPath(dir, file);
    if (existsSync(file)) {
      const text = readText(file);
      const next = stripBlock(text, BEGIN, END, CODEX_FILE);
      if (next !== text) mutations.push({ file, text: next });
    }
  } else {
    const mcpFile = join(dir, ".cursor/mcp.json");
    assertProjectPath(dir, mcpFile);
    const mcpMutation = removeOwnedMcp(mcpFile, agent);
    if (mcpMutation) mutations.push(mcpMutation);

    if (agent.cursorPermissionAdded) {
      const cliFile = join(dir, ".cursor/cli.json");
      assertProjectPath(dir, cliFile);
      if (existsSync(cliFile)) {
        const cli = readJson(cliFile, false);
        const permissions = objectValue(cli.permissions, `${cliFile}: permissions`);
        const allow = stringArray(permissions.allow, `${cliFile}: permissions.allow`);
        if (allow.includes("Mcp(warren:*)"))
          mutations.push(
            jsonMutation(cliFile, {
              ...cli,
              permissions: { ...permissions, allow: allow.filter((permission) => permission !== "Mcp(warren:*)") },
            }),
          );
      }
    }
  }
  return mutations;
}

function removeOwnedMcp(file: string, agent: FolderAgent): Mutation | undefined {
  if (!existsSync(file)) return undefined;
  const config = readJson(file, false);
  const servers = mcpServers(config, file);
  if (!("warren" in servers)) return undefined;
  if (!agent.managedMcp || JSON.stringify(servers.warren) !== JSON.stringify(agent.managedMcp))
    throw new Error(`${file}'s Warren server changed after warren-cli added it; remove it by hand or restore the managed entry`);
  const { warren: _warren, ...others } = servers;
  return jsonMutation(file, { ...config, mcpServers: others });
}

function refuseCollision(servers: Record<string, unknown>, file: string) {
  if ("warren" in servers) throw new Error(`${file} already has a Warren server not managed by warren-cli; remove it first`);
}

function readJson(file: string, create = true): Record<string, unknown> {
  if (!existsSync(file)) {
    if (create) return {};
    throw new Error(`${file} does not exist`);
  }
  const text = readText(file).trim();
  try {
    const value: unknown = text ? JSON.parse(text) : {};
    return objectValue(value, file);
  } catch (error) {
    if ((error as Error).message.startsWith(`${file}:`)) throw error;
    throw new Error(`${file} is not plain JSON (${(error as Error).message}); fix it before running warren-cli`);
  }
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: expected an object`);
  return value as Record<string, unknown>;
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label}: expected an array of strings`);
  return value;
}

function mcpServers(config: Record<string, unknown>, file: string): Record<string, unknown> {
  return objectValue(config.mcpServers, `${file}: mcpServers`);
}

function jsonMutation(file: string, value: Record<string, unknown>): Mutation {
  return { file, text: JSON.stringify(value, null, 2) + "\n" };
}

function withGitignoreEntries(text: string, entries: string[]): string {
  const rules = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
  const wanted = entries.map((entry) => `/${entry}`);
  const suffix = rules.slice(-wanted.length).map((rule) => (rule.startsWith("/") ? rule : `/${rule}`));
  if (JSON.stringify(suffix) === JSON.stringify(wanted)) return text;
  return `${text}${text && !text.endsWith("\n") ? "\n" : ""}# warren agent credentials and lock\n${wanted.join("\n")}\n`;
}

function assertCredentialUntracked(dir: string) {
  const root = realpathSync(dir);
  if (!hasGitMetadata(root)) return;
  const safePath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .filter((entry) => {
      const normalized = entry.replaceAll("\\", "/").toLowerCase();
      if (normalized.includes("/node_modules/.bin") || normalized.includes("/_npx/")) return false;
      let candidate = resolve(entry);
      try {
        candidate = realpathSync(candidate);
      } catch {}
      const fromProject = relative(root, candidate);
      return fromProject === ".." || fromProject.startsWith(`..${sep}`) || isAbsolute(fromProject);
    })
    .join(delimiter);
  if (!safePath) throw new Error("cannot safely locate Git outside project-controlled executable paths");

  const env: NodeJS.ProcessEnv = { ...process.env, PATH: safePath };
  for (const key of Object.keys(env)) if (key.toUpperCase().startsWith("GIT_")) delete env[key];
  try {
    execFileSync("git", ["-C", dir, "ls-files", "--error-unmatch", "--", `:(icase)${FOLDER_FILE}`], { stdio: "ignore", env });
  } catch (error) {
    if ((error as { status?: number }).status === 1) return;
    throw new Error(`cannot safely verify whether ${FOLDER_FILE} is tracked by Git; fix the repository before storing an agent token`);
  }
  throw new Error(`${FOLDER_FILE} is tracked by Git; remove it from the index before storing an agent token`);
}

function hasGitMetadata(start: string): boolean {
  for (let current = start; ; current = dirname(current)) {
    if (existsSync(join(current, ".git"))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
  }
}

function applyMutations(mutations: Mutation[]) {
  prepareMutations(mutations).commit();
}

function assertProjectPath(dir: string, file: string) {
  const root = resolve(dir);
  const target = resolve(file);
  const within = relative(root, target);
  if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within))
    throw new Error(`${file} is outside the project folder`);

  let current = root;
  for (const part of within.split(sep)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) throw new Error(`${current} is a symbolic link; Warren refuses to write through links`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

function prepareMutations(mutations: Mutation[]): PreparedMutation {
  const snapshots = new Map<string, Snapshot>();
  for (const mutation of mutations) {
    if (!snapshots.has(mutation.file)) snapshots.set(mutation.file, snapshot(mutation.file));
  }
  const staged = new Map<Mutation, string>();
  try {
    for (const mutation of mutations) {
      mkdirSync(dirname(mutation.file), { recursive: true });
      const temporary = temporaryPath(mutation.file);
      writeFileSync(temporary, mutation.remove ? "" : mutation.text ?? "", {
        mode: mutation.remove ? 0o600 : mutation.mode ?? snapshots.get(mutation.file)!.mode,
      });
      staged.set(mutation, temporary);
    }
  } catch (error) {
    for (const temporary of staged.values()) rmSync(temporary, { force: true });
    throw error;
  }
  let finished = false;
  const cleanStaged = () => {
    for (const temporary of staged.values()) rmSync(temporary, { force: true });
  };
  return {
    commit() {
      if (finished) throw new Error("this Warren config transaction is already finished");
      try {
        for (const mutation of mutations) {
          const temporary = staged.get(mutation)!;
          if (mutation.remove) rmSync(mutation.file, { force: true });
          else {
            renameSync(temporary, mutation.file);
            chmodSync(mutation.file, mutation.mode ?? snapshots.get(mutation.file)!.mode);
          }
        }
        finished = true;
        cleanStaged();
      } catch (error) {
        for (const [file, before] of [...snapshots].reverse()) {
          try {
            if (before.exists) atomicWrite(file, before.text, before.mode);
            else rmSync(file, { force: true });
          } catch {}
        }
        finished = true;
        cleanStaged();
        throw error;
      }
    },
    cancel() {
      if (finished) return;
      finished = true;
      cleanStaged();
    },
  };
}

function snapshot(file: string): Snapshot {
  if (!existsSync(file)) return { exists: false, text: "", mode: 0o644 };
  return { exists: true, text: readText(file), mode: statSync(file).mode & 0o777 };
}

function atomicWrite(file: string, text: string, mode: number) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = temporaryPath(file);
  try {
    writeFileSync(temporary, text, { mode });
    renameSync(temporary, file);
    chmodSync(file, mode);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function temporaryPath(file: string): string {
  return join(dirname(file), `.${basename(file)}.${process.pid}.${randomUUID()}.tmp`);
}

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, "utf8") : "";
}

function stripBlock(text: string, begin: string, end: string, file: string): string {
  const start = text.indexOf(begin);
  if (start === -1) return text;
  const stop = text.indexOf(end, start);
  if (stop === -1) throw new Error(`${file} has Warren's start marker but no end marker; fix it by hand`);
  return text.slice(0, start) + text.slice(stop + end.length).replace(/^\n/, "");
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}
