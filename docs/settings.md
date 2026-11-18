# Settings and switches

This page lists every plugin setting and environment variable the native orchestrator reads, with its default and its effect. It is for maintainers. What each gate does is in [gates.md](gates.md); the SDK pipeline's own variables are in [sdk-pipeline.md, Environment](sdk-pipeline.md#environment).

A [switch](glossary.md#s) is an environment variable named `ORCH_*`. Switches are named only in maintainer text: these docs, CLAUDE.md, `.claude/rules/agents.md` and hook comments. Never in agent bodies, skills or the nudge's context; `src/contracts.test.ts` checks this.

## How a setting reaches the hooks

1. The plugin declares 22 [plugin settings](glossary.md#p) as `userConfig` (`OPTIONS` in `scripts/build-plugin.mjs`). They show in `/config`.
2. Claude Code passes each one to the hooks as `CLAUDE_PLUGIN_OPTION_<KEY>` (the key in upper case).
3. The hooks copy it to `ORCH_<KEY>` only when `ORCH_<KEY>` is unset (`OPTION_KEYS` and `bridgeOptions` in `.claude/hooks/state.mjs`; `verify.sh` keeps the same list). So an environment variable wins over `/config`.
4. The project copy of the hooks (registered in `.claude/settings.json`) reads only the environment.

The plugin ships no `settings.json` since 1.6.1 (it held only `subagentStatusLine`; the mod now rewrites the worker rows, [dashboard.md](dashboard.md#the-row-of-each-worker); which component drew the rows in the live capture is not established, [limits.md](limits.md), K2).

The node hooks read `off`, `on`, `always` and `native` in any case, with spaces trimmed. `verify.sh` compares `ORCH_GATE_ISOLATED`, `ORCH_BASELINE`, `ORCH_BUGFIX_CHECK` and `ORCH_HANDBACK_GATE` exactly, in lower case. `ORCH_ALLOW_BUILTINS` and `ORCH_ALLOW_HAIKU` act only on `1`.

## Plugin settings

In the order of `OPTIONS` in `scripts/build-plugin.mjs`:

| Key | Environment | Default | Effect |
|---|---|---|---|
| `test_cmd` | `ORCH_TEST_CMD` | detected ([gates.md, Runner detection](gates.md#runner-detection)) | The [test gate](gates.md#test-gate)'s command. When set, it always runs, even for a prose-only change. |
| `escalation` | `ORCH_ESCALATION` | empty: an opus review for a slice with a doubt signal | `off` turns every [doubt signal](gates.md#doubt-signals) off, so `opus_review_required` never fires. `always` requires an opus review for every slice. |
| `judge` | `ORCH_JUDGE` | empty: off | `native` turns on the deny-only native Bash judge hook ([bash-judge.md, Native hook](bash-judge.md#native-hook)). For SDK workers, `off` turns their judge off ([bash-judge.md, 6 Configuration](bash-judge.md#6-configuration)). |
| `judge_timeout_ms` | `ORCH_JUDGE_TIMEOUT_MS` | 40000 | The native judge's model-call timeout, in ms, capped at 45000, so the hook decides before Claude Code's 60 s default hook timeout. |
| `read_router` | `ORCH_READ_ROUTER` | empty: off | `on` turns on the [read router](gates.md#read-router). |
| `gap_min` | `ORCH_GAP_MIN` | 80 | The [gap cutoff](gates.md#gap-cutoff): an integer from 0 to 100. Any other value counts as 80. 0 makes every failing review count as a fail. |
| `stall_gate` | `ORCH_STALL_GATE` | empty: on | `off` turns the [stall gate](gates.md#stall-gate) off (no `replan_required`). |
| `guards` | `ORCH_GUARDS` | empty: on | `off` turns off the [researcher guard](gates.md#researcher-guard) and the [egress guard](gates.md#egress-guard). With the guards on, a reviewer whose brief cannot be read is held to the hosts of its launch record; `egress_unverified` is logged only when no launch record exists either. |
| `allow_builtins` | `ORCH_ALLOW_BUILTINS` | empty: blocked while a run is open | `1` lets fork and built-in subagents launch while a run is open (no `builtin_agent_in_run`). |
| `run_stale_min` | `ORCH_RUN_STALE_MIN` | 30 | Minutes with nothing running and no launch, stop or agent start before an open run is stale. A value that is not a positive number counts as 30. |
| `baseline` | `ORCH_BASELINE` | `inform` | `inform`, `allow` or `off`: how the [test baseline](gates.md#test-baseline) uses a run on the base. Any value other than `allow` or `off` acts as `inform`. |
| `bugfix_check` | `ORCH_BUGFIX_CHECK` | empty: on | `off` skips the [bugfix check](gates.md#bugfix-check). |
| `quote_check` | `ORCH_QUOTE_CHECK` | empty: on | `off` skips the [quote check](gates.md#quote-check). |
| `gate_isolated` | `ORCH_GATE_ISOLATED` | `warn` | The test gate in isolated worktrees: `warn` (run, log, never block), `block` or `skip` ([gates.md, Test gate in worktrees](gates.md#test-gate-in-worktrees)). |
| `skill_hints` | `ORCH_SKILL_HINTS` | empty: on | `off` drops the [skill suggestions](skills.md#suggestions) block. An explicit `SKILLS:` line still reaches the worker. |
| `allow_haiku` | `ORCH_ALLOW_HAIKU` | empty: haiku raised to sonnet | `1` lets a launch of this plugin's agents run on a haiku model ([gates.md, Plan check: how it changes a launch](gates.md#plan-check-how-it-changes-a-launch)). |
| `handback_check` | `ORCH_HANDBACK_CHECK` | empty: on | `off` skips the [report check](gates.md#report-check). The hand-back capture is still written. |
| `skill_create` | `ORCH_SKILL_CREATE` | empty: on | `off` blocks every skill slice (`skill_create_off`), so a run drafts no skill ([skills.md](skills.md)). |
| `skills_repo_private` | `ORCH_SKILLS_REPO_PRIVATE` | unset | Absolute path of the private skills repository, where a new skill goes by default. Unset, a skill slice is blocked with `skill_repo_missing`. |
| `skills_repo_public` | `ORCH_SKILLS_REPO_PUBLIC` | unset | Absolute path of the public skills repository, for a skill slice with `TARGET: public`. |
| `workflow_guard` | `ORCH_WORKFLOW_GUARD` | empty: on | `off` turns the [workflow guard](gates.md#workflow-guard) off, so every Workflow launch goes through, a script written on the spot (the `ultracode` keyword) included. On, only the saved `orchestrate` workflow starts (1.6.0), checked by its content since 1.6.1. The switch also covers the refusal of a typed prompt holding the word `ultracode` (1.6.1): `off` lets such a prompt through. |
| `review_hold` | `ORCH_REVIEW_HOLD` | empty: on | `off` turns off the plan check's reviewer hold (1.6.1): a slice's reviewer is no longer refused with `tests_failed_after_report` while its implementer has a failed-tests block it never saw, and gets no note while the test gate is still running ([gates.md, Plan check](gates.md#plan-check)). The review gate still holds the final reply. |

## Environment variables

These have no plugin setting: set them in the environment.

### Test gate time

| Variable | Read by | Default | Effect |
|---|---|---|---|
| `ORCH_HOOK_BUDGET_S` | `verify.sh` | min(870, stall limit in seconds − 60): 540 with the stall limit unset | The whole test gate's time, in seconds. It is also the maximum: a larger value is cut to it, a smaller one is kept. The wait for the suite lock, the test run and the base run or bugfix check all count against it. A bugfix check that runs out blocks with `bugfix_timeout`. ([gates.md, Time budget and suite lock](gates.md#time-budget-and-suite-lock)) |
| `ORCH_TEST_TIMEOUT_S` | `verify.sh` | 600 | The test run's own limit, in seconds. The run gets the smaller of this and the time left in the budget, so with the default budget the time left (at most 540 s) decides. A suite that runs longer gets SIGTERM with its children, SIGKILL 5 s later, and blocks as `tests_failed` with `timed_out` and `limit_s`, whatever status it exits with. |
| `ORCH_BASE_TIMEOUT_S` | `bugfix-check.mjs` | 300 | The limit of one base run of the test baseline or the bugfix check. `verify.sh` lowers it to that run's share of the time left, less 10 s. |
| `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` | `verify.sh` (Claude Code's own setting) | 600000 | Claude Code ends a subagent that makes no progress for this many ms; time in a stop hook counts. The gate's budget stays 60 s under it, and never above 870 s. A value that is not a positive whole number reads as 600 s. |

### Plan check and other hooks

| Variable | Read by | Default | Effect |
|---|---|---|---|
| `ORCH_HANDBACK_GATE` | `verify.sh --handback` | on | `off` turns off the test gate's run at an implementer's hand-back ([gates.md, Hand-back gate](gates.md#hand-back-gate)), logged as `handback_gate_off`; the SubagentStop gate still runs. Compared exactly, in lower case. |
| `ORCH_SOURCES_NOTE` | `plan-check.mjs` | on | `off` drops the coverage note added to our researcher's launch when its `SOURCES:` names two or more local files. |
| `ORCH_READ_ROUTER_BUDGET_MS` | `plan-check.mjs` | 15000 | The read router's profiling budget, in ms, at most 40000 (under the hook's 60 s timeout). |
| `ORCH_TURN_WARNING` | `turn-budget.mjs` | on | `off` turns off the [turn warning](gates.md#turn-warning). |
| `ORCH_BUILTINS_FILE` | `plan-check.mjs`, `scripts/claude-update.mjs` | `~/.claude/orchestration/builtin-agents.json` | The file of built-in agent types learned on this machine. An empty value means no file. |
| `ORCH_JUDGE_MODEL` | `judge-hook.mjs` | `opus` | The native judge's model. |
| `ORCH_JUDGE_CLAUDE_BIN` | `judge-hook.mjs` | `claude` | The `claude` binary the native judge runs. |
| `ORCH_NO_NUDGE` | `nudge.mjs` | unset | Any value silences the [nudge](gates.md#nudge)'s SessionStart text. Headless runs set it. It does not affect the refusal of a typed prompt with the word `ultracode` (1.6.1), which `ORCH_WORKFLOW_GUARD` controls. |
| `ORCH_CLAUDE_BIN` | `scripts/claude-update.mjs` | `claude` | The `claude` binary the update check runs. |

The native judge sets `ORCH_JUDGE_INNER=1` on its own `claude -p` call, so the judge hooks stay quiet inside it. It is not a setting.

### Headless runs

Read by `scripts/orchestrate.sh` (so by `npm run native`) and by `scripts/auto.sh` (`npm run auto`), which starts every session through `orchestrate.sh`. How a headless run works: [native-mode.md, Headless runs](native-mode.md#headless-runs).

| Variable | Default | Effect |
|---|---|---|
| `ORCH_MODE` | `auto` | `auto.sh` only: `auto` lets triage pick; `plain`, `reviewed` or `orchestrate` forces a route. A forced route never escalates. |
| `ORCH_NO_ESCALATE` | unset | `auto.sh` only: any value turns [escalation](glossary.md#e) off. |
| `ORCH_AGENT` | `orchestrator` | The agent to run. `none` runs a plain session with no agent. |
| `ORCH_AGENT_PREFIX` | unset | For example `orchestration:`: always runs the plugin's agents, without checking the folder or the installed plugins. A missing trailing colon is added. An `ORCH_AGENT` that already has a namespace is used as it is. |
| `ORCH_OUTPUT_STYLE` | Concise | The plain session's [output style](glossary.md#o) (`ORCH_AGENT=none` only, so also `npm run auto`'s plain session). Unset: Concise. `default` or empty: no style. A word of letters, digits, `_` and `-`: that style. Anything else exits 1 before any model call. |
| `ORCH_MODEL` | unset | Passes `--model`. `npm run auto` runs its plain session on `opus` unless this names another model; `npm run native` passes it only when set. |
| `ORCH_BUDGET_TOKENS` | unset: no cap | A token cap (`500k`, `2M`; at least 10k). Approximate: converted at 1M tokens per list-price dollar into `--max-budget-usd`. `npm run native` is one session, which gets the cap. In `npm run auto` it caps the whole run: the triage call gets it (`src/route.ts --budget`), and before each later session (plain, reviewer, orchestrator, escalated orchestrator) what the run has spent so far is subtracted, from the cost each call reports, and the session gets the rest (`scripts/run-budget.mjs`). With less than 10k left, or after a triage call the cap stopped, no session starts: the run says so on stderr and exits 3. A session that leaves no readable result (a crash with no output) spent an unknown amount, so the run treats the cap as spent: no later session starts, and it exits 3 with a message (1.6.1). A plain-only route has no later session and exits with that session's own code. Raise the cap to give the run more. |
| `ORCH_BUDGET_USD` | — | Rejected: the script exits 1 and says to use `ORCH_BUDGET_TOKENS`. |
| `ORCH_ALLOWED_TOOLS` | the default allowlist | Replaces the tool allowlist, one permission rule per line. |
| `ORCH_EXTRA_ALLOWED_TOOLS` | unset | Appends rules to the default allowlist, one per line. The default list has no web tools; `auto.sh` adds `WebSearch` and `WebFetch` itself when the task changes no code. |
| `ORCH_SESSION_PERSISTENCE` | unset | `1` drops `--no-session-persistence`, so session and subagent transcripts are written and [telemetry](logs.md#telemetry) records per-agent tokens, turns and models. Any other value keeps the flag. The triage call of `npm run auto` and `npm run route` writes a transcript only with `1` too. |
| `ORCH_ADD_DIR` | unset | One extra folder the agents may read. |
| `ORCH_ADVISOR` | unset | Passes `--advisor` (an experimental advisor model). |
| `ORCH_DRY_RUN` | unset | Prints the exact `claude` arguments, one per line, and exits. |
| `ORCH_TEST_CMD` | detected | Also adds the permission rules the test command needs to the allowlist. |
| `ORCH_SKILL_CREATE`, `ORCH_SKILLS_REPO_PRIVATE`, `ORCH_SKILLS_REPO_PUBLIC` | as the plugin settings | Unless skill creation is `off`, each skills repository set here and the draft home get `--add-dir`, and the Skill tool, the validator and the seal command join the allowlist. `CLAUDE_CONFIG_DIR` also moves the draft home that `scripts/skill-publish.mjs` reads. |

Every headless run also exports `ORCH_NO_NUDGE=1`, `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` and `CLAUDE_CODE_FORK_SUBAGENT=0`.

### Skills and the route skill

| Variable | Read by | Default | Effect |
|---|---|---|---|
| `ORCH_HOME` | the `/route` skill | `~/claude-code-orchestration` | Where this repository is checked out, for the triager. |

### Claude Code variables the hooks read

| Variable | Effect here |
|---|---|
| `CLAUDE_PROJECT_DIR` | The project folder. The state dir, the suite lock and the researcher guard's `cd` rule are keyed to it. |
| `CLAUDE_PLUGIN_DATA` | The plugin's per-user data folder, where the plugin's hooks log ([logs.md, Where logs go](logs.md#where-logs-go)). |
| `CLAUDE_CONFIG_DIR` | Replaces `~/.claude` for the user settings, the skill drafts and the judge's prompt store. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | The person's own model setting. The read router reads it as a fallback; the no-haiku rule leaves it alone. |
| `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | With `1` the nudge adds a warning: an Agent call that passes `name` starts a teammate, which runs outside the plan check, the journal and the gates. |

Do not set `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`: both override the per-agent settings.

### For tests and development

| Variable | Read by | Effect |
|---|---|---|
| `ORCH_KEEP_TEST_TMP` | `scripts/run-tests.mjs`, `src/test-tmp.mjs` | `1` keeps the test temp root and prints its path. |
| `ORCH_CHECK_STEPS` | `scripts/check.mjs` | A JSON array of `[name, command]` pairs that replaces the steps of `npm run check`. An empty list fails. |
| `ORCH_SKILL_ROOTS` | `skill-catalog.mjs` | Test only: replaces every skill root with a list. |
| `ORCH_TEST_CASE_INSENSITIVE` | `plan-check.mjs` | Test only: `1` or `0` replaces the case-insensitive file system probe. |

The SDK pipeline's variables (`ORCH_MODEL_<ROLE>`, `ORCH_MODEL_JUDGE`, `ORCH_JUDGE_AUDIT`, `ORCH_SANDBOX`, `ORCH_SANDBOX_DOMAINS`, `ORCH_SDK_MCP`) are in [sdk-pipeline.md, Environment](sdk-pipeline.md#environment). `ORCH_SDK_MCP=project` is the one opt-in for MCP servers there: the writer, the verifier and solo then get the servers of the project's `.mcp.json`; by default no SDK role gets an MCP server, and none ever gets a claude.ai account connector.
