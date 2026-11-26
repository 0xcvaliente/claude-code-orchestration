# Probes 2.0.1: implementer stops with no test-gate record (D5)

Date: 2026-11-18. Claude Code 2.1.326 (the recorded session) and 2.1.327 (installed), repo at `fa4ddb9` (2.0.0) plus
the uncommitted slices s1 and s2. Follows item D5 of `docs/data/probes-2.0.1-reviewer-loop.md`.

Sources read (counts, times and field names only; no report or brief text is copied here):

- `.claude/state/gates.jsonl` and `telemetry.jsonl`, session 66cac1f1 (read only, never written).
- The orchestrator transcript of 66cac1f1: the `<task-notification>` enqueue time of each implementer stop.
- The real `verify.sh`, replayed against scratch projects and scratch state (scratchpad `s6/`), never `.claude/state/`.

Scripts (scratchpad `s6/`): `live.mjs` (per implementer: starts, stops, hand-back and stop records), `predict.mjs`
(each stop: is there a stop record, and what `agent_type` a text match of the stop event reads), `replay.mjs` (the
replay below; `hooks-before/` is a copy of `.claude/hooks` taken before the fix).

## Summary

The 30 stops had no record because the gate never gated them. `verify.sh` read the event's fields with a text match
whose greedy `.*` keeps the **last** `"agent_type"` in the event. At SubagentStop, Claude Code 2.1.326 lists the
session's in-flight work in `background_tasks` after the agent's own fields, with one `agent_type` per running subagent.
When the last subagent in that list was a reviewer, the gate read `agent_type=reviewer` and took the exit meant for
other agents, which writes no record. The hand-back gate never had this problem: a PreToolUse event has no
`background_tasks`. All five kinds below come from this one cause. Fixed by reading the event's top-level fields as
JSON. Two other ways out without a record (a TERM, and a `cd` that fails) now write `test_gate_error`. A SIGKILL still
writes nothing. The plan check stops calling a stop "pending" once the gate can no longer be running.

## Live records (session 66cac1f1)

`predict.mjs` over the 102 implementer SubagentStop records:

| `agent_type` a text match reads | stop has a stop-gate record | stops |
|---|---|---|
| implementer (own field, or an implementer listed last) | yes | 72 |
| reviewer (a reviewer listed last in `background_tasks`) | **no** | 30 |

The split is exact: no stop with a reviewer listed last has a record, and every other stop has one. The hand-back
record before each of the 30 stops, as D5 counted it: `handback_timed_out` 8 or 9, `handback_lock_wait` 6 or 7,
`tests_failed_isolated` 6, `tests_passed` 4, none 4. Timing confirms it. When the gate wrote a record, the orchestrator's
`completed` notification for that agent was enqueued right after the record (ac2ee2297db30c6cd: record 14:33:31.857,
notification 14:33:32.285). Claude Code waits for SubagentStop hooks. At the 30 stops the notification came within 0.3
to 2 s of the stop (a0c79a963000dc8c3: stop 14:34:22.578, notification 14:34:24.472), so the gate had exited at once.
Keys seen in `background_tasks` entries: `id`, `type`, `status`, `description`, `agent_type` (subagents only),
`command` (shells only). No `cwd`, `agent_id` or `session_id`, so in the live data only `agent_type` was misread.

## Replay

Command, once per kind (each kind runs twice: a stop event whose `background_tasks` ends with a reviewer, and the same
event with an empty list):

```
node s6/replay.mjs <hooks dir> [kind...]   # hooks-before/ = unfixed, .claude/hooks = fixed
```

Each case makes a git repo with an isolated worktree `.claude/worktrees/agent-a1` (one changed file) and its own
`TMPDIR`. Where the kind has a hand-back, the case first runs `verify.sh --handback`: a PreToolUse event plus the
`handbacks.jsonl` capture. Then it runs `verify.sh` with the SubagentStop event (`--recent-ms=300`, as in the tests).
Test commands: pass `true`, fail `echo 'not ok 1 - boom'; exit 1`, slow `sleep 20` with `ORCH_TEST_TIMEOUT_S=2`
`ORCH_HOOK_BUDGET_S=60`. For lock wait, a fresh `test-gate.lock` is held by a live process, with
`ORCH_HOOK_BUDGET_S=16`.

| kind (hand-back record) | stop record before the fix, reviewer listed last | before, empty list | after the fix, both shapes |
|---|---|---|---|
| `tests_passed` | none (exit 0 in 199 ms) | `allow tests_passed_cached`, reused pass | `allow tests_passed_cached`, reused pass |
| `tests_failed_isolated` | none (208 ms) | `warn tests_failed_isolated`, reused fail | `warn tests_failed_isolated`, reused fail |
| `handback_timed_out` | none (524 ms) | `warn tests_failed_isolated`, reused timeout, `timed_out:1` | the same |
| `handback_lock_wait` | none (195 ms) | `warn tests_failed_isolated`, `not_run:1` | `warn tests_failed_isolated`, `not_run:1` |
| none (no hand-back) | none (180 ms) | `allow tests_passed` | `allow tests_passed` |

`bash -x` of the unfixed stop gate shows `agent_type=reviewer` at the read and `exit 0` at the type check.

## Root cause and fix, per path

Line numbers are those of `verify.sh` at `fa4ddb9`, before the fix.

1. **Field read** (all five kinds). Root cause: `json_str` at `.claude/hooks/verify.sh:562-564` (before the fix), called
   at `:565-569`, read the last `"agent_type"` in the event. The exit at `:611-613` (`agent_type != implementer`,
   `exit 0`) then wrote nothing. In the same way `agent_id`, `session_id` and `cwd` could be taken from a nested object
   (the test with `agent_id`/`session_id` in a `background_tasks` entry, before the fix, gave a record for `zz9`,
   `other`). Fix: node parses the event once and prints the top-level string fields the gate reads (`agent_type`,
   `agent_id`, `session_id`, `cwd`, `tool_name`, `tool_use_id`). `json_str` reads those. Without node, or for input that
   is not a JSON object, it falls back to the old text match. Malformed input still exits 0. Tests: the five
   `... a stop whose event lists a reviewer last is the implementer's stop and leaves its record` cases, `the shared
   tree: failing tests ... still block with tests_failed` and `the agent's own fields win over the same keys nested
   deeper in the event` in `src/stop-gate-record.test.mjs`.
2. **TERM, INT or HUP during the stop gate** (Claude Code's 900 s hook timeout, or a person's Ctrl-C). Root cause:
   `on_exit` at `verify.sh:416-421` logged an undecided exit in the hand-back mode only, so a stop gate that was ended
   from outside exited with no record. Not seen in the live records. Fix: the gate is armed after the agent-type check
   in both modes, and an undecided stop exit logs `allow test_gate_error`, plus `"interrupted":1` after a signal. Test:
   `a stop gate ended by a TERM ... logs test_gate_error and lets the agent finish`.
3. **`cd` into the agent's folder fails** (`verify.sh:618-620`, `exit 0`). Now logs `test_gate_error` through the same
   `on_exit` path. No test: as root, `cd` into an existing folder cannot be made to fail.
4. **Reviewer note**. `plan-check.mjs` appended "the test gate has not reported yet ... its tests may still fail" to
   every reviewer of a stop with no paired record, however old the stop. Fix: `run.mjs` `stopGateWindowMs` is the gate's
   budget, computed as `verify.sh` computes it (540 s by default), plus 60 s for its worst overrun (B + 20 s) and the
   log write. Within that window the note stays `test_gate_pending`. Past it, or when the stop's record is
   `test_gate_error` (`NO_RESULT_REASONS`), the note says the gate left no result and is no longer running
   (`test_gate_no_result` in `review-hold.jsonl`). A failed-tests block still refuses with `tests_failed_after_report`.
   The review gate's doubt signals are unchanged: `test_gate_error` is an allow and is not in the fold's
   `TEST_GATE_REASONS`. Tests: `a stop older than the gate can run, with no record, gets the no-result note, never the
   pending one`, `a test_gate_error record of the stop gives the no-result note, never a silent pass` and `the window is
   the gate's budget plus its worst-case overrun`. Controls: a recent stop keeps the pending note, and an old stop's
   block still refuses.

Paths checked and found to write a record already (replayed, or read with a test that covers them): a cached hand-back
result taken at the stop (`tests_passed_cached`, a reused fail or timeout), a lock wait that gives up (`not_run:1`), a
test run that uses up the budget (`timed_out:1`), the prose-only skip (`no_code_changes`), no test command
(`no_test_command`), `isolated_skipped`, and the test gate's give-up (`max_blocks_reached`). A clean tree is not
skipped: the suite runs.

## Claude Code's own doing (for `docs/limits.md`)

- **A hook killed with SIGKILL** writes nothing: bash runs no trap. The plan check then says "no result" once the stop is
  older than the window. Not seen live.
- **A SubagentStop hook that never fires** (none seen: every one of the 102 stops has a telemetry record, and the 30
  without a gate record are explained by the field read above).
- **`background_tasks` is session-wide** in a SubagentStop event (its schema: "In-flight background work ... registered
  in this session"). It lists other agents' types, so any hook that reads an event field by text match can read another
  agent's value. `verify.sh` now parses JSON. The node hooks always did.

## Not done here

- `docs/gates.md` (Plan check, the pending-note row), `docs/brief-grammar.md` (Test gate pending line), `docs/logs.md`
  (`review-hold.jsonl` reasons, the new `test_gate_error` gate reason) and `docs/limits.md` (the SIGKILL item above) do
  not yet describe the no-result note and `test_gate_error`. They belong to other slices' files.
- In the replay, the `handback_lock_wait` hand-back stored nothing (`store: key_changed`), so the stop waited for the lock
  again (`reuse: no_entry`, 12.5 s). Not seen live: a4727bffed43a0b5a's stop reused the lock-wait result at once. Not
  investigated.
