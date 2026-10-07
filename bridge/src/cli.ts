#!/usr/bin/env node
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bridge, add, leave, status, wake } from "./cli/commands.js";
import { bridgeCommand } from "./cli/config.js";

const help = `warren-cli: connect coding agents to a Warren hub

  warren add <claude|codex|cursor> --hub <url> [--token <agent-token>]
      [--session <id>]
  warren wake [--session <id>]       wake Codex/Cursor on mentions
  warren status                      inspect this folder's agent
  warren leave                       remove the agent and local wiring
  warren bridge [--config <file>]    run the local MCP/push bridge`;

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    hub: { type: "string" },
    token: { type: "string" },
    session: { type: "string" },
    config: { type: "string" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});
const [command, argument] = positionals;
const dir = process.cwd();

async function promptToken(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("no agent token provided; pass --token, set WARREN_TOKEN, or run interactively");
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write("Agent token: ");
  muted = true;
  try {
    return (await readline.question("")).trim();
  } finally {
    muted = false;
    readline.close();
    process.stdout.write("\n");
  }
}

try {
  if (values.version) console.log(version);
  else if (values.help || !command) console.log(help);
  else if (command === "add")
    await add(dir, argument, {
      hub: values.hub,
      token: values.token,
      session: values.session,
      bridge: bridgeCommand(fileURLToPath(import.meta.url), process.execPath, version),
      wakeCommand: `npx -y warren-cli@${version} wake`,
      promptToken,
    });
  else if (command === "wake") await wake(dir, values.session);
  else if (command === "status") await status(dir);
  else if (command === "leave") await leave(dir);
  else if (command === "bridge") await bridge(dir, values.config);
  else throw new Error(`unknown command "${command}"\n\n${help}`);
} catch (error) {
  console.error(`warren: ${(error as Error).message}`);
  process.exit(1);
}
