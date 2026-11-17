# Probes for 1.6.1, slice k3: resuming a saved workflow, and the guard and the keyword refusal live

Date: 2026-11-17. Claude Code 2.1.326, Linux. Three paid calls, each with `--max-budget-usd`; 0.0158 USD at most in all (the slice's limit was 0.25 USD). This repo's real orchestrate workflow was never run.

**Setup.** Two scratch folders in the session's scratchpad, outside the repo, each with its own `.claude/settings.json`, run with `--setting-sources project` (the user's enabled plugins do not load), `--model haiku --permission-mode dontAsk --allowedTools Workflow --output-format stream-json --verbose` and `ORCH_NO_NUDGE=1`. The saved workflow is a toy `.claude/workflows/orchestrate.js` (`meta.name` `orchestrate`, one phase, one `agent()` call that answers `pong`, `return { echoed: args, r }`). The agent call is there so that the run has a journal: Claude Code refuses to resume a run with no journal before any hook runs. A logging hook (PreToolUse and PostToolUse, matcher `Workflow`) wrote each `tool_input` (a `script` value replaced by its length and SHA-256), the SHA-256 of the file a `scriptPath` names, the SHA-256 of the saved file, and the PostToolUse `tool_response`.

## Probe 1: what a resume looks like at PreToolUse

**Command** (folder `wfprobe`, logging hook only, no guard; cap 0.08 USD):

```
CLAUDE_CODE_SUBAGENT_MODEL=haiku claude -p 'Step 1: call the Workflow tool with exactly {"name":"orchestrate","args":{"task":"toy"}} and wait for it to complete. Step 2: resume that run: call Workflow with {"name":"orchestrate","resumeFromRunId":"<the Run ID from step 1>","args":{"task":"toy"}} and wait. Step 3: call Workflow with {"scriptPath":"<the Script file path from step 1>","resumeFromRunId":"<the Run ID from step 1>","args":{"task":"toy"}} and wait. Then reply DONE with each step result in one line.' --model haiku --setting-sources project --permission-mode dontAsk --allowedTools Workflow --max-turns 10 --max-budget-usd 0.08 --output-format stream-json --verbose
```

**Observed** (three Workflow calls, all completed with `{"echoed":{"task":"toy"},"r":"pong"}`):

| Call | PreToolUse `tool_input` keys | PostToolUse adds | Notes |
|---|---|---|---|
| launch | `name`, `args` | `script` (SHA-256 of the saved file) | result: `runId` `wf_5a36ce0f-de9`, `scriptPath` `<config>/projects/<project key>/<session id>/workflows/scripts/orchestrate-wf_5a36ce0f-de9.js` |
| resume by name | `name`, `args`, `resumeFromRunId` | `script` (SHA-256 of the saved file) | 1 of 1 agent result served from cache; the script that ran is the saved file as it is now |
| resume by file | `args`, `scriptPath`, `resumeFromRunId` | `script` (same SHA-256) | `scriptPath` is the persisted copy from the launch, byte for byte the saved file; 1 of 1 result from cache |

The run id has Claude Code's schema form, `^wf_[a-z0-9-]{6,}$` (the tool's input schema in the 2.1.326 binary). The binary's own resume notices give the second form, `Workflow({scriptPath, resumeFromRunId})`, and the tool description says `scriptPath` takes precedence over `script` and `name`. Not produced: `scriptPath` without `resumeFromRunId`, `scriptPath` together with `name`, a `remote` key. The binary also names an environment variable that limits the tool to `{name, args}` (it refuses `script`, `scriptPath`, `resumeFromRunId` and `remote`); it was not tried.

**Cost.** The stream had two result lines (the first when the launch went to the background): 0.0051584 and 0.0074424 USD. The second is the session's running total; the sum, 0.0126008 USD, is the upper bound used below.

**Rule taken into `workflow-guard.mjs`.** A resume by name is a launch by name plus a `resumeFromRunId` of the schema form, judged like the launch (the saved file's content). A resume by file passes only with exactly `scriptPath`, `resumeFromRunId` and optionally `args`, an absolute `scriptPath` of the form `.../workflows/scripts/<anything>-<resumeFromRunId>.js`, and a file there that hashes to one of the two stored values. Every shape not seen stays refused.

## Probe 2: the new hooks live

Folder `wfprobe2`: the same toy workflow, the logging hook, and this slice's `workflow-guard.mjs`, `workflow-hash.mjs`, `state.mjs` and `nudge.mjs` registered as the project registers them (PreToolUse `Workflow`, UserPromptSubmit).

- (2a) `claude -p 'ultracode Use a workflow to list the files in this folder.' ... --max-turns 3 --max-budget-usd 0.02`. Result: `UserPromptSubmit operation blocked by hook:` followed by the nudge's message (keyword-started workflows are off, type the request again without the word, or use the orchestrator) and the original prompt; `num_turns` 0, `total_cost_usd` 0. The prompt never reached the model.
- (2b) `claude -p '/orchestrate {"task":"toy"}' ... --max-turns 3 --max-budget-usd 0.05`. PreToolUse saw `{"name":"orchestrate","args":{"task":"toy"}}`; the guard refused it with `workflow_content_mismatch` (the toy file is not this repo's workflow), no PostToolUse fired, and `workflow-guard.jsonl` got `decision: "deny"`, `reason: "workflow_content_mismatch"`. Cost 0.00323909 USD.

The allow path of the new guard (this repo's real workflow by name, by resume and by persisted file) was not run live, since that would run the real workflow; the unit tests in `src/workflow-guard.test.mjs` cover it with the shapes above.

## Total

| Run | Cap (USD) | Cost (USD) |
|---|---|---|
| 1, launch and two resumes | 0.08 | 0.0126008 (upper bound; 0.0074424 reported as the running total) |
| 2a, typed keyword | 0.02 | 0 |
| 2b, toy file at the saved name | 0.05 | 0.0032391 |
| **Total** | | **0.0158399 at most** |

## Limits

One run per probe, haiku as the main model, one machine. A resume of a workflow from the plugin (`orchestration:orchestrate`) was not probed; its persisted file name is not known, so the guard checks only the `-<run id>.js` ending and the folder. A typed prompt in an interactive session was not tried (under `-p` the UserPromptSubmit block behaved as documented).
