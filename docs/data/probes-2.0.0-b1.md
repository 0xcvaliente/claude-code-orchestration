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

## What follows

- Proven live: a failing suite refuses the hand-back, the refusal reaches the worker, the worker fixes and hands back, only the corrected report is delivered, and the SubagentStop gate reuses the hand-back's result instead of running the suite a second time.
- Not proven live: pairing a stop with its test-gate record by `stop_key`. `run.mjs` (`stopGateOf`) therefore takes a record by key only when one carries the stop's key, and otherwise pairs by count as before, leaving out records keyed to one of the agent's earlier stops and every hand-back record. With keys that never match, this is the 1.6.1 behaviour. The unit tests (`src/test-gate-handback.test.mjs`, `src/plan-check-review-hold.test.mjs`) cover the keyed cases.

Total cost of the slice's probes: about 0.008 USD.
