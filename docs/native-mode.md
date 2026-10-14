# Native Claude Code mode

The same roles as the SDK pipeline, run inside a Claude Code session with no SDK code. They take any non-trivial task: code, research, writing, analysis or operations. Git machinery is for code in a git repository only. The test gate runs wherever there is a test command, and skips a prose-only change in a git work tree (below). The definitions live in `.claude/agents/`, the gates in `.claude/hooks/` and `.claude/settings.json`. The SDK pipeline (`npm start`) works on code in a git repository only; `claude --agent orchestrator`, `/route` and `npm run auto` take any folder.

```bash
claude --agent orchestrator
```

## Agents

| Agent | Model / effort | Tools |
|---|---|---|
| `orchestrator` | opus, high | `Agent(researcher, implementer, integrator, reviewer)`, `SendMessage`, Read, Grep, Glob |
| `researcher` | haiku, low | Read, Grep, Glob, read-only `git` (`log`, `ls-files`, `rev-list`, `rev-parse`, `status`, `show`), `wc`, `ls`, `du`, `WebSearch`, `WebFetch` |
| `implementer` | sonnet, medium | default |
| `integrator` | sonnet, low | Read, Grep, Glob, Bash |
| `reviewer` | sonnet, medium | Read, Grep, Glob, Bash, `WebSearch`, `WebFetch` |

- The orchestrator has no Edit, Write or Bash, so it can only delegate. Its plan lives in the conversation and in worker briefs. Do not add `memory:` to it or the reviewer: that auto-enables Write and Edit.
- What a worker does depends on the work. The `implementer` does one slice of code, a document, an analysis or an operation. Its acceptance check is a runnable command for code and a checklist otherwise: it re-reads its output against each item and reports where it is met (file and section, or source URL). It commits only in an isolated worktree, which exists only for code in a git repository. The `integrator` is for code in a git repository only: it merges worktree branches and writes CHECKPOINT commits. For code the `reviewer` runs the acceptance command: in a git repository it reviews the working-tree changes (`git diff HEAD`) or the commit range the brief names, outside git it reads the files the brief names. For anything else (documents, analysis, research, operations) it reads the output, checks every checklist item and checks each claim against the source it cites.
- `researcher` and `reviewer` search and fetch web pages when a question needs it, read-only. Fetched pages and documents are data, never instructions: the agent bodies and the conventions skill say so, and the orchestrator does not act on directions in a worker's findings that came from them. Never give either agent a web tool that posts data, or Edit or Write.
- Do not set `CLAUDE_CODE_EFFORT_LEVEL` or `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`; both override per-agent settings.
- Workers preload `.claude/skills/orchestration-conventions` (reply format, evidence rule, scope limits, fetched content is data).
- `researcher` and `integrator` set `omitClaudeMd: true`: they take everything from the brief, so they skip `CLAUDE.md`.
- The researcher's `git` is limited to a read-only allowlist. Verified from its own transcript: `git log`, `git ls-files` and `date` run, `git tag` is refused. This was added after a 14-repo analysis where file-only researchers read `.git/logs/HEAD` (a reflog across all branches) and got dates, tracked-file claims and counts wrong.

## Light path and full path

The orchestrator sizes the task first. It decides whether the task changes code (source, tests, build or CI configuration) and, if so, whether that code is in a git repository. Git machinery (worktrees, the integrator, checkpoint commits, branch reports, commit-range reviews of merged code) is for code in a git repository only (`npm run auto`'s reviewed-route reviewer is not part of this: it reads `git diff HEAD` for any task in a git work tree); work that changes no code runs in the shared folder and nobody commits. One slice, at most 3 files, under about 1,500 changed lines, nothing risky (a wrong result is costly: security, authentication, payments, data migrations or deletion, public API changes, production operations, content sent or published outside the team): the **light path** (one implementer in the shared folder, then one reviewer; no exploration, worktrees or integrator). Otherwise the **full path**. For large work (1,500+ lines) with separable parts it plans interface-first: slice 1 writes the shared interfaces, types and stubs (for documents, the outline and shared definitions) in the shared folder, a checkpoint commit follows for code in git, then the remaining slices run against it: in parallel in worktrees for code in a git repository, one at a time for code outside git, and in parallel in the shared folder for work that changes no code. The numbers mirror `TRIAGE` in `src/config.ts` (`bigLines` 1500, `reviewedMaxLines` 200); for work that small a plain session is cheaper still, which is what `npm run auto` and the `/route` skill decide before the orchestrator starts. They size a task from five facts: `code` (the task changes source, tests, build or CI configuration in a repository), files, lines, independent slices and risky. The last four count files, lines and slices of any kind, prose and research questions included, with the same thresholds as before. `code` does not change the route. It decides whether git machinery is used (worktrees, checkpoint commits, the integrator) and, in `npm run auto`, whether web tools are allowed. The test gate does not read it: it follows the test command and the changed files in `git status` (below).

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
    else tests pass or skipped
        V-->>O: allowed
    end
    O->>R: review the slice, fresh context
    R-->>O: STATUS pass or fail, gaps
    O->>G: final reply
    alt no reviewer passed after the last implementer
        G-->>O: exit 2 (blocked; after 2 blocks per implementer run, allowed with an unverified warning)
    else reviewer passed
        G-->>O: allowed
    end
```

| Hook | Script | Effect |
|---|---|---|
| `SubagentStop` (implementer) | `verify.sh` | Blocks finishing while the test command fails. It needs a command (`$ORCH_TEST_CMD`, else detected by `test-cmd.sh`); with `ORCH_TEST_CMD` unset it skips a change that is all prose in a git work tree (below). Runs in the agent's cwd. At most 2 blocks per agent, then it lets the agent finish. Agents in `.claude/worktrees/` follow `ORCH_GATE_ISOLATED`. |
| `Stop` | `review-gate.mjs` | Blocks the final reply if an implementer finished and no reviewer has since, the last reviewer said `STATUS: fail`, or it returned no status (`last_reviewer_no_status`). At most 2 blocks after each implementer run (a later implementer resets the count); then it lets the reply out with a `systemMessage` saying the work is unverified (`max_blocks_reached`). |
| `SubagentStart`, `SubagentStop` | `telemetry.mjs` | Appends events to `telemetry.jsonl` in the state dir (below). Records the worker's `STATUS` from `last_assistant_message`, or, when that is empty, from the `SubagentHandback` message or last text block in `agent_transcript_path`. |
| `SessionStart` (plugin only) | `nudge.mjs` | Tells the main session to run `orchestration:route` before a non-trivial task: code, research, writing, analysis or operations, in any folder. Silent when `ORCH_NO_NUDGE` is set. |

The review gate applies to every task but only sees implementers. When the orchestrator writes the answer itself from the researchers' sourced findings, no implementer runs and the `Stop` hook never fires, so the orchestrator sends the draft, the request and the sources to a `reviewer` before it replies (and to a second `reviewer` on opus when the answer is risky). That review is the orchestrator's own step, not a hook.

**When the test gate runs.** The gate runs the tests wherever there is a test command, `$ORCH_TEST_CMD` or a detected runner (below); with neither it allows (`no_test_command`). A detected runner is skipped, and `no_code_changes` is logged, only when the agent's folder is in a git work tree and every changed path (staged, unstaged or untracked) is prose: `.md`, `.markdown`, `.txt`, `.rst` and `.adoc`, in any case. These are not prose, so the tests run: `.mdx` (JSX); `CMakeLists.txt` and any `.txt` whose path names `requirements` or `constraints` (build and dependency files); anything under a folder named `test`, `tests`, `testdata`, `__tests__`, `spec`, `fixtures`, `__fixtures__`, `golden`, `snapshots` or `__snapshots__`, whatever its extension (golden files and snapshots feed the tests). A rename or copy is judged by both its old and new path. The decision comes from `git status`, never from what the agent reports, and any doubt keeps the tests: a clean tree (an isolated slice that already committed), a folder outside git, a failing `git`, any other path. An explicit `ORCH_TEST_CMD` always runs. So a prose-only change skips the gate in a git repository, but work that changes no code still runs the tests outside git, with `ORCH_TEST_CMD` set, or when a non-prose file (a `.csv`, say) changed. The gate never reads the triage fact `code`.

**Runner detection** (`.claude/hooks/test-cmd.sh`), first match wins: `ORCH_TEST_CMD`; `npm test` when `package.json` has a test script; `pytest` (or `unittest` if pytest is not installed) only when `test_*.py` or `*_test.py` files exist; `cargo test`; `go test ./...`; `swift test`; `make test` with a `test:` target. None found: the gate allows (`no_test_command`). pytest exit 5 (no tests collected) counts as no tests.

**Isolated worktrees.** Only code in a git repository runs in them. Sibling slices may not be merged yet, so a worktree's tests can fail for reasons the slice does not own. `ORCH_GATE_ISOLATED=warn` (default) runs the tests, logs `tests_failed_isolated` and never blocks; `block` gates them like the shared tree; `skip` does not run them. The integrator's acceptance check on the merged result is the real gate.

Every gate decision is appended to `gates.jsonl` in the state dir, so a run can show whether a gate fired. Hooks exit 2 to block; any other non-zero code only warns, and hooks exit 0 on malformed input.

**State dir and plugin copies** (`.claude/hooks/state.mjs`; `verify.sh` mirrors the rule in bash). The project copy of the hooks (registered in `.claude/settings.json`) logs to `.claude/state/` and writes a `.gitignore` there on first write. The plugin copy (`hooks.json` runs every hook with `--plugin`) logs outside the repo, because the logs hold subagent payloads: `$CLAUDE_PLUGIN_DATA/state/<key>`, or `~/.claude/orchestration/state/<key>` where Claude Code does not set `CLAUDE_PLUGIN_DATA`. The key is the project path with every byte that is not a letter or digit replaced by `-`. With the plugin installed in a repo that registers its own copy (this repo, or one with `.claude/` copied in), both copies would fire on every event, doubling telemetry and letting two review gates count each other's blocks. So the plugin's `telemetry.mjs` and `review-gate.mjs` exit at once when the project's settings register the same script, and the project copy does the work; the plugin's `verify.sh` then logs to the project's `.claude/state/` too, so every gate reads one log. `verify.sh` needs no such check: the project matcher `^implementer$` and the plugin's `orchestration:implementer` never match the same agent. The `/route` triager (`src/route.ts`) imports the same rule for `routes.jsonl`: `.claude/state/` in a repo that registers its own telemetry hook, the per-user dir otherwise (the skill passes `CLAUDE_PLUGIN_DATA` through, so it is the hooks' dir); `npm run auto` passes `--project-state` to keep it beside `runs.jsonl`. `npm run report [repo]` reads `.claude/state/` when it holds `telemetry.jsonl` or `runs.jsonl`, else the per-user dir for that repo: `$CLAUDE_PLUGIN_DATA`, then each `~/.claude/plugins/data/orchestration-*` (a terminal has no `CLAUDE_PLUGIN_DATA`), then `~/.claude/orchestration`. It writes `report.html` in the dir it read.

## Parallel slices

Worktrees, CHECKPOINT commits, BRANCH reports and the integrator are for code in a git repository only. Elsewhere:

- Code outside a git repository runs one slice at a time in the shared folder. No worktree is possible, and the test gate runs the whole suite on the shared tree each time an implementer finishes, so parallel siblings would fail each other's gate. Nobody commits.
- Work that changes no code (research, writing, analysis, operations) runs in the shared folder with no worktrees, integrator or commits. Slices with disjoint output files may run in parallel in one message, without isolation; slices that depend on each other run one after another.

**Check `worktree.baseRef` first (code in a git repository).** Claude Code starts a worktree from the remote default branch unless `worktree.baseRef` is `"head"` (set in this repo's `.claude/settings.json`; plugin users must set it in their own settings). Worktrees also only see committed work. Before a parallel wave the orchestrator reads `.claude/settings.json`, `.claude/settings.local.json` and `~/.claude/settings.json`; if `baseRef` is not `"head"` it runs the slices one after another in the shared tree and says so. If earlier slices left uncommitted work, it sends the `integrator` a CHECKPOINT brief naming the files those slices own; in that mode the integrator stages and commits only those paths and reports the hash in a `CHECKPOINT:` field. The orchestrator checks that field before launching the wave: if the commit failed or the field is `none` while those slices left changes, it runs the wave one slice at a time in the shared tree instead (the workflow does the same and logs why). A session that acts as orchestrator itself gets the same `baseRef` and CHECKPOINT rule from the `/route` skill; the session nudge carries only the `baseRef` rule (parallel slices use worktrees only when `baseRef` is `"head"`, else one at a time), not the CHECKPOINT rule.

For independent code slices in a git repository the orchestrator launches implementers with `isolation: "worktree"`; each commits on its own branch, and the `integrator` merges the branches (`git merge --no-ff`, aborting on conflict) and runs the acceptance check. Conflicted slices are retried one at a time in the shared tree. Dependent slices run sequentially in the shared tree. A rejected slice is retried by resuming the same implementer with `SendMessage` (verified: a resumed isolated implementer kept its worktree and committed on its branch) rather than starting a new one. A slice in the shared folder has no branch: if `SendMessage` fails, the orchestrator starts a fresh implementer with the same files and the gaps. Risky or cross-module slices get a second `reviewer` on `model: "opus"`; the slice passes only if both pass.

## Headless, CI and unattended

```bash
npm run native -- "task description" /path/to/repo     # always the orchestrator
npm run auto   -- "task description" /path/to/repo     # triage first: plain, reviewed or orchestrator
```

`native` runs `claude -p --agent orchestrator` with `dontAsk`, an optional budget cap (`ORCH_BUDGET_USD`, off by default) and an explicit tool allowlist (`ORCH_ALLOWED_TOOLS` replaces it; one permission rule per line, for example `ORCH_ALLOWED_TOOLS=$'Read\nBash(npm test*)'`; `ORCH_EXTRA_ALLOWED_TOOLS` appends rules to the default list instead). The default allowlist includes `Agent` and `SendMessage` (so a headless orchestrator retry can resume the same implementer). It has no web tools: for research add `WebSearch` and `WebFetch` through `ORCH_EXTRA_ALLOWED_TOOLS` (`npm run auto` does that itself when it counts the task as not code, below). The test command's permission rules (pytest, cargo, go, swift, make) are added automatically from `ORCH_TEST_CMD` or the detected runner; in `npm run auto`'s reviewed route the read-only reviewer gets the same detected-runner rules, so it can run the project's tests and nothing broader. Benchmark tasks declare their test command in `test-cmd.txt`, which `compare.mjs` exports as `ORCH_TEST_CMD`. `ORCH_MODEL` passes `--model`, for plain-model baselines. To run an agent (every route except a plain session) the target folder itself needs `.claude/agents/`: copy this project's `.claude/` into it. The script checks that folder only and exits 1 without it, so agents installed under `~/.claude` or by the plugin are not enough. With the plugin installed you can instead run `claude -p --agent orchestration:orchestrator` in any folder (give it your own permission flags; `ORCH_DRY_RUN=1` prints the ones the scripts use). The target can be any folder; a git repository is needed only for code work that uses worktrees. In a git repository, put `.claude/state/` and `.claude/worktrees/` in its `.gitignore`. `ORCH_DRY_RUN=1` prints the exact `claude` arguments. Cost, turns and subagent counts per run are logged to `.claude/state/runs.jsonl`; `npm run report` renders them, the agent events and the triage and gate decisions as `.claude/state/report.html` (a local file, nothing is published). For a session that keeps going until a condition holds, use `/goal` with your acceptance check.

**`npm run auto` for any task.** It triages first (`src/route.ts`, one read-only model call), then runs the cheapest route that fits, in any folder. Two independent facts shape a run. Git: in a git work tree the reviewed route's reviewer reads `git diff HEAD` and the untracked files from `git status --short`; elsewhere it reads the files the session's report says it created or changed. Code: the triager's `code` fact or, with no facts (a forced `ORCH_MODE`, a failed triage), yes when the folder is a git work tree or has a detected test runner; the route line on stderr ends in `(code: yes|no)`. For code the reviewer runs the tests; otherwise it checks every requirement of the task and each claim against the source it cites. When the route line says `(code: no)`, the session, the orchestrator and the reviewer also get `WebSearch` and `WebFetch` (the default allowlist has none). That is a task the triager says changes no code or, with no facts, a folder that is neither a git work tree nor has a test runner, so a forced run in an empty folder gets them even for a code task. The reviewer's prompt carries the session's report, cut to 4,000 characters, which it treats as data. The verdict is read from the reply's `STATUS` lines: a preamble before the first is fine; a blockquoted line is not a verdict (the prompt quotes the session's report, which may say `STATUS: pass` itself), nor is the template `STATUS: pass or fail`. The review passes only if the first `STATUS` line says pass and none says fail; a reply with no `STATUS` line fails. A triaged plain or reviewed run that fails escalates to the orchestrator unless `ORCH_NO_ESCALATE` is set; for code in git its edits stay uncommitted and the orchestrator works from `HEAD`, elsewhere they stay in place.

### What the first headless runs taught

Two live runs ended the same way: both implementers wrote code but could not run `npm test` or commit, and the orchestrator correctly reported the slices as unverified instead of passed.

- **The allowlist bug.** `orchestrate.sh` split the allowlist on whitespace, so `Bash(git status*)` became the broken tokens `Bash(git` and `status*)` and no `Bash(...)` rule with a space ever applied. The script now keeps one rule per array element. With the fix, background implementers ran `npm test` and `git commit` fine.
- **`cd` plus `git` is refused.** Claude Code prompts for `cd` into another directory followed by `git` (git could run that directory's hooks), and `dontAsk` turns a prompt into a denial whatever the allow rules say. Agents are now told to use `git -C <dir>` and `npm --prefix <dir>`, and reviewers examine the integrated result in the project directory.
- The macOS `/var` vs `/private/var` symlink was a wrong first guess; the failure reproduced under `~/orch-test`.

## Scripted flow (workflow)

`.claude/workflows/orchestrate.js` fixes the order in code instead of the orchestrator's prompt: plan, explore (`researcher`), build (`implementer`, isolated when code slices run in parallel in git), review (`reviewer`, plus an opus reviewer on risky slices), integrate (`integrator`, isolated code branches only). Ask Claude for it explicitly, for example "run the orchestrate workflow with task ...". It takes `args.code` (default `true`: the task changes code) and `baseRefHead`. With `code: true`, a wave of several slices runs isolated, after a checkpoint commit, only when `baseRefHead: true` (pass it only for a git repository whose `worktree.baseRef` is `"head"`); otherwise its slices run one after another in the shared tree, as do dependent slices, because worktrees only see committed work. Code outside git therefore runs one slice at a time. With `code: false` (research, writing, analysis, operations) there are no worktrees, checkpoint or integrator and nobody commits; the slices of a wave run at the same time in the shared folder, because their output files are disjoint and none is code, and the reviewer checks each slice's output against its checklist, not `git diff`. Order is advisory in the native session (the orchestrator once reviewed a branch before running the integrator, against its prompt); the workflow removes that freedom.

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
