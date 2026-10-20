# Benchmark

Compares orchestrated runs against plain Claude Code sessions on the same tasks, under a hard wall-clock cap, with model-matched arms: the orchestrator with shipped models (O-mix) against plain Sonnet (P-S), and the orchestrator with every agent on Opus (O-O) against plain Opus (P-O). Hidden tests grade every run offline. Cost is reported in tokens only, never in money.

Pre-registered hypotheses and decision rules: [HYPOTHESES.md](HYPOTHESES.md). Results: [docs/benchmarks.md](../docs/benchmarks.md).

## Arms

Defined in `bench/arms.mjs`. Every arm except `SDK` goes through the product scripts unmodified.

| Arm | What runs |
| --- | --- |
| `P-S` | Plain Sonnet session (`scripts/orchestrate.sh`, `ORCH_AGENT=none`, `ORCH_MODEL=sonnet`, no `.claude/` copied) |
| `P-O` | Plain Opus session (same, `ORCH_MODEL=opus`) |
| `O-mix` | Orchestrator with agents as shipped (this repo's `.claude/` copied in) |
| `O-O` | Orchestrator with every agent's `model:` line rewritten to Opus |
| `AUTO` | `scripts/auto.sh`: triage picks plain, reviewed or the orchestrator |
| `SDK` | The SDK pipeline: `npx tsx src/cli.ts --repo <run repo> --task <prompt> --mode orchestrate --no-escalate --out <run dir>/sdk [--test-cmd <task test_cmd>] [--budget <tokens>]`; no `.claude/` copied; no mid-run snapshots (see "The SDK arm") |

## Tasks

In `bench/tasks/<id>/`. The cap is the task's own wall-clock limit (`cap_min`); a matrix cell can override it.

| Task | Tier | Shape | Cap | Language |
| --- | --- | --- | --- | --- |
| `t1-parallel` | small | parallel (two independent modules) | 10 min | node |
| `t2-single` | small | single (duration parser) | 10 min | node |
| `h1-query-engine` | medium | splittable | 30 min | node |
| `h2-scheduler` | medium | splittable | 30 min | node |
| `k1-stdlib-toolkit` | large | splittable (4 modules: toml 124, shlex 68, regex 205, csv 106 hidden cases; 503 total) | 30 min | python |
| `h3-sql-engine` | large | monolithic (minisql, matched against SQLite) | 30 min | python |
| `k2-stdlib-toolkit-xl` | large | splittable (12 modules: k1's four plus ipaddr, fraction, urls, b64, diff, wrap, jsonx, cal; about 1,600 hidden tests) | 30 min | python |

`k1-stdlib-toolkit` (test command `python3 tests/run_public.py`, graded path `toolkit`) is graded in a sandbox: the stdlib oracle modules are blocked, and using them in any way scores that module 0. It may arrive from another branch; `node bench/validate.mjs` lists what is present.

## Commands, in order

```bash
npm run bench:validate                                   # no model calls: stub fails, reference passes, every mutant is caught, meta.total matches
npm run bench -- --matrix bench/matrix/pilot.json        # 1 rep: t2 on all arms, k1 and h3 at 10 min (smoke test of the whole pipeline)
npm run bench -- --matrix bench/matrix/lite.json         # 2 reps, all six tasks, all five arms, main cell
npm run bench -- --matrix bench/matrix/pilot-k2.json     # 1 rep: k2, P-O and O-mix, main cell
npm run bench -- --matrix bench/matrix/lite-k2.json      # 2 reps: k2, all five arms, main cell (10 runs)
npm run bench -- --matrix bench/matrix/sweeps.json       # k2 only, P-O vs O-mix, caps 10 and 60 min, budgets 3M and 8M tokens (16 runs)
npm run bench -- --matrix bench/matrix/sdk-vs-native.json   # NOT RUN: k2 at cap10, O-mix vs SDK, 4 reps (8 runs); H8 in HYPOTHESES.md
npm run bench:grade -- runs/bench/<campaign>             # offline grading of snapshots into grades.jsonl
npm run bench:analyze -- runs/bench/<campaign>           # summary.json: token metrics, comparisons, hypothesis verdicts
npm run bench:report -- runs/bench/<campaign>/summary.json   # report.html, plus benchmarks.md for docs/benchmarks.md
```

The pilot showed that k1 and h3 saturate within minutes, so the splittable-task hypothesis (H1) and both sweeps (H7) moved to `k2-stdlib-toolkit-xl`, which has its own main campaign (`lite-k2`) and the sweeps; `lite.json` stays unchanged and keeps k1 as a saturated large task. See the amendment in [HYPOTHESES.md](HYPOTHESES.md).

`bench:analyze` accepts several campaign dirs (pooled) and `--out`. `bench:report` takes `--html` and `--md`.

`bench/run.mjs` flags: `--matrix <file>`, `--campaign <name>`, `--resume <campaign dir>`, `--dry-run` (prints each run's command and environment additions), `--only <substring of run_id>`, `--parallel-blocks N`, `--seed N`, `--tasks-dir <dir>`, `--check-isolation`.
`bench/grade.mjs` flags: `--jobs N`, `--only <substring>`, `--final-only`, `--tasks-dir <dir>`. Identical (task, content hash) pairs are graded once (`grades-cache.json`), and finished (run, snapshot) pairs are skipped, so grading can be rerun.

Claims audit: an optional `<campaign>/claims-audit.json` of `{"<run_id>": {"claim": "success|partial|failure|unclear|none", "note": "..."}}` overrides the rules-based claim for false-success counts and H4 (the automatic claim stays as `claim_auto`, and the report shows both).

Lenient variant (k2 only): `node bench/grade.mjs <campaign> --variant lenient` grades `final/` only into `grades-lenient.jsonl` (other tasks are skipped with a note). In that grade `re` may be imported by any toolkit module except `toolkit/regex.py` (task rule 2 otherwise zeroes a module that imports it); regex cases stay watched as in the strict grade, and flags carry a `lenient:` prefix. `analyze.mjs` then adds `score_pct_lenient`, `pass_lenient` and `score_median_lenient`, and the report adds a lenient column for k2. The strict score stays official and hypotheses use it.
`bench/validate.mjs` flags: `--task <id>`, `--tasks-dir <dir>`.

A matrix file has `name`, `seed` and `groups`; each group lists `tasks`, `arms`, `cells` (`id`, plus `cap_min` or `budget_tokens`) and `reps`.

## The SDK arm

Compares the SDK pipeline (`src/cli.ts`) with the native orchestrator (`O-mix`) on the same task, cap and grading. This campaign has NOT been run and nothing here claims a result. H8 in [HYPOTHESES.md](HYPOTHESES.md) pre-registers the comparison and lists the known differences between the arms. The SDK-specific code is `bench/lib/sdk.mjs`; run-exec makes one call into it.

- Result location. The pipeline merges passing slices onto branch `orch/<runId>/result` in a worktree and leaves the run repo's working tree at the init commit. After the launch and before anything is read, the harness merges that branch into the working tree (fast-forward, else merge). `sdk-adapter.json` in the run folder records what was merged.
- Capped runs. If the cap kills the run, step 7 never ran: no result branch, no `report.json`. The harness reads the SDK run directory's `journal.json`, merges the `orch/<runId>/<slice>` branch of each slice recorded as passed (a conflicting or missing branch is skipped and listed in `sdk-adapter.json`), and grades that: passed, verified slices only. Native keeps whatever is in its tree. This asymmetry is documented in H8.
- No snapshots. The working tree is empty mid-run, so the row has `snapshots: "none"`, no snapshot is taken, and `analyze` sets t90, t100 and AUC to null for the arm.
- Tokens. The row's result document is synthesized from the SDK run directory: `report.json` `spentTokens` when present, else the sum of `tokens` in `telemetry.jsonl` (one line per worker, written as it finishes, so a killed run keeps the spend of workers that finished, not all spend: the tokens of workers still running when the cap kills the run are lost, so a capped SDK run's total is an undercount). Basis as in `scripts/tokens.mjs`: input + output + cache read + cache write.
- Errors. `report.error`, failed slices, failed workers' text and the tail of stderr are scanned for rate-limit and authentication wording; a match sets the same `rate_limited` / `auth_error` end reason as the other arms, so the run pauses and is requeued instead of being scored as a quality failure.
- Authentication. The SDK starts the Claude Code executable, so it uses `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) when set in the environment and otherwise the `claude` login. In a campaign with the SDK arm the preflight therefore passes when one of those variables is set (its value is never printed) and otherwise falls back to `claude auth status`. `runEnv` strips `ORCH_*` only, so `ANTHROPIC_*` passes through. Not verified live.
- Cost. O-mix medians were about 4.7M tokens per run, so the 8 runs of `sdk-vs-native.json` are roughly 40M tokens plus the SDK's own spend. `ORCH_BUDGET_TOKENS` (a cell's `budget_tokens`) becomes `--budget` for the SDK; this campaign sets none.
- No claims. The SDK prints no result claim, so its false-success rate is not meaningful.

## Outputs

- `runs/bench/<campaign>/`: `manifest.json`, `runs.jsonl`, one folder per run (snapshots and final), later `grades.jsonl`, `grades-cache.json`, `summary.json`, reports.
- Run repos: `~/orch-bench/<campaign>/<run_id>` (override the base with `BENCH_REPOS_DIR`).

## Isolation

Every user-enabled plugin is disabled in each run repo's `.claude/settings.json` (`enabledPlugins` set to false), and the runner checks the result with `claude plugin list --json` before launching. A run whose repo still shows an enabled plugin is not launched and ends with `end_reason` `error`, error `isolation`. `--check-isolation` runs the check alone. Inherited `ORCH_*` variables are stripped from each run's environment.

## Pacing and interruption

- Runs that share (task, cell, rep) form a block; its arms start together so they share rate-limit conditions. Block order is shuffled with the seeded PRNG.
- Create `<campaign dir>/PAUSE` to hold before the next block; remove it to continue.
- A rate-limited run creates `PAUSE` itself and is requeued; it is excluded from statistics until it finishes.
- SIGINT, SIGTERM or a crash terminates every live run's process group (kill after 8 s) and exits non-zero. An interrupted run writes no row.
- `--resume runs/bench/<campaign>` reruns what has no finished row, keeping the campaign's seed and block order.

## Task contract

A task is a folder `bench/tasks/<id>/`:

- `task.md`: the prompt the run receives.
- `meta.json`: `id` (equals the folder name), `title`, `tier` (small, medium, large), `shape` (parallel, single, dependent, monolithic, splittable), `lang` (node, python), `cap_min`, `total` (number of hidden checks, optional but expected), `test_cmd` (exported as `ORCH_TEST_CMD`, or `null`), `graded_paths` (what a snapshot hash covers), `snapshot_every_s`.
- `setup/`: the starting repo contents (stub code, public tests).
- `ref/`: a reference solution, copied over `setup/`.
- `score.mjs`: exports `score(dir)` returning `{pass, passed, total, ...}`. Node tasks with a `hidden.test.js` can reuse `scoreNodeHidden` from `bench/lib/score.mjs`. The hidden tests live outside `setup/`, so a run never sees them.
- `mutants.json`: a list of `{name, file, from, to}` edits; each must occur exactly once in `file` of the reference and make `score` fail.

## Adding a task

1. Create the folder with the files above; write `task.md` so the stub, public tests and cap make the task solvable but not trivial.
2. Add the id to the arrays in `bench/analyze.mjs` and `bench/report.mjs` and to the matrices that should run it.
3. Run `npm run bench:validate -- --task <id>` until it passes, then `npm test`.

## Cost is reported in tokens only

Token totals come from each run's result JSON (`scripts/tokens.mjs`), per model. No money figures appear in any output or doc; dollar fields in raw inputs are ignored. Budget cells set `ORCH_BUDGET_TOKENS`, which claude enforces through its dollar limit at 1M tokens per dollar, so the runs report their actual token use.
