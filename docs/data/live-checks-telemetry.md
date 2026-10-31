# Live check: telemetry v2 in headless runs (ORCH_SESSION_PERSISTENCE)

Version: `2.1.316 (Claude Code)`. Date: 2026-10-31.

Question: telemetry v2 (`.claude/hooks/telemetry.mjs`) reads `tokens`, `turns`, `models` and `max_turns_hit` from the subagent transcript at SubagentStop. `scripts/orchestrate.sh` passes `--no-session-persistence` by default, so no transcript is written. Does `ORCH_SESSION_PERSISTENCE=1`, which drops that flag, make the fields appear?

**Answer: YES.** With the variable set, the researcher's SubagentStop record has all four fields. With the default arguments it has none of them, and the `agent_transcript_path` named in the payload does not exist on disk.

## Setup

Two scratch folders, `<scratch>/persist/` and `<scratch>/default/`. Each is a git repository with one commit and holds a copy of this repo's `.claude/` (without `state/` and `worktrees/`) plus `facts.txt` containing `The capital of Norway is Oslo.`. Each run used a plain session (`ORCH_AGENT=none`) on sonnet, which launched the researcher agent (haiku, from `.claude/agents/researcher.md`) once. The cap was `ORCH_BUDGET_TOKENS=1M`.

The prompt was the same for both runs:

```
Launch the researcher agent exactly once with this brief: SLICE: r1 / FILES: facts.txt / DEPENDS: none / Read facts.txt and report the capital it names, with a QUOTE line. Do not read any file yourself. When it returns, reply with its answer in one line.
```

## Run 1: ORCH_SESSION_PERSISTENCE=1

```
ORCH_AGENT=none ORCH_MODEL=sonnet ORCH_SESSION_PERSISTENCE=1 ORCH_BUDGET_TOKENS=1M \
  scripts/orchestrate.sh "<prompt>" <scratch>/persist
```

Result: `subtype: success`, `subagent_stats.by_type: {"researcher": 1}`, 130,660 tokens in all (sonnet 68,970, haiku 61,690; input, output, cache read and cache write from the result JSON's modelUsage). The SubagentStop record in `<scratch>/persist/.claude/state/telemetry.jsonl` (other fields omitted):

```json
{"agent_type":"researcher","status":"pass","hook_event_name":"SubagentStop",
 "agent_transcript_path":"~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl",
 "tokens":{"input":6,"output":602,"cache_read":39884,"cache_write":21198},
 "turns":3,"models":["claude-haiku-5-5"],"max_turns_hit":false}
```

The tokens match the run's own `modelUsage["claude-haiku-5-5"]` exactly (input 6, output 602, cache read 39884, cache write 21198).

## Run 2: default (variable unset)

```
ORCH_AGENT=none ORCH_MODEL=sonnet ORCH_BUDGET_TOKENS=1M \
  scripts/orchestrate.sh "<prompt>" <scratch>/default
```

Result: `subtype: success`, `subagent_stats.by_type: {"researcher": 1}`, 109,486 tokens in all (sonnet 68,943, haiku 40,543; same fields). In the SubagentStop record in `<scratch>/default/.claude/state/telemetry.jsonl`, `agent_type` is `researcher` and `status` is `pass` (read from `last_assistant_message`). There are no `tokens`, `turns`, `models` or `max_turns_hit` keys, and the file at `agent_transcript_path` does not exist.

## Consequence

To get per-agent tokens, turns and models from a headless run or a bench run, set `ORCH_SESSION_PERSISTENCE=1`. The bench launchers (`bench/lib/plugin-launch.sh`, `bench/lib/native-launch.sh`) read the `ORCH_DRY_RUN=1` argument list, so they get the setting through the environment. The cost is that session transcripts are written under `~/.claude/projects/` for every run. The default is unchanged: `--no-session-persistence`, with these fields empty.
