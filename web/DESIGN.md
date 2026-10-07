# Warren web: design system

Hallmark genre modern-minimal, tone austere. Landing macrostructure: Workbench (was Map / Diagram until Tim's review, see below). Nav N5 floating bar. Footer Ft2 inline single line. The landing is pinned to light (`data-theme="light"`); the dashboard follows the system.
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

## Revision 2026-09-30: landing speaks the dashboard's language

Tim's review: the team map (thick coloured room outlines, big sun circles, heavy rounded headline) read as "Duolingo"; the dashboard is the bar. Studied DNA from his two references (image mode):

- **Multiplayer cursors around the hero:** people and agents of the demo team (Anna, Ben, Claude Code, Codex) drift slowly around the headline. Initials and agent avatars, never stock photos.
- **Workbench showcase:** a still of the real dashboard, built from the same shadcn components, in a white hairline frame with a soft shadow, sitting on a pale blue rounded backdrop and fading out at the bottom.
- **One floating card:** Claude Code's run, four steps that spin and check off when the showcase comes into view, joined by a dotted connector to the action it ends in ("Ben gets the reply").
- **Rejected from the first pass:** 3px coloured outlines, large colour fills, Outfit at 600 with -0.04em tracking (now 500, -0.025em).

## Revision 2026-10-05: conversation-first application shell

Research: Slack's current desktop navigation, simplified layout documentation, sidebar preferences, and settings patterns. Warren keeps its own neutral brand tokens and agent-specific concepts; the reference is used for hierarchy and interaction placement, not visual cloning.

### Reference lock

- **Primary direction:** Slack's conversation-first desktop shell: compact sidebar, one restrained conversation toolbar, message stream, composer, optional details rail.
- **Preserve:** Warren's room tree, sun/coral semantic colours, person/agent shapes, Outfit only for page-level headings, Inter for dense product UI.
- **Borrow only:** settings categories in a vertical rail; member count as the details entry point; secondary room actions behind one menu; composer controls inside one bordered writing surface.
- **Reject:** permanent room-context toolbar, permanent right rail, four equally prominent message-kind tabs, duplicated live-status copy, decorative Slack purple.
- **Token commitments:** neutral tinted sidebar; 58px conversation toolbar; 320px on-demand details rail; 10-12px control radii; blue remains interactive-only.

### Decision ledger

| Decision | Source | Role | Why |
|---|---|---|---|
| On-demand room details | Slack channel details + user request | Secondary context | Keeps the thread dominant and returns width when context is not needed |
| One overflow menu in the room header | Slack conversation toolbar | Secondary actions | Removes four competing header controls without deleting capability |
| Message type as a compact composer select | User screenshots + Slack composer hierarchy | Message metadata | Preserves Warren's typed messages without a persistent segmented bar |
| Vertical settings navigation | Slack Preferences | Settings information architecture | Scans faster and scales to seven categories |
| Presence dot in the account row | Slack sidebar | Connection status | Communicates live state without a detached text row |
