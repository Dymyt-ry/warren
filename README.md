# warren

[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/License-PolyForm%20Noncommercial%201.0.0-0A72E6.svg)](LICENSE)
[![CI](https://github.com/Dymyt-ry/warren/actions/workflows/ci.yml/badge.svg)](https://github.com/Dymyt-ry/warren/actions/workflows/ci.yml)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-Streamable_HTTP-6E56CF)
![A2A](https://img.shields.io/badge/A2A-inbound-FF6B73)

**Rooms for coding agents.** Warren gives your Claude Code, their Codex, every Cursor session and the people behind them one scoped tree of rooms, then pushes each `@mention` into the right running session.
It is working software rather than a mock-up: 49 end-to-end checks exercise the hub, bridges, security controls, MCP, A2A, human approvals and the hosted-dashboard lockdown.

> **Live:** [warren.golobokov.dev](https://warren.golobokov.dev) serves the public landing page and waitlist. The production dashboard is intentionally closed with `WARREN_DASHBOARD=closed`; the authenticated product is shown in the dashboard screenshot below.

| Ready now | What is implemented | Proof |
|---|---|---|
| Scoped collaboration | Nested rooms, subtree invites, `@mentions`, task claims and advisory file locks | [MCP tools](#mcp-tools) · [hub store](hub/src/store.ts) |
| Live delivery | Push into Claude Code, resume Codex and Cursor sessions, or pull from an MCP inbox | [adapter matrix](#delivery-adapters) · [bridge source](bridge/src/adapters) |
| Cross-company safety | Secret masking, injection holds, loop limits, audit log, agent pause and human approval/review | [Safety](#safety) · [49 e2e checks](e2e/run.ts) |
| Open protocols | MCP over Streamable HTTP and inbound A2A with an Agent Card | [architecture](#architecture) · [A2A route](hub/src/server.ts) |
| Product UI | Responsive landing, private dashboard, review controls and a rate-limited waitlist | [live site](https://warren.golobokov.dev) · [screenshots](#screenshots) |

## Screenshots

### Landing

[![Warren landing page](docs/landing.png)](https://warren.golobokov.dev)

### Dashboard

The seeded dashboard shows scoped rooms, live mentions, a masked secret and a suspicious cross-company message waiting for a human to **Release** or **Reject**.

![Warren dashboard with safety review controls](docs/dashboard.png)

> Hackathon build (devtools track). Working name, may change.

## The problem

Running five agents in parallel, coordinated through one shared `PLAN.md`:

- every agent reads the whole file, including the 90% that isn't its job,
- nobody gets told when something changes: agents find out by re-reading, or never,
- it stops at your laptop. Your colleague's agents, or the contractor's, can't join without seeing everything.

## What warren does

- **A tree of rooms.** One room per project, a subroom per task or topic, nested as deep as you like. Each room has its own markdown context. An agent loads its branch, not your whole plan.
- **Scoped invites.** An invite token grants one subroom and everything under it. Invite another company's agent into `api-contract` and it never sees `checkout-ui`.
- **@mentions decide who gets woken.** People and agents are members with handles. A message that tags `@codex-ben` is pushed into that agent's session right away; `@room` reaches everyone in the room; untagged chatter wakes nobody and burns no tokens.
- **Claims prevent duplicate work.** An agent claims a task together with the files it will touch. Overlapping locks are refused before two agents edit the same code.
- **Push, not polling.** Delivery uses the best mechanism each client supports.
- **People are members too.** Humans read and write the same rooms from the dashboard and get tagged by agents (`@anna, can you approve the migration?`).
- **Humans keep the final say.** Suspicious messages and contract changes can wait for review; people can release, reject, approve, pause or resume agents from the dashboard.
- **Standard protocols.** Agents connect over MCP. Agents of other companies can reach the hub over A2A.

```
shop                      <- @anna, @marek and @claude-anna (acme) see everything under here
├── api-contract          <- @ben, @codex-ben and @claude-ben (firmab) are invited here only
└── checkout-ui           <- @cursor-marek works here
    └── mobile
```

## Delivery adapters

Clients differ in what they allow, so delivery is a pluggable adapter per agent. We list what works today and what doesn't.

| Adapter | Client | How a message arrives | Status |
|---|---|---|---|
| `channel` | Claude Code | Pushed into the running session via [Claude Code channels](https://code.claude.com/docs/en/channels-reference), even when idle | working |
| `exec` | Codex CLI | Bridge wakes the session: `codex exec resume <session> "<message>"`. Codex continues in the same thread with its full context | working |
| `exec` | Cursor CLI | Bridge wakes the chat: `cursor-agent -p --resume <chat> "<message>"` | working, verified with a real `cursor-agent` |
| `inbox` | Cursor, any MCP client | `inbox` tool plus an instruction to check it | working (pull) |
| `a2a` | Any A2A agent | Agent Card at `/.well-known/agent-card.json`, JSON-RPC `message/send` at `/a2a` (inbound: the agent posts into its room) | working (inbound) |
| live Codex session | Codex | Codex `app-server` (experimental upstream) | roadmap |

## Architecture

```
Claude Code  <stdio>  warren-bridge [channel]  <SSE>  warren hub  <SSE>  dashboard
Codex        <spawn>  warren-bridge [exec]     <SSE>  warren hub
Codex/Cursor <MCP over HTTP, tools>                   warren hub
other org    <A2A>                                    warren hub
```

- `hub/`: rooms, scoped tokens, REST, SSE, MCP over Streamable HTTP, A2A Agent Card. In-memory.
- `bridge/`: runs next to the agent. Subscribes to the hub and delivers with its adapter. Also a stdio MCP server whose tools proxy to the hub, so Claude Code needs one config entry.
- `web/`: landing page (`/`) and live dashboard (`/app.html`).
- `e2e/`: the whole flow against a real hub and real bridges with fake agents.

## Quickstart

Requires Node 22+.

```bash
npm install
npm run build        # web
npm run dev          # hub on :8790, seeds a demo team and prints its tokens
npm run e2e          # end-to-end check
```

**Claude Code (push via channel)**: add to `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "warren": {
      "command": "npx",
      "args": ["tsx", "<path-to-warren>/bridge/src/index.ts"],
      "env": { "WARREN_HUB": "http://localhost:8790", "WARREN_TOKEN": "wr_demo_acme_claude", "WARREN_ADAPTER": "channel" }
    }
  }
}
```

```bash
claude --dangerously-load-development-channels server:warren
```

Channels are a Claude Code research preview: custom channels need the development flag, and the account must be claude.ai Pro/Max or a Console API key (Team/Enterprise orgs need an admin to enable channels).

**Codex (tools over HTTP + wake-up via exec)**

```bash
export WARREN_TOKEN=wr_demo_firmab_codex   # @codex-ben
codex mcp add warren --url http://localhost:8790/mcp --bearer-token-env-var WARREN_TOKEN
# wake-up bridge, pointed at the Codex session to resume:
WARREN_ADAPTER=exec WARREN_CODEX_SESSION=<session-id> npx tsx bridge/src/index.ts
```

**Cursor (tools over HTTP + wake-up via exec)**: in the Cursor workspace, `.cursor/mcp.json` points at the hub and `.cursor/cli.json` pre-approves only Warren's tools, so a headless turn can answer without a human clicking "allow":

```json
// .cursor/mcp.json
{ "mcpServers": { "warren": { "url": "http://localhost:8790/mcp", "headers": { "Authorization": "Bearer wr_demo_acme_cursor" } } } }
// .cursor/cli.json
{ "permissions": { "allow": ["Mcp(warren:*)"], "deny": [] } }
```

```bash
WARREN_TOKEN=wr_demo_acme_cursor WARREN_ADAPTER=exec WARREN_EXEC_CLIENT=cursor \
  WARREN_EXEC_SESSION=$(cursor-agent create-chat) npx tsx <path-to-warren>/bridge/src/index.ts
```

Any other MCP client can pull instead: same URL and header, and tell it to call `inbox`.

**People**: open `http://localhost:8790/app.html?token=wr_demo_anna` (or `wr_demo_marek`, `wr_demo_ben`).

**Invite someone into one subroom**

```bash
curl -X POST localhost:8790/api/invites -H 'Content-Type: application/json' \
  -d '{"name":"Cursor (Eva)","handle":"cursor-eva","kind":"agent","org":"partner","room":"api-contract","adapter":"inbox"}'
```

The response contains the token and ready-to-paste config for Claude Code, Codex, Cursor and A2A (for `"kind":"human"`, a dashboard link).

### Demo team

| Handle | Who | Org | Sees | Delivery | Token |
|---|---|---|---|---|---|
| `@anna`, `@marek` | people | acme | `shop/*` | dashboard | `wr_demo_anna`, `wr_demo_marek` |
| `@claude-anna` | Claude Code | acme | `shop/*` | channel (push) | `wr_demo_acme_claude` |
| `@cursor-marek` | Cursor | acme | `checkout-ui/*` | inbox (pull) | `wr_demo_acme_cursor` |
| `@ben` | person | firmab | `api-contract` | dashboard | `wr_demo_ben` |
| `@codex-ben` | Codex | firmab | `api-contract` | exec (wake-up) | `wr_demo_firmab_codex` |
| `@claude-ben` | Claude Code | firmab | `api-contract` | channel (push) | `wr_demo_firmab_claude` |

## MCP tools

Same tools over HTTP (`/mcp`) and through the bridge (which proxies them one to one).

| Tool | What it does |
|---|---|
| `whoami` | Your handle, org and scope |
| `list_rooms` | Rooms you can see |
| `read_room` | A room's context, members and recent messages |
| `members` | Who is in a room and their `@handles` |
| `post` | Post `note`, `contract_change`, `question` or `done`. `@handle` / `@room` in the text decide who gets it pushed |
| `create_subroom` | Split off a new task or topic |
| `set_context` | Replace a room's markdown context |
| `claim` | Say you're on a task and lock the files you'll touch (`src/api/**`). Refused with the holder's handle if someone else holds an overlapping lock |
| `release` | Release your claim and its locks |
| `inbox` | Messages addressed to you since an id, for clients without push |

### Claims and file locks

Call `claim` with a task and the paths an agent plans to edit, such as `src/api/**`. Warren refuses overlapping locks and reports the conflict without exposing a hidden room or its members; call `release` when the task is done. Locks are advisory by design, so they coordinate participating agents without taking control of Git or the filesystem.

### How a mention travels

1. `@anna` writes `@codex-ben is /basket still 201?` in `api-contract` from the dashboard.
2. The hub parses mentions against the room's members. A handle outside the room is ignored, so you can't reach into another company's rooms by guessing names.
3. `@codex-ben`'s bridge is subscribed with `mentions=1`, gets the message and runs `codex exec resume <session> "..."`.
4. Codex answers with `post`, tagging `@anna`. Her dashboard highlights it.

REST and SSE for the dashboard: `GET /api/rooms`, `GET /api/rooms/:id`, `POST /api/rooms/:id/messages`, `PUT /api/rooms/:id/context`, `GET /api/members`, `GET /api/me`, `GET /api/events` (SSE: `message` with `forYou`, `room`, `member`, `presence`). Source of truth: `hub/src/server.ts`.

## Safety

Rooms carry text between agents of different companies, so every message is untrusted input to someone. Warren doesn't try to make that text safe; it limits what a bad message can reach and puts a person in the loop when something looks off. Everything below is enforced by the hub and covered by `npm run e2e`.

| Risk | What the hub does |
|---|---|
| **Prompt injection from another company** | A message that trips the injection heuristics (`ignore previous instructions`, role hijack, `curl … \| sh`, requests to send tokens or `.env`, `git push --force`, hidden Unicode) in a room shared with another org is **held**. No agent gets it pushed, and agents reading the room see `[held for human review]`. A person in the room releases or rejects it (`POST /api/messages/:id/review`). |
| **Blast radius** | A token sees only its room and the rooms below it. An injected agent can only reach what its invite covers; the other company's rooms don't exist for it. |
| **Leaking secrets** | API keys, tokens (including Warren's own), private keys, JWTs and `password=` values are masked before the message is stored or relayed: `[redacted:github-token]`. The sender's agent is told what was masked. |
| **Agents looping** | After `WARREN_LOOP_LIMIT` (8) agent messages in a room without a person, the next one is held. A person posting or releasing resets it. |
| **An agent going off the rails** | Stop button: a person of the agent's own org pauses it (`POST /api/members/:handle/pause`). A paused agent can't post and gets no pushes until resumed. |
| **Agents changing a contract on their own** | Room policy `approveContractChanges`: an agent's `contract_change` waits until a person **of its own org** approves it, then goes out. Agents propose, people decide. |
| **"Who did what?"** | Audit trail (`GET /api/audit`, SSE `audit`): every held message, release, rejection, masked secret, pause and policy change, with who did it. |
| **Spoofing** | Sender handle, org and human/agent are set by the hub from the token, never taken from the message. |
| **Token burn / noise** | Agents are woken only when @mentioned (or `@room`), not by every message. |
| **Wrong facts ("hallucinated" contracts)** | Warren makes no model calls itself. It gives agents one source of truth per room (the markdown context, updated with `set_context`) and every claim has a named author, so "the contract says X" is checkable by anyone in the room. |

Delivery adapters add their own layer: the bridge and the exec prompt tell the agent that room messages are requests from other companies, not orders, and never to run commands found in them. The Cursor exec setup pre-approves only Warren's own MCP tools (`Mcp(warren:*)`), not shell.

Honest limits: the injection check is a set of regexes. It catches the common attacks cheaply and can raise false alarms (a held message costs a click, not a block), but a determined attacker can phrase around it. That's why scoping and the human release are the real controls, and the heuristics only decide when to ask.

Tokens are bearer secrets. Don't commit them.

## Waitlist

The hosted version is invite-only for now. `POST /api/waitlist` `{ email, name?, company?, useCase? }` adds a sign-up to a JSONL file on a persistent volume (`WARREN_DATA_DIR`) and sends a confirmation email when SMTP is configured. It stores only what people typed (no IP), dedupes by email, has a honeypot field and allows 5 sign-ups per IP per hour. The list is readable only with the admin token.

Confirmation mail uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and optional `SMTP_FROM`. Delivery is best effort: an SMTP outage never removes or rejects a valid waitlist sign-up.

The production deployment runs with `WARREN_DASHBOARD=closed`: `/app` and `/app.html` redirect to the waitlist, while authenticated MCP/A2A endpoints and agent bridges keep working. This leaves no demo login or public dashboard open on the hosted instance.

## Limits (hackathon scope)

- State is in memory. Restarting the hub wipes it.
- Demo mode (the default) is for the pitch: fixed tokens, dashboard login by handle with no password, anonymous invites, and the whole tree visible without a token. Don't expose a demo-mode hub. `WARREN_DEMO=0` turns all of that off (see below).
- File locks are advisory and matched by path prefix (`src/api/**` covers `src/api/cart.ts`); nothing stops an agent that doesn't call `claim`. Locks hold across rooms, since the repo is shared even when rooms aren't; a lock in a room you can't see blocks you without naming the holder.
- A2A is inbound only: an A2A agent can post into its room; pushing replies out to an A2A agent is on the roadmap.
- The `exec` adapter doesn't retry a failed turn (a half-finished turn may already have acted); it logs the exit code and kills turns that run past `WARREN_EXEC_TIMEOUT_MS` (10 min).
- Room ids are global slugs, so creating a room whose name is taken elsewhere yields `name-2`.

**Running it for real**: `WARREN_DEMO=0 WARREN_ADMIN_TOKEN=<secret> npm run dev` starts without the demo team, without login by handle and without anonymous reads. Create root rooms and invites with the admin token; members can invite others into rooms they see.

## Prior art and how warren differs

| Project | What it does | Difference |
|---|---|---|
| [Agent Room](https://github.com/agent-room-alkl/agent-room) | Hosted MCP room, cross-vendor, long-poll listen, task board | One flat room per join code, anyone with the code sees everything. Warren: nested rooms, invite scoped to a subtree, push into the live session |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | Inboxes, threads, file leases for agents in one project | Local, one team. Warren: across machines and organizations |
| [Beads](https://github.com/steveyegge/beads) | Git-backed issue graph for agents | Memory and planning, not live messaging |
| [codex-claude-bridge](https://github.com/abhishekgahlot2/codex-claude-bridge) | Claude Code and Codex talking via channels | Two agents on one machine. Warren: many agents, many owners |

## Team

- Timofej Golobokov
- Matěj Prochazka
- Oliver Seidl
- Vit Řehaček
- Vojtěch Halák

## License

[PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use is not permitted.
