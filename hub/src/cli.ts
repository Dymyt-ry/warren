// Maintenance commands for a self-hosted hub, run next to its database:
//
//   npm run warren -- reset-password <email>   one-time link to set a new password
//   npm run warren -- users                     everyone with an account
//
// In Docker: docker compose exec warren npm run warren -- reset-password you@example.com
import * as store from "./store.js";

const PUBLIC_URL = (process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 8790}`).replace(/\/$/, "");
const [command, arg] = process.argv.slice(2);

switch (command) {
  case "reset-password": {
    const m = arg ? store.memberByEmail(arg) : undefined;
    if (!m) {
      console.error(arg ? `nobody signs in with ${arg}` : "usage: reset-password <email>");
      process.exit(1);
    }
    const { link, code } = store.createLink(
      { purpose: "reset", email: m.email, org: null, scopeRoomId: null, role: null, handle: m.handle, createdBy: null },
      1,
    );
    console.log(`Set a new password for @${m.handle} (valid until ${link.expiresAt}):\n${PUBLIC_URL}/app?reset=${code}`);
    break;
  }
  case "users":
    for (const m of store.allMembers().filter((x) => x.kind === "human"))
      console.log(`@${m.handle.padEnd(16)} ${String(m.role).padEnd(7)} ${m.org.padEnd(16)} ${m.email ?? "-"}  sees ${m.scopeRoomId ?? "every room"}`);
    break;
  default:
    console.error("commands: reset-password <email>, users");
    process.exit(1);
}
