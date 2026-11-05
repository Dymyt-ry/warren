import assert from "node:assert/strict";
import test from "node:test";
import { defaultAgentName, loginHub, parseJoin } from "../src/cli/account.js";

test("a join link carries its hub; a bare code needs --hub", () => {
  assert.deepEqual(parseJoin("https://warren.example.com/j/wj_abc123"), { hub: "https://warren.example.com", code: "wj_abc123" });
  assert.deepEqual(parseJoin("wj_abc123", "https://warren.example.com"), { hub: "https://warren.example.com", code: "wj_abc123" });
  assert.throws(() => parseJoin("http://evil.example.com/j/wj_abc123"), /https/);
  assert.throws(() => parseJoin("https://warren.example.com/app?invite=wi_x"), /not a Warren join link/);
});

test("joined agents are named after the tool and the local user", () => {
  assert.equal(defaultAgentName("claude", { USER: "Jane Tester" }), "claude-jane-tester");
  assert.equal(defaultAgentName("codex", { USER: "" , USERNAME: "" }).startsWith("codex"), true);
});

test("a password only goes to a hub the person named", () => {
  assert.equal(loginHub("https://warren.example.com/", {}), "https://warren.example.com");
  assert.equal(loginHub(undefined, { WARREN_HUB: "https://warren.example.com" }), "https://warren.example.com");
});

test("`warren skill` installs the bundled skill for Claude Code and Codex and keeps managed links", async () => {
  const { mkdtempSync, readFileSync, rmSync, mkdirSync, symlinkSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { installSkill } = await import("../src/cli/skill.js");
  const home = mkdtempSync(join(tmpdir(), "warren-skill-"));
  try {
    const source = join(import.meta.dirname, "..", "skills", "warren", "SKILL.md");
    const first = installSkill(home, source);
    assert.match(first.join("\n"), /Claude Code: installed .*\.claude\/skills\/warren\/SKILL\.md/);
    assert.match(readFileSync(join(home, ".agents", "skills", "warren", "SKILL.md"), "utf8"), /^---\nname: warren\n/);
    assert.match(installSkill(home, source).join("\n"), /up to date/);
    rmSync(join(home, ".claude", "skills", "warren"), { recursive: true });
    mkdirSync(join(home, "mine"));
    symlinkSync(join(home, "mine"), join(home, ".claude", "skills", "warren"));
    assert.match(installSkill(home, source).join("\n"), /link you manage; left as is/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
