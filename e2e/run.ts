// End-to-end: real hub, real bridges, fake agents.
//   1. codex@firmab (HTTP MCP) sees api-contract only
//   2. codex@firmab posts a contract_change -> claude@acme's bridge pushes it as a channel notification
//   3. claude@acme asks back -> codex@firmab's bridge wakes "codex exec resume" (stubbed)
//   4. codex@firmab cannot post into checkout-ui
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 8799;
const HUB = `http://localhost:${PORT}`;
const ACME = "wr_demo_acme_claude";
const FIRMAB = "wr_demo_firmab_codex";
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

const hub = spawn("npx", ["tsx", "hub/src/server.ts"], { env: { ...process.env, PORT: String(PORT) }, stdio: "inherit" });
const cleanup: (() => unknown)[] = [() => hub.kill()];

try {
  for (let i = 0; i < 50; i++) {
    if (await fetch(`${HUB}/api/rooms`).then((r) => r.ok, () => false)) break;
    await sleep(200);
  }

  // 1. scoped MCP over HTTP
  const codex = new Client({ name: "fake-codex", version: "0" });
  await codex.connect(
    new StreamableHTTPClientTransport(new URL(`${HUB}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${FIRMAB}` } },
    }),
  );
  cleanup.push(() => codex.close());
  const listed = await codex.callTool({ name: "list_rooms", arguments: {} });
  const visible = JSON.parse((listed.content as { text: string }[])[0].text).map((r: { id: string }) => r.id);
  check(JSON.stringify(visible) === '["api-contract"]', `codex@firmab sees only api-contract (got ${visible})`);

  // 2. channel push into claude@acme
  const claude = new Client({ name: "fake-claude-code", version: "0" });
  const pushed: { content: string; meta: Record<string, string> }[] = [];
  claude.fallbackNotificationHandler = async (n) => {
    if (n.method === "notifications/claude/channel") pushed.push(n.params as (typeof pushed)[number]);
  };
  await claude.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", "bridge/src/index.ts"],
      env: { ...process.env, WARREN_HUB: HUB, WARREN_TOKEN: ACME, WARREN_ADAPTER: "channel" } as Record<string, string>,
    }),
  );
  cleanup.push(() => claude.close());
  await sleep(800); // let the bridge subscribe

  await codex.callTool({
    name: "post",
    arguments: { room: "api-contract", kind: "contract_change", text: "POST /cart is now POST /basket, body unchanged" },
  });
  const got = await waitFor(() => pushed.find((p) => p.meta.kind === "contract_change"));
  check(!!got && got.meta.room === "api-contract" && got.meta.from === "codex@firmab", "contract_change pushed into claude@acme session");

  // 3. exec wake-up for codex@firmab (codex binary stubbed)
  const dir = mkdtempSync(join(tmpdir(), "warren-e2e-"));
  const stub = join(dir, "codex");
  const out = join(dir, "args.txt");
  writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" > "${out}"\n`);
  chmodSync(stub, 0o755);
  const codexBridge = new Client({ name: "codex-bridge-host", version: "0" });
  await codexBridge.connect(
    new StdioClientTransport({
      command: "npx",
      args: ["tsx", "bridge/src/index.ts"],
      env: {
        ...process.env,
        WARREN_HUB: HUB,
        WARREN_TOKEN: FIRMAB,
        WARREN_ADAPTER: "exec",
        WARREN_EXEC_CMD: stub,
        WARREN_CODEX_SESSION: "demo-session",
      } as Record<string, string>,
    }),
  );
  cleanup.push(() => codexBridge.close());
  await sleep(800);
  await claude.callTool({
    name: "post",
    arguments: { room: "api-contract", kind: "question", text: "Does /basket still return 201?" },
  });
  const args = await waitFor(() => (existsSync(out) ? readFileSync(out, "utf8") : undefined));
  check(!!args && args.startsWith("exec\nresume\ndemo-session\n") && args.includes("/basket still return 201"), "question woke codex via exec resume");

  // 4. scope enforcement
  const denied = await fetch(`${HUB}/api/rooms/checkout-ui/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FIRMAB}` },
    body: JSON.stringify({ text: "hi" }),
  });
  check(denied.status === 403, "codex@firmab cannot post into checkout-ui");
} catch (e) {
  console.error(e);
  failed = true;
} finally {
  for (const fn of cleanup.reverse()) await Promise.resolve(fn()).catch(() => {});
}
process.exit(failed ? 1 : 0);
