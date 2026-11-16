# Fix notes: fix-sdk-workflow (S-1, W-2, O-8)

## S-1: a failing commit hook ends an SDK slice at once, with `attempts: 0`

- Changed: `src/git.ts` (`commitAll` throws the new `CommitError`, carrying what git and the hook printed, when `git commit` itself fails; `git add` and other git errors are thrown as before; hooks still run, no `--no-verify`), `src/slice.ts` (`runSlice`: a `CommitError` inside the attempt loop becomes the next attempt's feedback, the last 3000 characters of the hook output, then `continue`; any other error in the loop is rethrown as the new `SliceError`, which keeps the attempts made), `src/orchestrator.ts` (`doSlice` reports `err.attempts` for a `SliceError`, 0 otherwise).
- Visible effect: in a repository with a pre-commit hook (husky, lefthook, pre-commit), a hook that fails is shown to the writer as feedback and retried within `--retries`; when the retries are used up the slice fails with the hook's message as its issue and the real attempt count. A crash outside the commit (a git or worker error) still fails the slice, now with the attempts it had, not 0.
- Tests: `src/slice.test.ts` (four: hook always fails; fails once then passes; long output cut to its end; another error carries `attempts`), `src/orchestrator.test.ts` (two: a crash keeps its attempts; the audit's case A end to end, `maxRetries: 2` gives 3 attempts and the hook message).

## W-2: an isolated slice whose merged review fails gets no refute pass and no retry

- Changed: `.claude/workflows/orchestrate.js`. `refute()` takes a `merged` flag (the refuter looks at the merge in the current branch, not `git diff HEAD`); `runSlice(s, from, prior)` can start at a later attempt with the standing gaps (and tells an isolated retry that its earlier attempt is in the HEAD its worktree starts from); the pipeline stage calls `runSlice(s)` only with the slice; the integrator call moved into a local `integrate(list, label)` used for the wave (`integrate`) and for each retry (`integrate:<id>#<n>`), with the same prompt and the same "not merged by the integrator" failure. After the merged reviews, each failed slice, one at a time, gets the refute pass (`refute:<id>#<n>`); while gaps stand and attempts remain it is rebuilt in a new worktree from the current HEAD, merged and reviewed again (`review:<id>#<n>`, escalated as a retry), the last attempt on opus. Only when the attempts are used up does it fail for good, which starts the replan. Header comment updated.
- Visible effect: in a wave of two or more isolated slices, a merged review's gap that the refute pass drops no longer fails the slice, and a real gap gets the same retries as in the shared tree before the replan starts. Retries of isolated slices run one slice at a time, since each merge changes the shared tree.
- Tests: `src/workflow.test.mjs` (four: refute drops the gap; the gap stands and the retry passes; the attempts run out, last on opus, then the replan; a retry whose merge the integrator leaves out fails unreviewed).

## O-8: the workflow logs the whole plan JSON

- Changed: `.claude/workflows/orchestrate.js`. The log line is `plan: <n> slice(s), constraints <ids or none>`, after a replan `plan after replan: <n> slice(s), constraints <ids or none>`. The result gains `plan` (the whole plan, `{ constraints, slices }`, the replanned one after a replan) and `summary` (one line per slice, `<id>: <status> (<n> attempt(s))`, joined by newlines). Gap texts stay in `slices[].gaps`.
- Visible effect: the progress log and the session's relay stay short; resume in a new session now takes `args.plan` from the result's `plan`, not from the log.
- Tests: `src/workflow.test.mjs` (two new; the existing resume test and the `planLogged` helper now read the plan from the result, every assertion kept, and also assert the short line).

## Docs to update

- README.md:271 ("pass the logged `plan: <JSON>`"): the plan is in the result's `plan`; also say retries with refuted gaps hold for isolated slices after their merged review.
- docs/native-mode.md:280 ("The script logs its plan once as `plan: <JSON>` ... pass that JSON back"): read `plan` from the result; the log has one short line.
- docs/native-mode.md, "Build and review" and "Integrate" bullets (about :273 and :275): an isolated slice's failed merged review gets the refute pass and retries, one slice at a time.
- docs/native-vs-plugin.md:23 ("it resumes in a new session from its logged plan"): from the plan in its result.
- CHANGELOG.md: an entry for the three fixes.
- `dist/plugin/workflows/orchestrate.js` is stale until `npm run build-plugin` (a later run).
