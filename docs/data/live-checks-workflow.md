# Live checks: the `agent.spawn` mod hook for workflow agents

Version: `2.1.316 (Claude Code)`. Date: 2026-10-31. Probe only: nothing in the plugin was changed.

This file answers Check G of [live-checks-2026-10-31.md](live-checks-2026-10-31.md#probes-for-040-slice-i-router-2026-10-31). Agents that the scripted workflow (`.claude/workflows/orchestrate.js`) starts through `agent()` make no Agent tool call, so `plan-check.mjs` never sees them. They get neither the read router's model choice nor skill suggestions. The question is whether a mod's `agent.spawn` hook can fill that gap.

## Setup

All files were in a scratch folder, `<scratch>/wfprobe/`. The shipped dashboard was not used.

- `mod/` is a minimal function-hooks mod named `spawnprobe`. It has `.claude-plugin/plugin.json`, `hooks/hooks.json` (`{ "modules": ["./register.ts"] }`), `hooks/register.ts` and `hooks/helper.mjs`. The module registers two hooks:
  - `session.start` records three things in `logs/mod.jsonl`: a value imported from `./helper.mjs`, the result of `$.fs.read('<scratch>/wfprobe/proj/data.txt')`, and the result of `$.process.run(['node', '<scratch>/wfprobe/proj/profile.mjs', 'x.pdf'])`. That script imports `node:path` and prints JSON.
  - `agent.spawn` logs its input (`e`, with the prompt cut to 200 characters). When the prompt contains `PROBE-REWRITE`, it calls `next({ ...e, model: 'haiku', prompt: 'Reply with exactly the word REWRITTEN and nothing else.' })`; otherwise it calls `next(e)`. It then logs the result of `next`.
- `proj/` is the project the runs started from:
  - `.claude/workflows/probe.js` makes one call, `agent('PROBE-REWRITE. Reply with exactly the word ORIGINAL and nothing else.', { label: 'one', phase: 'Run', model: 'sonnet' })`.
  - `.claude/workflows/probe2.js` is the control. It makes one call, `agent('Reply with exactly the word ORIGINAL and nothing else.', { label: 'two', phase: 'Run', agentType: 'scout' })`.
  - `.claude/agents/scout.md` defines the `scout` agent with `model: sonnet` and `tools: Read`.
  - `.claude/settings.json` runs `.claude/hooks/log.mjs` on SubagentStart and SubagentStop. At SubagentStop that script reads `agent_transcript_path` and logs every `message.model` it finds there, the same method as section 2.3 of `docs/research-2026-10-31.md`.
- `claude plugin validate <scratch>/wfprobe/mod` reported `hooks: session.start, agent.spawn`, `gating hook without .catch: agent.spawn` and `calls: $.fs.read, $.fs.write (via write), $.process.run`. It ended with "Validation passed with warnings"; the only warnings were the plugin directory's README, LICENSE and icon checks.

Every run started from `proj/` with `--setting-sources project`, so neither the user's settings nor the installed orchestration plugin loaded. The mod was loaded with `--plugin-dir`.

## Runs

| # | Command (from `proj/`; `<mod>` = `<scratch>/wfprobe/mod`) | Outcome |
| --- | --- | --- |
| 1 | `claude -p "Run the saved workflow named probe with the Workflow tool, wait for it to finish, and report exactly what it returned." --model sonnet --setting-sources project --plugin-dir <mod> --allowedTools "Workflow" --output-format json` | Workflow returned `"REWRITTEN"`. `modelUsage`: `claude-sonnet-5-5` (main) and `claude-haiku-5-5`. Cost $0.050 |
| 2 | Same command with `probe2` in place of `probe` | Workflow returned `"ORIGINAL"`. `modelUsage`: `claude-sonnet-5-5` only. Cost $0.055 |
| 3 | `claude -p "Use the Agent tool once with subagent_type scout and this exact prompt: PROBE-REWRITE. Reply with exactly the word ORIGINAL and nothing else. Then report exactly what the agent answered." --model sonnet --setting-sources project --plugin-dir <mod> --allowedTools "Agent" --output-format json` | The agent answered `REWRITTEN`. `modelUsage`: `claude-sonnet-5-5` and `claude-haiku-5-5`. Cost $0.040 |
| 4 | `claude plugin validate` on two copies of the mod: one imports `node:fs`, the other imports `../../proj/outside.mjs` | Both failed. The first: `cannot import "node:fs" (from hooks/register.ts): a hooks module imports its own files by relative path and "claude-code", nothing else`. The second: `cannot import "../../proj/outside.mjs" (from hooks/register.ts): it is outside the plugin's folder` |
| 5 | `claude -p "Reply with the word ok." --model sonnet --setting-sources project --plugin-dir <scratch>/wfprobe/mod-node --debug-file ...` (the `node:fs` copy) | The session ran and answered `ok`, but stderr said `spawnprobe: hooks module did not load: cannot import "node:fs" ...`. The engine refuses the same import at load time |

Log lines (timestamps are UTC):

- Run 1, `agent.spawn:in`: `subagentType: "workflow-subagent"`, `model: "sonnet"`, `parentModel: "claude-sonnet-5-5"`, `background: false`, `workflow: { runId: "wf_60156ca2-8bc", agentIndex: 1 }`, and `tool_use_id` set to the Workflow tool call. The prompt was the script's own text.
- Run 1, `agent.spawn:out`: `{ model: "claude-haiku-5-5", agentId: "a5a9f9d9d4e37b32d" }`. SubagentStart and SubagentStop fired for the same `agent_id`, with `agent_type: "workflow-subagent"`. SubagentStop had `last: "REWRITTEN"`, and the transcript (`.../subagents/workflows/wf_60156ca2-8bc/agent-a5a9f9d9d4e37b32d.jsonl`) has `models: ["claude-haiku-5-5"]`. The word `ORIGINAL` appears 0 times in that transcript: the agent saw only the rewritten prompt, wrapped in the harness's "[Workflow harness — computed task]" frame.
- Run 2, `agent.spawn:in`: `subagentType: "scout"`, `provider: { plugin: "project", tier: "user" }`, no `model` key (the agent's frontmatter decides), and a `workflow` key. `agent.spawn:out`: `{ model: "claude-sonnet-5-5" }`, transcript `models: ["claude-sonnet-5-5"]`, `agent_type: "scout"`.
- Run 3, `agent.spawn:in`: `subagentType: "scout"`, `background: true`, no `workflow` key. `agent.spawn:out`: `{ model: "claude-haiku-5-5", agentId: "a09641cc929c19a99" }`, transcript `models: ["claude-haiku-5-5"]`, `last: "REWRITTEN"`.
- Every run, `session.start`: `helperValue: "helper-imported-ok"`, `tier: "big"` (a function from `helper.mjs`), `fsRead: "disk-read-ok"`, `proc: { exitCode: 0, stdout: "{\"file\":\"x.pdf\",\"ext\":\".pdf\",\"via\":\"node child process\"}" }`.

## Answers

1. **Does a mod's `agent.spawn` hook run under `claude -p`? Yes.** A mod loaded with `--plugin-dir` ran its `session.start` and `agent.spawn` hooks in every headless run (1 to 3). Hot reload and the "turn on mods" question play no part in this path.
2. **Does it fire for workflow agents and for Agent-tool subagents? Yes, for both.** A workflow agent's input carries `workflow: { runId, agentIndex }`. Its `subagentType` is the `agentType` the script gave (`scout` in run 2), or `workflow-subagent` when the script gave none. An Agent-tool subagent has no `workflow` key.
3. **Can it rewrite a workflow agent's model and prompt? Yes, verified by the model the agent ran.** In run 1 the script asked for `sonnet` and the hook set `haiku`. The transcript shows only `claude-haiku-5-5`, the answer was the rewritten prompt's `REWRITTEN`, and the original text never reached the agent. Run 2, the control, ran the frontmatter's `claude-sonnet-5-5`. The same rewrite works for an Agent-tool subagent (run 3).
4. **Can mod code read files or import local modules? Partly.**
   - It can read any file through `$.fs.read`; the type docs say a read is limited to 4 MiB.
   - It can run any host command through `$.process.run`, including `node` on a script that uses `node:*`.
   - It can import its own files with a static relative `import`, such as a pure `helper.mjs`.
   - It cannot import `node:*` modules, or files outside the plugin's folder. `claude plugin validate` refuses both, and the engine refuses the `node:fs` import at load time ("hooks module did not load"). The type header says the module runs with "no DOM, no Node", and that a module that uses `import()` does not load.
   - So `file-profile.mjs` and `skill-catalog.mjs` cannot be imported, because both import `node:fs`, `node:crypto` and others. They can be run as child processes: `file-profile.mjs` already has a CLI (`node file-profile.mjs <paths>` prints JSON). `skill-catalog.mjs` has none.

## What an implementation would need

It is feasible. The parts:

- **Where the hook lives.** The `agent.spawn` handler in `dashboard/register.tsx` already exists and only records spawns. Routing would go there, before its `next(e)`, and only when `e.workflow` is set: Agent-tool launches already get routed by `plan-check.mjs`, and two routers on one launch could disagree. The handler would match `subagentType === 'researcher'` (or `orchestration:researcher`, as the plugin build names it).
- **The brief.** `e.prompt` is the full brief, and `register.tsx` already mirrors the brief parser (`parseHeader` reads `SOURCES` and `READ`). One limit from the types: on a run that keeps its script out of SDK events, the prompt is a placeholder and a prompt rewrite is not applied. This probe's runs, like `orchestrate.js`, were not such runs.
- **The file profile.** Run `node <root>/hooks/file-profile.mjs <sources>` with `$.process.run` and parse its JSON. `$.process.run` has a 30 s default timeout. In the plugin build, `dashboard.tsx` sits in `dist/plugin/hooks/` beside `file-profile.mjs`, so `$.plugin.root` finds the script. The standalone `dist/dashboard` does not ship it, so routing would have to be off there, or the script shipped too.
- **Skill suggestions.** These need a CLI entry in `skill-catalog.mjs`, or a small wrapper script that prints the catalog or the matches as JSON, because the mod cannot import it. The hook could then add the suggested-skills block to `e.prompt`.
- **Rules to keep.** Raise a model the script chose, never lower it, the same rule as the read router. Keep the `ORCH_READ_ROUTER=on` opt-in, which the mod can read through `$`'s environment noun (not probed here). Log each decision to the pane.
- **Failure handling.** The validator lists `agent.spawn` as a gating hook: a hook that throws is skipped. A `.catch` that falls back to `next(e)` keeps a broken profile run from blocking workflow agents.
- **Precedence.** The types say a session that forces one model on every subagent (`CLAUDE_CODE_SUBAGENT_MODEL_FORCE`) outranks the hook.

Not probed: a project or plugin agent named `researcher` started from a workflow with a rewrite (only `scout`, as a control); the interactive TUI; `$.process.run` timing on a large PDF; and the shipped dashboard itself.
