# Native Claude Code mode

The same roles as the SDK pipeline, run inside a Claude Code session with no SDK code. The definitions live in `.claude/agents/`, the gates in `.claude/hooks/` and `.claude/settings.json`.

```bash
claude --agent orchestrator
```

## Agents

| Agent | Model / effort | Tools |
|---|---|---|
| `orchestrator` | opus, high | `Agent(researcher, implementer, integrator, reviewer)`, Read, Grep, Glob |
| `researcher` | haiku, low | Read, Grep, Glob, read-only `git` (`log`, `ls-files`, `rev-list`, `rev-parse`, `status`, `show`), `wc`, `ls`, `du` |
| `implementer` | sonnet, medium | default |
| `integrator` | sonnet, low | Read, Grep, Glob, Bash |
| `reviewer` | sonnet, medium | Read, Grep, Glob, Bash |

- The orchestrator has no Edit, Write or Bash, so it can only delegate. Its plan lives in the conversation and in worker briefs. Do not add `memory:` to it or the reviewer: that auto-enables Write and Edit.
- Do not set `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`; both override per-agent settings.
- Workers preload `.claude/skills/orchestration-conventions` (reply format, evidence rule, scope limits).
- `researcher` and `integrator` set `omitClaudeMd: true`: they take everything from the brief, so they skip `CLAUDE.md`.
- The researcher's `git` is limited to a read-only allowlist. Verified from its own transcript: `git log`, `git ls-files` and `date` run, `git tag` is refused. This was added after a 14-repo analysis where file-only researchers read `.git/logs/HEAD` (a reflog across all branches) and got dates, tracked-file claims and counts wrong.

## Light path and full path

The orchestrator sizes the task first. One slice, at most 3 files, nothing security-sensitive: the **light path** (one implementer in the shared tree, then one reviewer; no exploration, worktrees or integrator). Otherwise the **full path**. The numbers mirror `TRIAGE` in `src/config.ts`; for work that small a plain session is cheaper still, which is what `npm run auto` and the `/route` skill decide before the orchestrator starts.

## Gates

```mermaid
sequenceDiagram
    participant O as Orchestrator
    participant I as Implementer
    participant V as verify.sh (SubagentStop)
    participant R as Reviewer
    participant G as review-gate.mjs (Stop)
    O->>I: brief: goal, files, acceptance check
    I-->>V: tries to finish
    alt tests fail
        V-->>I: exit 2, test output (blocked)
        I->>I: fix and retry
    else tests pass
        V-->>O: allowed
    end
    O->>R: review the slice, fresh context
    R-->>O: STATUS pass or fail, gaps
    O->>G: final reply
    alt no reviewer passed after the last implementer
        G-->>O: exit 2 (blocked, one forced retry)
    else reviewer passed
        G-->>O: allowed
    end
```

| Hook | Script | Effect |
|---|---|---|
| `SubagentStop` (implementer) | `verify.sh` | Blocks finishing while `$ORCH_TEST_CMD` (default `npm test`) fails; runs in the agent's cwd. At most 2 blocks per agent, then it lets the agent finish. |
| `Stop` | `review-gate.mjs` | Blocks the final reply if an implementer finished and no reviewer has since, or the last reviewer said `STATUS: fail`. Allows one forced retry (`stop_hook_active`). |
| `SubagentStart`, `SubagentStop` | `telemetry.mjs` | Appends events to `.claude/state/telemetry.jsonl` (gitignored). |
| `SessionStart` (plugin only) | `nudge.mjs` | Tells the main session to run `orchestration:route` before a non-trivial coding task. Silent when `ORCH_NO_NUDGE` is set. |

Every gate decision is appended to `.claude/state/gates.jsonl`, so a run can show whether a gate fired. Hooks exit 2 to block; any other non-zero code only warns, and hooks exit 0 on malformed input.

## Parallel slices

For independent slices the orchestrator launches implementers with `isolation: "worktree"`; each commits on its own branch, and the `integrator` merges the branches (`git merge --no-ff`, aborting on conflict) and runs the acceptance check. Conflicted slices are retried one at a time in the shared tree. Dependent slices run sequentially in the shared tree and nothing is committed. Security-sensitive or cross-module slices get a second `reviewer` on `model: "opus"`; the slice passes only if both pass.

## Headless, CI and unattended

```bash
npm run native -- "task description" /path/to/repo     # always the orchestrator
npm run auto   -- "task description" /path/to/repo     # triage first: plain, reviewed or orchestrator
```

`native` runs `claude -p --agent orchestrator` with `dontAsk`, an optional budget cap (`ORCH_BUDGET_USD`, off by default) and an explicit tool allowlist (`ORCH_ALLOWED_TOOLS` replaces it; one permission rule per line, for example `ORCH_ALLOWED_TOOLS=$'Read\nBash(npm test*)'`). The target repo needs `.claude/` copied in, and `.claude/state/` and `.claude/worktrees/` in its `.gitignore`. `ORCH_DRY_RUN=1` prints the exact `claude` arguments. Cost, turns and subagent counts per run are logged to `.claude/state/runs.jsonl`; `npm run report` renders them and the agent events as `.claude/state/report.html` (a local file, nothing is published). For a session that keeps going until a condition holds, use `/goal` with your acceptance check.

### What the first headless runs taught

Two live runs ended the same way: both implementers wrote code but could not run `npm test` or commit, and the orchestrator correctly reported the slices as unverified instead of passed.

- **The allowlist bug.** `orchestrate.sh` split the allowlist on whitespace, so `Bash(git status*)` became the broken tokens `Bash(git` and `status*)` and no `Bash(...)` rule with a space ever applied. The script now keeps one rule per array element. With the fix, background implementers ran `npm test` and `git commit` fine.
- **`cd` plus `git` is refused.** Claude Code prompts for `cd` into another directory followed by `git` (git could run that directory's hooks), and `dontAsk` turns a prompt into a denial whatever the allow rules say. Agents are now told to use `git -C <dir>` and `npm --prefix <dir>`, and reviewers examine the integrated result in the project directory.
- The macOS `/var` vs `/private/var` symlink was a wrong first guess; the failure reproduced under `~/orch-test`.

## Scripted flow (workflow)

`.claude/workflows/orchestrate.js` fixes the order in code instead of the orchestrator's prompt: plan, explore (`researcher`), build (`implementer`, isolated when slices run in parallel), review (`reviewer`, plus an opus reviewer on risky slices), integrate (`integrator`). Ask Claude for it explicitly, for example "run the orchestrate workflow with task ...". Dependent slices run in the shared tree because worktrees branch from the default branch. Order is advisory in the native session (the orchestrator once reviewed a branch before running the integrator, against its prompt); the workflow removes that freedom.

## Verified in a live run (2026-10-13)

Task: two independent modules with tests, in a throwaway repo, headless. Researcher, two parallel implementers in worktrees, integrator and reviewers ran; both slices merged, `npm test` 11/11 on the merged tree, about $0.38 at list price.

Confirmed: hook payloads carry `session_id`, `agent_type`, `agent_id`, `cwd` and `hook_event_name`; `isolation: "worktree"` creates `worktree-agent-*` branches and commits merge cleanly; the `Agent(...)` allowlist holds; per-agent models route (haiku, sonnet and opus all billed); an unverifiable slice is reported as failed, not passed. The review gate has blocked in real sessions (`gates.jsonl`: `no_reviewer_after_last_implementer`, then `max_blocks_reached`).

## Project context

`CLAUDE.md` holds commands and rules every session needs. `.claude/rules/agents.md` loads only when you touch agent, hook, settings or workflow files.

## Optional: TypeScript code intelligence

Gives Claude type errors after edits and symbol lookup. Not installed by this repo; it downloads software, so run it yourself:

```bash
npm install -g typescript-language-server typescript
```

then, inside `claude`: `/plugin install typescript-lsp@claude-plugins-official`.

## Plugin build

`npm run build-plugin` assembles `dist/plugin` (`claude plugin validate dist/plugin`, `claude --plugin-dir dist/plugin`). Plugin agents are namespaced, so the build rewrites the orchestrator's allowlist and the test-gate hook matcher to `orchestration:<name>`, and the hooks compare the bare role name. The first live plugin run exposed that the namespaced name silently disabled both gates; `hooks.test.ts` now covers plain and namespaced names. Plugin builds do not carry `hooks`, `permissionMode` or `mcpServers` from agent frontmatter, and project permission denies are not part of a plugin.

`npm run sync-agents` rewrites model, effort and `maxTurns` in the agent files from `src/config.ts`; `npm run check-agents` fails on drift.
