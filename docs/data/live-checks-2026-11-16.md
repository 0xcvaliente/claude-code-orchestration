# Live checks, 2026-11-16 (Claude Code 2.1.325)

Four checks of the `agent` setting, which `.claude/settings.json` sets to `"orchestrator"` so that a session started in the repo root runs as the orchestrator. The code relies on four claims that no file recorded: a plain session starts as the orchestrator; `--settings '{"agent":""}'` gives the default agent back (`scripts/orchestrate.sh` for `ORCH_AGENT=none`, and the npm script `plain`); `--agent <name>` wins over the setting; and the Agent SDK option `settings: { agent: "" }` with `settingSources: ["project"]` does the same as the flag (`src/agent.ts`).

All probes ran from the root of a git worktree of this repo at 0b6e2c7, whose `.claude/settings.json` has `"agent": "orchestrator"`. Each was one model turn with the prompt "Reply with the single word ok."; every run ended with result `success`, text `ok`, `num_turns: 1`.

**How the agent is read.** The stream's `system`/`init` event has no agent field in this version (its keys include `model`, `tools`, `agents`, `output_style`, `permissionMode`, no `agent`). The evidence is therefore the init event's `tools` list, compared with the `tools:` line of each agent file, and its `model`. The model's own answer was not used.

Agent files at this commit:

- `orchestrator`: `model: fable`, `tools: Agent(researcher, implementer, integrator, reviewer), SendMessage, Read, Grep, Glob, Skill`
- `researcher`: `model: sonnet`, tools `Read, Grep, Glob`, a list of `Bash(...)` patterns, `WebSearch, WebFetch, Skill`

## P0: version

```bash
claude --version
```

`2.1.325 (Claude Code)`. Every init event below also reports `claude_code_version: "2.1.325"`. The SDK in `node_modules` is `@anthropic-ai/claude-agent-sdk` 0.3.325.

## Check 1: a plain session starts as the orchestrator

```bash
claude -p "Reply with the single word ok." --max-turns 1 --no-session-persistence --output-format stream-json --verbose
```

**Init event.**

```
"model": "claude-fable-5-2"
"tools": ["Task","SendMessage","Read","Skill","Grep","Glob"]      (6 tools)
```

The six tools are the orchestrator's list (`Agent` is reported under its older name `Task`). No Bash, Edit, Write or MCP tool, though this machine's user settings load many MCP servers (612 MCP tools appear in Check 2). The model is the orchestrator's `fable`.

**Confirmed.**

## Check 2: `--settings '{"agent":""}'` gives the default agent back

```bash
claude -p "Reply with the single word ok." --max-turns 1 --no-session-persistence --output-format stream-json --verbose --settings '{"agent":""}'
```

**Init event.**

```
"model": "claude-fable-5-2"
"tools": 640 entries: 28 built-in tools (Task, Bash, CronCreate, CronDelete, CronList, DesignSync, Edit,
         EnterWorktree, ExitWorktree, ListAgents, ListMcpResourcesTool, Monitor, NotebookEdit,
         PushNotification, Read, ReadMcpResourceDirTool, ReadMcpResourceTool, RemoteTrigger, ReportFindings,
         ScheduleWakeup, SendMessage, Skill, TaskStop, ToolSearch, WebFetch, WebSearch, Workflow, Write)
         plus 612 mcp__* tools
```

The full default tool set, with Bash, Edit and Write and every MCP tool: the session is not the orchestrator. Grep and Glob are absent, as expected for the default set on macOS (see live-checks-2026-11-10, Check C). The model is `fable` here too, which comes from this machine's default model, not from the agent; the tools decide.

**Confirmed.**

## Check 3: `--agent <name>` wins over the `agent` setting

```bash
claude -p "Reply with the single word ok." --max-turns 1 --no-session-persistence --output-format stream-json --verbose --agent researcher
```

**Init event.**

```
"model": "claude-sonnet-5-5"
"tools": ["Read","Bash","WebSearch","WebFetch","Skill"]      (5 tools)
```

The researcher's tools (its Bash patterns collapse to `Bash`; Grep and Glob drop out because it also names Bash, the macOS rule recorded on 2026-11-10) and the researcher's `sonnet` model. Neither the orchestrator's `Task`/`SendMessage` nor the default set appears.

**Confirmed.**

## Check 4: the SDK option `settings: { agent: "" }` does the same

A scratch script (outside the repo) importing `query` from this repo's `node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs`, run twice with `cwd` = the worktree root, `settingSources: ["project"]`, `maxTurns: 1`, `permissionMode: "dontAsk"`; the second run adds `settings: { agent: "" }`. It prints the init message's `model` and `tools` (MCP names filtered from the print only).

```js
query({ prompt: "Reply with the single word ok.",
        options: { cwd, settingSources: ["project"], maxTurns: 1, permissionMode: "dontAsk" } })
query({ prompt: "Reply with the single word ok.",
        options: { cwd, settingSources: ["project"], maxTurns: 1, permissionMode: "dontAsk", settings: { agent: "" } } })
```

**Output.**

```
{"label":"no-settings","version":"2.1.325","model":"claude-fable-5-2","agent":null,"nTools":6,
 "tools":["Task","SendMessage","Read","Skill","Grep","Glob"],"result":"success","text":"ok"}
{"label":"agent-empty","version":"2.1.325","model":"claude-fable-5-2","agent":null,"nTools":25,
 "tools":["Task","Bash","CronCreate","CronDelete","CronList","DesignSync","Edit","EnterWorktree","ExitWorktree",
          "ListAgents","Monitor","NotebookEdit","PushNotification","Read","RemoteTrigger","ReportFindings",
          "ScheduleWakeup","SendMessage","Skill","TaskStop","ToolSearch","WebFetch","WebSearch","Workflow","Write"],
 "result":"success","text":"ok"}
```

Without `settings`, the SDK session is the orchestrator too (the same six tools as Check 1), so `src/agent.ts` does need the option. With `settings: { agent: "" }` it has the default built-in set (25 tools, no MCP tools because only project settings load). The init message has no `agent` field (`null` above).

**Confirmed.**

## Check 5: a dash-led prompt after `--`, and the Concise output style in the flag settings

Added later the same day for the audit fixes W-4 (a task that starts with `-`) and O-5 (plain sessions in the Concise style). Claude Code 2.1.325, run once from an empty folder outside any repository (no project settings, so no `agent` setting to clear), cheapest model, one turn. The `--allowedTools` list comes right before `--`, as in `scripts/orchestrate.sh`, so the probe also shows that `--` ends that variadic option.

```bash
claude -p --model haiku --max-turns 1 --no-session-persistence --output-format stream-json --verbose \
  --permission-mode dontAsk --settings '{"agent":"","outputStyle":"Concise"}' --allowedTools Read Grep \
  -- "-x Reply with the single word ok."
```

**Output.** Exit code 0, nothing on stderr.

```
init:   {"claude_code_version":"2.1.325","model":"claude-haiku-5-5","output_style":"Concise", 596 tools}
result: {"subtype":"success","is_error":false,"num_turns":1,"result":"ok"}
```

The prompt `-x Reply ...` was taken as the prompt, not as an unknown option `-x` and not as a third `--allowedTools` rule (the session answered it). The init event reports `output_style: "Concise"`, so `outputStyle` in the `--settings` JSON selects the built-in style (the name is case-sensitive: https://code.claude.com/docs/en/output-styles).

**Confirmed.** Not probed: a prompt of `-` alone, and whether `outputStyle` applies to a session started with `--agent`.

## Check 6: a researcher's `cd` after the merge of the researcher guard fix

Added later the same day, from live use in this repository after the merge at commit d401009, which carries the researcher guard's `cd` rule (audit fix `fix-researcher-cd`, item 2). A researcher of a run ran four Bash calls, in this order:

| Call | Result |
|---|---|
| `cd ./src && ls \| head -3` | ran; listed `src` |
| `ls \| head -3` | ran; listed the project folder again: a subagent's working folder is reset between calls |
| `cd ../docs && ls \| head -3` | refused by the researcher guard with its `cd` message (`CD_FORM` in `.claude/hooks/researcher-guard.mjs`) |
| `cd ./docs && ls \| head -3` | ran |

**Confirmed.** A `cd` into the project with a `./` path runs, a `cd` that leads out of the project is refused, and the folder does not carry over to the next call. Not probed: an interactive session, and a `cd` path that starts with `/`.

## Check 7: four isolated implementers stopping together

Added later the same day, from live use in this repository (source: `docs/data/audit-2026-11-16/fix-notes-gate-load.md`, "Live observation"). Four isolated implementers of one wave stopped within two minutes, between 11:16:08 and 11:17:52 UTC. At each stop the test gate ran the whole suite, then a base run, at the same time as the other three.

- Three test-gate records came at 11:26:47 to 11:27:06 UTC, 554 to 590 s after their stops; about 120 s is usual. Each is `tests_failed_isolated` (`.claude/state/gates.jsonl` lines 419 to 421).
- The records of 11:27:05 and 11:27:06 carry `failing: 1, on_base: 1`: one failing test, which also failed on the base under that load. The record of 11:26:47 has the reason only, with no counts.
- Claude Code ended the fourth agent as stalled ("Agent stalled: no progress for 600s (stream watchdog did not recover)") while its stop hook still ran. No test-gate record exists for it.

**Confirmed.** Whole-suite runs of parallel gates slow each other down, and a stop hook that runs longer than Claude Code's stall limit (`CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`, default 600000 ms) ends the agent with no gate record. The audit fix `fix-gate-load` followed from this check. Not probed: the same wave on an idle machine, and a stall limit other than the default.

## Limits

Each claim was probed once, headless (`-p` or the SDK), on 2.1.325 and macOS; an interactive session was not started, and neither `scripts/orchestrate.sh` nor the npm script `plain` was run end to end (the flag they pass was). No init event names the agent, so the conclusions rest on the tool lists and models. Not probed: the comment's claim that the empty `agent` "changes no other setting" (only the tool list and model were compared, not permissions, hooks or other keys); whether `--agent` also wins over `--settings '{"agent":""}'` when both are passed; and whether `--agent` with an agent the setting does not name changes anything besides tools and model (system prompt, effort, maxTurns).
