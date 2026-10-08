# Pitch deck: AI-slop audit

Test: `hallmark audit` (58 gates from the hallmark skill + a pre-emit self-critique on 6 axes, 1–5).
Codex was meant to give an independent second opinion but hit its usage limit (until 4 Oct), so this is a single reviewer's verdict.

| | v1 `v1-austere.html` | v2 `index.html` |
|---|---|---|
| Findings | **3 critical · 5 major · 4 minor** | **0 critical · 1 major · 4 minor** |
| Self-critique (Philosophy, Hierarchy, Execution, Specificity, Restraint, Variety) | P3 H4 E4 S2 R3 V2 | P4 H5 E4 S5 R4 V4 |
| Look | dark, Inter only | light, Outfit + Inter, like the web (`web/DESIGN.md`) |

## v1: findings

**Critical**
1. *Inter-everywhere / design-system drift.* Headings and the wordmark are Inter; the web has switched headings to Outfit since then (`web/DESIGN.md`, `brand/BRAND.md`). The deck and the web won't look like the same product.
2. *Full-viewport centred hero* (slide 1): logo, tagline and footer all sit on one centre axis. The most recognisable generated title slide.
3. *The 3-column step template* (slide 4): three equal dashed boxes, a dot label above each, arrows between them. `web/DESIGN.md` rejects "1-2-3-4 step templates" explicitly.

**Major**
4. *Default-attractor sameness:* slides 2–5 share one skeleton (mark top-left, headline, big box, number bottom-right). Nothing on them uses Warren's own shape (rooms inside rooms) apart from the logo.
5. *Colour as decoration:* yellow `@` on all five handles (slide 3) dilutes "yellow = for you"; the coral line "1 markdown file." is a one-phrase headline accent that the web rejects.
6. *Dark by default:* the web design system says a light canvas by default, because dark-by-default reads as generated.
7. *Re-drawn terminal* (slide 5): a dark panel with `$ npm run e2e` imitates a terminal, and its `#07090C` sits outside the tokens (gates 47, 48).
8. *Stagger fade-up* on slide 4: the universal "things float in" animation.

**Minor**
9. Mono used as a third voice (labels, handles, placeholders, footer, numbers, links); it belongs to code only.
10. Spacing off the scale (150, 56, 44, 22 px).
11. The number and wordmark in the same place on every slide (fine for a deck, just monotonous).
12. The `[team name]` chip is the only thing in the title slide's footer.

## v2: what changed

- Light paper, Outfit headings, Inter text, mono only for code (`PLAN.md`, `POST /cart`, e2e output). Tokens and the spacing scale are in `:root`.
- Slide 1: name bottom-left, the big mark top-right. Nothing centred.
- Slide 2: the problem as a picture: 5 people × 4 agents, all wired into one `PLAN.md` (coral = the problem). This replaces the PLAN.md screenshot placeholder.
- Slide 3: the team drawn as a room map in the logo's geometry (same as the landing hero): shop (blue) → checkout-ui, api-contract (coral) → Ben and Codex invited from outside. Yellow only on the one mention. This replaces the dashboard screenshot placeholder.
- Slide 4: the real exchange from the landing (`POST /cart` → `/basket`, Claude replies `@ben done`) rendered like the dashboard, playing out in order; next to it only the `[SCREENSHOT Claude Code]` placeholder. This replaces the Codex and dashboard screenshot placeholders.
- Slide 5: `19/19` as a real number (from `npm run e2e`), the output as plain text without a fake terminal.

## v2: what's left

**Major**
1. On slide 4 the empty `[SCREENSHOT Claude Code]` box is the biggest element on the slide. Once the real screenshot is in, it goes away; without it, the slide is lopsided.

**Minor**
2. The api-contract message is on both slide 3 and slide 4 (a deliberate zoom-in, but repetition).
3. The frame's bottom padding of 160 px is off the scale.
4. The logo colours in the SVG symbol are hexes rather than tokens (a locked brand asset; acceptable).
5. v2 departs from the plan in the Doc: 3 of the 5 screenshot placeholders are replaced with diagrams. If you want real screenshots, v1 has the slots.
