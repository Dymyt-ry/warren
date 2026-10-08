import assert from "node:assert/strict";
import test from "node:test";
import { execArgs } from "../src/adapters/exec.js";

test("Codex delivery queues a mention into the bound live session", () => {
  assert.deepEqual(execArgs("codex", "thread-123", "hello"), ["queue", "--thread", "thread-123", "--message", "hello"]);
});

test("Codex delivery keeps the legacy resume fallback when no session is bound", () => {
  assert.deepEqual(execArgs("codex", undefined, "hello"), ["exec", "resume", "--last", "hello"]);
});

test("Cursor delivery still resumes its bound chat", () => {
  assert.deepEqual(execArgs("cursor", "chat-123", "hello"), ["-p", "--trust", "--approve-mcps", "--resume", "chat-123", "hello"]);
});
