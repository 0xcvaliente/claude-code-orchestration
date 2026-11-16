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

## Limits

Each claim was probed once, headless (`-p` or the SDK), on 2.1.325 and macOS; an interactive session was not started, and neither `scripts/orchestrate.sh` nor the npm script `plain` was run end to end (the flag they pass was). No init event names the agent, so the conclusions rest on the tool lists and models. Not probed: the comment's claim that the empty `agent` "changes no other setting" (only the tool list and model were compared, not permissions, hooks or other keys); whether `--agent` also wins over `--settings '{"agent":""}'` when both are passed; and whether `--agent` with an agent the setting does not name changes anything besides tools and model (system prompt, effort, maxTurns).
