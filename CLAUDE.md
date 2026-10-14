# claude-code-orchestration

Two orchestrators for the same job (split a task, build slices in parallel, gate on tests, verify independently):

- SDK pipeline: `src/` (TypeScript on the Agent SDK). Code in a git repository only. Order is fixed in code. Worktree per slice, optional budget cap (off by default), telemetry in `runs/`.
- Native: `.claude/` (agents, hooks, skill, workflow). Any task: code, research, writing, analysis or operations. Run with `claude --agent orchestrator`. Order is the orchestrator's prompt, plus hook gates. Git machinery (worktrees, checkpoint commits, the integrator) is for code in git: parallel slices run in worktrees there, code outside git runs one slice at a time, and work that changes no code may run slices with disjoint files in parallel in the shared folder. The test gate runs wherever there is a test command and skips only a prose-only change in a git work tree. The triage fact `code` does not change the route, and the test gate never reads it: it decides whether git machinery is used and, in `npm run auto`, whether web tools are allowed. The review gate covers every task.

## Commands
- `npm test` / `npm run typecheck`: must pass before finishing.
- `npm run check-agents`: fails if `.claude/agents/*.md` drift from `src/config.ts`; `npm run sync-agents` fixes it.
- `npm run native -- "task" [repo]`: headless native run (needs a logged-in `claude`). `npm run auto -- "task" [repo]`: same, but triage picks plain, reviewed or the orchestrator first.
- `npm run report`: HTML timeline from `.claude/state/` (or the plugin's per-user state dir). `npm run build-plugin`: `dist/plugin` (committed; `npm run check-plugin` fails when stale).

## Rules
- `src/config.ts` is the source of truth for model, effort, maxTurns and the triage thresholds (`TRIAGE`). After editing it, run `npm run sync-agents`.
- Nothing in either path pushes to a remote. Project settings deny `git push`, `git remote`, `sudo` and `rm -rf`; remove specific paths with `rm -r <path>`.
- Agent-file, hook and settings rules live in `.claude/rules/agents.md` and load when you touch those files.
- When testing hook scripts in zsh, pass JSON with `printf '%s'`, not `echo` (zsh expands `\n`).
