# Fix notes: scripts (slice fix-scripts)

Tests: `src/scripts-fixes.test.mjs` (W-3, W-4, W-5, O-9, O-5, beside its four older tests, kept unchanged), `src/run-result.test.mjs` (W-6), `src/build-plugin.test.mjs` (W-7), `src/verify.test.ts` (O-11). Each failed before its fix and passes after it.

## W-3: headless git rules
- Changed: `scripts/orchestrate.sh` (allow and deny lists, two comments), `src/verify.test.ts` (drift list = UNSAFE_BASH plus the headless git denies).
- Effect: `Bash(git -C *)` is gone. The `git -C <dir>` allow rules are pinned to status, diff, log, show, rev-parse, ls-files, rev-list, `branch --show-current`, `worktree list`, `worktree add`, add, commit, merge and `reset --merge`, but each rule's `*` also matches other words, so these are not the only `git -C` commands that pass (see the known limit). The plain rules are unchanged. Newly denied, headless only: `git -c` and `--config-env` (also after `-C <dir>`), `reset ... --h...` (any spelling of --hard), `git clean` and `git <opts> clean -<flag>`, the global options that take a separate value (`--namespace`, `--git-dir`, `--work-tree`, `--exec-path`, `--super-prefix`, `--attr-source`, a second `-C`). Refused now: `git -C /r reset --hard`, `clean -fdx`, `checkout -- .`, `-c core.hooksPath=/x commit`, `-c alias.p=push p`. Still allowed: adds of paths and commit messages containing config, restore, clean, checkout or rm. Over-block (pinned in the test): a commit message containing ` -c` is refused.
- Known limit: the rules stop the plain destructive forms an agent might run by mistake; they do not stop a command built to get around them. A `git -C * status*` rule matches any git command that has an allowed subcommand word as a later argument, e.g. `git -C /r branch -D main status` or `git -C /r checkout -- . diff` (pinned in the test). The base rule allowed those too; nothing got wider.
- Docs to update: CHANGELOG.md 1.4.4 "Known and not fixed" (replace the `Bash(git -C *)` line with the known limit above); docs/native-mode.md:251 ("so no headless run can push whatever the folder's settings say": add that the lists guard against mistakes, not a command built to pass); `.claude/rules/agents.md` and CLAUDE.md "Pushes and deletes" (name the headless git denies and the limit).

## W-4: a task that starts with a dash
- Changed: `scripts/orchestrate.sh`, `bench/lib/native-launch.sh`, `bench/lib/plugin-launch.sh`, `docs/data/live-checks-2026-11-16.md` (Check 5).
- Effect: a dash-led task (`npm run native -- "-x ..."`) reaches claude as `... --allowedTools <rules> -- "<task>"` and runs; any other task keeps its place after `-p`, so ordinary arguments are unchanged (bench/arms.test.mjs pins `-p <prompt>`). The bench launchers pass a dash-led placeholder for a dash-led prompt. Probe (2.1.325, haiku, one turn): the prompt `-x Reply ...` after `--` was answered, `ok`.
- Docs to update: CHANGELOG.md:35 and README.md:419 (dash-led tasks as a known limitation), `.claude/rules/agents.md` 1.4.5 "Dash-led tasks". `scripts/claude-update.mjs` needs no change: `--` is not an option.

## W-5: CDPATH
- Changed: `scripts/auto.sh` (repo, here, root), `scripts/orchestrate.sh` (here).
- Effect: with CDPATH exported, `npm run auto -- "task" proj` uses `./proj`, and either launcher started by a relative path finds its own folder.
- Docs to update: none (CHANGELOG 1.2.0 already promises the caller's folder).

## W-6: no result record
- Changed: `scripts/run-result.mjs`, `scripts/log-run.mjs` (comment only: it already logs orch_totals).
- Effect: a crashed or killed run prints `{"type":"result","subtype":"no_result","is_error":true,"terminal_reason":"no_result","result":<plain-text lines>,"orch_totals":{"results":0,"turns":<assistant messages seen>,"wall_ms":…,"exit_code":…,"complete":false}}` instead of an empty line; runs.jsonl gets the wall time, the turns and terminal_reason `no_result`. A stream with no records at all (an error text) is still printed unchanged.
- Docs to update: README "Briefs and replies"/headless output section if it lists orch_totals cases; CHANGELOG entry.

## W-7: build check
- Changed: `scripts/build-plugin.mjs` (a file walk replaces `diff -r -x results`).
- Effect: `npm run check-plugin` skips only `dist/plugin/evals/results`; a stale file under any other `results` path (a skill's `results/`, `evals/cases/results`) fails it. The failure lists `Files differ: <path>` / `Only in <dir>: <path>` lines instead of diff output. Note: dist/ on this branch is already stale against the sources changed by other slices (19 files, same count with the old diff); not rebuilt here (C2).
- Docs to update: CHANGELOG 1.2.0 line 229 wording ("results" excluded) if restated.

## O-9: terminal output
- Changed: `scripts/run-result.mjs` (`terminalForm`, `--terminal`), `scripts/orchestrate.sh`, `scripts/auto.sh`.
- Effect: in a terminal, `npm run native` and `npm run auto` print the result text and one line `turns 41, 723 s, exit 0`; piped or captured they print the JSON document as before (auto.sh, log-run.mjs, the bench read it).
- Docs to update: docs/native-mode.md and README where they say the launchers print JSON ("prints one JSON document"): add "when stdout is not a terminal".

## O-5: output style
- Changed: `scripts/orchestrate.sh` (plain branch), `src/orchestrate-sh.test.mjs` (the pinned settings text is now `{"agent":"","outputStyle":"Concise"}`).
- Effect: the plain session (`ORCH_AGENT=none`, also auto.sh's plain and reviewed session) runs in the Concise style. New variable ORCH_OUTPUT_STYLE: unset = Concise; `default` or empty = no style (`{"agent":""}` as before); another plain word (letters, digits, `_`, `-`) = that style; anything else exits 1 before any model call. Key and name checked against https://code.claude.com/docs/en/output-styles and in Check 5. Not done: `package.json` `plain`, because `src/policy.test.ts:74` (not owned) pins it to `claude --settings '{"agent":""}'`.
- Docs to update: `.claude/rules/agents.md` 1.4.4 "Default agent" and CLAUDE.md (the flag text), the env list in README/docs/native-mode.md (ORCH_OUTPUT_STYLE).

## O-11: test time
- Changed: `src/verify.test.ts` (async `reviewedWith`, the eleven cases under `Promise.all`).
- Effect: none for users; that test takes about 1 s instead of about 8 s, same assertions.
- Docs to update: none.
