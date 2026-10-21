# Pre-registered hypotheses

Dated 2026-10-15, written before any paid benchmark run. The decision rules below are the ones `bench/analyze.mjs` applies mechanically. Cost is measured in tokens only.

## Primary metrics

- Final hidden-test score (percent of `meta.total` passed at the end of the run).
- Total tokens per model, and output tokens.
- Wall time.
- Time to 90% and to 100% of the score (from snapshots).
- False-success rate: the run claims success but the hidden tests fail.

## Verdicts

Each hypothesis gets "supported", "not supported" or "inconclusive". A hypothesis is inconclusive when data is missing or n < 2. Rate-limited and errored runs are excluded. Lite runs 2 reps per cell, so most results show direction, not significance.

## Hypotheses

There is no H3: the extra-large task was dropped from the Lite scope.

- **H1.** On k1-stdlib-toolkit (main cell), O-mix and O-O each reach a final score within 5 points of P-O with lower median wall time.
- **H2.** On small tasks (t1-parallel, t2-single), O-mix uses at least 1.5x the median tokens of P-S, and O-O at least 1.5x P-O, with no pass-rate gain.
- **H4.** Pooled over main-cell runs, the false-success rate of O-mix+O-O is lower than that of P-S+P-O.
- **H5.** With efficiency = mean score % / median tokens in millions, AUTO is within 10% of the best arm's efficiency on at least 4 of 6 tasks.
- **H6.** O-O vs P-O per task shows the effect of orchestration alone. Supported if O-O scores at least P-O on every large task, not supported if lower on any, otherwise inconclusive.
- **H7.** On k1 and h3, the O-mix minus P-O score difference grows from cap10 to main (30 min) to cap60, and at the budget1M and budget3M caps P-O scores at least as high as O-mix.

## Budget caps

The budget caps are enforced through claude's dollar limit at 1M tokens per dollar, so they are approximate; actual token use is reported per run.

## Amendment, 2026-10-15, after the pilot and before any k2 run

Pilot facts. On k1-stdlib-toolkit (4 modules, 503 hidden tests), a plain Opus session scored 503/503 in 207 s (2.04M tokens), and the orchestrator ran 4 implementers in parallel and scored 496/503 in 205 s (2.02M tokens). On h3-sql-engine the orchestrator reached 99.6% within 4 minutes of a 10-minute cap. Both large tasks saturate within minutes, so the time-limit and budget sweeps cannot separate the setups on them, and H1 cannot be tested on k1.

Changes, all made before any run of the new task k2-stdlib-toolkit-xl (12 modules: k1's four plus ipaddr, fraction, urls, b64, diff, wrap, jsonx and cal; about 1,600 hidden tests; tier large, shape splittable, python, 30 min):

- **H1** uses k2-stdlib-toolkit-xl (main cell) instead of k1.
- **H7** uses k2 only; h3 and k1 are dropped from the sweeps. Its budget part refers to the two budget cells of the sweep (budget3M and budget8M, since k2 needs more tokens than k1), found as the cells whose id starts with "budget".
- **H5** needs AUTO within 10% on at least two-thirds of the tasks with data (rounded up), instead of at least 4 of 6 tasks.
- **H6**'s large tasks are every task with tier "large": k1, h3 and k2.
- k1 stays in the main matrix as a saturated large task.


## Amendment, 2026-10-20: H8, SDK pipeline vs native orchestrator, written before any SDK-arm run

No benchmark so far includes the SDK pipeline (`src/cli.ts`); the native orchestrator's promotion rests on a tie on k2 plus the design argument. The arm `SDK` and the matrix `bench/matrix/sdk-vs-native.json` (task k2-stdlib-toolkit-xl, arms O-mix and SDK, one cell `cap10` with a 10-minute cap, 4 reps, seed 21) exist to test it. This campaign has not been run.

- **H8.** On k2-stdlib-toolkit-xl at cap10, the SDK pipeline and O-mix differ in strict final score.
  - Primary metric: strict final score (percent of `meta.total`), SDK minus O-mix, paired by rep (block), the median of the paired differences with the same seeded bootstrap CI as every comparison in `analyze.mjs`.
  - Secondary metrics, reported and not part of the verdict: total tokens (ratio SDK / O-mix) and wall time (difference), paired the same way.
  - Decision rule: supported if the CI of the paired score difference excludes 0; not supported if it includes 0; inconclusive if either arm has fewer than 2 included runs or fewer than 2 pairs. Rate-limited and errored runs are excluded as elsewhere.
  - H8 says nothing about which arm should win. A "supported" verdict means the scores differ in either direction; the sign and size are in the evidence.

How a capped SDK run is graded. A native run is killed at the cap and whatever is in its working tree is graded. The SDK pipeline merges passing slices onto a result branch only at its last step, so a run killed by the cap has no result branch and no `report.json`. The harness then reads the SDK run directory's `journal.json` (written after planning and after every slice), merges the branch of every slice recorded as passed into the run repo's working tree (a branch that conflicts or is missing is skipped and listed in `sdk-adapter.json`), and grades that. So a capped SDK run is graded on its passed, verified slices only, while a native run keeps whatever happens to be in its tree, verified or not. That asymmetry is stated here, not hidden. The SDK arm also has no mid-run snapshots, so t90, t100 and AUC are not computed for it (they are null, not zero).

Amendment, 2026-10-21 (after a 1-rep trial, before any scored SDK run): the first trial (`runs/bench/sdk-vs-native-1rep`, O-mix 65.9%, SDK 0%) was a harness fault, not a result. The SDK arm passed the task's whole-suite `test_cmd` as `--test-cmd`, and the pipeline runs it inside each slice's own worktree where the other slices' modules are still stubs, so all 6 slices failed 3 times and nothing merged. The task meta now has an optional `sdk_test_cmd` (used for the SDK arm instead of `test_cmd`; k2 sets it): it runs `tests/run_public.py` for only the toolkit modules changed since the first commit. O-mix still uses the whole-suite `ORCH_TEST_CMD`. The trial is excluded from H8 and kept as a record; H8's hypothesis, metric and decision rule are unchanged.

First pair with the fix (`runs/bench/sdk-vs-native-1rep-b`, rep r3, one pair, so H8 is inconclusive by its own rule): strict final score O-mix 99.0% (1745/1762), SDK 65.6% (1156/1762); wall time 6.7 and 6.9 minutes; tokens 4.75M and 2.97M (the SDK figure undercounts workers still running at a cap, though this run finished by itself). The SDK lost four modules (`tomlparse`, `fraction`, `wrap`, `jsonx`) to task rule 2, because each imports `re`; its slices passed their gate and verifier. On the lenient grade (README, "Lenient variant") the scores are SDK 99.5% and O-mix 99.0%. One pair shows direction only.

Amendment, 2026-10-21 (written before the re-run below was graded): pair r4 of the full set (campaign `sdk-vs-native-r4`) stalled. O-mix wrote nothing at all (0 tokens, empty stdout and stderr, only the init commit) and the SDK planned six slices, started three and finished none before the deadline (478k tokens); both scored 0 at the 10-minute deadline, in a window when other agents were running on the same machine. The harness records this as `deadline`, not `rate_limited` or `error`, so the pre-registered exclusion rule does not cover it. Neither arm did work, so the pair says nothing about quality: it is excluded from H8 on that evidence alone and re-run unchanged (campaign `sdk-vs-native-r4b`, same run ids), and the re-run is analysed in its place. This departs from "exclude only rate-limited and errored runs" and is recorded here as a departure. The numbers with the stalled pair left in, for the record: SDK minus O-mix median +5.85 points, 95% CI [-33.43, 45.69], four pairs, verdict not supported. All five campaign folders stay under runs/bench/.

H8 result, 2026-10-21 (four pairs: `sdk-vs-native-1rep-b` r3, `-r1`, `-r2`, `-r4b`; `node bench/analyze.mjs` over those four): **not supported.** The strict-score median difference SDK minus O-mix is +6.55 points, 95% CI [-33.43, 45.69], which includes 0. Per pair (strict, SDK vs O-mix): r1 99.32 vs 53.63, r2 74.52 vs 74.80, r3 65.61 vs 99.04, r4b 75.37 vs 61.98; the winner flips between pairs, and a strict loss is mostly a module that imports `re` (task rule 2), not a failing module. Secondary figures: tokens ratio SDK/O-mix 0.65, CI [0.52, 0.90] (the SDK figure undercounts workers still running at the cap; one SDK run, r4b, hit the deadline); wall time SDK minus O-mix +108.8 s, CI [10.2, 232.3], so the native arm was faster in these four pairs.

Lenient grade (README, "Lenient variant"; a descriptive figure, not the pre-registered metric, and no CI was computed): SDK vs O-mix r1 99.32 vs 99.94, r2 83.37 vs 99.83, r3 99.49 vs 99.04, r4b 84.28 vs 99.72; median difference -8.0 points. O-mix is at or above 99% on every pair once `re` imports are allowed. The SDK reaches that in two pairs and falls to 83-84% in the two where it ran longest (r2 at 540 s, r4b at the 600 s deadline), with whole modules scoring 0 even leniently (r2: toml, diff; r4b: shlex, regex). So the strict verdict is dominated by one rule violation that flips between arms and reps, and the lenient view favours the native arm on completeness within 10 minutes. Four pairs with this much spread cannot separate them on the pre-registered metric; more reps would narrow the interval.

Known differences between the arms (none is corrected for):

- Models and effort. The SDK's planner, explorer, writer and verifier models and efforts come from `src/config.ts` `ROLES`; the native orchestrator is a separate top-level agent with its own model line and the shipped sub-agents.
- Control flow. SDK: concurrency 3, 2 retries per slice, `maxReplans` 0 (the CLI default), 15-minute timeout per worker. Native: no automatic replan, no fixed concurrency or retry numbers; the orchestrator decides.
- Test gate. The SDK uses `--test-cmd` (the task's `test_cmd`) with no `--setup-cmd`; native uses its hook gates and `ORCH_TEST_CMD`.
- Configuration. The SDK ignores the run repo's `.claude/` agents and hooks (only the committed `.claude/settings.json` with every user plugin disabled is read, through project settings); O-mix has this repo's `.claude/` copied in.
- Triage. `--mode orchestrate` skips triage, as O-mix has none; `--no-escalate` is set.
- Budget. `ORCH_BUDGET_TOKENS` is a token cap for the SDK (`--budget`) and a dollar-converted cap (1M tokens per dollar) natively. No budget is set in this campaign.
- Token undercount. A worker's tokens are recorded only when it finishes, and a capped SDK run has no `report.json`, so tokens of workers still running at the cap are lost. SDK token totals for capped runs are an undercount; this favours the SDK on tokens and does not affect the primary strict-score metric. Read H8's token ratio together with the count of capped SDK runs (`capped_sdk_runs` in the H8 evidence).
- Claims. The SDK prints no result claim, so its false-success rate is not meaningful and H4 does not use it.
