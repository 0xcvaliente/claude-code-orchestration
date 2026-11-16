# Docs rewrite plan (slice docs-outline, 2026-11-16)

The working plan for the writers who rewrite README.md, bench/README.md and the reference pages in docs/. Every writer follows part A, writes the pages of part B, moves content as part C says, applies the facts of part D, keeps the strings of part E, and builds README.md from part F. Terms: [docs/glossary.md](../../glossary.md). Index: [docs/README.md](../../README.md).

Base of this plan: branch `audit-1.4.6` at `2e28cb7`, version 1.4.5 in `package.json`.

## A. Readers and writing rules

### Readers

| Reader | Knows | Wants | Pages |
|---|---|---|---|
| Newcomer | Claude Code; has never seen this repo | What it does, how to install, what to type, what it costs and where it stops | README.md, docs/README.md, docs/glossary.md, docs/native-mode.md, docs/safety.md, docs/native-vs-plugin.md |
| Maintainer | The repo; changes hooks, agents or scripts | The exact rule, the file that holds it, the switch, the limit | docs/gates.md, docs/settings.md, docs/logs.md, docs/brief-grammar.md, docs/bash-judge.md, docs/skills.md, docs/dashboard.md, docs/sdk-pipeline.md, docs/development.md, docs/claude-code-updates.md, bench/README.md |

### Rules for every writer

1. Lead with what a thing does and what to type. The mechanism comes after.
2. Short sentences: aim for 20 words or fewer. Common words. Active voice. One idea per sentence.
3. One term for one thing: the glossary's term. Link the term to the glossary at its first use on a page.
4. Open each page with two or three lines: what it covers and who needs it.
5. Commands go in code blocks. Each command gets a comment or a line saying what it does or prints.
6. Tables for settings and switches. Numbered lists for steps. Bullets nest at most two levels.
7. Exact rules stay exact: the brief grammar, the judge's rules, gate reasons, thresholds. Write plain words around them; never change their meaning. Where a test pins a wording (part E), that wording stays.
8. No history in reference pages. Say what the code does now. Versions belong in CHANGELOG.md. Exception: behaviour that differs by the installed Claude Code version (for example a built-in subagent that Claude Code 2.1.325 added; never name it, see rule 14). Dated evidence ("Checked live on 2026-11-14") is not history and may stay under a "Checked live" heading.
9. Drop version tags from headings: `### Guards (0.4.0)` becomes `### Researcher guard`. Old anchors are linked from other pages: fix every link you break (grep for `#` anchors of your page).
10. Every limit goes in a "Limits" part of the page it belongs to, stated plainly. docs/safety.md links to each one; it does not copy them.
11. No fact without a source. No number from memory: copy it from the code, a test or the page that has it. When two sources disagree, the code wins; part D lists every known case.
12. No filler words ("simply", "just", "note that", "it is worth"). No sales words ("powerful", "seamless", "robust").
13. Switch names (`ORCH_*`) appear only in maintainer text: these docs, CLAUDE.md, `.claude/rules/agents.md`, hook comments. Never in agent bodies, skills or the nudge (pinned by `src/contracts.test.ts`).
14. Built-in agent names appear only in `.claude/hooks/builtin-agents.mjs`. Docs point to `BUILTIN_AGENTS` there (CLAUDE.md, 1.2.2). Say "seven built-in subagents" only with that pointer.
15. Do not edit dated records: docs/research-*.md, docs/benchmark-*.md, docs/benchmarks.md, docs/data/**, released CHANGELOG entries.
16. Use for your own pages exactly the page names and headings that part C names as targets, so that the links other writers write resolve. If you must change such a heading, keep going and name the old and new heading in your reply for the editor.

### Preferred terms (the full list is the glossary)

| Use | Not |
|---|---|
| orchestrate route | the pipeline (for the route) |
| SDK pipeline | the pipeline, the TypeScript pipeline (for `src/`) |
| worker | subagent, agent (when it means our researcher, implementer, reviewer or integrator) |
| reply (a worker's final message) | report, hand-back message |
| final report (the orchestrator's message to the person) | summary, answer |
| escalation (a failed plain or reviewed run reruns on the orchestrate route) | (keep for this only) |
| opus review (the review a doubt signal requires) | escalation, opus escalation |
| pane | dashboard, live dashboard, orchestration pane (the folder `dashboard/` keeps its name) |
| gated workflow | scripted flow, the workflow (on first use) |
| skill suggestions | skill hints |
| report check | hand-back check |
| stalled slice | stall (alone) |

### Before and after (README.md lines 68)

Before:

> The dashed arrow is **escalation**: if a triaged plain or reviewed run fails its checks, the task reruns through the pipeline. The failed attempt's edits stay in your folder, uncommitted in git, and are never reverted. For code in git the pipeline's worktrees only see committed work, so they do not see those edits. `ORCH_NO_ESCALATE=1` (SDK: `--no-escalate`) turns it off, and a forced mode never escalates.

After:

> **Escalation.** When a plain or reviewed run fails its checks, the task runs again on the orchestrate route.
> - The failed run's edits stay in your folder. Nothing reverts them and nothing commits them.
> - In git, the new run's worktrees start from your last commit, so they do not see those edits.
> - To turn escalation off, set `ORCH_NO_ESCALATE=1` (SDK pipeline: `--no-escalate`). A route you force never escalates.

## B. Pages after the rewrite

"New" pages do not exist yet. Lengths are targets, not limits, except README.md (at most 150 lines).

| Path | Purpose | Reader | Target length | Built from (today's sections) |
|---|---|---|---|---|
| README.md | Front door: what it is, install, first run, routes, triage, links | Newcomer | at most 150 lines | README Install and quick start, The three routes, Choosing a route (triage), What Claude Code ships, Development |
| docs/README.md (new) | Index of every page | Both | about 60 lines | new |
| docs/glossary.md (new) | Every term, defined once | Both | about 250 lines | new, checked against code |
| docs/native-mode.md | How a task runs: roles, light and full path, plan review, retries, parallel slices, headless runs, the gated workflow, the plugin | Newcomer, then maintainer | about 350 lines | native-mode Agents, Light path, Parallel slices, Headless, Scripted flow, Live checks, Plugin build; README The pipeline, The roles, The gated workflow, The plugin |
| docs/gates.md (new) | Every gate and guard: what it blocks, reason codes, loop guards, doubt signals, the test gate's details | Maintainer | about 400 lines | README The gates, Gate details, How a worker launch is shaped; native-mode Gates, Guards, Quote check, Gap cutoff, Test baseline, Bugfix check, Worker launch |
| docs/settings.md (new) | Every switch, plugin setting and environment variable, with default and effect | Maintainer | about 200 lines | README Switches and plugin settings, Reference/Environment; native-mode Switches and plugin settings |
| docs/logs.md (new) | Where logs go, what each log holds, telemetry, read log, the run report, headless run results | Maintainer | about 150 lines | README Telemetry and the read log; native-mode state-dir paragraph, Telemetry v2, Live checks (run log) |
| docs/safety.md (new) | What protects what (deny lists, judge, guards, sandbox, worktrees), what does not, and a link to each page's Limits | Both | about 120 lines | README Safety, Known limitations (as links) |
| docs/sdk-pipeline.md (new) | The frozen SDK pipeline: commands, flags, environment, outputs, its Bash judge in short | Maintainer | about 150 lines | README SDK pipeline, Bash judge (SDK workers), CLI flags, SDK rows of Environment |
| docs/development.md (new) | For contributors: npm scripts, repository layout, rules, plugin build, eval suite, diagrams | Maintainer | about 150 lines | README npm scripts, Repository layout, Development; native-mode Project context, Optional TypeScript code intelligence, Plugin build |
| docs/brief-grammar.md | Exact spec of brief lines, reply lines and the run model | Maintainer | about 320 lines (adds one lines-at-a-glance table) | itself; README Briefs and replies |
| docs/bash-judge.md | The Bash judge: classes, decision, fail-closed, limits, native hook | Maintainer | about 440 lines | itself |
| docs/dashboard.md | The pane and the two status lines | Both | about 240 lines | itself; README Dashboard and status line |
| docs/skills.md | Using installed skills, creating and publishing a skill | Maintainer | about 130 lines | itself; README skill suggestions, Creating a skill |
| docs/claude-code-updates.md | What to run after a Claude Code update and why | Maintainer | about 70 lines | itself; README After a Claude Code update |
| docs/native-vs-plugin.md | What Claude Code ships against what this plugin adds, area by area | Newcomer deciding | about 125 lines | itself; README What Claude Code ships vs what this adds |
| bench/README.md | The benchmark harness, the eval suite, and every campaign's result in short | Maintainer | about 280 lines | itself; README Benchmarks (all five campaigns), the eval line of Known limitations |
| docs/research-2026-11-16.md (new, record) | The 2026-11-16 audit: scope, every finding with its status (fixed by which slice, or open), what stays unproven, the live checks of the day | Maintainer | about 250 lines | docs/data/audit-2026-11-16/ (six findings files, every fix-notes file, this plan) |

What goes into docs/research-2026-11-16.md:
- One line per finding id (G-1 to G-15, T-1 to T-13, J-1 to J-15, S-1, S-2, W-1 to W-10, D-1 to D-7, B-1 to B-4, E-1, E-2, O-1 to O-11): title, kind, severity, status (fixed in slice `fix-...`, docs-only, or open), link to the findings file.
- The "Unproven" items of each findings file, as open.
- Every limit the fix-notes name (the D lines with source `fix-notes-*`), grouped by area.
- The two live checks of part D, "Later items" (link to docs/data/live-checks-2026-11-16.md once recorded).
- The test-gate load fix (from fix-notes-gate-load.md, once it exists).
- It is a dated record: written once, then not edited.

Who writes what (each writer owns only its pages; part C names their headings):

| Writer | Pages |
|---|---|
| 1 | README.md, docs/native-mode.md, docs/native-vs-plugin.md, docs/development.md |
| 2 | docs/gates.md, docs/settings.md, docs/logs.md |
| 3 | docs/bash-judge.md, docs/safety.md, docs/sdk-pipeline.md |
| 4 | docs/dashboard.md, docs/skills.md, docs/claude-code-updates.md, bench/README.md |
| 5 | docs/brief-grammar.md, docs/research-2026-11-16.md, the fact changes in CLAUDE.md and .claude/rules/agents.md (part D), and the two live checks appended to docs/data/live-checks-2026-11-16.md (part D, "Later items") |
| Editor (after all five) | Every page, docs/README.md and docs/glossary.md: terms, links and repetition |

Records (unchanged, listed in the index): CHANGELOG.md (released entries), docs/research-2026-10-31.md, docs/research-2026-11-10.md, docs/benchmark-*.md, docs/benchmarks.md, docs/data/**, bench/HYPOTHESES.md.

Decision on docs/benchmarks.md: a dated record. Its first line says "Generated by bench/report.mjs from lite, lite-k2, sweeps on 2026-10-15; do not edit by hand", and it reports three campaigns of that day. No edits.

## C. Content map

Every `##` and `###` heading of the nine pages (and the two `####` of native-mode.md). "cut" means the content repeats the named place. Line numbers are of `2e28cb7`.

### README.md (33 headings)

| Line | Heading | Goes to |
|---|---|---|
| 5 | Contents | cut: repeats the page's headings; the short README needs no contents list |
| 13 | Install and quick start | README "Install" (plugin commands, the two settings, `/reload-plugins`) and "First run" (commands); sandbox advice: docs/safety.md "Sandbox"; checkout commands also docs/native-mode.md "Headless runs"; dash-led task note: docs/native-mode.md "Headless runs" (fact changed, part D); default agent: docs/native-mode.md "Default agent of this repo"; workflow start: docs/native-mode.md "The gated workflow"; releases line: README "Development" |
| 51 | The three routes | README "The three routes" (table); reviewer detail: docs/native-mode.md "The reviewed route"; escalation: README "The three routes" (part A example) and docs/native-mode.md "Escalation" |
| 70 | Choosing a route (triage) | README same heading (pinned, part E); `routes.jsonl` locations: docs/logs.md "Log files"; why `minParallelFilesCode` is 10: bench/README.md "Results: why a router" |
| 91 | The pipeline | docs/native-mode.md "The orchestrate route" (pipeline diagram, the "why each step" bullets, the slice-life diagram); light path sentence: "Light path and full path"; parallel sentence: "Parallel slices" |
| 118 | The roles | docs/native-mode.md "Roles" (one table, merged with native-mode "Agents") |
| 132 | The gates | docs/gates.md "Gates at a glance" (diagram, table), "Review gate" (reasons in code order), "Doubt signals", "Loop guards", "Run scope" (summary; the exact rule stays in docs/brief-grammar.md "Run model") |
| 161 | Gate details | docs/gates.md "Gap cutoff", "Stall gate", "Test baseline", "Bugfix check", "Quote check", "Researcher guard", "Egress guard", "Report check", "Context after compaction", "Test gate" (prose-skip paragraph); validation before a retry and opus on the third attempt: docs/native-mode.md "Retries"; native judge bullet: docs/bash-judge.md "Native hook"; hand-back capture: docs/logs.md "Hand-back capture" |
| 177 | After a Claude Code update | docs/claude-code-updates.md "The check" (cut as repeat); README "Install" keeps one link line |
| 188 | How a worker launch is shaped | docs/gates.md "Plan check: how it changes a launch" (diagram, no-haiku rule, coverage note, read router); skill suggestions: docs/skills.md "Suggestions"; "Creating a skill": docs/skills.md "Creating a skill" (repeat); workflow agents paragraph: docs/native-mode.md "The gated workflow" and docs/gates.md "Limits" |
| 206 | Telemetry and the read log | docs/logs.md "Telemetry", "Read log", "File trail", "Run report", "Where logs go"; turn warning: docs/gates.md "Turn warning" |
| 216 | Briefs and replies | docs/brief-grammar.md "Lines at a glance" (new table, from this one) and "Reply" (STATUS rule, repeat) |
| 238 | Switches and plugin settings | docs/settings.md "Plugin settings" |
| 267 | The gated workflow | docs/native-mode.md "The gated workflow" |
| 282 | The plugin | docs/native-mode.md "The plugin" (what it carries, the nudge); headless agents in any folder: docs/native-mode.md "Headless runs"; "Building": docs/development.md "Build the plugin" |
| 290 | Dashboard and status line | docs/dashboard.md "Opening it" (repeat) and new "Status lines" (subagent status line, `statusline.sh`, its install) |
| 306 | What Claude Code ships vs what this adds | README "What it adds" (three lines); docs/native-vs-plugin.md intro (repeat); research link: docs/native-vs-plugin.md intro |
| 310 | Benchmarks | bench/README.md "Results" (intro: direction only, verdict rules link) |
| 314 | Read router benchmark (route-040) | bench/README.md "Read router benchmark (route-040)" (repeat; merge the two bullet lists) |
| 328 | Comparison run for 0.4.0 (compare-040) | bench/README.md "Comparison run for 0.4.0 (compare-040)" (repeat; merge) |
| 346 | Benchmark: orchestrator vs plain sessions, built-in subagents blocked | bench/README.md new "Results: built-in subagents blocked" |
| 371 | 0.3.0 short run | bench/README.md "Short documentation run" (add the result table) |
| 383 | Why a router | bench/README.md new "Results: why a router"; README "What it adds" keeps one sentence |
| 400 | Known limitations | each line to the Limits part of its page (list below); docs/safety.md "Limits by page" links them |
| 422 | Safety | docs/safety.md |
| 432 | SDK pipeline | docs/sdk-pipeline.md "What it is", "Run it", "What a run writes" |
| 445 | Bash judge (SDK workers) | docs/sdk-pipeline.md "Bash judge" (short); docs/bash-judge.md (long, repeat) |
| 449 | Reference | cut: a grouping heading; its children are mapped below |
| 451 | CLI flags (`npm start -- ...`) | docs/sdk-pipeline.md "Flags" |
| 470 | Environment | docs/settings.md "Environment variables"; SDK rows: docs/sdk-pipeline.md "Environment"; runner detection paragraph: docs/gates.md "Runner detection" |
| 501 | npm scripts | docs/development.md "npm scripts" |
| 520 | Repository layout | docs/development.md "Repository layout" |
| 554 | Development | README "Development" (two commands); docs/development.md "Contributor rules", "Diagrams" |

README "Known limitations", line by line:
- 404 benchmarks small: bench/README.md "Results" intro.
- 405 read router opt-in, one benchmark, `hard_pages: 0`, workflow researchers not routed: docs/gates.md "Limits".
- 406 validation and opus third attempt are prompt rules: docs/native-mode.md "Limits".
- 407 stall gate native only: docs/gates.md "Limits".
- 408 baseline `allow` heuristic: docs/gates.md "Limits".
- 409 quote check trusts the read cache, cannot check a scan value: docs/gates.md "Limits".
- 410 egress guard reads planned files from the shared tree: docs/gates.md "Limits".
- 411 overlap rule does not see every name of one file: docs/gates.md "Limits".
- 412 skill catalog misses `--plugin-dir` plugins and bundled skills: docs/skills.md "Limits".
- 413 headless runs keep no transcripts: docs/logs.md "Limits".
- 414 no WorktreeCreate hook, settings load from the start folder: docs/native-mode.md "Limits".
- 415 teammate keeps the review gate deferring; overlap and cycle never give up: docs/gates.md "Limits".
- 416 eval suite smoke run: bench/README.md new "Plugin eval suite".
- 417 hand-back capture of a refused report: closed by G-14 (part D, docs/logs.md); not a limit any more.
- 418 workflow overlap check coarser: docs/native-mode.md "Limits".
- 419 dash-led task fails: closed by W-4 (part D); not a limit any more.
- 420 pane stale after 10 minutes: docs/dashboard.md "Limits" (repeat).

### docs/native-mode.md (25 headings, plus 2 at level 4)

| Line | Heading | Goes to |
|---|---|---|
| 11 | Agents | docs/native-mode.md "Roles" (merged with README "The roles"); rules for agent files: docs/development.md "Contributor rules" |
| 33 | Light path and full path | docs/native-mode.md "Light path and full path"; the five facts: README "Choosing a route (triage)" (repeat) |
| 37 | Gates | docs/gates.md: sequence diagram to "Gates at a glance"; table rows to "Test gate", "Review gate", "Plan check", "Report check", "Researcher guard", "Egress guard", "Quote check", "Turn warning", "Context after compaction", "Nudge" (one line, link native-mode "The plugin"); journal and telemetry rows: docs/logs.md; judge row: docs/bash-judge.md "Native hook"; "Run scope": docs/gates.md "Run scope" and docs/brief-grammar.md "Run model" (repeat); "Constraints, escalation and one replan": docs/native-mode.md "Plan review and the constraints ledger", "Retries"; "When the test gate runs": docs/gates.md "Test gate"; "Runner detection": docs/gates.md "Runner detection"; "Isolated worktrees": docs/gates.md "Test gate in worktrees"; state dir paragraph: docs/logs.md "Where logs go" |
| 111 | What 0.4.0 adds | cut: a version heading; its intro links go to docs/native-vs-plugin.md intro |
| 115 | Brief and reply lines (0.4.0) | docs/brief-grammar.md "Lines at a glance" (repeat) |
| 128 | Switches and plugin settings (0.4.0) | docs/settings.md "Plugin settings" (repeat of README's table; one table) |
| 157 | Worker launch: read router and skill suggestions (0.4.0) | docs/gates.md "Plan check: how it changes a launch" |
| 166 | #### Read router (0.4.0, opt-in) | docs/gates.md "Read router"; its benchmark sentence: bench/README.md "Read router benchmark (route-040)" (repeat) |
| 182 | #### Skill suggestions (0.4.0) | docs/skills.md "Suggestions" |
| 188 | Guards (0.4.0) | docs/gates.md "Researcher guard", "Egress guard"; sandbox advice: docs/safety.md "Sandbox" |
| 195 | Quote check (0.4.0) | docs/gates.md "Quote check" |
| 199 | Gap cutoff and the stall gate (0.4.0) | docs/gates.md "Gap cutoff", "Stall gate" |
| 204 | Test baseline (0.4.0) | docs/gates.md "Test baseline" |
| 214 | Bugfix check (0.4.0) | docs/gates.md "Bugfix check" |
| 218 | Telemetry v2 and the read log (0.4.0) | docs/logs.md "Telemetry", "File trail", "Read log", "Run report" |
| 225 | The scripted workflow in 0.4.0 | docs/native-mode.md "The gated workflow" (arguments, how it differs) |
| 233 | Parallel slices | docs/native-mode.md "Parallel slices" |
| 244 | Headless, CI and unattended | docs/native-mode.md "Headless runs"; variables: docs/settings.md "Environment variables"; `runs.jsonl` and report: docs/logs.md |
| 257 | What the first headless runs taught | docs/native-mode.md "Checked live" (dated evidence: one rule per allowlist element; `cd` plus `git` refused, so agents use `git -C`) |
| 265 | Scripted flow: the gated workflow (0.3.0) | docs/native-mode.md "The gated workflow" |
| 286 | Native Bash judge hook (0.3.0, opt-in) | docs/bash-judge.md "Native hook" (repeat); docs/safety.md one line |
| 298 | Verified in a live run (2026-10-13) | docs/native-mode.md "Checked live" |
| 304 | Live checks (2026-10-31) | docs/native-mode.md "Checked live" (Checks A, B, C, E, F, G in one line each); run log totals: docs/logs.md "Headless run results" |
| 317 | Known limitations | split: teammate, overlap, `subagent_type` missing, fallback pairing, stall gate, baseline, quote cache, path identity, egress, read router, `hard_pages`: docs/gates.md "Limits"; `baseRef` start folder, WorktreeCreate, workflow agent names, workflow researchers: docs/native-mode.md "Limits"; eval suite: bench/README.md "Plugin eval suite" (fact changed, W-8); skill catalog: docs/skills.md "Limits"; headless transcripts: docs/logs.md "Limits"; pane stale: docs/dashboard.md "Limits" |
| 339 | Project context | docs/development.md "Contributor rules" |
| 343 | Optional: TypeScript code intelligence | docs/development.md "Optional: TypeScript code intelligence" |
| 353 | Plugin build | docs/development.md "Build the plugin"; what the plugin carries: docs/native-mode.md "The plugin" |

### docs/native-vs-plugin.md (13 headings)

The page stays; each heading keeps its place. Drop the version tags.

| Line | Heading | Goes to |
|---|---|---|
| 9 | Background agents and the review gate | same page, same heading |
| 18 | Scripted workflows and runs | same page, same heading (resume fact, part D) |
| 27 | Fork subagents, built-ins and role limits | same page, same heading (built-in count, part D) |
| 36 | Verification: constraints, review and escalation | same page, "Verification: constraints, review and opus review" |
| 45 | Routing cost | same page, same heading |
| 54 | Pushes, deletes and auto mode | same page, same heading |
| 63 | What a plugin can configure | same page, same heading (setting count, part D) |
| 72 | Reading documents and choosing the reading model (0.4.0) | same page, without "(0.4.0)" |
| 81 | Skills (0.4.0) | same page, "Skills" |
| 90 | Context after compaction (0.4.0) | same page, "Context after compaction" |
| 99 | Role guards and outbound access (0.4.0) | same page, "Role guards and outbound access" |
| 108 | Cost per role (0.4.0) | same page, "Cost per role" |
| 117 | Evaluation | same page, same heading (smoke-run fact, part D) |

### docs/bash-judge.md (27 headings)

The page stays; numbering stays. Plain words around the tables; rows unchanged.

| Line | Heading | Goes to |
|---|---|---|
| 7 | 1 What it is, and why | same page, same heading; the scope line changes (part D) |
| 27 | 2 The three classes | same |
| 37 | 2.1 `deny` rules | same; rows unchanged; the paragraphs after the table split into "Refused since the 2026-11-16 audit" and "Relaxed" sub-parts, history wording ("new in 1.4.5") removed, rows kept |
| 83 | 2.2 `judge` rules | same |
| 102 | 2.3 `pass` examples | same |
| 116 | 2.4 The tokenizer in plain words | same |
| 129 | 2.5 The exec-env rule | same |
| 139 | 3 How the judge decides | same |
| 143 | 3.1 The order inside `judgeBash` | same |
| 153 | 3.2 The prompt | same |
| 178 | 3.3 The authority rule (both policies) | same |
| 182 | 3.4 `RM_POLICY` in words | same |
| 188 | 3.5 `JUDGE_POLICY` in words (git) | same |
| 194 | 3.6 The answer | same |
| 198 | 3.7 The model | same |
| 202 | 3.8 The cache | same |
| 206 | 4 Fail closed | same |
| 232 | 5 What a refusal looks like to a worker | same |
| 251 | 6 Configuration | same; docs/settings.md links here for the SDK judge variables |
| 263 | 7 The audit log | same |
| 302 | 8 Resume | same |
| 314 | 9 The OS sandbox (opt-in) | same |
| 348 | 10 Cost and behaviour | same |
| 354 | 11 Limits | same |
| 390 | 12 How it was tested | same (the 2026-10-22 history list stays as dated evidence) |
| 405 | 13 Changing the policy | same |
| 419 | Native hook (0.3.0) | same page, "Native hook" (store location changed, part D) |

### docs/dashboard.md (11 headings)

| Line | Heading | Goes to |
|---|---|---|
| 5 | Opening it | same |
| 15 | Run boundary | same |
| 33 | Scrolling and resizing | same |
| 38 | Sections, top to bottom | same |
| 129 | Loop-back connectors | same |
| 142 | Sign-off | same |
| 151 | Glyphs and colours | same |
| 175 | Where the data comes from | same |
| 185 | The route tool | same |
| 193 | Loading it | same |
| 200 | Limits | same |
| (new) | Status lines | from README "Dashboard and status line" (subagent status line, `statusline.sh`, install) |

### docs/skills.md (13 headings)

| Line | Heading | Goes to |
|---|---|---|
| 5 | Using installed skills | same; its "Suggestions" bullet grows into a "Suggestions" part with the detail from native-mode line 184 |
| 14 | Creating a skill | same |
| 18 | The eight steps and who does each | same |
| 33 | Brief lines | same (exact grammar stays in docs/brief-grammar.md) |
| 39 | What the plan check does | same |
| 53 | The draft worktree | same |
| 57 | The seal | same |
| 61 | The skill gate | same |
| 76 | Publishing | same |
| 91 | Monitoring | same |
| 95 | Switches | same page, one line linking docs/settings.md (the table moves there: repeat) |
| 107 | Checked live | same |
| 115 | Limits | same |

### docs/claude-code-updates.md (5 headings)

| Line | Heading | Goes to |
|---|---|---|
| 5 | What happened on 2026-11-14 | same (dated, and about Claude Code versions: allowed by rule A8) |
| 16 | The check | same |
| 38 | How the built-in list is read | same |
| 44 | What `--fix` and `--write-source` change | same |
| 55 | What the repo relies on | same |

### docs/brief-grammar.md (16 headings)

Exact rules unchanged. Add one table at the top ("Lines at a glance", from README "Briefs and replies"). Drop version tags from headings.

| Line | Heading | Goes to |
|---|---|---|
| 7 | Line rule | same |
| 13 | Implementer brief | same |
| 28 | Optional brief lines (0.4.0) | same page, "Optional brief lines" (stale sentence, part D) |
| 50 | Skill slice lines | same |
| 78 | PLAN REVIEW brief | same |
| 110 | Reviewer brief | same |
| 120 | Reply | same (stale STATUS note, part D) |
| 177 | Run model | same |
| 188 | Review counting (0.4.0) | same page, "Review counting" |
| 196 | Stall (0.4.0) | same page, "Stall" |
| 202 | Reviewer model | same |
| 206 | Doubt signals | same |
| 222 | Log records | same (stop record `continues` already there) |
| 266 | Gates (slice A1) | same page, "Gates" |
| 274 | Stall gate and gap cutoff in the gates (0.4.0) | same page, "Stall gate and gap cutoff in the gates" |
| 282 | API (`.claude/hooks/brief.mjs`) | same |

### bench/README.md (13 headings)

| Line | Heading | Goes to |
|---|---|---|
| 7 | Arms | same (arm facts, part D) |
| 30 | Tasks | same |
| 52 | Commands, in order | same |
| 103 | The SDK arm | same |
| 117 | Short documentation run | same; adds README's 0.3.0 short-run table |
| 127 | Comparison run for 0.4.0 (compare-040) | same; merges README's bullets |
| 159 | Read router benchmark (route-040) | same; merges README's bullets |
| 174 | Outputs | same |
| 179 | Isolation | same |
| 183 | Pacing and interruption | same |
| 191 | Task contract | same |
| 202 | Adding a task | same |
| 208 | Cost is reported in tokens only | same |
| (new) | Results; Results: built-in subagents blocked; Results: why a router | from README "Benchmarks", "Benchmark: ... built-in subagents blocked", "Why a router" |
| (new) | Plugin eval suite | from README Known limitations line 416, npm scripts `npm run eval` row, CLAUDE.md Commands |

Count: 33 + 25 + 13 + 27 + 11 + 13 + 5 + 16 + 13 = 156 headings at levels 2 and 3, plus 2 at level 4 (158 rows; checked by script against `grep -nE "^#{2,4} "` of each page).

## D. Facts checklist

Each line: the fact as it is now, and its source. Tick when the page states it. "fix-notes-X" means `docs/data/audit-2026-11-16/fix-notes-X.md`; findings files are named in full.

### README.md

- [ ] The pinned triage section keeps every threshold string of part E. (source: src/contracts.test.ts, test "README carries the thresholds")
- [ ] A task that starts with `-` now runs: `scripts/orchestrate.sh` passes it after `--` (`... --allowedTools <rules> -- "<task>"`); remove the "start the task with another character" advice. (source: fix-notes-scripts.md, W-4)
- [ ] "The reviewed route" reviewer: a reviewer with no STATUS line does not pass (`last_reviewer_no_status`); it does not "fail". (source: gates.md, G-10 (b); .claude/hooks/review-gate.mjs:228)
- [ ] The orchestrator's first line is `Path: light|full - <reason>`; the plan is shown as one line per slice; the final report has at most 15 lines with one `<id>: pass|fail - <evidence pointer>` line per slice; more detail only when asked. Same rule in the route skill (`Route: <mode> - <reason>`) and the nudge. (source: fix-notes-output-rules.md, Docs to update: README)
- [ ] Built-in subagents: say "the built-in subagents listed in `BUILTIN_AGENTS` (seven since Claude Code 2.1.325) and fork"; never "six". (source: dashboard-bench.md, B-3; .claude/hooks/builtin-agents.mjs:17)
- [ ] `npm run plain` runs `claude --settings '{"agent":"","outputStyle":"Concise"}'`. (source: fix-notes-tests-misc.md, item 2 and Docs to update README.md:511; package.json:20)
- [ ] The research link for "what 0.4.0 recommended" moves with native-vs-plugin; README keeps only links to docs/README.md and the top pages. (source: README.md:308)

### docs/native-mode.md

- [ ] Roles: researcher tools now also allow `sed -n`, `cut`, `stat`, `echo` and `cd` (narrow forms held by the researcher guard); the table at line 16 lists only the git, `wc`, `ls`, `du` forms. (source: .claude/agents/researcher.md:8; fix-notes-guards.md, T-11; fix-notes-researcher-cd.md, item 2)
- [ ] Roles: researcher maxTurns 15, integrator maxTurns 20 (implementer 80, reviewer 40 already listed). (source: .claude/agents/researcher.md:6, integrator.md:6)
- [ ] Built-in subagents: line 22 says "six built-in subagents ... seven rules"; it is the list in `BUILTIN_AGENTS` (seven since 2.1.325) plus fork, eight rules in `DENIED_AGENTS`. (source: .claude/hooks/builtin-agents.mjs:17; CLAUDE.md "Eight agents are blocked")
- [ ] Default agent: `npm run plain` passes `{"agent":"","outputStyle":"Concise"}`. (source: fix-notes-tests-misc.md, Docs to update docs/native-mode.md:9)
- [ ] The plain session of `scripts/orchestrate.sh` (`ORCH_AGENT=none`, also `npm run auto`'s plain and reviewed sessions) runs in the Concise output style; `ORCH_OUTPUT_STYLE` unset = Concise, `default` or empty = no style, another plain word = that style, anything else exits 1 before any model call. (source: fix-notes-scripts.md, O-5)
- [ ] Headless output: in a terminal `npm run native` and `npm run auto` print the result text and one line `turns 41, 723 s, exit 0`; piped or captured they print the JSON document. (source: fix-notes-scripts.md, O-9)
- [ ] Headless deny lists: `Bash(git -C *)` is gone; `git -C <dir>` allows only the named subcommands; newly denied headless: `git -c`, `--config-env`, `reset --hard` in any spelling, `git clean`, global options with a separate value. The lists guard against mistakes, not a command built to pass them (`git -C /r branch -D main status` passes). A commit message containing ` -c` is refused. (source: fix-notes-scripts.md, W-3)
- [ ] Headless: a dash-led task now runs (after `--`). (source: fix-notes-scripts.md, W-4)
- [ ] Headless: a crashed or killed run prints a `no_result` document (`terminal_reason` `no_result`, `orch_totals.complete` false) and `runs.jsonl` gets its wall time and turns. (source: fix-notes-scripts.md, W-6)
- [ ] Orchestrator output: path line first, one-line-per-slice plan, final report of at most 15 lines; doubt signals include a test gate that gave up. (source: fix-notes-output-rules.md, Docs to update: docs/native-mode.md)
- [ ] Gated workflow resume: the log line is `plan: <n> slice(s), constraints <ids or none>`; take `args.plan` from the result's `plan`, not from the log. (source: fix-notes-sdk-workflow.md, O-8; Docs to update docs/native-mode.md:280)
- [ ] Gated workflow: an isolated slice whose merged review fails gets the refute pass and retries, one slice at a time, rebuilt from the current HEAD; it fails for good only when its attempts are used up. (source: fix-notes-sdk-workflow.md, W-2)
- [ ] Gated workflow result carries `plan` and `summary` (`<id>: <status> (<n> attempt(s))` per slice); gap texts stay in `slices[].gaps`. (source: fix-notes-sdk-workflow.md, O-8)
- [ ] Limits: a retry of a planned slice is judged against the run's DEPENDS order; `file_overlap` and `dependency_cycle` still block every time for a plan that is broken. (source: fix-notes-plan-check.md, G-7, Docs to update docs/native-mode.md:320) (belongs to docs/gates.md "Limits")
- [ ] Limits: validation before a retry and opus on the third attempt are prompt rules, enforced in code only by the gated workflow. (source: README.md:406)

### docs/gates.md (new)

Plan check:
- [ ] `file_overlap`: a launch overlaps when its FILES share a file with a launched slice it is in no order with, either way, through the run's DEPENDS (transitive), and also when a retry's DEPENDS line drops the only order between two slices that share a file. A fresh retry of a slice that a later slice DEPENDS on is allowed. (source: fix-notes-plan-check.md, G-7)
- [ ] `light_path_multi`: also blocks a `PATH: light` launch while the open run is a planned run with more than one planned slice; the message names the planned slices. (source: fix-notes-plan-check.md, G-12)
- [ ] The no-haiku rule also raises older and provider-prefixed haiku ids (any id with the word haiku between non-letters). (source: fix-notes-plan-check.md, G-15)
- [ ] No plan-check block message names an environment switch. (source: fix-notes-plan-check.md, G-6)
- [ ] The single allow combines all its features in one `updatedInput`: the haiku raise, the read router, the coverage note, skill suggestions, and the skill facts and DRAFTS lines. README says "two features". (source: gates.md, G-10 (a); .claude/rules/agents.md:44)
- [ ] Skill suggestions from goal words: bug words do not suggest the bugfix skill for prose-only FILES or a KIND other than bugfix. (source: fix-notes-hooks-small.md, W-10) (also docs/skills.md)

Review gate:
- [ ] Reasons in the order the code applies them: `agents_running` (allow, not a block), then `run_state_unreadable`, then `implementer_unfinished`, then per slice `no_reviewer_after_last_implementer`, `replan_required`, `last_reviewer_failed`, `last_reviewer_no_status`, `constraints_unchecked`, `opus_review_required`; allows `slice_failed_for_good`, `reviewer_passed`, `no_telemetry`, `no_implementer_in_session`, `unparseable_input`. The gate blocks on the first problem with blocks left. (source: gates.md, G-9; .claude/hooks/review-gate.mjs:85-313)
- [ ] `run_state_unreadable` blocks when the run state cannot be folded; it gives up as `max_blocks_reached`. (source: gates.md, G-9; review-gate.mjs:201)
- [ ] `implementer_unfinished` also covers an implementer whose latest test-gate record is a block with no later SubagentStop. (source: fix-notes-run-model.md, G-2)
- [ ] Limit: on a Claude Code without `background_tasks`, an agent still fixing after a test-gate block can be gated before it stops again. (source: fix-notes-run-model.md, G-2)
- [ ] A carried slice that was final and passed, then fails a review in the new run, keeps the Stop gate allowing with `reviewer_passed` (it has no attempt in the new run); the plan check blocks an unplanned implementer with `not_in_plan`. (source: fix-notes-run-pane.md, item 1)
- [ ] Run scope: a re-planned slice that is not final moves whole into the new run; a final, passed slice stays final there until an implementer of it works there or a review of it fails; a slice whose latest review failed starts clean. A closed run never reopens. (source: fix-notes-run-model.md, G-1; fix-notes-run-pane.md, item 1; docs/brief-grammar.md "Carried slices")

Doubt signals:
- [ ] The list: `risky`, `retry`, `read_answer`, `open_items`, `tests_failed_isolated`, `test_gate_gave_up`, `low_confidence_fail` (and `always` under `ORCH_ESCALATION=always`). `test_gate_gave_up` is new: a test-gate record `max_blocks_reached` or `bugfix_unverified_gave_up` later than the review the latest attempt followed. (source: fix-notes-run-model.md, T-9 fold side; docs/brief-grammar.md "Doubt signals")
- [ ] Hand-back: one review recorded twice (a forced hand-back, `stop_hook_active` true) counts once (`continues: true`). (source: fix-notes-run-model.md, G-8)

Test gate:
- [ ] Isolated worktree means `<project>/.claude/worktrees/<x>` only; a session started with `claude --worktree` is gated as the shared tree (its implementers get `tests_failed` blocks; its base is its HEAD). (source: fix-notes-test-gate.md, T-1)
- [ ] The prose-only skip judges `git status`, plus, in an isolated worktree, the paths committed since the fork point; no base found keeps the tests. (source: fix-notes-test-gate.md, T-2)
- [ ] The two-block cap counts blocks since the agent's latest SubagentStart: a resume starts a new count. (source: fix-notes-test-gate.md, T-9)
- [ ] `ORCH_HOOK_BUDGET_S`: default and maximum 870; a larger value is cut to 870. (source: fix-notes-test-gate.md, T-12)
- [ ] Limit: an isolated `warn` failure still pays for a base run (T-12 second half not done). (source: fix-notes-test-gate.md, T-12)
- [ ] Test baseline `allow`: never for a unittest command with failfast (`-f`, `--failfast`, combined `-qf`); never when cargo stopped at a failing target (a last rerun hint with no `error: N target(s) failed:` summary); an isolated worktree keeps `tests_failed_isolated`. (source: fix-notes-test-gate.md, T-4, T-13, T-8)
- [ ] Failing tests are read from node `--test`, jest, vitest, pytest, unittest, go and cargo (also `cargo test --quiet`). (source: fix-notes-test-gate.md, T-4, T-13)
- [ ] Limit: `unittest.main(failfast=True)` inside a script cannot be seen. (source: fix-notes-test-gate.md, T-4)
- [ ] Limit: a cargo workspace member whose folder name differs from its package name does not match, so its bugfix slice still blocks. (source: fix-notes-test-gate.md, T-13)
- [ ] Bugfix check: a test that only fails on the base as a whole file that does not load (import or syntax error) does not count; it blocks with `bugfix_test_passes_on_base`. (source: fix-notes-test-gate.md, T-3)
- [ ] Bugfix check: the unittest reproduction test is verified at the first stop. (source: fix-notes-test-gate.md, T-4)
- [ ] LATER: test gate under load: one suite run at a time per project; a default time budget 60 s under Claude Code's subagent stall limit; a slice whose suite could not run is marked for an opus review. Fill names, values and reasons from docs/data/audit-2026-11-16/fix-notes-gate-load.md once it exists. (source: planner's brief, in-flight slice)

Researcher guard:
- [ ] Allowed forms also include `sed -n` (one line or one range), `cut` (no `-z`), `stat` (listed long options), `echo` (no redirection); `sed -i`, `sed -n '1w x'`, `sed -e`, a glob argument to `sed -n` are refused with a message naming the allowed form. (source: fix-notes-guards.md, T-11)
- [ ] `cd` is allowed only as `cd <one literal path>` starting with `./`, `../` or `/`, whose physical path from every folder the shell may be in is the project folder or inside it; `cd src`, `cd /`, `cd ~`, a link leading out, a missing path, options, variables and globs are refused. This supersedes "cd stays refused" in fix-notes-guards.md T-11. (source: fix-notes-researcher-cd.md, item 2; .claude/agents/researcher.md:8 `Bash(cd *)`)
- [ ] Limit: a shell function or alias named `cd`. (source: fix-notes-researcher-cd.md, item 2)
- [ ] Device rule: refused when the path is `/dev` or under it (except `/dev/null`), judged on the text-normalised path and on the path the system resolves; also a path whose walk passes through /dev, existing or not; also for `wc`, `sed -n` and `cut`; a bare word counts as a path; grep and rg also judge `.`. (source: fix-notes-guards.md, T-5; fix-notes-researcher-cd.md, items 1 and 3; fix-notes-guards-2.md, item 2)
- [ ] A word over 4096 characters is refused; a walk over 20000 lstat calls is refused; a decision never throws. (source: fix-notes-researcher-cd.md, item 3)
- [ ] Limits: a glob the shell expands to a device (`cat /dev/zer?`) is not judged; a FIFO the shell reaches other than by its operands; Linux `/proc/self/fd`. (source: fix-notes-guards.md, T-5; fix-notes-guards-2.md, item 2; fix-notes-researcher-cd.md, item 3)

Egress guard:
- [ ] With no readable brief, the guard falls back to the reviewer's launch record (hosts in `urls`, host-shaped `sources`, its slice's planned FILES); a host not named there is denied (`host_not_in_brief`). `egress_unverified` appears only when no launch record exists either. (source: fix-notes-guards.md, T-6)

Quote check:
- [ ] A QUOTE citing a page the PDF does not have, with text not in the PDF, is unverified (sent back once), not unverifiable. (source: fix-notes-guards.md, T-7)

Report check:
- [ ] A capture the report check or the quote check refused is never the stop's reply; refusals are logged in `handback-refusals.jsonl`. (source: fix-notes-guards.md, G-14)
- [ ] Limit: a quote-check refusal without a `tool_use_id` that finishes before `handback-check.mjs` writes its capture is not tied to that capture. (source: fix-notes-guards.md, G-14)

Context after compaction:
- [ ] Slice states also show `passed, opus review due` and `review failed, replan required (n attempts)`. (source: fix-notes-hooks-small.md, G-5)

Read router:
- [ ] An xlsx cell beyond column XFD (16,384) is skipped. (source: fix-notes-hooks-small.md, T-10)

### docs/settings.md (new)

- [ ] `ORCH_OUTPUT_STYLE` (scripts/orchestrate.sh): unset = Concise; `default` or empty = no style; a plain word of letters, digits, `_`, `-` = that style; anything else exits 1. Environment only. (source: fix-notes-scripts.md, O-5; scripts/orchestrate.sh:51-54)
- [ ] `ORCH_HOOK_BUDGET_S`: default and maximum 870. (source: fix-notes-test-gate.md, T-12; .claude/hooks/verify.sh:36)
- [ ] `guards` row: name the egress guard's launch-record fallback. (source: fix-notes-guards.md, T-6)
- [ ] LATER: new or changed test gate time settings from the load fix. (source: fix-notes-gate-load.md, once it exists)
- [ ] The plugin declares 20 `userConfig` settings. (source: README.md:240; scripts/build-plugin.mjs `OPTIONS`)

### docs/logs.md (new)

- [ ] Telemetry takes a worker's status from the hand-back capture first (`handbackFor`), then `last_assistant_message`, then the transcript. (source: gates.md, G-10 (c))
- [ ] `telemetry.jsonl` keeps hook payload strings clipped to 300 characters, the worker's last message included; the run-model logs hold parsed fields only. (source: fix-notes-run-model.md, G-4)
- [ ] Hand-back capture skips refused captures (`handback-refusals.jsonl`). (source: fix-notes-guards.md, G-14)
- [ ] Stop records may carry `continues: true`. (source: fix-notes-run-model.md, G-8)
- [ ] `npm run report`: the Skills counts of a continued record replace the earlier record's. (source: fix-notes-run-model.md, G-8)
- [ ] Headless run result: `no_result` document for a crashed run; terminal form in a terminal. (source: fix-notes-scripts.md, W-6, O-9)

### docs/safety.md (new)

- [ ] Native judge store: the typed requests are in `<CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/judge-prompts/<project key>/prompts.jsonl` (folder 0700, file 0600), not in the state dir. (source: fix-notes-judge-hook.md, J-12, Docs to update README "Safety")
- [ ] Headless git denies and their limit (mistakes, not a built command). (source: fix-notes-scripts.md, W-3)
- [ ] If the page lists exec-env names, it includes `PS0`, `PS1`, `PS4`, `BASH_FUNC_<name>` and `ZDOTDIR`; otherwise it links docs/bash-judge.md 2.5. (source: fix-notes-judge.md, J-6, J-7)
- [ ] Judge relaxed no-op forms pass: `GIT_EDITOR=true`, `GIT_EDITOR=:`, `git -c core.editor=true|:`, empty `IFS=`. (source: fix-notes-judge.md, J-15)
- [ ] Judge refusals that cost legitimate uses (link to docs/bash-judge.md section 11): `PS4='+ ' bash -x`, a here-document delimiter with `$`, backtick in a quoted subscript, `set -A`, `commands` as a variable name, `git config --get` of an exec key, a refused filter-branch filter. (source: fix-notes-judge.md, J-5, J-6, J-10; fix-notes-judge-2.md, J-9, J-8, J-4, J-3)

### docs/sdk-pipeline.md (new)

- [ ] `--budget`: a worker that crashes, times out or ends with no result is charged the usage it streamed. (source: fix-notes-judge.md, S-2)
- [ ] A failing commit hook is shown to the writer as feedback and retried within `--retries`; when retries are used up the slice fails with the hook's message and the real attempt count. Hooks still run (no `--no-verify`). (source: fix-notes-sdk-workflow.md, S-1)
- [ ] The judge's working folder: the worker's worktree is the root; relative targets and facts resolve against the shell's current folder inside it; a judged command while the shell is outside the root is denied without asking. (source: fix-notes-judge.md, J-13)
- [ ] Agent SDK 0.3.325; the judge's hook is registered with `onFailure: "block"`. (source: README.md:434; package.json)
- [ ] "Bash judge" summary: if it names what the judge reads as scripts or refuses as definitions, it includes the git options of `GIT_SHELL_OPTS` (`rebase -x`, `grep -O`, `difftool -x`, `--upload-pack`, `--exec`, the filter-branch filters), `hash -p`, `enable -f`, `set -A` and zsh's `commands` table; otherwise it only links docs/bash-judge.md 2.1. (source: fix-notes-judge.md, J-3, J-8; fix-notes-judge-2.md, J-3, J-8, J-9)

### docs/development.md (new)

- [ ] Hooks list includes `skill-scan.mjs` (a library shared by the skill gate and `npm run skill-publish`). (source: fix-notes-skill-gate.md, W-1, Docs README ~532)
- [ ] `npm run plain` text. (source: fix-notes-tests-misc.md, item 2)
- [ ] `src/gate-hardening.test.mjs` is split into `gate-hardening-time`, `-trap` and `-logs` test files. (source: fix-notes-tests-misc.md, item 1)
- [ ] `npm run check-plugin` skips only `dist/plugin/evals/results`; a stale file under any other `results` path fails it. (source: fix-notes-scripts.md, W-7)

### docs/brief-grammar.md

- [ ] Line 30 says `SOURCES`, `READ` and `KIND` "have no gate behaviour yet"; the read router keys on `SOURCES`/`READ` and the bugfix check on `KIND: bugfix`. (source: .claude/rules/agents.md:27, :48; docs/native-mode.md:166, :214)
- [ ] Line 48 says `SKILLS` is optional "on any worker's brief (implementer, reviewer, researcher, integrator)"; the rule is never the integrator's. The parser may still read it; the spec should say the orchestrator never writes it there. (source: .claude/rules/agents.md:27; src/contracts.test.ts:255)
- [ ] Line 130's note says `journal.mjs`, `telemetry.mjs` and the dashboard take the last STATUS line; they use `parseStatus` now. (source: .claude/hooks/journal.mjs:32,185; telemetry.mjs:8)
- [ ] Gate reasons list (line 264): add `run_state_unreadable`. (source: gates.md, G-9)
- [ ] no_plan_review and light path: `PATH: light` does not skip the plan review while the open run plans more than one slice (`light_path_multi`). (source: fix-notes-plan-check.md, G-12)
- [ ] Already done in the spec, keep: carried slices, `continues`, `test_gate_gave_up`, `REPLAN` leading integer, `BUILTIN_AGENTS` pointer, telemetry clip. (source: fix-notes-run-model.md, G-1, G-8, T-9, G-11, G-13, G-4; fix-notes-run-pane.md, item 1)

### docs/bash-judge.md

- [ ] Section 1 scope lists `npm run auto` under the SDK pipeline; `npm run auto` runs `scripts/auto.sh`, which starts native sessions through `scripts/orchestrate.sh` (it calls `src/route.ts` for triage only). (source: package.json:14; scripts/auto.sh:44,75,80)
- [ ] J-14 is fixed: section 4 cites 0.3.325 and no longer says a timed-out hook lets the command run. Check, do not reintroduce. (source: judge-sdk.md, J-14; fix-notes-judge.md, J-14; docs/bash-judge.md:226)
- [ ] Native hook, Authority: the store moved to the per-user `judge-prompts` folder; a Bash command naming `judge-prompts` (any spelling the tokenizer decodes: `$'...'`, `$"..."`, escapes, inside `bash -c`/`sh -c`/`zsh -c`/`eval` up to 4 levels) is refused with no model call; a `prompts.jsonl` in `<project>/.claude/state` is ignored. (source: fix-notes-judge-hook.md, J-12; fix-notes-guards-2.md, item 1)
- [ ] Native hook, Limits: Write and Edit never reach the hook; a glob (`judge-*`), a name built at run time, a `cd` into the parent then a relative glob, a spelling nested deeper than 4 script strings, and a top-level line the tokenizer cannot read (raw-text look only) stay out of reach. (source: fix-notes-judge-hook.md, J-12; fix-notes-guards-2.md, item 1)
- [ ] Section 2.1 and 11 already list the audit rows (J-1 to J-10, J-15, fix-judge-2, fix-judge-3) and J-11, globsubst; keep them; remove "new in 1.4.5" wording only. (source: fix-notes-judge-2.md, item 3; fix-notes-judge.md, J-14/J-11)

### docs/dashboard.md

- [ ] Status lines: the subagent row's attempt number counts fresh launches within the run (a new count at each PLAN REVIEW without REPLAN); example `implementer s2 #2 risky · opus · ...` (not `sonnet`). (source: fix-notes-hooks-small.md, D-2; dashboard-bench.md, D-7)
- [ ] Status lines: rows are cut by display width over graphemes. Limit: a terminal that draws ambiguous-width characters as two columns shows those rows wider than counted. (source: fix-notes-hooks-small.md, D-3)
- [ ] `statusline.sh` prints names literally (a backslash in a folder or model name shows as it is). (source: fix-notes-tests-misc.md, D-5)
- [ ] Already done, keep: closed run never reopens, carried slices, 500-record cap, the test-gate blind spots, the hand-back second stop. (source: fix-notes-run-pane.md, items 2, 3, 5)

### docs/skills.md

- [ ] Suggestions: picks from goal words can name a skill that does not fit (one shared name word plus two description words is enough); the worker skips it. Bug words do not count for prose-only FILES or a KIND other than bugfix. (source: fix-notes-hooks-small.md, W-10)
- [ ] Already done, keep: branch scan, `paths`, the push-address rule, `--no-follow-tags`, tags and commit messages not scanned, merged-base branch blocked. (source: fix-notes-skill-gate.md, W-1, Not covered; fix-notes-guards-2.md, item 3)

### docs/native-vs-plugin.md

- [ ] Line 31: six built-in types; now the list in `BUILTIN_AGENTS` (seven since 2.1.325). (source: .claude/hooks/builtin-agents.mjs:17)
- [ ] Line 68: "15 `userConfig` settings"; now 20. (source: README.md:240; docs/native-mode.md:130)
- [ ] Lines 7 and 122: "not smoke-run yet"; the eval suite was smoke-run on 2026-11-10 (bounded to `t2-single`, one run, twice, about $0.37 each; 4 of 7 graders passed). (source: scripts-workflow-skills.md, W-8; CLAUDE.md Commands)
- [ ] Line 23: the gated workflow resumes from the plan in its result, not its logged plan. (source: fix-notes-sdk-workflow.md, Docs to update)
- [ ] Line 115: headless fields are empty unless `ORCH_SESSION_PERSISTENCE=1`. (source: README.md:208)

### bench/README.md

- [ ] `all-haiku` and `reader-haiku` rewrite the researcher to haiku (`agentModels`) and set `ORCH_ALLOW_HAIKU=1`; "shipped" applied in 0.4.0 only. (source: fix-notes-bench-evals.md, B-1 and Docs to update)
- [ ] `routed` and `reader-routed` run the shipped researcher (sonnet since 1.3.0), so the pairs `all-haiku -> routed` and `reader-haiku -> reader-routed` compare haiku with sonnet plus notes, not the 0.4.0 comparison. (source: fix-notes-bench-evals.md, B-1 "Not changed")
- [ ] Plain arms (P-S, P-O, W-mix, N-UC, the reader arms, AUTO) set `ORCH_OUTPUT_STYLE=default`. (source: fix-notes-bench-evals.md, item 4)
- [ ] Results table label: "`reader-haiku` (shipped in 0.4.0)". (source: fix-notes-bench-evals.md, Docs to update README.md ~322)
- [ ] Results: "six built-in subagents were blocked at the time of the campaign". (source: dashboard-bench.md, B-3)
- [ ] The claim classifier no longer counts the template `STATUS: pass or fail` as a claim. (source: fix-notes-bench-evals.md, B-4)
- [ ] The graders `score.mjs` of k1, k2 and h3 use the real-path entry guard. (source: fix-notes-bench-evals.md, B-2)
- [ ] Plugin eval suite: graders match a coloured node:test summary; `orch-agent-used` was removed from `t2-single`. Whether colour caused the observed t2-single failures is unproven. (source: fix-notes-bench-evals.md, E-1, E-2)

### docs/research-2026-11-16.md (new record)

- [ ] Every finding id with its status, from the six findings files and the fix-notes (part B list). (source: docs/data/audit-2026-11-16/*)
- [ ] The two live checks below, and the load fix, once recorded.

### CLAUDE.md and .claude/rules/agents.md (fact changes only)

- [ ] `npm run plain` JSON: CLAUDE.md:12; rules:71 check wording. (source: fix-notes-tests-misc.md, Docs to update)
- [ ] Researcher Bash list: add `sed -n`, `cut`, `stat`, `echo`, `cd ./<path>` into the project (CLAUDE.md 1.2.0; rules researcher-guard line). (source: fix-notes-guards.md, T-11; fix-notes-researcher-cd.md, item 2)
- [ ] Device rule wording ("/dev or a device under it", walk through /dev). (source: fix-notes-researcher-cd.md, item 1; fix-notes-guards-2.md, item 2)
- [ ] Egress guard line: launch-record fallback. (source: fix-notes-guards.md, T-6)
- [ ] Hand-back capture (1.4.4, both files): a refused capture is skipped (`handback-refusals.jsonl`). (source: fix-notes-guards.md, G-14)
- [ ] Native judge paragraph and CLAUDE.md where they name the store: `judge-prompts` per-user folder. (source: fix-notes-judge-hook.md, J-12)
- [ ] Pushes and deletes: name the headless git denies and their limit. (source: fix-notes-scripts.md, W-3)
- [ ] 1.4.5 "Dash-led tasks": the launch now passes the task after `--`. (source: fix-notes-scripts.md, W-4)
- [ ] 1.4.4 "Default agent": the flag text with `outputStyle`. (source: fix-notes-scripts.md, O-5)
- [ ] Run scope: carry rule with the failing-review exception; a closed run never reopens, on the pane too. (source: fix-notes-run-model.md, G-1; fix-notes-run-pane.md, Docs to update)
- [ ] Review gate bullet "Doubt signals:" adds a test gate that gave up; add the output rule to the three-places rule; CLAUDE.md may add a short 1.5.0 mention (optional). (source: fix-notes-output-rules.md; fix-notes-run-model.md, T-9)
- [ ] 1.2.0 `implementer_unfinished`: also a test-gate block with no later stop. (source: fix-notes-run-model.md, G-2)
- [ ] Log records: stop record optional `continues`. (source: fix-notes-run-model.md, G-8)
- [ ] Plan-check bullet: overlap is judged against the run's DEPENDS order (transitive). (source: fix-notes-plan-check.md, G-7)
- [ ] Model-facing rule could name hook block messages. (source: fix-notes-plan-check.md, G-6)
- [ ] Test-gate bullet: "judges `git status`" plus the slice's commits since its fork point in an isolated worktree; "one two-block cap per agent" becomes per agent since its latest start. (source: fix-notes-test-gate.md, T-2, T-9)
- [ ] Skill suggestions: bug-word rule. (source: fix-notes-hooks-small.md, W-10)
- [ ] Skill creation gate bullet: branch scan, `paths`, push-address rule, `skill-scan.mjs` shared with publish, no tags pushed (also CLAUDE.md 1.4.0). (source: fix-notes-skill-gate.md, W-1; fix-notes-guards-2.md, item 3)
- [ ] 1.4.4 entry guards: the graders no longer use the old form. (source: fix-notes-bench-evals.md, Docs to update)
- [ ] Keep every string of part E.

### Outside the agreed scope (list for the planner; no writer edits these)

- [ ] CHANGELOG.md: one unreleased 1.5.0 entry for every fix slice (fix-notes-*, "CHANGELOG" lines); the released entries stay, including lines 32, 35, 58, 59 that the notes call no longer true. (source: fix-notes-judge.md, fix-notes-judge-2.md, fix-notes-scripts.md, fix-notes-bench-evals.md, fix-notes-guards.md, fix-notes-guards-2.md, fix-notes-skill-gate.md, fix-notes-sdk-workflow.md)
- [ ] bench/HYPOTHESES.md H14 and H14-d3 notes: published runs had haiku as the shipped researcher; a rerun runs haiku only in the haiku arms. (source: fix-notes-bench-evals.md, Docs to update)
- [ ] dist/ rebuild (`npm run build-plugin`) after the merge: not in this run. (source: every fix-notes file; constraint C2)
- [ ] `src/agent.ts` comment about a timed-out callback: softened by fix-judge-2 item 4. Nothing left. (source: fix-notes-judge-2.md, item 4)
- [ ] `src/contracts.test.ts` could scan other hooks' messages for switch names. (source: fix-notes-plan-check.md, G-6)
- [ ] The header comment of `review-gate.mjs` (step 2 list of doubt signals) should name `test_gate_gave_up`; the orchestrator, route skill and nudge already list it. (source: fix-notes-run-model.md, T-9; fix-notes-output-rules.md)
- [ ] `docs/research-2026-11-10.md` "Open" (eval graders) is a dated record and stays as it is. (source: fix-notes-bench-evals.md, Docs to update)

### Docs-drift findings of the audit

- [ ] G-9: review gate reason order and `run_state_unreadable`: docs/gates.md "Review gate", docs/brief-grammar.md reason list. (source: gates.md, G-9)
- [ ] G-10: (a) the single allow's features, (b) a reply without STATUS does not pass, (c) telemetry's status source: docs/gates.md, README, docs/logs.md. (source: gates.md, G-10)
- [ ] W-8: eval suite smoke-run: bench/README.md "Plugin eval suite", docs/native-vs-plugin.md. (source: scripts-workflow-skills.md, W-8)
- [ ] D-7: status line example `· opus ·`: docs/dashboard.md "Status lines". (source: dashboard-bench.md, D-7)
- [ ] B-3: six built-ins in the present tense: bench/README.md results, README. (source: dashboard-bench.md, B-3)
- [ ] J-14: already fixed in docs/bash-judge.md section 4; verify only. (source: judge-sdk.md, J-14)

### Later items (another slice fills or records them)

- [ ] Test gate load fix: one suite run at a time per project; default time budget 60 s under Claude Code's subagent stall limit; a slice whose suite could not run is marked for an opus review. Fill from docs/data/audit-2026-11-16/fix-notes-gate-load.md (does not exist yet) into docs/gates.md, docs/settings.md, docs/brief-grammar.md "Doubt signals" if a signal is added, and docs/research-2026-11-16.md. (source: planner's brief)
- [ ] Live check (i), to record in docs/data/live-checks-2026-11-16.md: a researcher, after the merge at commit d401009, ran `cd ./src && ls | head -3` (listed src); the next call `ls | head -3` listed the project folder again (a subagent's folder is reset between calls); `cd ../docs && ls | head -3` was refused by the researcher guard with its cd message; `cd ./docs && ls | head -3` ran. Pages: docs/gates.md "Researcher guard" (cd rule), docs/research-2026-11-16.md. (source: planner's brief)
- [ ] Live check (ii), same file: four isolated implementers stopped within two minutes (11:16:08 to 11:17:52 UTC); their whole-suite runs at their stops took 554 to 590 s instead of about 120 s; each recorded one failing test that also failed on the base under that load; Claude Code ended one of the agents as stalled after 600 s without progress while its stop hook ran. Pages: docs/gates.md "Limits" (until the load fix lands), docs/research-2026-11-16.md. (source: planner's brief)

Count: 17 fix-notes files read; every "Docs to update" entry and every limit of each has a line above. 6 docs-drift findings, 3 later items.

## E. What src/contracts.test.ts pins in the four files

| File | Pinned | What it means for a writer |
|---|---|---|
| README.md | Exactly one heading matching `^#+ Choosing a route \(triage\)` | Keep the heading text `## Choosing a route (triage)` once. No other heading with that text. |
| README.md, that section only | `at most 3 files, at most 200 lines` | Keep this exact phrase (the "Small" sentence). |
| README.md, that section | `2 or more independent slices` | Keep. |
| README.md, that section | `10 or more files` | Keep. |
| README.md, that section | `4 or more when the task changes no code` | Keep this exact phrase. |
| README.md, that section | `1,500 or more lines` | Keep, with the comma. |
| README.md, that section | `12 or more files \|` | A table cell: the row "12 or more files" must be followed by the column bar. Keep the table. |
| README.md, that section | `` `bigLines` 1500 and `reviewedMaxLines` 200 `` | Keep this exact phrase, backticks included. |
| README.md, whole file | Any `<TRIAGE key> <number>` (with or without backticks) equals `TRIAGE` | Never write a key with another number, for example `minParallelFilesCode 4` as history. Keys: `minParallelSlices` 2, `minParallelFilesCode` 10, `minParallelFilesNonCode` 4, `bigFiles` 12, `reviewedMaxFiles` 3, `reviewedMaxLines` 200, `bigLines` 1500. Today's "raised from 4 to 10" passes only because no key name stands right before the 4. |
| docs/native-mode.md | Any `<TRIAGE key> <number>` equals `TRIAGE` | As above. |
| docs/native-mode.md | Every `N+ lines` has N = 1500 | Write "1,500+ lines" or avoid the form. |
| docs/native-mode.md | Every `at most N files` has N = 3 | Anywhere on the page. Never write "at most 5 files" for anything else. |
| docs/native-mode.md | Every `from N files for code` has N = 10, every `from N files for work that changes no code` has N = 4 | Only if you use these forms. |
| CLAUDE.md + .claude/rules/agents.md together | `ORCH_GAP_MIN`, `ORCH_STALL_GATE`, `ORCH_GUARDS`, `ORCH_READ_ROUTER`, `ORCH_QUOTE_CHECK`, `ORCH_BASELINE`, `ORCH_BUGFIX_CHECK`, `ORCH_SKILL_HINTS`, `ORCH_ALLOW_HAIKU`, `ORCH_SKILL_CREATE`, `ORCH_SKILLS_REPO_PRIVATE`, `ORCH_SKILLS_REPO_PUBLIC`, `CLAUDE_PLUGIN_OPTION_` | Each name stays in at least one of the two files. |
| CLAUDE.md, and separately .claude/rules/agents.md | `SKILLS:`, `ORCH_SKILL_HINTS=off`, `skill_hints`, `at most 3`, `anthropic-skills:<name>`, `synced/<uuid>/<name>`, `.claude/skills`, `Workflow agents get no hints`, `light_path`, `never for built-ins or fork`; regexes `1 for (a )?reviewers?` or `at most 1 for a reviewer`; `names and reason codes only` or `skill names and reason codes only`; `not found on disk pass through`; `never lower` (any case) | Each file must keep every one of these on its own. Edit around them, never through them. |

No other test reads README.md, docs/*.md, bench/README.md, CLAUDE.md or `.claude/rules/agents.md` (checked with grep over `src/*.test.*`, `bench/*.test.*`, `dashboard/*.test.*`). Docs are not part of `dist/`, so `npm run check-plugin` does not see them.

## F. Outline of the new README.md (at most 150 lines)

| Heading | Lines | What goes there |
|---|---|---|
| `# Claude Code orchestrator` | 4 | One sentence: what it is. One sentence: it picks the cheapest of three routes and gates the result. Link docs/README.md. |
| `## What it does` | 10 | Any task (code, research, writing, analysis, operations). Three routes. Gates that do not take a worker's word. Runs inside Claude Code as a plugin; the SDK pipeline is frozen (link docs/sdk-pipeline.md). |
| `## Install` | 25 | The two `/plugin` commands; start a new chat; `/reload-plugins` after an update. The two settings a plugin cannot set: `worktree.baseRef: "head"`, permission denies (link docs/safety.md). One line: run `npm run claude-update` after a Claude Code update (link). |
| `## First run` | 20 | `/route <task>`; `claude --agent orchestrator`; from a checkout: `npm run auto`, `npm run native`, `npm run plain`; the gated workflow is started by you (link docs/native-mode.md "The gated workflow"); `/orchestration on` for the pane (link docs/dashboard.md). Each command with one comment. |
| `## The three routes` | 18 | Table: route, what runs, where the result lands, what checks it. Escalation in three bullets (part A example). Link docs/native-mode.md. |
| `## Choosing a route (triage)` | 25 | Pinned (part E). The five facts in one list. The "Small" and "Parallel" sentences with the exact numbers. The five-row table. The `TRIAGE` sentence with `` `bigLines` 1500 and `reviewedMaxLines` 200 ``. Tuned on coding benchmarks only. Failed triage falls back to the orchestrate route. `/route` without a checkout sizes in-session. |
| `## What it adds` | 10 | Verification, routing cost, safety, resumability, one line each. One sentence from "Why a router": on small and medium tasks the orchestrate route cost 1.2x to 2.1x the tokens for the same 100%. Links docs/native-vs-plugin.md and bench/README.md "Results". |
| `## Limits and safety` | 8 | Three bullets: guards and deny lists are not a boundary (use the sandbox); worktrees isolate git state, not files; benchmarks are small, direction only. Link docs/safety.md. |
| `## Documentation` | 15 | Links: docs/README.md, docs/glossary.md, docs/native-mode.md, docs/gates.md, docs/settings.md, docs/brief-grammar.md, CHANGELOG.md. |
| `## Development` | 10 | `npm install`, `npm run check` (what it runs; CI runs it). Link docs/development.md and CLAUDE.md. |

About 145 lines with blank lines. Diagrams: keep `routes` and `triage` pictures in README; the other pictures move with their sections.

## G. Decisions (the planner's answers to the open questions)

1. Decided: "orchestrate route" for the route, "SDK pipeline" for `src/`. The glossary lists "the pipeline" only as "also called" for both.
2. Decided: "escalation" for the rerun of a failed plain or reviewed run on the orchestrate route; "opus review" for the review a doubt signal requires. Switch names (`ORCH_ESCALATION`, `ORCH_NO_ESCALATE`), gate reason codes and the text of agent files are not changed by the docs.
3. Decided: benchmark results live in bench/README.md "Results"; README.md keeps one sentence. No new results page.
4. Decided: the release is version 1.5.0, not 1.4.6. CHANGELOG.md gets its unreleased 1.5.0 entry from the release slice, built from part D "Outside the agreed scope". bench/HYPOTHESES.md stays as it is; docs/research-2026-11-16.md carries the B-1 note.
5. Decided: the file name docs/native-mode.md stays (`src/contracts.test.ts` reads it, and many pages link it); the page gets the title "How the native orchestrator works".
