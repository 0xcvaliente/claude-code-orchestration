# Probes 2.0.1: the gate soak

Date: 2026-11-18. Claude Code 2.1.327 installed, repo at `fa4ddb9` (2.0.0) plus the uncommitted slices s1, s2 and s6.
Asked for: "a test to see if there are more bugs appearing ... not longer than 1 hour".

## What the soak is

`scripts/soak-gates.mjs` (`npm run soak -- --minutes N --seed S`): a seeded, model-free soak of the real hooks in
`.claude/hooks`. Default 10 minutes; `--minutes` above 60, or anything that is not a positive number, exits 2 and runs
nothing. It stops starting sequences at its deadline, cuts a running one at its next step (not checked) and kills any
hook still running 5 s later. One summary line: seed, sequences, hook calls, violations; exit 0 clean, 1 with a
violation. Each violation prints its invariant, seed, sequence and step and a `REPLAY <json>` line (`--replay FILE`
runs it again; the same seed makes the same sequences, `--sequences K` runs only the first K). No model call, no
network; every sequence works in its own temp project (state dir, transcripts, a fake test command that reads a flag
file), removed at the end; the project's `.claude/state` is never read or written. `--hooks DIR` drives another hooks
folder (a copy of the unfixed hooks shows a finding red); `--plant` adds a hook that crashes (the test of the report).

A sequence: a PLAN REVIEW, then 2 to 4 workers (implementer, reviewer, researcher, integrator; bare or
`orchestration:` types; 5 % with no agent id) interleaved at random with global steps. Payload shapes are those of
`src/reviewer-loop.test.mjs`, `src/stop-gate-record.test.mjs` and the two earlier probe pages. Hooks of one event run
side by side, as Claude Code runs them:

| event | hooks |
|---|---|
| launch (PreToolUse, PostToolUse on Agent; SubagentStart) | `plan-check.mjs` (reviewer hold included; a refused reviewer is launched again, at most 4 tries), `journal.mjs`, `telemetry.mjs` |
| hand-back (PreToolUse on SubagentHandback) | `handback-check.mjs`, `quote-check.mjs`, `verify.sh --handback`; a refused report is fixed or sent again, at most 3 tries |
| stop (SubagentStop, `background_tasks` listing running agents and a shell in random order) | `telemetry.mjs`, `journal.mjs`, `verify.sh` (bare `implementer`), `quote-check.mjs` (researcher); a blocked stop is fixed and stopped again with `stop_hook_active` |
| orchestrator Stop | `review-gate.mjs`; at the end up to 16 tries with nothing running |

Worker life cycles: a text stop; a hand-back and its stop; a text turn held back and a forced hand-back with the
continued stop (other workers' steps may come between, a retry's launch or stop among them); a refused hand-back; a
wake after delivery (a late shell's notification or a typed prompt, with and without a SubagentStart); a SendMessage
resume (coordinator message in the transcript) that hands back, puts STATUS in its last message, only in its transcript,
or nowhere; tests that pass, fail then get fixed, or keep failing. Global steps: malformed and empty payloads to every
hook, a truncated or garbage log line, faults on one state log (its whole-file read, its read by fd, its writes, or the
log replaced by a folder, through a `NODE_OPTIONS` preload), and the faults lifted. 30 % of sequences are headless (no
transcript).

Invariants (named functions in the script): I1 caps (hand-back check 1, quote check 1, test gate 2 per agent since its
start, plan check 2 per reason and slice, reviewer hold 2 per slice, agent and block, review gate 2 per reason since the
last implementer stop, `implementer_unfinished` 2 per agent); I2 the Stop is let through within 16 tries once nothing
runs, and never blocked while a subagent is listed running; I3 one delivered review is one review in `foldRuns`, with
an attempt no later than itself, and a woken implementer adds no attempt; I4 every review episode is in the fold with
its delivered status; I5 exit 0 or 2, 0 on malformed input; I6 wall time under the registered timeout, a node hook's
CPU time under 5000 ms; I7 an implementer stop leaves a test-gate record, and a first stop since a start pairs; I8 no
brief or report text in any state file; I9 only `plan-check.mjs` prints an allow.

Exemptions, exactly as `scripts/soak-gates.mjs` applies them (none touches I2, I6, I8 or I9):

- **An agent touched by a fault** (`tainted`: a log fault was active during one of its hook calls) is left out of I3, I4 and I7 (its
  records may be lost by design); I7 and the woken-implementer check of I3 (`I3_wakeAddsNothing`) are also skipped for
  any stop made while a fault is active (`ctx.fault`).
- **Agents without an id** (`noId`, 5 % of workers) are left out of I3 and I4 (`I3_I4_reviews` skips `!a.id`) and of I7
  (checked only for `a.id`). Their I1 test-gate cap is counted per worker (`noid<i>`).
- **Reviewers not launched, or refused at launch** (`!a.launched`, `a.refused`) are left out of I3 and I4.
- **Headless text stops** whose STATUS line is only in the transcript or missing (`unknowable`: without a transcript the
  report cannot be read) are exempt from I4 (a missing review, or a status that differs); I3 still counts them.
  Headless sequences skip the woken-implementer check of I3 (the limit below).
- **The double fault** (`doubleFault`: `gates.jsonl` replaced by a folder) exempts the test gate's refusals from I1, and
  nothing else (the limit under "For docs/limits.md").
- **A hook call that timed out** is checked by I6 only: I5 skips it, and I7 skips a stop whose test gate timed out.

## Rounds

| round | seed | minutes | hooks | sequences | hook calls | violations |
|---|---|---|---|---|---|---|
| trial | 1 | 1 | before the fixes | 29 | 1,639 | 7 (I4 3, I1 4) |
| 1 | 101 | 8 | before the fixes | 223 | 11,704 | 83 (sequences with one: 23) |
| 2 | 101 | 8 | after the fixes | 217 | 11,449 | 1 (I3: a headless implementer woken after delivery, the limit below; the check now skips headless sequences) |
| 3 | 1 | 1 | after the fixes | 23 | 1,330 | 0 (exit 0 in 65 s) |
| reviewer | 77413 | 6 | after round 2's fixes | 145 | 8,151 | 5 (I1: the test gate refused one implementer 7 times with the whole-file read of gates.jsonl failing, finding 11) |
| reviewer checks | - | 2 x 1 | after round 2's fixes | - | - | - |
| 4 | 77413 | 6 | after finding 11's fix | 166 | 9185 | 2 (I1: seq 147, an implementer with no agent id refused 3 and 4 times; finding 12) |
| replay | 77413, seq 147 | 0.1 | after finding 12's fix | 1 | 73 | 0 |
| reviewer, second round | 52817 | 6 | after the fixes | 123 | 6,521 | 0 |
| validator | not recorded | 1.3 (78 s) | after the fixes | not recorded | not recorded | not recorded |

Total soak time: about 42 minutes, under the 60-minute cap: this slice's rounds 24 minutes plus the 8 s replay (trial 1, rounds 1 and 2 8 each, round 3 1, round 4 6), the reviewer's rounds 14 (seed 77413 6, the checks 2, seed 52817 6), the validator's 78 s run, and about 2 minutes in `src/soak-gates.test.mjs` runs. Round 1 by kind: I1 review gate 56 (42 `no_reviewer_after_last_implementer`
and 14 unlogged blocks, all under a fault on `gates.jsonl`), I4 14, I2 4, I1 test gate (no agent id) 4, I3 3, I5 2.

## Findings

Each fixed defect has a test in `src/soak-findings.test.mjs`, run against the hooks before the fix (all seven red,
2026-11-18) and after it (green).

1. **Quote check counts refusals it cannot read (item a)**. Smallest sequence: a researcher's hand-back with an
   unverified QUOTE, three times, with the whole-file read of `quotes.jsonl` failing. Before: exit 2, 2, 2 (`S1 ...
   at its hand-back`: "refused at most once ... got 2,2,2"); at a stop with an unwritable log also 2, 2, 2 (`S1 ...
   stop twice`). Root cause: `quote-check.mjs:111` read earlier refusals with `readJsonl` (an unreadable log reads as
   none), and `:300-305` refused at a stop even when its record was not written. Fix: `readJsonlOrNull`; an unreadable
   log means "refused before"; a refusal needs its record read back, at a stop too.
2. **A woken implementer's extra stop is a new attempt (item b)**. Sequence: implementer hands back, reviewer passes,
   the implementer is woken by a shell notification or a typed prompt (with or without SubagentStart) and stops with
   text. Before: attempts 1 to 2 and the review no longer current (`S2 ...`: "no new attempt, actual 2"; soak round 1,
   3 cases). Root cause: `journal.mjs` recorded every implementer stop. Fix: the wake rule (no hand-back since the
   previous stop record, no STATUS line, `stop_hook_active` false, no coordinator message since) now covers an
   implementer whose transcript shows no tool call since its previous stop; a headless implementer still counts (whether
   it worked is unknown).
3. **A resumed reviewer's report without STATUS in its last message was dropped (item c)**. Sequence: a reviewer
   delivered, is resumed with SendMessage, and stops with its STATUS line only in an earlier transcript turn, or with
   none. Before: one review instead of two (`S3 ...`: actual `['fail']`, expected `['fail','pass']`; soak round 1).
   Root cause: `journal.mjs:256` (before) dropped any such stop as a wake. Fix: a coordinator message
   (`isMeta`, `origin.kind: "coordinator"`) after the previous stop record marks a resume: the stop is recorded, its
   report taken only from the turn after that message (null when it has no STATUS). Headless (no transcript) the two
   cannot be told apart: the stop is still dropped (for `docs/limits.md`).
4. **A resumed reviewer's forced hand-back replaced its earlier review** (new). Sequence: reviewer delivers fail, the
   implementer retries, the reviewer is resumed, ends with a text turn (dropped as a wake, or recorded), hands back
   pass and stops with `stop_hook_active` true. Before: `continues: true` replaced the old review in place, so the retry
   had no review (`S4 ...`: actual `['pass']`). Root cause: `journal.mjs` set `continues` on any earlier stop record of
   the agent. Fix: only a record since the agent's latest SubagentStart counts.
5. **Test gate without an agent id had no cap** (new). Sequence: an implementer stop with no `agent_id` and failing
   tests, four times. Before: 2, 2, 2, 2 (`S5 ...`). Root cause: `verify.sh` counted blocks only with an agent id
   (`count_blocks`, `[ -n "$agent_id" ]`). Fix: id-less `tests_failed` blocks count per session.
6. **A refusal whose log cannot be read or written was made at every try** (new): the review gate (`gates.jsonl`
   unreadable or a folder: round 1, 56 I1 and 4 I2 violations), the plan check (`plan-check.jsonl`) and the reviewer
   hold (`review-hold.jsonl` unreadable). Before: 2, 2, 2, 2 each (`S6 ...` three tests). Root cause: each read its
   earlier blocks with `readJsonl` and wrote its block with no read-back (`review-gate.mjs` `decide`, `plan-check.mjs`
   `decide` and `reviewHold`). Fix: `readJsonlOrNull`; no block unless the earlier records were read and the block's
   record reads back; otherwise `<reason>_unrecorded` (the review gate adds its unverified systemMessage).
7. **The test gate ran on input that is not a hook event** (new). Sequence: `null` (or `[1,2]`, `"x"`, broken JSON,
   nothing) to `verify.sh` while tests fail. Before: exit 2 with a record (`S7 ...`: actual 2; round 1, sequence 55).
   Root cause: when node refused the input, `verify.sh` fell back to its text match, found no agent type, and gated.
   Fix: node present and the input refused: exit 0 before anything runs.
8. **Item d, the pane's `GATE_REASONS`**: not a defect. `dashboard/register.tsx` `GATE_REASONS` and `GATE_PHRASES` name
   the reasons that deny an Agent launch (`denialOf` reads only a denied launch); `test_gate_error` is a test-gate allow
   record and `test_gate_no_result` a note on an allowed reviewer launch, neither a denial. The pane's
   `TEST_GATE_REASONS` mirrors `brief.mjs`'s, which leaves `test_gate_error` out on purpose (stop-gate page, path 4).
   No pane change.
9. **Item e, `src/judge.test.ts:2452`**: not reproduced here. The failing run (3285 ms against 2000 ms of CPU time)
   came while other tests ran; CPU time is not wall time, but a loaded machine still slows it (shared caches,
   frequency, other processes on the same core). This slice did not run it under load within its budget, so there is
   no evidence to change the bound; `src/judge.ts` is frozen and was not touched. Next step: run the judge test 20
   times beside `npm test` and record the distribution.
11. **The test gate's block count read an unreadable log as 0** (found by the reviewer's round). Smallest sequence:
    the whole-file read of `gates.jsonl` failing, failing tests, the same implementer stopping five times. Before:
    2, 2, 2, 2, 2 (`S8 test gate: with the whole-file read of gates.jsonl failing, one agent is blocked twice, then let
    through`: actual [2,2,2,2,2]). Root cause: `bugfix-check.mjs` `countBlocks` (`:698`) read an unreadable log as no
    blocks and printed 0, so `verify.sh` `count_blocks` (`:491-498`) never fell back to its grep. Fix: `countBlocks`
    returns null (printed `null`) for a log that exists and cannot be read; `verify.sh` then counts with grep, so the
    cap holds whenever either reader can read the log. Its own bugfix count keeps reading unknown as 0 (blocks as before).
12. **A NUL byte in gates.jsonl reset the test gate's grep counts** (seed 77413, seq 147, after finding 11's fix).
    Smallest sequence: `gates.jsonl` holding a line with a NUL byte (a torn write), an implementer stop with no agent id
    and failing tests, four times. Before: 2, 2, 2, 2 (`S9 test gate: a NUL byte in gates.jsonl does not reset the cap of
    a stop with no agent id`: actual [2,2,2,2]). Root cause: grep treats such a file as binary and prints no lines, so
    the id-less session count (`verify.sh` about `:1055`) and `count_blocks`' fallback (`:496`) read 0. Fix: `grep -a`
    in both. Replay of seq 147 after the fix: 0 violations.
10. **Load flake seen**: `src/gate-hardening-time.test.mjs:108` failed once while 13 test files ran side by side (a 3 s
    budget, the hook's start-up took 2 s, "did not finish within 1 seconds"); it passed alone three times. Not changed.

## For `docs/limits.md`

- Headless resume (finding 3): without a transcript a resumed reviewer whose new report has no STATUS line in its last
  message cannot be told from a wake; its stop is dropped. A hand-back (auto mode) is unaffected.
- Headless wake of an implementer (finding 2): without a transcript the extra stop still counts as an attempt.
- A stop with no agent id shares one test-gate cap per session (finding 5).
- A torn last line with no newline merges with the next record written after it, which is then lost; the soak writes
  torn lines with their newline only.
- **Not fixed: no reader can read the test gate's count** (`gates.jsonl` replaced by a folder, so neither node nor grep
  reads it, and the block's own record cannot be written): `verify.sh` keeps blocking failing tests at every stop, with
  no cap. Reason: the only way to cap it is to let failing tests through on an unreadable log, which C13 forbids; a
  person has to decide whether an unreadable gate log may do that. The soak's I1 exempts exactly this double fault
  (`doubleFault` in `scripts/soak-gates.mjs`: the test gate's refusals while `gates.jsonl` is a folder) and nothing wider.
  The bugfix check's count reads unknown as 0 the same way (it keeps blocking).

## How to run

```
npm run soak                               # 10 minutes, a clock seed
npm run soak -- --minutes 8 --seed 101     # one round of this page
node scripts/soak-gates.mjs --replay seq.json
npx tsx --test src/soak-gates.test.mjs src/soak-findings.test.mjs
```
