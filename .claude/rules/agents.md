---
paths:
  - ".claude/agents/**"
  - ".claude/hooks/**"
  - ".claude/settings.json"
  - ".claude/workflows/**"
---
# Native orchestrator files

- Never add `memory:` to `orchestrator.md` or `reviewer.md`: it auto-enables Read, Write and Edit and breaks their read-only guarantee.
- `Agent(a, b)` type allowlists only work for an agent run as the main thread (`--agent`); inside a subagent they are ignored.
- Hooks: exit 2 blocks, any other non-zero code only warns. `PostToolUse` cannot undo a tool that already ran. Hooks must exit 0 on malformed input.
- The telemetry and review-gate hooks read `.claude/state/telemetry.jsonl`; keep `session_id`, `agent_type` and `hook_event_name` as the fields they rely on.
- Plugin builds do not carry `hooks`, `permissionMode` or `mcpServers` from agent frontmatter; keep gates in `settings.json` or `hooks.json`.
- After changing model, effort or maxTurns, edit `src/config.ts` and run `npm run sync-agents` instead of editing the agent file.
