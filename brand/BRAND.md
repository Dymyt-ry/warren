# warren brand

**Mark: "Lit room".** Rooms inside rooms, their doors lined up into a corridor that ends in the lit room: where a message just landed.

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

Inter (Google Fonts, OFL), weight 650 for the wordmark with tight tracking (-0.02em), 400/500 for UI. Fallback: the system font (SF Pro on Apple devices). JetBrains Mono / SF Mono for code and room context.

## Rules

- Clear space around the mark: the width of the lit room (44/256 of the mark).
- Minimum size: 16 px (favicon), lockup 96 px wide.
- On dark backgrounds use the `-dark` files; never put the light mark on ink.
- Don't recolour the rings, rotate the mark or close the doors.

## Open items

- The wordmark in the lockup SVGs is live text in Inter; convert to outlines before print use.
- Trademark clearance not checked.
