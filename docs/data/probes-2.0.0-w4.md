# Probes of slice w4 (2.0.0), 2026-11-17

Claude Code 2.1.326, Agent SDK 0.3.326, Linux. Every paid call was started with a dollar cap. Total: **0.0273086 USD**
of the 0.30 USD allowed.

| # | What | Command | Cap | Cost |
|---|---|---|---|---|
| 1 | Item 8: `${VAR:-default}` and an unset `${VAR}` in a project's `.mcp.json`, SDK pipeline with `ORCH_SDK_MCP=project` | below | 0.08 USD (`maxBudgetUsd`, `maxTurns: 2`, `timeout 60`) | 0.0273086 USD |
| 3 | Item 6: `claude plugin validate` and `claude plugin test` without a login (CI) | below | none needed: no model call | 0 |
| 2 | Items 4 and 5: `node scripts/claude-update.mjs --json` on this machine | `node scripts/claude-update.mjs --json` | none needed: no model call (safe-mode start-up request, `--help`, `plugin list`, a read of the program file) | 0 |

## Probe 1: `.mcp.json` variable forms (item 8)

Setup, as in docs/data/live-checks-2026-11-17-b.md, Probe 6: a scratch git repository whose `.mcp.json` names one
stdio server, `toy` (a 20-line server with one tool, `toy_ping`, that logs its argv and `TOY_*` environment):

```json
{"mcpServers":{"toy":{"type":"stdio","command":"node","args":["<scratch>/toy-server.mjs","--arg=${PROBE_TOY_ARG:-defaultarg}"],
 "env":{"TOY_SET":"${PROBE_TOY_VALUE:-envdefault}","TOY_UNSET":"${PROBE_UNSET_VAR_W4}"}}}}
```

`PROBE_TOY_ARG`, `PROBE_TOY_VALUE` and `PROBE_UNSET_VAR_W4` unset. One verifier call through `makeRunAgent` of this
branch's `src/agent.ts`, with a `query()` wrapper that adds `maxBudgetUsd: 0.08` and `maxTurns: 2` and prints the init
event: `ORCH_SDK_MCP=project timeout 60 npx --no-install tsx <scratch>/probe.mts <worktree> <scratch>/repo 0.08`.
Prompt: "List the names of your tools that start with mcp__ on one line, or reply none. Do not call any tool."

Seen:

- The runner passed `mcpServers` exactly as written (`${...}` unexpanded), with `strictMcpConfig: true`.
- Init event: `mcp_servers` `[{"name":"toy","status":"connected","source":"dynamic"}]`, tools `["mcp__toy__toy_ping"]`.
- The server's log: `{"argv":["--arg=defaultarg"],"env":{"TOY_SET":"envdefault","TOY_UNSET":"${PROBE_UNSET_VAR_W4}"}}`.
- Reply `mcp__toy__toy_ping`; result `success`; cost 0.0273086 USD; 7989 tokens.

Reading: Claude Code expands `${VAR:-default}` to the default, in `args` and in `env`, for servers passed through the
SDK's `mcpServers`. An unset `${VAR}` with no default is not an error and not an empty string: the server gets the text
`${PROBE_UNSET_VAR_W4}` itself, and the session still lists the server as connected. `src/agent.ts` passes the file as
written, so it neither causes nor hides this; no change was made there (a refusal of such a server would be a new
behaviour of the frozen pipeline). Not covered: http and sse servers, `${VAR}` inside `command` or a URL.

## Probe 2: the new `claude-update` checks on this machine (items 4 and 5)

`payload` ok (all 13 fields named in `<claude program file>`, the native install's versioned binary), `memory` ok
(`CLAUDE_CODE_DISABLE_AUTO_MEMORY` named there), `workflow` FAIL: the loaded plugin is the 1.2.2 install in
`<config dir>/plugins/cache/...` (the plugin list's `readFromFolder` is the main checkout, not this worktree, so the
cached install counts), whose `workflows/orchestrate.js` differs from the content the 1.6.1 guard expects; `plugin`
fails on the same install (1.2.2 against 1.6.1). The run also rewrote the record `<config dir>/orchestration/claude-update.json`,
as every run of the script does.

## Probe 3: the dashboard test without a login (item 6, CI)

Question: can CI, which has no Claude login, run `npm run test-dashboard`? That script builds a folder from
`dist/dashboard` plus `dashboard/register.tsx`, `dashboard/types/index.d.ts`, `dashboard/register.test.tsx` and the
brief fixtures (bundled into `fixtures/fixtures.ts`), then runs `claude plugin validate <dir>` and `claude plugin test <dir>`.
The probe built the same folder (its copy steps, in a scratch script) and ran each command alone, with the login hidden:
`env -i PATH="$PATH" HOME=<empty scratch folder>`, so no `~/.claude`, no `~/.claude.json`, no `ANTHROPIC_API_KEY`
and no `CLAUDE_CONFIG_DIR`; each under `timeout 120`. Claude Code 2.1.326.

| Command | Login | Exit | Time | Printed (last lines) |
|---|---|---|---|---|
| `claude plugin validate <dir>` | none | 0 | 18 s | the plugin directory notes, then `✔ Validation passed` |
| `claude plugin test <dir>` | none | 0 | 99 s | `119 pass`, `0 fail`, `Ran 119 tests across 1 file. [96.02s]` |
| `claude plugin test <dir>` | the machine's | 0 | 91 s | `119 pass`, `0 fail`, `Ran 119 tests across 1 file. [89.76s]` |
| `claude plugin test <copy of dist/dashboard alone>` | none, and the machine's | 1 | 1-2 s | `no *.test.ts or *.test.tsx under <dir>` |

The no-login runs wrote only `.claude/` and `.claude.json` (first-start state) into the empty HOME. Reading: neither
command needs a login. The first attempt's "no result in 120 s" came from running the whole `scripts/test-dashboard.mjs`
(validate, 18 s, plus test, about 99 s) under one 120 s limit, not from a missing login. CI now installs the CLI
(`npm install -g @anthropic-ai/claude-code@2.1.326`, the version the Agent SDK 0.3.326 carries; `npm view` lists it)
and runs `npm run test-dashboard` after `npm run check`, with no `continue-on-error`. The step is not run on a CI
runner here (no push).
