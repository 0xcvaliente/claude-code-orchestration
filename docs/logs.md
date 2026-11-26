# Logs and reports

This page says where the hooks and scripts log, what each log holds, and how `npm run report` and a headless run turn them into something to read. It is for maintainers who debug a run or read its cost. The gates that write most of these records are in [gates.md](gates.md).

The logs hold parsed fields, counts and paths. They never hold brief or [reply](glossary.md#r) text, with one exception: `telemetry.jsonl` keeps hook payload strings clipped to 300 characters ([Telemetry](#telemetry)); since 2.0.1 it drops `last_assistant_message`, the worker's report, so of the payload's strings only short fields such as ids, types and paths remain. Records written before 2.0.1 may still hold that field.

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
| `gates.jsonl` | `verify.sh`, `review-gate.mjs`, `researcher-guard.mjs`, `egress-guard.mjs`, `handback-check.mjs`, `judge-hook.mjs` | gate decision | `gate` (`test`, `review`, `researcher`, `egress`, `handback`, `judge`), `decision`, `reason`, ids, counts. The researcher guard logs the first word of a refused command; the egress guard the host only; the native judge the command's first 200 characters. Since 2.0.0 a test-gate record of a failed run also names what failed (`failed_count`, `failed_tests`, `failed_crash`, `output`), and one written by a gate that took over a stale suite lock carries `lock_takeover` ([gates.md, Test gate](gates.md#test-gate)). Since 2.0.1: a stop gate that ended with no decision logs allow `test_gate_error`, with `interrupted: 1` after a TERM, INT or HUP; a report-check record carries `log_unreadable` when the log could not be read in full, and an allow `<reason>_unconfirmed` with `voids` (the `ts` of a deny record that did not read back, which it corrects) follows such a record; a review-gate block that could not be counted or recorded is logged as allow `<reason>_unrecorded` ([gates.md, Report check](gates.md#report-check), [Review gate](gates.md#review-gate)). Since 2.1.0 the review gate's reason `second_review_required` (block) and `second_review_required_gave_up` (allow) ([gates.md, Second review rule](gates.md#second-review-rule)). Since 2.1.0 every test-gate record written after a suite run carries `suite_s`, the whole seconds the test command ran without the lock wait; records with no suite run, and records from before 2.1.0, have none ([gates.md, Time budget and suite lock](gates.md#time-budget-and-suite-lock)). |
| `plan-check.jsonl` | `plan-check.mjs` | implementer, fork or built-in launch | decision, reason, slice, FILES, DEPENDS, agent type, the run it was scoped to, give-ups and skips. Since 2.0.1 a block that could not be counted or recorded is logged as allow `<reason>_unrecorded`. Since 2.1.0 the reasons `wave_full` (block) and `wave_full_gave_up` (allow), and on each implementer launch of this plugin a `wave` object: `running`, `pending`, `cap`, `base`, `suite_s` whenever an isolated launch (`isolation: "worktree"`) read the project's latest one, narrowed or not, `lock` (`taken` or `not_taken`), `full`, `narrowed`; or `skipped` (`log_unreadable`, `wave_error`) ([gates.md, Wave cap](gates.md#wave-cap)) |
| `journal-launches.jsonl` | `journal.mjs`, PostToolUse on `Agent\|Task` | worker launch | the launch record ([Journal](#journal)) |
| `journal.jsonl` | `journal.mjs`, SubagentStop | implementer or reviewer stop (since 2.0.1 not a woken stop that holds no report: [Journal](#journal)) | the stop record ([Journal](#journal)) |
| `journal-pending.jsonl` | `journal.mjs` | foreground stop waiting for its launch | a stop's status, constraint answers and OPEN, until its launch record arrives |
| `telemetry.jsonl` | `telemetry.mjs`, SubagentStart and SubagentStop | agent start or stop | [Telemetry](#telemetry) |
| `handbacks.jsonl` | `handback-check.mjs` | hand-back | the parsed fields of the handed-back reply, written before any check decides, with `tool_use_id` when the payload has one and, since 2.0.0, `report_key` ([Hand-back capture](#hand-back-capture)). Since 2.1.0 the run fold reads it too (`loadRecords` in `run.mjs`): an implementer's capture marks where its attempt ended for the [second review rule](gates.md#second-review-rule), and an unreadable file gives every slice the one-review rule |
| `handback-refusals.jsonl` | `handback-check.mjs`, `quote-check.mjs`, `verify.sh` (the hand-back gate) | refused hand-back | session, agent, the refusing `gate` (`handback`, `quote` or `test`), `tool_use_id` when the payload has one, and from the report check and the quote check, since 2.0.0, `report_key` |
| `quotes.jsonl` | `quote-check.mjs` | researcher stop or hand-back | `agent_id`, slice, counts (total, verified, unverified, unverifiable, blocked) and the paths of unverified quotes |
| `reads.jsonl` | `read-log.mjs` | Read or WebFetch call | [Read log](#read-log) |
| `reads-route.jsonl` | `plan-check.mjs` (read router) | routed researcher launch | tier, models, reason codes, counts, paths |
| `model-floor.jsonl` | `plan-check.mjs` | haiku launch raised to sonnet | agent type, and where the model came from |
| `skills.jsonl` | `plan-check.mjs` | skill suggestion decision | role, slice, skill names, reason codes, counts |
| `skill-create.jsonl` | `plan-check.mjs` | skill-slice decision or DRAFTS lookup | decision, reason, skill name, target, paths, slice, run; since 2.1.0 `repo_check: "git_timeout"` when git ran out of time on the skills repository and the slice went through |
| `skill-gate.jsonl` | `skill-gate.mjs` | skill slice stop | decision, reason, failed reason codes |
| `review-hold.jsonl` | `plan-check.mjs` (1.6.1) | reviewer launch the hold acted on | decision (`block`, `allow` for a give-up, `note`), reason (`tests_failed_after_report`, `tests_failed_after_report_gave_up`, `test_gate_pending`; since 2.0.1 `test_gate_no_result`, a note given once the gate can no longer be running or its record is `test_gate_error`, and `tests_failed_after_report_unrecorded`, an allow when the log could not be read; since 2.1.0 `test_gate_passed`, a note given when the stop's paired test-gate record is an allow with `tests_passed` or `tests_passed_cached` and a `suite_s`), slice, the implementer's `agent_id`, and for a block or give-up `block_at` (the test-gate record's time, the loop guard's key) and `gate_reason`; never brief text. A refusal is made only when its record was written and reads back ([gates.md, Plan check](gates.md#plan-check)) |
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
- `test-gate.lock.run` (2.0.0): the lock's companion file, two lines: the holder's lock token and the process group of the command it runs under the lock. `verify.sh` writes it at the start of each such command (`run_limited`), reads it when it judges whether a lock whose holder is gone is stale (`lock_stale`: the lock stands while a member of that group is left), and removes it on release while it still holds the hook's own token (`release_lock`).
- `plan-check-wave.lock` (2.1.0): the wave cap's lock, held from its count to the launch's record ([gates.md, Wave cap](gates.md#wave-cap)).
- `test-gate-cache.json`: the hand-back gate's stored outcomes (since 2.1.0 with the run's `suite_s`), which the SubagentStop gate right after may reuse ([gates.md, Hand-back gate](gates.md#hand-back-gate)).
- `test-output/` (2.0.0): the last 64 KiB of the output of each failed test run, named in its record's `output`; the newest 10 files are kept, the folder 0700 and each file 0600.
- `report.html`: the run report, when `npm run report` writes it here.

## Journal

`journal.mjs` writes the run's [journal](glossary.md#j): parsed fields only, never brief or reply text. The gates fold it into runs ([brief-grammar.md, Log records](brief-grammar.md#log-records) has the exact fields).

- **Launch record** (`journal-launches.jsonl`, at PostToolUse on `Agent|Task`), for every launch of an implementer, reviewer, researcher or integrator: `agent_id`, bare `agent_type`, `slice` (a brief starting with PLAN REVIEW is slice `plan`), the parsed header, the reviewer's model, `isPlanReview`, `replan`, and for a PLAN REVIEW brief the parsed plan. Since 2.1.0 the launch of this plugin's implementer (bare or `orchestration:`, not the gated workflow's) also carries `reviews_needed`: 2 when its brief says `RISKY: yes`, otherwise 1, and no field with `ORCH_SECOND_REVIEW=off` (environment only). The fold reads it for the [second review rule](gates.md#second-review-rule); a record without it folds as before.
- **Stop record** (`journal.jsonl`, at SubagentStop of an implementer or reviewer): `slice`, `status`, the constraint answers, OPEN and `run`. Also `draft`, `skills_used` and `skills_skipped` when the reply has those lines, and `after_handback` (the `tool_use_id` of the hand-back the stop follows) when there is one.
- **`kind` and `model`** (reviewer stop records only, 2.1.x; `reviewFields` in `brief.mjs`). `kind` is `plan` for a PLAN REVIEW, `validate` for a brief with `VALIDATE: gaps`, otherwise `review`; `model` is the model the reviewer's launch record names. Both come from the reviewer's launch record in the same session (for a stop that waited for its launch, from that launch when it arrives); with no launch record, `kind` comes from the brief in the transcript and `model` is left out. Each is left out when unknown, and an implementer's record carries neither. Only added fields: no gate reads them, and the fold's review model (the stop record's `model`, else the launch record's) is the same value, so records with and without them fold alike. Records written before 2.1.x lack both.
- **A refused last hand-back** (2.0.0). When the agent's latest hand-back since its previous stop record was refused and the stop's own last message has no STATUS line, no report was delivered: the stop record has `status` null, `report: "handback_refused"` and `refused_by`, the check that refused it (`handback`, `quote` or `test`), and takes nothing from the refused report, the transcript or an older report ([Hand-back capture](#hand-back-capture)).
- **`continues: true`** marks a second stop record of one reply: written when `stop_hook_active` is true and the agent already has a stop record since its latest SubagentStart (2.0.1: a record from before a `SendMessage` resume does not count). The fold counts that review once.
- **A woken stop** (2.0.1). A worker woken after its report was delivered (a shell task that ends late, a prompt that reaches it) writes a text turn and stops again. When `stop_hook_active` is false, no hand-back came since the agent's previous stop record, no refusal marks one, the last message has no STATUS line and no coordinator message follows the previous stop in the transcript, the stop holds no new report: a reviewer's such stop gets no stop record, and so does an implementer's whose transcript shows no tool call since its previous stop. An implementer that made a tool call, or whose transcript cannot be read (headless), is recorded as before.
- **A resume** (2.0.1). A coordinator message in the transcript (`isMeta` true, `origin.kind` `"coordinator"`, not a compaction summary) written after the agent's previous stop record marks a `SendMessage` resume: the stop is recorded, and its report is taken only from the turns after that message (status null when none has a STATUS line).
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

**Payload.** The record keeps the hook payload, with each string clipped to 300 characters, except `last_assistant_message`, the worker's report, which is dropped since 2.0.1 (the parsed `status` stays; older records still hold it and no reader uses it). The run-model logs (the journal, `gates.jsonl`, `handbacks.jsonl`) hold parsed fields only.

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

Each capture carries `report_key` (2.0.0): the first 16 hex digits of the report's SHA-256, never report text. The report check and the quote check compute it alike and put it on their refusals too.

At SubagentStop `telemetry.mjs` takes the latest capture that no refusal marks and that is newer than its own previous stop record of that agent (`handbackFor`), else `last_assistant_message` and the transcript. `journal.mjs` (2.0.0, `handbackState`) looks at the latest capture newer than its previous stop record: it takes that capture when no refusal marks it; when one does, it takes a text reply with a STATUS line from the stop's last message, and otherwise writes the refused record ([Journal](#journal)).

**Refused captures are skipped.** A hand-back the report check, the quote check or the hand-back gate sent back is marked in `handback-refusals.jsonl`. A refusal marks the capture with the same `tool_use_id`, in either write order. Without an id it marks the capture with the same `report_key` nearest in time (written before or after the refusal; the quote check also waits up to 1 s for that capture before it writes its refusal), and a refusal with neither marks the agent's latest capture written at or before it (`deliverableCaptures` in `state.mjs`, `handbackState` in `journal.mjs`). So a worker that is sent back and then stops with a plain text reply is recorded with that text reply, not the one it never delivered.

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
- A note at the top, under the folders, naming every log that exists but could not be read (a folder in its place, no permission). Such a log counts as empty in every section, so a section can say "no ... yet" for it; the note says why.
- A table per role: agents, stops with usage, tokens by kind, turns, models and max-turn hits. Each record is a running total, so each agent counts once, from its last stop record.
- The agents that started and never stopped (a turn-limit stop fires no SubagentStop). Shown as `true` when the transcript ends on the last tool result with no assistant message after it and the turns reached the role's maxTurns; `null` when it cannot tell.
- An estimated cost by role and model, at the list prices in `scripts/prices.mjs` (`PRICES_AS_OF`). It is an estimate for comparing roles and models, not a bill.
- Tokens and estimated cost by phase, right after the cost, at the same list prices and as the same estimate, not a bill. The subagents are the agents the cost table covers (each agent's last stop record with tokens, priced when it used one model with a listed price), each placed by its latest launch record in `journal-launches.jsonl` (same session and agent id): plan review (slice `plan` or `isPlanReview`), explore (researcher), build (an implementer's first launch for a slice in a session), retries (later implementer launches of that slice), review (other reviewers), integrate (integrator), and unassigned (no launch record). Build and retries are decided per session, run and slice, the run taken from the implementer's own stop records in `journal.jsonl` (launch records carry no run), so the first implementer of a later run that reuses a slice id counts as build; an implementer with no stop record that names a run is decided per session and slice, and an implementer that has a run counts as retries too when an earlier launch of the same session and slice had no known run (one that hit its turn limit writes no stop record) and no launch with a known run came between them, so only the first known-run launch after it is affected and a later run that reuses the slice id still starts with build. Exception: when that first known-run launch is the first implementer of a new run (the unknown one belonged to an earlier run, or was the new run's own first attempt), the logs cannot tell the two apart (the launch record carries no run and the unknown launch has no stop record), so it counts under retries. Build and retries count launch records: an attempt that resumes the same agent (a SendMessage resume) writes no launch record, so its tokens count with that agent's first launch, under build when that was the first; the note under the table says so. So the subagent rows add up to the cost table's agents and total. The "main sessions" row (named "orchestrator" before) is the main thread of every session that launched a subagent, orchestrator or not (a plain session that launched one reviewer counts too), which no stop record covers; the note under the table says so: each distinct `transcript_path` the telemetry records name is read once and its assistant messages summed with the rule telemetry uses for a subagent (per message id the largest value of each token field, synthetic and sidechain messages skipped), priced per model. Message ids are matched across all those transcripts, so a forked or resumed session whose transcripts hold the same history counts each message once; a line that does not contain the text `"usage"` is skipped before it is parsed. Per phase: agents (transcripts for the main sessions), tokens by kind, total tokens, estimated cost and how many were not priced. Only top-level fields of a record count, so another agent's data under `background_tasks` is never counted twice. A transcript that is missing or unreadable is skipped and counted in a line under the table, and one too large to read in one piece (longer than the longest string Node can make, or past its file size limit) is skipped and counted in a line of its own; only the exact paths the records name are read. A missing, empty or unreadable log gives a one-line note instead of a crash.
- Tokens and estimated cost per slice whose latest review passed, under the phases (named "per passed slice" before): per slice (session, run and slice) whose latest reviewer stop record in `journal.jsonl` is pass (a stop record with `continues: true` replacing the one it continues) and which has an implementer launch, the attempts (implementer launch records), implementers, reviewers, their tokens and estimated cost, and "Failing review after latest attempt" (named "after latest launch" before): yes when a failing reviewer stop record of the slice was recorded after the start of its latest attempt, the later of its latest implementer launch record and its latest implementer stop record in `journal.jsonl` before the passing review (a resumed implementer writes no launch record, but a new stop record; by `ts`; a stop record with no readable time does not move the start; with no readable launch or review time, any failing review counts). The table shows the latest review, not the gates' verdict, and the report does not repeat the gates' fold: for a slice with several reviews of one attempt the two can differ (a risky slice fails on any counted fail, a superseded review counts as nothing, a fail whose gaps are all below the cutoff can count as a pass), and the column shows where a fail was recorded; the note under the table says so. An agent's run is the run of its own journal record. When that run is not among these slices (a slice carried into a later run is reviewed under the new run id while its earlier agents' records keep the old one), the agent counts for the first passed run of its session and slice id after its own (runs ordered by their first journal record) only when its own run recorded no reviewer stop record for that slice: the slice left that run unreviewed, so it was carried, even when the later run launched a fresh implementer for it; an earlier run that reviewed the slice (passed or failed) adds nothing. An agent with no known run (no journal stop record, for example an implementer that hit its turn limit) counts only when exactly one run of its session has journal records for that slice id; otherwise it is left out, and a line under the table says how many agents were left out because their run is unknown. Attempts counts launch records, so an attempt that resumes the same agent is not counted. Plan reviews, failed slices and slices with no implementer launch are left out; without a journal or launch records the table is replaced by one line.
- The "State:" line names `journal.jsonl` and `journal-launches.jsonl` whenever a section used their rows (the Skills section, reviews per slice, review outcomes by kind and model, the cost by phase and the passed-slice table), each once.
- Review time, after the cost by phase, in three tables:
  - Wall time by role and model: per agent, its last stop minus its first start in `telemetry.jsonl` (an agent may stop several times), then per role and model the number of agents, the median, the longest and the total. An agent with no start, no stop or no readable time is left out and counted in a note under the table.
  - Reviews per slice: per slice of each run, the reviewer stop records in `journal.jsonl` and how many ran on opus, from the models of the reviewer's last stop in `telemetry.jsonl`; a line under it gives slices, reviews, reviews per slice and the share on opus. A stop record with `continues: true` counts once with the record it continues; a resume counts as another review; a review with no model on record counts as not on opus. Only slices with an implementer record in `journal.jsonl` for the same session, run and slice are listed and counted; reviews of any other label (plan reviews, one-off checks) are left out of the table and the summary and counted in one line under it, absent when there are none. Reviews with no slice label (a brief without a SLICE line) are counted in that line too, so the table's reviews plus the line add up to every reviewer stop record; when no review is of a slice, the section says "No reviews of a slice in the journal yet." above the line. One limit remains: a slice whose implementer wrote no stop record (for example it hit its turn limit, which fires no SubagentStop) has no implementer record in `journal.jsonl`, so its reviews are counted as "not of a slice". Without a journal the table is replaced by one line.
  - Review outcomes by kind and model: the reviewer stop records in `journal.jsonl` that carry `kind`, counted per kind (`plan`, `validate`, `review`, in that order) and model: the stop record's `model`, else the reviewer's launch record's `model` in `journal-launches.jsonl`, else the one model of its last telemetry stop (`models` with exactly one entry), "unknown" when none. A launch record names a model as the launch gave it (an alias such as `opus`), telemetry as a full model id; the report has no mapping between the two, so one model can show under both forms, as the note under the table says with pass, fail and total (a reply with no STATUS line counts in the total only). A stop record with `continues: true` replaces the record it continues, so one reply counts once; a resume counts again. Records without `kind` (written before the field) are left out of the table and counted in one line under it, "N earlier reviews carry no kind". With no reviewer stop record the table is replaced by one line.
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
- A refusal without a `tool_use_id` is tied to its capture by `report_key` and time, not by identity: two hand-backs of one agent with the same report text have one key, and the refusal marks the one nearest in time. A refusal the hand-back gate writes without an id carries no `report_key` and marks the agent's latest capture written at or before it.
- `telemetry.jsonl` keeps clipped payload strings, the worker's last message included, so it can hold up to 300 characters of a reply.
