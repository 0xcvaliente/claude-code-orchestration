# Short k2 run, 0.3.0 (2026-10-31)

One run per arm. This run shows direction only and decides no hypothesis that needs two runs (verdict rules in [bench/HYPOTHESES.md](../bench/HYPOTHESES.md)). Data: [data/short-k2-2026-10-31.summary.json](data/short-k2-2026-10-31.summary.json), [data/short-k2-2026-10-31.runs.json](data/short-k2-2026-10-31.runs.json), and the campaign folder `runs/bench/short-k2-2026-10-31/` (`grades.jsonl`, `grades-lenient.jsonl`; not committed).

## Setup

- Task: `k2-stdlib-toolkit-xl` (twelve Python standard-library modules, 1,762 hidden tests), 10-minute cap (cell `cap10`), matrix `bench/matrix/short-k2.json`, seed 11, one rep per arm, all three arms started together.
- Versions: Claude Code 2.1.314, plugin 0.3.0, repo at b193fdf. Started 2026-10-31 05:43 UTC.
- Arms:
  - `O-mix`: this plugin's orchestrator with the shipped models (opus orchestrator, sonnet workers).
  - `N-UC`: native workflow orchestration with the plugin disabled, opted in by a direct request in the prompt (opus only).
  - `W-mix`: this repo's gated workflow (`/orchestrate`, the project copy).
- Strict is the official grade. Lenient is the k2 variant grade, which lets toolkit modules other than `toolkit/regex.py` import `re`.

## Results

| Arm | Strict | Lenient | Tokens | Wall time | Workflow ran | Claim | False success |
|---|---|---|---|---|---|---|---|
| O-mix 0.3.0 | 99.6% (1755/1762) | 99.6% (1755/1762) | 4.44M (opus 1.27M, sonnet 3.16M) | 395 s, exited | not a workflow arm | partial | no |
| N-UC | 92.91% (1637/1762) | 99.94% (1761/1762) | 5.65M (opus only) | 429 s, exited | yes, `wf_987c4129-0f1` (12 agents) | partial | no |
| W-mix | 66.91% (1179/1762) | 91.54% (1613/1762) | not measured | 602 s, killed at the deadline | yes, `wf_512226a5-9f0` (27 agents) | none | no |

No arm reached 100%. O-mix reached 99.6% at the 6-minute snapshot; N-UC passed 90% at the same snapshot (t90 360 s). W-mix had 0 tests passing at 4 minutes and 1179 at 8 and 10 minutes.

Other per-run figures from the summary: O-mix ran 15 subagents (6 implementer, 9 reviewer), gates `review:allow` 15, `test:block` 6, `test:allow` 4. W-mix ran 27 agents (10 implementer, 7 reviewer, 4 researcher, 3 integrator, 3 `workflow-subagent`) and 10 worktrees, gates `test:warn` 8, `review:allow` 2. N-UC ran without the plugin, so it has no gate or telemetry records; its 12 agents come from Claude Code's own workflow record.

## Did each workflow arm really use a workflow?

`workflow_runs` decides it.

- **N-UC: yes.** Claude Code recorded `wf_987c4129-0f1` (workflow `implement-toolkit`, status completed, agentCount 12). This was native workflow orchestration, not a plain Opus session.
- **W-mix: yes.** The runner recorded an empty list, which was a false negative: the run was killed before Claude Code wrote `workflows/wf_*.json`. The session folder holds `subagents/workflows/wf_512226a5-9f0/` (27 agent meta files) and `workflows/scripts/orchestrate-wf_512226a5-9f0.js`, and the run repo's git log has `worktree-wf_512226a5-9f0-*` merge commits. After the C3 fix, `workflowRunsIn` also finds a workflow from its script and agents folder, and the re-derived row lists `wf_512226a5-9f0` (`workflow_runs_rederived` in the runs file).

## Why strict is below lenient

The strict rows in `grades.jsonl` carry no flags. The only lenient flag is the variant marker (`lenient: variant grade, re may be imported outside toolkit/regex.py`), so the `re` rule is the only difference between the two grades. Per category:

- **O-mix: no gap.** No toolkit module outside `regex.py` imports `re`. The 7 failing tests are the same on both grades: 5 in `regex`, 1 in `toml`, 1 in `b64`.
- **N-UC: `toml`, 0/124 strict vs 124/124 lenient.** `toolkit/tomlparse.py` imports `re`. Its one lenient failure is in `b64`.
- **W-mix: `toml` (0 vs 118/124), `fraction` (0 vs 156/157), `jsonx` (0 vs 160/160).** `tomlparse.py`, `fraction.py` and `jsonx.py` import `re`. Its remaining failures on the lenient grade (149 in total) are `ipaddr` 126 (24/150), `wrap` 13 (147/160), `toml` 6 (118/124), `b64` 2 (157/159), `fraction` 1 (156/157) and `cal` 1 (155/156). No module was still rising at the end: in `grades.jsonl` every module's score is the same at 480 s, 600 s and final. `ipaddr` and `wrap` last rose between 360 s and 480 s; `b64` and `cal` held the same score from 360 s on. The snapshots therefore do not show how many of these failures the deadline cut off.

The task spec forbids `re` outside the regex module. The earlier O-mix 0.1.x baseline lost `tomlparse` to the same rule twice. In this run O-mix 0.3.0 (with the constraints ledger) did not break it.

## H13: native judge hook corpus

Live run of `dist/plugin/hooks/judge-hook.mjs --plugin` (`ORCH_JUDGE=native`, real claude CLI, opus) over the fixed corpus `src/fixtures/judge-corpus.json` on Claude Code 2.1.314 ([data/judge-corpus-live-2026-10-31.json](data/judge-corpus-live-2026-10-31.json)):

| Entries | Matched expected | Unrequested push/remote/`rm -r` allowed | False denies | Model calls |
|---|---|---|---|---|
| 28 | 28 | 0 | 0 | 10 |

## Plain reading

In this run, O-mix 0.3.0 scored as high on the strict grade as on the lenient one (99.6%), using 4.44M tokens against 5.65M for native workflow orchestration (N-UC), which scored 92.91% strict and 99.94% lenient. The gated workflow (W-mix) did not finish inside 10 minutes. No arm claimed a success it did not have.

Against the earlier campaign on the same task and cap (README, built-ins blocked): O-mix 0.1.x scored a 92.4% strict median (lenient 99.0%) at 5.66M tokens and 5.8 minutes, with 2 false successes; O-O scored 99.8% at 6.34M.

## Caveats

- One run per arm: direction only. Under the verdict rules, n < 2 is inconclusive.
- One task, coding only, 10-minute cap. W-mix was cut off mid-run; this campaign does not measure what a longer cap would change.
- W-mix tokens were not measured: claude was killed before it printed its JSON, so the recorded 0 is not the spend.
- N-UC's lenient score is higher than O-mix's (99.94% vs 99.6%). The strict lead comes from the `re` rule alone.
- The earlier baselines come from a different campaign (2 runs per setup, built-in subagents blocked) and an earlier plugin version, so the comparison with them is not like for like. This campaign has no O-O run.
