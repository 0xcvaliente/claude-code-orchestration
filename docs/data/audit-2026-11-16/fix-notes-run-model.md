# Fix notes: slice fix-run-model (G-1, G-2, G-8, T-9 fold side, G-4, G-11, G-13)

## G-1: a second plain PLAN REVIEW split a slice across two runs
- Changed: `.claude/hooks/brief.mjs` (`foldRuns`: carried slices, `carriedFinal` in `settle`), `dashboard/register.tsx` (run marks `carry`/`done`, `inRunOf`, `doneIn`, `runOpen`), `docs/brief-grammar.md` ("Carried slices"); tests in `src/review-gate-v2.test.mjs` (G-1 fold and Stop gate), `src/brief.test.mjs` (one pinned assertion changed to the new rule), `dashboard/register.test.tsx`.
- Rule (a little wider than the brief's): a re-planned slice moves whole into the new run when it is not final, has an implementer launch or stop, and its latest review after that does not count as a fail (an unreviewed attempt, and also a pass waiting for its opus review or a reply with no STATUS, which split the same way). Final and passed: final in the new run until an implementer of it works there (a launch, or a stop record: a SendMessage resume makes no launch; review fix). The pane keeps a done slice's agents so a resume finds its record, and counts a record that ended in the run as in it. Latest review failed, or failed for good: starts clean (Stall section unchanged).
- Visible: the review gate allows a slice reviewed after the second plan and blocks one that failed there; the new run closes when its other slices are final; the pane keeps the carried slice's cards.
- Docs to update: README "Known limitations" and `docs/native-mode.md` if they describe a new plan as starting every slice clean; `.claude/rules/agents.md` "Run scope" (add the carry rule).

## G-2: a test-gate block after a passing review went unseen
- Changed: `.claude/hooks/review-gate.mjs` (an implementer whose latest test-gate record is a block with no later SubagentStop counts as unfinished: same reason `implementer_unfinished`, per-agent guard, message names the test gate), `docs/brief-grammar.md` ("Unfinished implementers"); tests in `src/review-gate-v2.test.mjs`.
- Visible: the orchestrator gets `implementer_unfinished` ("sent back by the test gate ... Resume it with SendMessage") instead of a silent `reviewer_passed`; two blocks, then `implementer_unfinished_gave_up`.
- Docs to update: README "Gate details" and `docs/native-mode.md` Stop row (implementer_unfinished also covers a test-gate block with no later stop); `.claude/rules/agents.md` 1.2.0 `implementer_unfinished` bullet. Limit: on a Claude Code without `background_tasks`, an agent still fixing after a block can be gated before it stops again.

## G-8: one review recorded as two stop records
- Live check: the fold-only rule (merge consecutive stops of one reviewer with no implementer between) would merge 22 pairs in the live copy, 10 of them SendMessage resumes (`stop_hook_active` false, 11 s to 34 min apart), one turning a fail into a pass (`merged-result`), which would drop the `retry` signal. So the audit's marker is used instead: the 12 true double stops all had `stop_hook_active` true and the same status.
- Changed: `.claude/hooks/journal.mjs` (`continues: true` when `stop_hook_active` is true and the agent already has a stop record), `.claude/hooks/brief.mjs` (a continued reviewer stop replaces that agent's latest review of the slice when no implementer launch or stop came after it; reviews keep `agent`), `scripts/report.mjs` (skills of a continued record replace the earlier record's), `docs/brief-grammar.md` (Stop record); tests `src/journal-stops.test.mjs`, `src/review-gate-v2.test.mjs`, `src/report-cost.test.mjs`.
- Visible: `countedFails`, review counts and the report's Skills counts no longer double for a hand-back; verdicts unchanged. The pane is not changed: `turn.complete` carries no `stop_hook_active`, and it already updates one record per spawn (a resume is a new record); not shown that it sees two completions for one hand-back.
- Docs to update: `.claude/rules/agents.md` "Log records" (stop record gains optional `continues`).

## T-9 (fold side): a test gate that gave up looked clean
- Changed: `.claude/hooks/brief.mjs` (fold reads gate `test` records `max_blocks_reached` and `bugfix_unverified_gave_up`; doubt signal `test_gate_gave_up` when one is later than the review the latest attempt followed), `docs/brief-grammar.md` (Doubt signals table); test in `src/review-gate-v2.test.mjs`.
- Visible: such a slice needs a passing opus review (`opus_review_required`, signals list names `test_gate_gave_up`); off with escalation off.
- Docs to update: the orchestrator prompt's list of doubt signals, the route skill and nudge if they list them, `.claude/rules/agents.md` (the "Doubt signals:" sentence in the plan-check/review-gate bullet), README doubt-signal list, the header comment of `review-gate.mjs` step 2 list; `docs/dashboard.md` should say the pane cannot show `test_gate_gave_up` (as for `tests_failed_isolated`). The cap scope in `verify.sh` (per agent id across a resume) is not changed here.

## G-4, G-11, G-13 (spec only, `docs/brief-grammar.md`)
- G-4: "Run model" and "Log records" now limit the no-reply-text claim to the run-model logs and say `telemetry.jsonl` keeps payload strings clipped to 300 characters, the last message included (`telemetry.mjs` `clip`).
- G-11: `REPLAN: <n>` reads the leading integer (`2 (second)` is 2); a value not starting with digits is `null` (`brief.mjs` `parsePlan`).
- G-13: `builtin_agent_in_run` points to `BUILTIN_AGENTS` in `.claude/hooks/builtin-agents.mjs` and the learned file instead of naming agents.
- Docs to update: none beyond this file; README/native-mode carry their own lists (G-9, G-10, other slices).
