#!/usr/bin/env python3
"""Build the README diagrams as light and dark SVGs.

Edit the *.scene.json files (positions are explicit) or the sequence below, then run:

    python3 docs/diagrams/build.py

Scenes render with the diagram-craft skill's renderer (DIAGRAM_CRAFT, default
~/.claude/skills/diagram-craft). The README shows <name>-light.svg or
<name>-dark.svg through <picture>, matching the reader's GitHub theme.
"""
import json
import os
import sys
from html import escape
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = Path(os.environ.get("DIAGRAM_CRAFT", Path.home() / ".claude/skills/diagram-craft"))
sys.path.insert(0, str(SKILL / "scripts"))
import diagram  # noqa: E402

# GitHub's own light and dark page colours, so the figures sit on the page without a frame.
PALETTES = {
    "light": dict(paper="#ffffff", surface="#f6f8fa", ink="#1f2328", muted="#59636e",
                  rule="#818b98", edge="#59636e", accent="#0969da", accent_surface="#ddf4ff"),
    "dark": dict(paper="#0d1117", surface="#151b23", ink="#f0f6fc", muted="#9198a1",
                 rule="#656c76", edge="#9198a1", accent="#4493f8", accent_surface="#0f2a4a"),
}
SCENES = ["routes", "pipeline", "slice-lifecycle", "triage"]


def sequence_svg(theme):
    """Native sequence notation: the scene renderer has no lifelines or alt frames."""
    c = PALETTES[theme]
    p = f"gates-{theme}"
    W, H = 900, 584
    xs = dict(o=90, i=270, v=450, r=630, g=810)
    out = []
    add = out.append

    def text(x, y, value, size=13, weight=400, color=None, anchor="middle", mono=False):
        family = ' font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"' if mono else ""
        add(f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{color or c["ink"]}" text-anchor="{anchor}"{family}>{escape(value)}</text>')

    def guard(x, y, value):
        """An operand guard. In a wide font a guard can be longer than the space between two lifelines, so, like a
        message label, it sits on a paper-coloured chip sized for a wide font (8.6 px a character plus padding): the
        lifeline it crosses is hidden behind the text, never drawn through it. It stays inside the alt frame."""
        add(f'<rect x="{x - 4}" y="{y - 13}" width="{8.6 * len(value) + 16:.1f}" height="17" rx="3" fill="{c["paper"]}"/>')
        text(x, y, value, 12, 600, c["muted"], "start")

    def message(a, b, y, value, reply=False):
        x1, x2 = xs[a], xs[b]
        x2 += -2 if x2 > x1 else 2
        dash = ' stroke-dasharray="7 5"' if reply else ""
        marker = "open" if reply else "filled"
        add(f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="{c["edge"]}" stroke-width="2" marker-end="url(#{p}-{marker})"{dash}/>')
        mid, w = (xs[a] + xs[b]) / 2, len(value) * 13 * 0.6 + 14
        add(f'<rect x="{mid - w / 2:.1f}" y="{y - 25}" width="{w:.1f}" height="19" rx="3" fill="{c["paper"]}"/>')
        text(mid, y - 11, value)

    add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="{p}-title {p}-desc" font-family="system-ui, -apple-system, Segoe UI, sans-serif">')
    add(f'<title id="{p}-title">Native gates: hooks that block an agent from finishing</title>')
    add(f'<desc id="{p}-desc">The orchestrator briefs an implementer. When the implementer tries to finish, verify.sh runs the tests unless there is no test runner or, in a git work tree, only prose changed: on failure it blocks the implementer with the test output; when they pass or are skipped, the report reaches the orchestrator. A reviewer returns STATUS pass or fail, and review-gate.mjs blocks the orchestrator\'s final reply until a reviewer has passed the last implementer.</desc>')
    add("<defs>")
    add(f'<marker id="{p}-filled" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto"><path d="M0 0 L12 6 L0 12 Z" fill="{c["edge"]}"/></marker>')
    add(f'<marker id="{p}-open" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto"><path d="M1 1 L11 6 L1 11" fill="none" stroke="{c["edge"]}" stroke-width="1.6"/></marker>')
    add("</defs>")
    add(f'<rect width="{W}" height="{H}" fill="{c["paper"]}"/>')

    # alt frame first, so lifelines and messages draw over it
    add(f'<rect x="30" y="192" width="480" height="156" rx="4" fill="none" stroke="{c["rule"]}" stroke-width="1.5"/>')
    add(f'<path d="M30 192 H78 V212 L70 220 H30 Z" fill="{c["accent_surface"]}" stroke="{c["rule"]}" stroke-width="1.5"/>')
    text(42, 210, "alt", 13, 700, c["accent"], "start")
    add(f'<line x1="30" y1="272" x2="510" y2="272" stroke="{c["rule"]}" stroke-width="1.5" stroke-dasharray="5 5"/>')

    for key, x in xs.items():
        add(f'<line x1="{x}" y1="84" x2="{x}" y2="544" stroke="{c["rule"]}" stroke-width="1.5" stroke-dasharray="4 6"/>')
    people = dict(o=("Orchestrator", None), i=("Implementer", None), v=("verify.sh", "SubagentStop hook"),
                  r=("Reviewer", None), g=("review-gate.mjs", "Stop hook"))
    for key, (name, sub) in people.items():
        x = xs[key]
        add(f'<rect x="{x - 80}" y="20" width="160" height="64" rx="6" fill="{c["surface"]}" stroke="{c["rule"]}" stroke-width="1.5"/>')
        if sub:
            text(x, 48, name, 14, 700, mono=True)
            text(x, 67, sub, 12, 400, c["muted"])
        else:
            text(x, 57, name, 15, 700)

    message("o", "i", 130, "brief: goal, files, check")
    message("i", "v", 172, "tries to finish")
    guard(102, 210, "[tests fail]")
    message("v", "i", 250, "blocked + test output", reply=True)
    guard(102, 292, "[tests pass or skipped]")
    message("v", "o", 328, "allowed", reply=True)
    message("o", "r", 388, "review the slice")
    message("r", "o", 430, "STATUS: pass or fail", reply=True)
    message("o", "g", 472, "final reply")
    message("g", "o", 514, "blocked until a reviewer passes the last implementer", reply=True)
    text(30, 572, "Solid arrow: call or event. Dashed arrow: reply or hook decision. Time runs down.", 12, 400, c["muted"], "start")
    add("</svg>")
    return "\n".join(out) + "\n"


def main():
    for name in SCENES:
        scene = json.loads((HERE / f"{name}.scene.json").read_text())
        for theme, tokens in PALETTES.items():
            themed = {**scene, "theme": theme, "tokens": tokens}
            errors = diagram.validate(themed)
            if errors:
                sys.exit(f"{name} ({theme}):\n" + "\n".join(errors))
            (HERE / f"{name}-{theme}.svg").write_text(diagram.render_svg(themed) + "\n")
    for theme in PALETTES:
        (HERE / f"gates-sequence-{theme}.svg").write_text(sequence_svg(theme))
    print("built", ", ".join(SCENES + ["gates-sequence"]), "(light and dark)")


if __name__ == "__main__":
    main()
