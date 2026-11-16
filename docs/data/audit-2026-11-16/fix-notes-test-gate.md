# Fix notes: test gate (slice fix-test-gate)

Findings from `test-gate-guards.md`. Regression tests: `src/test-gate-audit.test.mjs` (one test or more per item,
each seen failing before its fix; the real-cargo bugfix verification test of T-13 is a guard that passes before and after the third attempt's fix). dist/ is not rebuilt here: `npm run build-plugin` must follow the merge.

## T-1: a session worktree is the shared tree
- Changed: `.claude/hooks/verify.sh` (isolated test: inside the project folder only `<project>/.claude/worktrees/<x>` is isolated, physical paths); `bugfix-check.mjs` gets the corrected `--isolated`.
- Effect: a session started with `claude --worktree` gets `tests_failed` blocks (exit 2) for its own implementers, and its baseline and bugfix base is its HEAD, not the main worktree's fork point.
- Docs: docs/native-mode.md:80 "Agents in `.claude/worktrees/` follow `ORCH_GATE_ISOLATED`" and :105 (Isolated worktrees) should say "other than the session's own project folder".

## T-2: committed code plus uncommitted prose
- Changed: `verify.sh` `only_prose_changed`: in an isolated worktree the paths committed since the fork point (main worktree's HEAD, as `baseInfo`) must be prose too; no base found keeps the tests.
- Effect: such a slice runs its tests (`tests_failed_isolated`, or a block in `block` mode) instead of `no_code_changes`.
- Docs: docs/native-mode.md:101 ("The decision comes from `git status`") and .claude/rules/agents.md test-gate bullet ("It judges `git status`") should add "plus, in an isolated worktree, the slice's commits since its fork point".

## T-3: a load failure on the base is no reproduction
- Changed: `bugfix-check.mjs` (`fileLevel`, used in `bugfix`; block message adds "or only as a whole file that does not load").
- Effect: a KIND: bugfix test that only fails to import on the base blocks with `bugfix_test_passes_on_base`.
- Docs: README.md:168 and docs/native-mode.md (Bugfix check) should say a whole-file failure (import or syntax error) does not count.

## T-4: unittest output
- Changed: `bugfix-check.mjs` `parseFailures` (`FAIL:`/`ERROR: name (module.Class.name)`, qualified as `module/path.py::Class.name`; `unittest.loader._FailedTest` is a crash) and `inFiles` (a qualifier ending in `.py` or `.rs` also matches when it is the tail of the changed test file's path: a unittest module relative to discover's start folder, or a cargo workspace member's `<package>/tests/x.rs`).
- Effect: a unittest reproduction test is `bugfix_verified` at the first stop; the baseline note works for unittest.
- Early end (third attempt): unittest prints its `FAIL:`/`ERROR:` blocks only after the whole run (`printErrors`), so a run cut short by a crash, `os._exit` or a kill prints no name and keeps the block (checked with Python 3.15: a test that calls `os._exit(1)` after a failing test leaves no `FAIL:` line). The one early end that still prints names is failfast, whose output has no mark of the stop. `bugfix-check.mjs` `failFastCmd`: under the allow baseline, a command that names `unittest` and passes `-f`, `--failfast` or `-f` among combined short flags (`-qf`) gets no allow (the gate keeps `tests_failed`). The detected command (`python3 -m unittest discover -q`) has no failfast. Limit: `unittest.main(failfast=True)` inside a script the command runs cannot be seen.
- Docs: docs/native-mode.md:212 runner list should name unittest (and say cargo `--quiet`); docs/native-mode.md:209 (`allow`) should add "never for a unittest command with failfast".

## T-13: cargo test --quiet
- Changed: `bugfix-check.mjs` `parseFailures`: `name --- FAILED` qualified by the following `error: test failed, to rerun pass` hint (`--lib` as src/lib.rs, `--test x` as tests/x.rs); that hint is no crash when it qualifies names. The detected command is unchanged.
- Effect: cargo bugfix slices verify (audit r13 now logs `bugfix_verified`; a real-cargo test verifies a reproduction test in a single crate and in a workspace member); the baseline note of the default inform mode lists the names cargo printed.
- Allow baseline (third attempt, the confirmed gap): cargo without `--no-fail-fast` stops after the first test target that fails, so the targets after it never ran. Before this slice quiet output always counted as a crash, so the allow baseline kept the block; with the parser above alone, a test already failing on the base in `--lib` hid a broken `tests/api.rs` that never ran, and the gate allowed with `tests_failed_baseline`. Fix: `bugfix-check.mjs` `stoppedEarly` (used only in `baseline`, allow mode): a run whose last cargo line is a rerun hint (`error: test failed, to rerun pass ...`), with no `error: N target(s) failed:` summary after it, stopped at a failing target, and the allow baseline returns no opinion (the gate blocks with `tests_failed`). A `--no-fail-fast` run ends with that summary, ran every target, and keeps the allow baseline. `parseFailures`, `complete`, the bugfix check and the inform note are unchanged by this. Tests: captured cargo 1.100 output (fail-fast stop blocks in allow mode, its name is listed in inform mode, the `--no-fail-fast` form still allows) and a real `cargo test --quiet --offline` crate (the validator's scenario; skipped without cargo).
- Docs: bugfix-check.mjs header updated; docs/native-mode.md:212 as above, and :209 (`allow`) should add "never when cargo stopped at a failing target". Workspaces: the hint's `-p <package>` becomes a leading folder (`<package>/tests/x.rs`, `<package>/src/lib.rs`), matched as the tail of the member's path (`crates/<package>/tests/x.rs`), never another member's file. Limit: a member whose folder name differs from its package name does not match, so its bugfix slice still blocks.

## T-9: caps per attempt (gate side)
- Changed: `bugfix-check.mjs` (`countBlocks`), `verify.sh` (`count_blocks`, used for the tests_failed cap and the bugfix_timeout/tmp_lost cap): blocks count only since the agent's latest SubagentStart in telemetry.jsonl; none recorded counts as before; grep fallback when node fails.
- Effect: an attempt resumed with SendMessage gets its own two blocks; reasons `max_blocks_reached` and `bugfix_unverified_gave_up` keep their names.
- Docs: docs/native-mode.md:80 "At most 2 blocks per agent", README gate table and .claude/rules/agents.md ("one two-block cap per agent") should say "per agent since its latest start (a resume starts a new count)".

## T-8: isolated failure under the allow baseline
- Changed: `verify.sh`: in an isolated worktree (not `block` mode) an allow-baseline warn logs `tests_failed_isolated` with `failing` and `base_failing`.
- Effect: the run model sees the isolated failure as a doubt signal again (opus review required under escalation).
- Docs: docs/native-mode.md:209 (`allow`) should note that an isolated worktree keeps `tests_failed_isolated`.

## T-12 (first half): budget cap
- Changed: `verify.sh`: `ORCH_HOOK_BUDGET_S` above 870 is cut to 870. The base run for an isolated failure is kept (second half not done).
- Effect: a large budget can no longer outlive the 900 s hook timeout; base runs get at most 860 s.
- Docs: README.md:486 (`ORCH_HOOK_BUDGET_S`) and docs/native-mode.md:80 should say "default and maximum 870".
