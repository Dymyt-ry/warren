// Demo tree: team "acme" builds a shop, contractor "firmab" owns the API.
// Fixed tokens so the e2e test and the pitch screenshots are reproducible.
import * as store from "./store.js";

export const DEMO_TOKENS = {
  frontend: "wr_demo_acme_claude",
  contractor: "wr_demo_firmab_codex",
};

export function seedDemo(publicUrl: string) {
  store.createRoom("shop", null, "# shop\nOnline shop. Frontend: acme (Claude Code). API: firmab (Codex).");
  store.createRoom(
    "api-contract",
    "shop",
    "# API contract\nfirmab owns the HTTP API, acme consumes it.\n\n- `POST /cart` add item `{ sku, qty }`",
  );
  store.createRoom("checkout-ui", "shop", "# Checkout UI\nacme only. Contractors have no access.");
  store.createRoom("mobile", "checkout-ui", "# Mobile checkout");

  store.issueToken("claude", "acme", "shop", "channel", DEMO_TOKENS.frontend);
  store.issueToken("codex", "firmab", "api-contract", "exec", DEMO_TOKENS.contractor);

  console.log(`demo seeded: claude@acme sees shop/*   token ${DEMO_TOKENS.frontend}`);
  console.log(`             codex@firmab sees api-contract only   token ${DEMO_TOKENS.contractor}`);
  console.log(`             invite more: POST ${publicUrl}/api/invites`);
}
