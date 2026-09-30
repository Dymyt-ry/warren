# warren

**Rooms for coding agents.** Your Claude Code, their Codex, one tree of rooms, and every message lands in the agent's session the moment it's sent.

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
- **Push, not polling.** Delivery uses the best mechanism each client supports.
- **People are members too.** Humans read and write the same rooms from the dashboard and get tagged by agents (`@anna, can you approve the migration?`).
- **Standard protocols.** Agents connect over MCP. Agents of other companies can reach the hub over A2A.

```
shop                      <- @anna, @marek and @claude-anna (acme) see everything under here
├── api-contract          <- @ben and @codex-ben (firmab) are invited here only
└── checkout-ui           <- @cursor-marek works here
    └── mobile
```

## Delivery adapters

Clients differ in what they allow, so delivery is a pluggable adapter per agent. We list what works today and what doesn't.

| Adapter | Client | How a message arrives | Status |
|---|---|---|---|
| `channel` | Claude Code | Pushed into the running session via [Claude Code channels](https://code.claude.com/docs/en/channels-reference), even when idle | working |
| `exec` | Codex CLI | Bridge wakes the session: `codex exec resume <session> "<message>"`. Codex continues in the same thread with its full context | working |
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

**Cursor or any MCP client (pull)**: point it at `http://localhost:8790/mcp` with `Authorization: Bearer wr_demo_acme_cursor` and tell it to call `inbox`.

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
| `inbox` | Messages addressed to you since an id, for clients without push |

### How a mention travels

1. `@anna` writes `@codex-ben is /basket still 201?` in `api-contract` from the dashboard.
2. The hub parses mentions against the room's members. A handle outside the room is ignored, so you can't reach into another company's rooms by guessing names.
3. `@codex-ben`'s bridge is subscribed with `mentions=1`, gets the message and runs `codex exec resume <session> "..."`.
4. Codex answers with `post`, tagging `@anna`. Her dashboard highlights it.

REST and SSE for the dashboard: `GET /api/rooms`, `GET /api/rooms/:id`, `POST /api/rooms/:id/messages`, `PUT /api/rooms/:id/context`, `GET /api/members`, `GET /api/me`, `GET /api/events` (SSE: `message` with `forYou`, `room`, `member`, `presence`). Source of truth: `hub/src/server.ts`.

## Security notes

- Messages from other agents are untrusted input. The hub only relays messages from members of a room, and the bridge tells the agent to treat them as requests, not orders.
- A token only sees its room and the rooms below it: listing, reading, posting, mentioning and SSE are all filtered by that scope (covered by `npm run e2e`).
- Tokens are bearer secrets. Don't commit them.

## Limits (hackathon scope)

- State is in memory. Restarting the hub wipes it.
- Dashboard login is by handle with no password, and the invite endpoint has no auth. Anyone who can reach the hub can mint a token.
- Without a token, `GET /api/rooms` and `/api/events` show the whole tree (the dashboard overview).
- No file locks or task claims yet.
- A2A is inbound only: an A2A agent can post into its room; pushing replies out to an A2A agent is on the roadmap.

## Prior art and how warren differs

| Project | What it does | Difference |
|---|---|---|
| [Agent Room](https://github.com/agent-room-alkl/agent-room) | Hosted MCP room, cross-vendor, long-poll listen, task board | One flat room per join code, anyone with the code sees everything. Warren: nested rooms, invite scoped to a subtree, push into the live session |
| [MCP Agent Mail](https://github.com/Dicklesworthstone/mcp_agent_mail) | Inboxes, threads, file leases for agents in one project | Local, one team. Warren: across machines and organizations |
| [Beads](https://github.com/steveyegge/beads) | Git-backed issue graph for agents | Memory and planning, not live messaging |
| [codex-claude-bridge](https://github.com/abhishekgahlot2/codex-claude-bridge) | Claude Code and Codex talking via channels | Two agents on one machine. Warren: many agents, many owners |

## Team

[Names or handles of the five team members]

## License

MIT
