# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **The orchestrator can load skills.** Its tools gain `Skill` (`NATIVE_TOOLS.orchestrator` in `src/config.ts`; checked live on Claude Code 2.1.325: a main-thread agent whose tools name `Skill` sees the installed skills and can load one). Before planning it may load at most two installed skills that shape the plan itself (domain rules, architecture, a threat model), because each loaded skill stays in its context for the whole run; every other fitting skill still goes to the workers by name on `SKILLS:` lines. The route skill and the session nudge carry the same rule.
- **A skill decision per planned slice.** In a PLAN REVIEW brief each slice may carry `SKILLS: <names>` or `SKILLS: none`, and a RISKY slice always carries one of the two. The plan reviewer treats a named skill that is not installed or does not fit the slice, and a RISKY slice with no decision, as gaps. The plan check counts only a `SKILLS:` line before the first `SLICE:` line of a PLAN REVIEW brief as names for the plan reviewer itself.
- **Skills in the gated workflow.** A planned slice may carry `skills` (at most 5 plain skill names). Its implementer and reviewer briefs then carry a `SKILLS:` line after the header lines the workflow already writes; a slice without skills gets exactly the briefs it got before.
- **A run can draft one new skill** ([docs/skills.md](docs/skills.md)). When no installed skill covers knowledge the task needs and that knowledge is reusable, the orchestrator may plan one skill slice (`KIND: skill`, `SKILL: <name>`, optional `TARGET: public` and `UPDATE: yes`); it proposes the skill first when a person can answer. The plan check blocks it with `skill_create_off`, `skill_name_invalid`, `skill_repo_missing`, `skill_exists` or `skill_limit`, and on an allow appends the facts the implementer needs (repository, draft worktree, branch `skill/<name>`, validator, seal command, the authoring skill `skill-authoring`). The draft is a git worktree of the private skills repository unless the slice says public. A new SubagentStop hook, the skill gate (`skill-gate.mjs`), checks the draft's SKILL.md, the repository validator, secrets and personal details, the seal (`skill-seal.mjs`, a `provenance.json` of file hashes) and that the branch is committed. Later slices read the draft through `DRAFTS: <name>`; the skill slice replies `DRAFT: <name> <branch>`. New settings: `skill_create`, `skills_repo_private` and `skills_repo_public` (20 plugin settings in all).
- **`npm run skill-publish`** (`scripts/skill-publish.mjs`), for a person to publish a draft: it verifies the seal and the validator, checks the draft is committed, pushes `skill/<name>` (never a force push) and opens a pull request whose body names the skill, the target, the provenance digest and that an agent created it. `--merge` merges the pull request, fast-forwards the repository, runs its installer and removes the draft worktree; `--dry-run` prints the steps; with no name it lists the drafts. No agent or hook pushes or installs a skill.
- **Reply lines `SKILLS-USED:` and `SKILLS-SKIPPED:`.** A worker whose brief named or suggested skills ends its report with them. `parseReply` returns `skillsUsed` and `skillsSkipped`, the dashboard mirrors them, and the journal keeps them on the stop record as `skills_used` and `skills_skipped` (skill names only, at most 8 each, left out when empty, so a reply without them is journaled as before).
- **A Skills section in `npm run report`**: per skill how often it was suggested, used and skipped; the drafts created with the skill gate's result; and the skills worth revising (skipped three or more times, or used in a slice whose review failed). Reports of runs without skills are unchanged.

### Changed

- **A reviewer on opus or above gets up to 2 suggested skills** (was 1). The limit follows the launch's effective model: the call's `model`, else the agent file's. A sonnet reviewer, or a launch whose model cannot be ranked, keeps 1. Implementers and researchers keep 3. No model default changed.

## [1.3.0] - 2026-11-14

1.3.0 changes which model each role runs on, keeps Haiku out unless you allow it, and fixes the run log of headless runs. Upgrading: the plugin has one new setting, `allow_haiku` (empty by default), and no existing setting changed. Runs cost more than on 1.2.2, because the orchestrator and the implementer each moved up one model; one small two-part task measured $1.08 at list price against $0.81 before.

### Changed

- **Models: Fable plans, Opus does the tasks, Sonnet does the rest, and no Haiku.** The orchestrator (SDK planner) runs on Fable 5.2 (was Opus). The implementer (SDK writer) and the plain session (`npm run auto`'s plain route, the SDK's solo role) run on Opus (were Sonnet; the plain session used to run on whatever model Claude Code defaulted to). The researcher (SDK explorer) runs on Sonnet (was Haiku). The reviewer, integrator and triager stay on Sonnet, and the Bash judge and the escalated reviews stay on Opus. The third and last attempt of a slice is still a fresh implementer on Opus, which is now the same model as the first attempt. Cost per run goes up: the benchmark figures in the README were measured with the earlier models and the triage thresholds were set against a plain Sonnet session, and neither was measured again. `ORCH_MODEL_<ROLE>` and `ORCH_MODEL` still override each default.

### Added

- **The haiku rule.** `plan-check.mjs` raises a launch of any of this plugin's agents to sonnet when its model is in the haiku family (the call's `model`, else the agent file's `model:` line, so an agent file copied from an earlier version is covered). `ORCH_ALLOW_HAIKU=1` or the new plugin setting `allow_haiku` turns the rule off; `CLAUDE_CODE_SUBAGENT_MODEL` is left alone. Each raise goes to `model-floor.jsonl` in the state dir. The read router is unchanged: it only raises a model, so with a Sonnet researcher its haiku tier changes nothing.

### Fixed

- **The run log recorded the last wake-up of a headless run, not the run.** `claude -p` answers once per wake-up of the session: an orchestrator that launches agents stops, is woken by each agent's result and stops again, and every stop is a result with its own `num_turns` and `duration_ms`. `--output-format json` prints the last one only, so `runs.jsonl` logged a run of two minutes and three agents as `duration_ms: 8320` and `turns: 1`. `scripts/orchestrate.sh` now asks for the event stream (`--output-format stream-json --verbose`) and `scripts/run-result.mjs` reduces it to the document the script prints: the last result as before, plus `orch_totals` with `results` (how many results the session produced), `turns` (`num_turns` summed over them) and `wall_ms` (the run's wall time, measured by the script). `scripts/log-run.mjs` writes those two totals to `turns` and `duration_ms`. Tokens were already right: `modelUsage` in the last result covers the whole session. Rows logged before this fix keep their low figures. The bench's `num_turns` still comes from each document's own `num_turns`; its `N-UC` arm runs `claude` itself and keeps `--output-format json`.

## [1.2.2] - 2026-11-14

1.2.2 follows Claude Code 2.1.323 to 2.1.325. Claude Code updated itself and the update went around two things this repo relies on; both are fixed, and a script now checks for the same kind of change after every update.

### Fixed

- **`web-fetch`, a built-in subagent added in Claude Code 2.1.325, was not blocked.** The block list named six built-in types by hand in three places. The plan check took `web-fetch` for somebody's own agent, so a session with an open run could hand work to it and no gate saw that, and `permissions.deny` in this repo did not deny it. The names now live in one file, `.claude/hooks/builtin-agents.mjs`: the plan check reads it, `DENIED_AGENTS` in `src/config.ts` is built from it, and `policy.test.ts` keeps `permissions.deny` in step. Headless runs were not affected: `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` still removes every built-in (checked on 2.1.325).
- **Claude Code's auto memory ran inside the judge and the SDK workers.** Each `claude -p` call of the native judge left an empty `~/.claude/projects/<temp folder>/memory` folder and carried the auto-memory instructions in its prompt; an SDK worker could write memory notes under its throwaway worktree's project folder. The judge hook, the SDK judge and every SDK worker now run with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`workerEnv` in `src/judge.ts`).

### Added

- **`npm run claude-update` (`scripts/claude-update.mjs`).** Run it after Claude Code updates. It asks the installed Claude Code for its built-in subagent types (its start-up answer in safe mode; no model call) and fails when one is not on the block list; checks that the headless switches still leave no built-in agent, that the options `scripts/orchestrate.sh` and the native judge pass are still in `claude --help`, that the Agent SDK carries the same Claude Code as the installed one, that an installed plugin is current, and that `dist/` matches the sources. `--fix` repairs the machine: it writes newly found built-in types to `~/.claude/orchestration/builtin-agents.json`, which the plan check reads at once, and updates a stale plugin install. `--enable` installs and enables the plugin when it is off (`--fix` never turns it on: the plugin is opt-in). `--write-source` is for a maintainer: it adds the new types to `builtin-agents.mjs` and `permissions.deny` and rebuilds `dist/`. Details in [docs/claude-code-updates.md](docs/claude-code-updates.md).

### Changed

- Agent SDK 0.3.325 (it carries Claude Code 2.1.325; 0.3.322 carried 2.1.322, so the SDK pipeline ran an older Claude Code than the installed one). `@types/node` 26.6.6.

## [1.2.1] - 2026-11-10

### Fixed

- `npm run report` counted an agent once per stop record. An agent stops more than once (the test gate sends an implementer back, a resume, the stops around a hand-back) and each record carries its running total from the transcript, so the role table, and the cost table added in 1.2.0, counted such an agent's tokens two or three times: in the logs of 2026-11-01 to 11-03 implementer cache reads came out 72% to 76% too high. Both tables now take each agent's last stop record, and "Agents" counts agents. The figures in [docs/research-2026-11-10.md](docs/research-2026-11-10.md) that came from the same sums are corrected.

## [1.2.0] - 2026-11-10

1.2.0 follows Claude Code 2.1.317 to 2.1.322 and closes three gaps found while researching it ([docs/research-2026-11-10.md](docs/research-2026-11-10.md), probes in [docs/data/live-checks-2026-11-10.md](docs/data/live-checks-2026-11-10.md)). It also carries the bug fixes from a read-only audit of the hooks, the SDK pipeline, the scripts and the dashboard, merged after 1.1.0; each of those has a test that failed before it. The brief and reply grammar, the gate reason names and the agent names are unchanged; one gate reason and one setting are new.

### Added

- Review gate: `implementer_unfinished`. A subagent that stops at its turn limit fires no SubagentStop (probed on Claude Code 2.1.322), so the test gate never ran for it and the journal counted no attempt: a turn-limited implementer could leave partial work that no gate saw, and with no other implementer the gate allowed with `no_implementer_in_session`. The gate now blocks while an implementer launched with the Agent tool has a SubagentStart and no later SubagentStop, until it is resumed and stops or a later implementer stop takes its slice over; two blocks, then `implementer_unfinished_gave_up` ([README, The gates](README.md#the-gates), [docs/brief-grammar.md, Gates](docs/brief-grammar.md#gates-slice-a1)).
- `handback-check.mjs` (PreToolUse on `SubagentHandback`, auto mode). A worker's report is read before it is delivered and sent back once when it has no `STATUS` line, or when a reviewer's pass leaves an id of its `CHECKS` line unanswered. `quote-check.mjs` runs on the same event, so an unverified quote is corrected before the orchestrator sees the report instead of after. Setting `handback_check` (`ORCH_HANDBACK_CHECK=off`), the 16th.
- Estimated cost in `npm run report`: cost by role and model at list prices (`scripts/prices.mjs`), the agents that started and never stopped, and cache rewrites. Telemetry records `tokens.cache_write_1h` and `cache_rewrites` (numbers only).
- A subagent status line shipped by the plugin (`subagent-statusline.mjs` through the plugin's `settings.json`): each worker's row shows its slice, attempt, model, tokens and progress.

### Changed

- The researcher's Bash list includes read-only search and paging: `grep`, `rg`, `find`, `head`, `tail` and `cat`, held by `researcher-guard.mjs` to forms that cannot write a file or start a program. On macOS and Linux Claude Code leaves the Grep and Glob tools out of an agent whose tools also name Bash, so a researcher launched from a plain session could not search at all: the logs since 2026-11-01 show 43 guard denials in about 26 researcher runs.
- A passing review on opus or a stronger model (`fable`) meets `opus_review_required`. The escalation still launches on opus by default.
- SDK pipeline (maintenance): Agent SDK 0.3.296 to 0.3.322, and the Bash judge's hook is registered with `onFailure: "block"`, so a guard that throws or returns nothing blocks the command.
- The orchestrator, the route skill and the nudge tell the session how to answer `implementer_unfinished` and never to accept a partial result as finished; the implementer waits for a command that was moved to the background before it reports.

### Fixed

- `npm run check-plugin` no longer fails after `npm run eval`: the eval writes its reports to `dist/plugin/evals/results` (ignored by git), which the comparison with a fresh build now leaves out.
- Hooks: a slice id that names an `Object.prototype` property (`constructor`, `__proto__`, `toString`) no longer throws in the run fold, and the Stop gate blocks instead of exiting 1 and letting the reply through when the run state cannot be read. `test-cmd.sh` detects `scripts.test`, not the word "test" anywhere in `package.json`.
- SDK pipeline: `waves()` breaks only real cycles and keeps a dependency that failed or is still pending, so a slice no longer runs without its dependency's work; a planner slice named `result` no longer collides with the integration branch; a bare 500/502/503/504 in error text is no longer retried as transient.
- Bash judge: `git config` keys that run programs (`difftool.*.cmd`, `mergetool.*.cmd`, `sendemail.*`, `web.browser`, `interactive.difffilter`, `init.templatedir`) are denied like the existing ones, in `src/judge.ts` and `.claude/hooks/judge-core.mjs`.
- Scripts: `scripts/auto.sh` resolves a relative repo path against the caller's folder (a missing folder is an error) and `scripts/report.mjs` reads legacy `runs.jsonl` rows without `subagents`.
- Workflow and UI: `maxRetries: 0` means no retries in the gated workflow; the status line prints a fallback when `jq` is missing; the dashboard progress step no longer shows a reviewer reply without a STATUS line as done (display only, run sign-off is unchanged).

### Known and not fixed

- The token budget restarts on `--resume` and is not applied to the plain and reviewed routes; the judge's own tokens are outside every budget.
- The bash judge does not read the shell string passed to `parallel`, `flock -c` or `script -c`, and still lets through `difftool.<n>.path`, `mergetool.<n>.path` and `browser.<n>.cmd`.
- The `/route` skill passes `$ARGUMENTS` inside double quotes, so a task containing quotes or `$(...)` is expanded by the shell.
- CI does not run or typecheck the dashboard.
- In the dashboard, the pipeline review cells and the phase state still read a reviewer reply without STATUS as done; `docs/dashboard.md` still says it shows as done.

## [1.1.0] - 2026-10-31

1.1.0 is the first stable release and the first tagged one. It is 0.4.0 plus the follow-ups listed under Fixed and Added. There was no 1.0.0 tag, and the versions before this one were not tagged.

### Fixed

- A slice is final only when its escalation rule is met: its latest review passed and it has no doubt signal, or a passing opus review came after its latest attempt. A run no longer closes on a sonnet pass that still needs an opus review, so that review and any further launch of the slice join the same run (ea62c55; [README, The gates](README.md#the-gates), [docs/brief-grammar.md, Run model](docs/brief-grammar.md#run-model)).

### Added

- `ORCH_SESSION_PERSISTENCE=1` keeps session and subagent transcripts in headless runs (`npm run native`, `npm run auto`, the bench), so telemetry records per-agent tokens, turns and models. Unset, headless runs behave as before (ec46ad9; [README, Telemetry and the read log](README.md#telemetry-and-the-read-log)).
- The `d3-reader` bench task (twelve questions over seven documents), the `reader-haiku`, `reader-sonnet` and `reader-routed` arms, and the route-040 benchmark of the read router (17fe23b, 69535bb). Results at n = 2 runs per arm, one task, direction only: the routed arm scored higher than the other two with fewer researcher tokens than `reader-sonnet`, but the model raise and the converted-text notes are confounded, and H14 is not called supported ([docs/benchmark-route-040.md](docs/benchmark-route-040.md)).
- A live probe of the `agent.spawn` mod hook for workflow agents: it runs under `claude -p`, fires for workflow agents and can rewrite their model and prompt. Routing workflow agents this way is feasible but not implemented (724d66f, 9ff6199; [docs/data/live-checks-workflow.md](docs/data/live-checks-workflow.md)).

### What 0.4.0 brought

Details in [README, What 0.4.0 adds to the gates](README.md#what-040-adds-to-the-gates) and [docs/research-2026-10-31.md, Implementation status](docs/research-2026-10-31.md#implementation-status-040).

- Brief and reply lines: `SOURCES:` and `READ:`, `KIND: bugfix`, `VALIDATE: gaps`, `SKILLS:`, `GAP: <0-100>` and `QUOTE:` ([Briefs and replies](README.md#briefs-and-replies)).
- Review precision: the gap cutoff (`ORCH_GAP_MIN`, default 80), validation of gaps before a retry, opus on the third attempt, and the native stall gate (`replan_required`).
- The test baseline (`inform` by default, `allow` opt-in) and the bugfix check for `KIND: bugfix` slices.
- Guards: the researcher Bash guard and the reviewer egress guard, both deny-only. The quote check for researcher `QUOTE:` lines. Plan and constraint re-injection after compaction (`compact-context.mjs`).
- The read router, opt-in (`ORCH_READ_ROUTER=on`) ([How a worker launch is shaped](README.md#how-a-worker-launch-is-shaped)).
- Skill suggestions in the plan check, on by default (`ORCH_SKILL_HINTS=off` to drop).
- Telemetry v2: tokens, turns, models and max-turn hits per agent, the file trail and the read log.
- 15 plugin settings as `userConfig`, bridged to the `ORCH_*` variables; an environment variable still wins ([Switches and plugin settings](README.md#switches-and-plugin-settings)).
- The gated workflow (shipped in 0.3.0) gained `gapMin`, `planCheck`, `planReview`, `refute` and `escalateLast`, all on by default ([The gated workflow](README.md#the-gated-workflow)).
- The native Bash judge hook is registered with `onFailure: "block"` and a 120 s timeout.

### Stability

In 1.x, these do not change incompatibly:

- The brief and reply line grammar ([docs/brief-grammar.md](docs/brief-grammar.md)).
- Gate reason names, such as `file_overlap`, `not_in_plan`, `replan_required` and `opus_review_required` ([README, The gates](README.md#the-gates)).
- The agent names (`researcher`, `implementer`, `reviewer`, `integrator`, `orchestrator`) and the `orchestration:` plugin namespace.
- The `userConfig` keys and the `ORCH_*` switches, with their defaults.
- The install path: marketplace `0xcvaliente/claude-code-orchestration`, plugin `orchestration`.

These stay opt-in or experimental and may change in a minor release:

- The read router (`ORCH_READ_ROUTER`); H14 is undecided.
- The native Bash judge hook (`ORCH_JUDGE=native`).
- The advisor (`ORCH_ADVISOR`).
- The eval suite (`npm run eval`), which has not been smoke-run.

Frozen: the SDK pipeline in `src/`, maintenance only since 0.3.0.

Known limitations are listed in [README, Known limitations](README.md#known-limitations).

### Upgrading

Installed plugin copies pick up the new version after a `/plugin` update or a reinstall, then `/reload-plugins`. No `userConfig` key or default changed after the 0.4.0 release commit (fc7360e), so there is nothing to migrate in settings. `ORCH_SESSION_PERSISTENCE` is a new environment variable for headless runs, not a `userConfig` key, and leaving it unset keeps the earlier behaviour. The one behaviour change is the finality rule above: a run waiting for a slice's opus review now stays open until that review runs or the run goes stale.

## Earlier versions (not tagged)

- 0.4.0 (56ec956 set the version; fc7360e completed the release with the README): see What 0.4.0 brought above.
- 0.3.0 (b193fdf): the gated workflow shipped in the plugin, the deny-only native Bash judge hook (opt-in), the plugin eval suite, native-workflow bench arms, and a plan-check fix for legacy records.
- 0.2.0 (e08d4ca): the review gate waits for running agents, run-scoped plan checks with plan conformance, the constraints ledger and opus escalation, and one parser for briefs.
- 0.1.1–0.1.13 (8c561fc to b287d2d): plugin packaging with the session nudge, a handback-aware review gate, runner detection, the per-implementer review loop guard, no double hook runs, plugin state outside user repos, and the dashboard pane.

[1.3.0]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/v1.3.0
[1.2.2]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/v1.2.2
[1.2.1]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/v1.2.1
[1.2.0]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/v1.2.0
[1.1.0]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/v1.1.0
