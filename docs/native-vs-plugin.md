# What Claude Code ships vs what this plugin adds

Claude Code already runs subagents in the background, scripts multi-agent workflows, forks the conversation into helpers, reviews diffs and gates risky commands in auto mode. This page compares each area with what the orchestration plugin (0.2.0) adds on top, why that is worth having, and how it is measured. Claude Code facts link to its docs; plugin facts point to the file that implements them; numbers come from the plugin's own logs and the benchmark.

**Where the plugin does not win.** Raw score is not its advantage. With Claude Code's built-in subagents allowed, plain Opus scored 99.7% on `k2-stdlib-toolkit-xl` by delegating to `general-purpose` itself (an earlier campaign, different plugin version; [README](../README.md#benchmark-orchestrator-vs-plain-sessions-built-in-subagents-blocked)). What the plugin adds is verification (gates that do not take the agent's word), routing cost (a plain session when the task does not split), safety (role limits and denies) and resumability (a run journal across sessions). The hypotheses H9 to H13 ([bench/HYPOTHESES.md](../bench/HYPOTHESES.md)) were written before any run of 0.2.0 to test exactly those claims.

Items marked **planned (0.3.0)** are not shipped.

## Background agents and the review gate

| | |
|---|---|
| Claude Code ships | Subagents run in the background by default (since v2.1.198). `Stop` and `SubagentStop` hook inputs carry `background_tasks`, the subagents, workflows and shell tasks still running ([hooks](https://code.claude.com/docs/en/hooks.md)). Verified on 2.1.314: headless `claude -p` fires an early `Stop` that lists the running tasks, delivers their result as a new turn, then fires a second `Stop` with `background_tasks: []`; it waits for background subagents but drops background shell tasks ([native-mode.md, Live checks](native-mode.md#live-checks-2026-10-31)). |
| The plugin adds | A Stop review gate that holds the final reply until every implementer's slice has a passing review, and defers (`agents_running`, not counted as a block) while `background_tasks` lists a running subagent, workflow or teammate (`.claude/hooks/review-gate.mjs`). Without `background_tasks` it pairs SubagentStart and SubagentStop records instead. |
| Why it is better | Claude Code reports what is running but does not stop a reply that ignores it. Before 0.2.0 the gate counted those early Stops as blocks and gave up: of 440 review-gate give-ups in the plugin's logs up to 2026-10-31, 430 fired while an agent was still running (320 of them a reviewer, 110 another agent) and 10 with nothing running. |
| Measured by | **H9**: review-gate give-ups that fire while an agent runs, over the first 14 days of real use after 0.2.0, target 0 (baseline 430 of 440). |

## Scripted workflows and runs

| | |
|---|---|
| Claude Code ships | The Workflow tool runs a saved script of agents; a run can be resumed only within the same session ([workflows](https://code.claude.com/docs/en/workflows.md)). The Workflow tool is removed from every subagent ([sub-agents](https://code.claude.com/docs/en/sub-agents.md)). |
| The plugin adds | A run model computed from log records (`foldRuns` in `.claude/hooks/brief.mjs`, spec in [brief-grammar.md](brief-grammar.md#run-model)): a run opens at a PLAN REVIEW or a light-path launch, closes when every slice is final, survives a new prompt and goes stale after `ORCH_RUN_STALE_MIN` minutes. The journal (`journal.jsonl`) records each slice's result, so an orchestrator asked to resume in a new session skips slices whose last review passed. The plugin's own scripted flow (`.claude/workflows/orchestrate.js`) fixes the order in code; its agents' SubagentStart and SubagentStop reach the gates under their bare `agent_type` (verified, Check C). |
| Why it is better | Resume across sessions, and gates that see the same run whether the orchestrator's prompt or a script drives it. |
| Measured by | Not yet by a pre-registered hypothesis; the gate replays in `src/gate-replay.test.mjs` cover the run boundary. **Planned (0.3.0)**: a shipped gated workflow, measured by **H12**. |

## Fork subagents, built-ins and role limits

| | |
|---|---|
| Claude Code ships | Fork subagents are on by default (since v2.1.302): a fork inherits the whole conversation and its tools. The deny rule `Agent(fork)` turns them off. Subagents may nest, to a default depth of 3 ([sub-agents](https://code.claude.com/docs/en/sub-agents.md)). Six built-in subagent types (`general-purpose`, `claude`, `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`) are always available unless denied. |
| The plugin adds | In this repo, `permissions.deny` blocks the six built-ins and `Agent(fork)` (`DENIED_AGENTS` in `src/config.ts`, `.claude/settings.json`); headless runs export `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` and `CLAUDE_CODE_FORK_SUBAGENT=0` (`scripts/orchestrate.sh`). The implementer has `disallowedTools: Agent`, so a slice cannot fan out on its own; the orchestrator can launch only researcher, implementer, integrator and reviewer. While a run is open the plan check blocks fork and built-in launches in any session (`builtin_agent_in_run`; `ORCH_ALLOW_BUILTINS=1` turns it off) and implementers that are not in the reviewed plan (`not_in_plan`). |
| Why it is better | Every worker is one the gates track: a fork or a built-in would do work no review gate sees. Nesting is cut at one level below the orchestrator. |
| Measured by | `src/policy.test.ts`, `src/plan-hooks.test.mjs` (behaviour, not a benchmark). The 2026-10 campaign with the built-ins blocked is in [benchmark-builtins-blocked.md](benchmark-builtins-blocked.md). |

## Verification: constraints, review and escalation

| | |
|---|---|
| Claude Code ships | `/code-review` checks a diff for correctness bugs ([code review](https://code.claude.com/docs/en/code-review-local.md)). |
| The plugin adds | A constraints ledger: the orchestrator writes the task's hard rules as `C1: <text>` lines in the PLAN REVIEW brief, each slice names the ids its files can break (`CHECKS:`), and reviewers answer each id with `C1: pass (cmd) ...`, `C1: pass (read) ...` or `C1: fail ...` ([brief-grammar.md](brief-grammar.md)). The Stop gate blocks a passing review that leaves a checked id unanswered (`constraints_unchecked`) and requires a passing opus review when a doubt signal fires (`opus_review_required`: RISKY, a retry, a `(read)` answer, OPEN items, an isolated test failure; `ORCH_ESCALATION`). A test gate runs the project's tests before an implementer may finish (`.claude/hooks/verify.sh`). |
| Why it is better | A spec rule is not a bug in a diff. On k2 at a 10-minute cap the shipped orchestrator (O-mix) scored 92.4% strict with 2 false successes, both from one spec rule (`tomlparse` imported `re`) its reviewers missed; the all-Opus orchestrator (O-O) scored 99.8% ([README](../README.md#benchmark-orchestrator-vs-plain-sessions-built-in-subagents-blocked)). The ledger makes such rules explicit and the escalation sends doubtful slices to an opus reviewer without paying for opus on every slice. |
| Measured by | **H10**: O-mix 0.2+ median strict score at least 97% with 0 false successes. **H11**: O-mix 0.2+ within 2 points of O-O's 99.8% at no more than 0.9x O-O's median tokens. |

## Routing cost

| | |
|---|---|
| Claude Code ships | No router: a session decides for itself whether to delegate. |
| The plugin adds | Triage on five facts (files, lines, independent slices, risky, code) that picks a plain session, a plain session plus one reviewer, or the pipeline (`src/triage.ts`, the `/route` skill, the session nudge). |
| Why it is better | On small and medium coding tasks the pipeline cost 1.2x to 2.1x the tokens of a plain session for the same 100% ([README, Why a router](../README.md#why-a-router)). |
| Measured by | H2 and H5 (pre-registered 2026-10-15; results in [benchmarks.md](benchmarks.md)); H11 for the cost of escalation inside the pipeline. |

## Pushes, deletes and auto mode

| | |
|---|---|
| Claude Code ships | Auto mode weighs the user's intent for soft-deny actions, but allows ordinary pushes to the working repository by default, and reads its rules only from user and managed settings, not from project settings or plugins ([auto mode config](https://code.claude.com/docs/en/auto-mode-config.md), [permission modes](https://code.claude.com/docs/en/permission-modes.md)). |
| The plugin adds | Headless runs pass push, remote, `sudo` and `rm -rf` as `--disallowedTools` (`UNSAFE_BASH`, `scripts/orchestrate.sh`). SDK workers use an opus Bash judge with the user's request as the only authority ([bash-judge.md](bash-judge.md)). **Planned (0.3.0)**: a deny-only judge hook for native sessions. |
| Why it is better | A plugin cannot add auto-mode rules, so a hook is the only way it can hold a push or recursive delete to the user's request. |
| Measured by | **H13** (planned, 0.3.0): on a fixed command corpus the native judge hook allows 0 push, remote or recursive-delete commands without a matching request. |

## What a plugin can configure

| | |
|---|---|
| Claude Code ships | A plugin's `settings.json` applies only the `agent` and `subagentStatusLine` keys ([plugins reference](https://code.claude.com/docs/en/plugins-reference.md)). |
| The plugin adds | Gates as hooks (`hooks.json`), which a plugin can ship. Permission denies (`Agent(fork)`, the built-ins, push and delete rules) and `worktree.baseRef: "head"` cannot ship in a plugin: the README says what to add to your own settings, and the orchestrator checks `baseRef` before a parallel wave. |
| Why it is better | It is not; it is the boundary. Known gap: settings load from the folder a session started in, so a session started elsewhere does not see this repo's `.claude/settings.json` ([native-mode.md, Known limitations](native-mode.md#known-limitations)). |
| Measured by | Nothing; stated so nobody assumes the denies ship. |

## Evaluation

| | |
|---|---|
| Claude Code ships | `claude plugin eval` compares a session with the plugin against one without it; it has no script grader ([plugin evals](https://code.claude.com/docs/en/plugin-evals.md)). |
| The plugin adds | A benchmark with hidden-test graders, strict and lenient scores, a false-success classification and pre-registered hypotheses with mechanical verdicts (`bench/`, `bench/analyze.mjs`). **Planned (0.3.0)**: an eval suite for `claude plugin eval`. |
| Why it is better | A hidden test suite grades the result, not a model's opinion of it, and a hypothesis written before the run cannot be fitted to it. |
| Measured by | The verdict rules in [bench/HYPOTHESES.md](../bench/HYPOTHESES.md): n < 2 is inconclusive, and runs with 1 or 2 per arm show direction only. |
