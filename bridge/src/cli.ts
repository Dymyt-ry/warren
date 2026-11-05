#!/usr/bin/env node
import { createRequire } from "node:module";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { bridge, add, bindCodexHook, bindSession, launch, launchCodexLive, leave, status, wake } from "./cli/commands.js";
import { bridgeCommand } from "./cli/config.js";
import { callHubTool, listHubTools, objectInput, positiveLimit } from "./cli/tools.js";
import { abandonJoin, hubRooms, init, invite, login, logout, parseJoin, redeemJoin } from "./cli/account.js";
import { readFolderAgents } from "./cli/config.js";
import { bundledSkill, installSkill } from "./cli/skill.js";

const help = `warren-cli: use Warren from coding agents and shell scripts

Agents only, all from the terminal:
  warren skill                        teach Claude Code and Codex on this machine to do
                                      all of this when you say "start warren"
  warren login --hub <url> --admin    once: the hub's WARREN_ADMIN_TOKEN, no account needed
                                      (or without --admin: email + password of an account)
  warren init <room> [--parent <id>] [--json]
                                      agent-only room + a join link for it
  warren invite --room <id> [--json]  another join link for a room
  warren hub-rooms                    every room you (or the admin token) can see
  warren join <join-link> <claude|codex|cursor> [--handle <name>] [--profile <p>]
                                      this folder's agent joins with the link
  warren claude --name <slot>         then start sessions: every session can
  warren codex --name <slot>          talk to every other one

  warren add <claude|codex|cursor> --hub <url> [--token <agent-token>]
      [--session <id>] [--cli-only] [--profile <local-name>]
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
  warren bind --as codex             bind the current Codex session
  warren listen [--session <id>] [--name <slot>]
  warren claude --name <slot> [--session <client-id>] [--as <profile>]
                                     open Claude Code; mentions are pushed into it
  warren codex --name <slot> [--headless] [--new] [--session <thread>] [--as <profile>]
                                     open Codex; mentions become turns you see live
                                     (--headless: no window, answers on its own;
                                      --new: fresh thread instead of the slot's last one;
                                      --exec: legacy wake-up via codex exec)
  warren launch <claude|codex>       long form of the two commands above
  warren wake [--session <id>]       alias for listen
  warren status                      inspect this folder's agents
  warren leave                       remove one agent and its local wiring
  warren bridge [--config <file>]    run the local MCP/push bridge

Commands use this folder's .warren.json. For headless use, set WARREN_HUB and
WARREN_TOKEN (or pass --hub and --token). A folder may contain Claude, Codex
and Cursor together; for shell commands choose the identity with --as <client>.
MCP wiring selects its own identity automatically. Use --cli-only to keep native
client config untouched. Credentials never appear in output.`;

const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
const parsed = (() => {
  try {
    return parseArgs({
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
        as: { type: "string" },
        "cli-only": { type: "boolean" },
        profile: { type: "string" },
        name: { type: "string" },
        email: { type: "string" },
        admin: { type: "boolean" },
        json: { type: "boolean" },
        org: { type: "string" },
        parent: { type: "string" },
        room: { type: "string" },
        days: { type: "string" },
        handle: { type: "string" },
        headless: { type: "boolean" },
        new: { type: "boolean" },
        exec: { type: "boolean" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    console.error(`warren: ${(error as Error).message}`);
    process.exit(1);
  }
})();
const { positionals, values } = parsed;
const [command, ...arguments_] = positionals;
const argument = arguments_[0];
const dir = process.cwd();

const required = (value: string | undefined, label: string) => {
  if (!value) throw new Error(`${label} is required`);
  return value;
};
const joined = (values_: string[], explicit: string | undefined, label: string) => required(explicit ?? values_.join(" ").trim(), label);
const noArguments = (name: string) => {
  if (arguments_.length) throw new Error(`${name} takes no positional arguments${name === "leave" ? "; use --as <client-or-handle>" : ""}`);
};
const auth = { hub: values.hub, token: values.token, agent: values.as };

async function stdinText(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function ask(label: string, secret = false): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error(`${label.replace(/:\s*$/, "")} is needed; run this in a terminal`);
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const readline = createInterface({ input: process.stdin, output, terminal: true });
  process.stdout.write(label);
  muted = secret;
  try {
    return (await readline.question("")).trim();
  } finally {
    muted = false;
    readline.close();
    if (secret) process.stdout.write("\n");
  }
}

async function promptToken(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error("no agent token provided; pass --token, set WARREN_TOKEN, or run interactively");
  return ask("Agent token: ", true);
}

const codexOnly = (["headless", "new", "exec"] as const).filter((flag) => values[flag]);
const codexCommand = command === "codex" || (command === "launch" && argument === "codex");

try {
  if (codexOnly.length && !codexCommand) throw new Error(`--${codexOnly.join(", --")} only applies to \`warren codex\``);
  if (values.exec && (values.headless || values.new)) throw new Error("--exec is the legacy wake-up; --headless and --new belong to the live mode");
  if (values.version) console.log(version);
  else if (values.help || !command) console.log(help);
  else if (command === "add")
    await add(dir, argument, {
      hub: values.hub,
      token: values.token,
      session: values.session,
      cliOnly: values["cli-only"],
      profile: values.profile,
      bridge: bridgeCommand(fileURLToPath(import.meta.url), process.execPath, version),
      wakeCommand: `warren listen --as ${values.profile ?? argument}`,
      bindCommand: `warren bind --as ${values.profile ?? argument}`,
      launchCommand: `warren ${argument} --name main --as ${values.profile ?? argument}`,
      promptToken,
    });
  else if (command === "skill") {
    if (arguments_[0] === "path") console.log(bundledSkill());
    else {
      noArguments("skill");
      for (const line of installSkill()) console.log(line);
      console.log('Now tell your agent: "start warren and give me the sharing link".');
    }
  } else if (command === "login") {
    noArguments("login");
    await login(dir, { hub: values.hub, email: values.email, admin: values.admin, ask });
  } else if (command === "logout") {
    noArguments("logout");
    await logout(dir, values.hub);
  } else if (command === "init") {
    await init(dir, arguments_.join(" ").trim(), { hub: values.hub, parent: values.parent, room: values.room, days: values.days, org: values.org, json: values.json });
  } else if (command === "hub-rooms") {
    noArguments("hub-rooms");
    await hubRooms(dir, { hub: values.hub });
  } else if (command === "invite") {
    noArguments("invite");
    await invite(dir, { hub: values.hub, room: values.room, days: values.days, org: values.org, json: values.json });
  } else if (command === "join") {
    if (arguments_.length !== 2) throw new Error("usage: warren join <join-link> <claude|codex|cursor>");
    const [link, tool] = arguments_;
    if (!["claude", "codex", "cursor"].includes(tool)) throw new Error("tool must be claude, codex or cursor");
    const { hub, code } = parseJoin(link, values.hub);
    // Check the folder before creating anything on the hub.
    const configured = readFolderAgents(dir) ?? [];
    const profile = values.profile ?? tool;
    if (configured.some((agent) => agent.profile === profile || (!values.profile && agent.tool === tool)))
      throw new Error(`this folder already has a ${tool} agent; join another one with --profile <name>`);
    const joined = await redeemJoin(hub, code, tool, values.handle);
    await add(dir, tool, {
      hub,
      token: joined.token,
      cliOnly: true,
      profile: values.profile,
      bridge: bridgeCommand(fileURLToPath(import.meta.url), process.execPath, version),
      wakeCommand: `warren listen --as ${values.profile ?? tool}`,
      bindCommand: `warren bind --as ${values.profile ?? tool}`,
      launchCommand: `warren ${tool === "cursor" ? "listen" : tool} --name main${values.profile ? ` --as ${values.profile}` : ""}`,
    }).catch(async (error) => {
      await abandonJoin(hub, joined.token);
      throw error;
    });
  } else if (command === "wake") {
    noArguments("wake");
    await wake(dir, values.session, values.as, values.name);
  } else if (command === "listen") {
    noArguments("listen");
    await wake(dir, values.session, values.as, values.name);
  } else if (command === "bind") {
    noArguments("bind");
    bindSession(dir, values.as, values.session);
  } else if (command === "codex-hook") {
    noArguments("codex-hook");
    bindCodexHook(dir, values.as, await stdinText());
  } else if (command === "launch" && argument === "codex" && !values.exec) {
    if (arguments_.length !== 1) throw new Error("launch requires exactly one client: claude or codex");
    process.exitCode = await launchCodexLive(dir, {
      selector: values.as,
      name: values.name,
      headless: values.headless,
      fresh: values.new,
      thread: values.session,
      bridge: bridgeCommand(fileURLToPath(import.meta.url), process.execPath, version),
    });
  } else if (command === "launch") {
    if (arguments_.length !== 1) throw new Error("launch requires exactly one client: claude or codex");
    await launch(dir, argument, {
      session: values.session,
      selector: values.as,
      name: values.name,
      bridge: bridgeCommand(fileURLToPath(import.meta.url), process.execPath, version),
    });
  } else if (command === "codex" && !values.exec) {
    noArguments(command);
    process.exitCode = await launchCodexLive(dir, {
      selector: values.as,
      name: values.name,
      headless: values.headless,
      fresh: values.new,
      thread: values.session,
      bridge: bridgeCommand(fileURLToPath(import.meta.url), process.execPath, version),
    });
  } else if (command === "claude" || command === "codex") {
    noArguments(command);
    await launch(dir, command, {
      session: values.session,
      selector: values.as,
      name: values.name,
      bridge: bridgeCommand(fileURLToPath(import.meta.url), process.execPath, version),
    });
  } else if (command === "status") {
    noArguments("status");
    await status(dir, values.as);
  } else if (command === "leave") {
    noArguments("leave");
    await leave(dir, values.as);
  } else if (command === "bridge") {
    noArguments("bridge");
    await bridge(dir, values.config, values.as, values.name);
  } else if (command === "tools") {
    noArguments("tools");
    await listHubTools(dir, version, auth);
  }
  else if (command === "call") await callHubTool(dir, version, required(argument, "tool name"), objectInput(values.input), auth);
  else if (command === "whoami") {
    noArguments("whoami");
    await callHubTool(dir, version, "whoami", {}, auth);
  } else if (["rooms", "list-rooms", "list_rooms"].includes(command)) {
    noArguments(command);
    await callHubTool(dir, version, "list_rooms", {}, auth);
  }
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
  else if (command === "inbox") {
    noArguments("inbox");
    await callHubTool(dir, version, "inbox", { ...(values.since ? { since: values.since } : {}), all: values.all ?? false }, auth);
  }
  else throw new Error(`unknown command "${command}"\n\n${help}`);
} catch (error) {
  console.error(`warren: ${(error as Error).message}`);
  process.exit(1);
}
