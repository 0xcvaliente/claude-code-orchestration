# Brief and reply grammar

Normative spec for the lines the orchestrator writes in its briefs, the lines workers write in their replies, and the run model the hooks and the dashboard derive from them. One implementation: `.claude/hooks/brief.mjs` (ESM, Node built-ins only, no side effects at import). Fixtures for every form are in `src/fixtures/briefs/` with their parse results in `expected.json`; `src/brief.test.mjs` checks both and each rule below.

Every parser takes any value and never throws: empty, malformed or non-string input gives `null`, `[]`, `{}` or `false`. Briefs, plans and replies written before this spec (no `RISKY`, `CHECKS`, `REPLAN`, `CONSTRAINTS` or plan slice lines) parse to those empty values, so a check that needs them can skip.

## Line rule

A field is a line `KEY: value`. Before the key a line may carry list, quote and emphasis characters (`- `, `> `, `*`, `_`, backticks); after the colon, `*` (so `- **SLICE:** s1` works). Keys are case-insensitive. For a header field the first matching line anywhere in the brief wins, which is the rule `plan-check.mjs` uses today, so header lines go at the start of the brief, before any body text or quoted plan that could repeat a key. A key in the middle of a line does not count.

Lists (`FILES`, `DEPENDS`) are comma-separated; each entry is trimmed, loses outer quotes or backticks and a leading `./`; empty entries and `none` are dropped. A slice id is the first word of the value without quotes, backticks or `*`. `CHECKS` keeps the `C<n>` tokens, upper-cased, deduplicated, in order.

## Implementer brief

```
SLICE: auth
FILES: src/auth.ts, src/session/
DEPENDS: A0, A1
PATH: light          (optional: the single-slice light path)
RISKY: yes           (optional: anything else, or no line, is not risky)
CHECKS: C1, C3       (optional: constraint ids this slice must satisfy)
```

`SLICE`, `FILES` and `DEPENDS` are required by the plan check; `PATH` is `light` when its value starts with the word `light`. A brief with a line `ORCHESTRATION: workflow` (the scripted workflow) is skipped by the plan check and by the run model.

`parseHeader(text)` returns `{ slice, files, depends, path: 'light'|null, risky, checks, focus, workflow }`.

## PLAN REVIEW brief

The brief starts with `PLAN REVIEW` (leading whitespace allowed, upper case). It is the plan reviewer's brief; its journal slice is `plan`.

```
PLAN REVIEW
REPLAN: 1                      (optional: extends the open run)
CONSTRAINTS:
C1: parsing never throws on malformed input
C2: no new dependencies
SLICE: toml
FILES: toolkit/toml.py, tests/test_toml.py
DEPENDS: none
GOAL: TOML reader
CHECKS: C1, C2
SLICE: csv - CSV reader        (text after the id is the goal)
FILES: toolkit/csv.py
DEPENDS: toml
RISKY: yes
CHECKS: C2
```

- `REPLAN: <n>`: a non-negative integer, else `null`.
- Constraints block: a line `CONSTRAINTS:` followed by lines `C<n>: <text>` (prefix characters allowed, blank lines inside the block allowed). The first line that is neither ends the block. Ids are upper-cased; a repeated id keeps its first text; an empty text is dropped.
- Planned slices: each `SLICE:` line (a `#` heading prefix is also allowed here) starts a slice; the `FILES`, `DEPENDS`, `GOAL`, `RISKY` and `CHECKS` lines up to the next `SLICE:` fill it. The id loses trailing `:,;.`; the id `plan` is not a slice. Text after the id is the goal, else the first `GOAL:` line. A repeated id continues its first entry. This matches `planOf` in `dashboard/register.tsx`.
- Text that does not start with `PLAN REVIEW` is not a plan: `parsePlan` returns `{ isPlanReview: false, replan: null, constraints: {}, slices: [] }`. A plan review without slice lines has `slices: []`.

`parsePlan(text)` returns `{ isPlanReview, replan, constraints: { C1: text }, slices: [{ slice, files, depends, goal, risky, checks }] }`.

## Reviewer brief

```
SLICE: toml
FOCUS: the error path on malformed input   (optional, for the reviewer only)
CHECKS: C1, C2                             (optional: answer one line per id)
```

Parsed by `parseHeader` (`focus`, `checks`).

## Reply

```
STATUS: pass
C1: pass (cmd) npm test -> 42 pass, 0 fail
C2: pass (read) package.json:12
C3: fail parse('[') throws SyntaxError
OPEN: none
```

**STATUS** (same rule as `scripts/auto.sh`'s reviewed route, documented in README): a STATUS line is a line that starts with `STATUS: pass` or `STATUS: fail` after whitespace, emphasis or heading characters (`**STATUS: pass**`, `## STATUS: fail`). These are not STATUS lines: a blockquoted line (`> STATUS: pass` is a quote), a STATUS in the middle of a line, and the template `STATUS: pass or fail`. Any STATUS line that says fail fails; otherwise the first one decides; no STATUS line is no status (`null`). Note: `journal.mjs`, `telemetry.mjs` and the dashboard take the last STATUS line today and count blockquotes; switching them to `parseStatus` changes that.

**OPEN**: the first non-quoted `OPEN:` line. Its inline value is one item; the list lines right below it (`-`, `*`, `+`, `1.`) are one item each, up to a blank line after an item or the first line that is not a list line. Empty, `none`, `-`, `n/a` and `nothing` (case-insensitive, trailing `.` allowed) mean nothing open.

**Answers**: one line per checked id, not quoted:

| Form | Meaning |
|---|---|
| `C1: pass (cmd) <command> -> <result>` | ran a command; `→` is accepted and read as `->` |
| `C1: pass (read) <file:line or URL>` | checked by reading |
| `C1: fail <reason>` | not met |

Ids are upper-cased. The first line for an id decides, except that a later `fail` line for it overrides a pass. The template `C1: pass or fail` is not an answer.

`parseReply(text)` returns `{ status, open: string[], answers: { C1: { verdict: 'pass'|'fail', mode: 'cmd'|'read'|null, detail } } }`; `parseStatus(text)` returns the status alone.

## Run model

A run belongs to one session. It is computed only from the log records below (no hook logs a raw prompt or reply): `foldRuns({ launches, stops, gates, starts }, { now, staleMin, sessionId })` merges the four files into one timeline (see Ordering under Log records).

- **Open.** A PLAN REVIEW launch record (reviewer, `isPlanReview`) without `replan` opens a planned run and closes any run open in the session. A light-path implementer launch (`path: "light"`) opens a light run when no run is open. A PLAN REVIEW with `replan` extends the open run with its `plan.slices` and `plan.constraints` (with no run open it opens one). Other implementer launches join the open run; with none open they are not tracked. Launches with `workflow: true` are skipped. A new user prompt does not close a run.
- **Attempts.** A retry may be a fresh implementer launch or a `SendMessage` resume of the same agent, which makes no launch. So attempts of a slice are counted from its implementer stop records (slice joined by `agent_id`), fresh launches and resumes alike. Stops with no review of the slice between them count as one attempt (a test-gate block makes the agent stop again).
- **Final slice.** A slice is final when its latest review (a reviewer stop after the slice's latest implementer launch or stop) passed, or failed for good: its latest review failed after 3 implementer attempts in the run (`MAX_RETRIES` 2). A review with no STATUS is neither.
- **Closed run.** A planned run closes when every planned slice is final; a light run closes when its slice is final.
- **Stale run.** A run is stale when nothing of it is running and no launch, stop or agent start happened in it for `ORCH_RUN_STALE_MIN` minutes (default 30). Running agents come from the `starts` input (telemetry.jsonl SubagentStart and SubagentStop records, which every agent emits): an agent runs from its SubagentStart to its next SubagentStop, or journal stop record, with the same `agent_id`; a resumed agent starts again under its id. A start belongs to the open run; a start after the run was idle for the threshold marks it stale instead of reviving it. So a long foreground worker, whose launch record is written only when it ends, never makes its run look idle. Without `starts`, staleness depends on launches and stops alone. A lost SubagentStop keeps the run from going stale until a new PLAN REVIEW closes it or the session ends (the review gate's own running check ignores starts older than the threshold). The plan check treats a stale run as closed (so a light launch opens a new run); the review gate keeps gating its unreviewed slices. A stop that arrives later (a long worker) still lands in the latest run that has its slice.

## Reviewer model

The model of a reviewer launch is `tool_input.model` when given; otherwise the `model:` line in the frontmatter of the agent definition (project `.claude/agents/<bare name>.md`, else `${CLAUDE_PLUGIN_ROOT}/agents/<bare name>.md`); otherwise unknown, which is not opus. A model counts as opus when its name contains `opus` (any case). `agentModel(toolInput, { projectDir, pluginRoot })` and `isOpusModel(model)`.

## Doubt signals

A slice needs a passing opus review after its latest implementer launch when any of these holds (`doubtSignals(slice, env)` returns their names; `hasOpusPass(slice)` says whether one exists):

| Signal | When |
|---|---|
| `risky` | `RISKY: yes` on its planned slice or its implementer brief |
| `retry` | the slice already had a failed review |
| `read_answer` | its latest passing review answered a constraint with `(read)` |
| `open_items` | its latest passing review has a non-empty OPEN |
| `tests_failed_isolated` | a test-gate record `tests_failed_isolated` (joined by `agent_id`) belongs to its latest attempt: it is later than the review the attempt followed |

`ORCH_ESCALATION=off` disables the signals; `ORCH_ESCALATION=always` requires an opus review for every slice (signal `always`).

## Log records

Hooks log parsed fields only, never brief or reply text. Readers accept older records that lack the new fields (they fold to empty values).

**Launch record** (`journal-launches.jsonl`, written by `journal.mjs` at PostToolUse on `Agent|Task` for every launch of an implementer, reviewer, researcher or integrator; built by `launchRecord(tool_input, { ts, sessionId, agentId, projectDir, pluginRoot })`):

| Field | Value |
|---|---|
| `ts`, `session_id` | as today |
| `agent_id` | from the tool response when present (a background launch returns `agentId`; a foreground result may carry it only in its text, as `journal.mjs`'s `agentIdOf` reads it), else `null` |
| `agent_type` | bare role (`implementer`, not `orchestration:implementer`); older records have `role` |
| `slice` | `sliceOfBrief`: `plan` for a PLAN REVIEW brief, else the SLICE id, else `null` (as today) |
| `files`, `depends`, `path`, `risky`, `checks`, `focus`, `workflow` | `parseHeader` |
| `model` | `agentModel` (see Reviewer model) |
| `isPlanReview`, `replan` | `parsePlan` |
| `plan` | PLAN REVIEW briefs only: `{ constraints, slices }` from `parsePlan` |

**Stop record** (`journal.jsonl` at SubagentStop; `stopRecord({ ts, sessionId, agentId, role, slice, reply, status, run })`): `ts`, `session_id`, `agent_id`, `role` (bare; readers also accept `agent_type`), `slice` (from the launch record with the same `agent_id`, or through `journal-pending.jsonl` when the stop arrives before its launch, as `journal.mjs` does today), `status` (`parseStatus` of the final report), `answers`, `open` (`parseReply`), `run` (the id `foldRuns` gives the run at write time: runs are numbered 1, 2, ... in session order). A resumed agent keeps its `agent_id`, so its stops join the same launch. A reviewer stop may also carry `model`; otherwise the model comes from its launch record.

**Test-gate record** (`gates.jsonl` from `verify.sh`, `gate: "test"`): carries `session_id` and `agent_id`, and no slice. The slice is resolved at read time by joining `agent_id` to a launch record; a record whose `session_id` differs from that launch's is ignored. `verify.sh` logs both. A record without `session_id` still counts through the join.

**Ordering.** A foreground agent's SubagentStop, and the test-gate record written at that stop, are logged before its PostToolUse launch record (journal.mjs:10). So a stop or gate record whose `agent_id` matches a launch record is placed at its effective time, `max(own ts, launch ts)`: never before its launch. Every launch, stop and gate record is ordered by that time. At equal times the launch comes first, and the stops and gates keep the order of their own `ts` (a stop before a gate at equal `ts`). The effective time is also the time the record counts at (review times, run activity, staleness). A record whose launch never appears keeps its own `ts` and today's handling.

New gate reasons: `agents_running`, `not_in_plan`, `constraints_unchecked`, `opus_review_required`, `builtin_agent_in_run`. Every one except `agents_running` has a `<reason>_gave_up` form, logged when the gate lets the launch or reply through after 2 blocks (the loop guard). `agents_running` is an allow and is never counted as a block, so it never gives up and has no `_gave_up` form.

## Gates (slice A1)

Hooks read the records through `.claude/hooks/run.mjs` (`loadRecords`, `sessionRuns`, `sliceOfAgent`; side-effect free at import).

- **Review gate** (`review-gate.mjs`, Stop). `agents_running` (allow, not counted as a block) while Stop's `background_tasks` lists an active (`running`, `pending`, `queued`) subagent, workflow or teammate; without `background_tasks`, while a SubagentStart younger than `ORCH_RUN_STALE_MIN` has no SubagentStop. Otherwise each slice of the latest run with an implementer attempt, and the slice of the session's last implementer, needs its latest review after its latest attempt to pass (`no_reviewer_after_last_implementer`, `last_reviewer_failed`, `last_reviewer_no_status`), every CHECKS id of that reviewer's brief answered with pass (`constraints_unchecked`; no CHECKS skips, logged in `skips`), and, when a doubt signal fired, a passing opus review (`opus_review_required`). A slice failed for good allows with `slice_failed_for_good` and a systemMessage naming it. When the last implementer has no slice in the run model (workflow agents, old briefs), the old rule decides (a passing reviewer after the last implementer, from telemetry). Loop guard: 2 blocks per reason since the last implementer stop, then allow with a systemMessage (`max_blocks_reached` for the old reasons, `<reason>_gave_up` for the new ones).
- **Plan check** (`plan-check.mjs`, PreToolUse on Agent). Scoped to the open run (with none open, to the launches since the last run; a light launch opening the next run sees both); each entry logs its `run`. `builtin_agent_in_run` blocks fork and the built-ins (`general-purpose`, also meant by a missing `subagent_type`, `claude`, `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`) while a run is open and not stale, never namespaced or project agents (`ORCH_ALLOW_BUILTINS=1` disables). `no_plan_review` waits for this run's plan reviewer to stop. `not_in_plan`: in a planned run with slice lines, the SLICE must be planned (or added by REPLAN) and FILES covered by its planned FILES after `normalizeFiles` (a planned folder or glob covers what is under it); no slice lines or no planned FILES skip, logged. Each of these, and `missing_lines`, blocks twice per scope, then lets the launch through as `<reason>_gave_up`. `file_overlap` and `dependency_cycle` block every time, as before.

## API (`.claude/hooks/brief.mjs`)

| Export | Returns |
|---|---|
| `parseHeader(text)` | header fields of an implementer or reviewer brief |
| `parsePlan(text)` | the PLAN REVIEW plan |
| `parseReply(text)` / `parseStatus(text)` | status, open items, constraint answers / status only |
| `isPlanReview(text)` / `sliceOfBrief(text)` | the PLAN REVIEW marker / journal slice key (`plan`, the SLICE id, or `null`) |
| `normalizeFiles(files, baseDir)` | absolute paths: relative against `baseDir`, trailing slashes stripped, duplicates dropped |
| `isOpusModel(model)`, `modelFromAgentFile(text)`, `agentModel(toolInput, dirs)` | reviewer model rules |
| `launchRecord(toolInput, ctx)`, `stopRecord(ctx)` | the log records above |
| `foldRuns({ launches, stops, gates, starts }, { now, staleMin, sessionId })` | `{ runs, open }`: runs with slice states (`launches`, `attempts`, `reviews`, `final`, `passed`, `gaveUp`, `isolatedTestFailure`, planned `files`; reviews carry their brief's `checks`), plus `planReviewed` and `running` per run |
| `currentReviews(slice)` | reviews after the slice's latest implementer launch or stop |
| `doubtSignals(slice, env)`, `hasOpusPass(slice)` | escalation |
| `staleMinutes(env)`, `escalationMode(env)`, `MAX_RETRIES`, `RUN_STALE_MIN_DEFAULT` | settings |

Parity: `parseHeader` reads `SLICE`, `FILES` and `DEPENDS` as `plan-check.mjs` logs them, and `sliceOfBrief` keys a brief as `journal.mjs` does (`src/brief.test.mjs` runs both hooks to check). One difference: `journal.mjs` finds no slice in ``SLICE: `s1` `` (an id in backticks); `parseHeader` reads `s1`, as `plan-check.mjs` does.
