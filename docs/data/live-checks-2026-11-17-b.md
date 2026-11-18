# Live checks for 1.6.1 (2026-11-17, Claude Code 2.1.326)

The probes behind release 1.6.1, one section per item of 1.6.0's "Known and not fixed" that needed one (CHANGELOG
1.6.1). Claude Code 2.1.326 on Linux, Agent SDK 0.3.326. Every paid call ran with a dollar cap. A call with `--model
no-such-model-x` is refused before any model runs and costs nothing. Total of all four sections at the end.

## K3: is the prompt's own record in the transcript at UserPromptSubmit?

Question: could `typedPrompt` (`.claude/hooks/state.mjs`) look up the current prompt's record in `transcript_path` and
mark a prompt as not typed when that record says it came from somewhere else? That needs (a) the record of this very
prompt in the transcript when the hook fires, and (b) a field on it (`origin`, `isMeta`) that differs between a typed
prompt and a wrapped message.

**Setup.** A scratch folder outside the repository with `hook.mjs`, a UserPromptSubmit hook that appends `{at, input,
tail}` to `hook.log` (`tail`: the last two non-empty lines of `input.transcript_path`, or `<unreadable: CODE>`), and
`settings.json` registering it. Every run from `<scratch>/work` with `--setting-sources local --settings
../settings.json --strict-mcp-config`, so no user or project hook, plugin or MCP server loads.

**Probe 1, a typed prompt, no model call.** `claude -p hi --model no-such-model-x --setting-sources local --settings
../settings.json --strict-mcp-config --max-budget-usd 0.01`. Cap 0.01 USD; exit 1 (model error); cost 0. The hook fired
before the error. Input keys: `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`,
`hook_event_name`, `prompt`; no origin-like field. `tail`: `<unreadable: ENOENT>`: at a session's first prompt the
transcript file does not exist yet.

**Probe 2, a typed prompt, then a task notification.** `claude -p 'Call the Bash tool once with command "sleep 3; echo
probe-done" and run_in_background set to true. Then reply with the single word started. When the background task
reports back, reply with the single word seen.' --model haiku --tools Bash --allowedTools Bash --setting-sources local
--settings ../settings.json --strict-mcp-config --disable-slash-commands --max-budget-usd 0.05 --output-format json`.
Cap 0.05 USD; result `seen`; cost 0.00103324 USD.

| Prompt | Hook input | Transcript tail when the hook fired |
| --- | --- | --- |
| the typed prompt | the same seven keys; no origin field | `<unreadable: ENOENT>` (no file yet) |
| `<task-notification>...` | the same seven keys; no origin field | a `queue-operation` `enqueue` record and a `dequeue` record; neither has a `promptId` or an origin |

In the transcript after the session, the notification's user record has `origin: {kind: "task-notification", ...}`,
`promptSource: "system"` and `turnOrigin: "task_notification"` (the typed prompt's: no origin, `sdk`, `sdk`); `isMeta`
is absent on both. That record comes after the two queue records, so it was written after the hook ran.

**Answer.** (a) No: a lookup by `prompt_id` finds nothing, and a lookup of the last user record finds the previous
prompt's. (b) Only on the record written after the hook. So `typedPrompt` reads no transcript; the opening text and any
origin-like field of the hook input decide. Not probed: another session's message and a subagent's hand-back.

## K9: resuming a saved workflow, and the workflow guard and keyword refusal live

**Setup.** Two scratch folders outside the repo, each with its own `.claude/settings.json`, run with `--setting-sources
project`, `--model haiku --permission-mode dontAsk --allowedTools Workflow --output-format stream-json --verbose` and
`ORCH_NO_NUDGE=1`. The saved workflow is a toy `.claude/workflows/orchestrate.js` (one `agent()` call that answers
`pong`; a run needs a journal to be resumable). A logging hook (PreToolUse and PostToolUse on `Workflow`) wrote each
`tool_input`, the SHA-256 of the file a `scriptPath` names and of the saved file, and the PostToolUse `tool_response`.
This repo's real workflow was never run.

**Probe 1, what a resume looks like at PreToolUse** (logging hook only; cap 0.08 USD):

```
CLAUDE_CODE_SUBAGENT_MODEL=haiku claude -p 'Step 1: call the Workflow tool with exactly {"name":"orchestrate","args":{"task":"toy"}} and wait for it to complete. Step 2: resume that run: call Workflow with {"name":"orchestrate","resumeFromRunId":"<the Run ID from step 1>","args":{"task":"toy"}} and wait. Step 3: call Workflow with {"scriptPath":"<the Script file path from step 1>","resumeFromRunId":"<the Run ID from step 1>","args":{"task":"toy"}} and wait. Then reply DONE with each step result in one line.' --model haiku --setting-sources project --permission-mode dontAsk --allowedTools Workflow --max-turns 10 --max-budget-usd 0.08 --output-format stream-json --verbose
```

| Call | PreToolUse `tool_input` keys | Notes |
|---|---|---|
| launch | `name`, `args` | result: `runId` `wf_5a36ce0f-de9`, `scriptPath` `<config>/projects/<key>/<session>/workflows/scripts/orchestrate-wf_5a36ce0f-de9.js` |
| resume by name | `name`, `args`, `resumeFromRunId` | the saved file as it is now ran; 1 of 1 agent result from cache |
| resume by file | `args`, `scriptPath`, `resumeFromRunId` | `scriptPath` is the launch's saved copy, byte for byte the saved file |

The run id has the form `^wf_[a-z0-9-]{6,}$` (the tool's input schema in the binary). Not produced: `scriptPath` without
`resumeFromRunId`, `scriptPath` with `name`, a `remote` key. Cost: 0.0126008 USD at most (two result lines, summed).

Rule taken into `workflow-guard.mjs`: a resume by name is judged like the launch (the saved file's content); a resume
by file passes only with exactly `scriptPath`, `resumeFromRunId` and optional `args`, an absolute `scriptPath` ending in
`.../workflows/scripts/<anything>-<resumeFromRunId>.js`, and a file there that hashes to one of the two stored values.

**Probe 2, the new hooks live** (the toy workflow plus this repo's `workflow-guard.mjs`, `workflow-hash.mjs`,
`state.mjs` and `nudge.mjs`, registered as the project registers them):

- (2a) `claude -p 'ultracode Use a workflow to list the files in this folder.' ... --max-turns 3 --max-budget-usd 0.02`:
  `UserPromptSubmit operation blocked by hook:` and the nudge's message; `num_turns` 0, cost 0. The prompt never
  reached the model.
- (2b) `claude -p '/orchestrate {"task":"toy"}' ... --max-turns 3 --max-budget-usd 0.05`: PreToolUse saw
  `{"name":"orchestrate","args":{"task":"toy"}}`; the guard refused it with `workflow_content_mismatch` (the toy file is
  not this repo's workflow) and logged it. Cost 0.0032391 USD.

Not run live: the allow path (it would run the real workflow; `src/workflow-guard.test.mjs` covers it with the shapes
above), a resume of the plugin's workflow, a typed prompt in an interactive session. Total for K9: 0.0158 USD at most.

## K4: the SDK roles' sessions

Checkout: release 1.6.0 plus the k4 change to `src/judge.ts` (no probe ran a judged command).

**Method.** `<scratch>/probe.mts` imports `makeRunAgent` from `src/agent.ts` and passes, through the runner's `query`
seam, a wrapper around the SDK's `query()` that keeps every option and adds `maxBudgetUsd`. It records the options, the
init message (`model`, `tools`, `mcp_servers`) and the result. Folder: a fresh git repository with one empty commit.
Prompt: "Reply with the word ok and nothing else. Do not use any tool." Each call: `timeout 60 npx --no-install tsx
<scratch>/probe.mts <label> <role> <scratch>/repo 0.08`, so cap 0.08 USD and 60 s; every role on its default model.
"Connector" means a tool or server whose name carries `claude_ai` / `claude.ai`.

| Probe | Role | Model (init) | Tools | MCP tools | MCP servers | Connector | Result | Cost (USD) |
|---|---|---|---|---|---|---|---|---|
| 1 | explorer | claude-sonnet-5-5 | 3 | 0 | none | no | "ok", 1 turn | 0.0077848 |
| 2 | verifier | claude-sonnet-5-5 | 4 | 0 | none | no | "ok", 1 turn | 0.0091031 |
| 3 | writer | claude-opus-5-5 | 6 | 0 | none | no | "ok", 1 turn | 0.0189179 |
| 4 | solo | claude-opus-5-5 | 6 | 0 | none | no | "ok", 1 turn | 0.0190134 |
| 5 | planner | claude-fable-5-2 | 3 | 0 | none | no | "ok", 1 turn | 0.0528224 |

The runner passed, for every role: `strictMcpConfig: true`, `mcpServers: {}`, `mcpServersDelivery: "initialize"`,
`settings: { agent: "", disableClaudeAiConnectors: true }`, `settingSources: ["project"]`. The `modelUsage` of explorer,
verifier, writer and solo also has a haiku entry: Claude Code's session-title call, removed for the triager only (about
0.0002 USD a session).

**Probe 6, `ORCH_SDK_MCP=project`.** `<scratch>/repo/.mcp.json` named one stdio server, `toy` (`args:
["<scratch>/toy-server.mjs", "--arg=${PROBE_TOY_ARG}"]`, `env: { "TOY_VAR": "${PROBE_TOY_VALUE}", ... }`), a 20-line
server with one tool, `toy_ping`. Command: `ORCH_SDK_MCP=project PROBE_TOY_ARG=argval42 PROBE_TOY_VALUE=envval42
PROBE_PROMPT="List the names of your tools that start with mcp__ on one line, or reply none. Do not call any tool."
timeout 60 npx --no-install tsx <scratch>/probe.mts mcp-verifier verifier <scratch>/repo 0.08`. Cap 0.08 USD. Seen: the
runner passed `mcpServers` with the one key `toy`, still with `strictMcpConfig: true`; init listed `toy` connected and
`mcp__toy__toy_ping` beside the verifier's 4 tools, no connector; the server's log showed `--arg=argval42` and
`TOY_VAR=envval42`; the reply was `mcp__toy__toy_ping`. Cost 0.0271721 USD. Not covered: `${VAR:-default}`, an unset
variable, http or sse servers.

**Answer.** For all five roles on 2.1.326: no MCP tool, no MCP server and no account connector reaches the session, and
each runs on its configured model; with `ORCH_SDK_MCP=project` a worker starts the project's server and expands
`${VAR}` in `args` and `env`. Total for K4: 0.1348137 USD.

## K10 and K2: the pinned git rules' warnings, and the worker rows

No paid model call. Cost 0.

**The startup warnings.** In the k5 worktree, twice (release 1.6.0's `scripts/orchestrate.sh`, then the pinned one),
with both skills repositories set:

```text
ORCH_DRY_RUN=1 bash scripts/orchestrate.sh hi > <scratch>/args.txt
claude <the same arguments without --output-format stream-json --verbose> --model no-such-model-x < /dev/null
```

Exit 1 (model error), cost 0. Before: seven warnings, one per `git -C * <form>` write rule ("has a wildcard before the
rest of the command, so it also matches any options inserted at that position"); the read rules drew none. After: no
warning for a rule naming the project folder or a skills repository. Warnings remain for the rules whose folder needs
a `*` for the worktree's name: `git -C <repo>/.claude/worktrees/* branch --show-current|add *|commit *` (3, every run)
and the same three under `<config dir>/orchestration/skill-drafts/*` (only with a skills repository set).

**The worker rows (`AgentRow` render hook).** No live session: `--max-budget-usd` works only with `--print`, and a
print session draws no agent rows. Evidence instead: `npm run test-dashboard` (2 min 10 s) passed `claude plugin
validate` and 119 of 119 tests of `claude plugin test` on the 2.1.326 engine's test host. Six cover the rows, two of
them mounting `AgentRow` through the engine: `implementer s1 #2 risky · opus · 50.0k (25%) · Running the tests` with the
pane off, no `body` for a row of an agent type that is not one of the four workers, the person's own `body` kept, and
no `body` when the state read is refused.

## Total

| Section | Cost (USD) |
|---|---|
| K3, typed prompt and transcript | 0.00103 |
| K9, workflow resume and guard | 0.0158 |
| K4, SDK roles | 0.1348137 |
| K10 and K2 | 0 |
| **Total** | **0.1516437** |
