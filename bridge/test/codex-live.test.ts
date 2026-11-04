import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CodexAppServer, decodeFrames } from "../src/codex-app.js";
import { codexDeveloperInstructions, codexThreadConfig, heldNoticePrompt } from "../src/codex-live.js";
import { warrenPrompt } from "../src/prompt.js";
import { senderAddress } from "../src/sse.js";
import { readFolder } from "../src/cli/config.js";
import { wireFolder } from "../src/cli/writers.js";

process.env.WARREN_LOCK_WAIT_MS = "200";

const session = { id: "wsess_1", handle: "codex-ana", name: "review", expiresAt: "" };
const message = {
  id: "m1",
  roomId: "api",
  from: "claude-ben",
  kind: "question",
  text: "@codex-ana/review is /basket still 201?",
  mentions: ["codex-ana"],
  mentionsRoom: false,
  at: "2026-01-01T00:00:00.000Z",
  metadata: { from: { agent: "claude-ben", sessionName: "api" } },
};

test("replies go to the exact sending session", () => {
  assert.equal(senderAddress(message), "claude-ben/api");
  assert.equal(senderAddress({ from: "anna" }), "anna");
  const prompt = warrenPrompt(message);
  assert.match(prompt, /^\[warren\] question from @claude-ben\/api in room "api"/);
  assert.match(prompt, /mentioning @claude-ben\/api/);
});

test("the Codex thread gets token-free Warren tools that join the launcher's slot", () => {
  const dir = mkdtempSync(join(tmpdir(), "warren-codex-live-"));
  try {
    wireFolder(dir, { tool: "codex", hub: "https://warren.example.com", token: "wr_codex_secret", handle: "codex-ana", bridge: { command: "node", args: ["cli.js", "bridge"] } }, { cliOnly: true }); // gitleaks:allow
    const agent = readFolder(dir)!;
    const config = codexThreadConfig({ dir, agent, slot: "review", bridge: { command: "/usr/bin/node", args: ["/opt/warren/cli.js", "bridge"] } }, session);
    assert.doesNotMatch(JSON.stringify(config), /wr_/);
    const env = config["mcp_servers.warren.env"];
    assert.equal(env.WARREN_ADAPTER, "none");
    assert.equal(env.WARREN_SESSION_NAME, "review");
    assert.equal(env.WARREN_SESSION_ID, "wsess_1");
    assert.equal(env.WARREN_CONFIG, join(dir, ".warren.json"));
    assert.equal(config["mcp_servers.warren.tools.post.approval_mode"], "approve");
    assert.equal(config["mcp_servers.warren.tools.set_context.approval_mode"], undefined, "changing shared room state still asks the person");
    assert.equal(config["mcp_servers.warren.default_tools_approval_mode"], undefined);
    assert.match(codexDeveloperInstructions(session), /@codex-ana\/review/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("WebSocket frames decode across chunk boundaries, extended lengths and masks", () => {
  const small = Buffer.concat([Buffer.from([0x81, 5]), Buffer.from("hello")]);
  const bigPayload = Buffer.alloc(300, 0x61);
  const big = Buffer.concat([Buffer.from([0x81, 126, 0x01, 0x2c]), bigPayload]);
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.concat([Buffer.from([0x81, 0x80 | 2]), mask, Buffer.from([0x68 ^ 1, 0x69 ^ 2])]);
  const all = Buffer.concat([small, big, masked]);
  const first = decodeFrames(all.subarray(0, 10));
  assert.equal(first.frames.length, 1);
  const rest = decodeFrames(Buffer.concat([first.rest, all.subarray(10)]));
  assert.equal(rest.frames.length, 2);
  assert.equal(rest.frames[0].payload.length, 300);
  assert.equal(rest.frames[1].payload.toString(), "hi");
  assert.equal(rest.rest.length, 0);
});

test("the app-server client speaks JSON-RPC over a WebSocket on a Unix socket", { skip: process.platform === "win32" }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "warren-codex-sock-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "s.sock");
  const seen: string[] = [];
  const server = createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const key = /Sec-WebSocket-Key: (.*)\r\n/.exec(buffer.subarray(0, end).toString())![1];
        const accept = createHash("sha1").update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        buffer = buffer.subarray(end + 4);
        upgraded = true;
      }
      const { frames, rest } = decodeFrames(buffer);
      buffer = rest;
      for (const frame of frames) {
        if (frame.opcode !== 1) continue;
        const request = JSON.parse(frame.payload.toString());
        seen.push(request.method);
        if (request.id === undefined) continue;
        const reply = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: request.method } }));
        const note = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method: "thread/status/changed", params: { threadId: "t", status: { type: "idle" } } }));
        socket.write(Buffer.concat([Buffer.from([0x81, reply.length]), reply, Buffer.from([0x81, note.length]), note]));
      }
    });
  });
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", (socket) => sockets.add(socket));
  await new Promise<void>((r) => server.listen(path, r));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    server.close();
  });
  writeFileSync(join(dir, "unused"), "");
  const client = await CodexAppServer.open(path);
  const notes: string[] = [];
  client.onMessage((m) => notes.push(String(m.method)));
  const result = await client.call<{ ok: string }>("turn/start", { threadId: "t" });
  assert.equal(result.ok, "turn/start");
  assert.deepEqual(seen.slice(0, 3), ["initialize", "initialized", "turn/start"]);
  assert.ok(notes.includes("thread/status/changed"));
  client.close();
});

test("a held message reaches Codex only as a text-free notice", () => {
  const notice = heldNoticePrompt({
    id: "h1",
    roomId: "api",
    from: "codex-eve",
    org: "evil",
    kind: "note",
    flags: ["instruction-override"],
    waitsFor: "ana",
    reviewable: true,
    reviewUrl: "https://warren.example.com/app?review=h1",
  });
  assert.match(notice, /held for human review/);
  assert.match(notice, /@ana decides at https:\/\/warren\.example\.com\/app\?review=h1/);
  assert.match(notice, /do not call any tool/);
});
