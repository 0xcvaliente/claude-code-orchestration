# Fix notes: slice fix-researcher-cd (items 1 to 3)

## Item 1: /dev itself is under the device rule
- Changed: `.claude/hooks/researcher-guard.mjs` (`readsDevice`, new `isDevice`): a candidate path that is `/dev` itself
  (text-normalised or system-resolved, case-folded) is refused like one under it; `/dev/null` passes as before. One
  exception keeps two earlier pins: a bare one-segment word whose text names `/dev` only because the command runs in
  `/` (`grep -rn dev x`). Tests: "(cd item 1)" in `src/guards.test.mjs`, seen failing first.
- Visible effect: `grep -r x /dev`, `/dev/`, `/dev/.`, `/dev/zero/..`, `cat /dev/`, a symlink to `/dev` and
  `<link to />/../dev` are refused ("reads a device that may never end").
- Docs: README.md:170 and docs/native-mode.md:192 ("a `/dev/` device other than `/dev/null`") should say "/dev or a
  device under it".

## Item 2: cd into the project folder or below it
- Changed: `researcher-guard.mjs` (`CD_FORM`, `cdReach`, folder tracking in `violation`, `researcherViolation(command,
  cwd, project)`; the hook passes `CLAUDE_PROJECT_DIR`, without it every cd is refused); `src/config.ts` gains
  `Bash(cd *)`, written to `.claude/agents/researcher.md` by `npm run sync-agents`; its body says cd goes only into
  the project folder or below. A cd passes only as `cd <one literal path>` whose real path, from every folder the
  shell may be in (logical and physical reading), is inside the project and exists from one of them. Later segments
  are judged from every such folder. Tests: "(cd item 2)" (allowed, refused, chains, devices after cd, hook).
- Visible effect: `cd sub`, `cd ./sub/`, `cd ..` from a subfolder, `cd /abs/project/sub` pass; `cd /`, `cd /dev`,
  `cd ~`, home, `cd ..` from the root, a symlink leading out, a missing path, two words, an option, `-`, `+1`, a
  variable, a glob, a control character are refused with the allowed form named. Not judged: CDPATH or zsh
  `cdable_vars` in the shell's own environment.
- Docs: fix-notes-guards.md T-11 ("`cd` stays refused") is superseded; README.md:147 and :170, docs/native-mode.md:192,
  `.claude/rules/agents.md` (researcher-guard line) and CLAUDE.md 1.2.0 should list `cd` into the project; dist/ needs
  a rebuild.

## Item 3: the guard always decides
- Changed: `researcherViolation` catches any error and refuses; a word longer than 4096 characters in a reading
  command is refused (judging its suffixes took ~12 s at 100k characters, minutes at 300k: past the hook timeout,
  which lets the command through); the entry check compares real paths (CLAUDE.md 1.4.4) instead of the name; an
  uncaught error in the hook block exits 2.
- Found: a script whose name ended in `researcher-guard.mjs` ran the hook block when it imported the guard and exited
  mid-import (exit 0 or 2). Exit 133 (SIGTRAP) was not reproduced: two copies in one process (file copy and `?copy=`),
  as processes, with odd payloads (cwd `/dev/fd/0`, NUL, 5000-char paths, project `/dev/zero`), 60-link chains, link
  loops, NUL, control characters, lone surrogates, 20 MB stdin: always 0 or 2. Those probes are kept as tests.
- Docs: none outside the hook header; README "Guards" may say an unjudgeable command is refused.
