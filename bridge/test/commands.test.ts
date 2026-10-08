import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { add, bindCodexHook, bindSession, claudeLaunchArgs, claudeLaunchEnv, codexLaunchArgs } from "../src/cli/commands.js";
import { readFolderAgents } from "../src/cli/config.js";
import { wireClaudeLaunch } from "../src/cli/writers.js";

const options = {
  hub: "https://warren.example.com",
  token: "wr_example_agent", // gitleaks:allow
  bridge: { command: "warren", args: ["bridge"] },
  wakeCommand: "warren wake",
};

test("add refuses a person's credential before writing project files", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-command-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async () => new Response(JSON.stringify({ handle: "owner", kind: "human", adapter: "dashboard" }), { status: 200 });
  await assert.rejects(add(dir, "codex", options), /belongs to a person/);
  assert.equal(existsSync(join(dir, ".warren.json")), false);
  assert.equal(existsSync(join(dir, ".codex/config.toml")), false);
});

test("add refuses an agent whose delivery adapter does not match the client", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-command-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async () => new Response(JSON.stringify({ handle: "claude-owner", kind: "agent", adapter: "channel" }), { status: 200 });
  await assert.rejects(add(dir, "codex", options), /uses the channel adapter/);
  assert.equal(existsSync(join(dir, ".warren.json")), false);
});

test("add can obtain the agent token from an interactive prompt callback", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-command-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${options.token}`);
    return new Response(JSON.stringify({ handle: "codex-owner", kind: "agent", adapter: "exec" }), { status: 200 });
  };
  const { token: _token, ...withoutToken } = options;
  await add(dir, "codex", { ...withoutToken, promptToken: async () => options.token });
  assert.equal(existsSync(join(dir, ".warren.json")), true);
});

test("CLI-only add stores the identity without changing native client config", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-command-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async () => new Response(JSON.stringify({ handle: "claude-owner", kind: "agent", adapter: "channel" }), { status: 200 });

  await add(dir, "claude", { ...options, cliOnly: true });

  assert.equal(readFolderAgents(dir)?.[0].cliOnly, true);
  assert.equal(existsSync(join(dir, ".mcp.json")), false);
});

test("add keeps an existing Codex identity when Claude joins the same folder", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-command-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async (_input, init) => {
    const authorization = (init?.headers as Record<string, string>).Authorization;
    return new Response(
      JSON.stringify(
        authorization === `Bearer ${options.token}`
          ? { handle: "codex-owner", kind: "agent", adapter: "exec" }
          : { handle: "claude-owner", kind: "agent", adapter: "channel" },
      ),
      { status: 200 },
    );
  };
  await add(dir, "codex", options);
  await add(dir, "claude", { ...options, token: "wr_example_claude" }); // gitleaks:allow
  assert.deepEqual(readFolderAgents(dir)?.map((agent) => agent.tool), ["claude", "codex"]);
});

test("add supports multiple agents of the same client with distinct profiles", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-command-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async (_input, init) => {
    const token = (init?.headers as Record<string, string>).Authorization;
    const handle = token.endsWith("_two") ? "codex-two" : "codex-one";
    return new Response(JSON.stringify({ handle, kind: "agent", adapter: "exec" }), { status: 200 });
  };

  await add(dir, "codex", { ...options, cliOnly: true, profile: "codex-api" });
  await add(dir, "codex", { ...options, token: `${options.token}_two`, cliOnly: true, profile: "codex-ui" });

  assert.deepEqual(readFolderAgents(dir)?.map((agent) => agent.profile), ["codex-api", "codex-ui"]);
});

test("destructive commands reject ignored positional arguments", () => {
  const cli = new URL("../src/cli.ts", import.meta.url);
  const result = spawnSync(process.execPath, ["--import", "tsx", cli.pathname, "leave", "codex"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /leave takes no positional arguments; use --as/);
});

test("argument parser errors use the normal concise CLI error", () => {
  const cli = new URL("../src/cli.ts", import.meta.url);
  const result = spawnSync(process.execPath, ["--import", "tsx", cli.pathname, "--not-a-warren-option"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^warren:/);
  assert.doesNotMatch(result.stderr, /node:internal|ERR_PARSE_ARGS/);
});

test("the CLI accepts --cli-only for add", () => {
  const cli = new URL("../src/cli.ts", import.meta.url);
  const result = spawnSync(process.execPath, ["--import", "tsx", cli.pathname, "add", "unknown", "--cli-only"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /tool must be one of/);
  assert.doesNotMatch(result.stderr, /Unknown option/);
});

test("bind stores the current Codex thread for live queue delivery", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-command-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async () => new Response(JSON.stringify({ handle: "codex-owner", kind: "agent", adapter: "exec" }), { status: 200 });
  await add(dir, "codex", { ...options, cliOnly: true });

  bindSession(dir, "codex", undefined, { CODEX_THREAD_ID: "thread-123" });

  assert.equal(readFolderAgents(dir)?.[0].session, "thread-123");
});

test("bind refuses to guess when it is outside a Codex session", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-command-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async () => new Response(JSON.stringify({ handle: "codex-owner", kind: "agent", adapter: "exec" }), { status: 200 });
  await add(dir, "codex", { ...options, cliOnly: true });

  assert.throws(() => bindSession(dir, "codex", undefined, {}), /no codex session detected/);
});

test("bind directs Claude to its channel launcher", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-command-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async () => new Response(JSON.stringify({ handle: "claude-owner", kind: "agent", adapter: "channel" }), { status: 200 });
  await add(dir, "claude", { ...options, cliOnly: true });

  assert.throws(() => bindSession(dir, "claude", "session-123", {}), /warren launch claude/);
});

test("Claude launch uses the project-configured Warren channel", () => {
  assert.deepEqual(claudeLaunchArgs("claude-session"), [
    "--resume",
    "claude-session",
    "--dangerously-load-development-channels",
    "server:warren",
  ]);
});

test("Claude launch keeps a stable token-free project MCP entry while the process selects the slot", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-command-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async () => new Response(JSON.stringify({ handle: "claude-owner", kind: "agent", adapter: "channel" }), { status: 200 });
  await add(dir, "claude", { ...options, cliOnly: true });
  const agent = readFolderAgents(dir)![0];

  wireClaudeLaunch(dir, agent, options.bridge);

  const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.warren.env.WARREN_AGENT, "claude");
  assert.equal(mcp.mcpServers.warren.env.WARREN_SESSION_NAME, undefined);
  assert.doesNotMatch(JSON.stringify(mcp), /wr_/);
  assert.equal(readFolderAgents(dir)![0].cliOnly, undefined);

  wireClaudeLaunch(dir, readFolderAgents(dir)![0], options.bridge);
  const replaced = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
  assert.deepEqual(replaced, mcp);
  assert.equal(claudeLaunchEnv("frontend", { KEEP: "yes", WARREN_SESSION_NAME: "old" }).KEEP, "yes");
  assert.equal(claudeLaunchEnv("frontend", { KEEP: "yes", WARREN_SESSION_NAME: "old" }).WARREN_SESSION_NAME, "frontend");
});

test("Codex launch injects token-free MCP wiring and an exact SessionStart hook", () => {
  const args = codexLaunchArgs(
    "/repo/.warren.json",
    { command: "/usr/bin/node", args: ["/opt/warren/cli.js", "bridge"] },
    "codex-api",
    "thread-123",
    "review",
  );
  const rendered = args.join("\n");

  assert.match(rendered, /mcp_servers\.warren/);
  assert.match(rendered, /codex-hook/);
  assert.match(rendered, /codex-api/);
  assert.match(rendered, /WARREN_SESSION_NAME = "review"/);
  assert.deepEqual(args.slice(-2), ["resume", "thread-123"]);
  assert.doesNotMatch(rendered, /wr_/);
});

test("Codex SessionStart hook binds the announced thread without model-visible output", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-command-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const original = globalThis.fetch;
  t.after(() => (globalThis.fetch = original));
  globalThis.fetch = async () => new Response(JSON.stringify({ handle: "codex-owner", kind: "agent", adapter: "exec" }), { status: 200 });
  await add(dir, "codex", { ...options, cliOnly: true });

  bindCodexHook(dir, "codex", JSON.stringify({ hook_event_name: "SessionStart", session_id: "thread-hook", cwd: dir }));

  assert.equal(readFolderAgents(dir)?.[0].session, "thread-hook");
});
