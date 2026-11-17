# Live probes, 1.6.1 slice k4: the SDK roles' sessions

Date: 2026-11-17. Claude Code 2.1.326, Agent SDK 0.3.326, Node 26. Checkout: release 1.6.0 (672518b) plus this slice's
change to `src/judge.ts` (which no probe below exercises: no probe ran a judged Bash command).

These close one item of 1.6.0's "Known and not fixed": its fixes to the SDK roles' options were probed live for the
triager only (`live-checks-2026-11-17.md`, Checks 1 to 3). Here each other role makes one real call.

## Method

`<scratch>/probe.mts` imports the repo's own runner (`makeRunAgent` from `src/agent.ts`) and passes it, through the
runner's `query` seam, a wrapper around the SDK's `query()`. The wrapper passes every option the runner builds on
unchanged and adds one: `maxBudgetUsd`, the dollar cap. It records the options the runner built, the session's init
message (`model`, `tools`, `mcp_servers`) and the result message (`total_cost_usd`, `modelUsage`). It refuses to run a
label twice.

- Working folder: `<scratch>/repo`, a fresh git repository with one empty commit (never this repo).
- Prompt: "Reply with the word ok and nothing else. Do not use any tool." (the MCP probe's prompt is given below).
- Each call: `PROBE_WT=<worktree> timeout 60 npx --no-install tsx <scratch>/probe.mts <label> <role> <scratch>/repo 0.08`,
  so the cap is 0.08 USD and the wall limit 60 s. Every role ran on its default model (`src/config.ts`), no override.
- "Connector" below means any tool or MCP server whose name carries `claude_ai` / `claude.ai` (account connectors appear
  as `mcp__claude_ai_<name>__<tool>`).

## Probes 1 to 5: one call per role

| Probe | Role | Model (init) | Tools in init | MCP tools | MCP servers | Connector | Result | Wall | Cost (USD) |
|---|---|---|---|---|---|---|---|---|---|
| 1 | explorer | claude-sonnet-5-5 | 3 | 0 | none | no | success, "ok", 1 turn | 10.7 s | 0.0077848 |
| 2 | verifier | claude-sonnet-5-5 | 4 | 0 | none | no | success, "ok", 1 turn | 4.9 s | 0.0091031 |
| 3 | writer | claude-opus-5-5 | 6 | 0 | none | no | success, "ok", 1 turn | 4.5 s | 0.0189179 |
| 4 | solo | claude-opus-5-5 | 6 | 0 | none | no | success, "ok", 1 turn | 4.0 s | 0.0190134 |
| 5 | planner | claude-fable-5-2 | 3 | 0 | none | no | success, "ok", 1 turn | 4.2 s | 0.0528224 |

Cap of each: 0.08 USD. Every role could be called alone; none needed anything but its prompt and a folder.

What the runner passed, for every role: `strictMcpConfig: true`, `mcpServers: {}`, `mcpServersDelivery: "initialize"`,
`settings: { agent: "", disableClaudeAiConnectors: true }`, `settingSources: ["project"]`, and the role's own tools.
The init tool lists match those tools (explorer and planner: Read, Glob, Grep; writer and solo add Edit, Write, Bash;
verifier has four).

Also seen: `modelUsage` of explorer, verifier, writer and solo has a `claude-haiku-5-5` entry besides the role's model:
Claude Code's session-title call, which 1.6.0 removed for the triager only (`title`; live-checks-2026-11-17.md, Check 2).
The planner's result had no haiku entry. Not a defect: it is the known cost of about 0.0002 USD per session.

**Answer.** Established for all five roles on Claude Code 2.1.326: no MCP tool, no MCP server and no account connector
reaches the session, and each runs on its configured model.

## Probe 6: a project MCP server with `ORCH_SDK_MCP=project`

`<scratch>/repo/.mcp.json` named one stdio server, `toy`: `command: "node"`, `args: ["<scratch>/toy-server.mjs",
"--arg=${PROBE_TOY_ARG}"]`, `env: { "TOY_VAR": "${PROBE_TOY_VALUE}", "TOY_LOG": "<scratch>/toy.log" }`. The toy server
(about 20 lines of Node) answers `initialize`, `tools/list` (one tool, `toy_ping`) and `tools/call`, and logs its argv,
the `TOY_VAR` it received and each method it was sent.

**Command.** `ORCH_SDK_MCP=project PROBE_TOY_ARG=argval42 PROBE_TOY_VALUE=envval42 PROBE_PROMPT="List the names of your
tools that start with mcp__ on one line, or reply none. Do not call any tool." PROBE_WT=<worktree> timeout 60 npx
--no-install tsx <scratch>/probe.mts mcp-verifier verifier <scratch>/repo 0.08`. Role: verifier (one of `MCP_ROLES`,
the cheapest). Cap 0.08 USD.

**Seen.**
- The runner passed `mcpServers` with the one key `toy` (read by `projectMcpServers` from `.mcp.json`), still with
  `strictMcpConfig: true` and `mcpServersDelivery: "initialize"`.
- Init: `mcp_servers: [{ name: "toy", status: "connected", source: "dynamic" }]`; 5 tools, the verifier's 4 plus
  `mcp__toy__toy_ping`; no connector.
- The server started. Its log: `argv: ["--arg=argval42"]`, `TOY_VAR: "envval42"`, then the methods `server/discover`,
  `initialize`, `notifications/initialized`, `tools/list`.
- The reply was `mcp__toy__toy_ping`; success, 1 turn, 6.0 s.

**Answer.** Established: with `ORCH_SDK_MCP=project` a worker starts the project's stdio server, its tool is listed, and
`${VAR}` is expanded in both `args` and `env` when the servers are delivered over `initialize`. No defect in
`src/agent.ts` was seen. Not covered: the `${VAR:-default}` form, an unset variable, and http or sse servers.

**Cost.** 0.0271721 USD.

## Total

| Probe | Cap (USD) | Cost (USD) |
|---|---|---|
| 1 explorer | 0.08 | 0.0077848 |
| 2 verifier | 0.08 | 0.0091031 |
| 3 writer | 0.08 | 0.0189179 |
| 4 solo | 0.08 | 0.0190134 |
| 5 planner | 0.08 | 0.0528224 |
| 6 verifier with `toy` | 0.08 | 0.0271721 |
| **Total** | | **0.1348137** |

Every call stayed under its cap and under a minute; the slice's limit was 0.50 USD.
