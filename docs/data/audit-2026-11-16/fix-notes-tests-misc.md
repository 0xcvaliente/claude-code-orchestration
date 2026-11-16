# Fix notes: fix-tests-misc

Slice `fix-tests-misc` of the 1.4.6 audit: O-10 (output-tokens.md), the `plain` script's output style, D-5 (dashboard-bench.md).

## 1. O-10: gate-hardening tests split and shortened

- What changed: `src/gate-hardening.test.mjs` is removed. Its 23 tests are in three files cut along its own sections, each importing `./test-tmp.mjs` first, with the helpers they use repeated in each file:
  - `src/gate-hardening-time.test.mjs`: section 1 (time limit and hook budget), 6 tests.
  - `src/gate-hardening-trap.test.mjs`: section 1b (temp folder, `run_limited`), 6 tests.
  - `src/gate-hardening-logs.test.mjs`: sections 2 to 5 and the follow-ups, 11 tests.
- Two tests shortened as the audit names: the polite and the stubborn `run_limited` calls run as two background jobs of the one bash script (each writes its own `lim_timed_out` flag, printed in fixed order after both `wait`s; cleanup and kill asserts unchanged), and the plain-agent half of "no time left for the bugfix check" runs in a fresh repo without the 5 s suite, with the same `ORCH_HOOK_BUDGET_S`.
- Nothing lost: same 23 test names; every assertion line of the old file is in the new files (84 calls before; 86 after, the extra two being the `git()` helper's assert repeated in two more files). The one changed line points the plain-agent `tests_passed` assert at the fresh repo.
- `scripts/run-tests.mjs` runs `tsx --test src/*.test.ts src/*.test.mjs`, so the new files are picked up.
- Visible effect: the file group took 63.0 s alone before; 29 to 33 s after (five runs in a row). The `run_limited` terminate test went from 16.2 s to about 10.2 s and the budget test from 10.3 s to about 5.8 s. The slowest part (`-time`, about 29 s) now sets the group's time; the loop-guard test (9.7 s) is untouched.
- Load: five runs started together all passed (30 to 31 s each, 22 pass, 1 skip, 0 fail); the timing asserts held, with the slow tests' durations within 0.1 s of a lone run (terminate 9.2 to 10.2 s, loop guard 9.7 s, budget 5.8 s).

## 2. `npm run plain` names the Concise output style

- What changed: `package.json` `plain` is `claude --settings '{"agent":"","outputStyle":"Concise"}'`, the JSON `scripts/orchestrate.sh` passes for a plain session. `src/policy.test.ts` pins the new text and also parses the JSON (agent `""`, outputStyle `Concise`). It failed before the change and fails again with the agent set to `orchestrator`.
- Visible effect: `npm run plain` starts a plain session with the same Concise style as the headless launchers.

## 3. D-5: statusline prints names literally

- What changed: `statusline/statusline.sh` colour variables hold real escape bytes (`$'\033[36m'`); the two output lines use `printf '%s\n'` instead of `echo -e`, and `usage_window` `printf '%s'` instead of `printf '%b'`. New test in `src/statusline.test.ts` (skipped without jq): folder `/x/my\cproj`, model `Op\tus`.
- Visible effect: a folder or model name with a backslash shows as it is; the line no longer stops at `\c` and the context bar stays on its own line. Colours unchanged (checked byte for byte with `od -c`).

## Docs to update

- `CLAUDE.md:12`: "`npm run plain`: a plain session here (`claude --settings '{"agent":""}'`)".
- `README.md:511`: the `npm run plain` row (`claude --settings '{"agent":""}'`).
- `docs/native-mode.md:9`: names the plain-session command; check its wording.
- `.claude/rules/agents.md:71`: lists `npm run plain` among launchers that clear the agent; still true, check whether it quotes the JSON.
