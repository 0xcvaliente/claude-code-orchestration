# SDK pipeline

The [SDK pipeline](glossary.md#s) is the TypeScript orchestrator in `src/`, built on the Claude Agent SDK. This page lists its commands, flags, environment variables and outputs, and its Bash judge in short. It is for maintainers. The SDK pipeline is frozen: it gets maintenance only, no new features.

For any task other than code in a git repository, use the native orchestrator instead ([How the native orchestrator works](native-mode.md)).

## What it is

- It takes code in a git repository only. Its order is fixed in code.
- It leaves its result on the branch `orch/<id>/result`. It does not touch your checkout, and it never pushes on its own.
- It runs on Agent SDK 0.3.325 (`package.json`). The Bash judge's hook is registered with `onFailure: "block"` ([Bash judge](#bash-judge)).
- None of the native [gates](gates.md) run here. Its own checks are the `--test-cmd` command and a verifier per slice.

**The routes.** `--mode auto` (the default) asks the triager first and picks one of three routes, like the native [triage](../README.md#choosing-a-route-triage):

| Route | `--mode` | What runs |
|---|---|---|
| Plain | `plain` | One `solo` session in your checkout, then `--test-cmd` when given. Its changes stay uncommitted in the working tree. |
| Reviewed | `reviewed` | A `solo` session, then a verifier; a failed review starts another round, up to `--retries` more. |
| Orchestrate | `orchestrate` | The steps below, in worktrees, merged into `orch/<id>/result`. |

When a triaged plain or reviewed run fails, the task runs again on the orchestrate route ([escalation](glossary.md#e)). The failed run's edits stay uncommitted in the working tree; nothing reverts them. The new run works from HEAD in worktrees, so it does not see them. `--no-escalate` turns this off, and a route you force with `--mode` never escalates.

**The orchestrate route, step by step** (`src/orchestrator.ts`):

1. The planner lists up to 4 questions about the repository.
2. Explorers answer them, read-only and in parallel. The answers go to `findings.md`.
3. The planner splits the task into at most 6 slices with disjoint files (`plan.json`). A slice that needs another slice's output names it in `dependsOn` and starts from a worktree that has it.
4. Each slice runs in its own worktree on the branch `orch/<id>/<slice>`: a writer builds it, the harness runs `--test-cmd`, a verifier checks it, and a failed check retries with feedback, up to `--retries` times.
5. With `--replans N`, slices that failed are planned again, only the missing work.
6. Passing slices are merged into `orch/<id>/result`.

**Roles** (`rolesFor` in `src/config.ts`; each model can be changed, [Environment](#environment)):

| Role | Default model | Effort | maxTurns | Tools |
|---|---|---|---|---|
| `triager` | `claude-sonnet-5-5` | low | 12 | Read, Glob, Grep |
| `planner` | `claude-fable-5-2` | high | 20 | Read, Glob, Grep |
| `explorer` | `claude-sonnet-5-5` | low | 15 | Read, Glob, Grep |
| `writer` | `claude-opus-5-5` | medium | 80 | Read, Glob, Grep, Edit, Write, Bash |
| `verifier` | `claude-sonnet-5-5` | medium | 40 | Read, Glob, Grep, Bash |
| `solo` | `claude-opus-5-5` | medium | 60 | Read, Glob, Grep, Edit, Write, Bash |

**Behaviour you can rely on:**

- Service errors (rate limit, overload, 5xx, a dropped stream) are retried up to twice, with backoff.
- A worker is stopped after 15 minutes.
- A worker that crashes, times out or ends with no result is charged the tokens it streamed before it ended, so `--budget` sees them.
- A failing commit hook (husky, lefthook, pre-commit) is shown to the writer as feedback and retried within `--retries`. When the retries are used up, the slice fails with the hook's message as its issue and the real attempt count. Hooks still run: the SDK pipeline never passes `--no-verify`.
- When `git merge --abort` fails, it refreshes the index with `git status`, aborts again, then runs `git reset --merge`. It stops with an error if a merge is still in progress.
- SDK workers run with an empty `agent` setting, so a repository whose settings name a default agent does not change them, and with Claude Code's auto memory off.

## Run it

Needs `npm install` and a logged-in `claude`.

```bash
# run a task; --test-cmd is the acceptance command the harness runs after each worker
npm start -- --repo /path/to/git/repo --task "add rate limiting to the API" --test-cmd "npm test"

# plan only, then stop: the cheapest way to try it
npm start -- --repo . --task "..." --plan-only

# skip triage and force a route
npm start -- --repo . --task "..." --mode plain

# continue a run; pass --task again, or the Bash judge refuses pushes and recursive deletes
npm start -- --repo . --resume <id> --task "<the original request>"

# triage only: prints the decision as JSON
npm run route -- --repo /path/to/folder --task "..."
```

A task that starts with a dash goes as `--task=<task>`.

Exit codes:

- 0: the run passed.
- 1: a slice failed, a merge conflicted, the plan failed, or the plain or reviewed session failed.
- 2: a bad flag, an invalid number, an unknown `--mode`, or a `--repo` that is not a git repository. A bad flag also prints the usage message.

`npm start` warns when the repository has uncommitted changes: workers branch from HEAD and will not see them.

## Flags

`npm start -- <flags>` (`src/cli.ts`):

| Flag | Meaning |
|---|---|
| `--repo DIR` | The git repository. Required. |
| `--task TEXT` | What to do. Required unless `--resume` is given. Without it on a resume, the Bash judge refuses pushes and recursive deletes ([Resume](bash-judge.md#8-resume)): pass it again. |
| `--mode auto\|plain\|reviewed\|orchestrate` | The route. `auto` (default) lets triage decide; anything else skips triage. |
| `--no-escalate` | Do not rerun a failed plain or reviewed run on the orchestrate route. |
| `--test-cmd CMD` | The acceptance command, run by the harness after each worker. |
| `--setup-cmd CMD` | Runs in each new worktree before its writer, for example `npm ci`. |
| `--budget TOKENS` | Optional run cap in tokens: `500000`, `500k`, `1.5M` or `2M`, at least 10k. Unset means no cap. See below. |
| `--concurrency N` | Parallel workers, at least 1 (default 3). |
| `--retries N` | Retries per slice, at least 0 (default 2). On the reviewed route, extra review rounds. |
| `--replans N` | Replanning rounds after failures (default 0). A number above 3 counts as 3. |
| `--plan-only` | Stop after planning (implies the orchestrate route). |
| `--resume ID` | Continue a run from its `journal.json` (implies the orchestrate route). |
| `--keep-worktrees` | Keep every worktree. By default the worktrees of passing slices and the result worktree are removed; failed worktrees and all branches stay. |
| `--out DIR` | Where runs are written (default `runs`). |

**How `--budget` works:**

- Orchestrate route: the cap is checked before each slice attempt and before each replan. Once it is spent, no new attempt or replan starts. Triage tokens, and on escalation the failed session's tokens, count against the cap.
- Reviewed route: the cap is checked before each round. Once it is spent no further round starts, but a session already running is not cut short. Triage tokens do not count toward that check.
- Plain route: a single session, so the cap never stops it.
- The Bash judge's own tokens are not counted ([Cost and behaviour](bash-judge.md#10-cost-and-behaviour)).

## Environment

The SDK pipeline reads these variables. The native ones are in [Settings, Environment variables](settings.md#environment-variables).

| Variable | Default | Meaning |
|---|---|---|
| `ORCH_MODEL_PLANNER`, `ORCH_MODEL_EXPLORER`, `ORCH_MODEL_WRITER`, `ORCH_MODEL_VERIFIER`, `ORCH_MODEL_TRIAGER`, `ORCH_MODEL_SOLO` | see [Roles](#what-it-is) | Override one role's model. Any model is accepted. |
| `ORCH_JUDGE` | on | `off`, `0` or `false` turns the Bash judge off: pushes, remote changes, `sudo` and the `rm -rf` spellings are then denied by rule (`UNSAFE_BASH`). |
| `ORCH_MODEL_JUDGE` | `claude-opus-5-5` | The Bash judge's model. |
| `ORCH_JUDGE_AUDIT` | none | The audit file when the run does not set one. A normal run writes `runs/<id>/judge-audit.jsonl`. |
| `ORCH_SANDBOX` | off | `on` runs the Bash roles in the SDK's OS sandbox. Opt-in; smoke-tested on macOS only. |
| `ORCH_SANDBOX_DOMAINS` | empty | Comma-separated network domains the sandbox allows (wildcards such as `*.example.com` pass through). |

Details of the judge's variables: [The Bash judge, Configuration](bash-judge.md#6-configuration). Details of the sandbox: [The Bash judge, The OS sandbox](bash-judge.md#9-the-os-sandbox-opt-in).

## What a run writes

Under `runs/<id>/` (or `--out`):

| File | What it holds |
|---|---|
| `plan.json` | The planner's questions and slices; rewritten after a replan. |
| `findings.md` | The explorers' answers. |
| `journal.json` | The run's state after each slice, for `--resume`. |
| `judge-audit.jsonl` | One line per Bash judge decision ([The audit log](bash-judge.md#7-the-audit-log)). |
| `telemetry.jsonl` | One line per worker call: role, tokens, turns, model, and the first 200 characters of its result text. |
| `report.json` | The run's result: each slice's status, attempts and issues, the merged and conflicted branches, the result branch, and tokens spent in total and by role. |
| `worktrees/<slice>` | Each slice's worktree (removed for passing slices unless `--keep-worktrees`). |

Also:

- `runs/routes.jsonl`: one line per route decision of `--mode auto`, including escalations.
- Branches `orch/<id>/<slice>` per slice and `orch/<id>/result` for the merge. Branches are never removed.
- `runs/` is git-ignored, so none of this reaches a commit.

At the end `npm start` prints the run id, tokens by role, one line per slice with its status and attempts, and the result branch. A failed run also prints the `--resume` command.

## Bash judge

The SDK workers with Bash (`solo`, `writer`, `verifier`) run every command through the Bash judge in `src/judge.ts`:

- The `deny` class (the floor: `sudo` and similar, catastrophic or non-plain recursive `rm`, commands the tokenizer cannot read) is refused at once, with no model call.
- The `judge` class (`git push`, `git remote`, one plain `rm -r[f] <paths>`) goes to an opus model. The user's original `--task` is the only authority. So a resume without `--task` refuses them.
- Everything else passes.
- It fails closed: every failure is a deny.

**The working folder.** The worker's worktree is the root. Relative targets and the git and file facts resolve against the shell's current folder inside it, which follows a `cd`. A judged command while the shell is outside the root is denied without asking.

Everything else, including the full rules ([section 2.1](bash-judge.md#21-deny-rules)), the prompt, the audit log and the limits, is in [The Bash judge](bash-judge.md).

## Limits

- Code in a git repository only.
- None of the native gates, guards or hooks: no plan check, no review gate, no test gate.
- The Bash judge is best-effort, not a sandbox ([The Bash judge, Limits](bash-judge.md#11-limits)).
- The sandbox is opt-in and was smoke-tested on macOS only.
- Worktrees isolate git state, not the file system ([Safety, Worktrees](safety.md#worktrees)).
