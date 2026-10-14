---
name: route
description: Decide whether a coding task should run as a plain session, a plain session plus an independent reviewer, or the multi-agent orchestrator pipeline. Use before starting a non-trivial task, or when asked "should I orchestrate this".
argument-hint: <task description>
---
Size the task before doing it.

1. Get the route.
   - If `${ORCH_HOME:-$HOME/claude-code-orchestration}` contains both `package.json` and `node_modules`, run the triager. `--repo` is the project the task is about; substitute its absolute path for `$PWD_OF_TASK_REPO`:

     ```bash
     (cd "${ORCH_HOME:-$HOME/claude-code-orchestration}" && npm run --silent route -- --repo "$PWD_OF_TASK_REPO" --task "$ARGUMENTS")
     ```

     It makes one cheap read-only model call and prints JSON: `mode`, `reason`, and the `facts` behind it. It also appends the decision to that project's `.claude/state/routes.jsonl`.
   - Otherwise (no checkout, e.g. a plugin-only install) size the task yourself. Skim the repo, then estimate `filesToTouch`, `independentSlices` (parts buildable at the same time with no shared files and no dependency; 1 when sequential or small), `linesToChange` (lines added or changed, new files included) and `risky` (security, authentication, payments, data migrations, public API changes, or several modules where a wrong change is costly). Apply these rules in order, the same as `TRIAGE` in `src/config.ts`:
     1. risky, fewer than 2 independent slices, at most 3 files and at most 200 lines: `reviewed`.
     2. risky otherwise: `orchestrate`.
     3. 12 or more files: `orchestrate`.
     4. 2 or more independent slices and (4 or more files, or 1500 or more lines): `orchestrate`. An interface-first plan lets those slices run in parallel even across few files.
     5. Otherwise `plain`. A large but sequential change stays plain: one session keeps a coupled design in one context.

     Thresholds: minParallelSlices 2, minParallelFiles 4, bigFiles 12, reviewedMaxFiles 3, bigLines 1500, reviewedMaxLines 200.

2. Tell the user the mode and the reason in one or two sentences, then act on it:
   - `plain`: do the task in this session. Run the project's tests before saying it is done.
   - `reviewed`: do the task here, then have `orchestration:reviewer` check `git diff HEAD` before reporting.
   - `orchestrate`: act as the orchestrator in this session. Plan at most 6 slices with disjoint files, delegate with the Agent tool to `orchestration:researcher`, `orchestration:implementer` (`isolation: worktree` for parallel slices), `orchestration:integrator` and `orchestration:reviewer`, and implement nothing yourself. Before any parallel worktree wave, confirm `worktree.baseRef` is "head" in `.claude/settings.json`, `.claude/settings.local.json` or `~/.claude/settings.json` (worktrees otherwise branch from the remote default branch and miss local work); if it is not, run the slices one after another in the shared tree. If earlier shared-tree slices left uncommitted work, first send `orchestration:integrator` a brief starting with CHECKPOINT, a label and the files those slices own, and check the `CHECKPOINT:` field of its reply (a commit hash) before launching the wave; on fail or "none", run the wave sequentially instead. For an unattended run use `claude -p --agent orchestration:orchestrator`.

3. If the user disagrees with the route, follow their choice. The thresholds live in `src/config.ts` (`TRIAGE`) in the orchestration repo.
