# After a Claude Code update

Claude Code updates itself. Most updates change nothing here, but this repo relies on a few things Claude Code does, and an update can change one of them without any error. This page lists what the repo relies on, what went wrong on 2026-11-14, and the script that checks all of it.

## What happened on 2026-11-14

Claude Code went from 2.1.323 to 2.1.325 on its own. Two things changed underneath this repo.

- **A new built-in subagent, `web-fetch`.** The gates track only this repo's researcher, implementer, reviewer and integrator, so Claude Code's own subagents are blocked while a run is open. The block list named six types by hand, in three places. `web-fetch` was in none of them: the plan check took it for somebody's own agent and let it through, and this repo's `permissions.deny` did not deny it.
- **Auto memory in inner calls.** Claude Code's auto memory was on in every `claude -p` call the native judge makes and in the SDK workers. Each judge call left an empty `~/.claude/projects/<temp folder>/memory` folder and carried the auto-memory instructions in its prompt. An SDK worker could write memory notes under the project folder of its throwaway worktree.

Headless runs were not affected by the first one: `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1`, which `scripts/orchestrate.sh` exports, still removed every built-in, `web-fetch` included.

Both are fixed in 1.2.2. The built-in names now live in one file, `.claude/hooks/builtin-agents.mjs`, and the inner calls run with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`.

## The check

```sh
npm run claude-update                      # check only; exit 1 when something needs attention
npm run claude-update -- --fix             # also repair this machine
npm run claude-update -- --enable          # install and enable the plugin when it is off
npm run claude-update -- --write-source    # maintainer: also update the block list in the repo
npm run claude-update -- --json            # the result as JSON
```

It calls no model. It runs `claude --version`, `claude --help`, `claude plugin ...` and two start-up requests (below), and writes its result to `~/.claude/orchestration/claude-update.json`.

| Check | Passes when | If it fails |
|---|---|---|
| `cli` | `claude --version` runs | Install Claude Code, or set `ORCH_CLAUDE_BIN` |
| `builtins` | Every built-in subagent type of the installed Claude Code is in `BUILTIN_AGENTS` | `--fix` blocks the new type on this machine at once. `--write-source` adds it to the repo; then run `npm run check` and release |
| `headless` | With `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` and `CLAUDE_CODE_FORK_SUBAGENT=0` Claude Code lists no subagent | The switches stopped working: headless runs can delegate to built-ins. `scripts/orchestrate.sh` needs another way to turn them off, for example `--disallowedTools "Agent(<type>)"` for each type |
| `flags` | Every documented option `scripts/orchestrate.sh` and the native judge pass is in `claude --help` | An option was removed or renamed; change the script that passes it |
| `sdk` | The Agent SDK's patch number equals Claude Code's (0.3.N carries 2.1.N) | A note, not a failure: the SDK pipeline runs the older Claude Code the SDK carries. `npm install @anthropic-ai/claude-agent-sdk@0.3.N && npm run check` |
| `plugin` | The plugin, when installed, is at this checkout's version | An older installed version fails; `--fix` updates it. Not installed or disabled is a note, because the plugin is opt-in: `--enable` installs it from this checkout and turns it on |
| `dist` | `npm run check-plugin` passes | `npm run build-plugin` |

### How the built-in list is read

The script starts `claude -p --safe-mode --input-format stream-json --output-format stream-json` in an empty temp folder and writes one line to it: the `initialize` control request, the same one the Agent SDK sends when a session starts. Claude Code answers with its version and the subagent types that exist. In safe mode every customization is off, so the answer holds built-ins only. The script then closes the input. No prompt is sent, so no model runs and nothing is billed.

It asks twice: once as it is, for the `builtins` check, and once with the two headless switches set, for the `headless` check.

### What `--fix` and `--write-source` change

`--fix` changes this machine only:

- It writes the built-in types that are not in `BUILTIN_AGENTS` to `~/.claude/orchestration/builtin-agents.json`. `builtinAgents()` in `builtin-agents.mjs` adds that file's names to the list every time the plan check runs, so the new type is blocked from the next launch on, with no new release and no restart. The file can only add plain names, never one of this plugin's own agents, so the worst a wrong file can do is block a type twice before the loop guard lets it through.
- It updates an installed plugin that is older than this checkout. Restart Claude Code afterwards.

`--enable` installs the plugin from this checkout's marketplace when it is missing and enables it when it is disabled. `--fix` never does that: whether the plugin is on is your choice, and an update check must not change it.

`--write-source` is for whoever maintains the repo. It adds the new types to `BUILTIN_AGENTS` in `.claude/hooks/builtin-agents.mjs` and to `permissions.deny` in `.claude/settings.json`, and runs `npm run build-plugin`. Then run `npm run check`, commit and release, so every install gets the list.

## What the repo relies on

| It relies on | Where | Checked by |
|---|---|---|
| The names of Claude Code's built-in subagent types | `builtin-agents.mjs`, `permissions.deny` | `builtins` |
| `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS` and `CLAUDE_CODE_FORK_SUBAGENT` | `scripts/orchestrate.sh` | `headless` |
| The `claude` options in `HEADLESS_FLAGS` | `scripts/orchestrate.sh`, `judge-hook.mjs` | `flags`; a test fails when a script passes an option that list does not name |
| `--max-turns` and `--advisor`, which `claude --help` does not list | `judge-hook.mjs`, `scripts/orchestrate.sh` | Nothing: the help cannot confirm them |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `judge-hook.mjs`, `workerEnv()` in `src/judge.ts` | Tests check that it is set; nothing checks that Claude Code still honours it |
| Hook events and their payload fields (`agent_type`, `tool_input.subagent_type`, `background_tasks`, ...) | `.claude/hooks/` | Nothing automatic; the probes in `docs/data/live-checks-*.md` were run by hand |
| The plugin being enabled, if you use it | `~/.claude/settings.json` | `plugin` (a note when it is off) |

The last two rows without a check are the limit of this script: it finds a new built-in subagent, a dead switch and a removed option, but not a hook payload that changed shape. For that, the hooks exit 0 on input they cannot read, and `npm run test-dashboard` and a headless run (`npm run native -- "task"`) show whether the gates still fire.
