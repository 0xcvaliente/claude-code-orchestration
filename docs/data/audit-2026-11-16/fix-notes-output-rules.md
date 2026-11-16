# Fix notes: output rules (O-1, O-2, O-3) and the test-gate doubt signal

Slice `fix-output-rules`. Source finding: `docs/data/audit-2026-11-16/output-tokens.md` (O-1, O-2, O-3).

## Changes
- `.claude/agents/orchestrator.md` (body only; 3,860 -> 4,095 words):
  - step 0: the path line points at the new section ("State the path on the first line of your reply (Output to the person).");
  - step 2: the full plan goes only into the PLAN REVIEW brief; the person sees its summary lines;
  - step 5, escalation: "a test gate that gave up on its latest attempt" joins the doubt signals;
  - step 7: the report uses the final-report form; replaced slices, skill drafts and evidence stay required, shorter;
  - new section, in full:

```markdown
## Output to the person
Write to the person in short bullets or key: value lines, never paragraphs; detail lives in the briefs, the orchestration pane and the run report.
- Path, first line: `Path: light|full - <reason, a few words>`.
- Plan, once: one line per slice, `<id>: <goal, a few words>`, plus `RISKY` when it is; then `Constraints: C1-C<n>` (ids only). The full plan with the constraint texts goes only into the PLAN REVIEW brief.
- Progress: one short line, only when something changed or when you end a turn to wait for workers (`waiting: s1 review, s3 build`). Asked for the status: one line per slice with its state.
- Question: a short numbered list, each item with its default.
- Final report of at most 15 lines: `Result: <n> passed, <n> failed`; one line per slice, `<id>: pass|fail - <evidence pointer>` (the command and its result in a few words, the file and section, or the source URL); then only the lines that apply: `replaced: <id> -> <ids>`, `reused: <ids>`, `draft: <name> on <branch>, publishing is a separate step`, `skill not created: <why>`, `sequential: <ids> - <why>`, `unverified: <ids>`; last `Open: <items>` or `Open: none`.
- More detail only when the person asks: the plan in full, gaps, logs, reasoning. A requested answer (step 2) is the deliverable and keeps its length.
```

- `.claude/skills/route/SKILL.md`: step 2's first sentence now gives `Route: <mode> - <reason, a few words>` on one line, short bullets or key: value lines, one-line progress only when something changed, a final report of at most 15 lines (plain and reviewed: what changed, the check and its result, what is open; orchestrate: `<id>: pass|fail - <evidence pointer>` per slice, then what is open), more detail only when asked. The escalation list names the test gate that gave up.
- `.claude/hooks/nudge.mjs`: one new `- output:` line with the same rule; the doubt-signal list names the test gate that gave up. Conditions, exits and silence unchanged.
- `src/contracts.test.ts`: three new tests (output rule in all three texts; full plan only in the PLAN REVIEW brief; the new doubt signal in each doubt-signal list). Red before the text changes (24 pass, 3 fail), green after (27 pass).

## Visible effect for a person
- First line `Path: full - <reason>` (or `Route: orchestrate - <reason>`), a one-line-per-slice plan, one-line progress notes, a final report of at most 15 lines with a pointer to the evidence per slice. Full plan, gaps and logs on request.
- A slice whose test gate gave up now gets an opus review before it is accepted (as the gate already required).

## Docs to update (not owned by this slice)
- `README.md`: where it describes what the orchestrator writes (path line, plan, report) and the doubt-signal list ("The gates").
- `docs/native-mode.md`: the orchestrator's report and path statement; doubt signals if listed.
- `.claude/rules/agents.md`: the review-gate bullet's "Doubt signals:" list; add the output rule to the three-places rule.
- `CLAUDE.md`: no doubt-signal list or output rule today; add a short mention under the 1.4.6 notes if wanted.
- `dist/plugin`: rebuild (`npm run build-plugin`) in a later step.
