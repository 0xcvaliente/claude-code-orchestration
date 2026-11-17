# Probes 2.0.0, slice b1: the test gate at the hand-back

Claude Code 2.1.326, 2026-11-17. Two live runs, both capped, both well under the slice's limit of 0.30 USD and 5 minutes.

## Setup

A scratch project at `<scratch>/probe`, outside the repository: a git repo with this branch's `.claude/hooks/` copied in, `package.json` with `"test": "node test.js"`, and a one-file suite (`test.js` asserts `add(2, 2) === 4`; `add.js` returns `a - b`, so the suite fails). Its `.claude/settings.json` registers PreToolUse on `SubagentHandback` (`handback-check.mjs`, `quote-check.mjs`, `verify.sh --handback`, timeout 900), SubagentStart and SubagentStop `telemetry.mjs`, SubagentStop `journal.mjs`, and SubagentStop `verify.sh` with matcher `^implementer$`. One agent, `.claude/agents/implementer.md`: `model: haiku`, tools Read, Edit, Write, Bash, `maxTurns: 12`.

```bash
cd <scratch>/probe
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 timeout 280 claude -p "Launch the implementer agent (subagent_type: implementer) with exactly this brief: 'SLICE: s1. Report STATUS: pass with one line saying add.js is fine. Do not change any file unless your report is sent back; if it is, follow what it says and report again.' When it returns, repeat its report to me verbatim and stop. Do not launch it again." \
  --model haiku --permission-mode auto --setting-sources project --strict-mcp-config --max-budget-usd 0.25 --output-format json
```

Cap per run: `--max-budget-usd 0.25` and `timeout 280`.

## Run 1 (stop key: the transcript's last entry)

- 23 s, `total_cost_usd` 0.0042.
- `gates.jsonl`, in order:
  1. `block tests_failed`, `at: handback`, `handback_id` of the first hand-back: the refusal. `handback-refusals.jsonl` marks that call (`gate: test`).
  2. `allow tests_passed`, `at: handback`, a second `handback_id` and another `tree`: the worker had read the refusal, changed `add.js` to `a + b`, and handed back again.
  3. `allow tests_passed_cached`, at the SubagentStop, `reused: pass`, `reused_from: handback:<second id>`, the same `tree`: the stop gate did not run the suite again.
- The orchestrator (the main session) received only the second report: `STATUS: pass`, "add.js had a bug (`a - b` instead of `a + b`), which failed npm test; I changed line 1 ...". The refused first report never reached it. `permission_denials` in the result was empty.
- Finding: the stop keys differed. `verify.sh` stored one uuid, `telemetry.mjs` and `journal.mjs` another (the two node hooks agreed with each other).

## Run 2 (stop key: the last assistant entry)

- 24 s, `total_cost_usd` 0.0037.
- The same three gate records (block at the hand-back, pass at the second hand-back, `tests_passed_cached` at the stop reusing it), and the same delivered report.
- The stop keys still differed between `verify.sh` and the node hooks. The node hooks run sooner after the stop than `verify.sh` reaches its read, so the subagent's transcript was still being written while the SubagentStop hooks ran: it is not complete when they fire.

## Run 3: the hook's `cwd` for an isolated implementer (review follow-up)

Question: does PreToolUse on `SubagentHandback` give the agent's worktree as `cwd` when the implementer runs with `isolation: "worktree"`? The hooks documentation lists `cwd` among the common input fields and names no separate worktree field, so it was probed.

Setup: a scratch repo at `<scratch>/probe2` with `worktree.baseRef: "head"`, one agent `implementer` (`model: haiku`, tools Read and Bash) told to report `pwd`, and a hook on PreToolUse `SubagentHandback` and on SubagentStop that logs the input's keys, `cwd`, `git -C <cwd> rev-parse --show-toplevel` and the last `cwd` in `agent_transcript_path`.

```bash
cd <scratch>/probe2
CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 timeout 200 claude -p "Launch the implementer agent with the Agent tool, subagent_type implementer, isolation \"worktree\", with the brief 'Report now.' When it returns, repeat its report verbatim and stop." \
  --model haiku --permission-mode auto --setting-sources project --strict-mcp-config --max-budget-usd 0.10 --output-format json
```

Cap `--max-budget-usd 0.10`. Result: 14 s, `total_cost_usd` 0.0028.

| Event | `cwd` | top level | Other keys |
|---|---|---|---|
| PreToolUse `SubagentHandback` | `<scratch>/probe2/.claude/worktrees/agent-<id>` | the same worktree | `agent_id`, `agent_type`, `tool_use_id`, `transcript_path` (no `agent_transcript_path`, no worktree field) |
| SubagentStop | the same worktree | the same worktree | `agent_transcript_path`, whose entries carry the same `cwd` |

So the hand-back gate tests the worktree the implementer worked in, exactly as the SubagentStop gate does: no change was needed. As a guard, a hand-back whose `cwd` is missing or not a folder is let through and logged (`handback_no_cwd`), and the SubagentStop gate decides.

## What follows

- Proven live: a failing suite refuses the hand-back, the refusal reaches the worker, the worker fixes and hands back, only the corrected report is delivered, and the SubagentStop gate reuses the hand-back's result instead of running the suite a second time. The hand-back gate sees an isolated implementer's worktree.
- A transcript-based stop key cannot work: the transcript is still being written while the SubagentStop hooks run. After review the stop key was dropped. A stop and its test-gate record now carry `after_handback`, the `tool_use_id` of the agent's latest hand-back since its latest start (`handbacks.jsonl`, written at PreToolUse, before the stop). Every SubagentStop hook reads the same value. A stop with no hand-back is paired by count as in 1.6.1. Unit tests cover it; it was not probed live again.
- After review the cache serves one case only: the SubagentStop gate of agent X reuses the result written by X's hand-back gate for X's latest hand-back, once, within 120 s (live, 1 to 2 s passed between the two records), and only when the tree key still matches.

Total cost of the slice's probes: about 0.011 USD (runs 1 to 3).
