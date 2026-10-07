import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { readFolder } from "../src/cli/config.js";
import { prepareUnwireFolder, unwireFolder, wireFolder, type Tool } from "../src/cli/writers.js";

const secret = "wr_example_secret"; // gitleaks:allow
const bridge = { command: "npx", args: ["-y", "warren-cli@0.4.0", "bridge"] };

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function wire(dir: string, tool: Tool) {
  wireFolder(dir, { tool, hub: "https://warren.example.com", token: secret, handle: `${tool}-agent`, bridge });
}

test("Claude wiring preserves other MCP servers and keeps the token out of shared config", () => {
  const { dir, done } = folder();
  try {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "docs" } } }));
    wire(dir, "claude");
    const text = readFileSync(join(dir, ".mcp.json"), "utf8");
    assert.doesNotMatch(text, new RegExp(secret));
    assert.deepEqual(Object.keys(JSON.parse(text).mcpServers).sort(), ["docs", "warren"]);
    assert.equal(readFolder(dir)?.token, secret);
    assert.equal(statSync(join(dir, ".warren.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, ".mcp.json")).mode & 0o022, 0);
    assert.equal(statSync(join(dir, ".gitignore")).mode & 0o022, 0);
    assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /^\/\.warren\.json$/m);
    unwireFolder(dir, readFolder(dir)!);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers), ["docs"]);
  } finally {
    done();
  }
});

test("new shared config files are not group- or world-writable", () => {
  const { dir, done } = folder();
  try {
    wire(dir, "claude");
    assert.equal(statSync(join(dir, ".mcp.json")).mode & 0o022, 0);
    assert.equal(statSync(join(dir, ".gitignore")).mode & 0o022, 0);
  } finally {
    done();
  }
});

test("Codex wiring writes a managed stdio block without the token", () => {
  const { dir, done } = folder();
  try {
    mkdirSync(join(dir, ".codex"));
    writeFileSync(join(dir, ".codex/config.toml"), "model = \"gpt-6\"\n");
    wire(dir, "codex");
    const text = readFileSync(join(dir, ".codex/config.toml"), "utf8");
    assert.match(text, /\[mcp_servers\.warren\]/);
    assert.match(text, /WARREN_CONFIG/);
    assert.doesNotMatch(text, new RegExp(secret));
    unwireFolder(dir, readFolder(dir)!);
    assert.equal(readFileSync(join(dir, ".codex/config.toml"), "utf8"), "model = \"gpt-6\"\n");
  } finally {
    done();
  }
});

test("Cursor wiring adds and removes only Warren entries", () => {
  const { dir, done } = folder();
  try {
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(join(dir, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { docs: { url: "https://example.com" } } }));
    writeFileSync(join(dir, ".cursor/cli.json"), JSON.stringify({ permissions: { allow: ["Read(*)"], deny: ["Shell(*)"] } }));
    wire(dir, "cursor");
    const mcp = readFileSync(join(dir, ".cursor/mcp.json"), "utf8");
    assert.doesNotMatch(mcp, new RegExp(secret));
    assert.deepEqual(Object.keys(JSON.parse(mcp).mcpServers).sort(), ["docs", "warren"]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".cursor/cli.json"), "utf8")).permissions.allow, ["Read(*)", "Mcp(warren:*)"]);
    unwireFolder(dir, readFolder(dir)!);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(dir, ".cursor/mcp.json"), "utf8")).mcpServers), ["docs"]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".cursor/cli.json"), "utf8")).permissions.allow, ["Read(*)"]);
  } finally {
    done();
  }
});

test("a broken managed Codex block is never truncated", () => {
  const { dir, done } = folder();
  try {
    mkdirSync(join(dir, ".codex"));
    writeFileSync(join(dir, ".codex/config.toml"), "# >>> warren (managed by warren-cli; `warren leave` removes it)\nimportant = true\n");
    assert.throws(() => wire(dir, "codex"), /no end marker/);
    assert.match(readFileSync(join(dir, ".codex/config.toml"), "utf8"), /important = true/);
  } finally {
    done();
  }
});

test("an unmanaged Warren MCP entry is never overwritten", () => {
  const { dir, done } = folder();
  try {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { warren: { command: "mine" } } }));
    assert.throws(() => wire(dir, "claude"), /not managed by warren-cli/);
    assert.equal(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers.warren.command, "mine");
    assert.equal(existsSync(join(dir, ".warren.json")), false);
  } finally {
    done();
  }
});

test("Cursor preflight prevents partial writes when a later config is malformed", () => {
  const { dir, done } = folder();
  try {
    mkdirSync(join(dir, ".cursor"));
    const original = JSON.stringify({ mcpServers: { docs: { command: "docs" } } });
    writeFileSync(join(dir, ".cursor/mcp.json"), original);
    writeFileSync(join(dir, ".cursor/cli.json"), "{ broken");
    assert.throws(() => wire(dir, "cursor"), /not plain JSON/);
    assert.equal(readFileSync(join(dir, ".cursor/mcp.json"), "utf8"), original);
    assert.equal(existsSync(join(dir, ".warren.json")), false);
  } finally {
    done();
  }
});

test("Cursor preserves a permission that existed before Warren was added", () => {
  const { dir, done } = folder();
  try {
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(join(dir, ".cursor/cli.json"), JSON.stringify({ permissions: { allow: ["Mcp(warren:*)"] } }));
    wire(dir, "cursor");
    const agent = readFolder(dir)!;
    assert.equal(agent.cursorPermissionAdded, false);
    unwireFolder(dir, agent);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".cursor/cli.json"), "utf8")).permissions.allow, ["Mcp(warren:*)"]);
  } finally {
    done();
  }
});

test("leave preflight refuses to delete a Warren MCP entry changed by the user", () => {
  const { dir, done } = folder();
  try {
    wire(dir, "claude");
    const agent = readFolder(dir)!;
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { warren: { command: "custom" } } }));
    assert.throws(() => prepareUnwireFolder(dir, agent), /changed after/);
    assert.equal(readFolder(dir)?.token, secret);
  } finally {
    done();
  }
});

test("wiring refuses to write through a project config directory symlink", () => {
  const { dir, done } = folder();
  const outside = mkdtempSync(join(tmpdir(), "warren-cli-outside-"));
  try {
    symlinkSync(outside, join(dir, ".codex"), "dir");
    assert.throws(() => wire(dir, "codex"), /symbolic link/);
    assert.equal(existsSync(join(outside, "config.toml")), false);
    assert.equal(existsSync(join(dir, ".warren.json")), false);
  } finally {
    done();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("credentials are never read through a symbolic link", () => {
  const { dir, done } = folder();
  const outside = mkdtempSync(join(tmpdir(), "warren-cli-outside-"));
  try {
    const credential = join(outside, "agent.json");
    writeFileSync(credential, JSON.stringify({ tool: "codex", hub: "https://warren.example.com", token: secret, handle: "elsewhere" }));
    symlinkSync(credential, join(dir, ".warren.json"));
    assert.throws(() => readFolder(dir), /symbolic link/);
  } finally {
    done();
    rmSync(outside, { recursive: true, force: true });
  }
});

test("the final gitignore rule protects the credential from a prior negation", () => {
  const { dir, done } = folder();
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, ".gitignore"), ".warren.json\n!.warren.json\n");
    wire(dir, "claude");
    execFileSync("git", ["check-ignore", "-q", "--no-index", ".warren.json"], { cwd: dir });
    assert.match(readFileSync(join(dir, ".gitignore"), "utf8"), /\/\.warren\.json\n$/);
  } finally {
    done();
  }
});

test("wiring refuses to recreate a credential file that Git already tracks", () => {
  const { dir, done } = folder();
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const credential = join(dir, ".warren.json");
    writeFileSync(credential, "{}\n");
    execFileSync("git", ["add", ".warren.json"], { cwd: dir });
    unlinkSync(credential);
    assert.throws(() => wire(dir, "claude"), /tracked by Git/);
    assert.equal(existsSync(credential), false);
  } finally {
    done();
  }
});

test("tracked credential detection is case-insensitive for macOS and Windows filesystems", () => {
  const { dir, done } = folder();
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const credential = join(dir, ".Warren.json");
    writeFileSync(credential, "{}\n");
    execFileSync("git", ["add", ".Warren.json"], { cwd: dir });
    unlinkSync(credential);
    assert.throws(() => wire(dir, "claude"), /tracked by Git/);
    assert.equal(existsSync(join(dir, ".warren.json")), false);
  } finally {
    done();
  }
});

test("wiring fails closed when Git cannot verify the index", () => {
  const { dir, done } = folder();
  try {
    writeFileSync(join(dir, ".git"), "gitdir: /definitely/missing/warren-index\n");
    assert.throws(() => wire(dir, "claude"), /cannot safely verify/);
    assert.equal(existsSync(join(dir, ".warren.json")), false);
  } finally {
    done();
  }
});

test("tracked-file verification ignores a project-controlled git executable", { skip: process.platform === "win32" }, () => {
  const { dir, done } = folder();
  const originalPath = process.env.PATH;
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const bin = join(dir, "node_modules/.bin");
    const marker = join(dir, "fake-git-ran");
    mkdirSync(bin, { recursive: true });
    const fake = join(bin, "git");
    writeFileSync(fake, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 1\n`);
    chmodSync(fake, 0o755);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    wire(dir, "claude");
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(join(dir, ".warren.json")), true);
  } finally {
    process.env.PATH = originalPath;
    done();
  }
});
