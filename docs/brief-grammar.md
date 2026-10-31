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

A run belongs to one session. `foldRuns(events, { now, staleMin })` derives runs from that session's launches and stops in order.

- **Open.** A PLAN REVIEW launch without `REPLAN` opens a planned run and closes any run open in the session. A light-path implementer launch (`PATH: light`) opens a light run when no run is open. A PLAN REVIEW with `REPLAN` extends the open run with its slices and constraints (with no run open it opens one). Other implementer launches join the open run; with none open they are not tracked. A new user prompt does not close a run.
- **Final slice.** A slice is final when its latest review (after its latest implementer launch) passed, or failed for good: its latest review failed after 3 implementer launches of that slice in the run (`MAX_RETRIES` 2). A review with no STATUS is neither.
- **Closed run.** A planned run closes when every planned slice is final; a light run closes when its slice is final.
- **Stale run.** A run is stale when no launch or stop happened in it for `ORCH_RUN_STALE_MIN` minutes (default 30). The plan check treats a stale run as closed (so a light launch opens a new run); the review gate keeps gating its unreviewed slices. A stop that arrives later (a long worker) still lands in the latest run that has its slice.

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
| `tests_failed_isolated` | the test gate logged `tests_failed_isolated` for its latest implementer |

`ORCH_ESCALATION=off` disables the signals; `ORCH_ESCALATION=always` requires an opus review for every slice (signal `always`).

## Log records

Journal entries (`journal.jsonl`) keep `ts`, `session_id`, `slice`, `role`, `status`, `agent_id` and add:

| Field | Value |
|---|---|
| `run` | the run id (`foldRuns` numbers runs 1, 2, ... in session order) |
| `checks` | `CHECKS` ids of the brief |
| `answers` | `parseReply(...).answers` of a reviewer's reply |
| `open` | `parseReply(...).open` |
| `model` | the reviewer's model (see Reviewer model), or `null` |
| `risky` | `RISKY: yes` on the brief |

New gate reasons: `agents_running`, `not_in_plan`, `constraints_unchecked`, `opus_review_required`, `builtin_agent_in_run`, each with a `<reason>_gave_up` form logged when the gate lets the launch or reply through after 2 blocks (the loop guard).

## API (`.claude/hooks/brief.mjs`)

| Export | Returns |
|---|---|
| `parseHeader(text)` | header fields of an implementer or reviewer brief |
| `parsePlan(text)` | the PLAN REVIEW plan |
| `parseReply(text)` / `parseStatus(text)` | status, open items, constraint answers / status only |
| `isPlanReview(text)` / `sliceOfBrief(text)` | the PLAN REVIEW marker / journal slice key (`plan`, the SLICE id, or `null`) |
| `normalizeFiles(files, baseDir)` | absolute paths: relative against `baseDir`, trailing slashes stripped, duplicates dropped |
| `isOpusModel(model)`, `modelFromAgentFile(text)`, `agentModel(toolInput, dirs)` | reviewer model rules |
| `foldRuns(events, opts)`, `currentReviews(slice)` | runs and slice states; reviews after the latest launch |
| `doubtSignals(slice, env)`, `hasOpusPass(slice)` | escalation |
| `staleMinutes(env)`, `escalationMode(env)`, `MAX_RETRIES`, `RUN_STALE_MIN_DEFAULT` | settings |

`foldRuns` events: `{ ts, phase: 'launch', role, prompt, model? }`, `{ ts, phase: 'stop', role, slice, reply?, status?, model? }` and `{ ts, phase: 'gate', slice, reason }`. Parity: `parseHeader` reads `SLICE`, `FILES` and `DEPENDS` as `plan-check.mjs` logs them, and `sliceOfBrief` keys a brief as `journal.mjs` does (`src/brief.test.mjs` runs both hooks to check). One difference: `journal.mjs` finds no slice in ``SLICE: `s1` `` (an id in backticks); `parseHeader` reads `s1`, as `plan-check.mjs` does.
