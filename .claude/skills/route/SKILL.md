---
name: route
description: Decide whether a coding task should run as a plain session, a plain session plus an independent reviewer, or the multi-agent orchestrator pipeline. Use before starting a non-trivial task, or when asked "should I orchestrate this".
argument-hint: <task description>
---
Size the task before doing it.

1. Run the triager. `ORCH_HOME` is the orchestration repo (default `~/claude-code-orchestration`); `--repo` is the project the task is about:

   ```bash
   (cd "${ORCH_HOME:-$HOME/claude-code-orchestration}" && npm run --silent route -- --repo "$PWD_OF_TASK_REPO" --task "$ARGUMENTS")
   ```

   Substitute the current project's absolute path for `$PWD_OF_TASK_REPO`. It makes one cheap read-only model call and prints JSON: `mode`, `reason`, and the `facts` behind it. It also appends the decision to that project's `.claude/state/routes.jsonl`.

2. Tell the user the mode and the reason in one or two sentences, then act on it:
   - `plain`: do the task in this session. Run the project's tests before saying it is done.
   - `reviewed`: do the task here, then have an independent reviewer check `git diff HEAD` (the `reviewer` agent, if installed) before reporting.
   - `orchestrate`: do not implement here. Tell the user to run `claude --agent orchestrator`, or `npm run auto -- "<task>" <repo>` from the orchestration repo for a headless run.

3. If the user disagrees with the route, follow their choice. The thresholds are in `src/config.ts` (`TRIAGE`) in the orchestration repo.
