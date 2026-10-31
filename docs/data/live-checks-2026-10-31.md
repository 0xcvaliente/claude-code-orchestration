# Live checks: workflow hooks and headless background waits

Version: `2.1.314 (Claude Code)` (file: `claude-version.txt`). Date: 2026-10-31.

`--setting-sources project` worked. Auth was fine, and only the project hooks logged. All nested runs used `ORCH_NO_NUDGE=1` and `--model haiku`, and all ran from `live-checks/repo/`.

Raw evidence files, all in `live-checks/`:

- `events.jsonl` is the full hook log for every run.
- Per-run slices: `checkA.events.jsonl`, `checkA2.events.jsonl`, `checkB.events.jsonl`, `checkB2.events.jsonl`.
- CLI output: `checkA.out.json`, `checkA2.out.json` (stderr is mixed in: a stdin warning comes first, then the JSON), `checkB.out.json`, `checkB2.out.json`.
- Wall clock: `check*.timing.txt`.

Setup: `repo/.claude/hooks/log.mjs` and `repo/.claude/settings.json` log PreToolUse and PostToolUse (matcher `.*`), SubagentStart, SubagentStop, Stop and UserPromptSubmit. The workflow scripts are `repo/.claude/workflows/probe.js` and `probe2.js`.

## Check A: do agents launched by a Workflow script fire the parent session's hooks?

**Answer: YES, with one gap.** SubagentStart and SubagentStop fire for each agent, and so do the agents' own PreToolUse and PostToolUse events. No PreToolUse or PostToolUse fires for an Agent or Task tool, because the script launches agents directly.

Command (first try worked, so `/probe` was not needed):

    ORCH_NO_NUDGE=1 claude -p "Run the saved workflow named probe with the Workflow tool and report what it returned." --model haiku --setting-sources project --allowedTools "Workflow" --output-format json

Result: `{"a":"alpha","b":"beta"}` (`checkA.out.json`, `.result`). The run took 9 s wall clock (`checkA.timing.txt`).

Events, from `checkA.events.jsonl`, all with session `c0ca0981…`:

| ts (UTC) | event | details |
|---|---|---|
| 03:09:47.671 | UserPromptSubmit | prompt_id `3a097123…` |
| 03:09:49.148 | PreToolUse | tool_name `Workflow`, tool_input `{"name":"probe"}` |
| 03:09:49.313 | PostToolUse | `Workflow`, tool_response `{"status":"async_launched","taskId":"wvzcwm7xq","taskType":"local_workflow","workflowName":"probe","runId":"wf_9c9d6ef0-3ac",…}`; tool_input now also has the full `script` |
| 03:09:49.324 | SubagentStart | agent_id `a4c93bf3b7a393b3a`, agent_type `workflow-subagent` |
| 03:09:50.679 | SubagentStop | same agent, `last_assistant_message:"alpha"`, background_tasks `[{"id":"wvzcwm7xq","type":"workflow","status":"running","description":"Probe whether…","name":"probe"}]` |
| 03:09:50.868 | SubagentStart | agent_id `ad7485f4ceed47a34`, agent_type `workflow-subagent` |
| 03:09:51.179 | **Stop** (main) | background_tasks: the same workflow entry, `status:"running"` |
| 03:09:51.860 | SubagentStop | `ad7485f4…`, `last_assistant_message:"beta"`, workflow still `running` |
| 03:09:52.051 | UserPromptSubmit | new prompt_id `e0e88c09…`; prompt begins `<task-notification><task-id>wvzcwm7xq</task-id>…` |
| 03:09:54.659 | Stop | `background_tasks: []` |

Counts for the probe run: 2 SubagentStart, 2 SubagentStop, 0 PreToolUse for Agent or Task.

Supplementary run A2, where the agent uses a tool (`probe2.js`, same command with `probe2`, `--allowedTools "Workflow,Read"`; see `checkA2.events.jsonl`):

- 03:10:19.861 PreToolUse `Read` and 03:10:20.046 PostToolUse `Read` both carry `agent_id:"adce97156f075ad54"` and `agent_type:"workflow-subagent"`. **Tool events made inside a workflow agent fire the parent's hooks and can be told apart by agent_id.**
- prompt_id: the workflow agent's events keep the prompt_id of the turn that launched the workflow (`997697c9…`), even after that turn's Stop at 03:10:19.860. The re-entry turn after the task notification gets a new prompt_id (`da41095e…`).

Other notes:

- SubagentStart has no `permission_mode` field. SubagentStop has `agent_transcript_path` under `…/subagents/workflows…`.
- A workflow appears in background_tasks with `type:"workflow"` and fields `name` and `description` (no `agent_type`). A workflow agent does not get its own entry.
- In both runs the main Stop fired while the workflow was still running.

## Check B: does `claude -p` wait for background subagents before the process exits?

**Answer: YES for background subagents. NO for background shell tasks: they are dropped and never finish.**

### B1: the command as briefed

    ORCH_NO_NUDGE=1 claude -p "Use the Agent tool with run_in_background set to true to start ONE subagent whose task is: run the Bash command: sleep 40 && echo done > done.txt . Do not wait for it. Immediately reply with the single word launched." --model haiku --setting-sources project --allowedTools "Agent,Bash,Read,Write" --permission-mode acceptEdits --output-format json < /dev/null

Timing (`checkB.timing.txt`): start 03:10:40Z, exit 03:10:56Z, so **16 s of wall time**. `done.txt` was missing at exit and still missing at 03:12:05Z, which is 69 s after exit.

| ts | event | details |
|---|---|---|
| 03:10:43.267 | PreToolUse Agent | `run_in_background:true` |
| 03:10:43.434 | SubagentStart | `a601dfc84ba0f1bec`, `general-purpose` |
| 03:10:43.435 | PostToolUse Agent | `status:"async_launched"` |
| 03:10:44.445 | Stop | `[{"id":"a601dfc84ba0f1bec","type":"subagent","status":"running","description":"Background sleep and write done file","agent_type":"general-purpose"}]` |
| 03:10:46.892 | PreToolUse Bash (agent_id a601…) | `{"command":"sleep 40 && echo done > done.txt","run_in_background":true}` |
| 03:10:47.169 | PostToolUse Bash | `backgroundTaskId:"bum4z7i0u"` |
| 03:10:48.599 | SubagentStop | background_tasks: the subagent `running`, plus `{"id":"bum4z7i0u","type":"shell","status":"running","description":"Sleep 40 seconds then write done.txt","command":"sleep 40 && echo done > done.txt"}` |
| 03:10:48.830 | UserPromptSubmit | task-notification re-entry |
| 03:10:50.885 | Stop | `[{"id":"bum4z7i0u","type":"shell","status":"running",…}]` |
| 03:10:56 | process exit | the shell task was still running; done.txt never appeared |

The subagent backgrounded its own Bash call, so it finished in about 5 s. Its `last_assistant_message` says a first foreground try "was blocked" by the harness. That rejected call produced no PreToolUse event. So B1 shows that the process waited for the subagent, then exited about 6 s after the final Stop and did not wait for the running shell task. That shell's file write never happened.

### B2: retry with wording that keeps the subagent busy

Same flags, with this prompt:

    Use the Agent tool with run_in_background set to true to start ONE subagent whose task is: run this exact Bash command in the FOREGROUND (Bash run_in_background must be false) and wait for it to finish, then reply finished: node -e "setTimeout(()=>require('fs').writeFileSync('done2.txt','done'),40000)" . You yourself must not wait for the subagent. Immediately reply with the single word launched.

Timing (`checkB2.timing.txt`): start 03:11:30Z, exit 03:12:17Z, so **47 s of wall time**. `done2.txt` existed at exit, with mtime 04:12:14 local, which is 03:12:14Z.

| ts | event | details |
|---|---|---|
| 03:11:32.761 / .939 | PreToolUse and PostToolUse Agent | `run_in_background:true`, `async_launched` |
| 03:11:32.942 | SubagentStart | `a0821d4bcfb9e1a23`, `general-purpose` |
| 03:11:34.423 | **Stop** (first) | `[{"id":"a0821d4bcfb9e1a23","type":"subagent","status":"running","description":"Run foreground delayed file write","agent_type":"general-purpose"}]` |
| 03:11:34.517 → 03:12:14.976 | PreToolUse and PostToolUse Bash (agent_id a0821…) | `run_in_background:false`, about 40 s |
| 03:12:15.870 | SubagentStop | background_tasks still shows the subagent `running` |
| 03:12:16.141 | UserPromptSubmit | task-notification re-entry, new prompt_id |
| 03:12:17.520 | Stop (final) | `background_tasks: []` |
| 03:12:17 | process exit | |

`subagent_stats` in `checkB2.out.json`: `started_in_background:1, completed:1`.

Shapes of background_tasks entries seen:

- subagent: `{id, type:"subagent", status, description, agent_type}`
- shell: `{id, type:"shell", status, description, command}`
- workflow: `{id, type:"workflow", status, description, name}`

Only `status:"running"` was ever seen. A finished task drops out of the list rather than showing `completed`.

## Surprises

1. **Stop fires before the work is done.** In headless mode the first Stop fires while background subagents or workflows are still running, which shows in background_tasks. The CLI then re-enters with a `<task-notification>` UserPromptSubmit (new prompt_id), and another Stop follows. A hook that treats Stop as the end of the session will fire early. Check that `background_tasks` is empty instead.
2. **`--output-format json` reports only the last turn.** `.result` and `num_turns:1` come from the re-entry turn, and `origin.kind:"task-notification"` in `checkA.out.json` shows this. The "launched" reply is not in the result.
3. **A SubagentStop can list its own agent as still running.** In B1 at 03:10:48.599 and B2 at 03:12:15.870, the stopping agent's entry still shows `running`.
4. **Background shell tasks are dropped when the process exits.** B1's `sleep 40` never wrote its file.
5. **Some blocked calls leave no hook event.** The harness blocked the subagent's foreground `sleep 40` before any PreToolUse fired, according to the agent's own message (B1 SubagentStop). The hook log has no sign of that blocked call.
6. **Workflow agents get their own agent_type.** It is `workflow-subagent`, which is different from Agent-tool agents (`general-purpose`).

## Check C: what agent_type do hooks see when a workflow agent() names an agentType?

**Answer: the bare agent name.** Hooks see `"implementer"` and `"reviewer"`, not `workflow-subagent` and not a prefixed form. A SubagentStop hook with matcher `^implementer$` matches the string. I did not run such a matcher; this conclusion comes from the logged `agent_type` value, which is exactly `"implementer"`.

Setup: `repo/.claude/agents/implementer.md` and `repo/.claude/agents/reviewer.md`. Each has frontmatter `name`, `description: probe <name>`, `model: haiku` and `tools: Read`, and a body asking for the exact word. The workflow is `repo/.claude/workflows/probe3.js`, as briefed: the implementer agent passes `model:'haiku'`, and the reviewer agent passes no model.

Command, run from `repo/` (log in `checkC.events.jsonl`, output in `checkC.out.json`, timing in `checkC.timing.txt`):

    ORCH_NO_NUDGE=1 claude -p "Run the saved workflow named probe3 with the Workflow tool and report what it returned." --model haiku --setting-sources project --allowedTools "Workflow" --output-format json < /dev/null

Result: `{"a":"gamma","b":"delta"}`. The run took 11 s, from 03:15:26Z to 03:15:37Z.

| ts (UTC) | event | agent_id | agent_type | last_assistant_message |
|---|---|---|---|---|
| 03:15:30.550 | SubagentStart | a89b1c8090ea39851 | `"implementer"` | (no field) |
| 03:15:32.171 | SubagentStop | a89b1c8090ea39851 | `"implementer"` | `"gamma"` |
| 03:15:32.481 | SubagentStart | aea8f8c496403944d | `"reviewer"` | (no field) |
| 03:15:32.970 | Stop (main) | (none) | (none) | background_tasks `[{"id":"wwe7nr2f8","type":"workflow","status":"running","description":"agentType probe","name":"probe3"}]` |
| 03:15:34.415 | SubagentStop | aea8f8c496403944d | `"reviewer"` | `"delta"` |
| 03:15:36.995 | Stop | (none) | (none) | `background_tasks: []` |

Model used by each agent (`checkC.models.txt`, read from the agent transcripts under `…/subagents/workflows/wf_8818e2fe-551/`):

- Both agents' `api-request` params and assistant messages show `claude-haiku-5-5`. The `querySource` values are `agent:custom:implementer` and `agent:custom:reviewer`.
- The one `claude-opus-5-5` hit in each file sits inside the `api-request-shape` system-prompt text, not in the request params.
- `agent-aea8f8c496403944d.meta.json` contains `{"agentType":"reviewer","isBuiltIn":false,"description":"probe:typed-rev","workflowPhase":"Probe",…}`.
- **Caveat:** the parent session also ran on haiku, so this run cannot tell whether the reviewer took haiku from its frontmatter or inherited it from the session. Telling them apart needs a parent on a different model.

Contrast with Check A: an agent() call without agentType reports `agent_type:"workflow-subagent"`.

## Addendum: probes for 0.3.0 (Claude Code 2.1.314)

These ran after Checks A to C, while the 0.3.0 slices were built. Their record is the code comment or doc each one names.

- **Plugin workflow `agentType` (slice B1; `scripts/build-plugin.mjs` header).** In a workflow shipped by a plugin, `agent()` with a namespaced `agentType` (`<plugin>:implementer`) resolved to the plugin's agent, and SubagentStart and SubagentStop hooks saw `agent_type: "<plugin>:implementer"`. A bare `agentType: 'implementer'` was "not found". So `npm run build-plugin` rewrites every `agentType: '<role>'` in `.claude/workflows/*.js` to `orchestration:<role>`, and the plugin's `verify.sh` matcher `orchestration:implementer` matches those agents. Check C still holds for the project copy: a project workflow's agents report the bare name.
- **A saved workflow starts headless with JSON arguments (slice B4; `bench/README.md`, "Short documentation run").** `claude -p '/hello {"task":"toy"}' --permission-mode dontAsk --allowedTools Workflow` (haiku, about $0.008) in a scratch folder with a toy `.claude/workflows/hello.js`: the model called `Workflow {"name":"hello","args":{"task":"toy"}}`, the workflow ran in the background, and `-p` waited for it and returned `{"echoed":{"task":"toy"}}`.
- **A direct request in a `-p` prompt starts a workflow; `ultracode` alone does not (slice B4; same section).** The workflows doc (https://code.claude.com/docs/en/workflows.md) says the `ultracode` keyword opts in only in a prompt the person types, not in one passed with `-p`, and that a direct request is the same opt-in. Probe: `claude -p 'ultracode Use a workflow with two agents to list the files in this folder.' --model haiku --max-turns 3 --max-budget-usd 0.10 --permission-mode dontAsk --allowedTools Workflow Read Glob 'Bash(ls*)'` with `CLAUDE_CODE_SUBAGENT_MODEL=haiku`: the model loaded the workflow-authoring skill, called `Workflow` with a two-agent script, and `-p` waited for both agents (about $0.016). The bench arm `N-UC` therefore adds the direct request to the keyword.

## Probes for 0.4.0, slice e-guards (Claude Code 2.1.316, 2026-10-31)

Version: `2.1.316 (Claude Code)`. All runs used `--model haiku`, `--setting-sources project` and `ORCH_NO_NUDGE=1`, in scratch folders under the session scratchpad (`probe-guards/` and `probe-wt/`). Every run cost under $0.01.

### Check E: what a subagent's PreToolUse input carries, and where its brief is

Setup: `probe-guards/.claude/agents/reviewer.md` (haiku, `tools: WebFetch, Bash(ls*)`), a project workflow `probe.js` with one `agent(..., { agentType: 'reviewer' })`, and a PreToolUse hook on `WebFetch|Bash` that logs the input keys, reads the first `type: "user"` line of candidate transcripts and then exits 2 for WebFetch, so nothing was fetched. Commands (script `probe-guards-fg.sh`):

    claude -p "Use the Agent tool with subagent_type reviewer (foreground, not background) and this exact prompt: 'SLICE: fg-probe ...'" --allowedTools "Agent,WebFetch" --output-format json
    claude -p "Run the saved workflow named probe with the Workflow tool and report what it returned." --allowedTools "Workflow,WebFetch" --output-format json
    claude -p "Use the Agent tool with subagent_type reviewer and run_in_background set to true, ... 'SLICE: bg-probe ...'" --allowedTools "Agent,WebFetch" --output-format json

Results, for all three (foreground, workflow `agent()` and background):

- PreToolUse keys: `session_id, transcript_path, cwd, prompt_id, permission_mode, agent_id, agent_type, effort, hook_event_name, tool_name, tool_input, tool_use_id`. `agent_type` is `"reviewer"` in all three. **There is no `agent_transcript_path`** (only SubagentStop carries it). `transcript_path` is the main session's transcript, whose first user message is the parent's prompt, not the brief.
- The subagent's own transcript, already on disk when its first tool call fires: `<transcript_path minus .jsonl>/subagents/agent-<agent_id>.jsonl` for the Agent tool (foreground and background), and `<same>/subagents/workflows/<wf run id>/agent-<agent_id>.jsonl` for a workflow agent. Its first line is `type: "user"`, `isSidechain: true`, `agentId: <agent_id>`, and `message.content` is the brief as a string.
- Agent tool: the content is the brief verbatim (`"SLICE: fg-probe\nFetch https://example.com/fg ..."`). Workflow: the harness wraps it, `"[Workflow harness — computed task] ... The computed task text follows:\n  SLICE: wf-probe\n  Fetch https://example.com/wf ..."`, every brief line indented by two spaces. `parseHeader` reads the indented `SLICE:` and `briefUrls` the URLs.
- Exit 2 from the PreToolUse hook blocked the fetch inside the subagent in all three cases (`web_fetch_requests: 0`).

Used by `.claude/hooks/egress-guard.mjs`; its fixtures in `src/guards.test.mjs` copy both transcript shapes.

### Check F: can a WorktreeCreate hook start `isolation: worktree` agents from the local HEAD?

Setup (`probe-wt/setup.sh`): a bare `origin.git` with commit `origin-base`, a clone `repo/` with one more unpushed commit `local-only`, no `worktree.baseRef` setting, an agent `iso` (`isolation: worktree`, `tools: Bash(git log*), Bash(pwd)`) that prints `pwd` and `git log -1 --format=%s`, and a WorktreeCreate hook `wt.mjs` whose behaviour `WT_MODE` picks. Command per mode (`probe-wt/run.sh <mode>`):

    WT_MODE=<mode> claude -p "Use the Agent tool with subagent_type iso and the prompt 'report'. Then reply with exactly what it returned, or with the exact error text if the Agent tool failed." --allowedTools "Agent,Bash(git log*),Bash(pwd)" --output-format json

| mode | hook behaviour | outcome |
|---|---|---|
| baseline | no hook | agent in `.claude/worktrees/agent-<id>` at `origin-base` (the remote default branch); worktree and branch removed afterwards |
| head | `git worktree add -b worktree-<name> <repo>/.claude/worktrees/<name> HEAD`, print the path | worktree created at `local-only` (86b2c30). A rerun with `--allowedTools "Agent,Bash"` (`head2.sh`) had the agent report `<repo>/.claude/worktrees/agent-a8f035cf6a2925bed local-only`. The worktree and its branch were **left behind** after the run, and a logging WorktreeRemove hook never fired |
| garbage | print `this is not a path`, exit 0 | Agent tool fails: "WorktreeCreate hook returned a path that is not a directory: <cwd>/this is not a path. The hook must create the directory before echoing its path." |
| fail | exit 1 | Agent tool fails: "WorktreeCreate hook failed: node ...wt.mjs: probe fails" |
| empty | exit 0, no output | Agent tool fails: "WorktreeCreate hook failed: hook succeeded but returned no worktree path (command: echo the path to stdout; http/callback: return hookSpecificOutput.worktreePath)" |
| deny | exit 2 | Agent tool fails: "WorktreeCreate hook failed: ... probe denies" |

Hook input keys: `session_id, transcript_path, cwd, prompt_id, hook_event_name, name`, with `name` = `agent-<agent id>` and `cwd` the project root (also `CLAUDE_PROJECT_DIR`).

**Answer: it works, but `worktree-head.mjs` was not written.** The hook replaces Claude Code's creation completely: any non-zero exit, empty stdout or non-directory path fails the agent launch with no fallback to the built-in path, so a hook bug would stop every isolated agent. Hook-created worktrees are not cleaned up (no WorktreeRemove call, the unchanged worktree and branch stay), while the built-in path removes them. `worktree.baseRef: "head"` in settings gives the local-HEAD start without either risk, so it stays the documented way (`.claude/rules/agents.md`).

## Probes for 0.4.0, slice i-router (2026-10-31)

### Check G: does the dashboard mod's `agent.spawn` hook run under `claude -p`, and can it rewrite a workflow researcher's model?

**Run later, with a minimal probe mod in place of the dashboard: see [live-checks-workflow.md](live-checks-workflow.md)** (Claude Code 2.1.316, 2026-10-31). The slice that wrote this section ran out of turns first. In short:

- A `--plugin-dir` mod's `agent.spawn` hook runs under `claude -p`.
- The hook fires for workflow agents (`e.workflow` is set) and for Agent-tool subagents.
- It can rewrite a workflow agent's `model` and `prompt`. The script asked for sonnet, the hook set haiku, and the transcript shows `claude-haiku-5-5` and the rewritten prompt.
- Mod code can read files (`$.fs.read`) and run `node` scripts (`$.process.run`). It can import only its own files, never `node:*` or files outside the plugin.

**Consequence:** `dashboard/register.tsx` still does not route workflow researchers. The probe shows routing is possible; [live-checks-workflow.md](live-checks-workflow.md) ends with what an implementation would need. The read router covers only Agent tool launches, through `plan-check.mjs`, since a workflow's `agent()` makes no Agent tool call (Check C, and `.claude/rules/agents.md`, "The scripted workflow"). The pane shows the model each researcher runs with: `spawned.model` on its start line and card. Whether that value reflects a PreToolUse `updatedInput` model has not been checked live either.

## Check H: does the read router raise a researcher on a scanned PDF? (Claude Code 2.1.316, 2026-10-31)

**Answer: yes, once, in one manual run.** Recorded for the compare-040 write-up ([../benchmark-compare-040.md](../benchmark-compare-040.md)), where no benchmark run launched a researcher.

Setup: a scratch git repo with this repo's `.claude/` copied in (at 56ec956) and `src/fixtures/files/scanned.pdf` copied as `scanned.pdf`. Command, from the scratch repo:

    ORCH_READ_ROUTER=on claude -p "..." --model sonnet --allowedTools=Agent

The main session launched the project `researcher` with the brief `SLICE: r1 / SOURCES: scanned.pdf / READ: extract / Question: what text is shown on the first page...`.

- `.claude/state/reads-route.jsonl`: `{"agent_type":"researcher","decision":"route","tier":"sonnet","model":"haiku","model_source":"agent_file","raised":true,"to":"sonnet","reasons":["read_extract","pdf_sonnet","pdf_scanned","pdf_hard_pages"],"files":1,"conversions":0,"hard_pages":0}`.
- `.claude/state/telemetry.jsonl`, the researcher's SubagentStop: models `["claude-sonnet-5-5"]`, 2 turns, tokens `{input 4, output 305, cache_read 6288, cache_write 9658}`. The plan check's model change took effect.
- The researcher reported no readable text on the page. The fixture page is an image without legible text, so the answer is right.
- Inconsistency in the log: `hard_pages` is 0 while the reasons include `pdf_hard_pages`.

Not checked: scores or token savings, other file types, and a workflow researcher (Check G).
