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
- Changed: `.claude/hooks/subagent-statusline.mjs`. `fitColumns` cuts a row by display width over grapheme segments (`Intl.Segmenter`), whole graphemes only, ending in "…"; `displayWidth` (exported for the tests) sums the width of each grapheme. A grapheme is 0 columns when it is only marks, controls or format characters (joiners, variation selectors), 1 when it holds U+FE0E (text presentation), 2 when it has emoji presentation (`\p{Emoji_Presentation}`, or `\p{Emoji}` followed by U+FE0F, which covers keycaps), else 2 when its first code point's East_Asian_Width is W or F, else 1.
- East_Asian_Width: no hand-kept table. The `WIDE` ranges (start, end pairs, all planes) are generated from Unicode 17.0.0 by Python's `unicodedata`; the comment above them names the version and gives the one-line python3 command that regenerates them (it reproduces the embedded table exactly). The two earlier versions missed blocks: a range table missed wide emoji (🚀, ✅, ⌛), and the script list after it missed Hangul Compatibility Jamo (U+3131-318E), among others.
- Tests in `src/subagent-statusline.test.mjs`, seen failing before the change: a row of Hangul Compatibility Jamo cut at 30 columns is at most 30 columns wide (was 38); and for every code point of the Basic and Supplementary Multilingual Planes (U+0000-1FFFF) `displayWidth` matches python3's `unicodedata` (0 for marks, Cc and Cf; 2 for W or F; else 1), leaving out code points unassigned in either version and code points with emoji presentation that Python counts as 1 (the emoji rule, such as the regional indicators); 8,396 code points differed before the change, none after. The test is skipped when python3 is not installed. The earlier emoji and CJK tests pass unchanged.
- Effect: a row never exceeds `columns` terminal columns by this measure and never splits a surrogate pair or an emoji sequence; ASCII rows are cut as before. Halfwidth forms (U+FF61-FFDC) are one column because the data says so, not by a special case.
- Limit: widths follow Unicode's East_Asian_Width and emoji properties; a terminal that draws ambiguous-width characters (East_Asian_Width A) as two columns will see those rows wider than counted.
- Docs: none states the old behaviour. `dist/plugin` needs a rebuild.

## W-10 skill suggestions from goal words and the bugfix rule
- Goal words: unchanged from the base commit bc1dce8. `git diff bc1dce8 -- .claude/hooks/skill-hint.mjs` shows only the bugfix rule. The two tuning rules of the earlier attempts (every name word; then two name words or one name word shared by at most two skills) are taken out with their tests: both lost skills a goal clearly named (a Payload CMS goal got nothing because nine installed skills share "payload"; a Figma goal lost the figma skill because four share "figma"), and losing a needed skill is worse than naming an extra one.
- Known limit, for the docs: a suggestion from goal words can still name a skill that does not fit the slice (one shared word in the skill's name plus two description words is enough, as the audit found with `documents`, `repo-context` or `konnected-product-rules`). The worker loads what fits and skips the rest, saying so in one line of its report; nothing blocks on a suggestion.
- New test in `src/skills.test.mjs` ("goal picks: a goal that clearly names a skill gets it, however many installed skills share the word"), with a fixture catalog where several skills share payload, figma, supabase and konnected: Payload CMS (→ `payload`, or `konnected-payload-backend` when the goal says more of its words), Figma (→ `figma`), a Supabase migration with RLS policies (→ `supabase-postgres-best-practices`) and a threat model (→ `security-threat-model`) each get their skill, for implementer and researcher. It passes on the base matching and fails on the second attempt's matching.
- Bugfix rule (kept from the earlier attempts): `.claude/hooks/skill-hint.mjs` `preferenceRules` fires `bugfix` on `KIND: bugfix` (even when FILES are prose), or with no KIND line on bug words when some FILES entry is not prose (prose: .md, .markdown, .rst, .adoc, .txt; no FILES at all counts as not prose-only). A KIND other than bugfix, or no KIND with all-prose FILES, gets no bugfix suggestion. Test: "preference table: the bugfix rule needs KIND: bugfix, or no KIND and a FILES entry that is not prose". The existing tests that expect the rule on bug words with code FILES and no KIND pass unchanged.
- Docs: `docs/skills.md:10`, README.md:200 and `.claude/rules/agents.md` (skill suggestions) say picks come from "the goal's words": add that bug words do not count for prose-only FILES or a KIND other than bugfix, and the known limit above. `dist/plugin` needs a rebuild.
