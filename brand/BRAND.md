# warren brand

> **Locked 2026-09-30.** Mark, colours and type are final for the hackathon. Don't change them without asking Tim.

**Mark: "Subroom".** Rooms inside rooms, stacked toward one corner, the innermost one lit: the branch an agent works in, where a message just landed. Geometry and colours live in `brand/build.py`; edit there and re-run it.

## Files (`brand/kit/`)

| File | Use |
|---|---|
| `warren-mark.svg` | Mark on light backgrounds |
| `warren-mark-dark.svg` | Mark on dark backgrounds (lifted colours) |
| `warren-mark-ink.svg` / `-paper.svg` | One-colour, when colour is not available |
| `warren-lockup.svg` / `-dark.svg` | Mark + wordmark, horizontal |
| `warren-stacked.svg` | Mark over wordmark |
| `warren-app-icon.svg` | App icon / favicon master (mark on an ink tile) |
| `web/` | favicon.ico, favicon.svg, apple-touch-icon, 192/512 icons, manifest |
| `tokens.css` | Colours and fonts for light and dark, used by `web/` |

## Colour

| Token | Light | Dark | Meaning |
|---|---|---|---|
| `--blue` | `#0A72E6` | `#3D9BFF` | primary: links, buttons, focus, outer room |
| `--coral` | `#F9505A` | `#FF6B73` | `contract_change`, warnings, inner room |
| `--sun` | `#FFC400` | `#FFD23F` | the lit room: @mentions, new messages |
| `--text` / `--bg` | `#0E1116` / `#FAFAF9` | `#F2F3F5` / `#0E1116` | ink and paper |

Colour carries meaning: yellow means "this is for you", coral means "something you depend on changed". Don't use them as decoration.

## Type

Outfit (OFL) for headings and the wordmark, weight 500 to 600, tracking -0.03em. Inter (OFL) 400/500/600 for text and UI. Both self-hosted via Fontsource in `web/`. Display face added 2026-09-30 with Tim's approval after a Hallmark audit flagged Inter-only as a generated-UI tell. Fallback: the system font (SF Pro on Apple devices). JetBrains Mono / SF Mono for code and room context.

## Rules

- Clear space around the mark: the width of the lit room (50/256 of the mark).
- Minimum size: 16 px (favicon), lockup 96 px wide.
- On dark backgrounds use the `-dark` files; never put the light mark on ink.
- Don't recolour the rooms, rotate or mirror the mark (the lit room sits bottom-right).

## Open items

- The wordmark in the lockup SVGs is live text in Inter; convert to outlines before print use.
- Strokes are not expanded to outlines yet (fine for web, expand for print or cutting).
- Trademark clearance not checked.
