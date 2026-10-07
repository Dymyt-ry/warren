import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { add } from "../src/cli/commands.js";

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
