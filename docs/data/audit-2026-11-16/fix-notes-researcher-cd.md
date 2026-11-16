# Fix notes: slice fix-researcher-cd (items 1 to 3, round 2 items A to C)

## Item 1 (and C): /dev itself is under the device rule
- Changed: `.claude/hooks/researcher-guard.mjs` (`readsDevice`, `isDevice`): a path that is `/dev` itself (text-normalised
  or reached by the system, case-folded) is refused like one under it; `/dev/null` passes as before, also through a
  link. Round 2: a bare word is judged as a path too, and grep and rg also judge `.` (they search it with no path).
- Visible effect: `grep -r x /dev`, `/dev/`, `/dev/.`, `/dev/zero/..`, `cat /dev/`, a link to `/dev` are refused; from
  `/`, `grep -rn dev x` and `grep -rdev x` (allowed before, pins flipped); in /dev or below, every grep and rg.
- Docs: README.md:170 and docs/native-mode.md:192 should say "/dev or a device under it".

## Item 2 (and B): cd into the project folder or below it
- Changed: `cdReach`, folder tracking in `violation`, `researcherViolation(command, cwd, project)` (the hook passes
  `CLAUDE_PROJECT_DIR`; without it every cd is refused); `src/config.ts` gains `Bash(cd *)` (sync-agents). A cd passes
  only as `cd <one literal path>` starting with `./`, `../` or `/` (bash and zsh skip CDPATH and cdable_vars then),
  whose physical path from every folder the shell may be in is the project folder or inside it (by device and inode).
  Later segments are judged from every such folder.
- Visible effect: `cd ./src`, `cd ../docs`, `cd /abs/project/src` pass; `cd src` (write `cd ./src`), `cd /`, `cd ~`,
  `cd ..` from the root, a link leading out, a missing path, two words, an option, `-`, `+1`, a variable, a glob, a
  control character are refused, naming the form. Limit: a shell function or alias named `cd`.
- Docs: supersedes fix-notes-guards.md T-11 ("cd stays refused"); README.md:147/:170, docs/native-mode.md:192,
  `.claude/rules/agents.md` (researcher-guard line), CLAUDE.md 1.2.0: list `cd ./<path>` into the project; rebuild dist/.

## Item 3 (and A): the guard always decides; the cause of exit 133
- Cause: `realpathSync.native` on a long path (about 150 characters or more) reaching /dev itself through a symlink
  ends the process with SIGTRAP (133) or SIGSEGV, or reports a false ENOENT, after a few dozen calls (Node 24.22.2,
  Darwin 27.2). Measured, 300 calls, 10 to 20 processes: link to /dev 11-13 of 20 crashed, rest mostly false ENOENT;
  short path, `/dev`, `<link>/zero`, `<link>/null`: none. lstat, stat and Node's JS `realpathSync`: no fault.
- Changed: the guard never makes that call. `resolve` walks a path with lstat and readlink (a link before the `..` after
  it); `judged` adds stat and refuses a device, FIFO or socket other than /dev/null (by identity), anything on /dev's
  file system, a walk through /dev not ending at /dev/null, disagreeing answers, and a walk over 20000 lstat calls. Also:
  a decision never throws, a word over 4096 characters is refused, the entry check compares real paths.
- After: the guard probe (300 decisions on the long link, 20 processes) 20 of 20 exit 0, 300 of 300 refused, `<link>/null`
  allowed; the bare call in the same run still crashed 11 of 20. Still not judged: a glob expanding to a device, a FIFO
  path the shell reaches other than by its operands, Linux `/proc/self/fd`.
