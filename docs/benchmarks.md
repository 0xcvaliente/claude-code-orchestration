# Benchmarks

Four runs compare the orchestrator with a plain session. Every cell is a single run, so read these as evidence about direction, not as measurements with error bars.

**Token counts.** A count is input, output, cache-read and cache-write tokens over every model. Run 4 and the triage calls are exact (Run 4 from the CLI's per-model `modelUsage`, triage from its session transcripts). Runs 1 to 3 and the live checks logged only list-price dollars per model, so their counts are estimates, marked ≈: each model's dollars times the tokens per dollar measured on runs that logged both. That is 600k for an Opus orchestrator or advisor (Run 4's orchestrator: 288,087 tokens for $0.48), 570k for a Sonnet session under two minutes (four SDK pipeline workers: 203,575 tokens for $0.36) and 1.83M for a Sonnet session in a long run (Run 4's workers: 4,383,685 tokens for $2.39). Measured runs ranged from about 180k to 1.8M tokens per dollar, so one estimate can be off by up to about 2x. Token counts do not weigh models: at list price an Opus 5.5 token costs twice a Sonnet 5.5 token.

**Short version:** the pipeline never beat a plain Sonnet session on correctness, used about 0.8x to 2.2x the tokens, was slower on small tasks and faster on parallel ones. That is why [triage](../README.md#choosing-a-route-triage) exists.

## How the benchmark works

`npm run compare` runs tasks under several setups in fresh git repos (`~/orch-compare`) and scores each with hidden tests the agent never sees. `npm run compare:validate` checks the hidden tests against reference solutions with no model calls.

| Variant | Setup |
|---|---|
| A | Opus orchestrator (native agent) |
| B | Sonnet orchestrator plus an Opus advisor |
| C | Plain Sonnet session (`ORCH_MODEL=sonnet`) |
| F | Plain Opus session (`ORCH_MODEL=opus`) |
| D | Sonnet orchestrator, no advisor |
| E | Auto: triage picks plain, reviewed or the orchestrator per task (`scripts/auto.sh`) |

Results land in `runs/compare/` as JSONL and a Markdown table. The Markdown starts with a summary per task and variant (pass rate k/N, mean and min-max tokens, mean wall time), then lists every run.

Options:

- `--repeat N` (default 1) runs each task and variant N times. Rows carry `rep`.
- `--timeout <sec>` (default 3600) kills the agent's whole process group after that long.
- `--snapshot-every <sec>` (default off) copies the run directory (without `.git`, `node_modules`, `.claude`) to `<out>/snapshots/<stamp>/<task>-<variant>-<rep>/t<secs>` at that interval. After the run, every snapshot and the final tree are scored. The row gets `timeline` (`[seconds, tests passed]` pairs) and `first_pass_s` (first passing snapshot, or null).

A task may carry `setup/` (copied into the run repo before the first commit) and `score.mjs` (exports `score(runDir)` and replaces `node --test hidden.test.js`). `--validate` uses the same scorer: the stub-only repo must fail and `ref/` must pass. A task may also declare its own test command in `test-cmd.txt` (first line, e.g. `python3 tests/run_public.py` for h3-sql-engine): `compare.mjs` passes it to the run as `ORCH_TEST_CMD`, so the headless allowlist gets the matching rule (otherwise `dontAsk` denies the command the task text tells the agent to run) and the verify gate runs that command instead of the seeded `node --test`. A task with `test-cmd.txt` gets no seeded `package.json`.

Tasks: `t1-parallel`, `t2-single`, `t3-dependent`, `h1-query-engine`, `h2-scheduler` and `h3-sql-engine`. h3 is the 30-minute minisql task: implement an in-memory SQL engine in Python from `SPEC.md`, scored by a hidden differential grader against SQLite (322 tests, about a minute to run). Its `hidden/` grader is never copied into the run repo.

## Run 1: easy tasks (2026-10-13)

Three tasks (parallel, single, dependent), one run per cell. All 9 runs passed every hidden test.

| Setup | Tokens per task (t1 / t2 / t3) | Wall time (t1 / t2 / t3) |
|---|---|---|
| A: Opus orchestrator | ≈230k / ≈130k / ≈190k | 64s / 43s / 65s |
| B: Sonnet orchestrator + Opus advisor | ≈260k / ≈130k / ≈160k | 110s / 79s / 85s |
| C: Plain session (Sonnet) | ≈120k / ≈62k / ≈85k | 20s / 22s / 36s |

The tasks were too easy to separate the setups on correctness, and the orchestrator roughly doubled tokens (2.0x to 2.2x) and tripled time. The advisor billed Opus tokens in only one of three B runs, so it was consulted rarely.

## Run 2: harder tasks (2026-10-13)

A SQL query engine and a job-scheduler simulator, 13 hidden tests each. 7 of 8 runs passed 13/13.

| Task | C: plain session | A: Opus orchestrator | D: Sonnet orchestrator | B: Sonnet + Opus advisor |
|---|---|---|---|---|
| Query engine | ≈2.5M, 508s, pass | ≈1.9M, 308s, pass | ≈4.7M, 805s, pass | ≈4.7M, 875s, pass |
| Scheduler | ≈1.9M, 397s, pass | ≈2.3M, 250s, pass | ≈3.0M, 519s, pass | ≈1.2M, 1636s, FAIL |

- Still no correctness separation: the plain session also passed both.
- The Opus orchestrator was the fastest setup on both tasks (parallel slices), at about 0.8x to 1.2x the plain session's tokens.
- A Sonnet orchestrator launched more agents (5 implementers and 5 reviewers on the query engine) and used about 1.6x to 1.9x the tokens.
- The advisor setup added time (1.9x the tokens on the query engine) and had the only failure. The orchestrator ended its turn ("waiting for completion") while its one implementer was still running, with no root `index.js`. The task text then did not say where `index.js` lives; it does now, and the orchestrator prompt now forbids ending a reply while workers run. B on the scheduler should be rerun before it counts against the advisor.

## Run 3: auto routing (2026-10-14)

Easy tasks `t1-parallel` and `t2-single`, one run per cell. E excludes the triage call, 32k tokens on t1-parallel and 21k on t2-single (exact).

| Task | C: plain session | A: Opus orchestrator | E: auto | E routed to |
|---|---|---|---|---|
| t1-parallel | ≈120k, 20s | ≈260k, 68s | ≈260k, 70s | pipeline |
| t2-single | ≈59k, 18s | ≈110k, 46s | ≈58k, 27s | plain |

All six runs passed every hidden test. Triage picked the route a person would have, so auto paid pipeline token use only on the parallel task and plain-session use on the single one. On `t1-parallel` the pipeline still used about twice the plain session's tokens (2.2x) for the same result, so these tasks are too easy to say the parallel route was worth choosing; the `minParallelFiles` threshold may be too eager. Treat this run as a smoke test of the router.

## Run 4: 30-minute minisql head-to-head (2026-10-14)

An Opus orchestrator (plugin 0.1.1) against a plain Opus session on the minisql task (`h3-sql-engine`), run concurrently with a 30-minute cap. Scored on 322 hidden tests, plus a 1,062-test stress suite added after the first one saturated. One run per arm.

| Setup | Hidden tests | Stress tests | Tokens | Wall time |
|---|---|---|---|---|
| Orchestrator (Opus) | 322/322 | 1,062/1,062 | 4.7M (Opus 0.29M, Sonnet 4.4M) | 22:33 |
| Plain Opus session | 322/322 | 1,062/1,062 | 8.4M | 18:17 |

- Both arms reached 322/322 at the first scored snapshot (6:01), so the task saturated in about 6 minutes and the rest of the time measured polish, not correctness.
- The orchestrator took the light path: one Sonnet implementer and 5 implement-review rounds. Most of its tokens were its Sonnet subagents'.
- The review gate recorded no status for 10 of 13 subagent stops. The fix lives in plugin 0.1.2: its telemetry hook reads the status from the subagent's SubagentHandback message in its transcript. It ships in the same release as this benchmark change.
- With one run per arm, the token gap (4.7M against 8.4M) and the time gap are not evidence of a difference. Use `--repeat` and `--snapshot-every` to measure it.

## Live checks of the router (2026-10-14)

Throwaway repo, one small task ("create `clamp.js` with tests"):

| Route | Result | Tokens |
|---|---|---|
| SDK `--mode auto` (triage chose plain) | tests pass | ≈28k |
| SDK `--mode reviewed` | tests pass, review pass, 1 session | ≈51k |
| Native orchestrator, light path | 1 implementer, 1 reviewer; test gate and review gate both allowed | ≈150k |
| Native `npm run auto` (triage chose plain) | completed | ≈57k |

## Not yet exercised live

Escalation, resume, replan and the retry backoff are covered by unit tests only. The second Opus reviewer (needs a `risky` slice), `omitClaudeMd` and the scripted workflow have not run live either.
