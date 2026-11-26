# Benchmark

The benchmark measures whether orchestration pays off. It runs the same tasks under orchestrated and plain Claude Code sessions, each with a hard wall-clock cap. Every run is graded offline with hidden tests.

Cost is reported in tokens only, never in money: totals come from each run's result JSON, per model (`scripts/tokens.mjs`), and dollar fields in raw inputs are ignored. Running it is paid: every `npm run bench` campaign starts real model sessions.

This page is for maintainers: running the benchmark, reading a result, adding a task or an arm, and the plugin [eval suite](../docs/glossary.md#e). It describes the harness as it is at 2.2.

What the campaigns found: [RESULTS.md](RESULTS.md) and the generated report [docs/benchmarks.md](../docs/benchmarks.md). The plugin itself: [the root README](../README.md).

The main comparisons are model-matched [arms](../docs/glossary.md#a). The orchestrator with shipped models (`O-mix`) runs against plain Sonnet (`P-S`). The orchestrator with every agent on Opus (`O-O`) runs against plain Opus (`P-O`). Pre-registered hypotheses and verdict rules: [HYPOTHESES.md](HYPOTHESES.md).

## Quick start

```bash
npm run bench:validate                                       # free: checks every task's graders, no model calls
npm run bench -- --matrix bench/matrix/pilot.json            # paid: 1 rep, a smoke test of the whole harness
npm run bench:grade -- runs/bench/<campaign>                 # offline: grade the snapshots
npm run bench:analyze -- runs/bench/<campaign>               # offline: summary.json
npm run bench:report -- runs/bench/<campaign>/summary.json   # offline: report.html
```

Each campaign is one matrix file, listed in "Commands, in order"; what it writes is in "Outputs".

## Arms

Defined in `ARMS` in `bench/arms.mjs`. Every arm except `SDK` goes through the product scripts unmodified.

| Arm | What runs |
| --- | --- |
| `P-S` | Plain Sonnet session (`scripts/orchestrate.sh`, `ORCH_AGENT=none`, `ORCH_MODEL=sonnet`, no `.claude/` copied) |
| `P-O` | Plain Opus session (same, `ORCH_MODEL=opus`) |
| `O-mix` | Orchestrator with agents as shipped (this repo's `.claude/` copied in) |
| `O-O` | Orchestrator with every agent's `model:` line rewritten to Opus |
| `AUTO` | `scripts/auto.sh`: [triage](../docs/glossary.md#t) picks plain, reviewed or the orchestrator. `.claude/` copied in; the run repo's settings set the model to sonnet |
| `N-UC` | Native ultracode: Claude Code as shipped, model Opus, no `.claude/` copied. Built-in and fork subagents allowed, `Workflow` allowed |
| `W-mix` | The shipped [gated workflow](../docs/glossary.md#g): `.claude/` copied in, `scripts/orchestrate.sh` with `ORCH_AGENT=none` and the prompt `/orchestrate {"task":<task prompt>,"code":true,"baseRefHead":true}`. `Workflow` allowed |
| `O-mix-plugin` | Orchestrator from this checkout's plugin build `dist/plugin`, loaded with `--plugin-dir` by `bench/lib/plugin-launch.sh`. `ORCH_AGENT_PREFIX=orchestration:`, no `.claude/` copied, shipped models |
| `O-mix-030` | The same with an older plugin build: `dist/plugin` at commit `d207cb8` (`BASELINE_030_REF`), extracted once with `git archive` into `<tmpdir>/orch-bench-plugin/d207cb8/` |
| `all-haiku` | `O-mix` with the researcher's `model:` line rewritten to haiku and `ORCH_ALLOW_HAIKU=1`; the other agents keep their shipped models. For the `d2-docs` reading comparison (H14) |
| `all-sonnet` | `O-mix` with `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1` and `CLAUDE_CODE_SUBAGENT_MODEL=sonnet`: every [worker](../docs/glossary.md#w) runs on sonnet, not the researcher alone |
| `routed` | `O-mix` with `ORCH_READ_ROUTER=on` and shipped models, so the researcher runs on sonnet |
| `reader-haiku` | The `d3-reader` arms (H14-d3): a plain sonnet session with this repo's `.claude/` copied in, so the project researcher and the hooks are present (`READER_ENV`). The researcher is rewritten to haiku, with `ORCH_ALLOW_HAIKU=1` |
| `reader-sonnet` | The reader session with every worker forced to sonnet as in `all-sonnet` (every worker here is a researcher) |
| `reader-routed` | The reader session with `ORCH_READ_ROUTER=on` and the researcher as shipped (sonnet). The router never lowers a model, so here it only adds converted-text notes to the brief |
| `SDK` | The [SDK pipeline](../docs/glossary.md#s), `npx tsx src/cli.ts --mode orchestrate`; no `.claude/` copied ("The SDK arm") |

- **`N-UC`.** The orchestration plugin and this repo's agents and hooks are not loaded. The prompt is `ultracode Use a workflow (the Workflow tool) to orchestrate this task.` followed by the task prompt (`NUC_PREFIX`). `bench/lib/native-launch.sh` launches it, so that native subagents are not blocked ([how the launcher works](RESULTS.md#short-documentation-run)). For `N-UC` and `W-mix`, the row's `workflow_runs` records whether a workflow ran.
- **`O-mix-plugin` and `O-mix-030`.** The launcher keeps the two exports that block built-in and fork subagents, and sets `ORCH_NO_NUDGE=1`. Where their hook logs land: [RESULTS.md, compare-040](RESULTS.md#comparison-run-for-040-compare-040).
- **Reader arms.** `READER_ENV` is `ORCH_AGENT=none`, `ORCH_MODEL=sonnet`, `ORCH_SESSION_PERSISTENCE=1` and `ORCH_OUTPUT_STYLE=default`.
- **Haiku arms.** The researcher ships on sonnet; the haiku arms rewrite it (the `agentModels` field), and `ORCH_ALLOW_HAIKU=1` keeps the plan check from raising it back. So `all-haiku` → `routed` and `reader-haiku` → `reader-routed` compare a haiku researcher with a sonnet researcher plus the router's notes. Arm ids are unchanged, so old results load ("Before 2.1").
- **Plain sessions keep the default output style.** Every arm that starts a plain session through `scripts/orchestrate.sh` sets `ORCH_OUTPUT_STYLE=default`: `P-S`, `P-O`, `W-mix`, `N-UC`, the three reader arms, and `AUTO` for its plain and reviewed routes. Without it a plain session gets the Concise [output style](../docs/glossary.md#o).

## Tasks

Each task is a folder `bench/tasks/<id>/`. The cap is the task's own wall-clock limit (`cap_min`); a matrix cell can override it.

| Task | Tier | Shape | Cap | Language |
| --- | --- | --- | --- | --- |
| `t1-parallel` | small | parallel (two independent modules) | 10 min | node |
| `t2-single` | small | single (duration parser) | 10 min | node |
| `c1-unit-registry` | small | splittable (six unit-conversion modules behind one shared registry) | 5 min | node |
| `d1-handbook` | small | splittable (a security handbook from four policy sources) | 5 min | node |
| `h1-query-engine` | medium | splittable | 30 min | node |
| `h2-scheduler` | medium | splittable | 30 min | node |
| `k1-stdlib-toolkit` | large | splittable (4 modules: toml 124, shlex 68, regex 205, csv 106 hidden cases; 503 total) | 30 min | python |
| `h3-sql-engine` | large | monolithic (minisql, matched against SQLite) | 30 min | python |
| `k2-stdlib-toolkit-xl` | large | splittable (12 modules: k1's four plus ipaddr, fraction, urls, b64, diff, wrap, jsonx, cal; 1,762 hidden tests) | 30 min | python |
| `d2-docs` | small | parallel (seven questions over seven documents) | 8 min | python |
| `d3-reader` | small | parallel (twelve questions over seven documents, one researcher each) | 8 min | python |

`c1-unit-registry` and `d1-handbook` were built for the O-next comparison and have not been run ([docs/benchmark-onext.md](../docs/benchmark-onext.md)).

**`d2-docs`** asks seven questions, one per document kind (the kinds are listed in the 2026-10-31 amendment of [HYPOTHESES.md](HYPOTHESES.md)). `gen/make_docs.py` makes the documents in `setup/docs/`. The run writes `answers.json`, whose format `python3 tools/check.py` checks. `score.mjs` grades each answer (exact, regex, or a number within a tolerance) and tags its category (`txt`, `pdf-text`, `pdf-table`, `pdf-scan`, `xlsx-formula`, `chart`, `pdf-long`).

**`d3-reader`** makes the [read router](../docs/glossary.md#r) run: a `d2-docs` campaign launched no researcher, so the router never fired there. Its twelve questions, its briefs and its hard kinds (q3 to q11): [docs/benchmark-route-040.md](../docs/benchmark-route-040.md). `task.md` tells the main session not to read the documents.

- `HARD` in its `score.mjs` and `READER_HARD` in `bench/analyze.mjs` give the hard and easy accuracy; a test keeps the two equal.
- It is not in `analyze.mjs`'s `TASKS`, so the older hypothesis loops ignore it.

**`k1-stdlib-toolkit`** (test command `python3 tests/run_public.py`, graded path `toolkit`) is graded in a sandbox. The stdlib oracle modules are blocked, and using them in any way scores that module 0.

**Graders of k1, k2 and h3.** Their `score.mjs` runs its command-line block through the real-path entry guard, so a grader called through a symlinked path still prints its grade.

**Python version for k1 and k2.** `hidden/grade.py` grades against Python 3.13's standard library and re-runs itself under `python3.13` (or `K2_PYTHON`) when it finds one. Under 3.14 or later it grades the cases in that task's `hidden/py313.py` (two for k1, eight for k2) against recorded values ([docs/limits.md](../docs/limits.md), G).

## Commands, in order

Each campaign is a paid run of one matrix: `npm run bench -- --matrix bench/matrix/<file>`.

| Matrix file | What it runs |
| --- | --- |
| `pilot.json` | 1 rep: t2 on the five main arms, k1 and h3 at 10 min (smoke test of the whole harness) |
| `lite.json` | 2 reps: six tasks (t1, t2, h1, h2, k1, h3), five arms, main cell |
| `pilot-k2.json` | 1 rep: k2, P-O and O-mix, main cell |
| `lite-k2.json` | 2 reps: k2, five arms, main cell (10 runs) |
| `sweeps.json` | k2 only, P-O vs O-mix, caps 10 and 60 min, budgets 3M and 8M tokens (16 runs) |
| `k2-cap10.json` | 2 reps: k2 at cap10, P-S, P-O, O-mix and O-O |
| `sdk-vs-native.json` | k2 at cap10, O-mix vs SDK, 4 reps (8 runs); H8, see "The SDK arm" |
| `short-k2.json` | 1 rep: k2 at cap10, O-mix vs N-UC vs W-mix in one block (~10-15 min); direction only |
| `compare-040.json` | O-mix-plugin vs O-mix-030 on k2 (1 rep), the d2-docs reading arms at cap6 (2 reps); direction only |
| `route-040.json` | d3-reader, reader-haiku vs reader-sonnet vs reader-routed, 2 reps (~2 min run, 20 min worst case); direction only |

The five main arms are `P-S`, `P-O`, `O-mix`, `O-O` and `AUTO`. `bench/matrix/k2-cap10-onext.json` is data only: `run.mjs` rejects its `O-next` arm, which no longer exists.

**Why k2 has its own campaigns.** k1 and h3 saturate within minutes, so H1 and the sweeps (H7) use k2, with its own main campaign `lite-k2` (amendment in [HYPOTHESES.md](HYPOTHESES.md)).

**Matrix files.** A [matrix](../docs/glossary.md#m) file has `name`, `seed` and `groups`. Each group lists `tasks`, `arms`, `cells` (`id`, plus `cap_min` or `budget_tokens`) and `reps`. A file may also set `parallel_blocks`; `--parallel-blocks` overrides it. A budget cell sets `ORCH_BUDGET_TOKENS`, which claude enforces through its dollar limit at 1M tokens per dollar (`TOKENS_PER_USD`); the runs still report their token use.

**Flags.**

- `bench/run.mjs`: `--matrix <file>`, `--campaign <name>`, `--resume <campaign dir>`, `--dry-run` (prints each run's command and environment additions), `--only <substring of run_id>`, `--parallel-blocks N`, `--seed N`, `--tasks-dir <dir>`, `--check-isolation`.
- `bench/grade.mjs`: `--jobs N`, `--only <substring>`, `--final-only`, `--tasks-dir <dir>`, `--variant lenient`. Identical (task, content hash) pairs are graded once (`grades-cache.json`). Finished (run, snapshot) pairs are skipped, so grading can be rerun.
- `bench/validate.mjs`: `--task <id>`, `--tasks-dir <dir>`, `--parallel N`, `--deadline-s S`.
- `bench:analyze` accepts several campaign folders (pooled) and `--out`. `bench:report` takes `--html` and `--md`.

## The SDK arm

Compares the SDK pipeline (`src/cli.ts`) with `O-mix` on k2 at a 10-minute cap. H8 in [HYPOTHESES.md](HYPOTHESES.md) pre-registers the comparison and lists the known differences between the arms. It also covers how a capped SDK run is graded, its missing snapshots (`snapshots: "none"`), its token undercount and `sdk_test_cmd`.

The 4-rep matrix has not been run as one campaign. Four single pairs ran as separate campaigns on 2026-10-21; their H8 verdict and its caveats are in HYPOTHESES.md, and this page claims no result.

The SDK-specific code is `bench/lib/sdk.mjs`; run-exec makes one call into it. The command is `npx tsx src/cli.ts --repo <run repo> --task <prompt> --mode orchestrate --no-escalate --out <run dir>/sdk [--test-cmd <task test_cmd>] [--budget <tokens>]`.

- **Result.** The harness merges `orch/<runId>/result`, or for a capped run each passed slice's branch, into the working tree before grading. `sdk-adapter.json` records what was merged and skipped.
- **Tokens.** From `report.json` `spentTokens` when present, else the sum of `tokens` in `telemetry.jsonl`.
- **Errors.** Rate-limit and authentication wording sets the same `rate_limited` / `auth_error` end reason as the other arms, so the run is requeued, not scored as a failure.
- **Authentication.** `ANTHROPIC_API_KEY` (or `CLAUDE_CODE_OAUTH_TOKEN`) when set, else the `claude` login; the preflight never prints the value. `runEnv` strips `ORCH_*` only, so `ANTHROPIC_*` variables pass through. Not checked live.
- **Size.** O-mix medians were about 4.7M tokens per run, so the 8 runs are roughly 40M tokens plus the SDK's own spend. A cell's `budget_tokens` becomes `--budget`; this campaign sets none.
- **No claims.** The SDK prints no result claim, so its false-success rate is not meaningful.

## Isolation

- Every user-enabled plugin is disabled in each run repo's `.claude/settings.json` (`enabledPlugins` set to false).
- The runner checks the result with `claude plugin list --json` before launching. A run whose repo still shows an enabled plugin is not launched; it ends with `end_reason` `error`, error `isolation`.
- `--check-isolation` runs the check alone.
- Inherited `ORCH_*` variables are stripped from each run's environment. An arm's own `ORCH_*` settings are applied after that.
- A plugin arm loads its plugin with `--plugin-dir`, which is not an installed plugin, so the isolation check does not see it.

## Pacing and interruption

- Runs that share (task, cell, rep) form a block. Its arms start together, so they share rate-limit conditions. Block order is shuffled by the seed.
- Create `<campaign dir>/PAUSE` to hold before the next block; remove it to continue.
- A rate-limited run creates `PAUSE` itself and is requeued. It is excluded from statistics until it finishes.
- SIGINT, SIGTERM or a crash ends every live run's process group (kill after 8 s) and exits non-zero. An interrupted run writes no row.
- `--resume runs/bench/<campaign>` reruns what has no finished row, keeping the campaign's seed and block order.

## Outputs

- `runs/bench/<campaign>/`: `manifest.json`, `runs.jsonl`, one folder per run (snapshots and final), later `grades.jsonl`, `grades-cache.json`, `summary.json` and the reports.
- Run repos: `~/orch-bench/<campaign>/<run_id>` (override the base with `BENCH_REPOS_DIR`).

## Grading and reading a result

`bench:grade` writes `grades.jsonl`, `bench:analyze` writes `summary.json` (token metrics, comparisons, hypothesis verdicts), and `bench:report` writes `report.html` and `benchmarks.md`. The strict score is official.

**Validating the tasks.** `npm run bench:validate` checks, with no model call, that each task's stub fails, its reference passes, every mutant is caught and `meta.total` matches. How it runs tasks side by side and its 270 s deadline: [docs/development.md](../docs/development.md#benchmark-and-eval-suite).

- Exit codes: 0 every task valid, 1 a task failed or no task matched, 3 the deadline, 130 on SIGINT or SIGTERM.
- `bench/eval-graders.test.mjs` checks the deadline: the caller survives, and no grader or scratch folder is left.

**Claims.** `bench/lib/claims.mjs` reads each run's final message and classifies its claim: success, partial, failure, unclear or none. A [false success](../docs/glossary.md#f) is a claimed success whose hidden grade fails.

- The template line `STATUS: pass or fail` (also with `/` or `|`) is not a claim.
- An optional `<campaign>/claims-audit.json`, mapping a run id to a `claim` (one of the five) and a `note`, overrides the rules-based claim for false-success counts and H4. The automatic claim stays as `claim_auto`, and the report shows both.

**Lenient variant** (k2 only). `node bench/grade.mjs <campaign> --variant lenient` grades `final/` only into `grades-lenient.jsonl`; other tasks are skipped with a note.

- `re` may be imported by any toolkit module except `toolkit/regex.py` (task rule 2 otherwise zeroes a module that imports it). Regex cases stay watched, and flags carry a `lenient:` prefix.
- `analyze.mjs` then adds `score_pct_lenient`, `pass_lenient` and `score_median_lenient`, and the report a lenient column for k2. Hypotheses use the strict score.

**Triage tokens.** `analyze.mjs` adds each logged route's tokens to a run's total as `by_model.triage`. A campaign is dated by `plugin_version` in its `manifest.json`.

When that version is below `TRIAGE_FIX_VERSION` (in `bench/analyze.mjs`) or missing, every run with triage tokens gets `triage_pre_fix: true`, and `summary.json` a footnote in `notes`, which the report lists under Caveats. The tokens are left as logged ("Before 2.1" says why they are high). To compare `AUTO` with other arms on the current triage, run a new campaign.

**Paired differences and pass^k.** `analyze.mjs` adds two sections to `summary.json` and prints both after the cells.

- `paired`: for each pair in `PAIRS` (`O-mix-030` → `O-mix-plugin`, `all-haiku` → `all-sonnet`, `all-haiku` → `routed`, `all-sonnet` → `routed`) and each metric (`score_pct`, `pass`, `tokens`), runs that share (task, cell, rep) are paired and B − A is taken. It reports the mean, its standard error clustered by task (CR1), a normal 95% interval and the mean per task.
- With fewer than 2 tasks the SE is null; below 3 tasks or 3 pairs a comparison is marked `direction_only`.
- `pass_k`: per (task, arm, cell), the reps `n`, passes `c`, pass@1 = c/n, and pass^k, the unbiased estimate C(c,k)/C(n,k) that all k attempts pass, for k = n and, when n ≥ 2, k = 2. It measures how reliably an arm gets every run right, not its average.

**Reader metrics and run validity.** For every `reader-*` or `d3-reader` run, `analyze.mjs` (`readerOf`) adds a `reader` object:

- `researcher_launches` and `researcher_stops`, from [telemetry](../docs/glossary.md#t)'s SubagentStart and SubagentStop records.
- `researcher_tokens` (all four token kinds) and `researcher_output_tokens`, from each researcher's last SubagentStop (a stop the quote check blocked is already included); null when no stop carries tokens. Also `researchers_with_tokens` and `researcher_models`.
- `route_decisions`, `routed_launches` and `raised`, from `state/reads-route.jsonl`; `hard_pct` and `easy_pct`, from the final grade's `by_cat`.

Invalid runs (rule in [HYPOTHESES.md](HYPOTHESES.md), H14-d3) are excluded like rate-limited ones and listed in `reader.invalid`. `reader.cells` holds per-cell medians over valid runs. `paired` also gets `READER_PAIRS` (`reader-haiku` → `reader-routed`, `reader-sonnet` → `reader-routed`, `reader-haiku` → `reader-sonnet`), with `researcher_tokens` and `hard_pct` added.

**Per-agent tokens need `ORCH_SESSION_PERSISTENCE=1`.** Without it headless runs keep no subagent transcripts, so telemetry's per-agent fields stay empty ([Telemetry](../docs/logs.md#telemetry)). Of the arms, only the reader arms set it.

## Adding a task or an arm

A task is a folder `bench/tasks/<id>/`:

- `task.md`: the prompt the run receives.
- `meta.json`: `id` (equals the folder name), `title`, `tier` (small, medium, large), `shape` (parallel, single, dependent, monolithic, splittable), `lang` (node, python), `cap_min`, `total` (number of hidden checks, optional but expected), `test_cmd` (exported as `ORCH_TEST_CMD`, or `null`), `graded_paths` (what a snapshot hash covers), `snapshot_every_s`. Optional: `sdk_test_cmd` ("The SDK arm").
- `setup/`: the starting repo contents (stub code, public tests).
- `ref/`: a reference solution, copied over `setup/`.
- `score.mjs`: exports `score(dir)` returning `{pass, passed, total, ...}`. Node tasks with a `hidden.test.js` can reuse `scoreNodeHidden` from `bench/lib/score.mjs`. The hidden tests live outside `setup/`, so a run never sees them.
- `mutants.json`: a list of `{name, file, from, to}` edits. Each must occur exactly once in `file` of the reference and make `score` fail.

To add a task:

1. Create the folder with the files above. Write `task.md` so the stub, public tests and cap make the task solvable but not trivial.
2. Add the id to `TASKS` in `bench/analyze.mjs` and `bench/report.mjs`, and to the matrices that should run it.
3. Run `npm run bench:validate -- --task <id>` until it passes, then `npm test`.

To add an arm:

1. Add the arm to `ARMS` in `bench/arms.mjs`: its label, its launcher or product script, its `ORCH_*` environment, and whether this repo's `.claude/` is copied in.
2. Add its id to `ARMS` in `bench/analyze.mjs` (and in `bench/report.mjs` when the report should show it), and to the matrices that should run it.
3. Describe it in the "Arms" table above.
4. Check the command it builds with `node bench/run.mjs --matrix <file> --dry-run`, then run `npm test`.

## Plugin eval suite

`npm run eval` runs `claude plugin eval` on the built plugin, `dist/plugin`, with the cases in `evals/`. It compares sessions with and without the plugin. It is paid; its `--max-cost-usd` cap is a `claude plugin eval` option, not a benchmark figure.

```sh
npm run eval                                                                 # every case; capped by --max-cost-usd 10
npm run eval -- --case t2-single --runs 1 --ablation none --max-cost-usd 2   # a bounded smoke run of one case
```

- **Cases.** `evals/` holds eight cases. Four come from bench tasks: `t2-single`, `t1-parallel`, `c1-unit-registry` and `d1-handbook`. Four come from project failures: `e1-shared-file`, `e2-research-notes`, `e3-constraint-answered` and `e4-plan-before-build`. Each has a `case.yaml`, a `prompt.md`, a `scaffold.sh` and a `graders/` folder.
- **Graders** call no model: `regex`, `file_exists` and `tool_used`.
- **The copy it runs.** `npm run build-plugin` copies `evals/` into `dist/plugin/evals/`, and the eval reads that copy. After a change to a case or grader, rebuild before you run it.
- **Smoke run.** On 2026-11-10 the bounded command ran end to end, with 4 of 7 graders passing ([docs/development.md](../docs/development.md#benchmark-and-eval-suite); failures: [docs/research-2026-11-10.md](../docs/research-2026-11-10.md), "Open"). The graders changed after it ([CHANGELOG.md](../CHANGELOG.md)); no eval has run since.

## Results

<a id="comparison-run-for-040-compare-040"></a><a id="read-router-benchmark-route-040"></a>Every campaign, with its date, versions, tables and caveats, is in [RESULTS.md](RESULTS.md); the O-next campaign of 2026-10-16 is in [docs/benchmark-onext.md](../docs/benchmark-onext.md). All campaigns are headless, on coding or document tasks only, with 1 or 2 runs per setup: they show direction, not measurements.

### Before 2.1

- No campaign has been run on 2.1 or 2.2. All five in RESULTS.md ran on plugin 0.1.5 to 0.4.0.
- The researcher shipped on haiku in 0.4.0 and ships on sonnet since 1.3.0. The published `routed` and `reader-routed` runs used a haiku researcher.
- `O-mix-030` is the 0.3.0 plugin. `TRIAGE_FIX_VERSION` is 1.5.1: before it the triage call carried the claude.ai connectors' MCP tools. That call took 437,331 tokens instead of 14,030 ([docs/data/live-checks-2026-11-16.md](../docs/data/live-checks-2026-11-16.md), Check 10), so older `AUTO` rows overstate triage.
- Release detail: [CHANGELOG.md](../CHANGELOG.md).
