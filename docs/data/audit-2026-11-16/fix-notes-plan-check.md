# Fix notes: plan check (G-7, G-12, G-15, G-6)

Slice fix-plan-check. Each fix has a regression test written first and seen failing. dist/ not rebuilt: `npm run build-plugin` is still due.

## G-7 (high): a retry of a slice that a later slice DEPENDS on

- Changed: `.claude/hooks/plan-check.mjs` (the run's DEPENDS graph over all allowed launches in scope; file_overlap skips a slice ordered before this launch, through its DEPENDS line or a retry's earlier launches, followed through other slices, or after it, an earlier launch whose DEPENDS lead to it; for a retry, a DEPENDS entry naming a slice already ordered after it is dropped before the cycle walk; header comment). Tests: two cases in `src/plan-check-overlap.test.mjs`.
- Visible effect: a fresh retry of `a` after `b` (`DEPENDS: a`) launched is allowed (`ok`), with `DEPENDS: none` or `DEPENDS: b`. Also new: a first launch is not an overlap with a slice it reaches only transitively (`b DEPENDS: m`, `m DEPENDS: a`). A real overlap (no order either way) and a cycle formed by a first launch still block every time.
- Docs to update: `README.md:415` and `docs/native-mode.md:320` (the limitation stays true for a broken plan, but add that a retry of a planned slice is judged against the run's graph); `docs/native-mode.md:82` and `.claude/rules/agents.md` ("overlap another slice's files outside DEPENDS": now outside the run's DEPENDS order, transitive).

## G-12 (medium): PATH: light before a multi-slice plan review

- Changed: `.claude/hooks/plan-check.mjs` (`light` also needs the open run not to be a planned run with more than one planned slice; the `light_path_multi` message names the planned slices when none launched yet; header comment). Test: `src/plan-hooks.test.mjs`.
- Visible effect: while a PLAN REVIEW of a, b, c is running, `SLICE: a ... PATH: light` is blocked with `light_path_multi` ("this run plans a, b, c"), twice, then `no_plan_review_gave_up` as before. A one-slice plan keeps `light_path`.
- Docs to update: `docs/brief-grammar.md` (no_plan_review / light path), `docs/native-mode.md:82` ("`light_path_multi` once another slice ran": also while the open plan names several slices), `README.md:143` if it says the same.

## G-15 (low): older and provider-prefixed haiku ids

- Changed: `.claude/hooks/plan-check.mjs` (new `haikuFamily`: the word haiku anywhere in the id between non-letters; `raiseHaiku` uses it beside `modelRank`, which stays strict for the read router). Test: `src/model-floor.test.mjs`.
- Visible effect: `claude-3-5-haiku-20241022`, `claude-3-haiku-20240307`, `us.anthropic.claude-haiku-4-5-20251001-v1:0` (call or agent file) are raised to sonnet and logged to `model-floor.jsonl`.
- Docs to update: none wrong (`README.md:197`, `docs/native-mode.md:176` already say "haiku family").

## G-6 (low): block messages naming a switch

- Changed: `.claude/hooks/plan-check.mjs` (dropped "ORCH_ALLOW_BUILTINS=1 allows built-ins." and "ORCH_STALL_GATE=off turns this check off."). Tests: `src/plan-hooks.test.mjs` (source scan of every "Plan check:" message for ORCH_; the builtin test no longer expects the switch in stderr).
- Visible effect: the two block messages end one sentence earlier.
- Docs to update: `.claude/rules/agents.md` model-facing rule ("agent bodies, the skills, the nudge's context string") could name hook block messages too; `src/contracts.test.ts` could scan other hooks' messages (not owned here).
