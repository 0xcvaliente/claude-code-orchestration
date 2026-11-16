# Fix notes: slice fix-run-pane (carried slice with a failing review, D-4, D-6, D-1)

## 1. A carried-final slice with a failing review
- Changed: `.claude/hooks/brief.mjs` (`foldRuns`, reviewer stop: a counted failing review of a slice with `carriedFinal` clears it; `SliceState` doc), `dashboard/register.tsx` (`doneIn`: a reviewer of the slice that ended in the run with status `fail` ends `done`), `docs/brief-grammar.md` ("Carried slices"); tests in `src/review-gate-v2.test.mjs` (fold test, hooks test) and `dashboard/register.test.tsx`.
- Visible: such a slice is no longer final or passed; the new run stays open, so the plan check blocks an implementer the plan does not name (`not_in_plan`) instead of treating the run as closed (`no_plan_review`). A pass, a fail that counts as a pass and a reply with no STATUS leave it final. The pane keeps the run open and the slice's card.
- Review gate (not changed): it gates only slices with an implementer attempt in the latest run, plus the last implementer's slice in the run where it has one. The slice has no attempt in the new run, and run 1 still shows its passing review, so the Stop gate allows with `reviewer_passed`. The hooks test pins that.

## 2. D-4: a closed run reopened on the pane
- Changed: `dashboard/register.tsx` (`RunMarks.closed`; `allFinal` split out of `runOpen`; `turn.complete` sets `closed` when an agent with a slice ends and every slice is final; `runOpen` returns false for a closed run), `docs/dashboard.md` ("Run boundary").
- Visible: after a final pass, a late failing review no longer keeps the pane's run open. The next typed prompt, or an idle spawn, starts a clean run, and a light launch opens a new light run, as the gates do.

## 3. D-6: the 80-record cap
- Changed: `dashboard/register.tsx` (`kept`: the latest 80 records plus older slice agents, REPLAN plan reviews and running agents, at most 500 in all; `drawnOf`: render draws the latest 80; `marksOf` reads every kept record), `docs/dashboard.md` ("Run boundary", "Limits").
- Visible: a retry signal and earlier attempts survive a large run, so `⇧opus?` stays and the run stays open while the gate holds it. The cards and counts still show the latest 80. Remaining cap: 500 records.

## 4. D-1: type warnings
- Changed: `dashboard/register.tsx` (the layout type `Run` is now `Seg`, so `RunMarks`, `inRunOf`, `doneIn` and `runOpen` are type-checked against the imported `Run`; `(e.tool as string) === 'Task'`; `outcome: Work['outcome']`; `kind: one.status as LogEntry['kind']`), `dashboard/register.test.tsx` (`as never` on 5 `clock.every` values and 13 `prompt.submit` inputs).
- Visible: `claude plugin validate` reports no TypeScript warnings for either file (before: 19 and 18). Left as they are: the four "gating hook without .catch" lines (prompt.submit, agent.spawn, both tool.call hooks; each wraps its work in try/catch), and the plugin directory checks (README, LICENSE, icon), which the validator says do not change the result.

## 5. Docs
- `docs/dashboard.md`: "Run boundary" (closed for good, carried slices, what the run model reads) and "Limits" (the test gate's give-up and isolated failures the pane cannot see, the second stop of a hand-back, the 500-record cap).

## Docs to update
- `.claude/rules/agents.md`, "Run scope": it says a run "closes when every slice is final" and that the dashboard mirrors the rule in `sliceRunOf`. Add that a closed run never reopens, on the pane too, and the carry rule with this slice's failing-review exception (G-1 notes already ask for the carry rule).
- `README.md:420` (Known limitations, the stale-after-10-minutes line): add the 500-record cap and the two blind spots (test-gate give-up and isolated failure, the second stop of a hand-back) if that list should match `docs/dashboard.md` "Limits".
- `docs/native-mode.md`: no line states the old behaviour (checked with grep for carried slices and the pane's run model).
- `CLAUDE.md`: no line states the old behaviour.
