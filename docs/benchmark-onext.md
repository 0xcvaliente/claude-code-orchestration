# Benchmark: O-next (revised proposals) vs O-mix (orchestrator as shipped)

Date: 2026-10-16. Campaign `k2-cap10-onext` (`bench/matrix/k2-cap10-onext.json`), branch `o-next-benchmark` (working tree on top of `06169c4`). Raw data: `runs/bench/k2-cap10-onext/` (`summary.json`, `grades.jsonl`, `grades-lenient.jsonl`, `report.html`).

One task, `k2-stdlib-toolkit-xl` (twelve modules, 1,762 hidden tests), with a 10-minute wall-clock cap and 4 runs per arm. In each block the two arms started together. Cost is in tokens, over every model.

## Arms

- **O-mix**: the native orchestrator as shipped (this repo's `.claude/`).
- **O-next**: O-mix plus `bench/variants/o-next.mjs`, which edits only the run repo's copy of `.claude/`:
  1. **Plan check in code**: the `plan-check.mjs` PreToolUse hook on `Agent`. Implementer briefs carry `SLICE`, `FILES` and `DEPENDS` lines. The hook blocks a file overlap with another slice unless that slice is in `DEPENDS`, and blocks dependency cycles.
  2. **Plan review**: before implementing, the orchestrator sends the plan to a reviewer in a brief that starts with `PLAN REVIEW`.
  3. **Per-slice review**: each slice is reviewed as soon as its implementer returns. Isolated code slices are reviewed on their branch before integration. Reviewer briefs may carry a `FOCUS` line.
  4. **Editor slice** for document deliverables.
  5. **Run journal**: the `journal.mjs` SubagentStop hook, plus a Resume section in the orchestrator prompt.

Agent models, effort and turn limits are the same in both arms. A test checks that the overlay leaves the agent front matter unchanged.

## Results

| Arm | Strict score, median (runs) | Lenient score, median | Tokens, median per run | Wall time, median |
|---|---|---|---|---|
| O-mix | **90.8%** (92.6, 74.6, 89.0, 99.5) | 99.5% | 4.73M | 269 s |
| O-next | **72.8%** (70.7, 74.8, 79.9, 62.2) | 99.6% | 5.15M | 316 s |

O-next against O-mix, paired by block:
- Strict score: **−18.1 points** (95% interval −37.3 to +0.2).
- Tokens: 1.09× (0.88 to 1.38).
- Wall time: +47 s (−20 to +92).

Tokens over all 4 runs, by model:

| Arm | Sonnet 5.5 | Opus 5.5 |
|---|---|---|
| O-mix | 15.63M | 3.71M |
| O-next | 16.03M | 4.08M |

No run hit the cap, and every run ended on its own within 244 to 337 s.

### Where the strict points went

In all 8 runs the lenient grade is 99.4 to 99.9%, so the code worked. Every strict loss is a module scored zero under the task's import rule. The strict grade zeroes a module that imports `re`; the lenient grade allows `re` everywhere except `toolkit/regex.py`.

| Arm | Modules zeroed per run |
|---|---|
| O-mix | 1, 3, 2, 0 |
| O-next | 4, 3, 3, 5 |

The modules most often zeroed were `toml` (all 8 runs), plus `shlex`, `fraction`, `urls` and `jsonx`. Whether an implementer reaches for `re` is a per-module habit, and none of the five changes target it. The gap is therefore not clearly caused by O-next. The interval for the score difference touches zero, and 4 runs per arm cannot separate a real effect from variance.

## Did the changes actually run?

| Change | What happened in the 4 O-next runs |
|---|---|
| Plan check | It ran on every implementer launch: 36 checks and 0 blocks. Every plan already had one module per slice. |
| Plan review | **Never.** In all 4 runs the orchestrator went straight to implementers. The first implementer started 9 s into run 1. Under a 10-minute cap the prompt step was skipped, and nothing enforces it. |
| Per-slice review | It ran: the first reviewer started at 45 to 113 s. O-mix behaved the same way (48 to 110 s), so the shipped orchestrator already does this on this task. |
| Branch review before integration | Never applicable. O-next used no worktrees in any run, so every slice ran in the shared tree. One of 4 O-mix runs used worktrees and the integrator. |
| Editor slice | Not applicable: k2 is a code task. |
| Run journal | **Broken in headless runs.** It recorded 0 entries, because `scripts/orchestrate.sh` passes `--no-session-persistence`, so subagent transcripts are never written and the hook cannot read the slice from the brief. Nothing resumed, so scores were unaffected. |

## Conclusion

On this task the revised proposals did not improve the orchestrator. Of the five changes, only the plan check ran, and it found nothing to block. O-next scored lower on the strict grade, but the loss comes from import-rule zeroes that none of the changes touch, and the interval includes no difference. Tokens (+9%) and wall time (+47 s) moved slightly against O-next, which fits the longer prompt and briefs.

Before promoting any of this into `.claude/`, two fixes are needed:
1. **Enforce the plan review.** Block the first implementer until a `PLAN REVIEW` reviewer has finished, in the same hook as the plan check.
2. **Make the journal work headless.** Key it by `agent_id` from the launch instead of reading the transcript.

After those fixes, the comparison needs a task where the changes can matter: one where plans can collide, plus a document task for the editor slice.

## v2: plan review enforced, journal fixed headless

Campaign `k2-cap10-onext-v2` (same matrix: k2, 10-minute cap, 4 runs per arm). Raw data: `runs/bench/k2-cap10-onext-v2/`.

### Changes from v1

- **The plan review is enforced.** `plan-check.mjs` blocks implementers until a reviewer whose brief starts with `PLAN REVIEW` has finished in the session. It reads slice `plan` from `journal.jsonl`.
  - **Light path:** `PATH: light` in the brief skips the wait, but only for a session's single slice.
  - **Loop guard:** each slice is blocked at most twice for a missing review, then let through, which opens the gate for the session.
- **The journal works headless.** `journal.mjs` now also runs on PostToolUse for `Agent`, which carries the brief and `tool_response.agentId`; a probe run confirmed this payload shape. On SubagentStop the hook looks up the slice by `agent_id`. A foreground agent stops before its PostToolUse fires, so its stop waits in `journal-pending.jsonl` until the launch arrives.
- **An aborted first attempt:** the first v2 attempt let `PATH: light` count on any brief, and the orchestrator added it to every brief of a 12-slice plan to skip the review. That attempt was stopped after one block and deleted, and the rule was narrowed to the single-slice case above.

### Results

| Arm | Strict score, median (runs) | Lenient score, median | Tokens, median per run | Wall time, median |
|---|---|---|---|---|
| O-mix | 81.5% (62.2, 79.7, 83.5, 83.3) | 99.5% | 5.56M | 267 s |
| O-next v2 | 81.7% (92.6, 62.3, 83.6, 79.9) | 99.6% | 5.01M | 303 s |

O-next v2 against O-mix, paired by block:
- Strict score: **+0.2 points** (95% interval −17.4 to +30.4).
- Tokens: 0.90× (0.41 to 1.20).
- Wall time: +36 s (−212 to +105).

Tokens over all 4 runs, by model:

| Arm | Sonnet 5.5 | Opus 5.5 |
|---|---|---|
| O-mix | 18.48M | 10.02M |
| O-next v2 | 19.10M | 2.68M |

O-mix's Opus total is dominated by run 1, which used 12.66M tokens in all. As in v1, the lenient grade is about 99.5% in every run, so strict differences are still import-rule zeroes.

### Did the changes run?

| Change | v2 |
|---|---|
| Plan review | **Ran in 4 of 4 runs**, before any implementer. It was short: the first implementer started 8 to 14 s after the plan reviewer started. It reported fail in 3 of 4 runs. The orchestrator then launched implementers without a second review, which the prompt allows after one fix and the gate allows once any plan review has finished. |
| Plan check | 30 implementer launches checked. No blocks, because the orchestrator waited for the review before launching anything. |
| Run journal | **Works headless:** 19 to 36 entries per run, one for each implementer and reviewer, with slice and status. |

### Conclusion (v2)

Both fixes work. The plan review now always happens, and the journal now records results in headless runs. On k2 the result is a tie with O-mix: the score is within noise and O-next used 10% fewer tokens. The reviews are shallow (seconds long), and their fail verdicts did not visibly change the plans. Making the plan review matter needs a stricter brief, or a re-review after a fail, and a task where plans can actually go wrong.
