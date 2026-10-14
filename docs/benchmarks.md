# Benchmarks

Four runs compare the orchestrator with a plain session. All costs are list price (an estimate, not what a subscription bills). Every cell is a single run, so read these as evidence about direction, not as measurements with error bars.

**Short version:** the pipeline never beat a plain Sonnet session on correctness, cost 1.1x to 2x more, was slower on small tasks and faster on parallel ones. That is why [triage](../README.md#choosing-a-route-triage) exists.

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

Results land in `runs/compare/` as JSONL and a Markdown table. The Markdown starts with a summary per task and variant (pass rate k/N, mean and min-max cost, mean wall time), then lists every run.

Options:

- `--repeat N` (default 1) runs each task and variant N times. Rows carry `rep`.
- `--timeout <sec>` (default 3600) kills the agent's whole process group after that long.
- `--snapshot-every <sec>` (default off) copies the run directory (without `.git`, `node_modules`, `.claude`) to `<out>/snapshots/<stamp>/<task>-<variant>-<rep>/t<secs>` at that interval. After the run, every snapshot and the final tree are scored. The row gets `timeline` (`[seconds, tests passed]` pairs) and `first_pass_s` (first passing snapshot, or null).

A task may carry `setup/` (copied into the run repo before the first commit) and `score.mjs` (exports `score(runDir)` and replaces `node --test hidden.test.js`). `--validate` uses the same scorer: the stub-only repo must fail and `ref/` must pass. A task may also declare its own test command in `test-cmd.txt` (first line, e.g. `python3 tests/run_public.py` for h3-sql-engine): `compare.mjs` passes it to the run as `ORCH_TEST_CMD`, so the headless allowlist gets the matching rule (otherwise `dontAsk` denies the command the task text tells the agent to run) and the verify gate runs that command instead of the seeded `node --test`. A task with `test-cmd.txt` gets no seeded `package.json`.

Tasks: `t1-parallel`, `t2-single`, `t3-dependent`, `h1-query-engine`, `h2-scheduler` and `h3-sql-engine`. h3 is the 30-minute minisql task: implement an in-memory SQL engine in Python from `SPEC.md`, scored by a hidden differential grader against SQLite (322 tests, about a minute to run). Its `hidden/` grader is never copied into the run repo.

## Run 1: easy tasks (2026-10-13)

Three tasks (parallel, single, dependent), one run per cell. All 9 runs passed every hidden test.

| Setup | Cost per task (t1 / t2 / t3) | Wall time (t1 / t2 / t3) |
|---|---|---|
| A: Opus orchestrator | $0.39 / $0.23 / $0.32 | 64s / 43s / 65s |
| B: Sonnet orchestrator + Opus advisor | $0.45 / $0.23 / $0.29 | 110s / 79s / 85s |
| C: Plain session (Sonnet) | $0.20 / $0.11 / $0.15 | 20s / 22s / 36s |

The tasks were too easy to separate the setups on correctness, and the orchestrator roughly doubled cost and tripled time. The advisor billed Opus tokens in only one of three B runs, so it was consulted rarely.

## Run 2: harder tasks (2026-10-13)

A SQL query engine and a job-scheduler simulator, 13 hidden tests each. 7 of 8 runs passed 13/13.

| Task | C: plain session | A: Opus orchestrator | D: Sonnet orchestrator | B: Sonnet + Opus advisor |
|---|---|---|---|---|
| Query engine | $1.34, 508s, pass | $1.52, 308s, pass | $2.88, 805s, pass | $3.26, 875s, pass |
| Scheduler | $1.03, 397s, pass | $2.00, 250s, pass | $1.82, 519s, pass | $0.83, 1636s, FAIL |

- Still no correctness separation: the plain session also passed both.
- The Opus orchestrator was the fastest setup on both tasks (parallel slices), at 1.1x to 1.9x the plain session's cost.
- A Sonnet orchestrator launched more agents (5 implementers and 5 reviewers on the query engine) and cost about twice as much.
- The advisor setup added cost and time and had the only failure. The orchestrator ended its turn ("waiting for completion") while its one implementer was still running, with no root `index.js`. The task text then did not say where `index.js` lives; it does now, and the orchestrator prompt now forbids ending a reply while workers run. B on the scheduler should be rerun before it counts against the advisor.

## Run 3: auto routing (2026-10-14)

Easy tasks `t1-parallel` and `t2-single`, one run per cell. E excludes the triage call, about $0.01 to $0.05.

| Task | C: plain session | A: Opus orchestrator | E: auto | E routed to |
|---|---|---|---|---|
| t1-parallel | $0.21, 20s | $0.45, 68s | $0.44, 70s | pipeline |
| t2-single | $0.10, 18s | $0.19, 46s | $0.10, 27s | plain |

All six runs passed every hidden test. Triage picked the route a person would have, so auto paid pipeline cost only on the parallel task and plain-session cost on the single one. On `t1-parallel` the pipeline still cost twice the plain session for the same result, so these tasks are too easy to say the parallel route was worth choosing; the `minParallelFiles` threshold may be too eager. Treat this run as a smoke test of the router.

## Run 4: 30-minute minisql head-to-head (2026-10-14)

An Opus orchestrator (plugin 0.1.1) against a plain Opus session on the minisql task (`h3-sql-engine`), run concurrently with a 30-minute cap. Scored on 322 hidden tests, plus a 1,062-test stress suite added after the first one saturated. One run per arm.

| Setup | Hidden tests | Stress tests | Cost | Wall time |
|---|---|---|---|---|
| Orchestrator (Opus) | 322/322 | 1,062/1,062 | $2.87 (Opus $0.48, Sonnet $2.39) | 22:33 |
| Plain Opus session | 322/322 | 1,062/1,062 | $4.80 | 18:17 |

- Both arms reached 322/322 at the first scored snapshot (6:01), so the task saturated in about 6 minutes and the rest of the time measured polish, not correctness.
- The orchestrator took the light path: one Sonnet implementer and 5 implement-review rounds. Most of its cost was the Sonnet implementer.
- The review gate recorded no status for 10 of 13 subagent stops. The fix lives in plugin 0.1.2: its telemetry hook reads the status from the subagent's SubagentHandback message in its transcript. It ships in the same release as this benchmark change.
- With one run per arm, the cost gap ($2.87 against $4.80) and the time gap are not evidence of a difference. Use `--repeat` and `--snapshot-every` to measure it.

## Live checks of the router (2026-10-14)

Throwaway repo, one small task ("create `clamp.js` with tests"):

| Route | Result | Cost |
|---|---|---|
| SDK `--mode auto` (triage chose plain) | tests pass | $0.05 |
| SDK `--mode reviewed` | tests pass, review pass, 1 session | $0.09 |
| Native orchestrator, light path | 1 implementer, 1 reviewer; test gate and review gate both allowed | $0.25 |
| Native `npm run auto` (triage chose plain) | completed | about $0.10 |

## Not yet exercised live

Escalation, resume, replan and the retry backoff are covered by unit tests only. The second Opus reviewer (needs a `risky` slice), `omitClaudeMd` and the scripted workflow have not run live either.
