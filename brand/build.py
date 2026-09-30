"""Regenerates brand/kit from one mark definition. Run: python3 brand/build.py"""
from pathlib import Path

OUT = Path(__file__).parent / "kit"
L = dict(blue="#0A72E6", coral="#F9505A", sun="#FFC400")  # on light backgrounds
D = dict(blue="#3D9BFF", coral="#FF6B73", sun="#FFD23F")  # on dark backgrounds
INK, PAPER = "#0E1116", "#FAFAF9"


def mark(c1, c2, c3):
    # "Subroom": rooms inside rooms, stacked toward one corner, the innermost lit.
    return (f'<rect x="26" y="26" width="204" height="204" rx="58" fill="none" stroke="{c1}" stroke-width="20"/>'
            f'<rect x="78" y="78" width="120" height="120" rx="34" fill="none" stroke="{c2}" stroke-width="20"/>'
            f'<rect x="128" y="128" width="50" height="50" rx="15" fill="{c3}"/>')


def svg(inner, vb="0 0 256 256"):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{vb}" role="img" aria-label="Warren">'
            f'<title>Warren</title>{inner}</svg>\n')


def word(fill, x=300, y=176, size=148, anchor="start"):
    return (f'<text x="{x}" y="{y}" text-anchor="{anchor}" font-family="Inter, -apple-system, \'SF Pro Display\', sans-serif" '
            f'font-weight="650" font-size="{size}" letter-spacing="{-size/25:.1f}" fill="{fill}">warren</text>')


light, dark = mark(*L.values()), mark(*D.values())
files = {
    "warren-mark.svg": svg(light),
    "warren-mark-dark.svg": svg(dark),
    "warren-mark-ink.svg": svg(mark(INK, INK, INK)),
    "warren-mark-paper.svg": svg(mark(PAPER, PAPER, PAPER)),
    "warren-app-icon.svg": svg(f'<rect width="256" height="256" rx="56" fill="{INK}"/>'
                               f'<g transform="translate(128 128) scale(0.74) translate(-128 -128)">{dark}</g>'),
    "warren-lockup.svg": svg(light + word(INK), "0 0 860 256"),
    "warren-lockup-dark.svg": svg(dark + word(PAPER), "0 0 860 256"),
    "warren-stacked.svg": svg(f'<g transform="translate(152 0)">{light}</g>' + word(INK, 280, 372, 112, "middle"),
                              "0 0 560 400"),
}
for name, content in files.items():
    (OUT / name).write_text(content)
(OUT / "web" / "favicon.svg").write_text(files["warren-app-icon.svg"])
print("wrote", len(files) + 1, "files")
