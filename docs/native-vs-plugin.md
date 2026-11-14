# What Claude Code ships vs what this plugin adds

Claude Code already runs subagents in the background, scripts multi-agent workflows, forks the conversation into helpers, reviews diffs and gates risky commands in auto mode. This page compares each area with what the orchestration plugin (0.4.0) adds on top, why that is worth having, and how it is measured. Claude Code facts link to its docs; plugin facts point to the file that implements them; numbers come from the plugin's own logs and the benchmark.

**Where the plugin does not win.** Raw score is not its advantage. With Claude Code's built-in subagents allowed, plain Opus scored 99.7% on `k2-stdlib-toolkit-xl` by delegating to `general-purpose` itself (an earlier campaign, different plugin version; [README](../README.md#benchmark-orchestrator-vs-plain-sessions-built-in-subagents-blocked)). What the plugin adds is verification (gates that do not take the agent's word), routing cost (a plain session when the task does not split), safety (role limits and denies) and resumability (a run journal across sessions). The hypotheses H9 to H13 ([bench/HYPOTHESES.md](../bench/HYPOTHESES.md)) were written before any run of 0.2.0 to test exactly those claims.

The three items planned for 0.3.0 (a gated workflow, a native judge hook, an eval suite) shipped in 0.3.0; they are marked **shipped (0.3.0)** below. The eval suite has not been smoke-run yet ([native-mode.md, Known limitations](native-mode.md#known-limitations)). What 0.4.0 added is marked **0.4.0**; the details are in [native-mode.md, What 0.4.0 adds](native-mode.md#what-040-adds). The 0.4.0 comparison run (compare-040) shows direction only and did not exercise the read router ([bench/README.md](../bench/README.md#comparison-run-for-040-compare-040), [results](benchmark-compare-040.md)).

## Background agents and the review gate

| | |
|---|---|
| Claude Code ships | Subagents run in the background by default (since v2.1.198; [what's new, 2026 week 27](https://code.claude.com/docs/en/whats-new/2026-w27.md)). `Stop` and `SubagentStop` hook inputs carry `background_tasks`, the subagents, workflows and shell tasks still running ([hooks](https://code.claude.com/docs/en/hooks.md)). Verified on 2.1.314: headless `claude -p` fires an early `Stop` that lists the running tasks, delivers their result as a new turn, then fires a second `Stop` with `background_tasks: []`; it waits for background subagents but drops background shell tasks ([live checks](data/live-checks-2026-10-31.md), Check B). |
| The plugin adds | A Stop review gate that holds the final reply until every implementer's slice has a passing review, and defers (`agents_running`, not counted as a block) while `background_tasks` lists a running subagent, workflow or teammate (`.claude/hooks/review-gate.mjs`). Without `background_tasks` it pairs SubagentStart and SubagentStop records instead. |
| Why it is better | Claude Code reports what is running but does not stop a reply that ignores it. Before 0.2.0 the gate counted those early Stops as blocks and gave up: of 440 review-gate give-ups in the plugin's logs up to 2026-10-31, 430 fired while an agent was still running (320 of them a reviewer, 110 another agent) and 10 with nothing running. |
| Measured by | **H9**: review-gate give-ups that fire while an agent runs, over the first 14 days of real use after 0.2.0, target 0 (baseline 430 of 440). |

## Scripted workflows and runs

| | |
|---|---|
| Claude Code ships | The Workflow tool runs a saved script of agents; a run can be resumed only within the same session, and Claude Code starts one only on the person's explicit request, for example the `ultracode` keyword in a typed prompt or a direct request ([workflows](https://code.claude.com/docs/en/workflows.md)). The Workflow tool is removed from every subagent ([sub-agents](https://code.claude.com/docs/en/sub-agents.md)). |
| The plugin adds | A run model computed from log records (`foldRuns` in `.claude/hooks/brief.mjs`, spec in [brief-grammar.md](brief-grammar.md#run-model)): a run opens at a PLAN REVIEW or a light-path launch, closes when every slice is final, survives a new prompt and goes stale after `ORCH_RUN_STALE_MIN` minutes. The journal (`journal.jsonl`) records each slice's result, so an orchestrator asked to resume in a new session skips slices whose last review passed. The plugin's own scripted flow (`.claude/workflows/orchestrate.js`) fixes the order in code; its agents' SubagentStart and SubagentStop reach the gates under their bare `agent_type` (verified, Check C). **Shipped (0.3.0)**: the gated workflow ships in the plugin as `/orchestration:orchestrate` (project copy `/orchestrate`), started by the person: plan with a CONSTRAINTS ledger, explore, build, review with opus escalation on doubt signals, one replan of slices failed for good, integrate isolated code branches; it resumes in a new session from its logged plan (`args.plan`, `args.skip`). Its plugin copy names agents `orchestration:<role>`, because a plugin workflow does not find a bare agent type ([live checks, addendum](data/live-checks-2026-10-31.md#addendum-probes-for-030-claude-code-21314)). |
| Why it is better | Resume across sessions, and gates that see the same run whether the orchestrator's prompt or a script drives it. |
| Measured by | Not yet by a pre-registered hypothesis; the gate replays in `src/gate-replay.test.mjs` cover the run boundary. **H12** for the gated workflow; the bench arms `N-UC` (native workflow orchestration, no plugin) and `W-mix` (this workflow) and the short matrix `bench/matrix/short-k2.json` ([bench/README.md](../bench/README.md#short-documentation-run)) give a direction-only comparison (one rep per arm); each run records the workflow runs it really made. **Measured (2026-10-31 short run)**: both arms ran a workflow (`workflow_runs`: N-UC 12 agents, W-mix 27). W-mix 66.91% strict vs N-UC 92.91%, 0 false successes each; W-mix was killed at the deadline (tokens not measured), N-UC used 5.65M tokens. Direction against H12. One run per arm, one task, 10-minute cap: direction only, inconclusive under the verdict rules ([benchmark-short-k2.md](benchmark-short-k2.md)). |

## Fork subagents, built-ins and role limits

| | |
|---|---|
| Claude Code ships | Fork subagents are on by default (since v2.1.302): a fork inherits the whole conversation and its tools. The deny rule `Agent(fork)` turns them off. Subagents may nest, to a default depth of 3 ([sub-agents](https://code.claude.com/docs/en/sub-agents.md)). Six built-in subagent types (`general-purpose`, `claude`, `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`) are always available unless denied. |
| The plugin adds | In this repo, `permissions.deny` blocks the built-ins (seven since Claude Code 2.1.325 added `web-fetch`; one list, `.claude/hooks/builtin-agents.mjs`, checked against the installed Claude Code by `npm run claude-update`) and `Agent(fork)` (`DENIED_AGENTS` in `src/config.ts`, `.claude/settings.json`); headless runs export `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` and `CLAUDE_CODE_FORK_SUBAGENT=0` (`scripts/orchestrate.sh`). The implementer has `disallowedTools: Agent`, so a slice cannot fan out on its own; the orchestrator can launch only researcher, implementer, integrator and reviewer. While a run is open the plan check blocks fork and built-in launches in any session (`builtin_agent_in_run`; `ORCH_ALLOW_BUILTINS=1` turns it off) and implementers that are not in the reviewed plan (`not_in_plan`). |
| Why it is better | Every worker is one the gates track: a fork or a built-in would do work no review gate sees. Nesting is cut at one level below the orchestrator. |
| Measured by | `src/policy.test.ts`, `src/plan-hooks.test.mjs` (behaviour, not a benchmark). The 2026-10 campaign with the built-ins blocked is in [benchmark-builtins-blocked.md](benchmark-builtins-blocked.md). |

## Verification: constraints, review and escalation

| | |
|---|---|
| Claude Code ships | `/code-review` checks a diff for correctness bugs ([code review](https://code.claude.com/docs/en/code-review-local.md)). |
| The plugin adds | A constraints ledger: the orchestrator writes the task's hard rules as `C1: <text>` lines in the PLAN REVIEW brief, each slice names the ids its files can break (`CHECKS:`), and reviewers answer each id with `C1: pass (cmd) ...`, `C1: pass (read) ...` or `C1: fail ...` ([brief-grammar.md](brief-grammar.md)). The Stop gate blocks a passing review that leaves a checked id unanswered (`constraints_unchecked`) and requires a passing opus review when a doubt signal fires (`opus_review_required`: RISKY, a retry, a `(read)` answer, OPEN items, an isolated test failure; `ORCH_ESCALATION`). A test gate runs the project's tests before an implementer may finish (`.claude/hooks/verify.sh`). **0.4.0**: reviewers give each gap a confidence (`GAP: <0-100>`), and a fail whose gaps are all below 80 counts as a pass with a doubt signal (opus review); before a retry a `VALIDATE: gaps` reviewer re-checks the gaps against the diff; the third attempt is a fresh opus implementer; a stall gate (`replan_required`, native only) asks for a replan when a retry fails on the same gap; the test gate names failures the base commit also has (`ORCH_BASELINE`, inform by default) and checks a `KIND: bugfix` slice's reproduction test (`bugfix-check.mjs`). |
| Why it is better | A spec rule is not a bug in a diff. On k2 at a 10-minute cap the shipped orchestrator (O-mix) scored 92.4% strict with 2 false successes, both from one spec rule (`tomlparse` imported `re`) its reviewers missed; the all-Opus orchestrator (O-O) scored 99.8% ([README](../README.md#benchmark-orchestrator-vs-plain-sessions-built-in-subagents-blocked)). The ledger makes such rules explicit and the escalation sends doubtful slices to an opus reviewer without paying for opus on every slice. |
| Measured by | **H15–H17** (0.4.0: opus on the last attempt, gap cutoff plus refute, stall replan) on k2 from the run journals; compare-040 ran one k2 pair (0.4.0 98.98% strict at 5.03M tokens and 412 s, 0.3.0 99.72% at 5.23M and 453 s), direction only and without the journal counts the hypotheses need. **H10**: O-mix 0.2+ median strict score at least 97% with 0 false successes. **H11**: O-mix 0.2+ within 2 points of O-O's 99.8% at no more than 0.9x O-O's median tokens. **Measured (2026-10-31 short run)**: O-mix 0.3.0 scored 99.6% strict (equal to its lenient score) with 0 false successes at 4.44M tokens. Direction consistent with H10; for H11 the campaign has no O-O run, and the earlier O-O median (99.8%, 6.34M) comes from a different campaign. One run per arm, one task, 10-minute cap: direction only, inconclusive under the verdict rules ([benchmark-short-k2.md](benchmark-short-k2.md)). |

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
| The plugin adds | Headless runs pass push, remote, `sudo` and `rm -rf` as `--disallowedTools` (`UNSAFE_BASH`, `scripts/orchestrate.sh`). SDK workers use an opus Bash judge with the user's request as the only authority ([bash-judge.md](bash-judge.md)). **Shipped (0.3.0), opt-in**: with `ORCH_JUDGE=native`, a deny-only judge hook for native sessions, project copy or plugin: a floor with no model call (the `sudo`/`su` family, catastrophic `rm`, unreadable commands, `rm` targets that are symlinks or resolve outside the working folder), and `git push`, remote changes and recursive `rm` judged by `claude -p --model opus` with the person's typed prompts as the only authority; fail closed, decides within 45 s, logged to `gates.jsonl` ([bash-judge.md, Native hook](bash-judge.md#native-hook-030)). **0.4.0**: registered with Claude Code's `onFailure: "block"`, so a crash or timeout of the hook refuses the command; a missing `node` exits 0 and blocks nothing. |
| Why it is better | A plugin cannot add auto-mode rules, so a hook is the only way it can hold a push or recursive delete to the user's request. Being deny-only, it never loosens what auto mode or the permission rules decide. |
| Measured by | **H13**: on a fixed command corpus the native judge hook allows 0 push, remote or recursive-delete commands without a matching request. **Measured (2026-10-31, live, Claude Code 2.1.314)**: 0 allowed over the 28-entry corpus, 0 false denies, 28 of 28 as expected, 10 model calls: supported ([data](data/judge-corpus-live-2026-10-31.json)). |

## What a plugin can configure

| | |
|---|---|
| Claude Code ships | A plugin's `settings.json` applies only the `agent` and `subagentStatusLine` keys ([plugins reference](https://code.claude.com/docs/en/plugins-reference.md)). A plugin can declare typed `userConfig` settings, shown in `/config` and passed to its hooks as `CLAUDE_PLUGIN_OPTION_<KEY>` ([research, 6.6](research-2026-10-31.md#66-claude-code-features-to-use), **doc**). A `WorktreeCreate` hook can replace how isolated worktrees are made ([live checks, Check F](data/live-checks-2026-10-31.md#probes-for-040-slice-e-guards-claude-code-21316-2026-10-31)). |
| The plugin adds | Gates as hooks (`hooks.json`), which a plugin can ship. Permission denies (`Agent(fork)`, the built-ins, push and delete rules) and `worktree.baseRef: "head"` cannot ship in a plugin: the README says what to add to your own settings, and the orchestrator checks `baseRef` before a parallel wave. **0.4.0**: 15 `userConfig` settings, one per gate switch; the hooks read `ORCH_<KEY>` first, so an environment variable still wins ([native-mode.md, Switches](native-mode.md#switches-and-plugin-settings-040)). No WorktreeCreate hook: the probe showed that any hook failure stops every isolated launch and that hook-made worktrees are not removed, so `worktree.baseRef: "head"` stays the documented way. |
| Why it is better | Settings in `/config` instead of environment variables. The rest is the boundary. Known gap: settings load from the folder a session started in, so a session started elsewhere does not see this repo's `.claude/settings.json` ([native-mode.md, Known limitations](native-mode.md#known-limitations)). |
| Measured by | Nothing; stated so nobody assumes the denies ship. `src/build-plugin.test.mjs` checks the `userConfig` block. |

## Reading documents and choosing the reading model (0.4.0)

| | |
|---|---|
| Claude Code ships | The Read tool reads text, images and PDFs. A subagent runs on the model its definition or the launch names; nothing looks at what it is asked to read ([research, section 2](research-2026-10-31.md#2-choosing-the-reading-model-by-file-type)). |
| The plugin adds | An opt-in read router (`ORCH_READ_ROUTER=on`) in `plan-check.mjs`: for a researcher brief with `SOURCES:` it profiles each file with local tools (`file-profile.mjs`, no model call), raises the researcher's model when a file needs it (a scan, tables, formulas, a long document with a judge question), never lowers it, and adds cached text conversions to the brief. Researchers back facts with `QUOTE:` lines, and `quote-check.mjs` blocks once when a quote is not in its source. |
| Why it is better | The premise ([research, 2.1](research-2026-10-31.md#21-why-it-pays)): one model for every read either pays a large model for clean text or gives a small model scans and tables. Not shown by a benchmark yet. |
| Measured by | **H14** on `d2-docs`. **Untested**: in compare-040 every d2-docs run took the light path and launched no researcher, so the router never fired; all three arms scored 100% (2 runs each). The router was verified by one live check (a scanned-PDF researcher raised from haiku to sonnet, telemetry showed `claude-sonnet-5-5`). Workflow researchers are not routed (the `agent.spawn` probe was not run). |

## Skills (0.4.0)

| | |
|---|---|
| Claude Code ships | Skills on disk, plugins' skills and the Skill tool; a session loads a skill when it judges that the skill's description fits the task. |
| The plugin adds | A `SKILLS:` brief line the orchestrator writes when a slice clearly needs an installed skill, and a suggestion block the plan check appends to implementer, researcher and reviewer launches: at most 3 installed skills (1 for a reviewer), names and reason codes only, from the file types in FILES or SOURCES, the role and the goal (`skill-catalog.mjs`, `skill-hint.mjs`). Researcher and reviewer got the `Skill` tool. |
| Why it is better | A worker starts with a one-line pointer to the skill a document or UI slice needs, instead of depending on it noticing the skill itself. |
| Measured by | Unit tests only (`src/skills.test.mjs`). Limits: the catalog misses `--plugin-dir` plugins and skills bundled with Claude Code, and workflow agents get no hints. |

## Context after compaction (0.4.0)

| | |
|---|---|
| Claude Code ships | Automatic compaction, and hook events around it (`PostCompact`, and `SessionStart` with source `compact`). |
| The plugin adds | `compact-context.mjs`: after a compaction it puts the open run's planned slices, their states and the constraint texts back in context, about 1,500 characters. It uses `SessionStart` with matcher `compact`, because PostCompact cannot add context. |
| Why it is better | The orchestrator's plan lives in the conversation; a summary can drop which slices passed and which rules apply. |
| Measured by | Unit tests only. |

## Role guards and outbound access (0.4.0)

| | |
|---|---|
| Claude Code ships | Per-agent `tools` lists, permission rules and modes, and a sandbox for Bash with a network allowlist ([research, 6.5](research-2026-10-31.md#65-security)). A pattern like `Bash(ls*)` in an agent's `tools` did not stop a researcher in auto mode from writing a file with a heredoc and running `python3` (**verified**, [research, section 3 item 4](research-2026-10-31.md#3-other-improvements-ranked)). |
| The plugin adds | `researcher-guard.mjs` holds the researcher to its read-only Bash list on every segment of a command; `egress-guard.mjs` lets a reviewer fetch only hosts named in its brief or its slice's planned files. Both deny-only, off with `ORCH_GUARDS=off`. |
| Why it is better | The reviewer reads untrusted content, sees the repository and can send data out; the egress guard narrows the last part. It is not a boundary: Bash can still reach the network, so the README recommends Claude Code's sandbox with a network allowlist for implementer and reviewer Bash. |
| Measured by | Unit tests (`src/guards.test.mjs`); the transcript shapes the egress guard reads were probed live (Check E). |

## Cost per role (0.4.0)

| | |
|---|---|
| Claude Code ships | `/cost` and OpenTelemetry give session totals; with `OTEL_LOG_TOOL_DETAILS=1` the metrics carry agent names ([research, 3 item 1 and 6.6](research-2026-10-31.md#66-claude-code-features-to-use)). |
| The plugin adds | Telemetry v2: tokens, turns, models and max-turn hits per subagent, read from its transcript at SubagentStop; a read log (`reads.jsonl`, never content); a file trail per slice from tool calls and git; a per-role table in `npm run report`. |
| Why it is better | It splits cost by role and slice without an OTel collector. |
| Measured by | Unit tests (`src/telemetry-v2.test.mjs`). Headless runs keep no subagent transcripts, so these fields are empty there, benchmark runs included. |

## Evaluation

| | |
|---|---|
| Claude Code ships | `claude plugin eval` compares a session with the plugin against one without it; it has no script grader ([plugin evals](https://code.claude.com/docs/en/plugin-evals.md)). |
| The plugin adds | A benchmark with hidden-test graders, strict and lenient scores, a false-success classification and pre-registered hypotheses with mechanical verdicts (`bench/`, `bench/analyze.mjs`). **Shipped (0.3.0)**: an eval suite for `claude plugin eval` (`evals/`, shipped in `dist/plugin/evals/`; `npm run eval`, paid, capped by `--max-cost-usd`): four cases from the bench tasks t2, t1, c1 and d1, graded by free graders, reporting the delta between sessions with and without the plugin. Not smoke-run yet. |
| Why it is better | A hidden test suite grades the result, not a model's opinion of it, and a hypothesis written before the run cannot be fitted to it. |
| Measured by | The verdict rules in [bench/HYPOTHESES.md](../bench/HYPOTHESES.md): n < 2 is inconclusive, and runs with 1 or 2 per arm show direction only. |
