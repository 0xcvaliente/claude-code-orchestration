# Probes 2.0.1: the reviewer that goes on after its report

Date: 2026-11-18. Claude Code 2.1.326, repo at `8cb5b1e` (2.0.0). Symptom reported by the person: "the reviewer is
looping when it already delivered the results to the orchestrator ... bugs or loops that is not responding".

Sources read (data, counts and timestamps only; no report or brief text is copied here beyond short quoted lines):

- `.claude/state/journal.jsonl`, `telemetry.jsonl`, `gates.jsonl`, `handbacks.jsonl`, `handback-refusals.jsonl`,
  `review-hold.jsonl` (2026-11-15 to 2026-11-18).
- Orchestrator session transcript `~/.claude/projects/-root-projects-repo-claude-code-orchestration/66cac1f1-0f66-49f2-9790-a86b10833354.jsonl`
  (8546 lines) and its 442 files under `66cac1f1-.../subagents/` (140 reviewers, 54 implementers, 15 researchers, 12
  integrators, by `agentType` in each `.meta.json`).
- The real hooks, replayed with crafted payloads against scratch state under the session scratchpad (`s1/`), never
  against `.claude/state/`.

Scripts used (scratchpad `s1/`): `tl.mjs` (one transcript's record types and times), `agents.mjs` (per-agent counts:
stops, hand-backs, refusals, enforce messages, tool calls and wake-ups after the first delivered hand-back), `q1.mjs` /
`q1all.mjs` (notifications reaching the orchestrator around each stop, and orchestrator Agent/SendMessage calls between
stops), `main.mjs` (queue records per agent id), `h2.mjs` (fold replay), `noread.mjs` (unreadable-log preload).

## Summary

The double stop that fills the journal (a text stop, then about 6 s later a stop with `continues: true`) is **not** a
loop and delivers nothing twice: Claude Code holds the text stop back, tells the reviewer to hand back, and only the
hand-back reaches the orchestrator. The reviewers that really go on after delivering are four, and none of them ran a
tool after delivering. Three were woken by their own shell commands that Claude Code had moved to the background
(a command over its 120 s timeout), and each wake sent the orchestrator one more `completed` notification with a new
`<result>`; one was woken 11 hours later by a typed prompt. Two defects in this repo's hooks were reproduced by replay
(D3, D4); neither fired in the recorded logs.

## Answers

### Q1. Does the first (text) stop already deliver the report?

No. For all 46 reviewers with the double-stop shape, the orchestrator transcript holds **no** task notification or
agent message for that agent between its first SubagentStop and its SubagentHandback call, and holds both after the
hand-back (`q1.mjs`: "with a notification between stop1 and hand-back 0 with one after 46").

Example a25bb13506eb672c6 (journal lines 206-207):

| time (UTC) | where | record |
|---|---|---|
| 03:14:54.787 | subagent transcript line 56 | `assistant` text block starting `STATUS: fail` |
| 03:14:54.850 | subagent line 57 | `user`, `isMeta`, text starting `[handback-send-enforce] Your report has not been delivered.` |
| 03:14:55.118 | journal 206 | SubagentStop record, no `after_handback` |
| 03:15:01.352 | subagent line 59 | `assistant` `tool_use` SubagentHandback |
| 03:15:03.369 | subagent line 60 | `tool_result` (`Report delivered to your caller.`) |
| 03:15:04.314 | journal 207 | SubagentStop record, `continues: true`, `after_handback` |
| 03:15:04.442 | orchestrator line 6035 | `queue-operation` enqueue `<task-notification>` `<status>completed</status>` with `<result>` |
| 03:15:07.195 | orchestrator lines 6039-6040 | dequeue of `<agent-message from="a25bb13506eb672c6">` and of the notification |

So the orchestrator gets the report once per hand-back, in two envelopes delivered together (the agent message and
the notification's `<result>`), 127 of 140 reviewers showing both (`q1all.mjs`). That pairing is Claude Code's.

### Q2. What forces the hand-back after the text stop?

Claude Code itself. The text is an `isMeta` user record starting `[handback-send-enforce] Your report has not been
delivered. Call SubagentHandback({message`. The tag appears in the installed `claude` binary (`strings`) and nowhere in
this repo (`grep -rn handback-send-enforce .claude dist src docs`: no match). It came once per agent (46 reviewers, 4
researchers, 2 implementers, 0 integrators; `agents.mjs` by role). Reviewers end with plain text far more often (46 of
140) than implementers (2 of 54): `.claude/agents/reviewer.md` ends with "Reply in this format:" and, like every agent
file, never names SubagentHandback (`grep -n SubagentHandback .claude/agents/*.md`: no match). Cost per case: one more
turn of about 5 s and one more SubagentStop event.

### Q3. Tool calls after a delivered hand-back; per-agent counts

Over the 140 reviewers of session 66cac1f1 (`agents.mjs ... reviewer`):

| per reviewer | distribution (value: reviewers) |
|---|---|
| SubagentStop records (telemetry) | 1: 88, 2: 50, 3: 1, 4: 1 |
| SubagentHandback calls | 1: 130, 2: 10 |
| refusals (`gates.jsonl` deny, `handback-refusals.jsonl`) | 0: 130, 1: 10 (all `checks_unanswered`) |
| `[handback-send-enforce]` messages | 0: 94, 1: 46 |
| tool calls after the first delivered hand-back | 0: 140 |
| wake-ups after the first delivered hand-back | 0: 136, 1: 2, 2: 2 |

No reviewer re-ran a check, handed back a third time or was refused twice. The four woken after delivery:

| agent | stops | woken by | first delivery to last stop | notifications the orchestrator got after delivery |
|---|---|---|---|---|
| a0792d681a9aaaa5f | 3 | a typed prompt ("continue", record `origin.kind: human`), then the orchestrator's SendMessage | 39400 s (23:05:25 to 10:02:04) | 2 more `completed` |
| a4b3b148d7f3328e8 | 4 | 2 task notifications of its own background shells | 491 s (02:45:23 to 02:53:34) | 2 more `completed` (orchestrator lines 5846, 5888) |
| ad9e67755b1a1a237 | 2 | 1 task notification of its own background shell | 401 s | 1 more `completed` (line 1768) |
| a7004217617dff335 | 2 | 1 task notification of its own background shell | 118 s | 1 more `completed` (line 849) |

The shells were Bash calls Claude Code moved to the background itself: the tool result reads "Command did not
complete within its 120s timeout and was moved to the background" (ad9e67755b1a1a237 at 14:40:10, a7004217617dff335 at
12:43:18). 19 of 140 reviewers had at least one background shell. Each wake makes the reviewer write one text turn
(for example "That background search only finished now, after my report ha...") and stop again, and Claude Code then
enqueues another `completed` notification whose `<result>` is that text, so the orchestrator spends a turn on it
(orchestrator lines 5888-5895: a 155-character reply). a4b3b148d7f3328e8 also stopped once before delivering (02:43:19,
a text turn saying it was waiting for a background run), and the orchestrator got a `completed` notification for that
stop too (line 5798).

Longest time from first delivery to last stop: 39400 s (a0792d681a9aaaa5f); without the typed prompt, 491 s.

### Q4. Workers that started and never stopped; the Stop gate

`telemetry.jsonl`: the only agent whose latest SubagentStart has no later SubagentStop is a7b6be10a16bdca7a, the
implementer of this probe (session 7850a6d4, still running). No delivered reviewer is listed as `running` in any later
`background_tasks` (0 cases). `gates.jsonl` has 282 `review`/`agents_running` allows in 11 streaks; the longest is 165
in a row from 2026-11-17 19:40 to 2026-11-18 08:49 (790 min), with gaps of at most 29 min between records. Each is the
orchestrator ending a turn while workers run (`source: background_tasks`, agents such as `["reviewer"]` 37 times,
`["implementer"]` 22 times). This is the normal wait, not a stuck reviewer; `review-gate.mjs:109-114` (at `8cb5b1e`; the `background_tasks`
branch of `running()`) allows it with no age cutoff, which did not matter here.

### Q5. Did the orchestrator act on the first stop before the second arrived?

Never in the double-stop shape: 0 of 46 have an Agent or SendMessage call for the same slice between the two stops
(`q1.mjs`). Across all reviewers there are two such calls, both after a delivery: the Agent launch at 02:45:36 for
slice f3 (after a4b3b148d7f3328e8 delivered at 02:45:23; the wakes came later) and the SendMessage at 10:01:49 telling
a0792d681a9aaaa5f to stop after the typed prompt woke it.

## Hypotheses

### H1. Unreadable `gates.jsonl` makes `handback-check.mjs` deny the same agent more than once: CONFIRMED (not seen live)

Replay (scratch project `s1/h1`, launch record with `checks: ["C1"]`, a passing report that leaves C1 unanswered; the
preload makes `readFileSync` of `gates.jsonl` throw, and with `NOREAD_TAIL=1` also the fd read):

```
printf '%s' "$P" | NOREAD_TAIL=0 CLAUDE_PROJECT_DIR=$D node --import s1/noread.mjs .claude/hooks/handback-check.mjs
```

- full read fails, tail read works: call 1 exit 2, call 2 exit 2, call 3 exit 2; 3 `deny` records. Claude Code asks
  for a resend at most three times, so a worker refused three times ends with no report delivered.
- both reads fail: exit 0 three times (correct), yet 3 `"decision":"deny"` records are written for denials that never
  happened.
- control, readable state: exit 2, 0, 0; records deny, `checks_unanswered_gave_up`, `checks_unanswered_gave_up`.

Root cause: `handback-check.mjs:118` reads earlier denials with `readJsonl`, which turns any read error into `[]`
(`run.mjs:38-39`), so `deniedBefore` is false; the write is confirmed at `handback-check.mjs:135` through a different
read (`appendJsonl`, a tail read by fd, `run.mjs:49-66`). The two reads can disagree (a log over the maximum string
length, a transient read error). Second issue: the record at `:133` says `deny` before `recorded` is known.
Live evidence: none (no reviewer with two refusals).
Fix: `.claude/hooks/handback-check.mjs` (and `run.mjs` if a throwing reader is added there): read earlier denials with
the same tail reader that confirms the write, or treat a failed read as "denied before" (never deny when the log cannot
be read); write `decision: "deny"` only for a denial that is returned. Add a test in `src/` with the preload approach.

### H2. A retry between a reviewer's two stops is counted as reviewed: CONFIRMED by replay (not seen live)

Replay through the real fold (`node s1/h2.mjs`, `foldRuns` from `.claude/hooks/brief.mjs`; plan review, implementer I1
stop at 10 s, reviewer R1 stop `fail` at 100 s, retry I2 launched at 90 s):

```
A double stop, no retry           | attempts 1 | reviews 1 | reviews of latest attempt fail | countedFails 1
B retry stop between the 2 stops  | attempts 2 | reviews 2 | reviews of latest attempt fail | countedFails 2
C retry stop, single review stop  | attempts 2 | reviews 1 | reviews of latest attempt none | countedFails 1
```

In B, I2 stops at 103 s and R1's continued stop lands at 106 s: it is kept as a second review and attributed to the
retry (`implAt` = I2's stop), so a retry nobody reviewed counts as reviewed and failed, and the slice has two counted
fails. Root cause: `brief.mjs:996` pops the earlier review only when `prev.ts > s.lastImplAt`; otherwise `:1005` pushes
the continued stop as a new review with `implAt: s.lastImplAt`. Live evidence: 0 continued reviewer stops with an
implementer stop of the slice between the two (journal scan). Fix in `.claude/hooks/brief.mjs`: a continued stop
always replaces the same agent's latest review (search back for the review whose `agent` matches, regardless of
implementer stops) and keeps that review's `implAt`; add a fold case to `src/brief.test.mjs`.

### H3. A resumed reviewer is denied again, or its new report dropped: REFUTED

Replay (readable scratch state, three hand-backs of the same agent id): exit 2, 0, 0. The once-per-agent key is never
reset, so a SendMessage resume is never refused again (it is let through and logged as `..._gave_up`), and each call is
captured in `handbacks.jsonl`, the latest one winning at the stop (`journal.mjs` `handbackState`). Not refused, not
dropped. Live: the 6 reviewers with 2 to 4 starts had 0 refusals after a start.

### H4. The same review counted twice: REFUTED for the fold; telemetry and pane not established

- Fold: replay A above, one review for the two stops (`brief.mjs:996` pops the first). A PLAN REVIEW reviewer's
  double stop (replayed in `h2.mjs` as `P1`, two `plan` stops) sets `planReviewed` twice (a boolean) and, with a
  `REPLAN`, pushes two times onto `replans` (`brief.mjs:966-968`), which only clears stalls older than them: no double
  count. `journal-pending.jsonl` holds 1 record.
- Journal: two records per double stop by design (`continues: true` on the second; 46 such reviewer pairs).
- Telemetry: two SubagentStop records per double stop, each with the transcript's `tokens`. Whether `npm run report`
  or `dashboard/register.tsx` adds them up per agent was not checked in this probe.
- Settled after this probe: `npm run report` keeps one stop record per agent, its last (`lastStops` in
  `scripts/report.mjs`), so a double stop is not counted twice there.

### H5. Other paths found

- D1 (Claude Code, mitigable here): late background shells wake a delivered reviewer (Q3).
  `.claude/agents/implementer.md:21` tells implementers to never leave a background shell running and to wait for a
  command moved to the background; `reviewer.md` and `integrator.md` have no such rule.
- D2 (Claude Code, mitigable here): reviewers end with text in 33% of runs, which costs the enforce turn (Q2).
- D5: 30 of 102 implementer stops in session 66cac1f1 have no SubagentStop test-gate record (72 have one) (only the hand-back gate's:
  `handback_timed_out` 8, `handback_lock_wait` 6, `tests_failed_isolated` 6, `tests_passed` 4; 4 stops with no
  hand-back; this split covers 28 of them, the stop-gate page gives it for all 30). `run.mjs` `stopGateOf` then returns null and the plan check adds `test_gate_pending` to every reviewer of
  that slice (`plan-check.mjs:302-304`); implementer abdbfa128cd2c507b drew 5 notes from 03:15 to 03:41. A reviewer so
  told runs the acceptance tests itself (`reviewer.md`), and a suite over 120 s is moved to the background, which is how
  D1 starts. Why `verify.sh` logged nothing at those stops was not established here.
  Settled in [probes-2.0.1-stop-gate.md](probes-2.0.1-stop-gate.md): the gate read the last `agent_type` of the event,
  a reviewer's listed in `background_tasks`, and exited with no record; fixed in 2.0.1.
- D6 (C11): `telemetry.mjs:204-211` copies every string field of the hook payload clipped to 300 characters, so
  `last_assistant_message` (report text) is in 76 `telemetry.jsonl` records (2026-11-15 to 2026-11-18).
- Plugin copy: the enabled user plugin is listed as `orchestration` 1.2.2. Every one of its SubagentHandback and
  SubagentStop hooks (`handback-check`, `quote-check`, `telemetry`, `journal`, `review-gate`) calls `duplicate()` and
  exits when the project registers the same script; its `verify.sh` matchers (`orchestration:implementer`) are
  disjoint from the project's. No per-user plugin state folder exists for this project, so the plugin copy wrote
  nothing here. The same holds for `dist/plugin` (one `duplicate("` per hook).

## Fix list (most likely cause of the symptom first)

1. **D1** late background shells wake a delivered reviewer and post extra `completed` notifications.
   Evidence: Q3 table (a4b3b148d7f3328e8, ad9e67755b1a1a237, a7004217617dff335). Root cause: `reviewer.md` (and
   `integrator.md`) lack the rule at `implementer.md:21`. Fix: add that rule to `.claude/agents/reviewer.md` and
   `.claude/agents/integrator.md` (pass a Bash `timeout` up to 600000 ms for a long acceptance command, wait for a
   moved command's output before reporting, kill what is still running), then `npm run sync-agents` and
   `npm run build-plugin`; and one line in `.claude/agents/orchestrator.md` that a `completed` notification from a
   worker that already handed back is not a new report.
2. **D5** missing stop-gate records keep the reviewer hold at `test_gate_pending`, which makes reviewers run the suite
   (feeding D1). Locator: the 30 stops above (`gates.jsonl` vs `telemetry.jsonl`). Root cause not established; next
   step: replay `verify.sh` (stop mode) after a hand-back gate record of each kind and find which path exits without
   `log_gate`. Files: `.claude/hooks/verify.sh`, possibly `run.mjs` `stopGateOf`.
3. **D3** (H1) repeated hand-back denial on an unreadable `gates.jsonl`: `handback-check.mjs:118`, `:133-135`.
4. **D4** (H2) continued review attributed to a retry: `brief.mjs:996`, `:1005`.
5. **D2** reviewers end with text: add to `.claude/agents/reviewer.md` (and `researcher.md`) that when a
   SubagentHandback tool is offered the report goes through it, not as a last message. Cost only, no loop.
6. **D6** report text in `telemetry.jsonl`: drop `last_assistant_message` (and other free-text fields) in
   `telemetry.mjs:205`.

## Not fixable here (Claude Code)

- The `[handback-send-enforce]` message and the extra SubagentStop it causes: Claude Code's hand-back enforcement.
- Moving a Bash command past 120 s to the background, and waking the subagent with a task notification when it ends,
  even after the subagent delivered.
- A new `completed` task notification, with a new `<result>`, at every later stop of the same agent (the notification's
  own `<note>` says the same task id may notify more than once).
- The report arriving in two envelopes (agent message and notification `<result>`) at one delivery.
- A typed prompt reaching a finished subagent (a0792d681a9aaaa5f, `origin.kind: human`, 11 h after delivery).
