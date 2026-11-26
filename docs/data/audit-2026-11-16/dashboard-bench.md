# Audit 2026-11-16 (HEAD bc1dce8): dashboard, status lines, benchmark and evals

Slice `audit-dash-bench`. A read-only audit. Every reproduction ran under the session scratch folder
`<scratch>/audit/audit-dash-bench/`,
written `$S` below. Set it before re-running a command, for example
`S=<scratch>/audit/audit-dash-bench`.
`$R` is the checkout, `<repo>`.
No model call, no paid run, no hook run against the live project, nothing committed.

## Summary

| id | kind | severity | title | files a fix would touch |
|---|---|---|---|---|
| D-1 | improvement | low | Type errors from `claude plugin validate`: one real root cause (a local `Run` type hides the imported one); the rest are typing noise | dashboard/register.tsx, dashboard/register.test.tsx |
| D-2 | bug | medium | The subagent status line counts attempts across every run in the session, so a reused slice id shows `#2` on its first attempt | .claude/hooks/subagent-statusline.mjs, src/subagent-statusline.test.mjs, dist/plugin (rebuild) |
| D-3 | bug | low | The subagent status line cuts rows by UTF-16 length, so wide characters overflow the row | .claude/hooks/subagent-statusline.mjs, src/subagent-statusline.test.mjs, dist/plugin (rebuild) |
| D-4 | bug | low | The pane reopens a run that the gates closed when a later review of a final slice fails | dashboard/register.tsx (`runOpen`, `sliceRunOf`), .claude/hooks/brief.mjs (`foldRuns`, as the reference), dashboard/register.test.tsx, docs/dashboard.md |
| D-5 | bug | low | statusline.sh prints names through `echo -e`, so a backslash in a folder name cuts the line | statusline/statusline.sh, src/statusline.test.ts |
| D-6 | bug | low | The pane keeps only 80 agent records, so its run model can drop a retry signal and close a run the gates hold | dashboard/register.tsx, dashboard/register.test.tsx, docs/dashboard.md |
| D-7 | docs-drift | low | README's subagent status line example shows a sonnet implementer on a second fresh launch | README.md |
| B-1 | bug | medium | The `all-haiku` and `reader-haiku` arms no longer run a haiku researcher, and the harness cannot make them | bench/arms.mjs, bench/analyze.mjs (`PAIRS`, `READER_PAIRS`), bench/README.md, bench/HYPOTHESES.md, README.md, bench/matrix/compare-040.json, bench/matrix/route-040.json, bench/arms.test.mjs |
| B-2 | known | low | The task graders' raw-path entry guard exits 0 with no output when run through a symlinked path | bench/tasks/h3-sql-engine/score.mjs, bench/tasks/k1-stdlib-toolkit/score.mjs, bench/tasks/k2-stdlib-toolkit-xl/score.mjs |
| B-3 | docs-drift | low | README "Benchmarks" says "six built-in subagents are blocked"; the repo blocks seven and fork | README.md |
| B-4 | bug | low | The claim classifier counts the template line `STATUS: pass or fail` as a pass, unlike the project's STATUS rule | bench/lib/claims.mjs, bench/analyze.test.mjs (or a claims test) |
| E-1 | bug | low | The `test-results.txt` regex graders do not match a coloured node:test summary | evals/{t1-parallel,t2-single,c1-unit-registry,e1-shared-file,e3-constraint-answered,e4-plan-before-build}/graders/results-*.md, their prompt.md |
| E-2 | known | low | `orch-agent-used` on `t2-single` requires an orchestration agent, but the case says the plugin should stay light | evals/t2-single/graders/orch-agent-used.md |

Counts: bug 8 (medium 2, low 6); known 2 (low); docs-drift 2 (low); improvement 1 (low); behaviour-change 0. Total 13.

## Coverage

- dashboard/register.tsx: partial. Read 1-500 (mirror parsers, helpers, triage, nodes), 640-660 (layout `Run`), 735-1210 (run model, timer, every hook). Diffed the mirror against brief.mjs 40-500 and 636-1020 line by line. Not read: 500-640 and 1210-1888 (render and layout arithmetic).
- dashboard/types/index.d.ts: full (95 lines).
- dashboard/register.test.tsx: partial. Read only through the baseline test run (108 pass) and the 17 type errors it reports.
- docs/dashboard.md: partial. Read 1-50, 94, 105-145 (run model, stale, attempts, sign-off) and 196-212 ("Limits"); grepped the rest.
- Mirror parity (brief point 2). The parser half of the mirror (register.tsx 26-291 against brief.mjs 17-453) matches line for line, token for token: header, plan, STATUS, OPEN, answers, GAP, QUOTE, DRAFT and SKILLS-*. No input was found on which the parsers disagree. The divergences are all in the run fold: D-4 (a closed run reopens) and D-6 (the 80-record cap). The documented ones are the stale rule, ORCH_GAP_MIN, the isolated test failure and the validated review in the counts (docs/dashboard.md:205-208).
- statusline/statusline.sh: full.
- .claude/hooks/subagent-statusline.mjs: full.
- src/statusline.test.ts, src/subagent-statusline.test.mjs: not reached (the behaviour was probed directly).
- bench/arms.mjs: full. bench/arms.test.mjs: not reached.
- bench/run.mjs: not reached. bench/lib/run-exec.mjs: partial, 84-261 (process groups, deadline, executeRun). bench/lib/run-core.mjs, bench/lib/sdk.mjs, bench/lib/native-launch.sh, bench/lib/plugin-launch.sh: not reached.
- bench/grade.mjs: partial (grep of its child spawn, 1-60). bench/lib/score.mjs: partial (entry and import path).
- bench/analyze.mjs: partial, 668-767 (paired differences with CR1 SE, pass^k) and 871-911. bench/lib/stats.mjs: full. bench/lib/claims.mjs: full.
- bench/report.mjs: partial (every interpolation, checked with grep for `esc`). bench/charts.mjs: partial (entry guard only). bench/validate.mjs: not reached.
- bench/tasks/*/score.mjs: t2-single read in full; h3, k1 and k2 entry guards read; d1, d2 and d3 not reached.
- bench/matrix/*: not reached (named only through README and HYPOTHESES).
- bench/README.md: partial (arm table 15-30, analysis 80-100, compare-040 and route-040 sections 120-170). bench/HYPOTHESES.md: partial, 100-163 (H14 and route-040).
- bench/*.test.mjs (analyze, charts, grade, run, sdk): not reached.
- evals/: every case's graders listed and compared (grep of pattern, path, input_match and arm). t2-single: case.yaml, prompt.md, scaffold.sh and every grader read in full. Other cases: prompt.md front matter and the test-results line only.
- README.md "Dashboard and status line" (290-305) and "Benchmarks" (310-380): full. Every number checked against docs/data/{route-040-2026-10-31,compare-040-2026-10-31,k2-cap10-nobuiltins,short-k2-2026-10-31}.summary.json. They all match.

## Findings

### D-1: Type errors from `claude plugin validate`: one real root cause, the rest typing noise

- kind: improvement
- severity: low
- where: dashboard/register.tsx:4 and dashboard/register.tsx:646; also 834-835, 912, 1011, 1021-1022, 1106, 1147, 1192; dashboard/register.test.tsx:26-253 and 675-1422
- what happens: The baseline `claude plugin validate` reports 13 warnings in register.tsx and 18 in register.test.tsx. They fall into five groups.
  - (a) Root cause, real. Line 646 declares a layout type `type Run = { text: string; color: string }`. It has the same name as the run model type imported at line 4 (`import type { ..., Run, ... } from '../types'`), which gives TS2440 at 4:46. The local declaration wins in the whole module, so `runOpen(list, plan, run: Run | null, t)` (line 831) and the casts `as Run` (lines 1021-1022) are typed as a text run. That causes TS2339 at 834:53 and 835:19/43, TS2345 at 912 and 1011, and TS2769/TS2352 at 1021-1022. The emitted JS is correct, because types are erased. But the run model code, the part that mirrors the gates, is no longer type-checked. A wrong field name there (for example `run.openedAt` for `run.at`) would pass silently.
  - (b) 1192:46, `"running"` is not assignable to the LogEntry kind. This is noise. At `turn.complete` the status is `reply.status ?? 'done'`, or `'pass'` for a doubted review (lines 1160 and 1164), so it is never `running`.
  - (c) 1106:32, `e.tool === 'Task'` has no overlap with the tool union. This is noise: a dead branch for the old tool name.
  - (d) 1147:15, `outcome` widened to `string`. This is noise: the value is `'answered'` or `'stopped'`.
  - (e) register.test.tsx: TS2322 `{}` to `void` (5 places) and TS2345 `{ text }` missing `wait` and `origin` of `PromptSubmitInput` (12 places). This is test typing noise only.
  The validator also prints "gating hook without .catch" for prompt.submit, agent.spawn and both tool.call hooks. Each wraps its own work in try/catch. Only `next(e)` and the event field reads stay outside, so those warnings are noise too.
- reproduction: by reading the baseline log `$S/../../baseline/dash.log` lines 26-61 (the brief's baseline). The quoted lines: `line 4, column 46: error TS2440: Import declaration conflicts with local declaration of 'Run'.`, `line 834, column 53: error TS2339: Property 'at' does not exist on type 'Run'.`, `line 1192, column 46: error TS2322: Type '"pass" | "fail" | "running" | "done"' is not assignable to type '"pass" | "fail" | "triage" | "done" | "start" | "blocked"'.` Source lines: register.tsx:646 `type Run = { text: string; color: string }`; register.tsx:1160 `const raw: Agent['status'] = reply.status ?? 'done'`.
- expected behaviour, with source: The run model should be checked against `Run` in dashboard/types/index.d.ts ("The run the gates would see ... `{ kind: 'planned' | 'light'; at: number; slice?: string }`"). The lack of typechecking is already known: docs/research-2026-11-10.md:139 "CI still does not run or typecheck the dashboard." and CHANGELOG.md:241. The `Run` shadow is not listed there.
- fix scope: dashboard/register.tsx (rename the layout type, for example `Seg`, at 646-657 and its uses; type `status` at 1192 as `LogEntry['kind']`; drop or cast the `'Task'` compare). dashboard/register.test.tsx (typed fixtures). Run `npm run test-dashboard` and `npm run build-plugin` (dist/plugin, dist/dashboard). brief.mjs is not affected.
- confidence: 95

### D-2: The subagent status line counts attempts across every run in the session

- kind: bug
- severity: medium
- where: .claude/hooks/subagent-statusline.mjs:69-85 (`indexLaunches`) and 103-106
- what happens: The attempt number `#n` counts every implementer launch of the same slice id in the session's whole `journal-launches.jsonl`, whatever the run. Orchestrators reuse ids such as `s1` from one task to the next. So the first implementer of `s1` in a second run of the same session shows `implementer s1 #2`, which reads as a retry that never happened. The pane, by contrast, scopes attempts to its run.
- reproduction: `$S/sl-probe.mjs` builds launch records for two runs (plan review p1, implementer a1 of s1; then plan review p2, implementer a2 of s1) and calls `rowFor` for a2.
  ```
  cd $S && TMPDIR=$S CLAUDE_PROJECT_DIR=$S node sl-probe.mjs
  implementer s1 #2 · opus · 1.2k
  ```
- expected behaviour, with source: subagent-statusline.mjs:63-65 says "the attempt number of each implementer launch (fresh launches of its slice up to and including its time ...)". README.md:294 shows `#2` as the attempt, and the run model (CLAUDE.md "Run scope: a run belongs to one session. It opens at a PLAN REVIEW launch ...") scopes attempts to a run. Counting should restart at each PLAN REVIEW launch without REPLAN. Fresh launches of the slice after the latest such launch are the attempt.
- fix scope: .claude/hooks/subagent-statusline.mjs (`indexLaunches`: reset the per-slice groups at a launch with `isPlanReview` and `replan` null, or reuse `foldRuns` from brief.mjs); src/subagent-statusline.test.mjs (a two-run case); `npm run build-plugin` (dist/plugin settings and hook copy).
- confidence: 90

### D-3: The subagent status line cuts rows by UTF-16 length

- kind: bug
- severity: low
- where: .claude/hooks/subagent-statusline.mjs:121
- what happens: `row.length > columns ? row.slice(0, columns - 1) + "…"` counts UTF-16 code units, not terminal columns. A label in CJK (two columns per character) or with emoji gives a row wider than `columns`. `slice` can also split a surrogate pair. Claude Code then wraps or cuts the row itself.
- reproduction: in `$S/sl-probe.mjs`, `rowFor({ id: "a2", agentType: "implementer", label: "修正 ".repeat(20) }, L, 30)`:
  ```
  cd $S && TMPDIR=$S CLAUDE_PROJECT_DIR=$S node sl-probe.mjs
  "implementer s1 #2 · 修正 修正 修正 …"
  ```
  That is 30 code units, but 20 + 15 + 1 = 36 terminal columns against a limit of 30.
- expected behaviour, with source: The row must fit the "usable row width" (subagent-statusline.mjs:90, `@param {number} [columns] usable row width`).
- fix scope: .claude/hooks/subagent-statusline.mjs (cut by display width, iterating code points, East Asian wide counted 2); src/subagent-statusline.test.mjs; dist/plugin rebuild.
- confidence: 85

### D-4: The pane reopens a run that the gates closed

- kind: bug
- severity: low
- where: dashboard/register.tsx:831-836 (`runOpen`, which recomputes finality on every call) against .claude/hooks/brief.mjs:839-842 and 959-965 (`closeIfDone`: once `run.closed` is true it stays true)
- what happens: Take a planned run whose only slice is final: a sonnet review passed with no doubt signal. The gates close the run for good. If a second review of the slice then fails (a second opinion, or a reviewer launched late), `foldRuns` keeps the run closed (`open: null`). The pane recomputes `sliceRunOf` instead: the latest review is now a fail with 1 attempt, so the slice is not final and `runOpen` returns true. While that lasts, a typed prompt does not start a clean run on the pane (register.tsx:912), and a light-path implementer is not recorded as a new light run (1022), although the gates opened one. This lasts until the 10-minute stale rule or a new plan review.
- reproduction: `$S/runopen-probe.mts` is register.tsx lines 332-336 and 743-837, copied verbatim with only the layout `Run` line removed, plus the same scenario fed to the real `foldRuns`.
  ```
  cd $S && TMPDIR=$S node runopen-probe.mts
  pane runOpen after r1 only: false
  pane runOpen after r2: true
  gates open run after r2: null | run 1 closed: true | s1 final: false
  ```
- expected behaviour, with source: docs/dashboard.md:20 says "It follows the gates' run boundary". .claude/rules/agents.md "Run scope" says the run "closes when every slice is final"; brief.mjs implements the close as permanent (`if (ids.length && ids.every(...final)) run.closed = true`, with no reopen). The documented known gap (docs/dashboard.md:20, "it can call a slice final that the gate still holds") is the opposite direction, so this one is not listed.
- fix scope: dashboard/register.tsx (keep a closed flag in `runAtom` once `runOpen` turns false while nothing runs, as brief.mjs does); dashboard/register.test.tsx (a "late failing review after a final pass" case); docs/dashboard.md "Run boundary". brief.mjs is the reference and is not changed. Rebuild dist/plugin and dist/dashboard.
- confidence: 80

### D-5: statusline.sh prints names through `echo -e`, so a backslash in a folder name cuts the line

- kind: bug
- severity: low
- where: statusline/statusline.sh:89 (`echo -e "${CYAN}[$MODEL]${RESET} 📁 ${DIR##*/}$BRANCH$LINES"`)
- what happens: The folder's base name and the model's display name come straight from the status JSON and go through `echo -e`, which reads backslash escapes in them. A folder named `my\cproj` stops the output at `\c`. The line loses `proj`, the branch and the `+N -M` counts, and its newline. The second line (rate limits and context bar) is then glued onto the first. `\n` or `\t` in a name inserts a line break or a tab. Folder names with a backslash are rare but legal on macOS and Linux.
- reproduction: a non-git scratch folder, JSON with `current_dir` `/x/my\cproj`.
  ```
  mkdir -p $S/slcwd; cd $S/slcwd && printf '%s' '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"/x/my\\cproj"},"context_window":{"used_percentage":42},"cost":{"total_lines_added":3,"total_lines_removed":1}}' | HOME=$S TMPDIR=$S bash $R/statusline/statusline.sh | od -c | head -8
  0000000  033   [   3   6   m   [   O   p   u   s   ] 033   [   0   m
  0000020   📁  **  **  **       m   y 033   [   3   2   m   [   c   t   x
  ```
  After `my` comes the context bar directly: no `proj`, no `+3 -1`, no newline between the two lines.
- expected behaviour, with source: statusline.sh:2 says the line shows "model, folder, git branch and changes, ...", and README.md:296 "model, folder and git branch with the count of changed tracked files and the lines added and removed". Only the colour codes need `-e`. The names should go through `printf '%s'`, or the colour variables should hold real escape bytes (`$'\033[36m'`) and the line should be printed with `printf '%s\n'`.
- fix scope: statusline/statusline.sh (lines 32, 89, 116 and 120); src/statusline.test.ts (a backslash folder case, skipped without jq). The statusline is copied by `npm run install-statusline`; nothing in dist/ carries it.
- confidence: 90

### D-6: The pane keeps only 80 agent records, so its run model can drop a retry signal

- kind: bug
- severity: low
- where: dashboard/register.tsx:1024 (`[...list, agent].slice(-80)`) and 1188 (`[...l, again].slice(-80)`), used by `sliceRunOf` (766-825) and `runOpen` (831-837)
- what happens: The `agents` state keeps the latest 80 records. `sliceRunOf` counts attempts and the `retry` signal from these records. In a large run (many slices, retries, validations and resumes), the oldest implementer stops and failed reviews fall off. A slice that needs an opus review at the gates (an earlier counted fail gives `retry`) then looks final on the pane after a sonnet pass. The pane closes the run (a new prompt starts a clean run, `⇧opus?` disappears) while the review gate still blocks with `opus_review_required`. The cap is not listed in docs/dashboard.md "Limits" (lines 197-212).
- reproduction: `$S/cap80-probe.mts` is the same verbatim copy of register.tsx 332-336 and 743-837 as in D-4. Slice s1: implementer, failing sonnet review, 80 records of other slices, retry implementer, passing sonnet review.
  ```
  cd $S && TMPDIR=$S node cap80-probe.mts 2>&1 | grep -v -i warning
  all records : attempts 2, signals [retry], final false
  last 80 kept: attempts 1, signals [], final true
  ```
- expected behaviour, with source: docs/dashboard.md:20, "A slice is final when ... its latest review passed and its escalation rule is met: the pane shows no doubt signal for it, or an opus review passed". brief.mjs `doubtSignals` (1009) counts `retry` from every review of the slice in the run (`s.reviews.some(...)`), with no cap.
- fix scope: dashboard/register.tsx (keep the per-slice facts `sliceRunOf` needs: attempts, an earlier counted fail, gap keys, in a separate small state; or cap the drawn list only, not the list the run model reads); dashboard/register.test.tsx; docs/dashboard.md "Limits" if a cap stays. brief.mjs is unchanged. Rebuild dist/.
- confidence: 85

### D-7: README's subagent status line example shows a sonnet implementer on a second fresh launch

- kind: docs-drift
- severity: low
- where: README.md:294 ("for example `implementer s2 #2 risky · sonnet · 41.2k (21%) · Running the tests`")
- what happens: Since 1.3.0 the implementer runs on opus, so a `sonnet` implementer row only appears when someone overrides the model. `#n` counts fresh implementer launches (subagent-statusline.mjs:63-65). A SendMessage resume, the second attempt of the retry flow, keeps `#1`, so `#2` is the third attempt, which is a fresh implementer with `model: "opus"`. The example therefore shows a combination the shipped defaults never produce.
- reproduction: by reading. README.md:294, quoted above; .claude/agents/implementer.md:4 `model: opus`; subagent-statusline.mjs:64 "(fresh launches of its slice up to and including its time; a SendMessage resume makes no launch, so it keeps its number)"; .claude/rules/agents.md Retry flow "the second attempt is a `SendMessage` resume ..., the third and last a fresh implementer with `model: "opus"`".
- expected behaviour, with source: The code and the agent files are right. The example should read `implementer s2 #2 risky · opus · ...`.
- fix scope: README.md:294 (and docs/dashboard.md if it repeats the example).
- confidence: 85

### B-1: The `all-haiku` and `reader-haiku` arms no longer run a haiku researcher

- kind: bug
- severity: medium
- where: bench/arms.mjs:15, 19-23, 59, 62 (labels "researcher on haiku (shipped default)" and "researcher on haiku (shipped)") and 75-78 (`runEnv` strips every `ORCH_*`); bench/analyze.mjs:672-677 (`PAIRS`) and 204 (`READER_PAIRS`)
- what happens: Since 1.3.0 the researcher ships on sonnet (`.claude/agents/researcher.md:4 model: sonnet`), and the plan check raises any haiku launch to sonnet unless `ORCH_ALLOW_HAIKU=1`. Neither arm sets a model, and `runEnv` drops any `ORCH_ALLOW_HAIKU` from the caller's environment. Run today:
  - `all-haiku` is identical to `O-mix`, apart from its label.
  - `reader-haiku` runs sonnet researchers, so `reader-haiku` → `reader-sonnet` compares sonnet with sonnet (both are all-researcher sessions).
  - `reader-routed` is now "sonnet researchers plus converted-text notes", because the router only raises a model.
  - `all-haiku` → `all-sonnet` now compares shipped models (opus implementer, sonnet researcher) with everything forced to sonnet, which is a downgrade of the implementer.
  A re-run of `route-040` or `compare-040` would print these arms and pairs under haiku labels, and the H14 and H14-d3 predictions would be judged on a comparison that no longer exists.
- reproduction: `$S/arms-probe.mjs` imports `ARMS` and `runEnv` from bench/arms.mjs.
  ```
  cd $S && TMPDIR=$S node arms-probe.mjs; grep -n "^model" $R/.claude/agents/researcher.md
  all-haiku == O-mix (minus label): true
  reader-haiku env keeps ORCH_ALLOW_HAIKU: false
  reader-haiku ORCH_* keys: ORCH_AGENT,ORCH_MODEL,ORCH_SESSION_PERSISTENCE,ORCH_EXTRA_ALLOWED_TOOLS,ORCH_NO_NUDGE
  4:model: sonnet
  ```
- expected behaviour, with source: CHANGELOG.md:176 says "The researcher (SDK explorer) runs on Sonnet (was Haiku)". CHANGELOG.md:180 says the haiku rule raises "a launch of any of this plugin's agents to sonnet when its model is in the haiku family". An arm labelled haiku should run haiku: it needs `ORCH_ALLOW_HAIKU=1` (kept by `runEnv`) and a haiku researcher (rewrite its `model:` line the way `agentModel` does for O-O). Otherwise the arms and pairs should be renamed or retired. The published results (README.md:322 "`reader-haiku` (shipped)", bench/README.md:22 and 25, bench/HYPOTHESES.md:130) were measured on 0.4.0, when haiku was shipped. They stay valid as history, but "shipped" is now false (docs-drift on the doc side).
- fix scope: bench/arms.mjs (haiku arms: `agentModel`-style rewrite of researcher.md plus `ORCH_ALLOW_HAIKU=1` in `env`, with `runEnv` filtering applied before the arm's env, as it already is; or rename the arms); bench/arms.test.mjs; bench/analyze.mjs `PAIRS`/`READER_PAIRS` labels; bench/README.md arm table; bench/HYPOTHESES.md H14/H14-d3 notes; README.md:322 label; bench/matrix/compare-040.json and route-040.json (arm ids, if renamed).
- confidence: 90

### B-2: The graders' raw-path entry guard exits 0 silently through a symlinked path

- kind: known
- severity: low
- where: bench/tasks/k1-stdlib-toolkit/score.mjs:65, bench/tasks/k2-stdlib-toolkit-xl/score.mjs:87, bench/tasks/h3-sql-engine/score.mjs:71 (`if (process.argv[1] === fileURLToPath(import.meta.url))`)
- what happens: Already listed. CHANGELOG.md:58 says "The three benchmark task graders (`bench/tasks/*/score.mjs`) keep the old entry guard." and .claude/rules/agents.md (1.4.4 entry guards) says "The benchmark graders `bench/tasks/*/score.mjs` still use the old form." New evidence: it does bite on macOS. Started as `node /tmp/.../score.mjs <dir>`, the grader prints nothing and exits 0, which looks like an empty success; the same file through `/private/tmp/...` prints the grade. The harness itself is not affected: `bench/grade.mjs` imports the graders through `bench/lib/score.mjs` (`--score-one` child), so only a person running a grader by hand meets it.
- reproduction: copy of bench/ in scratch, empty workspace.
  ```
  mkdir -p $S/benchcopy $S/emptyrepo; cp -R $R/bench $S/benchcopy/; L=${S#/private}
  TMPDIR=$S node $L/benchcopy/bench/tasks/k1-stdlib-toolkit/score.mjs $S/emptyrepo; echo "exit=$? (symlinked path)"
  TMPDIR=$S node $S/benchcopy/bench/tasks/k1-stdlib-toolkit/score.mjs $S/emptyrepo | cut -c1-160; echo "exit=$? (real path)"
  exit=0 (symlinked path)
  {"pass":false,"passed":0,"total":503,"by_cat":{"toml":[0,124],"shlex":[0,68],"regex":[0,205],"csv":[0,106]},"flags":["missing toolkit/ package"]}
  exit=0 (real path)
  ```
- expected behaviour, with source: .claude/rules/agents.md, 1.4.4 Entry guards: "compares `realpathSync(process.argv[1])` with `realpathSync(fileURLToPath(import.meta.url))`, never the raw strings". bench/analyze.mjs:871-874 already does this.
- fix scope: the three score.mjs files (copy the guard of bench/analyze.mjs:871-875); a test beside bench/grade.test.mjs that runs one grader through a symlinked folder.
- confidence: 95

### B-3: README "Benchmarks" says six built-in subagents are blocked

- kind: docs-drift
- severity: low
- where: README.md:348
- what happens: README.md:348 says "Claude Code's six built-in subagents are blocked in this repository, so a plain session cannot delegate." README.md:130 and CLAUDE.md say seven (since 2.1.325, `web-fetch`) plus fork. The benchmark ran when there were six; the sentence is written in the present tense about the repository.
- reproduction: `grep -n "six built-in\|seven built-in" $R/README.md` gives `130: ... Claude Code's seven built-in subagents (listed in .claude/hooks/builtin-agents.mjs) and fork subagents are denied ...` and `348:Claude Code's six built-in subagents are blocked in this repository ...`.
- expected behaviour, with source: The code is right: `.claude/hooks/builtin-agents.mjs` `BUILTIN_AGENTS`, and CLAUDE.md "Eight agents are blocked". README.md:348 should say "were blocked (six at the time of the campaign)", or seven plus fork.
- fix scope: README.md:348.
- confidence: 90

### B-4: The claim classifier counts the template `STATUS: pass or fail` as a pass

- kind: bug
- severity: low
- where: bench/lib/claims.mjs:35 (`STATUS_LINE = /^[ \t*_#`]*STATUS[ \t*_`]*:[ \t*_`]*(pass|fail)\b/gim`) and 55-56
- what happens: The project's STATUS rule (brief.mjs:19, the same in register.tsx:30) ignores the template line `STATUS: pass or fail`. The classifier reads it as `pass`, so it counts as DONE. A run whose final text echoes the format and says it is unfinished is then classed `partial`, not `failure`.
- reproduction: `$S/claims-probe.mjs`
  ```
  cd $S && TMPDIR=$S CLAUDE_PROJECT_DIR=$S node claims-probe.mjs
  "Reply in this format:\nSTATUS: pass or fail\nThe parser module is not finished yet." -> classifyClaim: partial | brief.mjs parseStatus: null
  "STATUS: pass\nSTATUS: pass or fail" -> classifyClaim: success | brief.mjs parseStatus: pass
  ```
- expected behaviour, with source: .claude/rules/agents.md, STATUS rule: "one rule everywhere ... blockquoted lines, a STATUS in mid-line and the template `STATUS: pass or fail` do not count". claims.mjs:23 calls the line "the worker contract". Only `success` claims feed the false-success count, so the published false-success numbers do not change. The `partial`/`failure` split does.
- fix scope: bench/lib/claims.mjs (add the template lookahead of brief.mjs's STATUS_RE to STATUS_LINE); its tests in bench/analyze.test.mjs.
- confidence: 80

### E-1: The `test-results.txt` regex graders do not match a coloured node:test summary

- kind: bug
- severity: low
- where: evals/t2-single/graders/results-nonempty.md:4 (`pattern: '^(?:#|ℹ) pass [1-9]'`) and results-pass.md:4 (`'^(?:#|ℹ) fail 0\b'`); the same patterns are in t1-parallel, c1-unit-registry, e1-shared-file, e3-constraint-answered and e4-plan-before-build
- what happens: The patterns anchor `#` or `ℹ` at the start of a line. When colour is on (for example `FORCE_COLOR` set by the environment that runs the session), node:test's spec reporter writes `\u001b[34mℹ pass 2\u001b[39m`. The line then starts with an escape sequence and neither grader matches, even though every test passed. Without colour the same work matches. This is a proven fragility. It is not proven to be the cause of the two failures on t2-single in docs/research-2026-11-10.md:136, which lists "a coloured or differently formatted `npm test` output" as one guess. Claude Code's own Bash tool sets no `FORCE_COLOR` here (`env | grep -i color` shows only `COLORTERM=truecolor`), so the cause there remains open (see Unproven).
- reproduction: scaffold t2-single in scratch, a correct duration.js and test, then the prompt's own command under four environments.
  ```
  W=$S/eval-t2; mkdir -p $W; cd $W && bash $R/evals/t2-single/scaffold.sh   # then duration.js + duration.test.js (see $S/eval-t2)
  for v in FORCE_COLOR=1 FORCE_COLOR=0 CI=1 NO_COLOR=1; do env $v HOME=$S TMPDIR=$S npm_config_cache=$S/npmcache npm test > tr-$v.txt 2>&1; node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");console.log(process.argv[1],"nonempty:",/^(?:#|ℹ) pass [1-9]/m.test(t),"pass0:",/^(?:#|ℹ) fail 0\b/m.test(t), JSON.stringify(t.split("\n").find(l=>l.includes("pass"))))' "tr-$v.txt"; done
  tr-FORCE_COLOR=1.txt nonempty: false pass0: false "\u001b[34mℹ pass 2\u001b[39m"
  tr-FORCE_COLOR=0.txt nonempty: true pass0: true "ℹ pass 2"
  tr-CI=1.txt nonempty: true pass0: true "ℹ pass 2"
  tr-NO_COLOR=1.txt nonempty: true pass0: true "ℹ pass 2"
  ```
  (node v24.22.2.)
- expected behaviour, with source: The grader text in results-pass.md says "test-results.txt records a node:test run with zero failures". A run with zero failures should pass whatever the terminal colour.
- fix scope: the results-*.md graders of the six cases (allow an optional SGR prefix: `^(?:\x1b\[[0-9;]*m)?(?:#|ℹ) pass [1-9]`), or the prompts (`NO_COLOR=1 npm test > test-results.txt 2>&1`). Rebuild dist/plugin, which copies evals/.
- confidence: 70 (fragility proven; link to the observed failure not proven)

### E-2: `orch-agent-used` on `t2-single` asks for the agent the case says it should not need

- kind: known
- severity: low
- where: evals/t2-single/graders/orch-agent-used.md:3-5 and evals/t2-single/prompt.md:2 (`description: "... Plugin should stay light."`)
- what happens: Already listed. docs/research-2026-11-10.md:136 says "`orch-agent-used` expects an orchestration agent, and the case's own description says the plugin should stay light there, so in a one-arm run it counts against a correct route." New evidence: the CLI help explains why it is scored at all. `claude plugin eval --help` says graders marked `with-only` are an indicator rather than score only "under with-without". The documented bounded command (`--ablation none`) therefore scores it, so it fails every correct light route. The same `orch-agent-used` grader is in c1, d1, e1 and t1, where an orchestration agent is expected, so only t2-single has the contradiction.
- reproduction: `cd $S && timeout 20 claude plugin eval --help` (help text only, no run), whose `--ablation` paragraph says "under with-without, graders marked with-only, incl. `tool_used: Skill`, are a plugin-fired indicator rather than part of the score". CLAUDE.md "Bounded: `npm run eval -- --case t2-single --runs 1 --ablation none --max-cost-usd 2`".
- expected behaviour, with source: the case description "Plugin should stay light". Fix idea: drop `orch-agent-used` from t2-single, or invert it (a light route uses no orchestration agent).
- fix scope: evals/t2-single/graders/orch-agent-used.md; dist/plugin/evals (rebuild); docs/research-2026-11-10.md "Open".
- confidence: 85

## Unproven

- t2-single `results-nonempty` and `results-pass`, the cause. Ruled out by running: the plain node:test output format (it matches), `CI=1` and `NO_COLOR=1`. The scaffold runs, because `npm run eval` passes `--scaffold` (package.json:30). Still open: `FORCE_COLOR` or a TTY-like stdout inside the eval sandbox (it would explain both failures, see E-1); `npm test` failing inside the eval's OS sandbox (an npm log or child-process denial would give `ℹ fail 1`, which also fails both); or the eval's regex engine ignoring `flags: m` (with the npm banner first, `^` would then never match). Each needs one `--keep-temp` eval run, which is paid.
- bench `launch()` (bench/lib/run-exec.mjs:183) waits for `close`, not `exit`. A grandchild that keeps the run's stdout open would hold the row until the deadline and record `end_reason: "deadline"` with exit code 0. Not run, and claude's Bash children do not inherit its stdout, so it may not occur in practice.
- subagent-statusline.mjs reads the whole `journal-launches.jsonl` on every refresh tick, and the log is never cleared (CLAUDE.md 1.4.4). The cost grows with the project's history. Not measured.
