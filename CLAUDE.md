# claude-code-orchestration

Two orchestrators for the same job (split a task, build slices in parallel, gate on tests, verify independently):

- SDK pipeline: `src/` (TypeScript on the Agent SDK). Order is fixed in code. Worktree per slice, budget caps, telemetry in `runs/`.
- Native: `.claude/` (agents, hooks, skill, workflow). Run with `claude --agent orchestrator`. Order is the orchestrator's prompt, plus hook gates.

## Commands
- `npm test` / `npm run typecheck`: must pass before finishing.
- `npm run check-agents`: fails if `.claude/agents/*.md` drift from `src/config.ts`; `npm run sync-agents` fixes it.
- `npm run native -- "task" [repo]`: headless native run (needs a logged-in `claude`).
- `npm run report`: HTML timeline from `.claude/state/`. `npm run build-plugin`: `dist/plugin`.

## Rules
- `src/config.ts` is the source of truth for model, effort and maxTurns. After editing it, run `npm run sync-agents`.
- Nothing in either path pushes to a remote. Project settings deny `git push`, `git remote`, `sudo` and `rm -rf`; remove specific paths with `rm -r <path>`.
- Agent-file, hook and settings rules live in `.claude/rules/agents.md` and load when you touch those files.
- When testing hook scripts in zsh, pass JSON with `printf '%s'`, not `echo` (zsh expands `\n`).
