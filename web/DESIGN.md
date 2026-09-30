# Warren web: design system

Hallmark genre modern-minimal, tone austere. Landing macrostructure: Map / Diagram. Nav N9 edge-aligned minimal. Footer Ft5 statement.
Brand (logo, colours) is locked in `brand/`. Display face added 2026-09-30 with Tim's approval.

## Reference lock

- **Primary direction:** Apple-austere product page. Hierarchy from type and space, never from boxes or dividers.
- **Preserve:** light paper canvas by default (dark follows the system); Outfit display over Inter text; blue is the only interactive colour; sun means "addressed to you" and nothing else; coral means "a contract changed" and nothing else.
- **Borrow only:** real product UI states inside the diagram, not screenshots; people and their machines as the nodes of the map.
- **Memorable move:** the logo is the map. The landing hero is the team drawn in the logo's geometry: nested rounded rooms, people as circles, agents as rounded squares. A message travels from Codex to Claude and Claude's node lights up like the logo's inner room.
- **Reject:** cards as grouping, pills, robot icons, border-top section rhythm, 1-2-3-4 step templates, dark-by-default, one-word headline accents.

## Tokens

| Role | Light | Dark |
|---|---|---|
| Canvas | paper `#FAFAF9` | ink `#0E1116` |
| Text | ink `#0E1116` | `#F2F3F5` |
| Quiet text | `#5B616E` | `#9BA3B1` |
| Interactive | blue `#0A72E6` | `#3D9BFF` |
| Contract change | coral `#F9505A` | `#FF6B73` |
| For you (lit) | sun `#FFC400` | `#FFD23F` |

Type: Outfit 500/600 for display and the wordmark (tracking -0.03em), Inter 400/500/600 for text and UI, JetBrains Mono only for code and room context.
Shapes: people are circles; agents and rooms are rounded squares (radius about 28% of the side, like the mark). Controls 10px radius. No pills.

## Decision ledger

| Decision | Source | Why |
|---|---|---|
| Light canvas default | Refero anti-slop (#3), Tim: Apple clean | Dark-by-default reads generated |
| Outfit + Inter | ui-ux-pro-max pairing "Geometric Modern", Hallmark audit (Inter everywhere) | Rounded geometry rhymes with the mark; Inter stays for UI legibility |
| Hero = team map in logo geometry | Hallmark Map / Diagram, Tailscale (people + machines), brand mark | Shows what Warren is in one picture |
| Real message components in the map | Linear (real UI in hero) | Proof the product exists, not a render |
| No cards, sections separated by space | Things, Refero anti-slop (#2) | Austere tone |
| Status as small square glyph + word | Linear status glyphs, brand room glyph | Replaces pills |
