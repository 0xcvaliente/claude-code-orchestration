# Read router benchmark for 0.4.0 (2026-10-31)

Two runs per arm of one reading task, `d3-reader`, built so that the read router must run. The run shows direction only and decides no hypothesis. The verdict rules are in [bench/HYPOTHESES.md](../bench/HYPOTHESES.md): n = 2, one task, so the task-clustered standard error is null. The predictions (H14-d3) were written into HYPOTHESES.md before any `d3-reader` run. Data: [data/route-040-2026-10-31.summary.json](data/route-040-2026-10-31.summary.json) and [data/route-040-2026-10-31.runs.json](data/route-040-2026-10-31.runs.json), with home paths made relative, dollar fields dropped, and each session's free-text final message left out of the runs file. The campaign folder is `runs/bench/route-040-20261031T2204/` (`manifest.json`, `runs.jsonl`, `grades.jsonl`, `summary.json` and each run's `state/` logs). It is not committed.

## Setup

- Matrix `bench/matrix/route-040.json`, seed 41, `parallel_blocks: 1`. Task `d3-reader` at an 8-minute cap (cell `cap8`), arms `reader-haiku`, `reader-sonnet` and `reader-routed`, 2 reps each. The three arms of a rep start together, and the 2 blocks run one after the other.
- Task (`bench/tasks/d3-reader`): twelve questions over seven documents. They are a text PDF (q1, q2), a PDF table (q3, q4), a scanned PDF with no text layer (q5, q6), a bar chart PNG (q7, q8), an xlsx whose formulas have no stored results (q9, q10), a docx with the answer in a table (q11) and a 60-page PDF (q12). A plain sonnet main session launches the project researcher once per question, all twelve together. Each brief is `SLICE: q<n>`, `SOURCES: <one document>`, `READ: extract`, the question and "Answer with a QUOTE line". The session then writes `answers.json`, and the hidden scorer checks every answer. The hard kinds are q3 to q11 (the files the router's profiler rates sonnet). The router leaves q1, q2 and q12 on haiku.
- Arms (`bench/arms.mjs`). All three run a plain sonnet session (`ORCH_AGENT=none`, `ORCH_MODEL=sonnet`) with this checkout's `.claude/` copied in, plus `ORCH_SESSION_PERSISTENCE=1`, so telemetry records per-researcher tokens:
  - `reader-haiku`: the researcher as shipped (haiku).
  - `reader-sonnet`: every subagent forced to sonnet (`CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`, `CLAUDE_CODE_SUBAGENT_MODEL=sonnet`). The only subagents are researchers.
  - `reader-routed`: the read router on (`ORCH_READ_ROUTER=on`).
- Versions: Claude Code 2.1.316, plugin 0.4.0, repo at 17fe23b.
- Duration. The matrix estimated 20 minutes in the worst case. The runs took about 2 minutes. From `manifest.json` and `runs.jsonl` (UTC; local time is UTC+1):
  - The campaign started at 21:04:18.
  - Block 1 (r1) ran from 21:04:19 to 21:05:31 (last end 21:05:30.958).
  - Block 2 (r2) ran from 21:05:32 to 21:06:27 (last end 21:06:26.831).
  - Grading and analysis ended at 21:07:00 (`generated_at`).
  - Every run exited on its own, between 35 s and 71 s, well before its cap. None was rate-limited, errored or excluded.
- Validity (`reader.invalid` in the summary). A run is invalid if it has fewer than 12 researcher launches, or if it is a routed run with no route decision. All 6 runs are valid. Each run has 12 researcher launches and 12 researcher stops, all 12 with tokens. Each routed run has 12 route decisions, 9 of them raised.

## Results

### Per run

| Run | Score | Hard (q3 to q11) | Researcher tokens | Researcher models | Total tokens | Wall | Researcher Bash denies |
|---|---|---|---|---|---|---|---|
| `reader-haiku` r1 | 75% (9/12) | 66.67% | 1,004,473 | haiku 12 | 1,188,438 | 48.3 s | 5 |
| `reader-haiku` r2 | 75% (9/12) | 66.67% | 1,271,137 | haiku 12 | 1,604,370 | 53.5 s | 3 |
| `reader-sonnet` r1 | 83.33% (10/12) | 77.78% | 1,283,759 | sonnet 12 | 1,664,280 | 70.8 s | 8 |
| `reader-sonnet` r2 | 75% (9/12) | 66.67% | 1,017,697 | sonnet 12 | 1,293,359 | 50.0 s | 8 |
| `reader-routed` r1 | 83.33% (10/12) | 77.78% | 627,253 | sonnet 9, haiku 3 | 1,000,218 | 35.5 s | 2 |
| `reader-routed` r2 | 100% (12/12) | 100% | 636,004 | sonnet 9, haiku 3 | 967,426 | 53.1 s | 2 |

Researcher tokens are input + output + cache read + cache write, taken from the last telemetry SubagentStop per researcher. Total tokens cover every model in the run, the sonnet main session included. Researcher models come from the same telemetry records (`reader.researcher_models`). No run claimed a success it did not have (`false_success` 0 in all six).

### Per cell

| Arm | n | Score median (min, max) | Hard median | Researcher tokens median | Researcher output tokens median | Total tokens median | Wall median |
|---|---|---|---|---|---|---|---|
| `reader-routed` | 2 | 91.67% (83.33, 100) | 88.89% | 631,628.5 | 9,473.5 | 983,822 | 44.3 s |
| `reader-sonnet` | 2 | 79.16% (75, 83.33) | 72.22% | 1,150,728 | 9,581 | 1,478,819.5 | 60.4 s |
| `reader-haiku` | 2 | 75% (75, 75) | 66.67% | 1,137,805 | 15,442 | 1,396,404 | 50.9 s |

The easy questions (q1, q2, q12) were right in every run (`easy_pct` 100). Only `reader-routed` r2 reached 100%, at 53 s (pass^2 = 0 for every arm; pass@1 0.5 for `reader-routed`, 0 for the others).

### Paired differences (B − A, per rep r1, r2)

| A → B | Score | Hard | Researcher tokens | Total tokens |
|---|---|---|---|---|
| `reader-sonnet` → `reader-routed` | 0, +25 (mean +12.5) | 0, +33.33 (mean +16.67) | −656,506, −381,693 (mean −519,099.5) | −664,062, −325,933 (mean −494,997.5) |
| `reader-haiku` → `reader-routed` | +8.33, +25 (mean +16.67) | +11.11, +33.33 (mean +22.22) | −377,220, −635,133 (mean −506,176.5) | −188,220, −636,944 (mean −412,582) |
| `reader-haiku` → `reader-sonnet` | +8.33, 0 (mean +4.17) | +11.11, 0 (mean +5.56) | +279,286, −253,440 (mean +12,923) | +475,842, −311,011 (mean +82,415.5) |

Every pair is marked `direction_only`. With one task, `se_clustered` and `ci95` are null.

## H14-d3 predictions

Each prediction is scored as written in the amendment, using the medians and paired means above.

- **(a) Accuracy within a margin of sonnet: direction consistent.** The routed median, 91.67%, is 12.51 points above sonnet's 79.16%, not more than 8.34 below it. The paired score difference `reader-sonnet` → `reader-routed` has a mean of +12.5, which is at least −8.34.
- **(b) Fewer researcher tokens than sonnet: direction consistent.** The routed median, 631,628.5, is below sonnet's 1,150,728 (45% lower). The paired researcher-token difference has a negative mean, −519,099.5. The amendment expected a small saving. The observed one is large, and the confounds below suggest where it comes from.
- **(c) Better than haiku on the hard kinds: direction consistent.** The routed hard median, 88.89%, is above haiku's 66.67%. The paired `hard_pct` difference `reader-haiku` → `reader-routed` has a mean of +22.22.

None of (a) to (c), and not H14 itself, is called supported or refuted: n = 2, one task, null clustered SE.

## Where the routed arm gained, and the confound

`reader-routed` changes two things at once. It raises 9 of the 12 researchers to sonnet, and for the PDF, xlsx and docx sources it appends notes that point to cached converted text. The scan and the chart get no conversion. The run cannot separate these two effects. The per-question grades show where the gain landed:

| Questions (kind) | `reader-haiku` | `reader-sonnet` | `reader-routed` |
|---|---|---|---|
| q1, q2 (text PDF), q12 (60-page PDF) | 6/6 | 6/6 | 6/6 |
| q3, q4 (PDF table) | 4/4 | 4/4 | 4/4 |
| q5, q6 (scan) | 4/4 | 4/4 | 4/4 |
| q7, q8 (chart) | 4/4 | 4/4 | 4/4 |
| q9, q10 (xlsx formulas) | 0/4 | 1/4 (r1 q10) | 2/4 (r2 both) |
| q11 (docx table) | 0/2 | 0/2 | 2/2 |

Counts are right answers over 2 runs, from the final grade's `by_cat` in `grades.jsonl`.

- On the table, scan and chart questions (q3 to q8), haiku was already right in every run. The router raised those six researchers to sonnet, and no score changed. So in this task, raising the model on those kinds gained nothing measurable.
- The whole score difference sits in q9 to q11, the xlsx and docx files. Researchers cannot open those without help: they are zip files, and the researcher's read-only tools include neither unzip nor Python. In the unrouted arms the researcher guard denied `python3`, `unzip`, `pandoc` and `pdftotext` attempts (`gates.jsonl`, gate `researcher`). Those researchers answered q9 and q10 as 0 in 3 of 4 runs, and q11 as 0 or 30 (the right answer is 45). The routed runs' denies were only `cd` and one command substitution, 2 per run. Routed r1's `researcher:deny: 2` were both `cd`, and do not explain its two misses.
- `reader-sonnet` without notes got q10 right once (r1). Model alone can therefore matter on the xlsx. The docx was answered right only with the notes.
- Routed r1 still answered 0 to q9 and q10. It had both the notes and sonnet. The conversion holds the formulas, not their results, so the model must compute them.
- Taken together, the per-question pattern suggests that the converted-text notes, more than the model raise, drove the score gain. This is a suggestion, not a finding: on q9 to q11 every routed researcher had both the notes and sonnet.
- Tokens: `reader-haiku` used as many researcher tokens as `reader-sonnet` (medians 1,137,805 and 1,150,728). `reader-routed` used about 45% fewer, although 9 of its 12 researchers ran on sonnet. This also points to the converted text replacing raw PDF and image reads and the failed tool attempts, rather than to the model.

## Limitations

- n = 2 per arm, one task, an 8-minute cap. The runs took about 2 minutes. Direction only, no verdict.
- Model and notes are confounded in `reader-routed` (above). An arm with the notes but no model raise would separate them, and no such arm exists yet.
- The task was built so that the router runs: one researcher per question, each brief with `SOURCES:` and `READ: extract`. It says nothing about how often the orchestrator launches researchers on real tasks. compare-040 showed that the orchestrator can take the light path and launch none ([benchmark-compare-040.md](benchmark-compare-040.md)).
- The main session runs on sonnet in every arm. Its tokens are in the total-token columns, not in the researcher tokens.
- The runs used the build at 17fe23b, before the 0.4.0 run-split fix (a plain session has no planned run, so that fix does not touch these runs).

## How to reproduce

```
npm run bench -- --matrix bench/matrix/route-040.json
npm run bench:grade -- runs/bench/<campaign>
npm run bench:analyze -- runs/bench/<campaign>
```

The committed `summary.json` rebuilds the per-run, per-cell and paired tables (`runs[].reader`, `reader.cells`, `cells`, `paired`). The per-question table comes from `grades.jsonl` and the denies from each run's `state/gates.jsonl`, which are in the campaign folder, not committed. See [bench/README.md](../bench/README.md), "Read router benchmark (route-040)".
