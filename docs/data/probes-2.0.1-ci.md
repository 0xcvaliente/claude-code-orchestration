# Probes 2.0.1: the CI failure of `src/test-gate-records.test.mjs` (pull request #31)

Date: 2026-11-18. Repo at `bc04989` (2.0.1, branch `fix/reviewer-loop-2.0.1`), compared with `4ecf82f` (2.0.0, `main`).
Local machine: Linux, 8 CPUs. Scripts and copies live in the session's scratchpad (`s7/`), never in `.claude/state/`.

## The failure

CI job `check` of pull request #31 (run 44322958852, head `bc04989`) passed typecheck, check-agents and check-plugin
and failed the test step on one test:

- `src/test-gate-records.test.mjs:206`, "the hand-back's block names what failed, and the stop that reuses its fail
  names the same tests and file", assertion at `:217`: the hand-back record's `store` was `recent_change`, expected
  `stored` (`actual: [ 'handback', 'tests_failed', 1, [ 'tests/test_a.py::test_one' ], 'recent_change' ]`).

```
gh run view 44322958852 --log-failed | grep -E "✖|recent_change|check failed"
```

## Main at 4ecf82f fails the same way

`gh run list --branch main --limit 10`: the `ci` workflow's run at `4ecf82f` is 44270898410, **failure**; the
successful run at that commit is the other workflow ("Update Mac copy", 44270898591), not `ci`. Its job log
(`gh run view 44270898410 --log-failed` printed nothing; read with
`gh api repos/<owner>/<repo>/actions/jobs/134686943910/logs`) shows the same test, the same assertion, the same actual
value `'recent_change'`. So the failure is **not a regression of 2.0.1**: 2.0.0 shipped it.

That run also failed a second test, `src/test-gate-lock.test.mjs:114`, "two gates that find the same stale lock side by
side: one takes it over, the suites never overlap" ("one suite after the other": `false`). It did not fail on the
pull request's run and is not investigated here ([limits](../limits.md), I).

## Cause

The test's own setup, not a hook. At `bc04989`, `src/test-gate-records.test.mjs`:

- `:211` waits 700 ms so that every listed entry is older than the 300 ms guard the test gives `verify.sh`
  (`--recent-ms=300`);
- `:213` then makes the state folder, `mkdirSync(state(s.dir), { recursive: true })`, **after** the wait. In this
  fresh repo `.claude` does not exist yet, so this makes `.claude` and `.claude/state`; making `state` inside `.claude`
  sets the mtime and ctime of `.claude`.

The listing watches `.claude` itself: only `.claude/state` (and `.git`, `.claude/worktrees`) is left out
(`.claude/hooks/test-gate-cache.mjs:69` `LEFT_OUT`, skipped at `:255`). So `.claude` is the newest listed entry, and the
store refuses with `recent_change` (`.claude/hooks/test-gate-cache.mjs:293`,
`l0.maxMs > l0.clock0 - recentGuard(recentMs)`) whenever `verify.sh` reaches its L0 listing (`.claude/hooks/verify.sh:876`,
after the event parse, the key and the lock) within 300 ms of the test's `mkdirSync`. That is a race between the test's
write and the hook's start-up time: a machine that starts the hook faster than 300 ms fails, a slower one passes. The
guard does what it should (a change 300 ms before L0 is recent); the test broke its own precondition.

Evidence (scratchpad `s7/probe.mjs`: the test's hand-back step, with L0 copied out of the gate's temp folder by the test
command; per run it prints the time from the test's `mkdirSync` to L0's clock, the newest listed time's age at L0 and
the ctime age of `.claude` at L0):

```
node s7/probe.mjs .claude/hooks/verify.sh 5
{"store":"stored","mkdir_to_L0_ms":565,"spawn_to_L0_ms":562,"maxMs_age_at_L0":564.3,"dotclaude_ctime_age_at_L0":565}
{"store":"stored","mkdir_to_L0_ms":420,"spawn_to_L0_ms":420,"maxMs_age_at_L0":420.4,"dotclaude_ctime_age_at_L0":421}
...
```

The newest listed time is the `.claude` folder's ctime in every run (the two ages agree to 1 ms), and it is exactly the
time of the test's `mkdirSync`. The margin over the guard is only the hook's start-up time.

| hooks | time from spawn to L0 (20 runs, ms) | store |
|---|---|---|
| `bc04989` (2.0.1) | min 419, median 517, max 1467 | stored 20 of 20 |
| `4ecf82f` (2.0.0, `git archive 4ecf82f .claude/hooks`) | min 343, median 423, max 636 | stored 20 of 20 |

Locally the margin never fell under 300 ms, so the test passed: 10 of 10 alone at `bc04989`, and the `4ecf82f` test
file run against the `4ecf82f` hooks 20 of 20 (`s7/old/old-hooks.test.mjs`). The CI runner reaches L0 sooner.

**Does the 2.0.1 `verify.sh` change cause it?** No. It makes it slightly *less* likely: 2.0.1's gate parses the event
with node before anything else, which adds about 90 ms (median 517 against 423) before L0, and so widens the margin. The
pull request's run failed anyway because the CI runner's start-up stays under 300 ms with either version. CPU load
beside the test slows the hook down and so also widens the margin; the failure belongs to a fast start, not a slow one.

## Reproduction

The race made deterministic, two ways:

1. The guard widened from 300 to 600 ms (`s7/force/make.sh`: a scratch copy of the test that imports the project by
   absolute path and passes `--recent-ms=600`; a 300 ms wider guard is the same as a hook that reaches L0 300 ms sooner):
   the test as it was at `bc04989` fails **5 of 5** with the CI symptom (`+ 'recent_change'`, `- 'stored'`); the fixed
   test passes 5 of 5 under the same 600 ms guard.
   ```
   s7/force/make.sh src/test-gate-records.test.mjs s7/force/before.test.mjs
   npx tsx --test --test-name-pattern="hand-back's block names" s7/force/before.test.mjs   # fail 1: 'recent_change'
   ```
2. The precondition the test relies on, asserted where the old test stood (`s7/force/precondition-before.test.mjs`: the
   `bc04989` test plus one assertion right after its late `mkdirSync`, "no listed entry changed within 300 ms"): fails
   at once, `newest listed entry 28.7 ms old`.

## Fix

`src/test-gate-records.test.mjs`, the test above: the state folder is made **before** the 700 ms wait, so every
listed entry (`.claude` included) is at least 700 ms old when the hand-back gate starts, whatever the hook's start-up
time; writing `handbacks.jsonl` inside `.claude/state` after the wait touches no listed entry. The test now also
asserts that precondition before the hand-back (`listTrees(scanRoots(dir))`: a full listing whose newest time is at
least 300 ms old), so a later change to the setup fails with a message that names the newest entry's age instead of
an unexplained `recent_change`.

What it pinned before and pins now: the same assertions, unchanged and none loosened: the hand-back gate blocks
(exit 2); its record is `at: handback`, `reason: tests_failed`, `failed_count: 1`,
`failed_tests: ['tests/test_a.py::test_one']`, `store: 'stored'`; the stop blocks (exit 2) and reuses the fail
(`reused: 'fail'`) with the same `failed_count`, `failed_tests` and `output`; the kept output file exists. Added: the
precondition assertion. No hook changed: `test-gate-cache.mjs` and `verify.sh` are as they were, so no stale hand-back
result becomes reusable and no block becomes an allow. The two sibling tests that use `--recent-ms`
(`src/test-gate-handback.test.mjs` `setup`, `src/stop-gate-record.test.mjs` `setup`) already make `.claude/state`
before their wait.

Repeat runs after the fix: `npx tsx --test src/test-gate-records.test.mjs` 20 of 20 alone, and 5 of 5 with eight
busy CPU loops (`node -e 'for(;;){}'`, one per CPU, started and killed by the same command) beside it.
