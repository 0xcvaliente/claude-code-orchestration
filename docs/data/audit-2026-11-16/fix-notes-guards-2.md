# Fix notes: slice fix-guards-2 (three holes left by the fix-judge-hook, fix-researcher-cd and fix-skill-gate reviews)

## Item 1: the judge hook sees the store name as the tokenizer decodes it

- What changed: `.claude/hooks/judge-hook.mjs` (`namesPromptStore`). Besides the raw text with quotes and backslashes
  dropped, the check now runs `tokenize` (judge-core.mjs, unchanged) and looks, case ignored, for `judge-prompts` in
  each run of literal text of every word (redirection targets and assignments included) of every command of the line,
  and of every `$(...)`, backtick and process substitution it records (nested up to 8 levels). Quoting is removed and
  `$'...'` escapes are decoded there. Test: `src/judge-hook.test.mjs` "J-12: a store name spelled with $'...', ...".
- Visible effect (judge on): `cat ~/.claude/orchestration/judge-$'prompts'/...`, `judge-$"prompts"`,
  `$'judge\x2dprompts'`, `$'\x6a'udge-prompts`, octal escapes, the name in a later command, a redirection, a
  substitution or an assignment are refused with the same message and no model call. Unchanged: `judge-$'notes'
  prompts.txt` and `judge-$P` pass as before.
- Limits: a run of literal text ends at an expansion or glob, so a glob (`judge-*`), a name built at run time from
  variables or command output, and a `cd` into the parent then a relative glob stay out of reach; a line the tokenizer
  cannot read gets only the raw-text look (the judge's floor denies it anyway). Write and Edit never reach the hook.
- Docs to update: `docs/bash-judge.md` "Native hook" (the refusal also covers `$'...'`/`$"..."` spellings) and its
  Limits (globs and run-time names only); CHANGELOG.md. `dist/plugin` needs `npm run build-plugin`.

## Item 2: the researcher guard refuses a path through /dev whose last part is missing

- What changed: `.claude/hooks/researcher-guard.mjs` (`resolve`): once the walk has passed through /dev's file system,
  a missing name, a non-folder with names after it, or a folder wanted where there is none returns "device", not
  "missing". Test: `src/guards.test.mjs` "researcher guard (guards-2 item 2): ...".
- Visible effect: `cd ./sub && grep -rn x ../ld/fd/63` (ld a link to /dev, 63 a descriptor the hook lacks), `cat
  ./ld/no-such-device` and `cat ./ld/null/x` are refused as a device. `/dev/null` through the link and a missing path
  that never touches /dev (`cat ./missing/x`, `cat ./file.txt/x`) still pass. A path such as `/dev/../tmp/missing`
  now counts as a device too (its walk passed through /dev).
- Limits: as before, a glob expanding to a device, a FIFO the shell reaches other than by its operands, Linux
  `/proc/self/fd`.
- Docs to update: README.md and docs/native-mode.md where they describe the researcher's device rule ("a path whose
  walk passes through /dev, existing or not, except /dev/null"); CHANGELOG.md; `dist/plugin` rebuild.

## Item 3: the skill publish push never follows tags

- What changed: `scripts/skill-publish.mjs` step 5 runs and shows `git push --recurse-submodules=no --no-follow-tags
  -u origin skill/<name>:skill/<name>`; header comment updated. `docs/skills.md` "Publishing" and "Limits" say no tag is
  pushed and tags are not scanned. Test: `src/skill-publish.test.mjs` "guards-2 item 3: ..." (push.followTags set, an
  annotated tag on the draft; dry run only; the shown options tried against scratch bare remotes, with a control that
  sends the tag without the option).
- Visible effect: with `push.followTags` in the person's git config, the publish no longer sends annotated tags that
  point into the branch; the dry run shows `--no-follow-tags`.
- Limits: tags are still not scanned (none is pushed); commit messages and identities stay unscanned as before.
- Docs to update: done in `docs/skills.md`; CHANGELOG.md; `.claude/rules/agents.md` "Skill creation" may mention it.
