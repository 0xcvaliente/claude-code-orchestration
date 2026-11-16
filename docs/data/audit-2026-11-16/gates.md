# Audit of the gate hooks, 2026-11-16 (HEAD 16e0627)

## Summary

| id | kind | severity | title | fix would touch |
|---|---|---|---|---|
| G-1 | bug | high | A second plain PLAN REVIEW splits a slice across two runs: the review gate blocks a reviewed slice and misses a failed one | `.claude/hooks/brief.mjs`, `.claude/hooks/review-gate.mjs`, `dashboard/register.tsx`, `docs/brief-grammar.md`, `src/brief.test.mjs`, `src/review-gate-v2.test.mjs` |
| G-2 | bug | medium | A test-gate block that lands after a passing review is never seen by the review gate | `.claude/hooks/review-gate.mjs`, `.claude/hooks/brief.mjs`, `docs/brief-grammar.md`, `src/review-gate-v2.test.mjs` |
| G-3 | bug | low | `telemetry.mjs` crashes with a stack trace on a `null` payload | `.claude/hooks/telemetry.mjs`, `src/telemetry-v2.test.mjs` |
| G-4 | docs-drift | low | The spec says no hook logs a reply, but telemetry keeps 300 characters of each last message | `docs/brief-grammar.md` (or `.claude/hooks/telemetry.mjs`) |
| G-5 | bug | low | After a compaction, a slice that still needs its opus review is reported as "passed" | `.claude/hooks/compact-context.mjs`, its test |
| G-6 | behaviour-change | low | Two plan-check block messages name an environment switch | `.claude/hooks/plan-check.mjs`, `src/contracts.test.ts`, `src/plan-*.test.mjs` |
| G-7 | bug | high | A fresh retry of a slice that a later slice DEPENDS on is blocked for good (`file_overlap`, then `dependency_cycle`) | `.claude/hooks/plan-check.mjs`, `src/plan-check*.test.mjs` |
| G-8 | improvement | low | In auto mode one review is recorded as two stop records | `.claude/hooks/journal.mjs`, `.claude/hooks/brief.mjs`, `dashboard/register.tsx`, `scripts/report.mjs`, `src/brief.test.mjs` |
| G-9 | docs-drift | low | The review gate's documented reason order is not the code's; `run_state_unreadable` undocumented | `README.md`, `docs/brief-grammar.md`, `docs/native-mode.md` |
| G-10 | docs-drift | low | Docs on the plan check's rewrite, a reply without STATUS, and telemetry's status source lag the code | `README.md`, `docs/native-mode.md` |
| G-11 | docs-drift | low | `REPLAN:` reads a leading number (`1a`, `1.5`, `0x2`) | `docs/brief-grammar.md` (or `brief.mjs`, `dashboard/register.tsx`, fixtures) |
| G-12 | bug | medium | `PATH: light` lets the first slice of a multi-slice plan start before its plan review finished | `.claude/hooks/plan-check.mjs`, `src/plan-check*.test.mjs` |
| G-13 | docs-drift | low | The spec still lists the built-in agents by name, without `web-fetch` | `docs/brief-grammar.md` |
| G-14 | known | low | A capture the quote check refused is also used at the stop (new case of CHANGELOG 1.4.4 known item) | `.claude/hooks/state.mjs`, `.claude/hooks/quote-check.mjs`, `.claude/hooks/handback-check.mjs`, `src/handback.test.mjs` |
| G-15 | bug | low | The haiku rule misses older and provider-prefixed haiku ids | `.claude/hooks/plan-check.mjs`, `src/model-floor.test.mjs` |

Counts: 15 findings. By kind: 7 bug, 5 docs-drift, 1 improvement, 1 behaviour-change, 1 known. By severity: 2 high, 2 medium, 11 low.

## Coverage

- `.claude/hooks/brief.mjs`: partial (640-1020 read: stop record, fold, settle, finish, doubt signals; 1-639 exercised through `spec-edges.mjs`, 36 spec edge cases, and read at 251-267 for REPLAN, not read line by line).
- `.claude/hooks/run.mjs`: full.
- `.claude/hooks/plan-check.mjs`: partial (114-210, 264-313, 555-575, 670-940, 1100-1247 read; 1-113 header comment, 210-263, 313-554, 576-669 and 940-1100, the glob and path-identity helpers, not read; overlap, cycle, light path, not_in_plan scope, haiku rule and malformed input exercised by running it).
- `.claude/hooks/review-gate.mjs`: full.
- `.claude/hooks/journal.mjs`: full.
- `.claude/hooks/handback-check.mjs`: full.
- `.claude/hooks/compact-context.mjs`: full.
- `.claude/hooks/state.mjs`: full.
- `.claude/hooks/telemetry.mjs`: full.
- `.claude/hooks/turn-budget.mjs`: full.
- `.claude/hooks/builtin-agents.mjs`: full (code; comments skimmed).
- `.claude/settings.json` hook wiring: full (every event, matcher, timeout and order listed and checked against the rules; findings G-2 and G-14 come from parallel hooks on one event).
- Specs: `docs/brief-grammar.md` full; `.claude/rules/agents.md` full. Docs: `README.md` "The gates", "Gate details", "How a worker launch is shaped", "Briefs and replies", "Known limitations" full; `docs/native-mode.md` hook table (78-92) and lines 109 and 320 only.
- Every hook in scope was run on 13 malformed inputs in 4 broken state-folder conditions (`badinput.mjs`): only G-3 failed.

## Setup

Slice `audit-gates`: a read-only audit of the run fold, the plan check, the review gate, the journal, the hand-back, telemetry, turn-budget and compaction hooks, against `docs/brief-grammar.md` and `.claude/rules/agents.md`. Every reproduction ran against a scratch project, never against the live state folder (no record with the audit session ids is in `.claude/state`).

`$S` = `<scratch>/audit/audit-gates`. The live logs were copied to `$S/state` (`cp .claude/state/* $S/state/`); `$S/lib.mjs` writes records into a scratch project `$S/proj/<name>` and runs a live hook there with `CLAUDE_PROJECT_DIR`, `HOME` and `CLAUDE_CONFIG_DIR` under `$S`, session id `audit-1`. Each script below is in `$S` and runs with `cd $S && node <script>`; `fold-live.mjs` and `run-field.mjs` take `$S/state` as their argument.

## Findings

### G-1: A second plain PLAN REVIEW splits a slice across two runs: the review gate blocks a reviewed slice and misses a failed one

- kind: bug
- severity: high
- where: `.claude/hooks/brief.mjs:880-885` (a PLAN REVIEW without REPLAN closes the open run and opens a new one that re-plans the same slices with empty state), `.claude/hooks/brief.mjs:844,922` (`runWith`: a later stop lands in the latest run that has the slice), `.claude/hooks/review-gate.mjs:201-205` (gates only slices with `attempts > 0` in the latest run, and the last implementer's slice in the latest run where it has attempts).
- what happens: when a session sends a second PLAN REVIEW (no `REPLAN:`) while slices of the first are in flight, an implementer stop that came before it stays in run 1, and every later stop and review of that slice lands in run 2, where the slice has `attempts: 0`. The review gate then (a) blocks with `no_reviewer_after_last_implementer` on run 1, although a reviewer passed the slice, and doing what the block asks (another review) cannot clear it, since that review lands in run 2 again: two blocks, then a give-up whose message calls the reviewed work unverified; and (b) never sees a failed review of that slice when the session's last implementer is another slice: the reply goes out as `reviewer_passed`. It also leaves run 2 open until it goes stale, since a slice that was final in run 1 is re-planned in run 2 and never relaunched. This happened in the live logs: session b34157a4, PLAN REVIEW at 01:20:44 (run 2), implementers launched 01:23:49, a second PLAN REVIEW at 01:28:22 (run 3); the fold puts `macos-tests` with 1 attempt and 0 reviews in run 2 and 0 attempts and 4 reviews in run 3, and `probe-default-agent` (final in run 2) keeps run 3 from closing (`stale=true closed=false`).
- reproduction: `cd $S && node fold-live.mjs $S/state` (live copy) printed `run 2 ... macos-tests L1 A1 R0 final=false` and `run 3 ... closed=false stale=true ... probe-default-agent L0 A0 R0 final=false ... macos-tests L0 A0 R4 final=true`. Synthetic, live `review-gate.mjs`: `cd $S && node g1-split-run.mjs` (plan x,y; implementer x stops; second PLAN REVIEW; reviewer x passes; Stop; one more passing reviewer as the block asks; Stop; Stop):
  ```
  stop 1: exit 2 Review gate: slice x (run 1): an implementer finished but no reviewer has run since. ...
  stop 2: exit 2 Review gate: slice x (run 1): an implementer finished but no reviewer has run since. ...
  stop 3: exit 0 Review gate: gave up after 2 blocks (no_reviewer_after_last_implementer). The work of slice x is unverified; ...
  run 1 closed=true x: attempts=1 reviews=0
  run 2 closed=false x: attempts=0 reviews=2
  ```
  `cd $S && node g1b-missed-fail.mjs` (same split, reviewer of x reports fail, then slice y implemented and passed): `exit 0`, gate record `"decision":"allow","reason":"reviewer_passed"`.
- expected: the gate holds the reply while a slice's latest review after its latest attempt failed, and lets it through once a reviewer passed it (`docs/brief-grammar.md:269`, "Review gate": "each slice of the latest run with an implementer attempt, and the slice of the session's last implementer, needs its latest review after its latest attempt to pass"); "no reachable state blocks for ever when the session does what the block message asks" (brief invariant). The spec allows the new run (`docs/brief-grammar.md:181`, "closes any run open in the session") but not that one slice's attempt and its review count in different runs.
- fix scope: `.claude/hooks/brief.mjs` (`foldRuns`: when a plain PLAN REVIEW re-plans a slice of the run it closes that is not final, carry its state into the new run, or let a stop land in the run that holds the slice's latest attempt), `.claude/hooks/review-gate.mjs` (also gate slices of the latest run with reviews but no attempts, or the run of the last attempt), mirror in `dashboard/register.tsx` (`sliceRunOf`), spec `docs/brief-grammar.md` "Run model", tests `src/brief.test.mjs`, `src/review-gate-v2.test.mjs`.
- confidence: 90

### G-2: A test-gate block that lands after a passing review is never seen by the review gate

- kind: bug
- severity: medium
- where: `.claude/hooks/review-gate.mjs:128-137` (an implementer counts as unfinished only when its latest SubagentStart has no later SubagentStop), `.claude/hooks/brief.mjs:803-810` (the fold reads only `tests_failed_isolated` test-gate records); wiring `.claude/settings.json` SubagentStop: `telemetry.mjs` and `journal.mjs` run beside `verify.sh` (900 s), so the stop is logged at once and the test gate decides minutes later.
- what happens: an implementer stops; telemetry and the journal log the stop at once; the orchestrator sends the work to a reviewer, who passes it; then `verify.sh`, still running from that stop, blocks it (tests fail) and sends the implementer back. If the implementer then never stops again (killed, turn limit, or a result already delivered), nothing in the review gate's inputs records the unresolved block: the agent has a SubagentStop after its start, so it is not `implementer_unfinished`, and the slice's latest review after its latest attempt passed, so the Stop gate allows with `reviewer_passed`. The failing tests go out unflagged. Live logs, session b34157a4: implementer `a488b9b1fb6a4da80` (slice macos-tests) stopped 01:28:03.7 (telemetry and journal `pass`), a reviewer launched 01:28:57 passed it 01:30:03, `verify.sh` blocked it at 01:31:25.5 (`bugfix_test_passes_on_base`), and no later SubagentStart or SubagentStop of that agent exists.
- reproduction: `cd $S && node g-testblock.mjs` (light slice x: implementer stops, reviewer passes, then a test-gate block record for the implementer; Stop with `background_tasks: []`):
  ```
  exit 0 stderr=[]
  {"ts":"...","gate":"review","decision":"allow","reason":"reviewer_passed","session_id":"audit-1","skips":["constraints_unchecked:x:no_checks"]}
  ```
  Live trace: `cd $S && node trace-agent.mjs $S/state a488b9b1fb6a4da80` printed the SubagentStart (01:23:49.755), the telemetry and journal stops (01:28:03.724 and .786, `pass`), the launch record and `gates.jsonl 2026-11-16T01:31:25.508Z test block bugfix_test_passes_on_base`, and nothing later.
- expected: the review gate holds the reply while an implementer's work was neither tested nor reviewed (`docs/brief-grammar.md:268`, "Unfinished implementers": "so it has no stop record, no test-gate record and no attempt in the fold ... blocks with `implementer_unfinished`"); a test-gate block is a failed attempt the agent must answer (`.claude/rules/agents.md`, test gate). The spec covers a stop that never fires, not a fired stop whose test gate then blocked.
- fix scope: `.claude/hooks/review-gate.mjs` (treat an implementer whose latest test-gate record is a block with no later stop of that agent like an unfinished one, or as a failed attempt), optionally `.claude/hooks/brief.mjs` (`foldRuns`: a `block` test-gate record later than the slice's latest review reopens the attempt), `docs/brief-grammar.md` ("Unfinished implementers"), tests `src/review-gate-v2.test.mjs`. Paired: the test-gate audit slice (`verify.sh` timing).
- confidence: 70

### G-3: `telemetry.mjs` crashes with a stack trace on a `null` payload

- kind: bug
- severity: low
- where: `.claude/hooks/telemetry.mjs:170-178` (`payload = JSON.parse(...)` accepts `null`; line 178 reads `payload.hook_event_name`).
- what happens: stdin `null` (valid JSON, not an object) passes the parse and then throws `TypeError: Cannot read properties of null`, exit 1, with the stack on stderr. Every other hook in scope checks `typeof input === "object"` after parsing.
- reproduction: `cd $S && node badinput.mjs` (runs each hook in scope on 13 malformed inputs in 4 state-folder conditions: missing, half-written lines, a file in its place, unreadable logs) printed only:
  ```
  missing telemetry.mjs nul: exit 1 file:///.../.claude/hooks/telemetry.mjs:178 |   if (payload.hook_event_name === "SubagentStop") { |               ^
  halfLines telemetry.mjs nul: exit 1 ... (same)
  stateIsFile telemetry.mjs nul: exit 1 ... (same)
  unreadable telemetry.mjs nul: exit 1 ... (same)
  done
  ```
- expected: "Hooks must exit 0 on malformed input" (`.claude/rules/agents.md`, third bullet); no stack trace to the agent (brief rule).
- fix scope: `.claude/hooks/telemetry.mjs` (exit 0 unless the parsed payload is a non-array object), test `src/telemetry-v2.test.mjs`; `npm run build-plugin` for `dist/plugin`.
- confidence: 95

### G-4: The spec says no hook logs a reply, but telemetry keeps the first 300 characters of every worker's last message

- kind: docs-drift
- severity: low
- where: `docs/brief-grammar.md:179` ("no hook logs a raw prompt or reply") and `:222` ("Hooks log parsed fields only, never brief or reply text"), against `.claude/hooks/telemetry.mjs:199-207` (the whole payload is spread into the record, strings clipped to 300 characters).
- what happens: `telemetry.jsonl` holds `last_assistant_message` (reply text, clipped), plus `transcript_path`, `cwd` and the other payload strings.
- reproduction: `cd $S && node telemetry-text.mjs $S/state` printed `telemetry records 489 with last_assistant_message 133` and the record keys, which include `last_assistant_message`, `transcript_path` and `cwd`.
- expected: `docs/native-mode.md:109` already says the logs "hold subagent payloads" (the reason the plugin copy logs outside the repo), so the code is the intended side and `docs/brief-grammar.md:179,222` should limit the claim to the run-model logs (`journal*.jsonl`, `gates.jsonl`, `handbacks.jsonl`); or, if reply text should never be kept, `telemetry.mjs` should drop `last_assistant_message` (the owner decides).
- fix scope: `docs/brief-grammar.md` (or `.claude/hooks/telemetry.mjs` and `src/telemetry-v2.test.mjs`).
- confidence: 90

### G-5: After a compaction, a slice that still needs its opus review is reported as "passed"

- kind: bug
- severity: low
- where: `.claude/hooks/compact-context.mjs:17-25` (`sliceState` returns `passed` on `s.passed`, which is the latest counted status, not finality; a stalled slice shows `review failed, retry due`).
- what happens: a RISKY slice passed by a sonnet reviewer is not final (it needs an opus pass), but the context put back after a compaction says `x: passed`, so the session can believe the slice is done; the review gate then blocks with `opus_review_required`. A stalled slice is shown as `retry due` although the next implementer launch is blocked with `replan_required`.
- reproduction: `cd $S && node compact-passed.mjs` (folds a plan with x RISKY and y, implementer x, a sonnet reviewer's pass, then calls `runContext(open)`):
  ```
  x final: false signals: risky
  Orchestration run 1 is still open in this session (planned, plan reviewed). Slices:
  - x: passed, RISKY FILES: x
  ```
- expected: `brief-grammar.md:183` ("A slice whose latest review passed but which still needs its opus pass is not final (it keeps `passed`...)"); the compaction context should say e.g. `passed, opus review due`, and `replan required` for `s.stalled`.
- fix scope: `.claude/hooks/compact-context.mjs` (`sliceState`: use `s.final`, `s.signals`, `s.stalled`), test in `src/hooks.test.ts` or the compact-context test; `npm run build-plugin`.
- confidence: 85

### G-6: Two plan-check block messages name an environment switch

- kind: behaviour-change
- severity: low
- where: `.claude/hooks/plan-check.mjs:850` ("ORCH_ALLOW_BUILTINS=1 allows built-ins.") and `:922` ("ORCH_STALL_GATE=off turns this check off.").
- what happens: the block message goes to the orchestrator as the tool error, so model-facing text names a switch it cannot set.
- reproduction: by reading: `plan-check.mjs:850` ends with `` ORCH_ALLOW_BUILTINS=1 allows built-ins.` `` and `:922` with `` ORCH_STALL_GATE=off turns this check off.` ``.
- expected: `.claude/rules/agents.md`: "Model-facing text (agent bodies, the skills, the nudge's context string) names gate reasons ... but never an environment switch: the orchestrator cannot set them, and naming them invites it to ask for one." The rule's list does not name hook messages, so this is a proposal to extend it to them (and to `src/contracts.test.ts`).
- fix scope: `.claude/hooks/plan-check.mjs` (drop the two sentences), `src/contracts.test.ts` (scan block messages), tests that match the message text (`src/plan-*.test.mjs`); `npm run build-plugin`.
- confidence: 80

### G-7: A fresh retry of a slice that a later slice DEPENDS on is blocked for good (`file_overlap`, then `dependency_cycle`)

- kind: bug (related known limitation: `README.md:415` "`file_overlap` and `dependency_cycle` block with no give-up", `docs/native-mode.md:320` "a plan that cannot be fixed stalls those launches"; what is new here is that the plan is valid and nothing in it can be fixed)
- severity: high
- where: `.claude/hooks/plan-check.mjs:1197-1213` (an earlier launch is skipped only when this launch's own DEPENDS names it: `if (e.slice === slice || depends.includes(e.slice)) continue;`, never when that launch DEPENDS on this slice), `:1216-1226` (cycle check over the run's launched DEPENDS).
- what happens: a plan gives two slices one file in sequence, b `DEPENDS: a`, which is what the block message itself advises ("list the owning slice in DEPENDS if this slice runs after it"). a and b launch fine. When a needs a fresh implementer (the documented third attempt is "a fresh implementer with `model: "opus"`", `.claude/rules/agents.md`, Retry flow), its launch is `file_overlap` (f owned by b) on every try; adding `DEPENDS: b`, as the message asks, turns it into `dependency_cycle` on every try. Neither has a loop guard, and a REPLAN does not clear the run's launched entries, so slice a cannot be retried in this run.
- reproduction: `cd $S && node g-retry-overlap.mjs` (plan a: f.txt; b: f.txt, DEPENDS a; plan reviewed; launches a, b, a, a, a through the live `plan-check.mjs`):
  ```
  launch a: exit 0
  launch b: exit 0
  launch a: exit 2 Plan check: slice a would change files another slice owns: f.txt (owned by b). Give each file one owner, or list the owning slice in DEPENDS
  launch a: exit 2 (same)
  launch a: exit 2 (same)
  ```
  `cd $S && node g-retry-overlap2.mjs` (the retries say `DEPENDS: b`): three times `exit 2 Plan check: DEPENDS of slice a forms a cycle. Fix the order in the plan.`
- expected: the overlap rule keeps two slices from owning one file at the same time; slices ordered by DEPENDS may share it (`plan-check.mjs:1212` message; `.claude/rules/agents.md`: blocks FILES that "overlap another slice's files outside DEPENDS"), and a retry of a planned slice is part of the flow (`.claude/rules/agents.md`, "Retry flow"). Doing what the message asks must not lead to a block that never releases.
- fix scope: `.claude/hooks/plan-check.mjs` (skip an earlier launch whose DEPENDS, transitively, include this slice, and compare a slice's retry against the run's DEPENDS graph rather than only this launch's line), tests `src/plan-check*.test.mjs` (a retry case); `npm run build-plugin`.
- confidence: 90

### G-8: In auto mode one review is recorded as two stop records

- kind: improvement
- severity: low
- where: `.claude/hooks/journal.mjs:156-210` and `.claude/hooks/telemetry.mjs:165-211` (every SubagentStop writes a record; neither reads the payload's `stop_hook_active`); folded by `.claude/hooks/brief.mjs:943-958` (each reviewer stop is a review).
- what happens: a worker that ends its turn with the report as text gets a first SubagentStop (`stop_hook_active: false`), is then made to hand the report back, and gets a second SubagentStop seconds later (`stop_hook_active: true`) with no SubagentStart between. Both hooks log both, so the fold counts two reviews where one ran (and `countedFails`, the report's per-role counts and the pane's review counts double). The gates are not misled today: the second record is the latest and carries the delivered report (the lead "agent ac425dcb64175818a, two stop records 4 s apart" is this: telemetry stops 04:01:52.732 and 04:01:56.086, hand-back capture 04:01:55.979 between them). A property loop (`gen.mjs`, 3000 sessions) found no change in run closing or slice finality from an identical duplicate.
- reproduction: `cd $S && node double-stops.mjs $S/state` (stop after stop of one agent with no start between) printed `agents 263 stop-after-stop without a start: 22`, e.g. `a9a31091eeb341134 orchestration:reviewer 2026-10-22T14:24:15.617Z 2026-10-22T14:24:21.491Z false true` (last two fields: `stop_hook_active` of each stop), and `journal stop pairs of one agent within 15 s: 13`. `cd $S && node trace-agent.mjs $S/state ac425dcb64175818a` shows the two stops and the hand-back capture between them. `cd $S && node gen.mjs 7` printed `{"reopen":0,"order":0,"dup":0}`.
- expected: one review, one record (the attempt rule already merges an implementer's repeated stops: `docs/brief-grammar.md:182`); the spec says nothing about reviewer stops of one hand-back, so this is a clarity fix.
- fix scope: `.claude/hooks/journal.mjs` (when `stop_hook_active` is true and the agent's previous stop record has no review or launch after it, mark the new record `continues: true`), `.claude/hooks/brief.mjs` (`foldRuns`: a reviewer stop marked so replaces the previous review instead of adding one), mirror `dashboard/register.tsx`, `scripts/report.mjs`; tests `src/brief.test.mjs`.
- confidence: 75

### G-9: The review gate's documented reason order is not the code's, and `run_state_unreadable` is undocumented

- kind: docs-drift
- severity: low
- where: `README.md:150` ("Review gate reasons, in order: `agents_running`; `no_reviewer_after_last_implementer`, `last_reviewer_failed`, `last_reviewer_no_status`; `constraints_unchecked`; `opus_review_required`; `replan_required`; `implementer_unfinished`; ...") and `docs/brief-grammar.md:262` (the list of gate reasons), against `.claude/hooks/review-gate.mjs:187-195` and `:229-243`.
- what happens: the code pushes `run_state_unreadable` and every `implementer_unfinished` problem before any per-slice problem, and checks `replan_required` before `last_reviewer_failed`; the gate blocks on the first problem with blocks left (`:275`), so `implementer_unfinished` is the first block, not the seventh. `run_state_unreadable` (a block that gives up as `max_blocks_reached`) and the allows `no_telemetry`, `no_implementer_in_session` and `unparseable_input` appear in neither list.
- reproduction: by reading: `review-gate.mjs:187` `if (foldFailed) problems.push({ reason: "run_state_unreadable", ...`, `:188` `for (const u of unfinished) {` (before `// 2. Per slice of the current run.` at `:197`), `:229` `if (counted === "fail" && s.stalled && stallGateOn(process.env)) {` before `:237` `if (counted === "fail") {`, `:275` `const live = problems.find((p) => spent(p) < MAX_BLOCKS);`.
- expected: the code is the intended side (the unfinished check runs "ahead of the `no_implementer_in_session` allow", `.claude/rules/agents.md` 1.2.0); README should list the reasons in the order the gate applies them and name `run_state_unreadable`; the spec's reason list should add it.
- fix scope: `README.md` ("Review gate reasons"), `docs/brief-grammar.md` (reason list), `docs/native-mode.md` (Stop row).
- confidence: 85

### G-10: Docs on the plan check's rewrite, a reply without STATUS, and telemetry's status source lag the code

- kind: docs-drift
- severity: low
- where: `README.md:195` ("For two features it rewrites a launch ... combined into one `updatedInput` when both apply"), `README.md:236` ("A reviewer with no STATUS line fails."), `docs/native-mode.md:84` (telemetry "Records the worker's `STATUS` from `last_assistant_message`, or, when that is empty, from the `SubagentHandback` message or last text block").
- what happens: (a) the plan check's single allow carries five things (haiku raise, read router, coverage note, skill hints, skill facts and DRAFTS lines: `plan-check.mjs:201-203,834`; the rules say "four features"), and README then lists four bullets under "two features". (b) A reply with no STATUS is "neither a pass nor a fail" in the fold (`docs/brief-grammar.md:183`); the review gate blocks it as `last_reviewer_no_status` (`review-gate.mjs:241-242`), it adds no `retry` signal and no failed attempt, so "fails" is wrong. (c) Since 1.4.4 telemetry takes the status from the hand-back capture first (`telemetry.mjs:181-190`, `handbackFor`), which `docs/native-mode.md:84` does not say.
- reproduction: by reading the lines quoted above; for (b), `node spec-edges.mjs` confirms `parseStatus` gives `null` for a reply without a STATUS line, and `brief.mjs:944` keeps it `null` (`const status = r.status === "pass" || r.status === "fail" ? r.status : null;`).
- expected: the code is right in all three; README `:195` should say the allow combines all of its features, `:236` should say "A reviewer with no STATUS line does not pass (`last_reviewer_no_status`)", and `docs/native-mode.md:84` should name the hand-back capture first.
- fix scope: `README.md`, `docs/native-mode.md`.
- confidence: 85

### G-11: `REPLAN:` reads a leading number, so `REPLAN: 1a`, `1.5` or `0x2` count as a replan

- kind: docs-drift
- severity: low
- where: `.claude/hooks/brief.mjs:266` (`field(t, "REPLAN")?.match(/^\**[ \t]*(\d+)/)`), mirrored in `dashboard/register.tsx:148`; spec `docs/brief-grammar.md:102` ("`REPLAN: <n>`: a non-negative integer, else `null`").
- what happens: any value that starts with digits is taken (`1a` is 1, `1.5` is 1, `0x2` is 0, `2 (second)` is 2). The effect is small (a REPLAN extends the open run instead of opening a new one), but the spec promises `null` for anything that is not an integer.
- reproduction: `cd $S && node replan-values.mjs` (`parsePlan("PLAN REVIEW\nREPLAN: " + v).replan`) printed `"1a" 1`, `"1.5" 1`, `"2 (second)" 2`, `"1e3" 1`, `"0x2" 0`, `"yes" null`. `cd $S && node spec-edges.mjs` (36 spec edge cases of the line rule, header, plan and reply) reports only `DIFF REPLAN 1a: got 1 want null`; the other 35 match the spec.
- expected: either the spec says "the leading integer" (keeping `2 (second)` working, which seems intended), or the parser requires the whole first word to be digits; the owner decides. Changing the parser means the mirror and `src/fixtures/briefs` together (`.claude/rules/agents.md`, brief grammar rule).
- fix scope: `docs/brief-grammar.md:102` (or `.claude/hooks/brief.mjs`, `dashboard/register.tsx`, `src/fixtures/briefs/*`, `src/brief.test.mjs`).
- confidence: 80

### G-12: `PATH: light` lets the first slice of a multi-slice plan start before its plan review finished

- kind: bug
- severity: medium
- where: `.claude/hooks/plan-check.mjs:895-911` (`const light = lightBrief && others.length === 0;` and `if (!reviewed && !light)`): "light" is judged only by the slices launched so far, never by the open planned run's `planned` list.
- what happens: a background PLAN REVIEW of slices a, b, c is still running (its launch record exists, so a planned run with three planned slices is open and not reviewed). An implementer brief for a with `PATH: light` is allowed as `light_path`, skipping `no_plan_review`; only the second slice is held. The light path is meant for a task with a single slice.
- reproduction: `cd $S && node g-light-bypass.mjs` (live `plan-check.mjs`, plan a,b,c launched in the background, no reviewer stop yet):
  ```
  launch a PATH: light: exit 0 light_path run=1
  launch b (no PATH): exit 2 no_plan_review run=1
  launch c PATH: light: exit 2 light_path_multi run=1
  ```
- expected: `docs/brief-grammar.md:270`: "`no_plan_review` waits for this run's plan reviewer to stop"; `:24` "`PATH` ... (the single-slice light path)"; `README.md:143` and `docs/native-mode.md:82`: "`PATH: light` skips it for the run's single slice". A planned run with more than one planned slice has no single slice.
- fix scope: `.claude/hooks/plan-check.mjs` (`light` also requires that the open run is not planned, or that its plan has at most one slice), tests `src/plan-check*.test.mjs`; `npm run build-plugin`.
- confidence: 85

### G-13: The spec still lists the built-in agents by name, without `web-fetch`

- kind: docs-drift
- severity: low
- where: `docs/brief-grammar.md:270` ("`builtin_agent_in_run` blocks fork and the built-ins (`general-purpose`, also meant by a missing `subagent_type`, `claude`, `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`)").
- what happens: the list misses `web-fetch` (in `BUILTIN_AGENTS` since 2.1.325, `.claude/hooks/builtin-agents.mjs`), and it also ignores names learned per machine (`learnedBuiltins`). The code is right.
- reproduction: by reading: `builtin-agents.mjs` `export const BUILTIN_AGENTS = Object.freeze([ "general-purpose", "claude", "Explore", "Plan", "claude-code-guide", "statusline-setup", "web-fetch", ]);` against the spec line quoted above.
- expected: `CLAUDE.md` (1.2.2): "Never name a built-in agent anywhere else" than `.claude/hooks/builtin-agents.mjs`; the spec should point to `BUILTIN_AGENTS` (and the learned file) instead of naming them.
- fix scope: `docs/brief-grammar.md:270`.
- confidence: 90

### G-14: A capture the quote check refused is also used at the stop (new case of a known problem)

- kind: known (`CHANGELOG.md:59`, 1.4.4 "Known and not fixed": "A report that the hand-back check sends back is still captured, so a worker that then stops without handing back again is recorded with the undelivered report."; same in `README.md:417`)
- severity: low
- where: `.claude/hooks/handback-check.mjs:89-95` (captures before any check, and cannot see a denial by `quote-check.mjs`, which runs beside it on the same PreToolUse), `.claude/hooks/state.mjs:157-168` (`handbackFor` takes the latest capture newer than the agent's last stop, whatever happened to it), `.claude/hooks/telemetry.mjs:181-190`.
- what happens: new evidence: the known entry names the hand-back check, but a hand-back refused by the quote check (researchers) is captured the same way; when the researcher then ends with a text report instead of a new hand-back, telemetry records the refused report's status.
- reproduction: `cd $S && node g-stale-capture.mjs` (live `handback-check.mjs` captures `STATUS: pass`; live `telemetry.mjs` SubagentStop with `last_assistant_message` `STATUS: fail ...`):
  ```
  handback-check exit 0
  telemetry stop exit 0 recorded status: pass | last_assistant_message: "STATUS: fail\nOPEN: the quote could not be found"
  ```
- expected: as the known entry: the stop records the report that was delivered.
- fix idea: have each PreToolUse hook that denies a hand-back append a `denied: true` marker for that capture (or have `handbackFor` skip a capture followed by a `gates.jsonl` deny of the same agent from `handback` or `quote` with a ts at or after it), so a denied capture is never preferred. Files: `.claude/hooks/state.mjs`, `.claude/hooks/quote-check.mjs`, `.claude/hooks/handback-check.mjs`, tests `src/handback.test.mjs`.
- confidence: 85

### G-15: The haiku rule misses older and provider-prefixed haiku ids

- kind: bug
- severity: low
- where: `.claude/hooks/plan-check.mjs:570-574` (`modelRank`: `/^(?:claude-)?(haiku|sonnet|opus|fable)(?:$|-)/`), used by `raiseHaiku` (`:276-294`).
- what happens: `haiku` and `claude-haiku-4-5` are raised to sonnet, but `claude-3-5-haiku-20241022`, `claude-3-haiku-20240307` and a Bedrock id such as `us.anthropic.claude-haiku-4-5-20251001-v1:0` rank `null`, so a launch (or an agent file) naming one of them runs on haiku with no raise and no `model-floor.jsonl` record. The same `null` rank also makes the read router skip such a researcher (`model_unranked`), which is its documented fail-safe; for the haiku rule it is a miss.
- reproduction: `cd $S && node g-haiku.mjs` (live `plan-check.mjs`, reviewer launch with each `model`):
  ```
  haiku                                          exit 0 updatedInput.model=sonnet
  claude-haiku-4-5                               exit 0 updatedInput.model=sonnet
  claude-3-5-haiku-20241022                      exit 0 updatedInput.model=null
  claude-3-haiku-20240307                        exit 0 updatedInput.model=null
  us.anthropic.claude-haiku-4-5-20251001-v1:0    exit 0 updatedInput.model=null
  ```
- expected: `.claude/rules/agents.md` ("the haiku rule (a launch of any of this plugin's or project's five agents whose model is in the haiku family, from the call or the agent file, gets `model: sonnet`"); `CLAUDE.md` Rules: "Haiku is not used". Whether the Agent tool's `model` accepts a full id is not proven here; an agent file's `model:` line does take one.
- fix scope: `.claude/hooks/plan-check.mjs` (a haiku test that finds the word `haiku` anywhere in the id for the haiku rule, keeping `modelRank` strict for the router), test `src/model-floor.test.mjs`; `npm run build-plugin`.
- confidence: 70

## Unproven

- Turn warning after a resume: `turn-budget.mjs` counts every assistant message in the agent's transcript, which a `SendMessage` resume continues. If Claude Code's `maxTurns` restarts at a resume, a resumed worker is warned too early and, since the marker is once per agent, not again near its real limit. Not checked: no live probe of how `maxTurns` counts across a resume.
- `journal.mjs:73-74` (`agentIdOf`) takes the first `agentId` match anywhere in a foreground result when the response has no `agentId` field; a report that quotes another agent's id could give the launch record the wrong `agent_id`. Not reproduced against a real foreground `tool_response` (its exact shape was not captured here).
- An implementer slice named `plan` (`SLICE: plan`) and its reviewer: the fold takes any reviewer stop with slice `plan` as a plan review (`brief.mjs:925`), which would mark the run plan-reviewed. Contrived; not run.
- A PLAN REVIEW without slice lines opens a planned run with `planned: []` that `closeIfDone` (`brief.mjs:839-842`) never closes; it only goes stale. Seen in the live copy (session 9722ac15, runs 1 and 2: `planned=[] closed=false stale=true`), but those records predate the `plan` field, and no harm beyond later light tasks joining that run was shown.
- Leads checked and explained, no finding: (1) reviewer stops with `status: null` in session b34157a4 (00:04, 00:39, 01:34 UTC) are all before the 1.4.4 hand-back fix (release commit ecd9f14 at 02:35 UTC); none later. (2) The `merged-result` reviewer stops with `run: null` (04:08 to 05:01 UTC): a refold at each write time (`cd $S && node run-field.mjs $S/state`) shows run 6 already closed (every slice final) and `merged-result` in no run, so `null` is what `runOf` should give; such a post-merge review is not seen by any gate, as documented ("The review gate ... only sees implementers"). (3) Duplicate stops: G-8.
- Property loop (`cd $S && node gen.mjs 7`, 3000 generated sessions of plan reviews, REPLANs, light and planned implementer launches, resumes, reviews with gaps, VALIDATE, test-gate records, telemetry and 31-minute idle spells): no closed run reopened, line order did not change any outcome, and an identical duplicate stop line changed nothing. A duplicate 4 s later (`gen-late-dup.mjs`) can change outcomes only when another review arrives in those 4 s, which the live double stops (G-8) do not show.

