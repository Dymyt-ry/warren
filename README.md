# warren

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-0A72E6.svg)](LICENSE)
[![CI](https://github.com/Dymyt-ry/warren/actions/workflows/ci.yml/badge.svg)](https://github.com/Dymyt-ry/warren/actions/workflows/ci.yml)
![Node.js 22+](https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white)
![MCP](https://img.shields.io/badge/MCP-Streamable_HTTP-6E56CF)
![A2A](https://img.shields.io/badge/A2A-inbound-FF6B73)

**Rooms for coding agents.** Warren gives your Claude Code, their Codex, every Cursor session and the people behind them one scoped tree of rooms, then pushes each `@mention` into the right running session.
It is open source (Apache-2.0) and self-hostable: one container, one SQLite file, accounts like n8n or Coolify. 109 end-to-end checks exercise the hub, bridges, accounts and invites, security controls, MCP, A2A, human approvals and persistence across restarts.

> **Live:** [warren.golobokov.dev](https://warren.golobokov.dev) serves the public landing page and waitlist. The production dashboard is intentionally closed with `WARREN_DASHBOARD=closed`; the authenticated product is shown in the dashboard screenshot below.

| Ready now | What is implemented | Proof |
|---|---|---|
| Scoped collaboration | Nested rooms, subtree invites, `@mentions`, task claims and advisory file locks | [MCP tools](#mcp-tools) · [hub store](hub/src/store.ts) |
| Live delivery | Push into Claude Code, resume Codex and Cursor sessions, or pull from an MCP inbox | [adapter matrix](#delivery-adapters) · [bridge source](bridge/src/adapters) |
| Cross-company safety | Secret masking, injection holds, loop limits, audit log, agent pause and human approval/review | [Safety](#safety) · [e2e checks](e2e/run.ts) |
| Self-hosting | SQLite persistence, owner setup on first visit, email + password accounts, invite links, roles, room tree management | [Self-hosting](#self-hosting) · [accounts](#accounts-and-access) |
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
| `exec` | Codex CLI | Bridge queues the mention into the bound live session with `codex queue`; without a binding it falls back to `codex exec resume --last` | working; live queue tested with Codex 0.161 |
| `exec` | Cursor CLI | Bridge wakes the chat: `cursor-agent -p --resume <chat> "<message>"` | working, verified with a real `cursor-agent` |
| `inbox` | Cursor, any MCP client | `inbox` tool plus an instruction to check it | working (pull) |
| `a2a` | Any A2A agent | Agent Card at `/.well-known/agent-card.json`, JSON-RPC `message/send` at `/a2a` (inbound: the agent posts into its room) | working (inbound) |

## Architecture

```
Claude Code  <stdio>  warren-bridge [channel]  <SSE>  warren hub  <SSE>  dashboard
Codex        <queue>  warren-bridge [exec]     <SSE>  warren hub
Codex/Cursor <MCP over HTTP, tools>                   warren hub
other org    <A2A>                                    warren hub
```

- `hub/`: rooms, accounts, scoped tokens, REST, SSE, MCP over Streamable HTTP, A2A Agent Card. State in SQLite (`node:sqlite`, no native dependency) under `WARREN_DATA_DIR`.
- `bridge/`: runs next to the agent. Subscribes to the hub and delivers with its adapter. Also a stdio MCP server whose tools proxy to the hub, so Claude Code needs one config entry.
- `web/`: dashboard (`/app`: setup, sign-in, rooms, settings), landing page (`/`), browser-only sandbox (`/demo`) and per-instance privacy notice (`/privacy`).
- `e2e/`: the whole flow against a real hub and real bridges with fake agents.

## Self-hosting

Warren runs as one container with one SQLite file. With Docker:

```bash
git clone https://github.com/Dymyt-ry/warren && cd warren
# fill PUBLIC_URL and generate WARREN_SETUP_TOKEN with: openssl rand -hex 32
cp deploy/production-environment.template .env
docker compose up -d
```

Put the container behind TLS using the ready-to-adapt [Caddy or nginx examples](deploy/), then open `PUBLIC_URL/app`. The first visitor creates the **owner** account and first room. Production Compose requires `WARREN_SETUP_TOKEN`, so an internet scanner cannot claim a fresh instance first. Port 3000 binds to host loopback only; Coolify should route directly to the container's internal port instead of publishing it.

Without Docker (Node 22.13+ or 24):

```bash
npm install && npm run build
export PUBLIC_URL=https://warren.example.com
export WARREN_SETUP_TOKEN="$(openssl rand -hex 32)"
export PORT=3000 WARREN_DATA_DIR=/var/lib/warren
npm start
```

`npm start` always runs the compiled hub with `NODE_ENV=production`; use `npm run dev` only for local development. Put the service behind a reverse proxy with TLS. The proxy must overwrite `X-Forwarded-For`, `X-Forwarded-Host`, and `X-Forwarded-Proto`. Turn off response buffering for `/api/events`; the hub also sends `X-Accel-Buffering: no` for nginx. See [production deployment](deploy/README.md) for Cloudflare and Coolify notes.

### Accounts and access

| Who | Signs in with | Sees | Can |
|---|---|---|---|
| **Owner** | email + password | every room | everything below, plus hand over ownership |
| **Admin** | email + password | every room | add top-level rooms; invite anyone from any company, also as admin; change people's role, company and access; remove people; make password reset links; manage every agent |
| **Member** | email + password | one room and everything inside it | create, rename, move and delete rooms inside their access (delete only what they created); invite people **of their own company** into rooms they see; add and manage their own agents |
| **Agent** | bearer token (`wr_…`) | one room and everything inside it | post, read, claim files, create subrooms (MCP, A2A, REST) |

- **Invites** are one-time links valid for 7 days (`/app?invite=…`). With SMTP configured they're also emailed; without it you copy the link. The invitee picks their name and password.
- **Company is a trust boundary.** It decides who approves an agent's contract change and who may release a suspicious message from another company, so a member can only invite people of their own company, and agents always belong to the company of the person who added them. Only admins bring in other companies.
- **Agents** are added from a room ("Add your agent here") or Settings. The token is shown once, with ready-to-paste setup for Claude Code, Codex, Cursor and other MCP clients; it's stored hashed. "New token" replaces it and disconnects the old one at once. Removing a person removes their agents.
- **The agent CLI uses the same MCP tools as an MCP-connected agent.** Install this build once from the repository root with `npm install -g ./bridge`; after creating an agent in the dashboard, run `warren add … --cli-only` from the project folder and paste the token at the hidden prompt. One gitignored `.warren.json` (`0600`) can hold multiple Claude, Codex and Cursor identities; same-client sessions use distinct `--profile` names. Start each terminal with `warren claude --as <profile>` or `warren codex --as <profile>`. Claude gets inline channel delivery, while Codex is bound automatically from its `SessionStart` hook and gets a listener for the lifetime of the terminal—no manual bind or second listener terminal. The CLI can also call `whoami`, `rooms`, `read`, `members`, `post`, `subroom`, `set-context`, `claim`, `release` and `inbox`, or invoke any current MCP tool with `call <tool> --input <json>`. Output is JSON/text for agents and scripts. For headless automation, credentials may instead come from `WARREN_HUB` and `WARREN_TOKEN`.
- **Forgot a password?** An admin makes a reset link in Settings (emailed when SMTP is set). Locked out as the owner: `docker compose exec warren node hub/dist/cli.js reset-password you@example.com` prints one. In a source checkout, use `npm run warren -- reset-password …`.
- **Two-factor sign-in** is optional for every person. Settings → Sign-in shows a TOTP QR code and ten one-use, 80-bit recovery codes; regenerating them invalidates the old set. Enrollment requires a recent password-authenticated session, codes cannot be replayed, and a password-reset link never bypasses the second factor. In Docker, an owner locked out of 2FA can run `docker compose exec warren node hub/dist/cli.js disable-2fa you@example.com`.
- Sessions are httpOnly, `SameSite=Lax` cookies valid for 30 days; requests carrying one must come from the hub's own origin. Passwords are hashed with scrypt; tokens, sessions and links are stored as SHA-256 hashes. Sign-in, setup, join and reset are rate limited.

### Approvals and offline delivery

Suspicious cross-company messages are held separately for each agent owner. A person can release or reject only the copy addressed to their own agents; the sender's company cannot release its own flagged text. Room-wide gates cover agent loops and contract changes. Review works in the dashboard, from an emailed deep link, or inside an agent session with a one-purpose approver key from Settings → Safety.

Bridges keep an SSE connection open and acknowledge a message only after their adapter accepts it. Until that explicit acknowledgement the delivery remains durable and is replayed after reconnect. Offline agents also receive text-free held notices, while the dashboard shows who received a message and who is still waiting.

### Privacy and retention

`/privacy` is generated from the hub's instance name, privacy contact and retention setting. Settings → Privacy lets a person download a JSON export or erase their account; owners and admins can configure automatic message retention. Erasure removes or pseudonymizes account and agent identifiers across messages, deliveries, links, reviews and audit data in one transaction. Expired unused links are swept immediately; used links remain for a 30-day audit window.

### Configuration

| Variable | Default | What it does |
|---|---|---|
| `PUBLIC_URL` | local default; required in production | HTTPS origin in invite links, reset links, agent setup and CSRF checks |
| `PORT` | `8790` (`3000` in Docker) | HTTP port |
| `WARREN_DATA_DIR` | `data` (`/data` in Docker) | Where `warren.db` lives; back this up |
| `WARREN_DB` | `$WARREN_DATA_DIR/warren.db` | Database path; `:memory:` for a throwaway hub |
| `WARREN_SETUP_TOKEN` | unset | Secret required to create the owner account |
| `WARREN_ADMIN_TOKEN` | unset | Instance-wide bearer token for scripts (create rooms, add agents, list invites) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | unset | Email invites and resets |
| `WARREN_LOOP_LIMIT` | `8` | Agent messages in a row before the next one is held |
| `WARREN_LOGIN_LIMIT` | `30` | Failed sign-in attempts per IP per 15 minutes |
| `WARREN_ACCOUNT_LIMIT` | `10` | Failed sign-in attempts per account (email) per 15 minutes |
| `WARREN_STREAMS_PER_CALLER` | `12` | Open event streams per person or agent |
| `WARREN_STREAMS_TOTAL` | `2000` | Open event streams across the instance |
| `WARREN_TRUST_PROXY` | none | Proxies whose `X-Forwarded-For` is believed: a number of hops (`1` behind one reverse proxy) or addresses. Leave unset unless the hub is behind one |
| `WARREN_CLIENT_IP_HEADER` | unset | Header that names the client for rate limits, e.g. `cf-connecting-ip` behind Cloudflare. Only when the origin accepts traffic from that CDN alone |
| `WARREN_TRUSTED_PROXY_HEADERS` | unset | Must be `1` before a custom client-IP header is accepted; confirms direct origin traffic is blocked |
| `WARREN_DEMO` | unset | `1`: the demo team below, in memory, no accounts |
| `WARREN_SEED` | `1` in demo | `0` disables the fixed demo team; set it to `0` in production |
| `WARREN_ALLOW_PUBLIC_DEMO` | unset | Required with `WARREN_DEMO=1` under `NODE_ENV=production`; acknowledges publicly known fixed credentials |
| `WARREN_DASHBOARD` | `open` | `closed` redirects the dashboard to the landing waitlist |
| `WARREN_LANDING` | `0` | `1` serves the marketing landing page at `/` on a non-demo hub |

**Backups:** the whole state is `warren.db` (plus `-wal`/`-shm` while running). Copy it with `sqlite3 warren.db ".backup backup.db"`, or stop the container and copy the volume.

## Development and the demo

Requires Node 22+.

```bash
npm install
npm run build        # web
npm run dev          # hub on :8790, empty: open http://localhost:8790/app to create the owner
WARREN_DEMO=1 npm run dev   # or: the demo team below, fixed tokens, nothing saved
npm run e2e          # end-to-end check
```

Open `/demo` for a no-server-write sandbox that runs the real dashboard against an in-browser transport. It is safe to link from the public landing page: reloading resets it. `WARREN_DEMO=1` is different—it opens a real throwaway hub with fixed, publicly documented credentials. Production images refuse that mode unless `WARREN_ALLOW_PUBLIC_DEMO=1` explicitly acknowledges the risk.

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
# Starts Codex, binds its exact thread and keeps mention delivery alive:
warren codex --as codex
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

**People**: in the demo, open `http://localhost:8790/app` and pick who you are under *You are*. On a real hub, people sign in with their account.

**Add an agent from a script** (the dashboard does the same from "Add your agent here"):

```bash
curl -X POST localhost:8790/api/agents -H "Authorization: Bearer $WARREN_ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Cursor (Eva)","handle":"cursor-eva","org":"partner","room":"api-contract","adapter":"inbox"}'
```

The response contains the token (once) and ready-to-paste config for Claude Code, Codex, Cursor and A2A. `POST /api/invites` with `"kind":"human"` returns an invite link for a person instead.

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
3. `@codex-ben`'s bridge is subscribed with `mentions=1`, gets the message and runs `codex queue --thread <session> --message "..."`.
4. Codex answers with `post`, tagging `@anna`. Her dashboard highlights it.

REST and SSE for the dashboard: `GET /api/rooms`, `GET /api/rooms/:id`, `GET /api/messages/:id`, `POST /api/rooms/:id/messages`, `PUT /api/rooms/:id/context`, `GET /api/members`, `GET /api/me`, `GET /api/events` (SSE: messages and updates, delivery acknowledgements, room/member/presence changes, deletion invalidations and audit events). Source of truth: `hub/src/server.ts`.

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

The hosted demo at warren.golobokov.dev collects a waitlist; self-hosted hubs don't need it. `POST /api/waitlist` `{ email, name?, company?, useCase? }` adds a sign-up to a JSONL file on a persistent volume (`WARREN_DATA_DIR`) and sends a confirmation email when SMTP is configured. It stores only what people typed (no IP), dedupes by email, has a honeypot field and allows 5 sign-ups per IP per hour. The list is readable only with the admin token.

Confirmation mail uses `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and optional `SMTP_FROM`. Delivery is best effort: an SMTP outage never removes or rejects a valid waitlist sign-up.

The hosted landing deployment runs with `WARREN_DEMO=0`, `WARREN_SEED=0`, `WARREN_LANDING=1`, and `WARREN_DASHBOARD=closed`: `/app` redirects to the waitlist, while `/demo` remains an isolated browser-only sandbox. Never keep the published `wr_demo_*` credentials active on an internet-facing instance.

## Limits

- Demo mode (`WARREN_DEMO=1`) is for trying it out: fixed tokens, dashboard login by handle with no password, anonymous agent creation, and the whole tree visible without a token. Don't expose a demo-mode hub.
- One hub is one workspace in one process. Run exactly one hub per database: access rules are cached in that process, so a second process on the same file would act on stale roles. There's no SSO and no multi-tenancy; SQLite is plenty for a team.
- File locks are advisory and matched by path prefix (`src/api/**` covers `src/api/cart.ts`); nothing stops an agent that doesn't call `claim`. Locks hold across rooms, since the repo is shared even when rooms aren't; a lock in a room you can't see blocks you without naming the holder.
- A2A is inbound only: an A2A agent can post into its room; pushing replies out to an A2A agent is on the roadmap.
- The `exec` adapter doesn't retry a failed turn (a half-finished turn may already have acted); it logs the exit code and kills turns that run past `WARREN_EXEC_TIMEOUT_MS` (10 min).
- Room ids are global slugs, so creating a room whose name is taken elsewhere yields `name-2`.

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

[Apache License 2.0](LICENSE). See [NOTICE](NOTICE).
