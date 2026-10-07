import assert from "node:assert/strict";
import test from "node:test";
import { bridgeCommand, hubOrigin } from "../src/cli/config.js";

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
