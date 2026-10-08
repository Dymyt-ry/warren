import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { add } from "../src/cli/commands.js";
import { readFolderAgents } from "../src/cli/config.js";

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
