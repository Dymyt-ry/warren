import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dataDir = mkdtempSync(join(tmpdir(), "warren-production-smoke-"));
const setupToken = "production-smoke-setup-token-0123456789abcdef";
const password = "correct horse production smoke";
const email = "owner@example.test";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (!address || typeof address === "string") return reject(new Error("could not allocate a smoke-test port"));
      probe.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function start(port: number) {
  let output = "";
  const child = spawn(process.execPath, ["--enable-source-maps", "hub/dist/server.js"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(port),
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      WARREN_DATA_DIR: dataDir,
      WARREN_SETUP_TOKEN: setupToken,
      WARREN_DEMO: "0",
      WARREN_SEED: "0",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk) => (output += chunk));
  child.stderr?.on("data", (chunk) => (output += chunk));
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`compiled production server exited during startup:\n${output}`);
    if (await fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.ok, () => false)) return child;
    await sleep(50);
  }
  child.kill("SIGTERM");
  throw new Error(`compiled production server did not become healthy:\n${output}`);
}

async function stop(child: ChildProcess) {
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  child.kill("SIGTERM");
  const code = await Promise.race([exited, sleep(5_000).then(() => undefined)]);
  if (code === undefined) {
    child.kill("SIGKILL");
    throw new Error("compiled production server did not stop within five seconds");
  }
  if (code !== 0) throw new Error(`compiled production server exited with ${code}`);
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

let activeChild: ChildProcess | undefined;
try {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  activeChild = await start(port);
  const app = await fetch(`${base}/app`);
  if (!app.ok || !(await app.text()).toLowerCase().includes("<!doctype html>")) throw new Error("compiled server did not serve the built dashboard");

  const setup = await fetch(
    `${base}/api/setup`,
    json({ name: "Smoke Owner", org: "Smoke Org", email, password, room: "Smoke Org", setupToken }),
  );
  if (setup.status !== 201) throw new Error(`owner setup failed with ${setup.status}: ${await setup.text()}`);
  const cookie = setup.headers.getSetCookie()[0]?.split(";", 1)[0];
  if (!cookie) throw new Error("owner setup did not create a session cookie");

  const stream = await fetch(`${base}/api/events`, { headers: { Cookie: cookie } });
  if (stream.status !== 200 || stream.headers.get("content-type") !== "text/event-stream") throw new Error("authenticated SSE did not open");
  await stop(activeChild);
  activeChild = undefined;

  activeChild = await start(port);
  const config = await fetch(`${base}/api/config`).then((response) => response.json() as Promise<{ needsSetup: boolean }>);
  const login = await fetch(`${base}/api/auth/login`, json({ email, password }));
  if (config.needsSetup || login.status !== 200) throw new Error("SQLite state did not survive a compiled-server restart");
  await stop(activeChild);
  activeChild = undefined;
  console.log("PASS  compiled production server: health, assets, setup/login, SSE shutdown, and SQLite restart");
} finally {
  if (activeChild?.exitCode === null) activeChild.kill("SIGKILL");
  rmSync(dataDir, { recursive: true, force: true });
}
