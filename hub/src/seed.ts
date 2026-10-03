// Demo team: "acme" builds a shop (two people, their agents), contractor
// "firmab" owns the API and is invited into api-contract only.
// Fixed tokens so the e2e test and the pitch screenshots are reproducible.
import * as store from "./store.js";

export const DEMO_TOKENS = {
  frontend: "wr_demo_acme_claude", // claude-anna, Claude Code, channel push
  contractor: "wr_demo_firmab_codex", // codex-ben, Codex, exec wake-up
  cursor: "wr_demo_acme_cursor", // cursor-marek, Cursor, inbox
  benClaude: "wr_demo_firmab_claude", // claude-ben, Claude Code, channel push
  anna: "wr_demo_anna",
  marek: "wr_demo_marek",
  ben: "wr_demo_ben",
};

export function seedDemo(publicUrl: string) {
  if (store.allRooms().length) return; // a demo hub with WARREN_DB keeps what it has
  store.setInstanceName("acme x firmab (demo)");
  store.createRoom(
    "shop",
    null,
    "# shop\nOnline shop. Frontend: acme (Claude Code, Cursor). API: firmab (Codex).\n\n" +
      "Post a `contract_change` and tag `@room` whenever you change something others depend on.",
    null,
    true,
  );
  store.createRoom(
    "api-contract",
    "shop",
    "# API contract\nfirmab owns the HTTP API, acme consumes it.\n\n- `POST /cart` add item `{ sku, qty }` -> `201 { cartId }`",
    null,
    true,
  );
  store.createRoom("checkout-ui", "shop", "# Checkout UI\nacme only. Contractors have no access.", null, true);
  store.createRoom("mobile", "checkout-ui", "# Mobile checkout\nResponsive checkout, owned by cursor-marek.", null, true);

  const add = (
    handle: string,
    name: string,
    kind: store.MemberKind,
    org: string,
    scope: string,
    adapter: store.Adapter,
    token: string,
    extra: { role?: store.Role; owner?: string } = {},
  ) => {
    store.addMember({ handle, name, kind, org, scopeRoomId: scope, adapter, token, ...extra });
    console.log(`  @${handle.padEnd(13)} ${kind.padEnd(6)} ${org.padEnd(7)} sees ${scope}/*  token ${token}`);
  };

  console.log("demo team (WARREN_DEMO=1, nothing is saved):");
  add("anna", "Anna", "human", "acme", "shop", "dashboard", DEMO_TOKENS.anna, { role: "owner" });
  add("marek", "Marek", "human", "acme", "shop", "dashboard", DEMO_TOKENS.marek);
  add("claude-anna", "Claude Code (Anna)", "agent", "acme", "shop", "channel", DEMO_TOKENS.frontend, { owner: "anna" });
  add("cursor-marek", "Cursor (Marek)", "agent", "acme", "checkout-ui", "inbox", DEMO_TOKENS.cursor, { owner: "marek" });
  add("ben", "Ben", "human", "firmab", "api-contract", "dashboard", DEMO_TOKENS.ben);
  add("codex-ben", "Codex (Ben)", "agent", "firmab", "api-contract", "exec", DEMO_TOKENS.contractor, { owner: "ben" });
  add("claude-ben", "Claude Code (Ben)", "agent", "firmab", "api-contract", "channel", DEMO_TOKENS.benClaude, { owner: "ben" });
  console.log(`  add more agents: POST ${publicUrl}/api/agents`);
}
