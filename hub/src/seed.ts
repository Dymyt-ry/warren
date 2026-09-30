// Demo team: "acme" builds a shop (two people, their agents), contractor
// "firmab" owns the API and is invited into api-contract only.
// Fixed tokens so the e2e test and the pitch screenshots are reproducible.
import * as store from "./store.js";

export const DEMO_TOKENS = {
  frontend: "wr_demo_acme_claude", // claude-anna, Claude Code, channel push
  contractor: "wr_demo_firmab_codex", // codex-ben, Codex, exec wake-up
  cursor: "wr_demo_acme_cursor", // cursor-marek, Cursor, inbox
  anna: "wr_demo_anna",
  marek: "wr_demo_marek",
  ben: "wr_demo_ben",
};

export function seedDemo(publicUrl: string) {
  store.createRoom(
    "shop",
    null,
    "# shop\nOnline shop. Frontend: acme (Claude Code, Cursor). API: firmab (Codex).\n\n" +
      "Post a `contract_change` and tag `@room` whenever you change something others depend on.",
  );
  store.createRoom(
    "api-contract",
    "shop",
    "# API contract\nfirmab owns the HTTP API, acme consumes it.\n\n- `POST /cart` add item `{ sku, qty }` -> `201 { cartId }`",
  );
  store.createRoom("checkout-ui", "shop", "# Checkout UI\nacme only. Contractors have no access.");
  store.createRoom("mobile", "checkout-ui", "# Mobile checkout\nResponsive checkout, owned by cursor-marek.");

  const add = (handle: string, name: string, kind: store.MemberKind, org: string, scope: string, adapter: store.Adapter, token: string) =>
    store.addMember({ handle, name, kind, org, scopeRoomId: scope, adapter, token });

  add("anna", "Anna", "human", "acme", "shop", "dashboard", DEMO_TOKENS.anna);
  add("marek", "Marek", "human", "acme", "shop", "dashboard", DEMO_TOKENS.marek);
  add("claude-anna", "Claude Code (Anna)", "agent", "acme", "shop", "channel", DEMO_TOKENS.frontend);
  add("cursor-marek", "Cursor (Marek)", "agent", "acme", "checkout-ui", "inbox", DEMO_TOKENS.cursor);
  add("ben", "Ben", "human", "firmab", "api-contract", "dashboard", DEMO_TOKENS.ben);
  add("codex-ben", "Codex (Ben)", "agent", "firmab", "api-contract", "exec", DEMO_TOKENS.contractor);

  console.log(`demo seeded (${store.allMembers().length} members):`);
  for (const m of store.allMembers())
    console.log(`  @${m.handle.padEnd(13)} ${m.kind.padEnd(6)} ${m.org.padEnd(7)} sees ${m.scopeRoomId}/*  token ${m.token}`);
  console.log(`  invite more: POST ${publicUrl}/api/invites`);
}
