# Fix notes: skill gate and publish scan (slice fix-skill-gate)

## W-1: what a push sends is scanned, and only the skill folder and README.md may change

- What changed: new library `.claude/hooks/skill-scan.mjs` (patterns, `scanText`, `mask`, `scanBranch`: every line any
  commit from the merge base to the tip of `skill/<name>` adds, every path; merges against each parent, binary as text,
  renames, external diff, textconv and replace refs off; names judged raw from `-z` output, control characters never
  allowed). `skill-gate.mjs` imports it (new code `paths`); `scripts/skill-publish.mjs` runs it as step 4, in
  `--dry-run` too. Tests: `src/skill-gate.test.mjs`, `src/skill-publish.test.mjs`.
- Which commits: publish reads `git ls-remote origin` and also scans every commit below the merge base that origin's
  refs do not reach (exactly what the push sends), refusing when there is any. The gate does the same with
  `refs/remotes/origin/*` when `refs/remotes/origin/<base>` exists (as fresh as the last fetch), else the merge-base
  range only.
- Visible effect: the implementer is blocked for a secret an earlier commit added and a later one removed
  (`<file>, only in earlier commit <sha12>: <kind>`, advice: `git reset --soft <merge base>`, seal, commit once), for
  any committed path outside `skills/<name>/` and `README.md` (a root `.gitignore`, `scripts/`, a link at
  `skills/<name>`, a name with a newline shown escaped), for a branch with no merge base, and for base commits origin
  lacks (named; their secrets as `in commit <sha12>, which is not part of the draft`). A person running
  `npm run skill-publish` gets the same findings and exit 1 before any push, dry run included; origin unreadable
  is refused too.
- Docs besides docs/skills.md: `.claude/rules/agents.md` "Skill creation" gate bullet (branch scan, `paths`, the
  remote rule, `skill-scan.mjs` shared with publish); README.md ~532 (hooks list: `skill-scan.mjs`, a library) and
  ~202; CLAUDE.md 1.4.0 bullet; CHANGELOG.md. `dist/plugin` must be rebuilt (`npm run build-plugin`).

## W-9: home paths that end the word, and the Windows form

- What changed: the home-path patterns in `skill-scan.mjs` accept a slash or a word end after `/root`,
  `/home/<user>` and `/Users/<user>`, and add `C:\Users\<user>` (single or doubled backslashes); `/Users/Shared` and
  `C:\Users\Public`, `Default`, `All Users` are excused. Test in `src/skill-gate.test.mjs`.
- Visible effect: `cd /Users/alice`, `HOME=/home/bob`, `see /home/bob.`, `cd /root` and `C:\Users\alice\notes` now
  block as `home-directory path`; `/Users/Shared/x` no longer does (it was flagged before).
- Docs besides docs/skills.md: none beyond the W-1 lines (the others do not list the patterns).

## Not covered

- Commit messages and author or committer identities are pushed but not scanned (a `Co-Authored-By` trailer would be
  an e-mail finding on every commit); docs/skills.md "Limits" says so.
