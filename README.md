# Claude Code orchestrator

Deterministic TypeScript pipeline on the Claude Agent SDK. Architecture: `orchestration/orchestration.html`.

```
plan (strongest) → explore (cheap, parallel) → plan slices → write (own worktree, parallel)
  → test gate (no model) → verify (fresh context) → retry with feedback → merge passing slices
```

## Use

```bash
npm install
npm start -- --repo /path/to/git/repo --task "add rate limiting to the API" --test-cmd "npm test"
npm start -- --repo . --task "..." --plan-only     # plan only: cheapest way to try it
```

Flags: `--budget USD` (run cap, default 10), `--concurrency N` (3), `--retries N` (2), `--out DIR` (`runs`), `--setup-cmd CMD` (runs in each new worktree before the writer, e.g. `npm ci`; worktrees have no `node_modules`), `--keep-worktrees` (by default passing slices' and the result worktree are removed after the run; branches always stay, failed slices' worktrees are kept for debugging). Invalid numbers exit 2; a failed plan exits 1.

Output per run in `runs/<id>/`: `plan.json`, `findings.md`, `telemetry.jsonl` (cost, turns, model per worker), `report.json`, and `worktrees/`.
Results land on git branches `orch/<id>/<slice>` and `orch/<id>/result`. Nothing is pushed.

## Native Claude Code mode

Same roles as the pipeline, run inside an interactive session with no SDK code. Definitions are in `.claude/agents/`.

```bash
claude --agent orchestrator
```

| Agent | Model / effort | Tools |
|---|---|---|
| `orchestrator` | opus, high | `Agent(researcher, implementer, integrator, reviewer)`, Read, Grep, Glob |
| `researcher` | haiku, low | Read, Grep, Glob |
| `implementer` | sonnet, medium | default |
| `integrator` | sonnet, low | Read, Grep, Glob, Bash |
| `reviewer` | sonnet, medium | Read, Grep, Glob, Bash |

- The orchestrator has no Edit, Write or Bash, so it can only delegate. Its plan lives in the conversation and in worker briefs. Do not add `memory:` to it or the reviewer: that auto-enables Write and Edit.
- Do not set `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`; both override per-agent settings.
- Workers preload `.claude/skills/orchestration-conventions` (reply format, evidence rule, scope limits).

### Gates (hooks in `.claude/settings.json`)

| Hook | Script | Effect |
|---|---|---|
| `SubagentStop` (implementer) | `verify.sh` | Blocks finishing while `$ORCH_TEST_CMD` (default `npm test`) fails; runs in the agent's cwd |
| `Stop` | `review-gate.mjs` | Blocks the final reply if an implementer finished and no reviewer has since, or the last reviewer said `STATUS: fail`. Allows one forced retry (`stop_hook_active`). |
| `SubagentStart`, `SubagentStop` | `telemetry.mjs` | Appends events to `.claude/state/telemetry.jsonl` (gitignored) |

### Parallel slices

For independent slices the orchestrator launches implementers with `isolation: "worktree"`, each commits on its own branch, and the `integrator` merges the branches (`git merge --no-ff`, aborting on conflict) and runs the acceptance check. Conflicted slices are retried one at a time in the shared tree. Dependent slices run sequentially in the shared tree and nothing is committed.

### Headless, CI and unattended

```bash
ORCH_BUDGET_USD=3 npm run native -- "task description" /path/to/repo
```

Runs `claude -p --agent orchestrator` with `dontAsk`, a budget cap and an explicit tool allowlist (`ORCH_ALLOWED_TOOLS` replaces it). The target repo needs `.claude/` copied in, and `.claude/state/` and `.claude/worktrees/` in its `.gitignore`.

Two live runs ended the same way: both implementers wrote code but could not run `npm test` or commit, and the orchestrator correctly reported the slices as unverified instead of passed. What the evidence showed:

- Cause, confirmed by the third run: `orchestrate.sh` split the allowlist on whitespace, so `Bash(git status*)` became the broken tokens `Bash(git` and `status*)` and no `Bash(...)` rule with a space ever applied. The script now keeps one rule per array element (`ORCH_DRY_RUN=1` prints the exact arguments). Background implementers are fine: with the fix they ran in the background and `npm test` and `git commit` worked.
- The reviewers were refused `cd <worktree> && git status && ... && npm test`: Claude Code prompts for `cd` into another directory followed by `git` (git could run that directory's hooks), and `dontAsk` turns a prompt into a denial whatever the allow rules say. Agents are now told to use `git -C <dir>` and `npm --prefix <dir>`, and reviewers examine the integrated result in the project directory.
- The macOS `/var` vs `/private/var` symlink was a wrong first guess; the failure reproduced under `~/orch-test`.
- `ORCH_ALLOWED_TOOLS` takes one rule per line, for example `ORCH_ALLOWED_TOOLS=$'Read\nBash(npm test*)'`. For a session that keeps going until a condition holds, use `/goal` with your acceptance check.

### Project context and cost

- `CLAUDE.md` holds commands and rules every session needs. `.claude/rules/agents.md` loads only when you touch agent, hook, settings or workflow files.
- `researcher` and `integrator` set `omitClaudeMd: true`: they take everything from the brief, so they skip `CLAUDE.md`.
- Security-sensitive or cross-module slices get a second `reviewer` on `model: "opus"`; the slice passes only if both pass.
- `npm run native` logs cost, turns and subagent counts per headless run to `.claude/state/runs.jsonl`. `npm run report` renders it and the agent events as `.claude/state/report.html` (local file, nothing published).

### Scripted flow (workflow)

`.claude/workflows/orchestrate.js` fixes the order in code instead of the orchestrator's prompt: plan, explore (`researcher`), build (`implementer`, isolated when slices run in parallel), review (`reviewer`, plus an opus reviewer on risky slices), integrate (`integrator`). Ask Claude for it explicitly, for example "run the orchestrate workflow with task ...". Dependent slices run in the shared tree because worktrees branch from the default branch.

### Optional: TypeScript code intelligence

Gives Claude type errors after edits and symbol lookup. Not installed by this repo; it downloads software, so run it yourself:

```bash
npm install -g typescript-language-server typescript
```

then, inside `claude`: `/plugin install typescript-lsp@claude-plugins-official`.

### Verified in a live run (2026-10-13)

Task: two independent modules with tests, in a throwaway repo, headless. Result: researcher, two parallel implementers in worktrees, integrator, reviewers; both slices merged, `npm test` 11/11 on the merged tree, about $0.38 at list price.

Confirmed: hook payloads carry `session_id`, `agent_type`, `agent_id`, `cwd` and `hook_event_name`; `isolation: "worktree"` creates `worktree-agent-*` branches and commits merge cleanly; the `Agent(...)` allowlist holds; per-agent models route (haiku, sonnet, opus all billed); `runs.jsonl` and `report.html` work; an unverifiable slice is reported as failed, not passed.

The review gate has blocked in real sessions (`gates.jsonl`: `no_reviewer_after_last_implementer`, then `max_blocks_reached`).

Not yet exercised: the test gate actually blocking (it has only logged `tests_passed`), the opus second reviewer (needs a `risky` slice), `omitClaudeMd`, the scripted workflow.

Observed weakness: the orchestrator reviewed one branch before running the integrator, against its prompt, and that reviewer tried `cd /tmp && git -C ...`, which the cd-plus-git guard refused. It recovered with a second review of the merged tree. Order is advisory in the native session; the scripted workflow fixes it.

### Benchmark: orchestrator vs advisor vs plain session

`npm run compare` runs 3 tasks (parallel, single, dependent) under 3 setups in fresh repos and scores each with hidden tests the agent never sees (`npm run compare:validate` checks the tests against reference solutions, no model calls). Results land in `runs/compare/`.

First run (2026-10-13, one run per cell, costs at list price): all 9 runs passed 100% of hidden tests.

| Setup | Cost per task (t1 / t2 / t3) | Wall time (t1 / t2 / t3) |
|---|---|---|
| A: Opus orchestrator | $0.39 / $0.23 / $0.32 | 64s / 43s / 65s |
| B: Sonnet orchestrator + Opus advisor | $0.45 / $0.23 / $0.29 | 110s / 79s / 85s |
| C: Plain session (Sonnet) | $0.20 / $0.11 / $0.15 | 20s / 22s / 36s |

Reading it: these tasks were too easy to separate the setups on correctness, and the orchestrator roughly doubled cost and tripled time. The advisor billed Opus tokens in only one of three B runs, so it was consulted rarely. Use a plain session for small tasks; judging the orchestrator needs harder tasks and several runs per cell.

Second run, harder tasks (2026-10-13; a SQL query engine and a job-scheduler simulator, 13 hidden tests each, one run per cell, list-price cost): 7 of 8 runs passed 13/13.

| Task | C: plain session | A: Opus orchestrator | D: Sonnet orchestrator | B: Sonnet + Opus advisor |
|---|---|---|---|---|
| Query engine | $1.34, 508s, pass | $1.52, 308s, pass | $2.88, 805s, pass | $3.26, 875s, pass |
| Scheduler | $1.03, 397s, pass | $2.00, 250s, pass | $1.82, 519s, pass | $0.83, 1636s, FAIL |

Reading it: still no correctness separation, since the plain session also passed both. The Opus orchestrator was the fastest setup on both tasks (parallel slices), at 1.1x to 1.9x the plain session's cost. A Sonnet orchestrator launched more agents (5 implementers and 5 reviewers on the query engine) and cost about twice as much. The advisor setup added cost and time and had the only failure. That failure was the orchestrator ending its turn ("waiting for completion") while its one implementer was still running, with no root `index.js` (the task text then did not say where `index.js` lives; it does now). The orchestrator prompt now forbids ending a reply while workers run. B on the scheduler should be rerun before it is counted against the advisor.

### Keep in sync and share

- `npm run sync-agents` rewrites model, effort and `maxTurns` in the agent files from `src/config.ts`; `npm run check-agents` fails on drift.
- `npm run build-plugin` assembles `dist/plugin` (`claude plugin validate dist/plugin`, `claude --plugin-dir dist/plugin`). Plugin agents are namespaced, so the build rewrites the orchestrator's allowlist and the test-gate hook matcher to `orchestration:<name>`, and the hooks compare the bare role name. Verified in two live headless runs (2026-10-13): agents route, and both gates log (`tests_passed`, `reviewer_passed`). The first run exposed that the namespaced name silently disabled both gates; `hooks.test.ts` now covers plain and namespaced names. Project permission denies are not part of a plugin.

## Tune cost

Models, effort, turn caps, and per-worker budgets live in `src/config.ts`. Override models with
`ORCH_MODEL_PLANNER`, `ORCH_MODEL_EXPLORER`, `ORCH_MODEL_WRITER`, `ORCH_MODEL_VERIFIER`.
Check `telemetry.jsonl`, then move each role to the cheapest model that still passes verification.

## Test

`npm test` runs the control flow against a scripted fake model in temp git repos (no API calls).

## Limits

- Worktrees isolate git state, not the filesystem: a worker with Bash can still write outside its worktree. Run in a container or VM for untrusted repos.
- The deny lists (`UNSAFE_BASH` in `src/config.ts`, `permissions.deny` in `.claude/settings.json`; `policy.test.ts` keeps them equal) guard against mistakes, not malice. Native headless mode allows `Bash(npm *)` and `Bash(node *)`, which can run any code, including a push.
- Workers branch from `HEAD`; uncommitted changes are not visible to them.
- Slices that edit the same file conflict at merge time; conflicting branches are reported, not auto-resolved.
