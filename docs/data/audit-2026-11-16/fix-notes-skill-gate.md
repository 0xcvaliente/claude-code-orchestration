# Fix notes: skill gate and publish scan (slice fix-skill-gate)

## W-1: the whole branch is scanned, and only the skill folder and README.md may change

- What changed: new library `.claude/hooks/skill-scan.mjs` (the patterns, `scanText`, `mask`, and `scanBranch`: every
  line any commit from the merge base to the tip of `skill/<name>` adds, on every path, merges against each parent,
  binary files as text, renames off, external diff, textconv and replace refs off; plus every path those commits touch).
  `.claude/hooks/skill-gate.mjs` imports it and adds the reason code `paths`; `scripts/skill-publish.mjs` runs it as a
  new step 4 (before the push, and in `--dry-run` too). Tests: `src/skill-gate.test.mjs`, `src/skill-publish.test.mjs`.
- Visible effect: a skill slice's implementer is blocked for a secret that an earlier commit added and a later one
  removed (named as `<file>, only in earlier commit <sha12>: <kind>`, with the advice to recreate the commits with
  `git reset --soft <merge base>`, seal and commit once), and for any committed path outside `skills/<name>/` and
  `README.md` (`[paths]`, with or without a secret; a committed root `.gitignore`, `scripts/` change or a link at
  `skills/<name>` counts too), and for a branch with no merge base. A person running `npm run skill-publish` (dry run
  included) gets the same findings and exit 1 before anything is pushed.
- Docs to update besides docs/skills.md: `.claude/rules/agents.md` "Skill creation", skill gate bullet (add the branch
  scan, the `paths` code and `skill-scan.mjs` as a library shared with the publish script); README.md line ~532 (the
  hooks list: add `skill-scan.mjs`, a library) and ~202 (optionally: the gate scans the whole branch); CLAUDE.md 1.4.0
  bullet (the skill gate also scans the branch history and paths; the publish script runs the same scan);
  CHANGELOG.md entry. `dist/plugin` must be rebuilt (`npm run build-plugin`): it ships the changed gate and the new
  module.

## W-9: home paths that end the word, and the Windows form

- What changed: the home-path patterns in `.claude/hooks/skill-scan.mjs` accept a slash or a word end after
  `/root`, `/home/<user>` and `/Users/<user>`, and add `C:\Users\<user>` (single or doubled backslashes);
  `/Users/Shared` and `C:\Users\Public`, `Default`, `All Users` are excused. Test in `src/skill-gate.test.mjs`.
- Visible effect: `cd /Users/alice`, `HOME=/home/bob`, `see /home/bob.`, `cd /root` and `C:\Users\alice\notes` now
  block as `home-directory path`; `/Users/Shared/x` no longer does (it was flagged before).
- Docs to update besides docs/skills.md: none beyond the W-1 lines (README.md, `.claude/rules/agents.md` and CLAUDE.md
  do not list the patterns).

## Not covered

- Commit messages and author or committer identities are pushed but not scanned (a `Co-Authored-By` trailer would be
  an e-mail finding on every commit).
