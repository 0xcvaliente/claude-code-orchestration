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

