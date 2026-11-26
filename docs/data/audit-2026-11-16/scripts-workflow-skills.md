# Audit 2026-11-16: scripts, gated workflow, skill hooks, build and CI (HEAD a853b8c)

Slice `audit-scripts-skills`. Read-only audit: nothing in the repository was changed except this file. Every run used a
scratch folder, `$S` below:
`<scratch>/audit/audit-scripts-skills`
(`$P` is the project root). The launchers ran only against a fake `claude` in `$S/bin`; the build ran in a
`git archive HEAD` copy at `$S/copy`. No model call, push, install or whole-suite run. Helpers kept in `$S` for re-runs:
`bin/claude` (a fake that writes its argv to `$FAKE_ARGS`, prints a `system` record, then a `result` record unless
`FAKE_NORESULT` is set, and exits `$FAKE_CODE`), `proj/` (a folder with `.claude/agents/orchestrator.md`),
`sigtest.sh`, `wf-isolated.mjs` and `gate-leak.mjs`. Observed outputs below shorten the scratch path to `$S`.

## Summary

| id | kind | severity | title | files a fix would touch |
| --- | --- | --- | --- | --- |
| W-1 | bug | high | The skill gate passes a branch that carries a secret in an earlier commit or outside the skill folder, and `skill-publish` pushes it unscanned | `.claude/hooks/skill-gate.mjs`, `scripts/skill-publish.mjs`, `src/skill-gate.test.mjs`, `src/skill-publish.test.mjs`, `docs/skills.md` |
| W-2 | bug | medium | Gated workflow: a parallel (isolated) slice that fails its merged review fails for good at once, with no refute pass and no retry | `.claude/workflows/orchestrate.js`, `src/workflow.test.mjs`, `README.md`, `docs/native-mode.md`, `dist/plugin/workflows/orchestrate.js` (rebuild) |
| W-3 | known | medium | `Bash(git -C *)` reaches `reset --hard`, `clean`, `checkout -- .`, `-c core.hooksPath` and an alias push that no deny rule names; two comments and a doc line say otherwise | `scripts/orchestrate.sh`, `src/config.ts` (`UNSAFE_BASH`), `src/verify.test.ts`, `src/orchestrate-sh.test.mjs`, `docs/native-mode.md` |
| W-4 | known | low | A task that starts with `-`: the exact launcher fix | `scripts/orchestrate.sh`, `src/orchestrate-sh.test.mjs`, `scripts/claude-update.mjs` (`HEADLESS_FLAGS`, if `--` must be listed), `CHANGELOG.md`, `README.md` |
| W-5 | bug | low | `auto.sh` resolves a relative repo through an exported `CDPATH`: the wrong folder, and a two-line path | `scripts/auto.sh` (and the `here=` lines of both launchers), `src/auto.test.ts` |
| W-6 | bug | low | `run-result.mjs` prints nothing for an event stream with no result, so the run's wall time and stream are lost | `scripts/run-result.mjs`, `scripts/log-run.mjs`, `src/run-result.test.mjs` |
| W-7 | bug | low | `build-plugin --check` ignores every source path named `results`, not only `dist/plugin/evals/results` | `scripts/build-plugin.mjs`, `src/build-plugin.test.mjs` |
| W-8 | docs-drift | low | `docs/native-mode.md` says the eval suite has not been smoke-run; README and CLAUDE.md say it was on 2026-11-10 | `docs/native-mode.md` |
| W-9 | improvement | low | The skill gate's home-path pattern needs a trailing slash: `/Users/alice`, `/home/bob.` pass | `.claude/hooks/skill-gate.mjs`, `src/skill-gate.test.mjs`, `docs/skills.md` |
| W-10 | improvement | low | Skill hints by goal words picked two unrelated skills for this audit's own launch | `.claude/hooks/skill-hint.mjs`, `src/skills.test.mjs` |

Counts: bug 5 (high 1, medium 1, low 3), known 2 (medium 1, low 1), docs-drift 1 (low), improvement 2 (low).

## Coverage

- `scripts/orchestrate.sh`: full. Run with a fake `claude` (arguments, no-result stream, SIGTERM, SIGINT, SIGHUP).
- `scripts/auto.sh`: full by reading; line 26 run in isolation (W-5). Not run end to end: it starts triage (`src/route.ts`).
- `scripts/run-result.mjs`, `scripts/log-run.mjs`, `scripts/tokens.mjs`, `scripts/prices.mjs`: full (run through the launcher).
- `scripts/report.mjs`: full by reading (escaping, last-stop join, cost); not run.
- `scripts/build-plugin.mjs`: full; build and `--check` run in `$S/copy`.
- `scripts/check.mjs`: partial (lines 40-134 read; 1-39 not read). `scripts/run-tests.mjs`: full by reading.
- `scripts/claude-update.mjs`: partial (120-312 read, 1-119 by grep); run without the `claude` CLI in a scratch home.
- `scripts/skill-publish.mjs`: full by reading; not run (it pushes).
- `scripts/install-statusline.sh`, `scripts/sandbox-smoke.mjs`, `scripts/test-dashboard.mjs`: not reached.
- `.claude/workflows/orchestrate.js`: partial (380-679 read; 1-379 and 680-729 by grep of their functions); run against a stubbed runtime (W-2).
- `.claude/hooks/skill-catalog.mjs`: partial (1-135, 229-263). `.claude/hooks/skill-hint.mjs`: partial (grep of caps, rules and goal scoring).
- `.claude/hooks/skill-seal.mjs`: full. `.claude/hooks/skill-gate.mjs`: full, run in scratch (W-1). `.claude/hooks/nudge.mjs`: full.
- `.claude/skills/skill-authoring/` (SKILL.md and references): not reached.
- `.github/workflows/ci.yml`: full. `package.json`: partial (version). `tsconfig.json`: partial (include, exclude, checkJs).
- `.claude-plugin/marketplace.json`: full (no version field; the version lives in `dist/plugin/.claude-plugin/plugin.json`, 1.4.5 like `package.json`).
- Built plugin manifest and hook registration: compared through `scripts/build-plugin.mjs` lines 79-117 against `.claude/settings.json` (full): every project hook has a plugin registration with the same event and timeout, matchers as documented; `--check` on a pristine copy passes (deterministic).
- Tests read for their harness only: `src/workflow.test.mjs` (15-74), `src/skill-gate.test.mjs` (20-119). The other listed tests: not reached.
- Docs: README "The gated workflow", "The plugin", "Known limitations"; `docs/native-mode.md` "Headless, CI and unattended", "Known limitations", "Plugin build"; `docs/skills.md` (grep); `docs/claude-code-updates.md:26`; CHANGELOG "Known and not fixed" of every release.

## Findings

### W-1: The skill gate passes a branch that carries a secret in an earlier commit or outside the skill folder, and skill-publish pushes it unscanned

- kind: bug
- severity: high
- where: `.claude/hooks/skill-gate.mjs:351-380` (the scan covers the files on disk under `skills/<name>/` and the README.md lines `git diff <merge base>` adds, nothing else); `scripts/skill-publish.mjs:255-267` (pushes `skill/<name>` with all its history; no scan step at all).
- what happens: (A) the gate blocks a token, the worker deletes it and commits on top (what the block message tells it to do), the gate then passes, and the token stays in the branch history that `npm run skill-publish` pushes. (B) a file outside `skills/<name>` and README.md (here `notes/leak.md`) is committed on the branch: it is never sealed, never scanned, and it is pushed. The gate's own text says "a skill branch changes only its skill folder and README.md" (line 336) but only `scripts/` is enforced. With `TARGET: public` this publishes the secret.
- reproduction: `cd $S && TMPDIR=$S/tmp node gate-leak.mjs $P $S` (the script copies `.claude/hooks` into `$S/gate-*/project`, builds a skills repo and a draft worktree as `src/skill-gate.test.mjs` does, writes the launch record and runs `skill-gate.mjs` with `CLAUDE_PROJECT_DIR`, `CLAUDE_CONFIG_DIR` and `HOME` in scratch). Observed:
  ```
  A-history: gate exit 0; token in main..skill/demo-skill history: true
  B-outside: gate exit 0; token in main..skill/demo-skill history: true
  {"...","skill":"demo-skill","target":"private","decision":"allow","reason":"ok","failed":[],"problems":0}
  ```
- expected (source): `docs/skills.md:27` "secret and personal-detail check" as the compliance step before a person publishes; `skill-gate.mjs:336` "a skill branch changes only its skill folder and README.md"; `.claude/rules/agents.md` (skill creation): the gate checks secrets so nothing unchecked is pushed. The pushed object is the branch, so the branch (every commit from the merge base) is what must be clean.
- fix scope: `skill-gate.mjs`: scan every added line of `git log -p --no-ext-diff --no-textconv <merge base>..refs/heads/skill/<name>` (all commits, all paths) and add a check that the branch touches only `skills/<name>/**` and `README.md` (`git diff --name-only <merge base> refs/heads/skill/<name>`); on a history hit, tell the worker to rewrite the branch (reset to the merge base and commit again). `skill-publish.mjs`: run the same scan before step 4 (share the patterns, for example export `scanText` from the gate or move it to a small module beside `skill-seal.mjs`). Tests in `src/skill-gate.test.mjs` and `src/skill-publish.test.mjs`; `docs/skills.md` line 67.
- confidence: 85

### W-2: Gated workflow: a parallel (isolated) slice that fails its merged review fails for good at once, with no refute pass and no retry

- kind: bug
- severity: medium
- where: `.claude/workflows/orchestrate.js:654-667` (the review after the integrator: `b.status = gaps.length ? 'failed' : 'passed'`), against the shared-tree loop at 571-614.
- what happens: in a wave of two or more code slices with `baseRefHead`, each slice is built once, merged, and reviewed once. A failing review fails the slice for good: `refute()` is never called and the `maxRetries` loop never runs, so a gap the refute pass would drop still fails it, and the replan pass starts. The failed slice's code stays merged in the current branch, under the replanned work. A shared-tree slice with the same review gets the refute pass and up to `maxRetries` retries (the last on opus).
- reproduction: `cd $S && node wf-isolated.mjs $P/.claude/workflows/orchestrate.js` (the stubbed runtime of `src/workflow.test.mjs`; two slices, `baseRefHead: true`, the first review of slice `a` fails with one gap at confidence 90, the refute stub drops every gap). Observed:
  ```
  agent labels: build:a#1 integrate review:a plan:replan
  slice a: {"id":"a","status":"failed","attempts":1,"gaps":["a: edge case wrong"]}
  ```
- expected (source): README.md:271 "build and review each slice ..., retry with refuted gaps, replan once the slices that failed for good"; the header's `maxRetries`, `refute` and `escalateLast` (orchestrate.js:23-42) are stated for every slice, with no exception for isolated ones. The native orchestrator retries a worktree slice by `SendMessage` resume (`.claude/rules/agents.md`, retry flow).
- fix scope: `orchestrate.js` (after a failed merged review, run `refute()` and, while attempts remain, rebuild the slice in a new worktree with the standing gaps, merge, review again; or, if this is intended, say so in the header), `src/workflow.test.mjs` (an isolated-wave retry test), README.md "The gated workflow" and `docs/native-mode.md` (the difference), then `npm run build-plugin`.
- confidence: 90

### W-3: `Bash(git -C *)` reaches reset --hard, clean, checkout -- ., -c core.hooksPath and an alias push that no deny rule names

- kind: known (CHANGELOG.md:61, 1.4.4 "Known and not fixed": "The headless allow rule `Bash(git -C *)` ... can reach git forms that the narrower rules do not name.")
- severity: medium
- where: `scripts/orchestrate.sh:91` (the rule); `scripts/orchestrate.sh:90` says of `git reset --merge` "exactly this form, no other reset"; `scripts/orchestrate.sh:158-160` says "`Bash(git -C *)` cannot reach a push"; `docs/native-mode.md:251` says "so no headless run can push whatever the folder's settings say".
- what happens (new evidence): matched as plain globs, these forms hit the allow rule and none of `UNSAFE_BASH`: `git -C /r reset --hard`, `git -C /r clean -fdx`, `git -C /r checkout -- .` (all lose uncommitted work), `git -C /r -c core.hooksPath=/x commit -m m` (runs a program of the agent's choosing), and `git -C /r -c alias.p=push p origin main`, which pushes while no deny pattern matches, because `Bash(git * push*)` needs a space before `push`.
- reproduction: each rule turned into a regex where `*` is `.*` (a model of Claude Code's prefix-glob rules), as run:
  ```
  node -e '
  const glob=(p)=>new RegExp("^"+p.replace(/[.+?^${}()|[\]\\]/g,"\\$&").replace(/\*/g,".*")+"$");
  const deny=["git push*","git * push*","git remote*","git * remote*"];
  for (const c of ["git -C /r push origin main","git -C /r -c alias.p=push p origin main","git -C /r reset --hard","git -C /r clean -fdx","git -C /r checkout -- .","git -C /r -c core.hooksPath=/x commit -m m"]) console.log(JSON.stringify(c).padEnd(46), "deny:", deny.filter(d=>glob(d).test(c)).join(",")||"none", "| allow git -C *:", glob("git -C *").test(c));'
  ```
  Observed:
  ```
  "git -C /r push origin main"                   deny: git * push* | allow git -C *: true
  "git -C /r -c alias.p=push p origin main"      deny: none | allow git -C *: true
  "git -C /r reset --hard"                       deny: none | allow git -C *: true
  "git -C /r clean -fdx"                         deny: none | allow git -C *: true
  "git -C /r checkout -- ."                      deny: none | allow git -C *: true
  "git -C /r -c core.hooksPath=/x commit -m m"   deny: none | allow git -C *: true
  ```
  Not checked against Claude Code's own matcher (that needs a model turn); the alias push depends on Claude Code not parsing `-c alias.*`, hence the confidence.
- expected (source): the comments at `orchestrate.sh:90` and `:158-160`, `docs/native-mode.md:251`, and CLAUDE.md "Pushes and deletes" (headless runs never push).
- fix idea: replace `Bash(git -C *)` with pinned read and write forms, as `auto.sh:116-123` already does for the reviewer (`Bash(git -C <repo_abs> status*)`, `diff*`, `log*`, `show*`, `add*`, `commit*`, `merge*`, `branch*`, `worktree*`), and add to `UNSAFE_BASH` `Bash(git * -c *)`, `Bash(git -c *)`, `Bash(git * reset --hard*)` and `Bash(git * clean*)`. Worktree agents use `git -C <worktree>`, so the pins need the worktree root (`<repo>/.claude/worktrees/*`, which reopens a wildcard before the subcommand: pin `Bash(git -C <repo>/.claude/worktrees/* commit*)` and accept that `*` there). Correct the two comments and the doc line. Tests: `src/verify.test.ts` (UNSAFE_BASH drift), `src/orchestrate-sh.test.mjs`.
- fix scope: `scripts/orchestrate.sh`, `src/config.ts`, `src/verify.test.ts`, `src/orchestrate-sh.test.mjs`, `docs/native-mode.md`.
- confidence: 60 (alias push), 95 (the reset, clean and checkout reach)

### W-4: A task that starts with `-`: the exact launcher fix

- kind: known (CHANGELOG.md:35, README.md:419, `.claude/rules/agents.md` 1.4.5 "Dash-led tasks")
- severity: low
- where: `scripts/orchestrate.sh:134` (`args=(-p "$task")`).
- what happens (new evidence): the prompt reaches `claude` as the word after `-p`, so a dash-led task is read as an option.
- reproduction: `cd $S/proj && env -i PATH=$S/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin HOME=$S/home TMPDIR=$S/tmp CLAUDE_PROJECT_DIR=$S/proj FAKE_ARGS=$S/args1 bash $P/scripts/orchestrate.sh "-x leading dash task" $S/proj; head -3 $S/args1` (fake `claude` writes its argv). Observed:
  ```
  -p
  -x leading dash task
  --agent
  ```
- fix idea: `args=(-p)` at line 134 and, after line 163 (the variadic `--allowedTools`, which today must stay last), `args+=(-- "$task")`. `--` ends both the variadic list and option parsing, so the task becomes the positional prompt whatever it starts with, and `--allowedTools` no longer has to be last. `bench/lib/native-launch.sh:15-21` replaces the placeholder by value, so it carries `--` through unchanged; `bench/lib/plugin-launch.sh` needs the same check. Needs one live probe on the installed Claude Code that `claude -p ... --allowedTools A B -- "-x"` takes `-x` as the prompt (record it in `docs/data/live-checks-*.md`), and `src/orchestrate-sh.test.mjs` asserting the last two arguments are `--` and the task.
- fix scope: `scripts/orchestrate.sh`, `src/orchestrate-sh.test.mjs`, then drop the CHANGELOG/README known lines.
- confidence: 75 (the commander-style handling of `--` is not probed here)

### W-5: auto.sh resolves a relative repo through an exported CDPATH

- kind: bug
- severity: low
- where: `scripts/auto.sh:26` (`repo="$(cd "$repo" 2>/dev/null && pwd)"`); also `scripts/auto.sh:27` and `scripts/orchestrate.sh:42` (`here=...` from a relative `dirname`).
- what happens: with `CDPATH` exported, bash searches it first for a relative name, so `auto.sh "task" proj` takes `$CDPATH/proj` instead of `./proj`, and because `cd` prints the folder it found, `repo` holds that path twice on two lines; `route.ts` and `orchestrate.sh` then get a path that does not exist. `orchestrate.sh:54` already guards this (1.4.4: `CDPATH='' cd -- "$repo"`), `auto.sh` does not.
- reproduction: line 26 run alone, `cd $S/work && CDPATH=$S/cdp bash -c 'repo=proj; repo="$(cd "$repo" 2>/dev/null && pwd)" || exit 1; printf "auto.sh line 26 gives: [%s]\n" "$repo"'`, and the same with orchestrate.sh's form. Observed:
  ```
  auto.sh line 26 gives: [$S/cdp/proj
  $S/cdp/proj]
  orchestrate.sh line 54 gives: [$S/work/proj]
  ```
- expected (source): `auto.sh:25` "Absolute before the cd ... route.ts would resolve a relative path against that root" and CHANGELOG 1.2.0 line 233 ("resolves a relative repo path against the caller's folder").
- fix scope: `scripts/auto.sh:26` `repo="$(CDPATH='' cd -- "$repo" 2>/dev/null && pwd)"`, the same `CDPATH=''` on the `here=` lines of both launchers; a case in `src/auto.test.ts`.
- confidence: 90

### W-6: run-result.mjs prints nothing for an event stream with no result

- kind: bug
- severity: low
- where: `scripts/run-result.mjs:50-61` (stream records are dropped; with no `result` record it returns only the non-record lines, here none).
- what happens: when `claude` exits without a result event (a crash or a kill after start-up), `orchestrate.sh` prints an empty line and `runs.jsonl` gets `duration_ms: null`, `turns: null` and `result: ""`, although the script knows the start time and the exit code. The JSON stream itself is lost (the temp file is removed at exit), so nothing records what happened.
- reproduction: `cd $S/proj && env -i PATH=$S/bin:/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin HOME=$S/home TMPDIR=$S/tmp CLAUDE_PROJECT_DIR=$S/proj FAKE_ARGS=$S/args3 FAKE_NORESULT=1 FAKE_CODE=1 bash $P/scripts/orchestrate.sh "no result task" $S/proj; tail -1 $S/proj/.claude/state/runs.jsonl`. Observed: an empty stdout line, exit 1, and
  ```
  {"task":"no result task","ok":false,"tokens":null,"usage":null,"duration_ms":null,"turns":null,"terminal_reason":"unparsed output","subagents":{},"result":"","exit_code":1,"complete":false}
  ```
- expected (source): `run-result.mjs:19` "Output that is not an event stream ... is printed unchanged" (an event stream without a result is neither case), and `log-run.mjs:4-5` (duration is the whole run's wall time).
- fix scope: `run-result.mjs`: with records but no result, print `{ type: "result", is_error: true, subtype: "no_result", orch_totals: { results: 0, turns: 0, wall_ms, exit_code, complete: false } }` (or the last few stream lines); `log-run.mjs` then logs the wall time; `src/run-result.test.mjs`.
- confidence: 80

### W-7: build-plugin --check ignores every source path named results

- kind: bug
- severity: low
- where: `scripts/build-plugin.mjs:178` (`diff -r -x results`): `-x` excludes a name at any depth, on both sides.
- what happens: a stale `dist/plugin` passes `npm run check-plugin` (and the `dist` check of `claude-update`) when the changed source is a file or folder named `results` anywhere: under `.claude/skills/<x>/results/`, `evals/results`, or a hook folder.
- reproduction: `mkdir -p $S/copy && git -C $P archive HEAD | tar -x -C $S/copy && cd $S/copy && TMPDIR=$S/tmp node scripts/build-plugin.mjs --check` (exit 0), then in `$S/copy`, each node call with `TMPDIR=$S/tmp`: `mkdir -p .claude/skills/route/results && echo v1 > .claude/skills/route/results/notes.md && echo v1 > evals/results; node scripts/build-plugin.mjs; echo v2 > .claude/skills/route/results/notes.md; echo v2 > evals/results; node scripts/build-plugin.mjs --check`. Observed:
  ```
  dist/plugin and dist/dashboard are up to date
  check after changing two sources named results: exit 0
  v1            (dist/plugin/skills/route/results/notes.md, stale)
  ```
- expected (source): `build-plugin.mjs:177` "`claude plugin eval` writes its reports to dist/plugin/evals/results ...: not part of the build" (one path), CHANGELOG 1.2.0 line 229.
- fix scope: drop the `-x` and delete `evals/results` from the temp build only, or compare with a file walk that skips exactly `plugin/evals/results`; a case in `src/build-plugin.test.mjs`.
- confidence: 90

### W-8: docs/native-mode.md says the eval suite has not been smoke-run

- kind: docs-drift
- severity: low
- where: `docs/native-mode.md:324`.
- what happens: by reading. `docs/native-mode.md:324`: "The eval suite (`npm run eval`, `evals/`) has not been smoke-run: in an isolated worktree a guard read `claude plugin eval` as the shell's `eval` and refused it, so the first run is left to the user." README.md:416: "The eval suite (`npm run eval`) was smoke-run on 2026-11-10, bounded to `t2-single`, one run, twice, about $0.37 each". CLAUDE.md (Commands): "Smoke-run on 2026-11-10 ... it runs end to end; 4 of 7 graders pass".
- expected (source): README.md:416 and CLAUDE.md are right (they cite `docs/research-2026-11-10.md`); native-mode.md is stale.
- fix scope: `docs/native-mode.md:324` (copy README's sentence).
- confidence: 90

### W-9: The skill gate's home-path pattern needs a trailing slash

- kind: improvement
- severity: low
- where: `.claude/hooks/skill-gate.mjs:71` (and the same shape at 73).
- what happens: a home path that ends the word, such as `cd /Users/alice`, `HOME=/home/bob` or `see /home/bob.`, passes; Windows `C:\Users\alice\` passes too. Each names a person's account. Documented scope is `/Users/<user>/` with the slash (`skill-gate.mjs:26`, `docs/skills.md:67`), so this widens the check rather than fixing a broken promise.
- reproduction: the regex copied from line 71 in `node -e`. Observed:
  ```
  "cd /Users/alice/notes" -> flagged
  "cd /Users/alice" -> passes
  "see /home/bob." -> passes
  "HOME=/home/bob" -> passes
  "C:\\Users\\alice\\notes" -> passes
  ```
- expected (source): `docs/skills.md:67` "No secret or personal detail in the skill's files" (the purpose).
- fix scope: end the user segment with `(?:\/|\b)` (keep `/Users/Shared` excused), add `[A-Za-z]:\\Users\\[^\\\s]+`; tests in `src/skill-gate.test.mjs`; `docs/skills.md:67`.
- confidence: 85

### W-10: Skill hints by goal words picked two unrelated skills for this audit's launch

- kind: improvement
- severity: low
- where: `.claude/hooks/skill-hint.mjs:245-274` (step 3, the brief's words against skill names and descriptions) and the bugfix rule at 148/167.
- what happens: the plan check appended to this slice's own launch (an audit of scripts and hooks, no `KIND: bugfix`): `konnected-product-rules (goal_match)`, `diagnosing-bugs (bugfix)` and `anthropic-skills:built-in-browser (goal_match)`. Two of the three have nothing to do with the slice; the bugfix pick comes from bug words in an audit brief.
- reproduction: the plan check ran on this slice's launch; its output is the "Suggested skills (plan check)" block of this slice's brief (quoted above). Not re-run here: re-running needs the live skill catalog under `~/.claude`.
- expected (source): `.claude/rules/agents.md` (skill suggestions): skills "chosen from the file types in FILES or SOURCES, the role and the goal's words"; a suggestion is meant to fit the slice.
- fix scope: raise the minimum goal score or require a name hit for `goal_match`, and do not count bug words in a brief whose FILES are only `.md` outputs; `src/skills.test.mjs`.
- confidence: 50

## Unproven

- `orchestrate.sh` on SIGTERM to its own pid: the launcher exits 143 and its EXIT trap removes the temp stream (checked with `$S/sigtest.sh`, TERM and HUP), but the `claude` child is not signalled and may keep running unattended. Not checked whether the fake child outlived the launcher. (SIGINT in that script was ignored because a background job of a non-interactive shell ignores SIGINT: a test artifact, not a finding.)
- `scripts/run-tests.mjs:32-36`: on a signal it kills only the `sh -c` child and removes the temp root at once; test workers may outlive it and write into a removed folder. Not run (it would run the suites).
- `skill-catalog.mjs:252-254`: a failed `renameSync` leaves `skill-catalog.json.<pid>.tmp` behind. Not provoked.
- `auto.sh:74`: the escalated orchestrator inherits a user's `ORCH_MODEL`, which `orchestrate.sh:152` passes as `--model` next to `--agent orchestrator`; whether it overrides the agent's model was not probed.
- `scripts/report.mjs:114`: an anonymous stop key (`\n#0`) could equal a real key with an empty session id and agent id `#0`. Contrived; not run.
