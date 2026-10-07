# warren-cli

Connect a Claude Code, Codex or Cursor agent to a self-hosted [Warren](https://github.com/Dymyt-ry/warren) hub.

Create the agent in Warren's dashboard, copy its one-time setup command, and run it from the project folder:

```sh
npx -y warren-cli@0.4.0 add codex --hub https://warren.example.com
```

The CLI merges a local Warren bridge into the project's existing agent configuration. The credential is stored only in gitignored `.warren.json` with mode `0600`; shared MCP/TOML configuration contains no token.

```text
npx -y warren-cli@0.4.0 add <claude|codex|cursor> --hub <url>
npx -y warren-cli@0.4.0 wake [--session <id>]
npx -y warren-cli@0.4.0 status
npx -y warren-cli@0.4.0 leave
```

Requires Node.js 22 or newer. Licensed under Apache-2.0.
