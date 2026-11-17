# Live checks, 2026-11-17 (Claude Code 2.1.326)

Check 5 (the workflow guard) was added by a later slice; it is described in its own section. Four checks of what CHANGELOG 1.5.1, "Known and not fixed", left open about the triage call: items 3 (hooks), 4 (the small haiku call), 5 (`strictMcpConfig` alone) and 6 (a triage really stopped by the cap). Every probe is a triage call, the cheapest model call this repo makes, each started with a dollar cap. Claude Code 2.1.326 (`claude --version` and every init message's `claude_code_version`), Agent SDK 0.3.326, on Linux. The code is this checkout with the uncommitted 1.6.0 changes (every SDK role passes `disableClaudeAiConnectors`, `strictMcpConfig` with `mcpServers: {}` and `mcpServersDelivery: "initialize"`; the triager also `disableAllHooks: true`).

**The repository.** `<scratch>/repo-p`: a new git repository with one commit and no remote, holding `package.json` (`"test": "node --test"`), `src/add.js`, one test and a copy of this checkout's `.claude/` (agents, hooks, rules, skills, `settings.json`, which registers hooks for `PostToolUse`, `PreToolUse`, `SessionStart`, `Stop`, `SubagentStart`, `SubagentStop` and `UserPromptSubmit`), with an empty `.claude/state`. The orchestration plugin is enabled on this machine (`~/.claude/settings.json`). `repo-q` and `repo-r` are copies of it at other paths, for Check 4. The task is Check 8's, unchanged: "Add a function clamp(n, lo, hi) in src/math.js ... and run the tests with npm test."

**The call (Checks 1 to 3).** As in Check 10 of [live-checks-2026-11-16.md](live-checks-2026-11-16.md): a scratch script outside the project imports this checkout's `src/agent.ts`, `src/triage.ts` and the SDK by absolute path and runs

```ts
const run = makeRunAgent({ query: wrapped, env: process.env });
await triage({ run, repo: "<scratch>/repo-p", task, budgetTokens: 300_000 }); // Check 3: 150_000
```

`wrapped` passes every option on and adds three that only record: `includeHookEvents: true` (the stream then carries `hook_started` and `hook_response` messages), `debug: true` and `debugFile` in the scratch folder. A probe can also change one option, named in its check. It records the options, the init message, every hook event, each assistant message's usage and the result message (`total_cost_usd`, `modelUsage`). It refuses to run a label twice, and a dry run (no model call) printed the options first. Cost below is the result's `total_cost_usd`.

Runs, in order: A (the code as it was), B (A plus `title`), C (the code with the title fix), D (C without `disableClaudeAiConnectors`), E (C without `disableAllHooks`, a control). All five picked `plain` with the same facts as Checks 8 and 10 (code, 2 files, 1 slice, not risky; 15 to 20 lines). B to E hit the prompt cache A had written, which is why they cost a tenth of A.

## Check 1: does a triage run any hook of the project it reads? (item 3)

**Question.** With `disableAllHooks: true` in the triager's flag settings, does a triage of a folder that registers hooks run any of them?

**Command.** Run A: `npx --no-install tsx <scratch>/tprobe.mts a <scratch>/repo-p 300000`. Control, run E: `PROBE_KEEP_HOOKS=1 npx --no-install tsx <scratch>/tprobe.mts e <scratch>/repo-p 300000` (the wrapper deletes `disableAllHooks` from the flag settings). Cap 300k tokens (0.30 USD) each.

**Observed.**

- Run A: no `hook_*` message in the stream, and `repo-p/.claude/state` stayed empty: no `gates.jsonl`, no record of any kind. The debug log says `Registered 0 hooks from 4 plugins` and `Skipping plugin hooks - allowManagedHooksOnly is enabled and no managed plugins`. Claude Code's own built-in modules (`cc-plugin-agents-md@builtin`, `cc-plugin-telemetry@builtin` and two others, "the plugins the binary carries") still ran; they are part of Claude Code, not hooks of a settings file or an installed plugin.
- Plugin hooks. The control's debug log says `Registered 0 hooks from 4 plugins` too: the four are the built-in modules, and the orchestration plugin, enabled in `~/.claude/settings.json`, was not loaded in either run, because the SDK session reads project settings only (`settingSources: ["project"]`). So the hooks that ran in the control were the project's, and this probe says nothing about plugin hooks.
- Run E (control): the stream carried `hook_started`/`hook_response` pairs for `UserPromptSubmit`, `PostToolUse:StructuredOutput` and `Stop`, and `repo-p/.claude/state/gates.jsonl` got one record (review gate, `allow`, `no_telemetry`), the record Checks 8 and 10 saw. So the method sees hooks when they run.

**Answer.** Established on this machine: the triage call runs no hook of the project's settings, and the control ran them. Plugin hooks were not exercised by this probe: the triage loads no user-enabled plugin either way. Hooks of managed settings were not probed (this machine has none).

**Cost.** A: 0.0254458 USD. E: 0.0026152 USD.

## Check 2: the small haiku call (item 4)

**Question.** Is the haiku call of Checks 8 and 10 still there, what makes it, and can a documented option remove it?

**Command.** Run A as in Check 1, then run B: `PROBE_TITLE=triage npx --no-install tsx <scratch>/tprobe.mts b <scratch>/repo-p 300000` (the wrapper adds `title: "triage"`), then run C with `src/agent.ts` passing `title: "triage"` for the triager: `npx --no-install tsx <scratch>/tprobe.mts c <scratch>/repo-p 300000`. Cap 300k tokens each.

**Observed.**

- Run A: `modelUsage` has `claude-haiku-5-5` with 1,648 input and 18 output tokens (0.0001738 USD), the entry of Checks 8 and 10. The debug log names the request: `[API REQUEST] /v1/messages ... source=generate_session_title`, right after `dispatching to firstParty model=claude-haiku-5-5`. In the Claude Code 2.1.326 binary, `querySource:"generate_session_title"` is the call that asks for a JSON object with one `title` field, which fits 18 output tokens. The request sources in A's log: `growthbook`, `sdk`, `served`, `generate_session_title`.
- The SDK documents the option (`sdk.d.ts`, `Options.title`): "Custom session title. When provided, the session uses this title and skips automatic title generation."
- Run B: `modelUsage` has `claude-sonnet-5-5` only, and the debug log has no `generate_session_title` and no `claude-haiku` line. The sources left: `growthbook`, `sdk`, `served`. Same route and facts.
- Run C (the fix in `src/agent.ts`): the options that reached `query` carry `title: "triage"`; `modelUsage` has sonnet only, and no `generate_session_title` request.

**Answer.** Established: the haiku call is Claude Code's session-title call, and passing `title` removes it. The triager now passes `title: "triage"` (`src/agent.ts`, `TRIAGE_TITLE`; test in `src/agent.test.ts`). It writes no transcript by default, so the title is never shown; with `ORCH_SESSION_PERSISTENCE=1` the kept transcript is titled "triage". The other roles still make the call: one per session, about 0.0002 USD.

**Cost.** B: 0.0026052 USD. C: 0.0025752 USD (A is counted under Check 1).

## Check 3: `strictMcpConfig` alone, without `disableClaudeAiConnectors` (item 5)

**Question.** Do the claude.ai account connectors stay out of a triage that passes `strictMcpConfig: true` and `mcpServers: {}` but not `disableClaudeAiConnectors`?

**Command.** Run D: `PROBE_DROP_CONNECTORS=1 npx --no-install tsx <scratch>/tprobe.mts d <scratch>/repo-p 150000`. The wrapper deletes `disableClaudeAiConnectors` from the flag settings it passes on; no file of the repo was edited for this. Cap 150k tokens (0.15 USD).

**Observed.**

- Options that reached `query`: `strictMcpConfig: true`, `mcpServers: {}`, `settings: {agent: "", disableAllHooks: true}`.
- Init message: `tools` is `Glob, Grep, Read, StructuredOutput`, no `mcp__*` tool; `mcp_servers` is empty.
- The one request read 5,403 tokens from the cache and wrote 409, a 5,812-token prompt like runs A to C. Check 8's first request, with 99 connector tools in its tool list, wrote 110,319. So no connector tool was in the request.
- The debug log differs from run A: A says `[claudeai-mcp] Disabled via disableClaudeAiConnectors setting`; D says `[claudeai-mcp] Fetching from https://api.anthropic.com/v1/mcp_servers?...` and `Fetched 4 servers`, and has no line after it that connects one. Both logs say `Artifacts MCP server not added: managed_or_strict_mcp_config (strict_mcp_config)`.

**Answer.** On this machine, in a session of one request, `strictMcpConfig` alone kept every account connector's tools out, but Claude Code still fetched the list of the account's connectors; `disableClaudeAiConnectors` also skips that fetch. Not shown: a longer session in which a connector might connect later (Check 8 saw 45 Canva tools arrive after the first request). The code keeps passing both options.

**Cost.** D: 0.0041403 USD.

## Check 4: a triage really stopped by a tiny cap (item 6)

**Question.** Does a triage that reaches its cap end as `error_max_budget_usd`, fall back with `capStopped: true`, and does `npm run auto` then exit 3 and start no session?

**Safety.** `scripts/orchestrate.sh` prints its `claude` arguments and exits when `ORCH_DRY_RUN` is set, before it runs `claude` (line 202). Every `npm run auto` below ran with `ORCH_DRY_RUN=1` and the smallest cap, 10k tokens (0.01 USD), so no orchestrate, plain or reviewed session could start, and none did: stdout was empty in both runs.

**The warm cache.** A first `npm run route -- --repo <scratch>/repo-q --task "<task>" --budget 10k` on sonnet was not stopped: it read the cached prompt of runs A to E and cost 0.0041103 USD, under the 0.01 USD cap (exit 0, decision `plain`, `costUsd: 0.0041103`). A warm triage on sonnet costs less than the smallest cap. To get a cold cache the stopped probes ran on another model with the triager's model switch, `ORCH_MODEL_TRIAGER`.

**Commands and observed.**

1. `ORCH_MODEL_TRIAGER=claude-opus-5-5 npm run --silent route -- --repo <scratch>/repo-q --task "<task>" --budget 10k`. Exit 0. Decision: `mode: orchestrate`, `source: fallback`, reason `triage failed (the token cap stopped it, error_max_budget_usd); the run's cap is spent, so no session follows`, `tokens: 6085`, `costUsd: 0.05106`, `capStopped: true`; logged as the second line of `repo-q/.claude/state/routes.jsonl`. The call spent 0.051 USD against a 0.01 USD cap: Claude Code checks the cap after a request, so one request can overshoot it.
2. `ORCH_DRY_RUN=1 ORCH_BUDGET_TOKENS=10k ORCH_MODEL_TRIAGER=claude-haiku-5-5 npm run --silent auto -- "<task>" <scratch>/repo-r`. Haiku stayed under the cap (decision `plain`, `costUsd: 0.0015189`), and `auto.sh` stopped on its other path: exit 3, stderr `budget: ORCH_BUDGET_TOKENS=10k is the cap for the whole run, and this run has spent 1.5k of it ..., leaving 8.5k, under the 10k a session needs: the plain session does not start.` Stdout empty.
3. `ORCH_DRY_RUN=1 ORCH_BUDGET_TOKENS=10k ORCH_MODEL_TRIAGER=claude-opus-5 npm run --silent auto -- "<task>" <scratch>/repo-r`. Exit 3, stdout empty, stderr one line: `budget: the triage call reached ORCH_BUDGET_TOKENS=10k, the cap for the whole run, so the cap is spent and no session starts. Raise ORCH_BUDGET_TOKENS to run the task.` The logged decision: `orchestrate`, `fallback`, `capStopped: true`, `tokens: 6909`, `costUsd: 0.069875`. No route line was printed, since `auto.sh` stops before it.

**Answer.** Established: a triage the cap stops ends as `error_max_budget_usd` and falls back with `capStopped: true`, `npm run route` prints that decision, and `npm run auto` exits 3 after it with the budget message and starts no session. Also seen: the cap does not bound one request, so a triage can spend several times a small cap (0.051 and 0.070 USD against 0.01), and a warm sonnet triage (about 0.003 to 0.004 USD) is never stopped by the smallest cap.

**Cost.** 0.0041103 + 0.05106 + 0.0015189 + 0.069875 = 0.1265642 USD.

## Check 5: the shape of a Workflow launch at PreToolUse, and the workflow guard (slice s4)

**Question.** What `tool_input` does a PreToolUse hook on `Workflow` see for a script the model writes on the spot (the `ultracode` keyword) and for a saved workflow, and does `workflow-guard.mjs` refuse the first and pass the second?

**Setup.** Scratch folders in the session's scratchpad, outside the repo, each with its own `.claude/settings.json`; `--setting-sources project`, so the user's enabled plugins did not load (the init message listed only Claude Code's four built-in modules, plus the scratch plugin in run d). A logging hook (PreToolUse and PostToolUse, matcher `Workflow`) wrote each payload to a file. The saved workflow is a toy `orchestrate.js` (`meta.name` `orchestrate`, one phase, `return { echoed: args }`, no agent); this repo's real orchestrate workflow was never run. Every run: `--model haiku --permission-mode dontAsk --output-format stream-json --verbose`, `ORCH_NO_NUDGE=1`.

**Commands.**
- (a) `wf-a`, logging hook only: `CLAUDE_CODE_SUBAGENT_MODEL=haiku claude -p 'ultracode Use a workflow with two agents to list the files in this folder.' --max-turns 5 --max-budget-usd 0.10 --allowedTools Workflow Read Glob 'Bash(ls*)' Skill`.
- (c) `wf-c`, logging hook and the toy `.claude/workflows/orchestrate.js`: `claude -p '/orchestrate {"task":"toy"}' --max-turns 3 --max-budget-usd 0.05 --allowedTools Workflow`.
- (b) `wf-b`, the logging hook plus this checkout's `workflow-guard.mjs` and `state.mjs` copied to `.claude/hooks/` and registered on PreToolUse `Workflow`, and the same toy workflow: command (a) again (cap 0.10), then command (c) again (cap 0.05).
- (d) `wf-d`, no project settings; a scratch plugin named `orchestration` (toy `workflows/orchestrate.js`, the guard registered with `--plugin` in its `hooks/hooks.json`) loaded with `--plugin-dir`: `claude -p '/orchestration:orchestrate {"task":"toy"}' --max-turns 3 --max-budget-usd 0.05 --allowedTools Workflow`.

**Observed.**
- (a) The model loaded the workflow-authoring skill, then called `Workflow`. PreToolUse `tool_input` had one key, `script` (1,738 characters, the whole script); no `name`, no `args`. PostToolUse showed the same single key and `status: "async_launched"`. So at PreToolUse an ad-hoc launch carries its whole script (the 2026-10-31 note that PreToolUse saw only the name was about a saved workflow).
- (c) The model called `Workflow {"name":"orchestrate","args":{"task":"toy"}}`; PreToolUse saw exactly that; PostToolUse added `script`. Result `{"echoed":{"task":"toy"}}`.
- (b) Ad-hoc: the tool result was the hook's error, `orchestration workflow guard refused this Workflow launch (inline_script). Workflows started by a keyword or written on the spot are off in this project. ...`; no PostToolUse fired, so no workflow ran; `workflow-guard.jsonl` got `decision: "deny"`, `reason: "inline_script"`, `keys: ["script"]`. The model then did the task without a workflow, by launching two subagents itself with the Agent tool (this scratch folder denies none). Saved: `{"name":"orchestrate","args":{"task":"toy"}}` passed silently, the workflow ran and returned `{"echoed":{"task":"toy"}}`, and the log got `decision: "allow"`, `reason: "saved_workflow"`.
- (d) The model called `Workflow {"name":"orchestration:orchestrate","args":{"task":"toy"}}`. The plugin copy of the guard found its plugin's `workflows/orchestrate.js` and passed it; the workflow ran (`{"echoed":{"task":"toy"}}`), and the record (`allow`, `saved_workflow`, name `orchestration:orchestrate`) went to the per-user state dir, as for every plugin hook.

**Answer.** Established on 2.1.326, one run each: an ad-hoc launch reaches PreToolUse as `{"script": ...}` and a saved one as `{"name": ..., "args": ...}`, with the plugin's workflows namespaced as `orchestration:<name>`. The guard refuses the first before it runs and passes the second. Not probed: `scriptPath` and `resumeFromRunId` (both read from the tool's schema text in the binary), a typed `ultracode` prompt in an interactive session (under `-p` the keyword alone does not opt in; the plain request does), and the nudge's line for the keyword (unit tests only).

**Cost.** (a) 0.0116456 USD, (c) 0.0035159 USD, (b) 0.0131298 + 0.0036176 USD, (d) 0.0038007 USD: 0.0357096 USD.

## Total

| Run | Check | Cap | Cost (USD) |
|---|---|---|---|
| A | 1, 2 | 300k | 0.0254458 |
| B | 2 | 300k | 0.0026052 |
| C | 2 | 300k | 0.0025752 |
| D | 3 | 150k | 0.0041403 |
| E | 1 | 300k | 0.0026152 |
| route, sonnet, warm | 4 | 10k | 0.0041103 |
| route, opus 5.5 | 4 | 10k | 0.0510600 |
| auto, haiku | 4 | 10k | 0.0015189 |
| auto, opus 5 | 4 | 10k | 0.0698750 |
| **Subtotal, slice s3** | | | **0.1639459** |
| a, ad-hoc workflow | 5 | 0.10 USD | 0.0116456 |
| c, saved `orchestrate` | 5 | 0.05 USD | 0.0035159 |
| b, ad-hoc, guarded | 5 | 0.10 USD | 0.0131298 |
| b, saved, guarded | 5 | 0.05 USD | 0.0036176 |
| d, plugin `orchestration:orchestrate` | 5 | 0.05 USD | 0.0038007 |
| **Subtotal, slice s4** | | | **0.0357096** |
| **Total** | | | **0.1996555** |

Fourteen paid calls, about 0.20 USD in all: nine for slice s3 (limit 1.50 USD), five for slice s4 (limit 0.50 USD), under the run's 2 USD limit.

## Limits

One run per probe, on one Linux machine, in scratch repositories that carry a copy of `.claude/`. Checks 1 to 3 went through a script that wraps `query`, not through `npm run auto`; Check 4 went through `npm run route` and `npm run auto` with the launcher in dry-run mode, and its stopped calls ran on opus, not on the triager's sonnet. Not probed: hooks of managed settings, a longer session without `disableClaudeAiConnectors`, the title call in the other SDK roles' sessions, and `ORCH_SDK_MCP=project`.
