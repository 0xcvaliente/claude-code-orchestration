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
- The telemetry and review-gate hooks read `telemetry.jsonl` in the state dir from `.claude/hooks/state.mjs`; keep `session_id`, `agent_type`, `hook_event_name` and `ts` as the fields they rely on. `verify.sh` mirrors the state-dir rule in bash: change both together. `src/route.ts` and `scripts/report.mjs` import `state.mjs` from a checkout, so keep its exports free of side effects beyond reading settings.
- Plugin hooks run with `--plugin`. A hook with no matcher must exit early on `duplicate()` from `state.mjs`, or it runs twice next to the project copy; keep the project and plugin `verify.sh` matchers disjoint.
- Plugin builds do not carry `hooks`, `permissionMode` or `mcpServers` from agent frontmatter; keep gates in `settings.json` or `hooks.json`.
- After changing model, effort or maxTurns, edit `src/config.ts` and run `npm run sync-agents` instead of editing the agent file.
- The orchestrator's "Size the task first" step mirrors `TRIAGE` in `src/config.ts` (the SDK and `npm run auto` use those numbers). Change both together. `npm run build-plugin` after any change under `.claude/agents`, `skills` or `hooks`: `dist/plugin` is committed and `npm run check-plugin` fails when stale.
- `worktree.baseRef` must be `"head"` in settings for checkpoint commits and for parallel slices on unpushed or feature-branch work; the default starts worktrees from the remote default branch.
- Resume an implementer with `SendMessage` (to its agent id) to send reviewer gaps; it keeps its context instead of re-reading the code.
