# Fix notes: bench and evals (slice fix-bench-evals)

Tests: `bench/arms.test.mjs` (items 1 and 4), `bench/grade.test.mjs` (item 2), `bench/analyze.test.mjs` (item 3), `bench/run.test.mjs` (item 7). Each new test failed before its fix and passes after it; no older test was removed or weakened. No result file, matrix or dated report was changed.

## 1. B-1: haiku arms
- Changed: `bench/arms.mjs` (new `agentModels` field, rewritten by `prepareClaudeDir` like `agentModel`; `all-haiku` and `reader-haiku` get `agentModels: {researcher: "haiku"}` and `ORCH_ALLOW_HAIKU=1` in their own env, which `runEnv` applies after it drops inherited `ORCH_*`; header and labels), `bench/analyze.mjs` (comments on `PAIRS` and `READER_PAIRS` saying what each arm runs).
- Effect: a rerun of `all-haiku` or `reader-haiku` runs a haiku researcher again; the other agents keep their shipped model. No label says "shipped" for haiku any more. Arm ids are unchanged, so old results load.
- Not changed, for the person to decide: `routed` and `reader-routed` keep the shipped researcher (sonnet since 1.3.0; it was haiku in 0.4.0). Their labels now say so. The pairs `all-haiku -> routed` and `reader-haiku -> reader-routed` therefore compare a haiku researcher with a sonnet researcher plus the router's notes, not the 0.4.0 comparison (haiku with and without the router). Giving these two arms the haiku researcher too would restore it.

## 2. B-2: grader entry guard
- Changed: `bench/tasks/{k1-stdlib-toolkit,k2-stdlib-toolkit-xl,h3-sql-engine}/score.mjs` (the real-path guard of `bench/analyze.mjs`).
- Effect: `node <symlinked path>/score.mjs <dir>` now prints the grade instead of nothing with exit 0.

## 3. B-4: template STATUS line
- Changed: `bench/lib/claims.mjs` (`STATUS_LINE` gets the template lookahead of `STATUS_RE` in `.claude/hooks/brief.mjs`).
- Effect: `STATUS: pass or fail` (also `/` or `|`) is no claim. The audit's example "Reply in this format: STATUS: pass or fail / The parser module is not finished yet." is now `failure` (was `partial`); "STATUS: pass / STATUS: pass or fail" stays `success`. Only the partial/failure split of a re-analysis can move; false-success counts cannot.

## 4. Plain arms: output style
- Changed: `bench/arms.mjs`: `ORCH_OUTPUT_STYLE=default` in the env of P-S, P-O, W-mix, N-UC (its launcher takes orchestrate.sh's arguments through a dry run), the three reader arms (via `READER_ENV`) and AUTO (its plain and reviewed routes start a plain session through orchestrate.sh). The launchers are unchanged.
- Effect: these arms' plain sessions get `--settings {"agent":""}` with no `outputStyle`, as in the published runs, instead of the Concise style.

## 5. E-1: coloured node:test summary
- Changed: `results-nonempty.md` and `results-pass.md` in c1-unit-registry, e1-shared-file, e3-constraint-answered, e4-plan-before-build, t1-parallel and t2-single (9 files): patterns are now `^(?:\x1b\[[0-9;]*m)?(?:#|ℹ) pass [1-9]` and `^(?:\x1b\[[0-9;]*m)?(?:#|ℹ) fail 0\b`.
- Proof (`check-graders.mjs`, in the slice's scratch folder; it reads the `pattern:` line of each file and compiles it with flag `m`):
  ```js
  const [nonempty, pass] = process.argv.slice(2).map((f) => new RegExp(/^pattern: '(.*)'$/m.exec(readFileSync(f, "utf8"))[1], "m"));
  const E = "\x1b";
  // plain "ℹ pass 2\nℹ fail 0", coloured `${E}[34mℹ pass 2${E}[39m ...`, tap "# pass 2\n# fail 0",
  // failing "ℹ pass 0\nℹ fail 2", failingColoured `${E}[34mℹ pass 0${E}[39m\n${E}[34mℹ fail 2${E}[39m`
  ```
  On the new t2-single files: plain, coloured and tap give `nonempty: true pass: true`; failing and failingColoured give `nonempty: false pass: false`. On the old files (from HEAD) coloured gave `false false`.
- Effect: a passing run with colour on now passes both graders. Whether colour caused the observed t2-single failures is still unproven (audit E-1).

## 6. E-2: orch-agent-used on t2-single
- Changed: `evals/t2-single/graders/orch-agent-used.md` removed. The same grader in c1, d1, e1 and t1 stays.
- Effect: a correct light route on t2-single is no longer marked down in a one-arm (`--ablation none`) eval.

## 7. O-11: executeRun test
- Changed: `bench/run.test.mjs`: the `rate_limited` and `deadline` cases run under `Promise.all`, each with its own run id (so its own output folder and repo) and its own `commandFor`; same assertions.
- Effect: none for users; the test takes about 5.2 s instead of about 8.2 s.

## Docs to update
- `bench/README.md` arm table (around lines 22 and 25): `all-haiku` and `reader-haiku` rewrite the researcher to haiku and set `ORCH_ALLOW_HAIKU=1`; "shipped" applied in 0.4.0 only; `routed` and `reader-routed` now run the shipped sonnet researcher. Plain arms set `ORCH_OUTPUT_STYLE=default`.
- `bench/HYPOTHESES.md` H14 and H14-d3 notes (around line 130): the published runs had haiku as the shipped researcher; a rerun runs haiku only in the haiku arms, and the routed arms compare against sonnet.
- `README.md` (around line 322): "`reader-haiku` (shipped)" should say shipped in 0.4.0.
- `CHANGELOG.md`: the grader guard entry (line 58, "keep the old entry guard") and the `.claude/rules/agents.md` 1.4.4 entry-guard note ("The benchmark graders ... still use the old form") are no longer true.
- `dist/plugin/evals` must be rebuilt (`npm run build-plugin`) to carry the eval grader changes; `docs/research-2026-11-10.md` "Open" is a dated record and stays as it is.
