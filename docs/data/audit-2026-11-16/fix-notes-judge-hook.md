# Fix notes: slice fix-judge-hook (J-12, O-11 judge clamp test)

## J-12: the native judge's record of the person's requests is out of the project

- What changed: `state.mjs` gains `PROMPT_STORE_NAME` (`judge-prompts`), `promptStoreDir(project)` and `promptStore`
  (its state-folder rule and `OPTION_KEYS` are unchanged). `prompt-capture.mjs` now appends to
  `<CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/judge-prompts/<project key>/prompts.jsonl` (folder 0700, file 0600),
  keyed by `stateKey` like the per-user state folder, for the project copy and the plugin copy alike (not
  `CLAUDE_PLUGIN_DATA`). `judge-hook.mjs` reads only that file, and while the judge is on denies, with no model call, a
  Bash command whose text (quotes and backslashes dropped, case ignored) contains `judge-prompts`: the absolute path,
  `~/...`, `$HOME/...` or the bare folder name, even a read. Tests: `src/judge-hook.test.mjs` (three J-12 tests).
- Visible effect for a person with the judge on: the typed requests are now in the per-user folder above; a
  `prompts.jsonl` in `<project>/.claude/state` is ignored (old records there no longer count, so a session started
  before the update has no recorded request until the person types again). Commands such as `cat`, `tail`, `ls` or
  `echo >>` naming `judge-prompts` are refused with "the command names the judge's record of the user's requests"
  and logged as a judge deny in `gates.jsonl`.
- Docs to update: `docs/bash-judge.md` "Native hook" (Authority: where the store is; the new refusal) and its Limits:
  the judge sees Bash only, so a worker with the Write or Edit tool, or a Bash command that reaches the store through a
  spelling the text check cannot see (a glob such as `judge-*`, a name built at run time from variables or `$'\x..'`
  escapes, a `cd` into the parent then a relative glob), can still alter it; best-effort, not a sandbox. Also
  `docs/native-mode.md` (line naming `prompts.jsonl` in the state dir), README.md "Safety", `.claude/rules/agents.md`
  (native Bash judge paragraph) and CLAUDE.md where they name the store. `dist/plugin` needs `npm run build-plugin`
  (not run in this slice), and CHANGELOG.md an entry.

## O-11: the judge's clamp test no longer waits 45 s

- What changed: in `src/judge-hook.test.mjs` the background run with a 120000 ms setting and a 90 s stub is gone. The
  clamp test now checks `judgeTimeoutMs` edges (unset, empty, text, 0, negative, 1, 400, 44999, 45000, 45001,
  120000), that `judge-hook.mjs` takes its deadline only from `judgeTimeoutMs(process.env.ORCH_JUDGE_TIMEOUT_MS)` and
  arms its timer with it, and one end-to-end run with 1500 ms that denies with `judge_timeout: timed out after 1500 ms`
  in under 10 s. The parity test and the other tests are unchanged.
- Visible effect: the file takes about 8 s instead of about 46 s; the live 45 s cut itself is no longer run.
- Docs to update: none needed; a test-suite note in CHANGELOG.md if the release lists test changes.
