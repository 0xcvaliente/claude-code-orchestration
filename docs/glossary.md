# Glossary

Every term these docs use, defined once, in alphabetical order. Each page links a term here at its first use. Where two words name one thing, the first is the one to write; the others are listed as "also called". The source in brackets is where the term is defined in code or spec.

Gate reason codes (`not_in_plan`, `opus_review_required`, ...) are not listed here: [docs/gates.md](gates.md) lists them, and docs/brief-grammar.md "Gate reasons of the run model" lists those that come from the run model.

## A

**Acceptance check.** The command or checklist that proves one slice is done. For code it is the narrowest command that proves the slice, usually the tests of the files it owns; the whole suite is left to the test gate and the integrator. [`.claude/agents/implementer.md`, `.claude/agents/orchestrator.md` step 2]

**Arm.** One setup the benchmark runs on every task, for example `P-S` (plain Sonnet) or `O-mix` (the orchestrator with shipped models). [`bench/arms.mjs`, bench/README.md "Arms"]

**Attempt.** One try at building a slice. Attempts are counted from the slice's implementer stops, so a fresh launch and a `SendMessage` resume both count. Stops with no review of the slice between them count as one attempt (a test-gate block makes a worker stop again). [docs/brief-grammar.md "Run model", Attempts]

**Authority (judge).** What the Bash judge accepts as permission: only the user's original request, never a worker's brief. The SDK judge takes it from `--task`; the native judge hook from the prompts the person typed in the session. [docs/bash-judge.md 3.3, "Native hook"]

## B

**baseRef.** The Claude Code setting `worktree.baseRef`. Set to `"head"`, worktrees start from your local HEAD; otherwise they start from the remote default branch and miss local commits. [docs/native-mode.md "Parallel slices"]

**Brief.** The text the orchestrator sends a worker when it launches it. It starts with header lines (`SLICE:`, `FILES:`, `DEPENDS:` for an implementer) that the hooks read. [docs/brief-grammar.md]

**Bugfix check.** The test gate's check for a `KIND: bugfix` slice: after its tests pass, a changed or added test file must fail on the base. [`.claude/hooks/bugfix-check.mjs`]

**Built-in subagent.** A subagent type that ships with Claude Code. The one list of their names is `BUILTIN_AGENTS` in `.claude/hooks/builtin-agents.mjs`; this repo denies them, and the plan check blocks them while a run is open. [CLAUDE.md, "Eight agents are blocked"]

## C

**Campaign.** One benchmark session: a matrix run once, with its runs, grades and summary under `runs/bench/<campaign>/`. [bench/README.md "Outputs"]

**Carried slice.** A slice of an open run that a new plan review without `REPLAN:` names again. That plan review closes the old run, and the slice is handed on by its state there:
- Not final, with an implementer launch or stop in the old run, and no later review that counts as a fail: it moves whole into the new run, with its attempts and reviews.
- Final and passed: it counts as final and passed in the new run. That lasts until an implementer of it works there (a launch or a stop) or a review of it there counts as a fail. From then on it is judged like any other slice of the new run.
- Latest review counts as a fail, failed for good, or no implementer work in the old run: it starts clean in the new run.
- Not named by the new plan: it stays in the old run. [docs/brief-grammar.md "Run model", Carried slices]

**Cell.** One column of a benchmark matrix: a time cap or a token cap, for example `cap10` or `budget3M`. [bench/README.md "Commands, in order"]

**Checkpoint.** A commit the integrator makes before a parallel wave, of only the files earlier slices own, so that new worktrees start with that work. It reports the hash in its `CHECKPOINT:` field. Code in git only. [`.claude/agents/orchestrator.md` step 3]

**CHECKS.** The brief line `CHECKS: C1, C3`: the constraint ids a slice can break. Its reviewer answers each id. [docs/brief-grammar.md "Implementer brief"]

**Code (triage fact).** Whether the task changes source, tests, or build or CI configuration. It sets the parallel-slices file count (10 for code, 4 otherwise), whether git machinery is used, and, in `npm run auto`, whether web tools are allowed. A missing value counts as code. [CLAUDE.md; `src/config.ts` `TRIAGE`]

**Constraint answer.** A reviewer's reply line for one checked id: `C1: pass (cmd) <command> -> <result>`, `C1: pass (read) <file:line or URL>` or `C1: fail <reason>`. [docs/brief-grammar.md "Reply"]

**Constraints ledger.** The task's hard rules, written by the orchestrator as a `CONSTRAINTS:` line followed by `C<n>: <text>` lines in the PLAN REVIEW brief. [docs/brief-grammar.md "PLAN REVIEW brief"]

**Counted status.** How a review counts for the gates, which can differ from its STATUS line. A fail whose gaps are all below the gap cutoff counts as a pass with a doubt signal, and a gap validation replaces the earlier reviews of its attempt. [docs/brief-grammar.md "Review counting"]

## D

**Default agent.** The agent a plain `claude` starts as. This repo's `.claude/settings.json` sets it to the orchestrator; `npm run plain` clears it. The plugin never sets it. [docs/native-mode.md "Default agent of this repo"; `.claude/rules/agents.md` 1.4.4]

**Deny list.** Permission rules that refuse a tool call whatever any allow rule says: `permissions.deny` in Claude Code's settings, and the `--disallowedTools` list of every headless run (`UNSAFE_BASH` plus the headless git denies). They catch mistakes; they are not a security boundary. [docs/safety.md "Deny lists"; `scripts/orchestrate.sh`]

**Doubt (tokenizer).** What the Bash judge's tokenizer raises when it cannot read a command with confidence, for example an unterminated quote, brace expansion or a zsh-only expansion. The command is then denied. Not the same as a doubt signal. [docs/bash-judge.md 2.4; `Doubt` in `src/judge.ts`]

**Doubt signal.** A sign that a passing slice needs a second look: `risky`, `retry` (an earlier review counted as a fail), `read_answer`, `open_items`, `tests_failed_isolated`, `test_gate_gave_up` or `low_confidence_fail`. Any one of them means the slice is final only after an opus review passes after its latest implementer launch or stop. With `ORCH_ESCALATION=off` no signal counts; with `always` every slice carries one. [docs/brief-grammar.md "Doubt signals"; `doubtSignals` in `.claude/hooks/brief.mjs`]

**Draft (skill).** A new skill a skill slice writes, in a git worktree of the skills repository on branch `skill/<name>`. It is not installed until a person publishes it. [docs/skills.md "The draft worktree"]

## E

**Egress guard.** The guard that lets a reviewer's `WebFetch` reach only hosts its brief, its launch record or its slice's planned files name. [`.claude/hooks/egress-guard.mjs`]

**Escalation.** A triaged plain or reviewed run that fails its checks runs again on the orchestrate route. Its edits stay in your folder. Also called: route escalation. Not the opus review. [README.md "The three routes"]

**Eval suite.** Eight cases in `evals/` for `claude plugin eval`, which compares sessions with and without the plugin. Paid. [bench/README.md "Plugin eval suite"]

**Exec-env name.** An environment variable that makes git, a shell or the loader run another program, such as `PATH`, `PAGER`, `GIT_SSH_COMMAND` or `PS4`. The Bash judge denies setting one on a line that runs git, `rm` or a shell. [docs/bash-judge.md 2.5; `EXEC_ENV` in `src/judge.ts`]

## F

**Failed for good.** A slice whose latest review counts as a fail after 3 implementer attempts in the run (`MAX_RETRIES` 2). It is final; the review gate lets the reply out and names it as failed. [docs/brief-grammar.md "Final slice"]

**False success (benchmark).** A run whose final message claims success while the hidden tests fail. [docs/benchmarks.md "Method"; `bench/lib/claims.mjs`]

**Final slice.** A slice the run is done with. It failed for good, or its latest review counts as a pass and either no doubt signal fired or an opus review passed after its latest implementer launch or stop. A review with no STATUS is neither a pass nor a fail. [docs/brief-grammar.md "Final slice"]

**Fix slice.** An implementer slice of the 2026-11-16 audit that fixed findings, named `fix-...`. Each wrote a `fix-notes-*.md` file under `docs/data/audit-2026-11-16/`. [docs/research-2026-11-16.md "Scope"]

**Floor (judge).** The commands the Bash judge denies with no model call: `sudo` and similar, catastrophic or non-plain recursive `rm`, anything the tokenizer cannot read, and the other `deny` rules of bash-judge.md 2.1. Also called: the `deny` class. [docs/bash-judge.md 2.1]

**Floor (test gate).** The time a suite run must still have after the wait for the suite lock: min(120 s, budget / 4, the test run's own limit), at least 1 s. When the time left falls to it while another gate holds the lock, an isolated worktree in `warn` mode logs `tests_failed_isolated` with `not_run`; otherwise the suite runs anyway, without the lock. [docs/gates.md "Time budget and suite lock"]

**Fork subagent.** A subagent that inherits the whole conversation and its tools. Denied in this repo (`Agent(fork)`) and blocked while a run is open. [docs/native-vs-plugin.md "Fork subagents, built-ins and role limits"]

**Full path.** The orchestrator's way for any task that is not small: exploration, a plan review, slices with a reviewer each, and for code in git, worktrees and the integrator. [`.claude/agents/orchestrator.md` step 0]

## G

**Gap.** One problem a reviewer found, written `GAP: <0-100> <text>`; the number is its confidence that the gap is real. A line with no number counts as 100. [docs/brief-grammar.md "Reply"]

**Gap cutoff.** The confidence at or above which a gap fails a review: 80 by default (`ORCH_GAP_MIN`). [docs/brief-grammar.md "Review counting"]

**Gap key.** The first 8 hex characters of the sha1 of a gap's normalised text. Equal keys mean the same gap in two replies; the stall gate compares them. [`gapKey` in `.claude/hooks/brief.mjs`]

**Gap validation.** A review whose brief says `VALIDATE: gaps`: a fresh reviewer re-checks another review's gaps against the diff and keeps only those that stand, before a retry. In the gated workflow the same step is called the refute pass. [docs/brief-grammar.md "Review counting"]

**Gate.** A hook that blocks a worker launch, a worker's stop or the final reply until a check holds. Every gate only denies, except the plan check, which may also change a launch. [docs/gates.md "Gates at a glance"]

**Gated workflow.** `.claude/workflows/orchestrate.js`, a Claude Code workflow that runs the orchestrate route with its order fixed in code. Only the person starts it (`/orchestration:orchestrate`, project copy `/orchestrate`). Also called: scripted flow. [docs/native-mode.md "The gated workflow"]

**Give-up.** What a gate does after its loop guard runs out: it lets the launch or reply through and logs `<reason>_gave_up` (or `max_blocks_reached`). [docs/gates.md "Loop guards"]

**Guard.** A deny-only hook that narrows what one role can do: the researcher guard and the egress guard. Guards are not a security boundary. [`.claude/rules/agents.md`, 0.4.0 hooks]

## H

**Hand-back.** A worker delivering its reply through Claude Code's `SubagentHandback` tool (in auto mode). The report check and the quote check read the reply there, before it is delivered, and for an implementer the test gate runs there too (the hand-back gate). [`.claude/hooks/handback-check.mjs`; docs/gates.md "Hand-back gate"]

**Headless run.** A run with no interactive session: `npm run native`, `npm run auto` or the benchmark, through `claude -p`. [docs/native-mode.md "Headless runs"]

**Hook.** A script Claude Code runs at an event (a tool call, a stop, a session start). Exit code 2 blocks; any other non-zero code only warns. [`.claude/rules/agents.md`]

## I

**Implementer.** The worker that builds one slice: code, a document, an analysis or an operation. Opus, medium effort, at most 80 turns; every tool except `Agent`. [`.claude/agents/implementer.md`; `src/config.ts`]

**Integrator.** The worker that, for code in git only, writes checkpoint commits, merges passing branches, runs the slices' acceptance checks and then the whole suite once. It never resolves a conflict. [`.claude/agents/integrator.md`]

**Interface-first plan.** For large work with separable parts: slice 1 writes the shared interfaces, types and stubs (for documents, the outline and shared definitions), and the other slices run against them. [`.claude/agents/orchestrator.md` step 0]

**Isolated worktree.** A git worktree under `<project>/.claude/worktrees/` where one parallel code slice runs (`isolation: "worktree"`). The test gate only warns on failures there by default. [docs/native-mode.md "Parallel slices"]

## J

**Journal.** The run's log of parsed brief and reply fields: launch records in `journal-launches.jsonl`, stop records in `journal.jsonl`. Never brief or reply text. Also called: run journal. [`.claude/hooks/journal.mjs`]

**Judge.** The Bash judge. It denies the floor at once and passes everything else. It sends `git push`, git remote changes and a plain recursive `rm` to an opus model, with the user's request as the only authority. It runs in SDK workers by default and in native sessions only with `ORCH_JUDGE=native` (the native judge hook). [docs/bash-judge.md]

## L

**Light path.** The orchestrator's way for a small task: one slice, at most 3 files and under about 1,500 changed lines, nothing risky. One implementer (brief line `PATH: light`), then one reviewer; no exploration, plan review, worktrees or integrator. [`.claude/agents/orchestrator.md` step 0]

**Loop guard.** A gate's limit on repeating itself: most gates block twice per reason and scope, then give up. `file_overlap` and `dependency_cycle` never give up. [docs/gates.md "Loop guards"]

## M

**Matrix.** A benchmark file (`bench/matrix/<name>.json`) that lists tasks, arms, cells and repetitions. [bench/README.md "Commands, in order"]

**Mod.** A Claude Code function-hooks plugin module. The pane is one (`dashboard/register.tsx`). [docs/dashboard.md]

## N

**Nudge.** The plugin's SessionStart hook (`nudge.mjs`): it tells a new main session to run `orchestration:route` before a non-trivial task. The same file, at UserPromptSubmit, refuses a typed prompt holding the word `ultracode` (since 1.6.1). [docs/native-mode.md "The plugin"; docs/gates.md "Nudge"]

## O

**Opus review.** A review on opus (or a model whose name contains `opus`, `fable` or `mythos`) that a slice needs when a doubt signal fired, or always for a RISKY slice. The review gate blocks with `opus_review_required` until one passes. Also called: escalation rule (in the spec), opus escalation. Not the same as escalation. [docs/brief-grammar.md "Reviewer model", "Doubt signals"]

**Orchestrate route.** The route that plans the task, builds independent slices with a reviewer each, behind the gates. Also called: the pipeline. [README.md "The three routes"]

**Orchestrator.** The planning agent of the orchestrate route: Fable, high effort. It only delegates: it has no Edit, Write or Bash. [`.claude/agents/orchestrator.md`]

**Output style.** The Claude Code style a plain session runs in. Headless plain sessions and `npm run plain` use Concise; `ORCH_OUTPUT_STYLE` changes it for headless runs. [`scripts/orchestrate.sh`; `package.json`]

## P

**Pane.** The live view of a run beside the chat, drawn by the plugin's mod. Off at every session start; `/orchestration on` turns it on. Also called: dashboard, live dashboard, orchestration pane. [docs/dashboard.md]

**Plain route.** One session does the task alone in your folder, with no workers. Also called: plain session; in the SDK pipeline, `solo`. [README.md "The three routes"]

**Plan check.** The gate that checks every implementer launch against the run's reviewed plan (`.claude/hooks/plan-check.mjs`). It is the only hook that may also change a launch (raise a model, add notes or skill suggestions). [docs/gates.md "Plan check"; `.claude/rules/agents.md`]

**Plan review.** A reviewer launched with a brief that starts with `PLAN REVIEW`, holding the task, the constraints ledger and the planned slices. Without `REPLAN:` it opens a new run; implementers of the run wait until it has finished. [docs/brief-grammar.md "PLAN REVIEW brief"]

**Plugin setting.** A switch the plugin declares as `userConfig`, set in `/config`. An environment variable of the same switch wins. [docs/settings.md "Plugin settings"]

**Prompt store.** The native judge's record of what the person typed: `<CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/judge-prompts/<project key>/prompts.jsonl` (folder 0700, file 0600), outside the project. It is the native judge's authority; a Bash command that names it is refused. [docs/bash-judge.md "Native hook"]

## Q

**Quote check.** The gate that looks up each researcher `QUOTE: <locator> | <verbatim text>` line in its source and sends the researcher back once when a quote is not there. A quote from a URL or a scan is unverifiable and never blocks. [`.claude/hooks/quote-check.mjs`]

## R

**Read router.** An opt-in part of the plan check: for a researcher brief with `SOURCES:`, it profiles the files and raises the researcher's model to the tier the files need (haiku, sonnet or opus). It never lowers a model. [docs/gates.md "Read router"]

**Replan.** A plan review whose brief has `REPLAN: <n>`. It plans only the missing work and extends the open run with new slices and constraints (with no run open, it opens one). One that finishes clears a stalled slice. The orchestrator sends at most one per run. [docs/brief-grammar.md "PLAN REVIEW brief"; docs/native-mode.md]

**Reply.** A worker's final message: `STATUS:`, one answer per checked id, `OPEN:`, and optional `GAP:`, `QUOTE:`, `DRAFT:`, `SKILLS-USED:` and `SKILLS-SKIPPED:` lines. Also called: report. [docs/brief-grammar.md "Reply"]

**Report check.** The hook that sends a worker's reply back once, before delivery, when it has no STATUS line or a reviewer's pass leaves a checked id unanswered. Also called: hand-back check. [`.claude/hooks/handback-check.mjs`]

**Researcher.** The worker that answers one narrow question with evidence (file paths or URLs). Sonnet, low effort, at most 15 turns; read-only tools held by the researcher guard. [`.claude/agents/researcher.md`]

**Researcher guard.** The guard that holds a researcher's Bash to its read-only list: no redirection except `2>/dev/null` and `2>&1`, no substitution, no reads of devices, FIFOs, `/proc` or `/sys` (globs judged on what they may expand to). [`.claude/hooks/researcher-guard.mjs`]

**Review gate.** The Stop gate. It gates every slice of the latest run that an implementer worked on, plus the slice of the session's last implementer. It blocks the final reply until each of them has a passing review after its latest attempt (or failed for good), with its checked ids answered and any needed opus review and replan done. [`.claude/hooks/review-gate.mjs`; docs/gates.md "Review gate"]

**Reviewed route.** One session does the task, then one fresh reviewer checks it. [README.md "The three routes"]

**Reviewer.** The worker that checks one slice, or a plan, with a fresh context. Sonnet, medium effort, at most 40 turns; it never edits files. [`.claude/agents/reviewer.md`]

**Risky.** A task or slice where a wrong result is costly: security, authentication, payments, data migrations or deletion, public API changes, production operations, content published outside the team. A RISKY slice gets an opus review from the start. [README.md "Choosing a route (triage)"]

**Route.** One of three ways to run a task: plain, reviewed or orchestrate. Triage picks one. [README.md "The three routes"]

**Run.** The unit the gates check, within one session. A plan review without `REPLAN:` opens a planned run and closes any open run; a light-path launch opens a light run when none is open; a replan extends the open run. A run closes when every slice is final, and a closed run never reopens. A new user prompt does not close it; an idle run goes stale. [docs/brief-grammar.md "Run model"]

## S

**SDK pipeline.** The TypeScript orchestrator in `src/` on the Claude Agent SDK (`npm run sdk`). Code in a git repository only. Frozen: maintenance only. Its roles are planner, explorer, writer, verifier, triager and solo. Also called: the pipeline. [docs/sdk-pipeline.md; CLAUDE.md]

**SDK worker.** One agent the SDK pipeline starts for a role: planner, explorer, writer, verifier, triager or solo. The ones with Bash (solo, writer, verifier) run the Bash judge. [docs/sdk-pipeline.md "What it is"; `rolesFor` in `src/config.ts`]

**Seal.** `provenance.json` in a draft skill's folder: a hash of every file. Any change after sealing breaks it. [docs/skills.md "The seal"]

**Shared folder.** The project folder itself, outside any worktree. Work that changes no code, and code outside git, runs there. Also called: shared tree. [docs/native-mode.md "Parallel slices"]

**Skill gate.** The gate that checks a skill slice's draft at the implementer's stop: frontmatter, validator, no secrets or home paths, only the skill folder and README.md changed, a valid seal. [docs/skills.md "The skill gate"]

**Skill slice.** An implementer slice with `KIND: skill` that drafts one new skill. At most one per run. [docs/skills.md "Creating a skill"]

**Skill suggestions.** A short block the plan check appends to an implementer, researcher or reviewer brief: at most 3 installed skills (1 for a reviewer, 2 on opus or above), names and reason codes only. Also called: skill hints. [docs/skills.md "Suggestions"]

**Slice.** One part of a task that one implementer builds, with its own id (`SLICE:`) and its own files (`FILES:`). Two slices may share a file only when DEPENDS orders them. [docs/brief-grammar.md "Implementer brief"; `.claude/hooks/plan-check.mjs`]

**Slice state.** What the gates know about one slice of a run, computed from the logs by `foldRuns`: its launches, attempts and reviews, whether it passed, is final or is stalled, and its doubt signals. [docs/brief-grammar.md "Run model"; `foldRuns` in `.claude/hooks/brief.mjs`]

**Stale run.** An open run with nothing running and no launch, stop or agent start for `ORCH_RUN_STALE_MIN` minutes (30 by default). The plan check treats it as closed; the review gate still gates its unreviewed slices. The pane uses 10 minutes. [docs/brief-grammar.md "Run model"]

**Stall limit (Claude Code).** Claude Code ends a subagent that makes no progress for 600 seconds; it reports it as stalled. Not the same as a stalled slice. [Check 7 in docs/data/live-checks-2026-11-16.md; `CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS`, docs/settings.md "Test gate time"]

**Stalled slice.** A slice whose retry failed on the same gap again. Its latest counted review is a fail, and so is the latest counted review of an earlier attempt, with only fails between them. The two share a gap key, and no replan has finished since. The plan check and the review gate then block with `replan_required`. A slice that failed for good is never stalled. [docs/brief-grammar.md "Stall"]

**State dir.** The folder the hooks log to: `.claude/state/` in a repo that registers its own hooks, otherwise a per-user folder of the plugin. [docs/logs.md "Where logs go"; `.claude/hooks/state.mjs`]

**Static prefix.** The start of a shell word as the Bash judge reads it: its literal pieces joined, quoted or not, up to its first dynamic or glob piece. `"PATH=/x"` and `PA"TH=/x"` both give `PATH=/x`. [docs/bash-judge.md 2.5]

**STATUS rule.** How a reply's verdict is read: any `STATUS: fail` line fails it; otherwise the first `STATUS:` line decides; quoted lines, a STATUS in mid-line and the template `STATUS: pass or fail` do not count. [`parseStatus` in `.claude/hooks/brief.mjs`]

**Suite lock.** `test-gate.lock` in the state dir. The test gate holds it while it runs a suite, so one suite runs at a time per project, worktrees included. [docs/gates.md "Time budget and suite lock"]

**Switch.** An environment variable named `ORCH_*` that turns a gate or feature on or off or sets a value. Named only in maintainer text. [docs/settings.md; `.claude/rules/agents.md`]

## T

**Table word.** A shell word whose static prefix is the name of one of zsh's function, alias or `commands` tables followed by `=`, `+=` or a `[...]` subscript, or that name after an assigning builtin. The Bash judge denies it except as an argument of a text-only command such as `grep` or `echo` (`TEXT_ONLY`). [docs/bash-judge.md 2.1]

**Telemetry.** Per-agent records at SubagentStart and SubagentStop in `telemetry.jsonl`: tokens, turns, models. Headless runs fill them only with `ORCH_SESSION_PERSISTENCE=1`. [docs/logs.md "Telemetry"; `.claude/hooks/telemetry.mjs`]

**Test baseline.** When the tests fail at an implementer's stop, the test gate runs the same command on a clean copy of the base and names the failures that also fail there. [docs/gates.md "Test baseline"; `.claude/hooks/bugfix-check.mjs`]

**Test gate.** The gate that runs the project's tests when an implementer stops (`.claude/hooks/verify.sh`) and blocks while they fail; it also runs at an implementer's hand-back. It judges the files from `git status`, never the worker's word. [docs/gates.md "Test gate"; `.claude/rules/agents.md`]

**Tier.** The model a file needs to be read well, as the read router decides: haiku, sonnet or opus. [`READ_TIERS` in `src/config.ts`]

**Tokenizer.** The Bash judge's reader of a command line: `tokenize` in `src/judge.ts`, copied in `.claude/hooks/judge-core.mjs`. It runs and expands nothing. It splits the line into simple commands and words and marks what the shell would fill in. The researcher guard uses it too. [docs/bash-judge.md 2.4]

**Triage.** One read-only Sonnet call that reports five facts about a task (files, lines, independent slices, risky, code); plain code turns them into a route. [README.md "Choosing a route (triage)"]

**Triager.** The agent that does triage: Sonnet, low effort, read-only. [docs/native-mode.md "Roles"]

**Turn limit.** A worker's maxTurns. A worker that reaches it stops with no reply and fires no SubagentStop. [`.claude/rules/agents.md`, turn budget]

**Turn warning.** A message our worker gets once, at 80% of its maxTurns, telling it to commit its work and send its reply now. It never blocks. [`.claude/hooks/turn-budget.mjs`]

## W

**Wave.** Slices launched together in one message to run in parallel. [`.claude/agents/orchestrator.md` step 3]

**Worker.** One of this repo's four launched roles: researcher, implementer, reviewer, integrator. Also called: subagent, agent. [CLAUDE.md]

**Workflow agent.** An agent the gated workflow starts. It makes no Agent tool call, so the plan check never sees it; the test gate and the review gate do. [docs/native-mode.md "The gated workflow"]

**Worktree.** A second working folder of the same git repository, on its own branch. Parallel code slices in git each get one. [docs/native-mode.md "Parallel slices"]
