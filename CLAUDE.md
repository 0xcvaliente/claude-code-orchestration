# claude-code-orchestration

Two orchestrators for the same job (split a task, build slices in parallel, gate on tests, verify independently):

- SDK pipeline: `src/` (TypeScript on the Agent SDK). Code in a git repository only. Order is fixed in code. Worktree per slice, optional token cap (off by default), telemetry in `runs/`.
- Native: `.claude/` (agents, hooks, skill, workflow). Any task: code, research, writing, analysis or operations. Run with `claude --agent orchestrator`. Order is the orchestrator's prompt, plus hook gates. Git machinery (worktrees, checkpoint commits, the integrator) is for code in git: parallel slices run in worktrees there, code outside git runs one slice at a time, and work that changes no code may run slices with disjoint files in parallel in the shared folder. The test gate runs wherever there is a test command and skips only a prose-only change in a git work tree. The triage fact `code` changes one routing rule, the parallel-files threshold (`TRIAGE.minParallelFilesCode` 10, `minParallelFilesNonCode` 4; a missing `code` counts as code). It also decides whether git machinery is used and, in `npm run auto`, whether web tools are allowed. The test gate never reads it. The review gate covers every task.

## Commands
- `npm test` / `npm run typecheck`: must pass before finishing.
- `npm run check-agents`: fails if `.claude/agents/*.md` drift from `src/config.ts`; `npm run sync-agents` fixes it.
- `npm run native -- "task" [repo]`: headless native run (needs a logged-in `claude`). `npm run auto -- "task" [repo]`: same, but triage picks plain, reviewed or the orchestrator first.
- `npm run report`: HTML timeline from `.claude/state/` (or the plugin's per-user state dir). `npm run build-plugin`: `dist/plugin` (committed; `npm run check-plugin` fails when stale).
- `npm run bench -- --matrix bench/matrix/<name>.json` runs the benchmark (see bench/README.md); `npm run bench:validate` checks every task's graders with no model calls.

## Rules
- `src/config.ts` is the source of truth for model, effort, maxTurns and the triage thresholds (`TRIAGE`). After editing it, run `npm run sync-agents`.
- Neither path pushes to a remote: SDK workers deny `git push` (`UNSAFE_BASH`), `scripts/orchestrate.sh` passes the same list to every headless native run as `--disallowedTools`, and the agents are told not to push. Project settings deny `git remote`, `sudo` and `rm -rf` (remove specific paths with `rm -r <path>`), but not `git push`: an interactive session may push as its permission mode allows.
- Claude Code's six built-in subagents (`general-purpose`, `claude`, `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`) are blocked: `DENIED_AGENTS` in `src/config.ts` is in `permissions.deny` (`policy.test.ts` keeps them in step) and `scripts/orchestrate.sh` exports `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` for headless runs. Only this repo's researcher, implementer, reviewer and integrator remain. The benchmark's plain runs in README "Why a router" predate this and self-delegated to `general-purpose`.
- Agent-file, hook and settings rules live in `.claude/rules/agents.md` and load when you touch those files.
- When testing hook scripts in zsh, pass JSON with `printf '%s'`, not `echo` (zsh expands `\n`).
