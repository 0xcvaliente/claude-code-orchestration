# Fix notes: test gate under load (slice fix-gate-load)

Regression tests: `src/test-gate-load.test.mjs` (six tests, each seen failing before the change, all passing after; about 16 s). `src/test-gate-audit.test.mjs` T-12 now sets a stall limit of one hour, so it still pins the absolute cap of 870 s (with the limit unset the cap is 540 s). Only `.claude/hooks/verify.sh` changed in the hooks; dist/ is not rebuilt here: `npm run build-plugin` must follow the merge.

## Live observation (2026-11-16, this repository)

- Four isolated implementers of one wave stopped between 11:16:08 and 11:17:52 UTC. Each stop ran the gate, and each gate ran the whole suite, then a base run, at the same time as the other three.
- Three gate records came at 11:26:47 to 11:27:06 UTC, 554 to 590 s after their stops (about 120 s is usual). Each was `tests_failed_isolated` with one failing test that also failed on the base under that load.
- The fourth agent was ended by Claude Code with "Agent stalled: no progress for 600s (stream watchdog did not recover)" while its gate still ran. No gate record exists for it, so the run model never saw its test result.
- Official facts: Claude Code fails a subagent that makes no progress for 10 minutes (changelog 2.1.113); the limit is `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`, default 600000; time in a stop hook counts. The gate's budget was 870 s by default, its test run 600 s, a base run 300 s, its hook timeout 900 s: all of them could pass the stall limit.

## Item 1: budget under the stall limit

- Changed: `verify.sh` reads the stall limit from `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` when it is a positive whole number of milliseconds (600 s otherwise; more than 15 digits counts as far above 870). The budget's maximum is min(870, stall limit in seconds - 60), at least 1. It is the default; `ORCH_HOOK_BUDGET_S` above it is cut to it, below it is kept. The test run still gets min(its own limit, time left), so with the default budget the time left (at most 540 s) decides, not the 600 s limit. Header comment: worst cases are now B + 8 and B + 20 for a budget B, 548 and 560 s by default (under 600), 878 and 890 s at most (under 900).
- Effect for a person: with Claude Code's defaults the gate always writes its record before the agent's 600 s stall limit, so a slow or loaded suite ends as a test-gate record (a block, or `tests_failed_isolated`) instead of a stalled agent with no record. Someone who raised the stall limit gets a larger budget, up to 870 s.

## Item 2: one suite at a time

- Changed: `verify.sh` takes a lock, `test-gate.lock` in the gate's state dir, before the test run and holds it through the base run or bugfix check until the hook ends. The state dir comes from `CLAUDE_PROJECT_DIR` (or the plugin's per-user dir keyed by that path), never from the agent's cwd, so every worktree of a project shares it. The lock file holds `<pid> <start epoch seconds>`; it is written to a private file and hard-linked into place (`ln` fails when the name exists: atomic, never half written). A waiter sleeps one second between tries, and the wait counts against the budget. A lock whose holder is gone (`kill -0`, then `ps -p` for a process of another user) or older than the hook timeout (900 s) is stale: one waiter at a time (a `test-gate.lock.takeover` dir, itself broken after 2 minutes with `find -mmin +2`) removes it, after reading it twice, and every waiter tries again. The EXIT trap releases the lock on every way out (normal exit, a timed-out test run, SIGTERM to the hook), and only while the file still holds this hook's own token. A state dir where no lock can be made lets the gate go on without one, as before.
- Effect for a person: a wave of isolated implementers stopping together runs its suites one after the other, each at normal speed, instead of all at once at a fraction of it. A stop may wait longer for its gate when siblings stop at the same moment, but no suite slows another, and a base run no longer fails a test only because the machine was loaded.

## Item 3: no silent skip

- Floor: the time a suite run must still have after the wait, min(120 s, budget / 4, the test run's own limit), at least 1. 120 s is about what this repository's suite takes on an idle machine (the gate records of an unloaded stop come about 120 s after it), so a run started with less would most likely be cut by its limit and logged as a hanging suite, which it is not. A quarter of the budget keeps a small budget waiting for most of its time instead of skipping at once, and a suite is never promised more than its own limit. With the default budget the floor is 120 s, which leaves up to 420 s of waiting: three sibling suites of about 120 s each.
- Changed: when the time left falls to the floor while the lock is still held by another gate, an agent in an isolated worktree (mode `warn`) gets `{"decision":"warn","reason":"tests_failed_isolated","not_run":1,"lock_wait_s":N}` and exit 0 with no output. The run model (`brief.mjs` `foldRuns`, unchanged) counts every `tests_failed_isolated` record as an isolated test failure of the slice, a doubt signal, so the slice needs a passing opus review; older readers ignore the new fields. The shared tree (and an isolated worktree in `block` mode) runs the suite anyway without the lock and never skips. Every other decision, message and the two-block loop guard are unchanged; no new message is printed.
- Effect for a person: a slice whose tests could not run in time is not passed silently: it shows as an isolated test failure, and the review gate asks for an opus review of it. The integrator's full run after the merge stays the real gate.

## Limits that remain

- A gate killed with SIGKILL (Claude Code's own hook timeout, if it ever sends it) leaves its lock; the next gate takes it over only once its holder process is gone, which it is at that point. A reused pid keeps a dead holder's lock until it is 900 s old.
- The takeover guard narrows but does not close one race: a holder that releases between a waiter's two reads, followed by a third gate's new lock, could be removed. It needs three gates within microseconds and a lock judged stale; the result is two suites at once, as before this change.
- The lock is per project. Suites of different projects, or of other sessions on other projects, still run at once on one machine.
- Waiting serialises: with many siblings, later stops wait longer and the last ones may reach the floor and get `not_run` (isolated) or run without the lock (shared). The stall limit, not the gate, bounds how long a stop can wait.
- The floor is a fixed guess for this repository (120 s). A project whose suite takes longer than the time left still gets a timed-out run, logged as such.
- The bugfix check's base runs also run under the lock and share the budget, so a KIND: bugfix slice that waited long may get `bugfix_timeout` (a block, counted with the other bugfix blocks), as before when the budget ran out.

## Docs to update

- README.md:486 (`ORCH_HOOK_BUDGET_S`): "default 870 (below the 900 s hook timeout)" should say: default and maximum min(870, `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS` in seconds - 60), so 540 by default; the lock wait counts against it.
- README.md:485 (`ORCH_TEST_TIMEOUT_S`): add that with the default budget the time left (at most 540 s) cuts the 600 s limit.
- README.md:167 (Test baseline): the base run's share of "the time left in the test gate's budget" now comes after the lock wait; add that the base run runs under the project's suite lock.
- README.md:144 (Test gate row) and README.md:109 (Parallel slices): parallel slices in worktrees no longer run their gates' suites at once; one suite at a time per project, and an isolated slice whose gate could not get the lock in time logs `tests_failed_isolated` with `not_run`.
- docs/native-mode.md:80 (verify.sh row): "the whole hook ends within `ORCH_HOOK_BUDGET_S` (default 870)" should give the new default and maximum, the stall limit, the suite lock and the `not_run` record.
- docs/native-mode.md:105 (Isolated worktrees): `warn` "runs the tests" should add: unless the project's suite lock stays held until the time left reaches the floor, then `tests_failed_isolated` with `not_run:1`.
- docs/native-mode.md:206 (Test baseline): "`ORCH_HOOK_BUDGET_S`, default 870" should say 540 by default (stall limit - 60, at most 870).
- CLAUDE.md:24 ("Test gate time (1.4.0, ...)"): "`ORCH_HOOK_BUDGET_S` (the whole `verify.sh`, default 870, under the 900 s hook timeout ...)" should say default and maximum min(870, stall limit - 60), 540 by default, and name the suite lock.
- CLAUDE.md:6 ("It runs the whole suite at each implementer stop"): add "one suite at a time per project (a lock in the state dir)".
- .claude/rules/agents.md:22 (test gate bullet: "The test gate runs the project's whole suite when an implementer stops"): add that gates of one project take turns through `test-gate.lock` in the state dir, and that an isolated gate that cannot get it in time logs `tests_failed_isolated` with `not_run`.
- .claude/rules/agents.md:48 (`ORCH_BASELINE` in the switch list): the base run also runs under the suite lock and inside the shorter budget.
