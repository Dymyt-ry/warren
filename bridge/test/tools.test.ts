import assert from "node:assert/strict";
import test from "node:test";
import { objectInput, positiveLimit } from "../src/cli/tools.js";

test("generic MCP calls accept only a JSON object", () => {
  assert.deepEqual(objectInput('{"room":"api","all":true}'), { room: "api", all: true });
  assert.deepEqual(objectInput(undefined), {});
  assert.throws(() => objectInput("[1,2]"), /JSON object/);
  assert.throws(() => objectInput("{"), /valid JSON/);
});

test("read limits stay inside the MCP tool schema", () => {
  assert.equal(positiveLimit(undefined), undefined);
  assert.equal(positiveLimit("1"), 1);
  assert.equal(positiveLimit("100"), 100);
  assert.throws(() => positiveLimit("0"), /1 to 100/);
  assert.throws(() => positiveLimit("101"), /1 to 100/);
  assert.throws(() => positiveLimit("1.5"), /1 to 100/);
});
