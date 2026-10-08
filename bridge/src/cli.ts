#!/usr/bin/env node
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bridge, add, leave, status, wake } from "./cli/commands.js";
import { bridgeCommand } from "./cli/config.js";
import { callHubTool, listHubTools, objectInput, positiveLimit } from "./cli/tools.js";

const help = `warren-cli: use Warren from coding agents and shell scripts

  warren add <claude|codex|cursor> --hub <url> [--token <agent-token>]
      [--session <id>]
  warren whoami
  warren rooms
  warren read <room> [--limit <1-100>]
  warren members <room>
  warren post <room> <text...> [--kind <note|question|contract_change|done>]
  warren subroom <parent> <name...> [--context <markdown>]
  warren set-context <room> <markdown...>
  warren claim <room> <task...> [--file <path-or-glob>]...
  warren release <claim-id>
  warren inbox [--since <message-id>] [--all]
  warren tools                       list the live hub's MCP tools as JSON
  warren call <tool> --input <json>  call any MCP tool; output is JSON/text
  warren wake [--session <id>]       wake Codex/Cursor on mentions
  warren status                      inspect this folder's agent
  warren leave                       remove the agent and local wiring
  warren bridge [--config <file>]    run the local MCP/push bridge

Commands use this folder's .warren.json. For headless use, set WARREN_HUB and
WARREN_TOKEN (or pass --hub and --token). Credentials never appear in output.`;

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    hub: { type: "string" },
    token: { type: "string" },
    session: { type: "string" },
    config: { type: "string" },
    input: { type: "string" },
    limit: { type: "string" },
    kind: { type: "string" },
    text: { type: "string" },
    context: { type: "string" },
    task: { type: "string" },
    file: { type: "string", multiple: true },
    since: { type: "string" },
    all: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});
const [command, ...arguments_] = positionals;
const argument = arguments_[0];
const dir = process.cwd();

const required = (value: string | undefined, label: string) => {
  if (!value) throw new Error(`${label} is required`);
  return value;
};
const joined = (values_: string[], explicit: string | undefined, label: string) => required(explicit ?? values_.join(" ").trim(), label);
const auth = { hub: values.hub, token: values.token };

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
  else if (command === "tools") await listHubTools(dir, version, auth);
  else if (command === "call") await callHubTool(dir, version, required(argument, "tool name"), objectInput(values.input), auth);
  else if (command === "whoami") await callHubTool(dir, version, "whoami", {}, auth);
  else if (["rooms", "list-rooms", "list_rooms"].includes(command)) await callHubTool(dir, version, "list_rooms", {}, auth);
  else if (["read", "read-room", "read_room"].includes(command)) {
    const limit = positiveLimit(values.limit);
    await callHubTool(dir, version, "read_room", { room: required(argument, "room"), ...(limit ? { limit } : {}) }, auth);
  }
  else if (command === "members") await callHubTool(dir, version, "members", { room: required(argument, "room") }, auth);
  else if (command === "post")
    await callHubTool(
      dir,
      version,
      "post",
      { room: required(argument, "room"), kind: values.kind ?? "note", text: joined(arguments_.slice(1), values.text, "message text") },
      auth,
    );
  else if (["subroom", "create-subroom", "create_subroom"].includes(command))
    await callHubTool(
      dir,
      version,
      "create_subroom",
      { parent: required(argument, "parent room"), name: joined(arguments_.slice(1), undefined, "subroom name"), context: values.context ?? "" },
      auth,
    );
  else if (["set-context", "set_context"].includes(command))
    await callHubTool(
      dir,
      version,
      "set_context",
      { room: required(argument, "room"), context: joined(arguments_.slice(1), values.context, "context") },
      auth,
    );
  else if (command === "claim")
    await callHubTool(
      dir,
      version,
      "claim",
      { room: required(argument, "room"), task: joined(arguments_.slice(1), values.task, "task"), files: values.file ?? [] },
      auth,
    );
  else if (command === "release") await callHubTool(dir, version, "release", { claim: required(argument, "claim id") }, auth);
  else if (command === "inbox")
    await callHubTool(dir, version, "inbox", { ...(values.since ? { since: values.since } : {}), all: values.all ?? false }, auth);
  else throw new Error(`unknown command "${command}"\n\n${help}`);
} catch (error) {
  console.error(`warren: ${(error as Error).message}`);
  process.exit(1);
}
