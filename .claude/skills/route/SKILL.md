---
name: route
description: Decide whether a non-trivial task (code, research, writing, analysis or operations) should run as a plain session, a plain session plus an independent reviewer, or the multi-agent orchestrator pipeline. Use before starting a non-trivial task, or when asked "should I orchestrate this".
argument-hint: <task description>
---
Size the task before doing it.

1. Get the route.
   - If `${ORCH_HOME:-$HOME/claude-code-orchestration}` contains both `package.json` and `node_modules`, run the triager. `--repo` is the folder the task is about (any folder; a git repository is not required); substitute its absolute path for `$TASK_DIR`:

     ```bash
     (cd "${ORCH_HOME:-$HOME/claude-code-orchestration}" && CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" npm run --silent route -- --repo "$TASK_DIR" --task "$ARGUMENTS")
     ```

     It makes one cheap read-only model call and prints JSON: `mode`, `reason`, and the `facts` behind it (`filesToTouch`, `linesToChange`, `independentSlices`, `risky` and `code`). It also appends the decision to `routes.jsonl` in that folder's state dir: `.claude/state/` when the project registers the orchestration hooks itself, otherwise the plugin's per-user dir, so nothing is written into the folder.
   - Otherwise (no checkout, e.g. a plugin-only install) size the task yourself. Skim the folder, then estimate five facts:
     - `code`: true when the task creates or changes source code, tests, build or CI configuration in a repository; false for research, writing, analysis, planning or operations whose output is documents, data, answers or commands run. It does not change the mode; it decides how step 2 runs it.
     - `filesToTouch`: files the task creates or changes, of any kind (source, docs, reports, data, config).
     - `linesToChange`: lines added or changed, prose and data included, new files included.
     - `independentSlices`: parts separate workers could do at the same time with no shared output file and no dependency (modules, documents, or research questions combined at the end); 1 when sequential or small.
     - `risky`: a wrong result is costly: security, authentication, payments, data migrations or deletion, public API changes, production operations (deploys, infrastructure, credentials), content sent or published outside the team, or several modules where a wrong change is costly.

     Apply these rules in order, the same as `TRIAGE` in `src/config.ts`:
     1. risky, fewer than 2 independent slices, at most 3 files and at most 200 lines: `reviewed`.
     2. risky otherwise: `orchestrate`.
     3. 12 or more files: `orchestrate`.
     4. 2 or more independent slices and (4 or more files, or 1500 or more lines): `orchestrate`. An interface-first plan lets those slices run in parallel even across few files.
     5. Otherwise `plain`. A large but sequential change stays plain: one session keeps a coupled design in one context.

     Thresholds: minParallelSlices 2, minParallelFiles 4, bigFiles 12, reviewedMaxFiles 3, bigLines 1500, reviewedMaxLines 200.

2. Tell the user the mode and the reason in one or two sentences, then act on it. Only code in a git repository uses git machinery (worktrees, the integrator, checkpoint commits, branch reports, `git diff` reviews). The test gate runs only where code is involved; the review gate applies to every task.
   - `plain`: do the task in this session. If it changed code, run the project's tests before saying it is done; otherwise check the result against the request (every requested item is there, and each claim is backed by a source you read).
   - `reviewed`: do the task here, then have `orchestration:reviewer` check the result before reporting: `git diff HEAD` for code in a git repository, otherwise the files or answer you produced, with the request and what a correct result must contain.
   - `orchestrate`: act as the orchestrator in this session. Plan at most 6 slices with disjoint output files, delegate with the Agent tool to `orchestration:researcher`, `orchestration:implementer` and `orchestration:reviewer`, and implement nothing yourself. Give each slice an acceptance check: a runnable command for code, otherwise a checklist a reviewer can verify by reading the output and its cited sources.
     - Code in a git repository: parallel slices use `isolation: worktree` and `orchestration:integrator` merges them. Before any parallel worktree wave, confirm `worktree.baseRef` is "head" in `.claude/settings.json`, `.claude/settings.local.json` or `~/.claude/settings.json` (worktrees otherwise branch from the remote default branch and miss local work); if it is not, run the slices one after another in the shared tree. If earlier shared-tree slices left uncommitted work, first send `orchestration:integrator` a brief starting with CHECKPOINT, a label and the files those slices own, and check the `CHECKPOINT:` field of its reply (a commit hash) before launching the wave; on fail or "none", run the wave sequentially instead.
     - Code outside a git repository: worktrees are impossible, and the test gate runs the whole suite on the shared tree each time an implementer finishes, so parallel siblings would fail each other's gate. Run the slices one after another in the shared folder; nobody commits.
     - Work that changes no code: slices run in the shared folder with no worktrees, no integrator and no commits. Slices with disjoint output files may run in parallel in one message without isolation; slices that depend on each other run one after another.
     - Every deliverable is reviewed. If you write the answer yourself from the researchers' findings, no implementer runs and the Stop gate never fires, so send the draft and its sources to `orchestration:reviewer` before replying (a second `orchestration:reviewer` with model "opus" when the answer is risky), and fix or flag what it reports.

     For an unattended run use `claude -p --agent orchestration:orchestrator`.

3. If the user disagrees with the route, follow their choice. The thresholds live in `src/config.ts` (`TRIAGE`) in the orchestration repo.
