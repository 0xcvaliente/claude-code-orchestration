# Fix notes: fix-hooks-small

## G-3 telemetry.mjs on a non-object payload
- Changed: `.claude/hooks/telemetry.mjs` (exit 0 when the parsed payload is not a plain object); test in `src/telemetry-v2.test.mjs`.
- Effect: `null`, numbers, strings, `true` and arrays end the hook quietly (exit 0, no output, no log record) instead of a stack trace and exit 1.
- Docs: none wrong (`.claude/rules/agents.md` already says hooks exit 0 on malformed input). `dist/plugin` needs `npm run build-plugin`.

## G-5 compact-context.mjs states after a compaction
- Changed: `.claude/hooks/compact-context.mjs` (`sliceState` reads the fold's `final` and `stalled`; header comment); test in `src/hooks.test.ts`.
- Effect: a passed slice that is not final shows `passed, opus review due`; a stalled slice shows `review failed, replan required (n attempts)` instead of `retry due`. Records without `final`/`stalled` keep the old wording.
- Docs: `docs/native-mode.md:92` lists the states as "passed, failed for good, retry due, reviewing, pending": add "opus review due" and "replan required".

## T-10 file-profile.mjs column cap
- Changed: `.claude/hooks/file-profile.mjs` (`MAX_SHEET_COLUMNS` 16,384; a cell beyond column XFD is skipped); test in `src/file-profile.test.mjs`.
- Effect: `r="ZZZZZZ1"` no longer pads a row to 321 million cells (about 2 GB); XFD itself still converts.
- Docs: none states the old behaviour.

## D-2 subagent status line attempts per run
- Changed: `.claude/hooks/subagent-statusline.mjs` (`indexLaunches` starts a new count at each PLAN REVIEW launch without REPLAN); test in `src/subagent-statusline.test.mjs`.
- Effect: the first implementer of a slice id that an earlier run of the session also used shows no `#2`; a REPLAN keeps counting within the run.
- Docs: README.md:294 ("attempt") is still right; it could say the attempt counts within the run. `dist/plugin` needs a rebuild.

## D-3 subagent status line cut by display width
- Changed: `.claude/hooks/subagent-statusline.mjs` (`fitColumns`: grapheme segments, wide CJK and emoji 2 columns, marks and controls 0); test in `src/subagent-statusline.test.mjs`.
- Effect: a row never exceeds `columns` terminal columns and never splits a surrogate pair or an emoji sequence; ASCII rows are cut as before.
- Docs: none states the old behaviour. `dist/plugin` needs a rebuild.

## W-10 skill suggestions from goal words and the bugfix rule
- Changed: `.claude/hooks/skill-hint.mjs` (a goal match needs every word of the skill's name, two at least; the bugfix rule fires on `KIND: bugfix`, or with no KIND on bug words when some FILES entry is not prose: .md, .markdown, .rst, .adoc, .txt); tests in `src/skills.test.mjs`.
- Effect, from a copy of `.claude/state/skills.jsonl` (105 launches, 172 goal_match picks) and the journal's SKILLS-USED/SKIPPED: `documents` (47 picks; 43 skipped, 0 used), `ui-verification`, `payload`, `anthropic-skills:xlsx` and `anthropic-skills:pptx` have one-word names and can no longer come from goal words (52 picks gone); `konnected-product-rules` (40; 30 skipped) needs "konnected", which no brief here says; `repo-context` (44; 26 skipped, 1 used) needs "repo" and "context"; `anthropic-skills:built-in-browser` (16; 16 skipped) needs "built" and "browser". Of the 16 `diagnosing-bugs (bugfix)` picks, the 6 on the `audit-*` slices (no KIND, `.md` findings as outputs) drop, and so would the docs and release slices whose FILES were prose only (the log does not keep FILES); KIND: bugfix slices keep it. The pinned GSAP goal match and the existing bug-word cases (code FILES, no KIND) are unchanged.
- Interpretation: "a brief whose kind is not bugfix" is read as a KIND other than bugfix, or no KIND with prose-only FILES, so the existing tests that fire the rule on bug words with code FILES and no KIND keep their expectations.
- Docs: `docs/skills.md:10`, README.md:200, `.claude/rules/agents.md` (skill suggestions) say picks come from "the goal's words": add that a goal match needs the skill's whole name (two words at least) and that bug words do not count for prose-only FILES or a non-bugfix KIND.
