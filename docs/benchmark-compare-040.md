# Comparison run for 0.4.0 (2026-10-31)

One k2 run per arm and two d2-docs runs per arm. This run shows direction only and decides no hypothesis (verdict rules in [bench/HYPOTHESES.md](../bench/HYPOTHESES.md): n < 2 is inconclusive, and with one task per group the clustered standard error is null). Data: [data/compare-040-2026-10-31.summary.json](data/compare-040-2026-10-31.summary.json), [data/compare-040-2026-10-31.runs.json](data/compare-040-2026-10-31.runs.json) (home paths made relative, dollar fields dropped), and the campaign folder `runs/bench/compare-040-20261031T1722/` (`grades.jsonl`, `grades-lenient.jsonl`, the run hook logs; not committed).

## Setup

- Matrix `bench/matrix/compare-040.json`, seed 40, `parallel_blocks: 2` (at most 5 sessions live). Two groups:
  - `k2-stdlib-toolkit-xl` (twelve Python standard-library modules, 1,762 hidden tests) at a 10-minute cap (cell `cap10`), arms `O-mix-plugin` and `O-mix-030`, 1 rep each.
  - `d2-docs` (seven questions over a .txt, a text PDF, a PDF table, an image-only scanned PDF, an xlsx with uncached formulas, a bar chart and a 60-page PDF) at a 6-minute cap (cell `cap6`, overriding the task's 8), arms `all-haiku`, `all-sonnet` and `routed`, 2 reps each.
- Versions: Claude Code 2.1.316, plugin 0.4.0, repo at 56ec956. Started 2026-10-31 16:22:40 UTC.
- Arms (`bench/arms.mjs`):
  - `O-mix-plugin`: the orchestrator from this checkout's plugin build (0.4.0), loaded with `--plugin-dir`, shipped models (opus orchestrator, sonnet workers).
  - `O-mix-030`: the same from the 0.3.0 plugin (`dist/plugin` at ef62288).
  - `all-haiku`: the orchestrator as shipped (researcher on haiku).
  - `all-sonnet`: the orchestrator with every subagent forced to sonnet (`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`), not the researcher alone.
  - `routed`: the orchestrator with the read router on (`ORCH_READ_ROUTER=on`).
- Duration: the eight runs took about 8 minutes of wall time, from 16:22:40 to 16:30:15 in the run log (the last run, `O-mix-030`, ended at 16:30:15.796). The matrix note planned about 25 minutes in a 30-minute budget. Every run exited on its own before its cap; none was rate-limited, errored or excluded.
- Strict is the official grade. Lenient is the k2 variant grade (lets toolkit modules other than `toolkit/regex.py` import `re`).

## Results

### Per run

| Run | Score | Tokens | Output tokens | Wall | Time to 100% | Implementer launches | Reviewer launches | Claim | False success |
|---|---|---|---|---|---|---|---|---|---|
| k2 `O-mix-plugin` r1 | 98.98% (1744/1762) | 5,034,067 (opus 1,222,652, sonnet 3,811,415) | 204,842 | 412 s | not reached (90% at 360 s) | 7 (6 sonnet, 1 opus) | 8 (incl. 1 plan review) | partial | no |
| k2 `O-mix-030` r1 | 99.72% (1757/1762) | 5,225,511 (opus 964,162, sonnet 4,261,349) | 225,317 | 453 s | not reached (90% at 360 s) | 6 (sonnet) | 10 (incl. 1 plan review) | partial | no |
| d2 `all-haiku` r1 | 100% (7/7) | 2,584,315 | 23,411 | 219 s | 180 s | 2 (1 sonnet, 1 opus) | 4 | failure | no |
| d2 `all-haiku` r2 | 100% (7/7) | 1,534,902 | 9,701 | 105 s | 60 s | 1 | 1 | failure | no |
| d2 `all-sonnet` r1 | 100% (7/7) | 1,636,866 | 16,075 | 175 s | 90 s | 1 | 3 | partial | no |
| d2 `all-sonnet` r2 | 100% (7/7) | 1,674,606 | 17,987 | 182 s | 90 s | 1 | 4 | failure | no |
| d2 `routed` r1 | 100% (7/7) | 1,234,657 | 15,116 | 177 s | 120 s | 2 | 3 | unclear | no |
| d2 `routed` r2 | 100% (7/7) | 1,216,290 | 13,317 | 146 s | 60 s | 1 | 3 | partial | no |

Launch counts come from each run's `journal-launches.jsonl`. The summary's `subagents` field counts SubagentStop records instead, so it counts an implementer again each time a gate sends it back (for example 4 implementer stops in `all-haiku` r1 against 2 launches). The claim column is the rules-based claim; no d2 run claimed a success it did not have, since all scored 100%.

The `O-mix-030` final grade carries a static-scan flag, `static: exec( in toolkit/regex.py`. It is a flag only: the score is unchanged, and the lenient grade (99.72%) carries the same flag. Strict and lenient are equal for both k2 runs (98.98% and 99.72%), so no module lost tests to the `re` rule. Per module, `O-mix-plugin` lost 11 tests in `regex` (194/205), 4 in `toml`, 2 in `csv` and 1 in `b64`; `O-mix-030` lost 3 in `csv`, 1 in `fraction` and 1 in `b64`.

### Per cell

| Task, cap | Arm | n | Strict median | Tokens median | Output tokens median | Wall median | Time to 100% median | pass^k |
|---|---|---|---|---|---|---|---|---|
| k2, cap 10 | `O-mix-plugin` (0.4.0) | 1 | 98.98% | 5,034,067 | 204,842 | 412 s | not reached | pass^1 = 0 |
| k2, cap 10 | `O-mix-030` (0.3.0) | 1 | 99.72% | 5,225,511 | 225,317 | 453 s | not reached | pass^1 = 0 |
| d2-docs, cap 6 | `all-haiku` | 2 | 100% | 2,059,608.5 | 16,556 | 162 s | 120 s | pass^2 = 1 |
| d2-docs, cap 6 | `all-sonnet` | 2 | 100% | 1,655,736 | 17,031 | 179 s | 90 s | pass^2 = 1 |
| d2-docs, cap 6 | `routed` | 2 | 100% | 1,225,473.5 | 14,216.5 | 161 s | 90 s | pass^2 = 1 |

k2 "pass" means all 1,762 tests pass, which neither run reached, so pass^1 is 0 for both. On d2 every question in every run was right at the end, including the table (q3) and scan (q4) questions.

### Paired differences (B − A, per rep)

| A → B | Pairs | Score | Pass | Tokens |
|---|---|---|---|---|
| `O-mix-030` → `O-mix-plugin` | 1 | −0.74 points | 0 | −191,444 |
| `all-haiku` → `all-sonnet` | 2 | 0, 0 | 0, 0 | +139,704, −947,449 (mean −403,872.5) |
| `all-haiku` → `routed` | 2 | 0, 0 | 0, 0 | −318,612, −1,349,658 (mean −834,135) |
| `all-sonnet` → `routed` | 2 | 0, 0 | 0, 0 | −458,316, −402,209 (mean −430,262.5) |

All four comparisons are marked `direction_only`: one task each, so the clustered standard error and interval are null.

## What it does and does not show

- On k2, 0.4.0 scored 0.74 points below 0.3.0 (98.98% against 99.72%) with 191,444 fewer tokens (3.7% less) and 41 s less wall time. Neither claimed a false success. One run each cannot separate this from run-to-run noise: the earlier 0.3.0 run on the same task and cap scored 99.6% ([benchmark-short-k2.md](benchmark-short-k2.md)).
- On d2-docs, all three arms answered all seven questions in both reps. The score gives no signal between them.
- The d2 token figures differ (routed lowest, all-haiku highest), but this is not a router effect. See the next section.

## The light path: the read router was not exercised

Every d2-docs run took the light path: the orchestrator ran the task as a single slice (`answers`, `PATH: light`) with one or two implementer launches per run and launched no researcher. The read router changes only researcher launches, so it never fired: no routed run has a `reads-route.jsonl`, and the summary's `routes` list is empty for every run. H14 is therefore untested by this campaign.

Three further points:

- `all-haiku` puts the researcher on haiku, and no researcher ran, so no d2 run used haiku at all (the token records list only opus and sonnet). `all-haiku` and `routed` both ran as the shipped orchestrator; `all-sonnet` differed only in forcing reviews the orchestrator asked to run on opus onto sonnet (the review gate logged `opus_review_required_gave_up` once in each `all-sonnet` run).
- The token spread between arms comes from how each orchestrator ran the slice, not from routing. In `all-haiku` r1 the orchestrator made 6 PDF reads itself, of 4 distinct files (`manual.pdf` 3 times, in page ranges; `reads.jsonl`), its slice needed a second, opus implementer, and opus tokens reached 2,089,001 of the run's 2,584,315.
- Headless runs use `--no-session-persistence` (`scripts/orchestrate.sh`), so they keep no subagent transcripts, and telemetry v2's per-agent fields (`tokens`, `models`, `turns`) are empty in all 31 SubagentStop records of the d2 runs. H14's "reading tokens" per role cannot be read from these runs.

## Live router check

The router was checked separately, by hand, on 2026-10-31 (recorded in [data/live-checks-2026-10-31.md](data/live-checks-2026-10-31.md), Check H). In a scratch git repo with the main checkout's `.claude/` copied in (at 56ec956) and `src/fixtures/files/scanned.pdf`, `ORCH_READ_ROUTER=on claude -p ... --model sonnet --allowedTools=Agent` had the main session launch the project researcher with the brief `SLICE: r1 / SOURCES: scanned.pdf / READ: extract / Question: what text is shown on the first page...`.

- `reads-route.jsonl` recorded `decision: route`, `model: haiku` from the agent file, `raised: true`, `to: sonnet`, reasons `read_extract`, `pdf_sonnet`, `pdf_scanned`, `pdf_hard_pages`, 1 file, 0 conversions, `hard_pages: 0`.
- Telemetry's SubagentStop for the researcher recorded models `["claude-sonnet-5-5"]`, 2 turns, tokens input 4, output 305, cache read 6,288, cache write 9,658.
- The researcher reported no readable text on the page; the fixture page is an image without legible text.
- Log inconsistency: the record has `hard_pages: 0` next to the `pdf_hard_pages` reason.

This shows the mechanism works once: a researcher brief naming a scanned PDF was raised from haiku to sonnet, and the researcher really ran on sonnet. It says nothing about scores or token savings.

## H15–H17: not exercised

The run journals (`journal.jsonl` and `journal-launches.jsonl` for d2 in each run's `state/`; for k2 in the plugin data dir `~/.claude/plugins/data/orchestration-inline/state/<run repo>/`), folded with the gates' own `sessionRuns`:

- No slice failed for good and none stalled. No `REPLAN` plan review, no `replan_required` gate decision and no `VALIDATE: gaps` (refute) review appears in any run.
- On k2, no slice had more than two attempts. In `O-mix-plugin`, slice S2's implementer (`ab2c8…`) reported fail at 16:25:07, 16:25:19 and 16:26:01 (it asked for Bash permission), then reported pass at 16:26:52 with the open item "`toolkit/regex.py` needs a real implementation". After that pass, at 16:27:02, the orchestrator launched a fresh opus implementer (`a9cc0…`) on S2, and at 16:27:05 an opus reviewer (`a13e7…`), which passed `ab2c8…`'s work at 16:27:15. The opus implementer reported pass at 16:29:06 and a second opus reviewer passed it at 16:29:22. This was an extra opus attempt after a pass that left an open item, not a retry after a failed review, and not the third-attempt rule of H15. `O-mix-030` used one implementer launch per slice.
- On d2, `all-haiku` r1's slice had two attempts in the first journal run, then a fresh opus implementer that the journal recorded as a new run (run 2), which passed.

So H15 (opus on the last attempt), H16 (gap cutoff plus refute pass) and H17 (stall replan) have no data from this campaign.

## Charts

None. `bench/charts.mjs` draws only the arms `P-S`, `P-O`, `O-mix` and `O-O`; for this campaign it produces empty charts. Their caption is taken from the first run in `summary.json`, here a d2-docs run, so it would describe d2-docs with a wrong rep count. The page therefore uses tables.

## Limitations

- n = 1 per k2 arm and n = 2 per d2 arm, one task per group: direction only, no verdict.
- The k2 pair changes everything between 0.3.0 and 0.4.0 at once, so even a clear difference could not be attributed to one mechanism.
- d2-docs saturated at 100% for every arm within 3 minutes of a 6-minute cap, and its single-slice shape sends the orchestrator down the light path, so it cannot test the read router. A reading task that makes the orchestrator launch researchers is needed.
- Per-role tokens are unavailable in headless runs (`--no-session-persistence`).
- The live router check is a single manual run on one file.

## How to reproduce

```
npm run bench -- --matrix bench/matrix/compare-040.json
npm run bench:grade -- runs/bench/<campaign>
node bench/grade.mjs runs/bench/<campaign> --variant lenient
npm run bench:analyze -- runs/bench/<campaign>
```

The committed `summary.json` rebuilds the tables above. Attempt counts come from each run's journal (`journal.jsonl`, `journal-launches.jsonl`); for the plugin arms they are in Claude Code's plugin data dir, not the run repo (see [bench/README.md](../bench/README.md), "Comparison run for 0.4.0").
