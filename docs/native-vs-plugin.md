# What Claude Code ships vs what this plugin adds

For anyone deciding whether to install the plugin. Area by area, this page says what Claude Code already does, what the orchestration plugin adds on top, why that is worth having, and how each claim is measured. Claude Code facts link to its docs; plugin facts name the file that implements them; numbers come from the plugin's own logs and the [benchmark](../bench/README.md). Terms: [glossary](glossary.md).

Claude Code already runs subagents in the background, scripts multi-agent workflows, forks the conversation into helpers, reviews diffs with `/code-review` and weighs intent in auto mode.

**Where the plugin does not win.** Raw score is not its advantage. With Claude Code's built-in subagents allowed, plain Opus scored 99.7% on `k2-stdlib-toolkit-xl` by delegating to them itself (an earlier campaign, an earlier plugin version; [Results: built-in subagents blocked](../bench/README.md#results-built-in-subagents-blocked)). What the plugin adds:
- **Verification**: gates that do not take a worker's word.
- **Routing cost**: a plain session when the task does not split.
- **Safety**: role limits, guards, and denies for fork and built-in subagents.
- **Resumability**: a run journal that outlives the session.

The hypotheses H9 to H13 in [bench/HYPOTHESES.md](../bench/HYPOTHESES.md) were written before any run of 0.2.0 to test those claims. The 0.4.0 comparison run (compare-040) shows direction only and did not exercise the read router ([bench/README.md](../bench/README.md#comparison-run-for-040-compare-040), [results](benchmark-compare-040.md)). The research behind the newer areas, and what of it shipped, is in [research-2026-10-31.md, Implementation status](research-2026-10-31.md#implementation-status-040). How the plugin works: [How the native orchestrator works](native-mode.md); the exact brief lines: [Brief and reply grammar](brief-grammar.md).

## Background agents and the review gate

| | |
|---|---|
| Claude Code ships | Subagents run in the background by default (since v2.1.198; [what's new, 2026 week 27](https://code.claude.com/docs/en/whats-new/2026-w27.md)). `Stop` and `SubagentStop` hook inputs carry `background_tasks`: the subagents, workflows and shell tasks still running ([hooks](https://code.claude.com/docs/en/hooks.md)). Checked on 2.1.314: headless `claude -p` fires an early `Stop` that lists the running tasks, delivers their result as a new turn, then fires a second `Stop` with `background_tasks: []`. It waits for background subagents but drops background shell tasks ([live checks](data/live-checks-2026-10-31.md), Check B). |
| The plugin adds | A Stop [review gate](glossary.md#r) that holds the final reply until every implementer's slice has a passing review. It waits (`agents_running`, not counted as a block) while `background_tasks` lists a running subagent, workflow or teammate (`.claude/hooks/review-gate.mjs`). Without `background_tasks` it pairs SubagentStart and SubagentStop records instead. |
| Why it is better | Claude Code reports what is running but does not stop a reply that ignores it. Before 0.2.0 the gate counted those early Stops as blocks and gave up. Of 440 review-gate give-ups in the plugin's logs up to 2026-10-31, 430 fired while an agent was still running (320 of them a reviewer, 110 another agent) and 10 with nothing running. |
| Measured by | **H9**: review-gate give-ups that fire while an agent runs, over the first 14 days of real use after 0.2.0. Target 0 (baseline 430 of 440). |

## Scripted workflows and runs

| | |
|---|---|
| Claude Code ships | The Workflow tool runs a saved script of agents. A run can be resumed only within the same session. Claude Code starts one only on the person's explicit request, for example the `ultracode` keyword in a typed prompt or a direct request ([workflows](https://code.claude.com/docs/en/workflows.md)). The Workflow tool is removed from every subagent ([sub-agents](https://code.claude.com/docs/en/sub-agents.md)). |
| The plugin adds | A [run](glossary.md#r) model computed from log records (`foldRuns` in `.claude/hooks/brief.mjs`; spec in [brief-grammar.md, Run model](brief-grammar.md#run-model)). A run opens at a PLAN REVIEW or a light-path launch, closes when every slice is final, survives a new prompt, and goes stale after `ORCH_RUN_STALE_MIN` minutes. The journal (`journal.jsonl`) records each slice's result, so an orchestrator asked to resume in a new session skips slices whose last review passed. The [gated workflow](native-mode.md#the-gated-workflow) (`.claude/workflows/orchestrate.js`) fixes the order in code. The plugin ships it as `/orchestration:orchestrate` (project copy `/orchestrate`), and the person starts it. It plans with a constraints ledger, explores, builds, reviews with an opus review on doubt signals, replans once the slices that failed for good, and merges isolated code branches. It resumes in a new session from the plan in its result (`args.plan`, `args.skip`). Its agents' SubagentStart and SubagentStop reach the gates under their bare `agent_type` (checked, Check C). Its plugin copy names agents `orchestration:<role>`, because a plugin workflow does not find a bare agent type ([live checks, addendum](data/live-checks-2026-10-31.md#addendum-probes-for-030-claude-code-21314)). |
| Why it is better | Resume across sessions, and gates that see the same run whether the orchestrator's prompt or a script drives it. |
| Measured by | The run boundary: the gate replays in `src/gate-replay.test.mjs`, not a pre-registered hypothesis. The gated workflow: **H12**. The bench arms `N-UC` (native workflow orchestration, no plugin) and `W-mix` (this workflow) and the short matrix `bench/matrix/short-k2.json` ([bench/README.md](../bench/README.md#short-documentation-run)) give a direction-only comparison, one run per arm. Each run records the workflow runs it really made. **Measured (2026-10-31 short run)**: both arms ran a workflow (`workflow_runs`: N-UC 12 agents, W-mix 27). W-mix scored 66.91% strict against N-UC's 92.91%, with 0 false successes each. W-mix was killed at the deadline (tokens not measured); N-UC used 5.65M tokens. Direction against H12. One run per arm, one task, 10-minute cap: direction only, inconclusive under the verdict rules ([benchmark-short-k2.md](benchmark-short-k2.md)). |

## Fork subagents, built-ins and role limits

| | |
|---|---|
| Claude Code ships | Fork subagents are on by default (since v2.1.302): a fork inherits the whole conversation and its tools. The deny rule `Agent(fork)` turns them off. Subagents may nest, to a default depth of 3 ([sub-agents](https://code.claude.com/docs/en/sub-agents.md)). The [built-in subagent](glossary.md#b) types (the list is `BUILTIN_AGENTS` in `.claude/hooks/builtin-agents.mjs`; seven since Claude Code 2.1.325) are always available unless denied. |
| The plugin adds | In this repo, `permissions.deny` blocks the built-ins and `Agent(fork)` (`DENIED_AGENTS` in `src/config.ts`, `.claude/settings.json`). `npm run claude-update` checks the list against the installed Claude Code. Headless runs export `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` and `CLAUDE_CODE_FORK_SUBAGENT=0` (`scripts/orchestrate.sh`). The implementer has `disallowedTools: Agent`, so a slice cannot fan out on its own; the orchestrator can launch only the researcher, implementer, integrator and reviewer. While a run is open, the plan check blocks fork and built-in launches in any session (`builtin_agent_in_run`; `ORCH_ALLOW_BUILTINS=1` turns it off) and implementers that are not in the reviewed plan (`not_in_plan`). |
| Why it is better | Every worker is one the gates track: a fork or a built-in would do work no review gate sees. Nesting stops one level below the orchestrator. |
| Measured by | `src/policy.test.ts` and `src/plan-hooks.test.mjs` (behaviour, not a benchmark). The 2026-10 campaign with the built-ins blocked is in [benchmark-builtins-blocked.md](benchmark-builtins-blocked.md). |

## Verification: constraints, review and opus review

| | |
|---|---|
| Claude Code ships | `/code-review` checks a diff for correctness bugs ([code review](https://code.claude.com/docs/en/code-review-local.md)). |
| The plugin adds | A [constraints ledger](glossary.md#c): the orchestrator writes the task's hard rules as `C1: <text>` lines in the PLAN REVIEW brief. Each slice names the ids its files can break (`CHECKS:`), and reviewers answer each id with `C1: pass (cmd) ...`, `C1: pass (read) ...` or `C1: fail ...` ([brief-grammar.md](brief-grammar.md)). The Stop gate blocks a passing review that leaves a checked id unanswered (`constraints_unchecked`). It requires a passing [opus review](glossary.md#o) when a [doubt signal](gates.md#doubt-signals) fires (`opus_review_required`: RISKY, a retry, a `(read)` answer, OPEN items, an isolated test failure, a test gate that gave up; `ORCH_ESCALATION`). A test gate runs the project's tests before an implementer may finish (`.claude/hooks/verify.sh`). Reviewers give each gap a confidence (`GAP: <0-100>`), and a fail whose gaps are all below 80 counts as a pass with a doubt signal. Before a retry a `VALIDATE: gaps` reviewer re-checks the gaps against the diff. The third attempt is a fresh opus implementer. The stall gate (`replan_required`, native only) asks for a replan when a retry fails on the same gap. The test gate names failures the base commit also has (`ORCH_BASELINE`, `inform` by default) and checks a `KIND: bugfix` slice's reproduction test (`bugfix-check.mjs`). |
| Why it is better | A spec rule is not a bug in a diff. On k2 at a 10-minute cap the shipped orchestrator (O-mix) scored 92.4% strict with 2 false successes, both from one spec rule its reviewers missed (`tomlparse` imported `re`). The all-Opus orchestrator (O-O) scored 99.8% ([Results: built-in subagents blocked](../bench/README.md#results-built-in-subagents-blocked)). The ledger makes such rules explicit, and the opus review sends doubtful slices to an opus reviewer without paying for opus on every slice. |
| Measured by | **H15 to H17** (opus on the last attempt, gap cutoff plus refute, the replan of a stalled slice) on k2 from the run journals. compare-040 ran one k2 pair (0.4.0: 98.98% strict at 5.03M tokens and 412 s; 0.3.0: 99.72% at 5.23M and 453 s). That is direction only, and it lacks the journal counts the hypotheses need. **H10**: O-mix 0.2+ median strict score at least 97% with 0 false successes. **H11**: O-mix 0.2+ within 2 points of O-O's 99.8% at no more than 0.9x O-O's median tokens. **Measured (2026-10-31 short run)**: O-mix 0.3.0 scored 99.6% strict (equal to its lenient score) with 0 false successes at 4.44M tokens. Direction consistent with H10. For H11 the campaign has no O-O run, and the earlier O-O median (99.8%, 6.34M) comes from another campaign. One run per arm, one task, 10-minute cap: direction only, inconclusive under the verdict rules ([benchmark-short-k2.md](benchmark-short-k2.md)). |

## Routing cost

| | |
|---|---|
| Claude Code ships | No router: a session decides for itself whether to delegate. |
| The plugin adds | [Triage](glossary.md#t) on five facts (files, lines, independent slices, risky, code) that picks a plain session, a plain session plus one reviewer, or the orchestrate route (`src/triage.ts`, the `/route` skill, the nudge). |
| Why it is better | On small and medium coding tasks the orchestrate route cost 1.2x to 2.1x the tokens of a plain session for the same 100% ([Results: why a router](../bench/README.md#results-why-a-router)). |
| Measured by | H2 and H5 (pre-registered 2026-10-15; results in [benchmarks.md](benchmarks.md)); H11 for the cost of opus reviews inside the orchestrate route. |

## Pushes, deletes and auto mode

| | |
|---|---|
| Claude Code ships | Auto mode weighs the user's intent for soft-deny actions, but allows ordinary pushes to the working repository by default. It reads its rules only from user and managed settings, not from project settings or plugins ([auto mode config](https://code.claude.com/docs/en/auto-mode-config.md), [permission modes](https://code.claude.com/docs/en/permission-modes.md)). |
| The plugin adds | Headless runs pass push, remote, `sudo` and `rm -rf` as `--disallowedTools` (`UNSAFE_BASH`, `scripts/orchestrate.sh`). SDK workers use an opus Bash judge with the user's request as the only authority ([bash-judge.md](bash-judge.md)). Opt-in with `ORCH_JUDGE=native`: a deny-only judge hook for native sessions, project copy or plugin. It refuses a floor with no model call: the `sudo`/`su` family, catastrophic `rm`, commands it cannot read, and `rm` targets that are symlinks or resolve outside the working folder. It sends `git push`, remote changes and recursive `rm` to `claude -p --model opus`, with the person's typed prompts as the only authority. It fails closed, decides within 45 s and logs to `gates.jsonl` ([bash-judge.md, Native hook](bash-judge.md#native-hook)). It is registered with Claude Code's `onFailure: "block"`, so a crash or timeout of the hook refuses the command; a missing `node` exits 0 and blocks nothing. |
| Why it is better | A plugin cannot add auto-mode rules, so a hook is the only way it can hold a push or a recursive delete to the user's request. Being deny-only, it never loosens what auto mode or the permission rules decide. |
| Measured by | **H13**: on a fixed command corpus the native judge hook allows 0 push, remote or recursive-delete commands without a matching request. **Measured (2026-10-31, live, Claude Code 2.1.314)**: 0 allowed over the 28-entry corpus, 0 false denies, 28 of 28 as expected, 10 model calls: supported ([data](data/judge-corpus-live-2026-10-31.json)). |

## What a plugin can configure

| | |
|---|---|
| Claude Code ships | A plugin's `settings.json` applies only the `agent` and `subagentStatusLine` keys ([plugins reference](https://code.claude.com/docs/en/plugins-reference.md)). A plugin can declare typed `userConfig` settings, shown in `/config` and passed to its hooks as `CLAUDE_PLUGIN_OPTION_<KEY>` ([research, 6.6](research-2026-10-31.md#66-claude-code-features-to-use), **doc**). A `WorktreeCreate` hook can replace how isolated worktrees are made ([live checks, Check F](data/live-checks-2026-10-31.md#probes-for-040-slice-e-guards-claude-code-21316-2026-10-31)). |
| The plugin adds | Gates as hooks (`hooks.json`), which a plugin can ship. Permission denies (`Agent(fork)`, the built-ins, push and delete rules) and `worktree.baseRef: "head"` cannot ship in a plugin. The README's [Install](../README.md#install) says what to add to your own settings, and the orchestrator checks `baseRef` before a parallel wave. 20 `userConfig` settings, one per switch; the hooks read `ORCH_<KEY>` first, so an environment variable still wins ([Plugin settings](settings.md#plugin-settings)). No WorktreeCreate hook: the probe showed that any hook failure stops every isolated launch and that hook-made worktrees are not removed, so `worktree.baseRef: "head"` stays the documented way. |
| Why it is better | Settings in `/config` instead of environment variables. The rest is the boundary. Known gap: settings load from the folder a session started in, so a session started elsewhere does not see this repo's `.claude/settings.json` ([native-mode.md, Limits](native-mode.md#limits)). |
| Measured by | Nothing; stated so nobody assumes the denies ship. `src/build-plugin.test.mjs` checks the `userConfig` block. |

## Reading documents and choosing the reading model

| | |
|---|---|
| Claude Code ships | The Read tool reads text, images and PDFs. A subagent runs on the model its definition or the launch names; nothing looks at what it is asked to read ([research, section 2](research-2026-10-31.md#2-choosing-the-reading-model-by-file-type)). |
| The plugin adds | An opt-in [read router](gates.md#read-router) (`ORCH_READ_ROUTER=on`) in `plan-check.mjs`. For a researcher brief with `SOURCES:` it profiles each file with local tools (`file-profile.mjs`, no model call). It raises the researcher's model when a file needs it (a scan, tables, formulas, a long document with a judge question), never lowers it, and adds cached text conversions to the brief. Researchers back facts with `QUOTE:` lines, and `quote-check.mjs` blocks once when a quote is not in its source. |
| Why it is better | The premise ([research, 2.1](research-2026-10-31.md#21-why-it-pays)): one model for every read either pays a large model for clean text or gives a small model scans and tables. Not shown by a benchmark yet. |
| Measured by | **H14** on `d2-docs`. **Untested** there: in compare-040 every d2-docs run took the light path and launched no researcher, so the router never fired; all three arms scored 100% (2 runs each). The router was checked by one live run (a scanned-PDF researcher raised from haiku to sonnet; telemetry showed `claude-sonnet-5-5`) and benchmarked once on `d3-reader`, direction only ([Read router benchmark (route-040)](../bench/README.md#read-router-benchmark-route-040)). Workflow researchers are not routed (the `agent.spawn` probe showed it could be done; it is not built). |

## Skills

| | |
|---|---|
| Claude Code ships | Skills on disk, plugins' skills and the Skill tool. A session loads a skill when it judges that the skill's description fits the task. |
| The plugin adds | A `SKILLS:` brief line the orchestrator writes when a slice clearly needs an installed skill. The plan check appends [skill suggestions](skills.md#suggestions) to implementer, researcher and reviewer launches: at most 3 installed skills (1 for a reviewer, 2 on opus or above), names and reason codes only. It picks them from the file types in FILES or SOURCES, the role and the goal (`skill-catalog.mjs`, `skill-hint.mjs`). The researcher and the reviewer have the `Skill` tool. |
| Why it is better | A worker starts with a one-line pointer to the skill a document or UI slice needs, instead of depending on it noticing the skill itself. |
| Measured by | Unit tests only (`src/skills.test.mjs`). Limits: the catalog misses `--plugin-dir` plugins and skills bundled with Claude Code, and workflow agents get no suggestions ([skills.md, Limits](skills.md#limits)). |

## Context after compaction

| | |
|---|---|
| Claude Code ships | Automatic compaction, and hook events around it (`PostCompact`, and `SessionStart` with source `compact`). |
| The plugin adds | `compact-context.mjs`: after a compaction it puts the open run's planned slices, their states and the constraint texts back in context, about 1,500 characters. It uses `SessionStart` with matcher `compact`, because PostCompact cannot add context ([Context after compaction](gates.md#context-after-compaction)). |
| Why it is better | The orchestrator's plan lives in the conversation; the compacted text can drop which slices passed and which rules apply. |
| Measured by | Unit tests only. |

## Role guards and outbound access

| | |
|---|---|
| Claude Code ships | Per-agent `tools` lists, permission rules and modes, and a sandbox for Bash with a network allowlist ([research, 6.5](research-2026-10-31.md#65-security)). A pattern like `Bash(ls*)` in an agent's `tools` did not stop a researcher in auto mode from writing a file with a heredoc and running `python3` (**verified**, [research, section 3 item 4](research-2026-10-31.md#3-other-improvements-ranked)). |
| The plugin adds | The [researcher guard](gates.md#researcher-guard) (`researcher-guard.mjs`) holds the researcher to its read-only Bash list on every part of a command. The [egress guard](gates.md#egress-guard) (`egress-guard.mjs`) lets a reviewer fetch only hosts named in its brief, its launch record or its slice's planned files. Both are deny-only and off with `ORCH_GUARDS=off`. |
| Why it is better | The reviewer reads untrusted content, sees the repository and can send data out; the egress guard narrows the last part. It is not a boundary: Bash can still reach the network, so run implementer and reviewer Bash in Claude Code's sandbox with a network allowlist ([Safety](safety.md#sandbox)). |
| Measured by | Unit tests (`src/guards.test.mjs`); the transcript shapes the egress guard reads were probed live (Check E). |

## Cost per role

| | |
|---|---|
| Claude Code ships | `/cost` and OpenTelemetry give session totals; with `OTEL_LOG_TOOL_DETAILS=1` the metrics carry agent names ([research, 3 item 1 and 6.6](research-2026-10-31.md#66-claude-code-features-to-use)). |
| The plugin adds | [Telemetry](logs.md#telemetry): tokens, turns, models and turn-limit hits per worker, read from its transcript at SubagentStop. Also a read log (`reads.jsonl`, never content), a file trail per slice from tool calls and git, and a per-role table in `npm run report`. |
| Why it is better | It splits cost by role and slice without an OpenTelemetry collector. |
| Measured by | Unit tests (`src/telemetry-v2.test.mjs`). Headless runs, benchmark runs included, fill these fields only with `ORCH_SESSION_PERSISTENCE=1` (the `reader-*` bench arms set it); without it they keep no subagent transcripts and the fields stay empty. |

## Evaluation

| | |
|---|---|
| Claude Code ships | `claude plugin eval` compares a session with the plugin against one without it; it has no script grader ([plugin evals](https://code.claude.com/docs/en/plugin-evals.md)). |
| The plugin adds | A benchmark with hidden-test graders, strict and lenient scores, a false-success classification and pre-registered hypotheses with mechanical verdicts (`bench/`, `bench/analyze.mjs`). An [eval suite](../bench/README.md#plugin-eval-suite) for `claude plugin eval` (`evals/`, shipped in `dist/plugin/evals/`; `npm run eval`, paid, capped by `--max-cost-usd`). It has eight cases with free graders: four from the bench tasks t1, t2, c1 and d1, and four from failures seen in projects, `e1` to `e4`. It reports the delta between sessions with and without the plugin. Smoke-run on 2026-11-10: bounded to `t2-single`, one run, twice, about $0.37 each. It runs end to end, and 4 of 7 graders passed. |
| Why it is better | A hidden test suite grades the result, not a model's opinion of it, and a hypothesis written before the run cannot be fitted to it. |
| Measured by | The verdict rules in [bench/HYPOTHESES.md](../bench/HYPOTHESES.md): n < 2 is inconclusive, and runs with 1 or 2 per arm show direction only. |
