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
SCENES = ["routes", "pipeline", "slice-lifecycle", "triage", "worker-launch"]

GATES_TITLE = "Native gates: the hooks around each worker and the orchestrator's final reply"
GATES_DESC = (
    "The orchestrator sends the plan to a reviewer, then launches workers. plan-check.mjs (PreToolUse on Agent) blocks an "
    "implementer brief with missing lines, a file overlap, a dependency cycle, no plan review, a slice or file that is not in "
    "the plan, or an isolated launch whose worktree would not start from HEAD, and a built-in or fork agent while a run is "
    "open; it blocks the implementer of a stalled slice with replan_required. Otherwise it lets the launch through, and for "
    "this plugin's agents (never a built-in or fork) it may send one updatedInput: a haiku model is raised to sonnet (on by "
    "default), the read router raises a researcher's model for the tier of its SOURCES files (opt-in, never lower) and the "
    "skill hints append up to 3 suggested skills (1 for a reviewer, 2 for one on opus or above). researcher-guard.mjs denies "
    "a researcher's Bash command unless it is read-only, and egress-guard.mjs denies a reviewer's WebFetch to a host its brief "
    "and files do not name. When an implementer stops, verify.sh blocks it with the test output while the tests fail "
    "in the shared tree (in an isolated worktree it only warns by default; by default it marks failures that also fail on "
    "the base as probably pre-existing; an opt-in allow mode lets it finish when every failure also fails on the base; off "
    "skips the base run), and blocks a KIND: bugfix slice that has no test failing on the base. When a researcher reports, "
    "quote-check.mjs blocks it once for a quote not found in its source; in auto mode, at a worker's hand-back, "
    "handback-check.mjs sends a report back once when it has no STATUS line or a reviewer's pass leaves a checked id "
    "unanswered. review-gate.mjs (Stop) defers while agents run and blocks the final reply while an implementer has no later "
    "reviewer, the last review failed (a gap of 80 or more or a failed check; lower gaps pass with a doubt signal), an opus "
    "review is missing after a doubt signal, a checked constraint is unanswered, a stalled slice has no replan, or an "
    "implementer started and never stopped. The test and review gates and most plan checks let the work through after 2 "
    "blocks; file overlap and dependency cycle block every time, the guards deny every time, and quote-check and "
    "handback-check send a report back once."
)


def sequence_svg(theme):
    """Native sequence notation: the scene renderer has no lifelines or alt frames."""
    c = PALETTES[theme]
    p = f"gates-{theme}"
    W = 1320
    right = W - 20
    head_h = 92  # lane header height: the test lane names three hooks
    life_top = 20 + head_h
    keys = ["o", "p", "w", "v", "g", "r", "s"]
    xs = {k: 90 + 190 * i for i, k in enumerate(keys)}
    frames, body = [], []

    def text(x, y, value, size=13, weight=400, color=None, anchor="middle", mono=False, into=None):
        family = ' font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"' if mono else ""
        (body if into is None else into).append(
            f'<text x="{x}" y="{y}" font-size="{size}" font-weight="{weight}" fill="{color or c["ink"]}" text-anchor="{anchor}"{family}>{escape(value)}</text>')

    def guard(y, value, x=102):
        """An operand guard. In a wide font a guard can be longer than the space between two lifelines, so, like a
        message label, it sits on a paper-coloured chip sized for a wide font (8.6 px a character plus padding): the
        lifeline it crosses is hidden behind the text, never drawn through it. It stays inside the alt frame."""
        body.append(f'<rect x="{x - 4}" y="{y - 13}" width="{8.6 * len(value) + 16:.1f}" height="17" rx="3" fill="{c["paper"]}"/>')
        text(x, y, value, 12, 600, c["muted"], "start")

    def message(a, b, y, value, reply=False):
        x1, x2 = xs[a], xs[b]
        x2 += -2 if x2 > x1 else 2
        dash = ' stroke-dasharray="7 5"' if reply else ""
        marker = "open" if reply else "filled"
        body.append(f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" stroke="{c["edge"]}" stroke-width="2" marker-end="url(#{p}-{marker})"{dash}/>')
        mid, w = (xs[a] + xs[b]) / 2, len(value) * 13 * 0.6 + 14
        assert w <= abs(xs[b] - xs[a]) - 8, f"label too wide for its arrow: {value}"
        body.append(f'<rect x="{mid - w / 2:.1f}" y="{y - 25}" width="{w:.1f}" height="19" rx="3" fill="{c["paper"]}"/>')
        text(mid, y - 11, value)

    def alt(top, bottom, splits):
        frames.append(f'<rect x="30" y="{top}" width="{right - 30}" height="{bottom - top}" rx="4" fill="none" stroke="{c["rule"]}" stroke-width="1.5"/>')
        frames.append(f'<path d="M30 {top} H78 V{top + 20} L70 {top + 28} H30 Z" fill="{c["accent_surface"]}" stroke="{c["rule"]}" stroke-width="1.5"/>')
        text(42, top + 18, "alt", 13, 700, c["accent"], "start", into=frames)
        for split in splits:
            frames.append(f'<line x1="30" y1="{split}" x2="{right}" y2="{split}" stroke="{c["rule"]}" stroke-width="1.5" stroke-dasharray="5 5"/>')

    def note(x, top, lines):
        h = 18 * len(lines) + 14
        body.append(f'<rect x="{x}" y="{top}" width="{right - 12 - x}" height="{h}" rx="4" fill="{c["surface"]}" stroke="{c["rule"]}" stroke-width="1.2"/>')
        for i, line in enumerate(lines):
            text(x + 12, top + 22 + 18 * i, line, 12, 600 if i == 0 else 400, c["ink"] if i == 0 else c["muted"], "start")
        return h

    # Vertical rhythm, top to bottom: a message after a message is 42 px down (40 within a short exchange); an alt frame
    # opens 22 px below the message that starts it; a guard sits 24 px below the frame top or a split, its message 34 px
    # below the guard's last line, and the next split or the frame bottom 20 px below that message.
    y = life_top + 44

    def alt_block(operands):
        """Draw one alt frame at the cursor. operands: [(guard lines, (from, to, label))]. Returns the y after it."""
        nonlocal y
        top = y + 22
        y = top
        splits = []
        for i, (guards, (a, b, label)) in enumerate(operands):
            if i:
                splits.append(y)
            y += 24
            for j, g in enumerate(guards):
                guard(y, g)
                if j < len(guards) - 1:
                    y += 18
            y += 34
            message(a, b, y, label, reply=True)
            y += 20
        alt(top, y, splits)
        y += 40

    # Plan review and launch
    message("o", "r", y, "PLAN REVIEW: constraints and slices")
    y += 42
    message("r", "o", y, "STATUS: pass or fail, gaps", reply=True)
    y += 42
    message("o", "p", y, "launch worker: brief")
    top = y + 22
    y = top + 24
    guard(y, "[implementer brief: missing lines, file overlap, dependency cycle, no plan review,")
    y += 18
    guard(y, " slice or files not in the plan, or an isolated launch whose worktree would not start from HEAD;")
    y += 18
    guard(y, " or a built-in or fork agent while a run is open]")
    y += 34
    message("p", "o", y, "blocked: fix the plan", reply=True)
    y += 20
    split1 = y
    y += 24
    guard(y, "[implementer of a stalled slice: the same gap in two failed reviews in a row]")
    y += 34
    message("p", "o", y, "replan_required", reply=True)
    y += 20
    split2 = y
    y += 24
    guard(y, "[implementer allowed, or a researcher or reviewer (never blocked)]")
    y += 34
    message("p", "w", y, "allowed", reply=True)
    y += 16
    y += note(490, y, [
        "One updatedInput, only for this plugin's agents (never a built-in or fork):",
        "Haiku rule (on by default): any of the five agents asked to run on a haiku model runs on sonnet.",
        "Read router (opt-in): a researcher with SOURCES gets the model for its files' tier, raised, never lowered.",
        "Skill hints: up to 3 suggested skills found on disk (1 for a reviewer, 2 on opus), appended to the brief.",
    ]) + 14
    alt(top, y, [split1, split2])
    y += 40
    # Researcher's Bash
    message("w", "g", y, "researcher's Bash")
    y += 40
    message("g", "w", y, "denied unless read-only", reply=True)
    y += 44
    # Implementer stop: the test gate
    message("w", "v", y, "implementer stops")
    alt_block([
        (["[tests fail in the shared tree (an isolated worktree only warns by default)]"], ("v", "w", "blocked + test output")),
        (["[tests pass, but a KIND: bugfix slice has no test that fails on the base]"], ("v", "w", "blocked: repro test")),
        (["[tests pass or are skipped; or, in allow mode, every failing test also fails on the base]"], ("v", "o", "allowed: the report")),
    ])
    # Researcher report: the quote check and the hand-back check
    message("w", "v", y, "researcher reports")
    alt_block([
        (["[a QUOTE line is not found in its source (at the hand-back in auto mode, else at the stop)]"], ("v", "w", "blocked once")),
        (["[no STATUS line in the report (at the hand-back, auto mode)]"], ("v", "w", "sent back once")),
        (["[quotes found, or read from a scan or a URL]"], ("v", "o", "allowed: the report")),
    ])
    # Review
    message("o", "r", y, "review the slice")
    y += 42
    message("r", "g", y, "reviewer's WebFetch")
    y += 42
    message("g", "r", y, "unlisted host: denied", reply=True)
    y += 42
    message("r", "o", y, "STATUS, GAP lines with a confidence", reply=True)
    y += 42
    # Final reply: the review gate
    message("o", "s", y, "final reply")
    alt_block([
        (["[a subagent or workflow is still running]"], ("s", "o", "allowed for now: agents_running")),
        (["[no reviewer after the last implementer, the last review failed, no opus review after a doubt signal,",
          " a checked constraint left unanswered, a stalled slice without its replan, or an implementer that never stopped]"],
         ("s", "o", "blocked with the reason")),
        (["[every slice passed its latest review]"], ("s", "o", "allowed")),
    ])
    life_bottom = y - 20

    foot = [
        "Solid arrow: call or event. Dashed arrow: reply or hook decision. Time runs down.",
        "A review fails on a failed checked id or a gap of 80 or more; lower gaps pass with a doubt signal.",
        "In auto mode handback-check.mjs also sends a reviewer's report back once, before delivery, when its pass leaves a checked id unanswered.",
        "After 2 blocks the test gate, the review gate and most plan checks let the work through; overlap and cycle block every time, the guards always deny, quote-check blocks once.",
        "Test baseline: by default the block marks failures that also fail on the base as probably pre-existing; allow mode (opt-in) lets the implementer finish; off skips the base run.",
    ]
    foot_top = y + 8
    for i, line in enumerate(foot):
        text(30, foot_top + 22 * i, line, 12, 400, c["muted"], "start")
    H = foot_top + 22 * (len(foot) - 1) + 30

    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" role="img" aria-labelledby="{p}-title {p}-desc" font-family="system-ui, -apple-system, Segoe UI, sans-serif">',
        f'<title id="{p}-title">{escape(GATES_TITLE)}</title>',
        f'<desc id="{p}-desc">{escape(GATES_DESC)}</desc>',
        "<defs>",
        f'<marker id="{p}-filled" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto"><path d="M0 0 L12 6 L0 12 Z" fill="{c["edge"]}"/></marker>',
        f'<marker id="{p}-open" viewBox="0 0 12 12" refX="11" refY="6" markerWidth="10" markerHeight="10" orient="auto"><path d="M1 1 L11 6 L1 11" fill="none" stroke="{c["edge"]}" stroke-width="1.6"/></marker>',
        "</defs>",
        f'<rect width="{W}" height="{H}" fill="{c["paper"]}"/>',
    ]
    # alt frames first, so lifelines and messages draw over them
    out += frames
    for x in xs.values():
        out.append(f'<line x1="{x}" y1="{life_top}" x2="{x}" y2="{life_bottom}" stroke="{c["rule"]}" stroke-width="1.5" stroke-dasharray="4 6"/>')
    heads = dict(
        o=[("Orchestrator", "plain")],
        p=[("plan-check.mjs", "mono"), ("PreToolUse on Agent", "sub")],
        w=[("Worker", "plain"), ("implementer or researcher", "sub")],
        v=[("verify.sh", "mono"), ("quote-check.mjs", "mono"), ("handback-check.mjs", "mono"), ("stop and hand-back hooks", "sub")],
        g=[("researcher-guard.mjs", "mono"), ("egress-guard.mjs", "mono"), ("PreToolUse hooks", "sub")],
        r=[("Reviewer", "plain")],
        s=[("review-gate.mjs", "mono"), ("Stop hook", "sub")],
    )
    mid = 20 + head_h / 2
    for key, lines in heads.items():
        x = xs[key]
        out.append(f'<rect x="{x - 88}" y="20" width="176" height="{head_h}" rx="6" fill="{c["surface"]}" stroke="{c["rule"]}" stroke-width="1.5"/>')
        y = mid + 4 - 9 * (len(lines) - 1) + (2 if len(lines) == 1 else 0)
        for value, kind in lines:
            if kind == "plain":
                text(x, y, value, 15, 700, into=out)
            elif kind == "mono":
                text(x, y, value, 13, 700, mono=True, into=out)
            else:
                text(x, y, value, 12, 400, c["muted"], into=out)
            y += 18
    out += body
    out.append("</svg>")
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
