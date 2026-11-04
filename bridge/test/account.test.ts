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
