# Logs and reports

This page says where the hooks and scripts log, what each log holds, and how `npm run report` and a headless run turn them into something to read. It is for maintainers who debug a run or read its cost. The gates that write most of these records are in [gates.md](gates.md).

The logs hold parsed fields, counts and paths. They never hold brief or [reply](glossary.md#r) text, with one exception: `telemetry.jsonl` keeps hook payload strings clipped to 300 characters ([Telemetry](#telemetry)).

## Where logs go

The hooks log to one folder, the [state dir](glossary.md#s). `.claude/hooks/state.mjs` decides which; `verify.sh` follows the same rule in bash.

| Hooks | State dir |
|---|---|
| The project copy (registered in the project's `.claude/settings.json`) | `<project>/.claude/state/`. It writes a `.gitignore` there on first write. |
| The plugin copy (`hooks.json` runs every hook with `--plugin`) | A per-user folder outside the repo, because the logs hold parts of subagent payloads: `$CLAUDE_PLUGIN_DATA/state/<key>`, or `~/.claude/orchestration/state/<key>` where Claude Code does not set `CLAUDE_PLUGIN_DATA`. |

The key is the project path with every byte that is not a letter or digit replaced by `-`, cut to its last 200 characters.

**Plugin and project copy together.** With the plugin installed in a repo that registers its own copy of the hooks (this repo, or one with `.claude/` copied in), both copies would fire on every event. That would double telemetry and let two review gates count each other's blocks. So:
- a plugin hook exits at once when the project's settings register the same script (`duplicate()` in `state.mjs`), and the project copy does the work;
- a plugin hook the project does not register logs to the project's `.claude/state/` too, so every gate reads one log;
- `verify.sh` needs no such check: the project matcher `^implementer$` and the plugin's `orchestration:implementer` never match the same agent.

**Not in the state dir.** The native Bash judge keeps the prompts the person typed in `<CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/judge-prompts/<key>/prompts.jsonl` (folder 0700, file 0600), outside the project; see [bash-judge.md, Native hook](bash-judge.md#native-hook). Headless runs log `runs.jsonl` to the target folder's `.claude/state/` (below).

## Log files

| File | Written by | One record per | Holds |
|---|---|---|---|
| `gates.jsonl` | `verify.sh`, `review-gate.mjs`, `researcher-guard.mjs`, `egress-guard.mjs`, `handback-check.mjs`, `judge-hook.mjs` | gate decision | `gate` (`test`, `review`, `researcher`, `egress`, `handback`, `judge`), `decision`, `reason`, ids, counts. The researcher guard logs the first word of a refused command; the egress guard the host only; the native judge the command's first 200 characters. |
| `plan-check.jsonl` | `plan-check.mjs` | implementer, fork or built-in launch | decision, reason, slice, FILES, DEPENDS, agent type, the run it was scoped to, give-ups and skips |
| `journal-launches.jsonl` | `journal.mjs`, PostToolUse on `Agent\|Task` | worker launch | the launch record ([Journal](#journal)) |
| `journal.jsonl` | `journal.mjs`, SubagentStop | implementer or reviewer stop | the stop record ([Journal](#journal)) |
| `journal-pending.jsonl` | `journal.mjs` | foreground stop waiting for its launch | a stop's status, constraint answers and OPEN, until its launch record arrives |
| `telemetry.jsonl` | `telemetry.mjs`, SubagentStart and SubagentStop | agent start or stop | [Telemetry](#telemetry) |
| `handbacks.jsonl` | `handback-check.mjs` | hand-back | the parsed fields of a delivered reply ([Hand-back capture](#hand-back-capture)) |
| `handback-refusals.jsonl` | `handback-check.mjs`, `quote-check.mjs` | refused hand-back | which hand-back was sent back |
| `quotes.jsonl` | `quote-check.mjs` | researcher stop or hand-back | `agent_id`, slice, counts (total, verified, unverified, unverifiable, blocked) and the paths of unverified quotes |
| `reads.jsonl` | `read-log.mjs` | Read or WebFetch call | [Read log](#read-log) |
| `reads-route.jsonl` | `plan-check.mjs` (read router) | routed researcher launch | tier, models, reason codes, counts, paths |
| `model-floor.jsonl` | `plan-check.mjs` | haiku launch raised to sonnet | agent type, and where the model came from |
| `skills.jsonl` | `plan-check.mjs` | skill suggestion decision | role, slice, skill names, reason codes, counts |
| `skill-create.jsonl` | `plan-check.mjs` | skill-slice decision or DRAFTS lookup | decision, reason, skill name, target, paths, slice, run |
| `skill-gate.jsonl` | `skill-gate.mjs` | skill slice stop | decision, reason, failed reason codes |
| `workflow-guard.jsonl` | `workflow-guard.mjs` (1.6.0) | Workflow launch | `gate: "workflow"`, decision (`allow` or `deny`), reason, the workflow name (at most 80 characters), the input's key names, ids; never the script or the arguments ([Workflow guard](gates.md#workflow-guard)) |
| `routes.jsonl` | `src/route.ts` (triage) | triage decision | the task (first 200 characters), the route, its reason and the triage facts |
| `runs.jsonl` | `scripts/log-run.mjs` | headless run | [Headless run results](#headless-run-results) |

**Where `routes.jsonl` goes.** `src/route.ts` uses the same rule as the hooks: `<folder>/.claude/state/` in a folder that registers its own telemetry hook, the per-user state dir otherwise. The `/route` skill passes `CLAUDE_PLUGIN_DATA` through, so that is the hooks' folder. `npm run auto` passes `--project-state`, so its `routes.jsonl` sits beside `runs.jsonl` in the target folder.

Other files in the state dir:
- `baseline-cache.json`: the test baseline's base results, per base commit, command and run folder.
- `read-cache/`: the read router's text conversions, keyed by path, size and mtime.
- `skill-catalog.json`: the cached list of installed skills.
- `turn-warnings/`: one marker per worker that got the turn warning.
- `test-gate.lock`: the test gate's suite lock, while a gate holds it ([gates.md, Time budget and suite lock](gates.md#time-budget-and-suite-lock)).
- `report.html`: the run report, when `npm run report` writes it here.

## Journal

`journal.mjs` writes the run's [journal](glossary.md#j): parsed fields only, never brief or reply text. The gates fold it into runs ([brief-grammar.md, Log records](brief-grammar.md#log-records) has the exact fields).

- **Launch record** (`journal-launches.jsonl`, at PostToolUse on `Agent|Task`), for every launch of an implementer, reviewer, researcher or integrator: `agent_id`, bare `agent_type`, `slice` (a brief starting with PLAN REVIEW is slice `plan`), the parsed header, the reviewer's model, `isPlanReview`, `replan`, and for a PLAN REVIEW brief the parsed plan.
- **Stop record** (`journal.jsonl`, at SubagentStop of an implementer or reviewer): `slice`, `status`, the constraint answers, OPEN and `run`. Also `draft`, `skills_used` and `skills_skipped` when the reply has those lines.
- **`continues: true`** marks a second stop record of one reply: written when `stop_hook_active` is true and the agent already has a stop record. The fold counts that review once.
- **Order.** A foreground agent stops before its PostToolUse, so a stop with no launch yet waits in `journal-pending.jsonl` and is written when its launch arrives.
- **Headless runs** keep no subagent transcript, so the slice is taken from the launch record with the same `agent_id`.
- A resumed orchestrator reads `journal.jsonl` and skips slices whose last review passed.

### File trail

An implementer's stop record also carries `files_touched` and `files_source`:
- `tools`: from its tool calls, in the [shared folder](glossary.md#s);
- `tools+git`: tool calls plus git, in an isolated worktree;
- `git`: from git alone, in an isolated worktree without a transcript.

It is never taken from the reply. Unknown, or on any error, both fields are left out.

## Telemetry

[Telemetry](glossary.md#t) is one record per SubagentStart and SubagentStop in `telemetry.jsonl` (`.claude/hooks/telemetry.mjs`). The review gate reads it to see which agents run and how reviews ended.

**Status.** At SubagentStop it records the worker's STATUS (`parseStatus`), taken from the first of these that exists:
1. the hand-back capture newer than this agent's previous stop record (`handbackFor` in `state.mjs`);
2. `last_assistant_message` of the stop payload;
3. the last text block or `SubagentHandback` message in the agent's transcript.

**Payload.** The record keeps the hook payload, with each string clipped to 300 characters. The worker's last message is one of those strings. The run-model logs (the journal, `gates.jsonl`, `handbacks.jsonl`) hold parsed fields only.

**Usage**, read at SubagentStop from the agent's transcript (`agent_transcript_path`). Numbers and model names only:

| Field | What it is |
|---|---|
| `tokens.input`, `output`, `cache_read`, `cache_write` | Each the maximum over the lines of one message id, summed over messages. Harness-made `<synthetic>` messages are skipped. |
| `tokens.cache_write_1h` | The part of the cache writes at the one-hour lifetime. |
| `turns` | Distinct assistant message ids. |
| `models` | The models the agent ran on. |
| `max_turns_hit` | How the transcript ends when the stop hook reads it. |
| `cache_rewrites` | `{ requests, tokens }`: requests after the agent's first that wrote at least 20,000 tokens to the cache while reading less than a quarter of that from it (a cache that went cold mid-run). |

A missing transcript leaves these fields out.

**Headless runs.** They pass `--no-session-persistence` by default and keep no subagent transcripts, so the usage fields are empty there. `ORCH_SESSION_PERSISTENCE=1` makes `scripts/orchestrate.sh` drop that flag, for `npm run native`, every session `npm run auto` starts, and bench runs that use the script (the `reader-*` bench arms set it). Transcripts are then written under `~/.claude/projects/` (one per session) and the fields fill in ([live-checks-telemetry.md](data/live-checks-telemetry.md)). The triage call of `npm run auto` and `npm run route` follows the same switch: without it, it writes no transcript ([live-checks-2026-11-16.md](data/live-checks-2026-11-16.md), Check 10).

## Hand-back capture

In auto mode a worker delivers its reply through the `SubagentHandback` tool. The stop payload of such a hand-back carries no `last_assistant_message`, and the transcript does not hold the reply yet. So `handback-check.mjs` captures the reply's parsed fields at the hand-back:
- in `handbacks.jsonl` (`recordHandback` in `state.mjs`), never reply text;
- for any agent with an agent id, before it reads its own switch, so with the [report check](gates.md#report-check) off too;
- the log is never cleared.

At SubagentStop `journal.mjs` and `telemetry.mjs` take the latest capture newer than their own previous stop record of that agent (`handbackFor`), else `last_assistant_message` and the transcript.

**Refused captures are skipped.** A hand-back the report check or the quote check sent back is marked in `handback-refusals.jsonl`. `handbackFor` skips it: matched by `tool_use_id` in either write order, or, without an id, the latest capture written before the refusal. So a worker that is sent back and then stops with a plain text reply is recorded with that text reply, not the one it never delivered.

## Read log

`read-log.mjs` (PostToolUse on `Read|WebFetch`) writes one line per call to `reads.jsonl`:
- **Read:** agent, path (relative inside the project), extension, size, pages, and kind (`text`, `code`, `pdf`, `image`, `notebook`, `office` or `other`).
- **WebFetch:** the host only, no path, query or prompt.

It never logs content and never blocks.

## Run report

`npm run report` renders the logs as `report.html`, a local file. Nothing is published.

```sh
npm run report                    # this repo's logs
npm run report -- /path/to/repo   # another folder's logs
```

**Which logs it reads.** Each log comes from the first folder that has it: `<repo>/.claude/state/`, then the per-user folders for that repo (`$CLAUDE_PLUGIN_DATA`, each `~/.claude/plugins/data/orchestration-*`, then `~/.claude/orchestration`). A terminal has no `CLAUDE_PLUGIN_DATA`, hence the list. A repo whose `.claude/state/` holds every log reads nothing else. A headless run with the plugin's agents splits them: `runs.jsonl` and `routes.jsonl` in the folder, the agent events and gate decisions in the per-user folder.

**Where it writes.** In the first folder that holds `telemetry.jsonl` or `runs.jsonl`, else `routes.jsonl` or `gates.jsonl`. So a plugin install's report stays out of the repo. The page names the folder each log came from.

**What it shows.**
- The runs, the agent events, and the triage and gate decisions: event and agent names, statuses and gate reasons, never the payloads.
- A table per role: agents, stops with usage, tokens by kind, turns, models and max-turn hits. Each record is a running total, so each agent counts once, from its last stop record.
- The agents that started and never stopped (a turn-limit stop fires no SubagentStop). Shown as `true` when the transcript ends on the last tool result with no assistant message after it and the turns reached the role's maxTurns; `null` when it cannot tell.
- An estimated cost by role and model, at the list prices in `scripts/prices.mjs` (`PRICES_AS_OF`). It is an estimate for comparing roles and models, not a bill.
- Reads by kind and role.
- A Skills section, only when the logs name a skill (`skills.jsonl`, `journal.jsonl`, `skill-create.jsonl`, `skill-gate.jsonl`). The skills of a stop record with `continues: true` replace the earlier record's, so one reply counts once.

## Headless run results

`npm run native` and `npm run auto` run `claude -p` through `scripts/orchestrate.sh` ([native-mode.md, Headless runs](native-mode.md#headless-runs)).

**Why the event stream.** `claude -p` answers once per wake-up. An orchestrator that waits for workers stops, is woken by each result and stops again, and every stop is a result of its own. `--output-format json` prints only the last one. So `orchestrate.sh` reads the event stream (`--output-format stream-json --verbose`) and `scripts/run-result.mjs` reduces it to one document: the last result plus `orch_totals`.

| `orch_totals` field | What it is |
|---|---|
| `results` | How many results the session produced (1 when it never waited for a worker). |
| `turns` | `num_turns` summed over every result. |
| `wall_ms` | Wall time measured by the script. |
| `exit_code` | claude's exit code. Left out when it is unknown. |
| `complete` | True only when that exit code is 0. A run cut short still ends with a result, but an interim one. Left out when the exit code is unknown. |

Every other field is the last result's. `result` is the final text; `modelUsage` and `total_cost_usd` already cover the whole session.

**A run with no result.** When claude crashed or was killed after start-up, the stream has no result record. `run-result.mjs` then prints a document of its own: `type` `result`, `subtype` and `terminal_reason` `no_result`, `is_error` true, and `orch_totals` with `results` 0, the turns seen, `wall_ms`, `exit_code` when known, and `complete` false.

**What is printed.**
- In a terminal: the result text and one totals line, for example `turns 41, 723 s, exit 0` (an unknown value prints as `?`).
- Piped or captured (`auto.sh`, the benchmark, `jq`): the JSON document.

**`runs.jsonl`.** `scripts/log-run.mjs` appends one line per headless run to `<target folder>/.claude/state/runs.jsonl`:

| Field | What it is |
|---|---|
| `ts`, `task` | When, and the task (first 200 characters) |
| `ok` | The result parsed and `is_error` is false |
| `tokens`, `usage` | Input + output + cache read + cache write over every model, and that breakdown |
| `duration_ms`, `turns` | From `orch_totals` (`wall_ms`, `turns`), else the document's own `duration_ms` and `num_turns` |
| `terminal_reason` | From the document; `no_result` for a crashed run, `unparsed output` when it was not JSON |
| `subagents` | Counts by agent type |
| `result` | The first 300 characters of the result |
| `exit_code`, `complete` | As in `orch_totals`, else from the exit code |

A crashed run is logged with its wall time and the turns seen.

**Checked live** on 2026-11-14 with Claude Code 2.1.325: a session with one background agent printed two results (2 turns, then 1). Before the event stream was used, a run with three agents had logged 1 turn and 8 s for 2 minutes of work.

## Limits

- Headless runs keep no subagent transcripts by default, so telemetry's token, turn and model fields are empty there unless `ORCH_SESSION_PERSISTENCE=1` is set. The cost of setting it is one transcript per session under `~/.claude/projects/`, the triage call's included.
- A worker that stops at its turn limit fires no SubagentStop, so `max_turns_hit` cannot see it. The report lists agents that started and never stopped instead.
- A quote-check refusal without a `tool_use_id` in its payload, that finishes before `handback-check.mjs` writes its capture, is not tied to that capture.
- `telemetry.jsonl` keeps clipped payload strings, the worker's last message included, so it can hold up to 300 characters of a reply.
