import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { readFolder, readFolderAgents } from "../src/cli/config.js";
import { prepareUnwireFolder, unwireFolder, wireFolder, writeFolder, type Tool } from "../src/cli/writers.js";

const secret = "wr_example_secret"; // gitleaks:allow
const bridge = { command: "npx", args: ["-y", "warren-cli@0.4.0", "bridge"] };

function folder() {
  const dir = mkdtempSync(join(tmpdir(), "warren-cli-test-"));
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

function wire(dir: string, tool: Tool) {
  wireFolder(dir, { tool, hub: "https://warren.example.com", token: `${secret}_${tool}`, handle: `${tool}-agent`, bridge });
}

test("Claude wiring preserves other MCP servers and keeps the token out of shared config", () => {
  const { dir, done } = folder();
  try {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "docs" } } }));
    wire(dir, "claude");
    const text = readFileSync(join(dir, ".mcp.json"), "utf8");
    assert.doesNotMatch(text, new RegExp(secret));
    assert.deepEqual(Object.keys(JSON.parse(text).mcpServers).sort(), ["docs", "warren"]);
    assert.equal(readFolder(dir)?.token, `${secret}_claude`);
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

test("Claude and Codex share one credential file while their wiring selects the right identity", () => {
  const { dir, done } = folder();
  try {
    wire(dir, "codex");
    wire(dir, "claude");
    assert.deepEqual(readFolderAgents(dir)?.map((agent) => agent.tool), ["claude", "codex"]);
    assert.throws(() => readFolder(dir), /multiple Warren agents/);
    assert.equal(readFolder(dir, undefined, "codex")?.handle, "codex-agent");
    assert.equal(readFolder(dir, undefined, "claude")?.handle, "claude-agent");
    assert.match(readFileSync(join(dir, ".codex/config.toml"), "utf8"), /"WARREN_AGENT" = "codex"/);
    assert.equal(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers.warren.env.WARREN_AGENT, "claude");
    assert.doesNotMatch(readFileSync(join(dir, ".mcp.json"), "utf8"), new RegExp(secret));
    assert.doesNotMatch(readFileSync(join(dir, ".codex/config.toml"), "utf8"), new RegExp(secret));

    unwireFolder(dir, readFolder(dir, undefined, "claude")!);
    assert.equal(readFolder(dir)?.tool, "codex");
    assert.equal(Object.keys(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")).mcpServers).length, 0);
    assert.match(readFileSync(join(dir, ".codex/config.toml"), "utf8"), /mcp_servers\.warren/);

    unwireFolder(dir, readFolder(dir)!);
    assert.equal(existsSync(join(dir, ".warren.json")), false);
  } finally {
    done();
  }
});

test("adding Claude migrates a legacy Codex config without exposing either token", () => {
  const { dir, done } = folder();
  try {
    mkdirSync(join(dir, ".codex"));
    writeFileSync(
      join(dir, ".warren.json"),
      JSON.stringify({ tool: "codex", hub: "https://warren.example.com", token: secret, handle: "codex-agent" }),
      { mode: 0o600 },
    );
    writeFileSync(
      join(dir, ".codex/config.toml"),
      [
        "# >>> warren (managed by warren-cli; `warren leave` removes it)",
        "[mcp_servers.warren]",
        'command = "npx"',
        'args = ["-y","warren-cli@0.5.0","bridge"]',
        'env = { "WARREN_CONFIG" = ".warren.json" }',
        "# <<< warren",
        "",
      ].join("\n"),
    );
    wire(dir, "claude");
    const codex = readFileSync(join(dir, ".codex/config.toml"), "utf8");
    assert.match(codex, /"WARREN_AGENT" = "codex"/);
    assert.doesNotMatch(codex, new RegExp(secret));
    assert.deepEqual(readFolderAgents(dir)?.map((agent) => agent.tool), ["claude", "codex"]);
  } finally {
    done();
  }
});

test("adding Codex migrates legacy Claude MCP wiring", () => {
  const { dir, done } = folder();
  try {
    const managedMcp = { command: "npx", args: ["-y", "warren-cli@0.5.0", "bridge"], env: { WARREN_CONFIG: ".warren.json" } };
    writeFileSync(
      join(dir, ".warren.json"),
      JSON.stringify({ tool: "claude", hub: "https://warren.example.com", token: "wr_legacy_claude", handle: "claude-old", managedMcp }), // gitleaks:allow
      { mode: 0o600 },
    );
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: { docs: { command: "docs" }, warren: managedMcp } }));
    wire(dir, "codex");
    const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    assert.equal(mcp.mcpServers.warren.env.WARREN_AGENT, "claude");
    assert.equal(mcp.mcpServers.docs.command, "docs");
    assert.doesNotMatch(readFileSync(join(dir, ".mcp.json"), "utf8"), /wr_legacy_claude/);
  } finally {
    done();
  }
});

test("adding Claude migrates legacy Cursor wiring without changing its permission ownership", () => {
  const { dir, done } = folder();
  try {
    const managedMcp = { command: "npx", args: ["-y", "warren-cli@0.5.0", "bridge"], env: { WARREN_CONFIG: ".warren.json" } };
    mkdirSync(join(dir, ".cursor"));
    writeFileSync(
      join(dir, ".warren.json"),
      JSON.stringify({
        tool: "cursor",
        hub: "https://warren.example.com",
        token: "wr_legacy_cursor", // gitleaks:allow
        handle: "cursor-old",
        managedMcp,
        cursorPermissionAdded: true,
      }),
      { mode: 0o600 },
    );
    writeFileSync(join(dir, ".cursor/mcp.json"), JSON.stringify({ mcpServers: { warren: managedMcp } }));
    writeFileSync(join(dir, ".cursor/cli.json"), JSON.stringify({ permissions: { allow: ["Mcp(warren:*)"], deny: [] } }));
    wire(dir, "claude");
    const mcp = JSON.parse(readFileSync(join(dir, ".cursor/mcp.json"), "utf8"));
    assert.equal(mcp.mcpServers.warren.env.WARREN_AGENT, "cursor");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".cursor/cli.json"), "utf8")).permissions.allow, ["Mcp(warren:*)"]);
    assert.equal(readFolder(dir, undefined, "cursor")?.cursorPermissionAdded, true);
  } finally {
    done();
  }
});

test("one Warren identity cannot be wired as two different clients", () => {
  const { dir, done } = folder();
  try {
    wire(dir, "codex");
    const before = readFileSync(join(dir, ".warren.json"), "utf8");
    assert.throws(
      () => wireFolder(dir, { tool: "cursor", hub: "https://warren.example.com", token: `${secret}_codex`, handle: "codex-agent", bridge }),
      /already configured/,
    );
    assert.equal(readFileSync(join(dir, ".warren.json"), "utf8"), before);
    assert.equal(existsSync(join(dir, ".cursor/mcp.json")), false);
  } finally {
    done();
  }
});

test("a pending leave serializes every other config mutation", () => {
  const { dir, done } = folder();
  try {
    wire(dir, "codex");
    wire(dir, "claude");
    const pending = prepareUnwireFolder(dir, readFolder(dir, undefined, "codex")!);
    assert.equal(existsSync(join(dir, ".warren.json.lock")), true);
    assert.throws(
      () => wireFolder(dir, { tool: "cursor", hub: "https://warren.example.com", token: "wr_cursor_secret", handle: "cursor-agent", bridge }), // gitleaks:allow
      /another Warren command/,
    );
    assert.deepEqual(readFolderAgents(dir)?.map((agent) => agent.tool), ["claude", "codex"]);
    pending.cancel();
    assert.equal(existsSync(join(dir, ".warren.json.lock")), false);
    wireFolder(dir, { tool: "cursor", hub: "https://warren.example.com", token: "wr_cursor_secret", handle: "cursor-agent", bridge }); // gitleaks:allow
    assert.deepEqual(readFolderAgents(dir)?.map((agent) => agent.tool), ["claude", "codex", "cursor"]);
    const ignore = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.equal(ignore.match(/^\/\.warren\.json$/gm)?.length, 1);
    assert.equal(ignore.match(/^\/\.warren\.json\.lock$/gm)?.length, 1);
  } finally {
    done();
  }
});

test("an incomplete stale lock fails with manual recovery guidance", () => {
  const { dir, done } = folder();
  try {
    writeFileSync(join(dir, ".warren.json.lock"), "");
    assert.throws(() => wire(dir, "codex"), /incomplete or stale.*remove that lock file/);
    unlinkSync(join(dir, ".warren.json.lock"));
    wire(dir, "codex");
    assert.equal(readFolder(dir)?.handle, "codex-agent");
    assert.equal(existsSync(join(dir, ".warren.json.lock")), false);
  } finally {
    done();
  }
});

test("a stale session update cannot overwrite an identity moved to another hub", () => {
  const { dir, done } = folder();
  try {
    wire(dir, "codex");
    const stale = readFolder(dir)!;
    const file = join(dir, ".warren.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.agents.codex.hub = "https://other.example.com";
    writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    assert.throws(() => writeFolder(dir, { ...stale, session: "old-session" }), /agent changed/);
    assert.equal(readFolder(dir)?.hub, "https://other.example.com");
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
    assert.equal(readFolder(dir)?.token, `${secret}_claude`);
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
    const ignore = readFileSync(join(dir, ".gitignore"), "utf8");
    assert.match(ignore, /^\/\.warren\.json$/m);
    assert.match(ignore, /^\/\.warren\.json\.lock$/m);
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
