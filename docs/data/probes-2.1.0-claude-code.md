# Probes 2.1.0: Claude Code 2.1.327 to 2.1.331

Date: 2026-11-24. Claude Code 2.1.331 installed (2.1.328 to 2.1.331 in `~/.local/share/claude/versions/`), repo at
`13ab1e7` (2.0.3) plus the uncommitted slice s0. Release 2.1.0 is checked against Claude Code 2.1.331 and Agent SDK
0.3.331. No model was called: no `claude -p` with a prompt, no headless run, no eval or bench.

## Sources

- Claude Code's changelog, fetched with `curl -sSfL https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`
  on 2026-11-24 (11,799 lines). The entries `## 2.1.331` to `## 2.1.327` (lines 3 to 741) were read in full.
- The program file `~/.local/share/claude/versions/2.1.331` (read with node, `Buffer.indexOf`, no run) for the wait
  ceiling below; the same lookup in 2.1.328, 2.1.329 and 2.1.330 found the same function.
- The npm registry: `npm view @anthropic-ai/claude-agent-sdk version` printed `0.3.331`; `npm view
  @anthropic-ai/claude-code@2.1.331 version` printed `2.1.331`.

## The headless wait ceiling (read from the 2.1.331 program)

`function v_l(){return s.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS??WUn}` with `var WUn=600000;`. The print-mode loop sets
`backgroundWaitFirstIdle` when its input is closed and no turn runs, clears it when a turn runs, and sets
`ceilingExceeded` once `now - backgroundWaitFirstIdle >= v_l()` (and the ceiling is above 0). Then it prints
`Background tasks still running ... after the last turn (...); stopping them. Set CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0
to wait indefinitely.` So a headless run whose orchestrator ends its turn to wait for one implementer has ten minutes
for that implementer's whole work, its SubagentStop hooks included (the test gate's budget is at most 870 s), before
Claude Code stops it. Whether 2.1.326 already had this ceiling was not read (no 2.1.326 program on the machine).

## Decisions

Every entry that touches hooks, subagents, the Agent tool, background tasks, plugins, settings, permissions, headless
mode, worktrees, workflows or the SDK. Each is quoted verbatim, then the decision, the reason and the files checked.
Entries about the VS Code extension, the self-hosted runner, the gateway, Code Mode's own script runtime, the terminal
display and sign-in were read and left out: nothing here uses them.

### Changed

- 2.1.328: "Changed `claude -p` with `CLAUDE_CODE_FORK_SUBAGENT=0` to count a background subagent and those it waits
  for against one 10-minute wait; raise `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` for longer chains". **Changed.**
  `scripts/orchestrate.sh` exports `CLAUDE_CODE_FORK_SUBAGENT=0` and runs the orchestrator, which ends its turn while
  an implementer and its test gate run, often longer than ten minutes. It now exports
  `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=3600000` unless the environment already sets it (0, no limit, is kept). The
  new `bgwait` check of `npm run claude-update` fails when the program no longer names the setting. Checked:
  `scripts/orchestrate.sh`, the program file (above). Pinned: `src/cc-2-1-331.test.mjs` ("headless runs wait an
  hour"), `src/claude-update.test.mjs` ("bgwait").

### No change, with a test

- 2.1.329: "Changed Stop and SubagentStop hooks to list a Monitor's script as `monitor`, not `shell`, in
  `background_tasks`". **No change.** Only `review-gate.mjs` reads the list, and only `subagent`, `workflow` and
  `teammate` entries that run, wait or are queued defer it (`ACTIVE_TYPES`, `ACTIVE_STATUS`). A monitor, like a shell
  before it, brings no report the gate waits for, and one that watches all session would defer every Stop.
  `verify.sh` reads top-level fields only (2.0.1); `journal.mjs` and `telemetry.mjs` never read `background_tasks`.
  Pinned: a Stop listing a running monitor and a shell blocks, one listing a running subagent beside the monitor
  defers (`src/cc-2-1-331.test.mjs`).
- 2.1.327: "Changed subagents launched without a model to stay on the model they started on when resumed, including
  after `/model`". 2.1.330: "Changed a subagent's model fallback to carry over: agents with no model and forks it then
  starts run on the fallback, and the agents they start use its Bedrock region". **No change.** Every agent file names
  its model; the retry's second attempt is a `SendMessage` resume, which the plan check (model floor, read router,
  matcher `Agent|Task`) never sees; the third is a fresh launch with `model: "opus"`, which it sees as before. The
  implementer has no Agent tool, so it starts no agents. Pinned: agent files name a model, the plan check's matcher,
  and the real `plan-check.mjs` on a `SendMessage` payload exits 0 with no output.
- 2.1.328: "Changed managed `PostToolUse` hooks to no longer fire for calls refused before they ran: no log entry,
  rewrite, block or stop there; `PostToolBatch` gets most, not marked as refused". **No change.** `journal.mjs`,
  `read-log.mjs` and `turn-budget.mjs` are project and plugin hooks, never managed ones, and none needs a PostToolUse
  for a refused call (a launch the plan check refused must leave no launch record). Pinned: the PostToolUse lists of
  `.claude/settings.json` and `dist/plugin/hooks/hooks.json`.
- 2.1.328: "Added `\"onFailure\": \"block\"` for `mcp_tool` hooks, as for command and HTTP hooks: a hook whose call
  fails blocks the action". **No change.** Every hook here is a `command` hook; the judge hook already has
  `onFailure: "block"`. Pinned: every registered hook has type `command`.
- 2.1.331: "Added `optionalDependencies` to plugin manifests: plugins that install with the plugin listing them and can
  be disabled or uninstalled on their own". **No change.** The plugin depends on no other plugin. Pinned: neither
  manifest has `dependencies` or `optionalDependencies`.
- 2.1.331: "Fixed a permission rule on a subagent's model, such as `Agent(model:*)`, blocking Claude's follow-up
  message to a subagent started on this version with no model named". **No change.** No permission rule names a
  subagent's model; `permissions.deny` names agent types only. Pinned: no `Agent(model:` rule.

### No change, documented

- 2.1.331: "Fixed Stop hooks that read the transcript missing the last reply in Claude Desktop; SubagentStop hooks now
  wait for it too". **No change.** `journal.mjs` reads a worker's transcript at SubagentStop (woken stops, the report
  after a resume, the implementer's tool calls); a transcript that holds the last reply can only help. Checked:
  `.claude/hooks/journal.mjs`.
- 2.1.331: "Fixed Claude not being told when permission rules on the Agent tool dropped its queued message to a
  subagent that had already ended". **No change.** No rule here drops a `SendMessage`; display of an earlier failure.
- 2.1.331: "Fixed a Workflow agent's background shells and MCP servers sometimes being left running after it handed back
  its report". **No change.** The 2.0.1 rule (no shell task left behind) still holds for every worker; the workflow's
  agents now also get this from Claude Code.
- 2.1.331: "Fixed an interrupted or failed plugin update leaving a partial plugin folder that later loaded with skills
  or other components missing". **No change.** The `workflow` check still reads the loaded copy's workflow.
- 2.1.331: "Fixed `claude plugin install`, `marketplace add` and similar commands hanging with no output when managed
  settings needed an approval that could not be asked for". **No change.** `claude-update` runs them only with
  `--enable` or `--fix`, with a 120 s timeout.
- 2.1.331: "Fixed PermissionRequest hooks not saving `Skill(name:*)` allow rules outside local settings". **No
  change.** No PermissionRequest hook here.
- 2.1.331: "Changed what a `PermissionDenied` hook's `retry: true` tells Claude: make the refused call again only if you
  asked for that call". **No change.** No PermissionDenied hook here.
- 2.1.331: "Changed in a future release, on or after November 30, 2026: plugin marketplaces in managed
  `extraKnownMarketplaces` will auto-update by default. To opt one out, set `\"autoUpdate\": false` on its entry".
  **No change.** This repo adds its marketplace with `claude plugin marketplace add`, not in managed settings.
- 2.1.331: "Fixed turns and subagents failing in cloud sessions, or timing out on long replies elsewhere, when a reply
  went silent while Claude was still thinking; Claude Code now tries the request once more". **No change.**
- 2.1.330: "Fixed `ExitWorktree` and the worktree exit dialog deleting a worktree that another running Claude Code
  session was working in". **No change.** No agent here calls `ExitWorktree`; isolated slices use `isolation:
  worktree`.
- 2.1.330: "Fixed changes to user settings being lost when several Claude Code processes saved them at the same time".
  **No change.** `claude-update --fix` writes the user settings with a temp file and a rename, outside Claude Code.
- 2.1.330: "Fixed an MCP server that subagents declare being shut down when one of them finished, while other subagents
  or the session were still using it". **No change.** No agent here declares an MCP server.
- 2.1.330: "Fixed plugins going missing from the installed list when several `claude plugin` commands ran at the same
  time". **No change.** `claude-update` runs them one at a time.
- 2.1.330: "Fixed a stopped background subagent sometimes not staying stopped" and "Fixed Claude still waiting for a
  background agent that was stopped just as it finished, in sessions run by an app or the SDK". **No change.** The
  review gate's `implementer_unfinished` covers an implementer stopped with no SubagentStop either way.
- 2.1.330: "Fixed environment variables written by a SessionStart hook being lost with `claude -p --continue`". **No
  change.** No SessionStart hook here writes `CLAUDE_ENV_FILE`; headless runs do not use `--continue`.
- 2.1.330: "Fixed `claude -p` exiting 0 with no message when its output went to a file on a full disk: it now prints an
  error and exits 1, though a full NFS export may go unnoticed". **No change.** `scripts/run-result.mjs` already
  records the exit code (`exit_code`, `complete`).
- 2.1.330: "Fixed the choice between two user or project agent files declaring the same name depending on the order the
  file search listed them". **No change.** The plugin's agents are namespaced (`orchestration:<role>`), so the
  project's and the plugin's copies never share a name.
- 2.1.330: "Fixed a subagent's own subagents and forks running on the plan-mode model in plan mode under `opusplan` or
  `haiku`". **No change.** Workers here start no agents (the implementer has no Agent tool; others list none).
- 2.1.330: "Changed more `rm` commands aimed at the root, home, a top-level folder or the working folder to ask for
  approval; where nobody can answer, they're refused". **No change.** Headless runs already deny `rm -rf`; a worker
  refused in a run says so in its report.
- 2.1.330: "Changed skills that Claude runs with a `model` setting, other than `context: fork` skills, to leave
  subagents, forks, compaction and `/recap` on the session's model". **No change.** No skill here sets `model`.
- 2.1.330: "Changed prompt hooks to accept model aliases such as `haiku` or `sonnet` in their `model` field". **No
  change.** No prompt hook here.
- 2.1.330: "Added easel, a built-in mod that draws charts when asked and under MCP metrics results, ...". **No change.** It
  adds no built-in agent type (`builtins` check: 5 types, all on the list); the dashboard mod is separate.
- 2.1.329: "Changed Code Mode so a PreToolUse hook that errors no longer refuses a script's tool call, as outside Code
  Mode; set `\"onFailure\": \"block\"` on a command, HTTP or MCP tool hook that must refuse". **No change.** Every
  gate here refuses by exiting 2, never by erroring; the judge hook, which must refuse on failure, has
  `onFailure: "block"`.
- 2.1.329: "Fixed a background agent running on when it was stopped while it was being resumed". **No change.**
- 2.1.329: "Fixed a removed plugin's MCP server staying connected in headless sessions after `reload_plugins` or when
  the account's plugin list drops it". **No change.** The plugin has no MCP server.
- 2.1.329: "Fixed a new skills, commands or agents folder being missed when `--add-dir` names the working directory or
  Claude Code starts in the home folder". **No change.** `scripts/orchestrate.sh` passes `--add-dir` for other folders
  only.
- 2.1.329: "Fixed the Agent tool's `effort` parameter being ignored for named teammates in agent teams". **No change.**
  No teammates here.
- 2.1.329: "Fixed `claude --help` output being cut short when piped to another program". **No change.** The `flags`
  check reads `claude --help` through a pipe and found all 15 options before and after.
- 2.1.329: "Changed the `/tasks` header and the footer's background count to one number covering shells, monitors, MCP
  calls, agents, workflows and scheduled tasks". **No change.** Display only.
- 2.1.328: "Added `CLAUDE_CODE_DISABLE_DEFERRED_TOOL_RESUME`, which lets a host stop `claude -p --resume` and
  `--continue` from running a tool call that a hook deferred". **No change.** No hook here defers a call.
- 2.1.328: "Fixed the token counts on the spinner and for subagents counting a retried reply twice, missing replies that
  were not streamed, and standing still while Claude thinks". **No change.** Telemetry counts tokens from the
  transcript by distinct message id (`usageFromTranscript`).
- 2.1.328: "Fixed agent hooks running past their timeout while compacting after a request was refused as too large".
  **No change.** No agent hook here.
- 2.1.328: "Fixed `/goal` removing a skill's Stop hook, or ending early on another hook's result, when both had the same
  wording". **No change.**
- 2.1.328: "Changed Code Mode to no longer run UserPromptSubmit hooks, managed ones included, on scripts' output".
  **No change.** `nudge.mjs` and `prompt-capture.mjs` want typed prompts only (`typedPrompt`).
- 2.1.328: "Changed subagents in `claude -p`, the Agent SDK, desktop and VS Code to wait for their own subagents by
  default when `CLAUDE_CODE_FORK_SUBAGENT=0` is set". **No change.** Workers here start no agents.
- 2.1.328: "Changed a shell command rewritten by a PermissionRequest hook to a sandbox-excluded command to run outside
  the sandbox". **No change.** No PermissionRequest hook here.
- 2.1.328: "Changed how a sandbox that can't start is reported, unless `sandbox.failIfUnavailable` is set: the next
  sandboxed Bash command is refused and says that the sandbox is off for the session". **No change, documented.** On
  a machine where the sandbox cannot start (the test machine, `docs/data/probes-2.0.0-f4.md`, Probe 3) a person with
  `sandbox.enabled` now sees that refusal; not probed here.
- 2.1.328: "Improved `claude -p` and SDK sessions to fetch managed-settings plugins that have their own git repository,
  in the background, for a later session" and "Improved how soon managed-settings plugins from a git marketplace load
  on a fresh machine in `claude -p`, SDK and Claude Desktop sessions; a short run may exit up to 30 seconds later".
  **No change.** This plugin is not a managed-settings plugin.
- 2.1.327: "Fixed some `--disallowedTools` rules with parentheses in their content". **No change.** The headless deny
  rules are full `Bash(...)` rules; a fix can only make more of them apply. Not probed.
- 2.1.327: "Fixed agents passed with `--agents` being lost once plugins loaded or reloaded" and "Fixed a plugin's agent
  being dropped when resuming a session from the `--resume` picker". **No change.** `scripts/orchestrate.sh` passes
  `--agent`, not `--agents`, and resumes nothing.
- 2.1.327: "Fixed a finished subagent resuming on the model and effort of a sibling subagent that messaged it". **No
  change.** Only the orchestrator messages workers.
- 2.1.327: "Fixed failing hooks showing nothing: SubagentStop in background agents, SessionEnd at `/clear` and
  `/resume`, and CwdChanged and FileChanged in fullscreen" and "Fixed a Stop hook that failed to run being shown as
  having reported a problem". **No change.** Display only.
- 2.1.327: "Changed `ExitWorktree` to ask before removing a worktree that may hold unsaved work". **No change.**
- 2.1.327: "Changed path checks to refuse some symbolic links" and "Changed what counts as inside a working directory,
  so some paths now ask for permission". **No change, documented.** A headless worker refused such a path says so in
  its report. Not probed.
- 2.1.327: "Changed Bash commands whose variables expand to very long text to be denied". **No change.**
- 2.1.327: "Changed a subagent resumed by a sibling's message to follow the session's permission settings". **No
  change.** Workers do not message each other.
- 2.1.327: "Changed `--worktree` with a relative `--add-dir` beside the launch folder ..." and "Changed some
  `--worktree` starts with a relative `--add-dir` above the launch folder ...". **No change.** `scripts/orchestrate.sh`
  passes no `--worktree`.
- 2.1.327: "Changed the first subagent on a model to wait up to 1.5 seconds (10 in `claude -p`) for that model's
  settings from Anthropic" and "Changed restarted background subagents, and turns that start by themselves, to wait for
  plugins to load". **No change.**
- 2.1.327: "Changed non-interactive (`-p`) mode to run fewer git commands before the first request". **No change.**

## `npm run claude-update`

Run before any change (orchestration 2.0.3): every check `ok` but `sdk`, a note (`Agent SDK 0.3.325 carries its own
Claude Code 2.1.325`, the stale `node_modules` below); `All checks passed.` Run after the change (orchestration 2.1.0):

| Check | Result |
|---|---|
| `cli` | ok, Claude Code 2.1.331 |
| `builtins` | ok, all 5 built-in agent types of Claude Code 2.1.331 are on the block list (no `--write-source`) |
| `headless` | ok, the headless switches leave no built-in agent |
| `flags` | ok, all 15 documented options exist |
| `payload` | ok, all 13 hook payload fields named in the 2.1.331 program |
| `memory` | ok, `CLAUDE_CODE_DISABLE_AUTO_MEMORY` named |
| `bgwait` (new) | ok, `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` named |
| `sdk` | ok, Agent SDK 0.3.331 carries Claude Code 2.1.331 |
| `plugin` | ok, orchestration 2.1.0 enabled (read from this checkout) |
| `workflow` | ok |
| `sandbox` | ok, the sandbox is off in the user settings |
| `dist` | ok |

`All checks passed.` Never run with `--fix` or `--enable`.

## Agent SDK

0.3.331 is published; `package.json` and `package-lock.json` now name `^0.3.331` (lock: 0.3.331 and its eight platform
packages). The `tsc` errors about `mcpServersDelivery` in `src/agent.ts` and `src/judge.ts` that slice s0 saw came
from a stale `node_modules`, not from the package files: the lock named 0.3.326, but `node_modules/.package-lock.json`
was the install of release 1.4.3 (Agent SDK 0.3.325, whose types have no `mcpServersDelivery`), and `npm ls` printed
`(empty)`. A first `npm install` failed on that tree (`ENOENT ... rename node_modules/node_modules/ajv-formats`, beside
leftover `.ajv-formats-*` folders of an interrupted install from 2026-10-17); removing `node_modules` and installing
again gave 0.3.331, and `npm run typecheck` passes with no source change.

## Commands run

```sh
claude --version                                   # 2.1.331 (Claude Code)
npm run claude-update                              # before and after; never --fix, --enable or --write-source
curl -sSfL https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md -o CHANGELOG.md
npm view @anthropic-ai/claude-agent-sdk version    # 0.3.331
npm view @anthropic-ai/claude-code@2.1.331 version # 2.1.331
npm ls @anthropic-ai/claude-agent-sdk              # (empty) before the reinstall
npm version 2.1.0 --no-git-tag-version
rm -r node_modules && npm install @anthropic-ai/claude-agent-sdk@^0.3.331
npm run typecheck                                  # passes
npm run build-plugin && npm run check-plugin       # up to date
npx tsx --test src/claude-update.test.mjs src/cc-2-1-331.test.mjs src/marketplace.test.mjs src/policy.test.ts src/review-gate-v2.test.mjs
```

The program file was read with a node one-liner (`readFileSync`, `indexOf` of `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`,
`WUn=` and `v_l()`), never run.
