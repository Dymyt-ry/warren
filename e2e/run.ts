// End-to-end: real hub, real bridges, fake agents.
//   1. codex-ben (firmab, HTTP MCP) sees api-contract only
//   2. a contract_change without a mention is NOT pushed; with @room it is pushed into claude-anna's session
//   3. claude-anna @mentions codex-ben -> its bridge wakes "codex exec resume" (stubbed); an untagged note does not
//   4. anna (human, dashboard) tags @claude-anna -> pushed; the agent answers @anna -> anna's stream flags it forYou
//   5. scope: codex-ben can't post into checkout-ui, can't @mention someone outside the room
//   6. inbox for pull clients returns only what's addressed to them
//   7. A2A message/send posts into the room of the caller's token
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8799;
const HUB = `http://localhost:${PORT}`;
const CLAUDE = "wr_demo_acme_claude";
const CODEX = "wr_demo_firmab_codex";
const CURSOR = "wr_demo_acme_cursor";
const ANNA = "wr_demo_anna";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let failed = false;
const check = (ok: boolean, name: string) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed = true;
};

async function waitFor<T>(fn: () => T | undefined, ms = 5000): Promise<T | undefined> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    const v = fn();
    if (v) return v;
  }
}

const api = (path: string, token?: string, body?: unknown) =>
  fetch(`${HUB}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });

const toolJson = (r: Awaited<ReturnType<Client["callTool"]>>) => JSON.parse((r.content as { text: string }[])[0].text);

// Own process group, so cleanup kills npx and the node child under it.
const hub = spawn("npx", ["tsx", "hub/src/server.ts"], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: ["ignore", "ignore", "inherit"],
  detached: true,
});
const cleanup: (() => unknown)[] = [() => { try { process.kill(-hub.pid!); } catch {} }];

try {
  if (await fetch(`${HUB}/api/rooms`).then(() => true, () => false))
    throw new Error(`port ${PORT} is taken: a hub from an earlier run is still up`);
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${HUB}/api/rooms`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }

  // 1. scoped MCP over HTTP
  const codex = new Client({ name: "fake-codex", version: "0" });
  await codex.connect(
    new StreamableHTTPClientTransport(new URL(`${HUB}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${CODEX}` } },
    }),
  );
  cleanup.push(() => codex.close());
  const visible = toolJson(await codex.callTool({ name: "list_rooms", arguments: {} })).map((r: { id: string }) => r.id);
  check(JSON.stringify(visible) === '["api-contract"]', `codex-ben sees only api-contract (got ${visible})`);

  // 2. channel push into claude-anna, only when mentioned
  const claude = new Client({ name: "fake-claude-code", version: "0" });
  const pushed: { content: string; meta: Record<string, string> }[] = [];
  claude.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") pushed.push(n.params as (typeof pushed)[number]);
  };
  await claude.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", "bridge/src/index.ts"],
      env: { ...process.env, WARREN_HUB: HUB, WARREN_TOKEN: CLAUDE, WARREN_ADAPTER: "channel" } as Record<string, string>,
    }),
  );
  cleanup.push(() => claude.close());
  const bridgeTools = (await claude.listTools()).tools.map((t) => t.name);
  check(["post", "read_room", "members", "inbox"].every((t) => bridgeTools.includes(t)), `bridge proxies hub tools (${bridgeTools.join(", ")})`);
  await sleep(800); // let the bridge subscribe

  await codex.callTool({
    name: "post",
    arguments: { room: "api-contract", kind: "note", text: "Refactoring the cart handler, no API change yet" },
  });
  await codex.callTool({
    name: "post",
    arguments: { room: "api-contract", kind: "contract_change", text: "@room POST /cart is now POST /basket, body unchanged" },
  });
  const got = await waitFor(() => pushed.find((p) => p.meta.kind === "contract_change"));
  check(!!got && got.meta.room === "api-contract" && got.meta.from === "codex-ben" && got.meta.to === "room", "@room contract_change pushed into claude-anna session");
  check(!pushed.some((p) => p.content.includes("Refactoring")), "untagged note was not pushed");

  // 3. exec wake-up for codex-ben (codex binary stubbed), only when mentioned
  const dir = mkdtempSync(join(tmpdir(), "warren-e2e-"));
  const stub = join(dir, "codex");
  const out = join(dir, "args.txt");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${out}"\n`);
  chmodSync(stub, 0o755);
  const codexBridge = new Client({ name: "codex-bridge-host", version: "0" });
  await codexBridge.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", "bridge/src/index.ts"],
      env: {
        ...process.env,
        WARREN_HUB: HUB,
        WARREN_TOKEN: CODEX,
        WARREN_ADAPTER: "exec",
        WARREN_EXEC_CMD: stub,
        WARREN_CODEX_SESSION: "demo-session",
      } as Record<string, string>,
    }),
  );
  cleanup.push(() => codexBridge.close());
  await sleep(800);
  await claude.callTool({ name: "post", arguments: { room: "api-contract", kind: "note", text: "Updating the client now" } });
  await claude.callTool({
    name: "post",
    arguments: { room: "api-contract", kind: "question", text: "@codex-ben does /basket still return 201?" },
  });
  const args = await waitFor(() => (existsSync(out) ? readFileSync(out, "utf8") : undefined));
  await sleep(300);
  const wakes = existsSync(out) ? readFileSync(out, "utf8").split("exec\nresume\n").length - 1 : 0;
  check(!!args && args.startsWith("exec\nresume\ndemo-session\n") && args.includes("/basket still return 201"), "@codex-ben question woke codex via exec resume");
  check(wakes === 1, `untagged note did not wake codex (wakes: ${wakes})`);

  // 4. human <-> agent: anna tags claude-anna from the dashboard, the agent answers @anna
  const annaEvents: { forYou: boolean; from: string; text: string }[] = [];
  const annaStream = new AbortController();
  cleanup.push(() => annaStream.abort());
  void fetch(`${HUB}/api/events?token=${ANNA}`, { signal: annaStream.signal })
    .then(async (res) => {
    let buf = "";
    for await (const chunk of res.body!) {
      buf += new TextDecoder().decode(chunk as Uint8Array);
      let end;
      while ((end = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const data = frame.match(/^data: (.*)$/m)?.[1];
        if (frame.startsWith("event: message") && data) annaEvents.push(JSON.parse(data));
      }
    }
    })
    .catch(() => {}); // aborted at cleanup
  const login = await api("/api/login", undefined, { handle: "anna" }).then((r) => r.json());
  check(login.token === ANNA && login.kind === "human", "anna logs into the dashboard by handle");
  await sleep(300);
  const annaPost = await api("/api/rooms/checkout-ui/messages", ANNA, { kind: "question", text: "@claude-anna can you switch checkout to /basket?" });
  const annaMsg = await annaPost.json();
  check(annaPost.status === 201 && JSON.stringify(annaMsg.mentions) === '["claude-anna"]', "anna's post from the dashboard parses @claude-anna");
  const toClaude = await waitFor(() => pushed.find((p) => p.meta.from === "anna"));
  check(!!toClaude && toClaude.meta.to === "you" && toClaude.meta.room === "checkout-ui", "anna's @mention pushed into claude-anna session");
  await claude.callTool({ name: "post", arguments: { room: "checkout-ui", kind: "done", text: "@anna done, checkout calls /basket" } });
  const reply = await waitFor(() => annaEvents.find((e) => e.from === "claude-anna" && e.forYou));
  check(!!reply, "claude-anna's @anna reply reaches anna's stream flagged forYou");

  // 5. scope enforcement
  const denied = await api("/api/rooms/checkout-ui/messages", CODEX, { text: "hi" });
  check(denied.status === 403, "codex-ben cannot post into checkout-ui");
  const outside = toolJson(await codex.callTool({ name: "post", arguments: { room: "api-contract", text: "@cursor-marek hello" } }));
  check(outside.mentions.length === 0, "codex-ben cannot @mention cursor-marek, who is outside api-contract");
  const members = await api("/api/members?room=api-contract").then((r) => r.json());
  check(!members.some((m: { token?: string }) => m.token), "member lists never expose tokens");

  const seen = await api("/api/members", CODEX).then((r) => r.json());
  const handles = seen.map((m: { handle: string }) => m.handle);
  check(handles.includes("claude-anna") && !handles.includes("cursor-marek"), `codex-ben's member list is scoped (${handles.join(", ")})`);
  const presence = Object.fromEntries(seen.map((m: { handle: string; online: boolean }) => [m.handle, m.online]));
  check(presence["claude-anna"] === true && presence["codex-ben"] === true && presence["marek"] === false, "presence: bridges online, marek offline");
  const anon = await api("/api/rooms", undefined, { name: "x", parentId: "shop" });
  const outsideRoom = await api("/api/rooms", CODEX, { name: "x", parentId: "checkout-ui" });
  const subroom = await api("/api/rooms", CODEX, { name: "Basket migration", parentId: "api-contract" });
  check(anon.status === 401 && outsideRoom.status === 403 && subroom.status === 201, "subrooms need a token and a visible parent");

  // 6. inbox for pull clients (Cursor)
  await api("/api/rooms/mobile/messages", ANNA, { text: "@cursor-marek mobile layout needs the /basket change too" });
  await api("/api/rooms/mobile/messages", ANNA, { text: "general note, nobody tagged" });
  const inbox = await api("/api/inbox", CURSOR).then((r) => r.json());
  check(inbox.length === 1 && inbox[0].text.includes("mobile layout"), `cursor-marek inbox has only what's addressed to it (${inbox.length})`);

  // 7. A2A message/send
  const a2a = await api("/a2a", CODEX, {
    jsonrpc: "2.0",
    id: 1,
    method: "message/send",
    params: { message: { role: "user", messageId: "m1", parts: [{ kind: "text", text: "@claude-anna 201 stays, body is { basketId }" }] } },
  }).then((r) => r.json());
  check(a2a.result?.metadata?.room === "api-contract", "A2A message/send posts into the token's room");
  check(!!(await waitFor(() => pushed.find((p) => p.content.includes("basketId")))), "A2A message with @claude-anna pushed into its session");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {});
}
process.exit(failed ? 1 : 0);
