# After a Claude Code update

Claude Code updates itself. Most updates change nothing here, but this repo relies on a few things Claude Code does, and an update can change one of them without any error. This page says what to run after an update, what each check means, and what the repo relies on. For anyone who keeps a checkout or the plugin installed.

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

- It calls no model. It runs `claude --version`, `claude --help`, `claude plugin ...` and two start-up requests ("How the built-in list is read" below).
- It prints one line per check, marked `ok`, `fixed`, `note` or `FAIL`. It exits 0 when no check failed, 1 when one did, and 2 on an unknown argument.
- It writes its result to `<CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/claude-update.json`.
- `ORCH_CLAUDE_BIN` names another `claude` binary.

| Check | Passes when | If it fails |
|---|---|---|
| `cli` | `claude --version` runs | Install Claude Code, or set `ORCH_CLAUDE_BIN` |
| `builtins` | Every built-in subagent type of the installed Claude Code is in `BUILTIN_AGENTS` | `--fix` blocks the new type on this machine at once. `--write-source` adds it to the repo; then run `npm run check` and release |
| `headless` | With `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` and `CLAUDE_CODE_FORK_SUBAGENT=0` Claude Code lists no subagent | The switches stopped working: headless runs can delegate to built-ins. `scripts/orchestrate.sh` needs another way to turn them off, for example `--disallowedTools "Agent(<type>)"` for each type |
| `flags` | Every option in `HEADLESS_FLAGS` (the options `scripts/orchestrate.sh` and the native judge pass) is in `claude --help` | An option was removed or renamed; change the script that passes it |
| `sdk` | The Agent SDK's patch number equals Claude Code's (0.3.N carries 2.1.N) | A note, not a failure: the [SDK pipeline](glossary.md#s) runs the older Claude Code the SDK carries. To match: `npm install @anthropic-ai/claude-agent-sdk@0.3.N && npm run check`. With no Agent SDK installed the check passes |
| `plugin` | The plugin, when installed, is at this checkout's version | An older installed version fails; `--fix` updates it. Not installed or disabled is a note, because the plugin is opt-in: `--enable` installs it from this checkout and turns it on |
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
- It updates an installed plugin that is older than this checkout. Restart Claude Code afterwards.

`--enable` installs the plugin from this checkout's marketplace when it is missing, and enables it when it is disabled. `--fix` never does that: whether the plugin is on is your choice, and an update check must not change it.

`--write-source` is for whoever maintains the repo. It adds the new types to `BUILTIN_AGENTS` in `.claude/hooks/builtin-agents.mjs` and to `permissions.deny` in `.claude/settings.json`, and runs `npm run build-plugin`. Then run `npm run check`, commit and release, so every install gets the list.

## What the repo relies on

| It relies on | Where | Checked by |
|---|---|---|
| The names of Claude Code's built-in subagent types | `builtin-agents.mjs`, `permissions.deny` | `builtins` |
| `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` and `CLAUDE_CODE_FORK_SUBAGENT` | `scripts/orchestrate.sh` | `headless` |
| The `claude` options in `HEADLESS_FLAGS` | `scripts/orchestrate.sh`, `judge-hook.mjs` | `flags`; a test fails when a script passes an option that list does not name |
| `--max-turns` and `--advisor`, which `claude --help` does not list | `judge-hook.mjs`, `scripts/orchestrate.sh` | Nothing: the help cannot confirm them |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `judge-hook.mjs`, `workerEnv()` in `src/judge.ts` | Tests check that it is set; nothing checks that Claude Code still honours it |
| [Hook](glossary.md#h) events and their payload fields (`agent_type`, `tool_input.subagent_type`, `background_tasks`, ...) | `.claude/hooks/` | Nothing automatic; the probes in `docs/data/live-checks-*.md` were run by hand |
| The plugin being enabled, if you use it | `~/.claude/settings.json` | `plugin` (a note when it is off) |

## Limits

- The script finds a new built-in subagent, a dead switch and a removed option. It does not find a hook payload that changed shape, or options the help does not list.
- For a changed payload: the hooks exit 0 on input they cannot read, so a gate can go quiet without an error. `npm run test-dashboard` and a headless run (`npm run native -- "task"`) show whether the gates still fire.
- Nothing checks that Claude Code still honours `CLAUDE_CODE_DISABLE_AUTO_MEMORY`.
