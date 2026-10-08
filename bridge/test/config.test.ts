import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bridgeCommand, hubOrigin, readFolder, readFolderAgents } from "../src/cli/config.js";

test("hubOrigin accepts only a clean HTTP(S) origin", () => {
  assert.equal(hubOrigin("https://warren.example.com/"), "https://warren.example.com");
  assert.equal(hubOrigin("http://localhost:8790/"), "http://localhost:8790");
  assert.equal(hubOrigin("http://127.0.0.1:8790/"), "http://127.0.0.1:8790");
  assert.throws(() => hubOrigin("http://warren.example.com"), /must use https/);
  assert.throws(() => hubOrigin("file:///tmp/hub"), /http/);
  assert.throws(() => hubOrigin("https://warren.example.com/team"), /origin/);
  assert.throws(() => hubOrigin("https://user:secret@warren.example.com"), /credentials/);
});

test("bridgeCommand survives npx cache cleanup and supports source checkouts", () => {
  assert.deepEqual(bridgeCommand("/tmp/_npx/123/node_modules/warren-cli/dist/cli.js", "/node", "0.4.0"), {
    command: "npx",
    args: ["-y", "warren-cli@0.4.0", "bridge"],
  });
  assert.deepEqual(bridgeCommand("C:\\Users\\dev\\AppData\\Local\\npm-cache\\_npx\\123\\node_modules\\warren-cli\\dist\\cli.js", "node.exe", "0.4.0"), {
    command: "npx",
    args: ["-y", "warren-cli@0.4.0", "bridge"],
  });
  assert.deepEqual(bridgeCommand("/repo/bridge/src/cli.ts", "/node", "0.4.0"), {
    command: "npx",
    args: ["tsx", "/repo/bridge/src/cli.ts", "bridge"],
  });
});

test("the original single-agent config remains readable", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-config-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, ".warren.json"),
    JSON.stringify({ tool: "codex", hub: "https://warren.example.com", token: "wr_legacy", handle: "codex-old" }), // gitleaks:allow
  );
  assert.equal(readFolderAgents(dir)?.length, 1);
  assert.equal(readFolder(dir)?.handle, "codex-old");
});

test("multi-agent configs require an explicit shell identity", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-config-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, ".warren.json"),
    JSON.stringify({
      version: 2,
      agents: {
        claude: { tool: "claude", hub: "https://warren.example.com", token: "wr_claude", handle: "claude-one" }, // gitleaks:allow
        codex: { tool: "codex", hub: "https://warren.example.com", token: "wr_codex", handle: "codex-one" }, // gitleaks:allow
      },
    }),
  );
  assert.throws(() => readFolder(dir), /multiple Warren agents/);
  assert.equal(readFolder(dir, undefined, "codex")?.handle, "codex-one");
  assert.equal(readFolder(dir, undefined, "@claude-one")?.tool, "claude");
  assert.throws(() => readFolder(dir, undefined, "cursor"), /no cursor agent/);
});

test("client selectors take precedence over a conflicting agent handle", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-config-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, ".warren.json"),
    JSON.stringify({
      version: 2,
      agents: {
        claude: { tool: "claude", hub: "https://warren.example.com", token: "wr_claude", handle: "codex" }, // gitleaks:allow
        codex: { tool: "codex", hub: "https://warren.example.com", token: "wr_codex", handle: "actual-codex" }, // gitleaks:allow
      },
    }),
  );
  assert.equal(readFolder(dir, undefined, "codex")?.handle, "actual-codex");
  assert.equal(readFolder(dir, undefined, "@codex")?.tool, "claude");
});

test("ambient WARREN_AGENT never silently selects a shell identity", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-config-test-"));
  const previous = process.env.WARREN_AGENT;
  t.after(() => {
    if (previous === undefined) delete process.env.WARREN_AGENT;
    else process.env.WARREN_AGENT = previous;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(
    join(dir, ".warren.json"),
    JSON.stringify({
      version: 2,
      agents: {
        claude: { tool: "claude", hub: "https://warren.example.com", token: "wr_claude", handle: "claude-one" }, // gitleaks:allow
        codex: { tool: "codex", hub: "https://warren.example.com", token: "wr_codex", handle: "codex-one" }, // gitleaks:allow
      },
    }),
  );
  process.env.WARREN_AGENT = "codex";
  assert.throws(() => readFolder(dir), /multiple Warren agents/);
  assert.equal(readFolder(dir, undefined, "codex")?.handle, "codex-one");
});
