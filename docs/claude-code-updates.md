# After a Claude Code update

Claude Code updates itself. Most updates change nothing here, but this repo relies on a few things Claude Code does, and an update can change one of them without any error. This page says what to run after an update, what each check means, and what the repo relies on. For anyone who keeps a checkout or the plugin installed.

## What happened on 2026-11-24

Claude Code went from 2.1.326 to 2.1.331, and Agent SDK 0.3.331 carries it. Read: the entries 2.1.327 to 2.1.331 of Claude Code's changelog in full (from `raw.githubusercontent.com`, on 2026-11-24). Release 2.1.0 moves the SDK pipeline to 0.3.331 and CI's Claude Code CLI to 2.1.331; `npm run claude-update` passes every check with both. Every entry judged, with its text, decision and reason: [probes 2.1.0](data/probes-2.1.0-claude-code.md). Item by item, for what this repo relies on:

- **Headless wait (changed).** 2.1.328: `claude -p` with `CLAUDE_CODE_FORK_SUBAGENT=0`, which `scripts/orchestrate.sh` exports, counts a background subagent and those it waits for against one 10-minute wait. The 2.1.331 program stops the background tasks still running that long after the last turn (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, default 600000). The orchestrator ends its turn to wait for an implementer, whose work and test gate (up to 870 s) can pass ten minutes with no turn in between, so Claude Code could stop the implementer mid-slice. `scripts/orchestrate.sh` now exports `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=3600000` unless the environment sets it (0 waits with no limit), and the new `bgwait` check fails when Claude Code no longer names the setting.
- **Monitors in `background_tasks`.** 2.1.329: Stop and SubagentStop list a Monitor's script as `monitor`, not `shell`. The review gate defers only for a running subagent, workflow or teammate, so a monitor does not defer it, as a shell did not; `verify.sh` reads top-level fields only, and the journal and telemetry never read the list. No change; `src/cc-2-1-331.test.mjs` pins it.
- **Subagent models.** 2.1.327: a subagent launched without a model stays on its starting model when resumed; 2.1.330: a subagent's model fallback carries over to the agents it starts. Every agent file names its model, the retry's resume is a `SendMessage` the plan check never sees, and the third attempt is a fresh launch the plan check sees as before. No change.
- **Hook failures and refused calls.** 2.1.328: managed PostToolUse hooks no longer fire for refused calls; `journal.mjs`, `read-log.mjs` and `turn-budget.mjs` are project and plugin hooks. 2.1.328 adds `onFailure: "block"` for `mcp_tool` hooks, and 2.1.329 stops an erroring PreToolUse hook from refusing in Code Mode; every hook here is a command hook, every gate refuses by exit 2, and the judge hook already has `onFailure: "block"`. 2.1.331: SubagentStop hooks wait for the last reply in the transcript, which the journal reads. No change.
- **Plugins and permissions.** 2.1.331 adds `optionalDependencies` to plugin manifests and fixes `Agent(model:*)` rules blocking a follow-up message; the plugin depends on no plugin and no rule names a model. Managed marketplaces will auto-update from 2026-11-30 on; this one is added by hand. Path checks that refuse some symbolic links and more `rm` forms that ask (2.1.327, 2.1.330) were not probed; a headless worker refused one says so in its report. No change.
- **Sandbox that cannot start.** 2.1.328: unless `sandbox.failIfUnavailable` is set, the next sandboxed Bash command is refused and says the sandbox is off. On the test machine, where the sandbox cannot start, a person with `sandbox.enabled` now sees that refusal. Not probed.
- **Agent SDK 0.3.331.** `npm run typecheck` passes with no source change. The `mcpServersDelivery` type errors seen before the move came from a stale `node_modules` (an install of release 1.4.3 with SDK 0.3.325), not from the package files; a clean `npm install` fixed them.

## What happened on 2026-11-17

Claude Code went to 2.1.326, and Agent SDK 0.3.326 carries it. Read: the whole 2.1.326 entry of Claude Code's changelog and the 0.3.326 entry of the Agent SDK's (both from `raw.githubusercontent.com`, on 2026-11-17). Release 1.6.0 moves the SDK pipeline to 0.3.326; `npm run claude-update` passes every check with both. Item by item, for what this repo relies on:

- **Hook output.** A hook's `"decision": "block"` now holds in more cases, so a hook that always prints one could start blocking. No hook here prints a decision to stdout except to block on purpose; `"decision"` elsewhere is in the state logs (`gates.jsonl`). Hook failures now show in red and a stopping hook in yellow: display only. `updatedInput` from a PreToolUse hook is kept in more cases when several hooks answer; the plan check is the only hook that returns one.
- **Bash permission checks.** Several changes make more commands ask, or be refused where no one can answer (unattended runs): some `cp` and `mv`, very long values, lines that set environment variables in the sandbox when auto-allow is off, commands reaching Claude Code's sign-in files, and some git commands in subagents isolated in a worktree that can rewrite branches shared with the checkout. Not probed here. A headless run whose worker is refused such a command says so in its report.
- **Headless tool lists.** A new startup warning names an `--allowedTools` or `--disallowedTools` entry that does not look like a complete rule. An invalid `--tools` entry draws a different one, `--tools: "Bash(git" doesn't look like a tool name...`, since `--tools` takes plain tool names; `scripts/orchestrate.sh` passes no `--tools`. Both print on stderr in text mode: `claude -p hi --model no-such-model-x --disallowedTools "Bash(git"` prints `--disallowedTools: "Bash(git" doesn't look like a complete rule...` (the unknown model name stops the run before any model call). With `--output-format stream-json --verbose` it is absent from both stderr and the event stream, and `scripts/orchestrate.sh` runs with stream-json, so a headless run would not show it. The launcher's own lists, run in text mode the same way (its arguments from `ORCH_DRY_RUN=1`, without the stream-json options), draw no such warning. They draw another one: seven `git -C *` allow rules (`branch --show-current`, `worktree list`, `worktree add`, `add`, `commit`, `merge`, `reset --merge`) have a wildcard before the rest of the command, so they also match options inserted there. 1.6.0 left those rules as they were; 1.6.1 pinned them to known folders, and only the three (six with skill repositories) that need a `*` for a worktree's name still warn.
- **Sandbox writable folders.** Sandboxed commands write to fewer home folders; some can be allowed again only with `sandbox.filesystem.allowWrite` in user or managed settings. The hooks run outside the sandbox, so per-user state under `~/.claude/orchestration/` is unaffected. Skill drafts under `~/.claude/orchestration/skill-drafts/` are written by the implementer's own Bash: whether a sandboxed implementer can still write there was not established, because the sandbox could not start on the test machine. The reason given then, `socat` missing, was not the whole cause: in the 2.0.0 probe, with `socat` installed, the sandbox still did not start, because the kernel restricts nested user namespaces (setting one up needs CAP_SYS_ADMIN) ([probes f4](data/probes-2.0.0-f4.md), Probe 3). Since 1.6.1 the `sandbox` check of `npm run claude-update` notes a missing `allowWrite` entry and `--fix` adds it; a live sandboxed write is still not shown. The SDK pipeline's sandbox (`ORCH_SANDBOX=on`) allows only the worktree and the temp folder, as before.
- **Settings.** Values nested past 64 levels are dropped with a warning, and a settings file saved with an error mid-session is named. The repo's settings nest a few levels; nothing to do.
- **Plugins.** A malformed `plugin.json` display field is now ignored with a note instead of refusing the plugin. `claude plugin list` shows no such note for this plugin, but notes `subagentStatusLine is deprecated in favor of mods and will stop working in a future release.` for the setting the plugin's `settings.json` held in 1.6.0 (the worker rows). No documented replacement exists: the docs name no mod interface for the agent rows, and Claude Code's changelog says at 2.1.323 "Removed the `subagentStatusLine` setting", while the 2.1.326 binary still runs the command and caches the key (`Cached plugin settings with keys: subagentStatusLine` in a debug log). 1.6.0 left it as it was; 1.6.1 moved the rows to the mod's `AgentRow` hook and ships no `settings.json`. For a plugin whose marketplace is a directory, as with a checkout of this repo, Claude Code reads the plugin straight from the checkout (`Read from:` in `claude plugin list`), and `~/.claude/plugins/installed_plugins.json` can keep an older version for it (on the test machine 1.2.2 while 1.6.0 loaded): read the loaded version from `claude plugin list` or `npm run claude-update`, which compares the folder's version for such an install (`versionOf` in `scripts/claude-update.mjs`).
- **Worktree sessions and plugin settings.** 2.1.326 "Changed some worktree sessions to skip some plugin settings; a notice names what was skipped". In 1.6.0 the plugin's `settings.json` held only `subagentStatusLine`, a display setting no gate reads (1.6.1 ships none); the gates are hooks from `hooks.json`, and the test gate judges a `claude --worktree` session by `git status`, as the shared tree. Probed with no model call (`claude -p hi --model no-such-model-x --worktree probe-wt` in a scratch repository, plugin enabled at user scope, `--debug-file`): the session cached `subagentStatusLine`, ran the plugin's SessionStart hook, and printed no skip notice. Which worktree sessions skip what was not found; under 1.6.0 such a skip cost only the worker rows' look, and 1.6.1 ships no plugin settings to skip (the rows are the mod's). Nothing needs to change.
- **Agent SDK 0.3.326.** Sending `mcpServers` on Claude Code's command line (the default, `'argv'`) is deprecated; a later release defaults to `mcpServersDelivery: 'initialize'`. Every SDK `query()` of this repo (the roles in `src/agent.ts`, the Bash judge in `src/judge.ts`) now passes `mcpServersDelivery: 'initialize'` with its `mcpServers`, as the SDK suggests for the Claude Code it carries (1.6.0, Fixed). No SDK MCP server, `rewindFiles()` or `resumeSessionAt` is used here. `npm run typecheck` passes on 0.3.326.

## What happened on 2026-11-14

Claude Code went from 2.1.323 to 2.1.325 on its own. Two things changed underneath this repo.

- **A new [built-in subagent](glossary.md#b) type.** The gates track only this repo's researcher, implementer, reviewer and integrator, so Claude Code's own subagents are blocked while a run is open. The block list then named six types by hand, in three places. The new type was in none of them: the plan check took it for somebody's own agent and let it through, and this repo's `permissions.deny` did not deny it.
- **Auto memory in inner calls.** Claude Code's auto memory was on in every `claude -p` call the native judge makes, and in the SDK workers. Each judge call left an empty `~/.claude/projects/<temp folder>/memory` folder and carried the auto-memory instructions in its prompt. An SDK worker could write memory notes under the project folder of its throwaway worktree.

[Headless runs](glossary.md#h) were not affected by the first one: `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`, which `scripts/orchestrate.sh` exports, still removed every built-in, the new one included.

Both are fixed in 1.2.2. The built-in names now live in one file, `BUILTIN_AGENTS` in `.claude/hooks/builtin-agents.mjs`, and the inner calls run with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

## The check

Run this in a checkout after every Claude Code update:

```sh
npm run claude-update                      # check only; exit 1 when something needs attention
npm run claude-update -- --fix             # also repair this machine
npm run claude-update -- --enable          # install and enable the plugin when it is off
npm run claude-update -- --write-source    # maintainer: also update the block list in the repo
npm run claude-update -- --json            # print the result as JSON
```

- It calls no model. It runs `claude --version`, `claude --help`, `claude plugin ...` and two start-up requests ("How the built-in list is read" below), and reads the program file of `claude` (found on `PATH`, through symlinks) for the `payload`, `memory` and `bgwait` checks.
- It prints one line per check, marked `ok`, `fixed`, `note` or `FAIL`. It exits 0 when no check failed, 1 when one did, and 2 on an unknown argument.
- It writes its result to `<CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/claude-update.json`.
- `ORCH_CLAUDE_BIN` names another `claude` binary.

| Check | Passes when | If it fails |
|---|---|---|
| `cli` | `claude --version` runs | Install Claude Code, or set `ORCH_CLAUDE_BIN` |
| `builtins` | Every built-in subagent type of the installed Claude Code is in `BUILTIN_AGENTS` | `--fix` blocks the new type on this machine at once. `--write-source` adds it to the repo; then run `npm run check` and release |
| `headless` | With `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` and `CLAUDE_CODE_FORK_SUBAGENT=0` Claude Code lists no subagent | The switches stopped working: headless runs can delegate to built-ins. `scripts/orchestrate.sh` needs another way to turn them off, for example `--disallowedTools "Agent(<type>)"` for each type |
| `flags` | Every option in `HEADLESS_FLAGS` (the options `scripts/orchestrate.sh` and the native judge pass) is in `claude --help` | An option was removed or renamed; change the script that passes it |
| `payload` | Every hook payload field the hooks read (`HOOK_FIELDS`) is named in the program file of `claude` (2.0.0). Presence only: a field can keep its name and change its shape | The failure names the missing fields. The hooks exit 0 on input they cannot read, so a gate can go quiet: read the hook docs and probe the hooks (`npm run test-dashboard`, a headless run). A program file that cannot be found or read, or that names none of the fields (a wrapper script), is a note |
| `memory` | `CLAUDE_CODE_DISABLE_AUTO_MEMORY` is named in the same program file (2.0.0). Presence only: whether it still turns auto memory off is not tested | The judge hook and the SDK workers may now start auto memory; read Claude Code's memory docs for what replaced the switch. Same notes as `payload` |
| `bgwait` | `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`, which `scripts/orchestrate.sh` exports so `claude -p` keeps waiting for a background implementer and its test gate, is named in the same program file (2.1.0). Presence only: how long `claude -p` then waits is not tested | Headless runs may be stopped after Claude Code's default wait (10 minutes since 2.1.328) while an implementer still works; read the headless docs for what replaced the setting. Same notes as `payload` |
| `sdk` | The Agent SDK's patch number equals Claude Code's (0.3.N carries 2.1.N) | A note, not a failure: the [SDK pipeline](glossary.md#s) runs the older Claude Code the SDK carries. To match: `npm install @anthropic-ai/claude-agent-sdk@0.3.N && npm run check`. With no Agent SDK installed the check passes |
| `plugin` | The plugin, when installed, is at this checkout's version | An installed version that differs fails; `--fix` runs `claude plugin update` for it. Not installed or disabled is a note, because the plugin is opt-in: `--enable` installs it from this checkout and turns it on |
| `workflow` | The enabled plugin's `workflows/orchestrate.js` (in the folder it is read from) has the content the workflow guard expects (`PLUGIN_WORKFLOW_SHA256`; 2.0.0). Not run when the plugin is off | The guard's project copy checks only `dist/plugin`, so a loaded copy of other content would be trusted as installed. Update the plugin (`claude plugin update`; `--fix` runs it only when the version differs from this checkout's), or, for a plugin read from this checkout, run `npm run build-plugin`. A folder the plugin list does not name, or a file that cannot be read, is a note |
| `sandbox` | With `sandbox.enabled` in your user settings (`<config dir>/settings.json`), `sandbox.filesystem.allowWrite` covers `<config dir>/orchestration` (state, skill drafts, the judge's record; 1.6.1) | A note naming the entry. `--fix` adds `<config dir>/orchestration` to `sandbox.filesystem.allowWrite`, keeping every other key and the indent; a symlinked `settings.json` is written at its target, and paths are compared with symlinks resolved. Managed settings are never edited; a file that cannot be read or parsed is a note only. On Linux an entry for a path that does not exist has no effect; the check creates the folder (it writes `claude-update.json` there). Restart Claude Code after the fix |
| `dist` | `npm run check-plugin` passes | `npm run build-plugin` |

### How the built-in list is read

1. The script starts `claude -p --safe-mode --input-format stream-json --output-format stream-json` in an empty temp folder.
2. It writes one line: the `initialize` control request, the same one the Agent SDK sends when a session starts.
3. Claude Code answers with its version and the subagent types that exist. In safe mode every customization is off, so the answer holds built-ins only.
4. The script closes the input. No prompt is sent, so no model runs and nothing is billed.

It asks twice: once as it is, for the `builtins` check, and once with the two headless switches set, for the `headless` check.

### What `--fix` and `--write-source` change

`--fix` changes this machine only:

- It writes the built-in types that are not in `BUILTIN_AGENTS` to `<CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/builtin-agents.json`. `builtinAgents()` in `builtin-agents.mjs` adds that file's names to the list every time the plan check runs. So the new type is blocked from the next launch on, with no new release and no restart.
- The file can only add plain names, never one of this plugin's own agents. The worst a wrong file can do is block a type twice before the loop guard lets it through. `ORCH_BUILTINS_FILE` names another file; empty means none.
- It runs `claude plugin update` for an installed plugin whose version differs from this checkout's. It installs nothing when the plugin is not installed (`--enable` does). An install from a marketplace added at a release tag stays on that tag until the marketplace is added again at a newer one ([Sharing the plugin](marketplace.md#stable-or-latest)). A plugin updated from your shell loads in the next session you start. In a session that is already open, run `/reload-plugins`.
- With the sandbox on in your user settings, it adds `<config dir>/orchestration` to `sandbox.filesystem.allowWrite` (the `sandbox` row above).

`--enable` installs the plugin from this checkout's marketplace when it is missing, and enables it when it is disabled. `--fix` never does that: whether the plugin is on is your choice, and an update check must not change it. It adds the checkout folder as the marketplace (`claude plugin marketplace add <checkout>`) when no marketplace of that name is known; installing from GitHub instead, at `main` or at a release tag: [Sharing the plugin](marketplace.md).

`--write-source` is for whoever maintains the repo. It adds the new types to `BUILTIN_AGENTS` in `.claude/hooks/builtin-agents.mjs` and to `permissions.deny` in `.claude/settings.json`, and runs `npm run build-plugin`. Then run `npm run check`, commit and release, so every install gets the list.

## What the repo relies on

| It relies on | Where | Checked by |
|---|---|---|
| The names of Claude Code's built-in subagent types | `builtin-agents.mjs`, `permissions.deny` | `builtins` |
| `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` and `CLAUDE_CODE_FORK_SUBAGENT` | `scripts/orchestrate.sh` | `headless` |
| `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` (how long `claude -p` waits for background agents after its last turn) | `scripts/orchestrate.sh` | `bgwait` checks that Claude Code still names it; `src/cc-2-1-331.test.mjs` that the script sets it; nothing checks that Claude Code still honours it |
| The `claude` options in `HEADLESS_FLAGS` | `scripts/orchestrate.sh`, `judge-hook.mjs` | `flags`; a test fails when a script passes an option that list does not name |
| `--max-turns` and `--advisor`, which `claude --help` does not list | `judge-hook.mjs`, `scripts/orchestrate.sh` | Nothing: the help cannot confirm them |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `judge-hook.mjs`, `workerEnv()` in `src/judge.ts` | Tests check that it is set; `memory` checks that Claude Code still names it; nothing checks that Claude Code still honours it |
| [Hook](glossary.md#h) events and their payload fields (`agent_type`, `tool_input.subagent_type`, `background_tasks`, ...) | `.claude/hooks/` | `payload` checks that each field name is still in the program file; nothing checks a field's shape or an event; the probes in `docs/data/live-checks-*.md` were run by hand |
| The loaded plugin's workflow file | the installed or checkout plugin folder | `workflow` |
| The plugin being enabled, if you use it | `~/.claude/settings.json` | `plugin` (a note when it is off) |

## Limits

- The script finds a new built-in subagent, a dead switch and a removed option. Since 2.0.0 its `payload` check finds a hook payload field the hooks read that the program file no longer names; it does not find a field whose shape changed, or options the help does not list.
- For a changed payload: the hooks exit 0 on input they cannot read, so a gate can go quiet without an error. `npm run test-dashboard` and a headless run (`npm run native -- "task"`) show whether the gates still fire.
- The `memory` check (2.0.0) only finds that the program file still names `CLAUDE_CODE_DISABLE_AUTO_MEMORY`; nothing checks that Claude Code still honours it.
