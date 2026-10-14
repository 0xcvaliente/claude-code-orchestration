# Benchmarks

Three runs compare the orchestrator with a plain session. All costs are list price (an estimate, not what a subscription bills). Every cell is a single run, so read these as evidence about direction, not as measurements with error bars.

**Short version:** the pipeline never beat a plain Sonnet session on correctness, cost 1.1x to 2x more, was slower on small tasks and faster on parallel ones. That is why [triage](../README.md#choosing-a-route-triage) exists.

## How the benchmark works

`npm run compare` runs tasks under several setups in fresh git repos (`~/orch-compare`) and scores each with hidden tests the agent never sees. `npm run compare:validate` checks the hidden tests against reference solutions with no model calls.

| Variant | Setup |
|---|---|
| A | Opus orchestrator (native agent) |
| B | Sonnet orchestrator plus an Opus advisor |
| C | Plain Sonnet session |
| D | Sonnet orchestrator, no advisor |
| E | Auto: triage picks plain, reviewed or the orchestrator per task (`scripts/auto.sh`) |

Results land in `runs/compare/` as JSONL and a Markdown table.

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
