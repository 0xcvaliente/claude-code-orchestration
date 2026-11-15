# Changelog

All notable changes to this project are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.4.2] - 2026-11-15

1.4.2 fixes a hole in the test gate, hardens the gated workflow, the brief parser, the plan check and the guards, and adds three aids for runs: a turn warning, a check that a worktree starts from the checked-out work, and a coverage note for researchers. Upgrading: no plugin setting changed. Two new switches are read from the environment only (`ORCH_TURN_WARNING=off`, `ORCH_SOURCES_NOTE=off`). A plan whose FILES use a `**` glob beside a file that does not exist yet is now blocked as an overlap: name the folder or the files instead. A researcher may write `2>/dev/null` and `2>&1`. The new hook and the changed gates take effect in a new session.

### Added

- **A turn warning** (`.claude/hooks/turn-budget.mjs`, a PostToolUse hook with no matcher, registered last in `.claude/settings.json` and the plugin's `hooks.json`). An agent that reached its turn limit stopped without a report, and nothing told it the limit was near. Now, the first time a researcher, implementer, reviewer or integrator of this plugin has used 80% of its maxTurns, the hook adds as context: "You have used N of your M turns. Commit your work and report now; list what is unfinished under OPEN." Once per agent; it never blocks. The registered command is an sh pre-filter that starts node only when the payload holds an `agent_id`, so a main-session tool call starts no node process. `telemetry.mjs` now runs its hook code only as the entry script and exports its turn count (`usageFromTranscript`) and `maxTurnsOf` for this hook; its records are unchanged. Off with `ORCH_TURN_WARNING=off` (environment only, no plugin setting).
- **The plan check blocks a worktree that would miss the checked-out work** (`worktree_base_not_head`, `.claude/hooks/plan-check.mjs`). A session started in a parent folder of a repository does not load the repository's own settings, so its worktrees started from the remote default branch. An implementer launch with `isolation: "worktree"` is now blocked when the effective `worktree.baseRef` is not `"head"` and the repository's HEAD differs from `refs/remotes/origin/HEAD`. The setting is taken from the first of the session project's `.claude/settings.local.json`, its `.claude/settings.json` and the user `settings.json` that sets it (a file sets it only when `worktree` is an object with a string `baseRef`). An unreadable or invalid settings file, or commits that cannot be resolved, let the launch through as before. Two blocks per slice, then the launch goes through as `worktree_base_not_head_gave_up`. When an earlier rule also gave up on the same launch, the record's reason is that earlier rule's `<reason>_gave_up`, and `worktree_base_not_head_gave_up` is listed in its `gave_up` field.
- **A coverage note for researchers with several sources** (`.claude/hooks/plan-check.mjs`). A launch of this plugin's researcher whose `SOURCES:` names two or more distinct local files gets a note appended: read every file in full, with several Read calls in one turn, and end the report with a `FILES-READ:` line; a file not read goes under OPEN. Off with `ORCH_SOURCES_NOTE=off` (environment only).

### Changed

- **The plan check matches FILES globs** (`.claude/hooks/plan-check.mjs`). A glob counted as its literal prefix, so a planned `**/*.ts` covered every file in the project, and `*.md` beside `src/a.ts` was a `file_overlap` on every try. Now `*` matches within one path segment, `**` (a whole segment) across segments and `?` one character. A planned glob covers only the files that match it; a planned folder still covers what is under it. Two FILES entries overlap when some path could match both. An entry without glob characters stands for itself and everything under it unless it exists on disk as a regular file: a name that does not exist yet may become a folder (`docs/v1.2`, `conf.d`). The cost: a `**` glob beside a file that does not exist yet counts as an overlap. What cannot be decided counts as an overlap.
- **Researchers may write `2>/dev/null` and `2>&1`** (`.claude/hooks/researcher-guard.mjs`). A stderr redirection written exactly `2>/dev/null` or `2>&1`, outside quotes and comments and as a word of its own, writes no file and is allowed. Every other redirection is still refused, `2> /dev/null` with a space and `2>/dev/nullx` included; a command with ANSI-C quoting (`$'...'`) is checked unchanged, so the form is refused there.
- **The test gate stops a run with SIGTERM, then SIGKILL** (`.claude/hooks/verify.sh`). At its limit a run's process group gets SIGTERM, and SIGKILL 5 s later if the leader is still there (`LIM_GRACE_S`). A run signalled at its limit counts as timed out whatever exit status it returns (a suite may exit 0 on SIGTERM); the hook keeps that fact itself, from its watchdog's exit status, not in a file the suite could delete. The bugfix check's limit is the time left less those 5 s, and only a timed-out test run can add them (875 s, still under the 900 s hook timeout).

### Fixed

- **A gated-workflow review that failed without naming a gap passed the slice** (`.claude/workflows/orchestrate.js`). Such a verdict now counts as one hard gap ("the reviewer failed the slice without naming a gap"), so the slice is retried or fails.
- **The gated workflow built a slice whose dependency had failed** (`.claude/workflows/orchestrate.js`). It could pass. Waves are now decided from the results: a slice runs once everything it depends on passed, and a slice with a failed dependency is not built and is reported failed with the gap "depends on failed <id>", as is every slice that depends on it.
- **The gated workflow took a failed or partial merge as done** (`.claude/workflows/orchestrate.js`). The integrator's result was not read, the log said `done` and every built slice was reviewed as merged. The integrator now answers through a schema (`status`, `merged`, `open`); a built slice whose branch (or id) is not in `merged` fails before review with "branch <name> not merged by the integrator (<why>)", and a missing or malformed result merged nothing.
- **The gated workflow crashed on a plan without `files` with the plan check off** (`.claude/workflows/orchestrate.js`). `files` and `dependsOn` are now made arrays for every planned slice, whether or not the plan check runs.
- **`**OPEN: none**` read as an open item** (`.claude/hooks/brief.mjs`, mirrored in `dashboard/register.tsx`). An OPEN value that is an empty word (`none`, `-`, `n/a`, `nothing`) wrapped in or followed by emphasis or backticks (`**OPEN: none**`, `OPEN: _none_`, `` OPEN: `none` ``) gave a false open item and so the `open_items` doubt signal, and the review gate asked for an opus review for nothing. It now means nothing open.
- **A slice id read differently in a plan and in a launch** (`.claude/hooks/brief.mjs`, mirrored in `dashboard/register.tsx`; spec in `docs/brief-grammar.md`). `SLICE: "A1"` in a plan was not planned, and `SLICE: A1.` was planned as `A1` but launched as `A1.`, a `not_in_plan` block. Both now use one rule: the first word of the value without quotes, backticks and `*`, with trailing `:,;.` removed.
- **Two spellings of one path could have two owners** (`.claude/hooks/plan-check.mjs`). `file_overlap` compared FILES as written, so `/abs/project/src/a.ts` and `src/a.ts` were two files. Both sides are now normalised against the project folder before the comparison. `file_overlap` still blocks every time.
- **The plan check's lock and logs** (`.claude/hooks/plan-check.mjs`). The launch lock holds an owner token and is removed only by its owner, inside a try: a lock taken over after it went stale is no longer removed by the launch that lost it, and a failed removal no longer ends the hook. The launch log and the skill-create log are read for this session's lines only.
- **The egress guard ignored the port** (`.claude/hooks/egress-guard.mjs`). `https://cited.example:8443/` passed when the brief named `https://cited.example`. Hosts are now compared with their port, a scheme's default port counting as none (`https://a.example:443` is `https://a.example`).
- **The compact-context hook cut the constraints first** (`.claude/hooks/compact-context.mjs`). Over its 1,500-character cap the text was cut at the end, so the constraint texts and the final reminder went first. Now the slice lines give way first: their FILES lists are dropped, then the lines that do not fit, ending in "- +N more slices". The constraints block is cut only when it does not fit beside the header and the reminder. When everything fits it prints what it printed before.
- **The test gate's temp folder could vanish mid-run, and a `KIND: bugfix` stop was then allowed** (`.claude/hooks/verify.sh`, `.claude/hooks/bugfix-check.mjs`). A race introduced with the test-run limit in 1.4.0: the watchdog of `run_limited`, stopped with SIGTERM before it had reset the traps it inherited, ran the hook's EXIT trap and deleted the hook's temp folder; the bugfix check was then skipped and the stop allowed as `tests_passed` (3 of 240 runs under load). The watchdog now drops the EXIT trap first and is stopped with SIGKILL before its limit. The hook makes its folder again before each use, and a bugfix stop whose helper input or answer was lost blocks with the new reason `bugfix_tmp_lost`, counted under the bugfix cap (two blocks, then `bugfix_unverified_gave_up`).
- **A stopped bugfix helper left its base worktree registered** (`.claude/hooks/bugfix-check.mjs`). A `finally` does not run when a signal ends the process, so base worktrees stayed in `git worktree list`. On SIGTERM, SIGINT or SIGHUP the helper now kills its base runs' process groups, removes each base worktree, its record and its temp folder, and exits with no answer.
- **Tests that failed only under machine load** (`src/test-gate-v2.test.mjs`, `src/gate-hardening.test.mjs`, `bench/run.test.mjs`). They no longer depend on machine speed: the `run_limited` tests write their own output files and give bash time to set its TERM trap, the terminal gate test's time bound no longer assumes a fast machine, and the bench kill check waits up to 10 s for killed processes to be reaped before it checks their group is gone.
- **A base run that could not be used always read "timed out or failed without parsable test names"** (`.claude/hooks/bugfix-check.mjs`). The bugfix check (`KIND: bugfix`) now says why, with its own text per cause, and the gate record carries a `cause` detail under the existing reason codes (`bugfix_base_unusable`, `bugfix_no_base`): `lock_mismatch` (the base's lock file differs from the main checkout's, named in the message), `worktree_add_failed`, `base_timeout` or `no_test_names`. The `node_modules` link into the base worktree passes the folder link type Windows needs (`junction`). A pytest id that contains a space (a parametrized id such as `test_x[a b]`) is now parsed whole; it was dropped.
- **npm's placeholder test script counted as a test command** (`.claude/hooks/test-cmd.sh`). A `package.json` whose test script is exactly `echo "Error: no test specified" && exit 1` (whitespace trimmed) is treated as having no test script; any other script still is the test command.
- **Tests and `npm run claude-update` failed in a git worktree without its own `node_modules`** (`scripts/claude-update.mjs`, `src/plugin-state.test.ts`, `src/claude-update.test.mjs`). Five tests failed there, and the `sdk` check reported the Agent SDK as not installed. They now resolve the Agent SDK and tsx the way Node does, so a parent folder's `node_modules` counts. `writeSource` builds both texts before writing, so it writes `builtin-agents.mjs` and `settings.json` both or neither. The plugin version check tells whether a plugin is read from this checkout by path segment, not by string prefix, so a sibling folder such as `/x/repo-old` is not taken for `/x/repo`.
- **A refusal by the researcher guard gave no way forward** (`.claude/hooks/researcher-guard.mjs`). For a command outside the allowed list the message now says what to use instead: for `cd`, absolute paths in the command (`git -C`); for `sed` and `awk`, the Read tool with offset and limit, or `head` and `tail`; for any other command, the allowed commands. A variable assignment gets the allowed commands too. Other refusals (a redirection, a substitution, an expansion, a refused option) keep their earlier message. What is allowed and denied is unchanged here (see Changed for `2>/dev/null`).
- **`npm test` left its temporary folders behind.** The tests create thousands of temp folders per run (git repositories, state dirs, fake homes) and most never removed theirs; after a day of runs they used every inode of a tmpfs `/tmp`, and unrelated commands failed with `ENOSPC`. `npm test` now runs through `scripts/run-tests.mjs`, which gives the two suites one temp root (`TMPDIR`, `TMP`, `TEMP`) and removes it at the end, also on an interrupt. `ORCH_KEEP_TEST_TMP=1` keeps the folder and prints its path.
- **Two dashboard tests timed out in `npm run test-dashboard`.** "stale work: the timer draws a last redraw" kept the pane mounted through ten minutes of 250 ms pulses, about 2400 redraws and 30 s against a 15 s limit; it now mounts the pane for the last seconds only (under 4 s) and checks the same sign-off. The tests that draw the pane at many widths or advance the clock by minutes took 2 to 5 s against the default 5 s limit and get 30 s (`SLOW` in `dashboard/register.test.tsx`).
- **The judge's linear-time test missed its limit under load.** `src/judge.test.ts` and `src/judge-hook.test.mjs` allowed 2 s per 20,000-word command and one took 2.1 s on a heavily loaded machine; the limit is 8 s, still far below the 27 s the code needed before the fix.

## [1.4.1] - 2026-11-15

1.4.1 hardens the Bash judge and the researcher guard. Upgrading: no setting changed. A quoted word that starts with an exec-env name and `=` (`PATH=`, `GIT_SSH_COMMAND=`, ...) is now denied on a line that runs git, rm or a shell, as the unquoted word already was, even when it is only an argument such as `git log --grep 'PATH='`: run that search as its own command. For a researcher, an unquoted glob in an option is denied: write `rg -g '*.md' x`.

### Changed

- **The exec-env rule reads a word's static prefix, quoted or not** (`.claude/hooks/judge-core.mjs`, `src/judge.ts`, [docs/bash-judge.md](docs/bash-judge.md#25-the-exec-env-rule)). The static prefix is the text of a word's literal pieces joined, quoted or not, up to its first dynamic or glob piece. When it starts with an exec-env name (`PATH`, `PAGER`, `GIT_SSH_COMMAND`, `LD_PRELOAD`, ...) and `=` or the append form `+=`, the line has an exec-env assignment, wherever the word stands and whatever command precedes it. So `env "PATH=/x" git status`, `env PA"TH=/x" git status`, `export "GIT_SSH_COMMAND=sh -c id"; git fetch` and `PAGER+=evil git log` are denied on a line that runs git, rm or a shell, like the unquoted form was on 1.4.0. The judge no longer models where `env`'s or a launcher's own words end; a word is an assignment by its spelling alone. Out of reach, as before: a dynamic name part (`env ${P}ATH=/x git status`), `env -S` strings, and assignments never spelled `NAME=` (`read PATH`, `printf -v PATH`).
- **Cost of that rule (accepted).** Such a word is denied on a line that runs git, rm or a shell even when it is only an argument: `git log --grep 'PATH='`, `grep 'PATH=' f && git status`. The deny message says to run the search or echo as its own command. `grep -rn 'PATH=' src` alone still passes.

### Fixed

- **`find ... -rm` passed the judge.** `-rm` is bfs's name for `-delete`, and `find` with either is now denied (`judge-core.mjs`, `src/judge.ts`).
- **A long command could outlast the judge hook's timeout.** The judge's analysis was quadratic or exponential in the number of words: a command of 20,000 words took seconds (one form took about 27 s on 1.4.0) and a hook killed at its timeout does not block. The analysis no longer rescans earlier words for each word and stops at the first deny, and the same command now takes well under a second (about 0.15 s) (`judge-core.mjs`, `src/judge.ts`, tested in `src/judge-hook.test.mjs` and `src/judge.test.ts`).
- **The judge hook parsed every session's prompts.** `judge-hook.mjs` skips a line of `prompts.jsonl` that cannot hold this session's id before parsing it; the session check after parsing still decides.
- **The researcher guard missed a device path attached to an option and a glob in an option name** (`researcher-guard.mjs`). `grep --file=/dev/zero x` and `grep -f/dev/zero x` are denied like `grep x /dev/zero`; `/dev/null` stays allowed in each place. A glob in an option's name (`tail -?`, `rg -g*.md x`) is denied in any command, because the shell may expand it into another option, such as `-f` or `-delete`; the message says to quote the glob (`rg -g '*.md' x`) or use the long form (`--glob=*.md`). A glob in a long option's value (`--include=*.ts`) still passes.
- **Nothing proved the judge was never weaker than 1.4.0.** `src/judge-differential.test.mjs` runs the vendored 1.4.0 judge (`src/fixtures/judge-core-1.4.0.mjs`) against the current one over the judge tests, the corpus and generated forms: nothing 1.4.0 denies passes or is judged, nothing it judges passes, and a new deny comes only from the exec-env rule or `find -rm`.

## [1.4.0] - 2026-11-15

1.4.0 lets the orchestrator use skills, lets a run draft one new skill, keeps the orchestration pane closed until you turn it on, and gives the test gate a time limit. Upgrading: three new plugin settings (`skill_create`, `skills_repo_private`, `skills_repo_public`, all empty by default); no existing setting changed. The pane now stays closed in every terminal, herdr included, until you type `/orchestration on`, at every session start. Two new environment switches, read from the environment only (no plugin setting): `ORCH_TEST_TIMEOUT_S` (the test run's limit, default 600 s) and `ORCH_HOOK_BUDGET_S` (the whole test gate, default 870 s).

### Added

- **The orchestrator can load skills.** Its tools gain `Skill` (`NATIVE_TOOLS.orchestrator` in `src/config.ts`; checked live on Claude Code 2.1.325: a main-thread agent whose tools name `Skill` sees the installed skills and can load one). Before planning it may load at most two installed skills that shape the plan itself (domain rules, architecture, a threat model), because each loaded skill stays in its context for the whole run; every other fitting skill still goes to the workers by name on `SKILLS:` lines. The route skill and the session nudge carry the same rule.
- **A skill decision per planned slice.** In a PLAN REVIEW brief each slice may carry `SKILLS: <names>` or `SKILLS: none`, and a RISKY slice always carries one of the two. The plan reviewer treats a named skill that is not installed or does not fit the slice, and a RISKY slice with no decision, as gaps. The plan check counts only a `SKILLS:` line before the first `SLICE:` line of a PLAN REVIEW brief as names for the plan reviewer itself.
- **Skills in the gated workflow.** A planned slice may carry `skills` (at most 5 plain skill names). Its implementer and reviewer briefs then carry a `SKILLS:` line after the header lines the workflow already writes; a slice without skills gets exactly the briefs it got before.
- **A run can draft one new skill** ([docs/skills.md](docs/skills.md)). When no installed skill covers knowledge the task needs and that knowledge is reusable, the orchestrator may plan one skill slice (`KIND: skill`, `SKILL: <name>`, optional `TARGET: public` and `UPDATE: yes`); it proposes the skill first when a person can answer. The plan check blocks it with `skill_create_off`, `skill_name_invalid`, `skill_repo_missing`, `skill_exists` or `skill_limit`, and on an allow appends the facts the implementer needs (repository, draft worktree, branch `skill/<name>`, validator, seal command, the authoring skill `skill-authoring`). The draft is a git worktree of the private skills repository unless the slice says public. A new SubagentStop hook, the skill gate (`skill-gate.mjs`), checks the draft's SKILL.md, the repository validator, secrets and personal details, the seal (`skill-seal.mjs`, a `provenance.json` of file hashes) and that the branch is committed. Later slices read the draft through `DRAFTS: <name>`; the skill slice replies `DRAFT: <name> <branch>`. New settings: `skill_create`, `skills_repo_private` and `skills_repo_public` (20 plugin settings in all).
- **`npm run skill-publish`** (`scripts/skill-publish.mjs`), for a person to publish a draft: it verifies the seal and the validator, checks the draft is committed, pushes `skill/<name>` (never a force push) and opens a pull request whose body names the skill, the target, the provenance digest and that an agent created it. `--merge` merges the pull request, fast-forwards the repository, runs its installer and removes the draft worktree; `--dry-run` prints the steps; with no name it lists the drafts. No agent or hook pushes or installs a skill.
- **Reply lines `SKILLS-USED:` and `SKILLS-SKIPPED:`.** A worker whose brief named or suggested skills ends its report with them. `parseReply` returns `skillsUsed` and `skillsSkipped`, the dashboard mirrors them, and the journal keeps them on the stop record as `skills_used` and `skills_skipped` (skill names only, at most 8 each, left out when empty, so a reply without them is journaled as before).
- **A Skills section in `npm run report`**: per skill how often it was suggested, used and skipped; the drafts created with the skill gate's result; and the skills worth revising (skipped three or more times, or used in a slice whose review failed). Reports of runs without skills are unchanged.
- **Headless runs say whether they finished.** `scripts/orchestrate.sh` passes claude's exit code to `scripts/run-result.mjs` and `scripts/log-run.mjs`. `orch_totals` gains `exit_code` and `complete` (true only when the exit code is 0); both are left out when the exit code is not known. A run cut short after an interim wake-up still ends with a result, and `complete: false` marks that result as an interim one. `runs.jsonl` carries the same two fields, `null` when neither `orch_totals` nor the argument gives the exit code.

### Changed

- **The orchestration pane is off until you turn it on** (`dashboard/register.tsx`, [docs/dashboard.md](docs/dashboard.md)). It is off at every session start in every terminal, herdr included; the herdr check is gone. `/orchestration on` turns it on and opens it focused, `/orchestration off` turns it off and closes it, `/orchestration` alone switches between the two, and the choice lasts for the session. While it is on, a typed prompt, an orchestration agent's start and a route verdict open it as before, and on a terminal narrower than 144 columns a toast says to type `/orchestration on`. While it is off nothing opens it, but the run is still recorded, so turning it on mid-run shows the run so far. The dashboard's hooks catch their own errors: a failing state write, `ui.open` or command registration never fails the prompt, agent start, tool call, turn or session start it wraps.
- **The test gate has a time budget** (`.claude/hooks/verify.sh`). A hook killed at its timeout (900 s) does not block, so the whole hook now ends within `ORCH_HOOK_BUDGET_S` (default 870). The test run gets `ORCH_TEST_TIMEOUT_S` (default 600) or the time left, whichever is less. The test baseline's base run and the bugfix check get only the time left: each base run gets the smaller of `ORCH_BASE_TIMEOUT_S` and its share of the time left less 10 s, and the helper is killed when the budget runs out. A bugfix check that has no time left or is killed blocks a `KIND: bugfix` slice with `bugfix_timeout`, counted with the other bugfix blocks. Both switches are read from the environment only; neither is a plugin setting.
- **A reviewer on opus or above gets up to 2 suggested skills** (was 1). The limit follows the launch's effective model: the call's `model`, else the agent file's. A sonnet reviewer, or a launch whose model cannot be ranked, keeps 1. Implementers and researchers keep 3. No model default changed.

### Fixed

- **A test suite that hung let the implementer finish.** The test gate ran the suite with no limit of its own, so a hanging suite ran until Claude Code killed the hook at its timeout, and a killed hook does not block. The suite now runs in its own process group and is killed with its children at the limit; the stop blocks as a test failure (`tests_failed`, with `timed_out` and `limit_s` in the gate record) under the same loop guard, and no base run follows. A suite that reads the terminal fails at once instead of stalling until the limit.
- **The review gate's loop guard missed block records without a timestamp.** It counted only earlier `block` records whose `ts` was at or after the last implementer's stop; a record with no `ts` now counts too (`review-gate.mjs`).
- **The gates parsed every session's log lines.** `readJsonl` in `run.mjs` takes a session id and skips another session's lines before parsing them, and `review-gate.mjs`, `handback-check.mjs` and `quote-check.mjs` read each log once per call; a record just written is read back from the end of the log only (`appendJsonl`).
- **Test-gate records had whole-second timestamps.** `verify.sh` now writes milliseconds, like the node hooks, so the run model orders a test-gate record against a stop in the same second.
- **The test gate misread event fields holding an escaped quote or backslash.** `verify.sh` reads `agent_type`, `agent_id`, `session_id` and `cwd` up to the closing quote, not the first escaped one, and undoes `\"`, `\\` and `\/`.
- **`npm run skill-publish` could push or merge commits the seal never covered.** It records the sealed branch's head, refuses to push when origin's `skill/<name>` holds commits that head does not, and `--merge` merges with `gh pr merge --match-head-commit <that head>`, so nothing pushed after the checks is merged (`scripts/skill-publish.mjs`).
- **A sealed skill file that git did not track passed.** The seal covers every file on disk, but an ignored or untracked file is never pushed. The skill gate and `npm run skill-publish` now fail when a file under `skills/<name>` is not committed on the branch, and a branch lookup that fails is a git-state failure in the gate (`skill-gate.mjs`).
- **The subagent status line parsed every session's launches.** `subagent-statusline.mjs` skips lines of other sessions before parsing and indexes the launches once per refresh.
- **`statusline/statusline.sh` could stall on git and showed no 7-day reset date on Linux.** It runs `git --no-optional-locks status` without untracked files (the count is of changed tracked files), kills a git that takes more than about a second and shows no count then, and kills git and removes its temp file when it is killed itself. Non-numeric values no longer break it, the 7-day window shows its reset date on Linux as well as macOS, and it reads its fields in one `jq` call.

## [1.3.0] - 2026-11-14

1.3.0 changes which model each role runs on, keeps Haiku out unless you allow it, and fixes the run log of headless runs. Upgrading: the plugin has one new setting, `allow_haiku` (empty by default), and no existing setting changed. Runs cost more than on 1.2.2, because the orchestrator and the implementer each moved up one model; one small two-part task measured $1.08 at list price against $0.81 before.

### Changed

- **Models: Fable plans, Opus does the tasks, Sonnet does the rest, and no Haiku.** The orchestrator (SDK planner) runs on Fable 5.2 (was Opus). The implementer (SDK writer) and the plain session (`npm run auto`'s plain route, the SDK's solo role) run on Opus (were Sonnet; the plain session used to run on whatever model Claude Code defaulted to). The researcher (SDK explorer) runs on Sonnet (was Haiku). The reviewer, integrator and triager stay on Sonnet, and the Bash judge and the escalated reviews stay on Opus. The third and last attempt of a slice is still a fresh implementer on Opus, which is now the same model as the first attempt. Cost per run goes up: the benchmark figures in the README were measured with the earlier models and the triage thresholds were set against a plain Sonnet session, and neither was measured again. `ORCH_MODEL_<ROLE>` and `ORCH_MODEL` still override each default.

### Added

- **The haiku rule.** `plan-check.mjs` raises a launch of any of this plugin's agents to sonnet when its model is in the haiku family (the call's `model`, else the agent file's `model:` line, so an agent file copied from an earlier version is covered). `ORCH_ALLOW_HAIKU=1` or the new plugin setting `allow_haiku` turns the rule off; `CLAUDE_CODE_SUBAGENT_MODEL` is left alone. Each raise goes to `model-floor.jsonl` in the state dir. The read router is unchanged: it only raises a model, so with a Sonnet researcher its haiku tier changes nothing.

### Fixed

- **The run log recorded the last wake-up of a headless run, not the run.** `claude -p` answers once per wake-up of the session: an orchestrator that launches agents stops, is woken by each agent's result and stops again, and every stop is a result with its own `num_turns` and `duration_ms`. `--output-format json` prints the last one only, so `runs.jsonl` logged a run of two minutes and three agents as `duration_ms: 8320` and `turns: 1`. `scripts/orchestrate.sh` now asks for the event stream (`--output-format stream-json --verbose`) and `scripts/run-result.mjs` reduces it to the document the script prints: the last result as before, plus `orch_totals` with `results` (how many results the session produced), `turns` (`num_turns` summed over them) and `wall_ms` (the run's wall time, measured by the script). `scripts/log-run.mjs` writes those two totals to `turns` and `duration_ms`. Tokens were already right: `modelUsage` in the last result covers the whole session. Rows logged before this fix keep their low figures. The bench's `num_turns` still comes from each document's own `num_turns`; its `N-UC` arm runs `claude` itself and keeps `--output-format json`.

## [1.2.2] - 2026-11-14

1.2.2 follows Claude Code 2.1.323 to 2.1.325. Claude Code updated itself and the update went around two things this repo relies on; both are fixed, and a script now checks for the same kind of change after every update.

### Fixed

- **`web-fetch`, a built-in subagent added in Claude Code 2.1.325, was not blocked.** The block list named six built-in types by hand in three places. The plan check took `web-fetch` for somebody's own agent, so a session with an open run could hand work to it and no gate saw that, and `permissions.deny` in this repo did not deny it. The names now live in one file, `.claude/hooks/builtin-agents.mjs`: the plan check reads it, `DENIED_AGENTS` in `src/config.ts` is built from it, and `policy.test.ts` keeps `permissions.deny` in step. Headless runs were not affected: `CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` still removes every built-in (checked on 2.1.325).
- **Claude Code's auto memory ran inside the judge and the SDK workers.** Each `claude -p` call of the native judge left an empty `~/.claude/projects/<temp folder>/memory` folder and carried the auto-memory instructions in its prompt; an SDK worker could write memory notes under its throwaway worktree's project folder. The judge hook, the SDK judge and every SDK worker now run with `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` (`workerEnv` in `src/judge.ts`).

### Added

- **`npm run claude-update` (`scripts/claude-update.mjs`).** Run it after Claude Code updates. It asks the installed Claude Code for its built-in subagent types (its start-up answer in safe mode; no model call) and fails when one is not on the block list; checks that the headless switches still leave no built-in agent, that the options `scripts/orchestrate.sh` and the native judge pass are still in `claude --help`, that the Agent SDK carries the same Claude Code as the installed one, that an installed plugin is current, and that `dist/` matches the sources. `--fix` repairs the machine: it writes newly found built-in types to `~/.claude/orchestration/builtin-agents.json`, which the plan check reads at once, and updates a stale plugin install. `--enable` installs and enables the plugin when it is off (`--fix` never turns it on: the plugin is opt-in). `--write-source` is for a maintainer: it adds the new types to `builtin-agents.mjs` and `permissions.deny` and rebuilds `dist/`. Details in [docs/claude-code-updates.md](docs/claude-code-updates.md).

### Changed

- Agent SDK 0.3.325 (it carries Claude Code 2.1.325; 0.3.322 carried 2.1.322, so the SDK pipeline ran an older Claude Code than the installed one). `@types/node` 26.6.6.

## [1.2.1] - 2026-11-10

### Fixed

- `npm run report` counted an agent once per stop record. An agent stops more than once (the test gate sends an implementer back, a resume, the stops around a hand-back) and each record carries its running total from the transcript, so the role table, and the cost table added in 1.2.0, counted such an agent's tokens two or three times: in the logs of 2026-11-01 to 11-03 implementer cache reads came out 72% to 76% too high. Both tables now take each agent's last stop record, and "Agents" counts agents. The figures in [docs/research-2026-11-10.md](docs/research-2026-11-10.md) that came from the same sums are corrected.

## [1.2.0] - 2026-11-10

1.2.0 follows Claude Code 2.1.317 to 2.1.322 and closes three gaps found while researching it ([docs/research-2026-11-10.md](docs/research-2026-11-10.md), probes in [docs/data/live-checks-2026-11-10.md](docs/data/live-checks-2026-11-10.md)). It also carries the bug fixes from a read-only audit of the hooks, the SDK pipeline, the scripts and the dashboard, merged after 1.1.0; each of those has a test that failed before it. The brief and reply grammar, the gate reason names and the agent names are unchanged; one gate reason and one setting are new.

### Added

- Review gate: `implementer_unfinished`. A subagent that stops at its turn limit fires no SubagentStop (probed on Claude Code 2.1.322), so the test gate never ran for it and the journal counted no attempt: a turn-limited implementer could leave partial work that no gate saw, and with no other implementer the gate allowed with `no_implementer_in_session`. The gate now blocks while an implementer launched with the Agent tool has a SubagentStart and no later SubagentStop, until it is resumed and stops or a later implementer stop takes its slice over; two blocks, then `implementer_unfinished_gave_up` ([README, The gates](README.md#the-gates), [docs/brief-grammar.md, Gates](docs/brief-grammar.md#gates-slice-a1)).
- `handback-check.mjs` (PreToolUse on `SubagentHandback`, auto mode). A worker's report is read before it is delivered and sent back once when it has no `STATUS` line, or when a reviewer's pass leaves an id of its `CHECKS` line unanswered. `quote-check.mjs` runs on the same event, so an unverified quote is corrected before the orchestrator sees the report instead of after. Setting `handback_check` (`ORCH_HANDBACK_CHECK=off`), the 16th.
- Estimated cost in `npm run report`: cost by role and model at list prices (`scripts/prices.mjs`), the agents that started and never stopped, and cache rewrites. Telemetry records `tokens.cache_write_1h` and `cache_rewrites` (numbers only).
- A subagent status line shipped by the plugin (`subagent-statusline.mjs` through the plugin's `settings.json`): each worker's row shows its slice, attempt, model, tokens and progress.

### Changed

- The researcher's Bash list includes read-only search and paging: `grep`, `rg`, `find`, `head`, `tail` and `cat`, held by `researcher-guard.mjs` to forms that cannot write a file or start a program. On macOS and Linux Claude Code leaves the Grep and Glob tools out of an agent whose tools also name Bash, so a researcher launched from a plain session could not search at all: the logs since 2026-11-01 show 43 guard denials in about 26 researcher runs.
- A passing review on opus or a stronger model (`fable`) meets `opus_review_required`. The escalation still launches on opus by default.
- SDK pipeline (maintenance): Agent SDK 0.3.296 to 0.3.322, and the Bash judge's hook is registered with `onFailure: "block"`, so a guard that throws or returns nothing blocks the command.
- The orchestrator, the route skill and the nudge tell the session how to answer `implementer_unfinished` and never to accept a partial result as finished; the implementer waits for a command that was moved to the background before it reports.

### Fixed

- `npm run check-plugin` no longer fails after `npm run eval`: the eval writes its reports to `dist/plugin/evals/results` (ignored by git), which the comparison with a fresh build now leaves out.
- Hooks: a slice id that names an `Object.prototype` property (`constructor`, `__proto__`, `toString`) no longer throws in the run fold, and the Stop gate blocks instead of exiting 1 and letting the reply through when the run state cannot be read. `test-cmd.sh` detects `scripts.test`, not the word "test" anywhere in `package.json`.
- SDK pipeline: `waves()` breaks only real cycles and keeps a dependency that failed or is still pending, so a slice no longer runs without its dependency's work; a planner slice named `result` no longer collides with the integration branch; a bare 500/502/503/504 in error text is no longer retried as transient.
- Bash judge: `git config` keys that run programs (`difftool.*.cmd`, `mergetool.*.cmd`, `sendemail.*`, `web.browser`, `interactive.difffilter`, `init.templatedir`) are denied like the existing ones, in `src/judge.ts` and `.claude/hooks/judge-core.mjs`.
- Scripts: `scripts/auto.sh` resolves a relative repo path against the caller's folder (a missing folder is an error) and `scripts/report.mjs` reads legacy `runs.jsonl` rows without `subagents`.
- Workflow and UI: `maxRetries: 0` means no retries in the gated workflow; the status line prints a fallback when `jq` is missing; the dashboard progress step no longer shows a reviewer reply without a STATUS line as done (display only, run sign-off is unchanged).

### Known and not fixed

- The token budget restarts on `--resume` and is not applied to the plain and reviewed routes; the judge's own tokens are outside every budget.
- The bash judge does not read the shell string passed to `parallel`, `flock -c` or `script -c`, and still lets through `difftool.<n>.path`, `mergetool.<n>.path` and `browser.<n>.cmd`.
- The `/route` skill passes `$ARGUMENTS` inside double quotes, so a task containing quotes or `$(...)` is expanded by the shell.
- CI does not run or typecheck the dashboard.
- In the dashboard, the pipeline review cells and the phase state still read a reviewer reply without STATUS as done; `docs/dashboard.md` still says it shows as done.

## [1.1.0] - 2026-10-31

1.1.0 is the first stable release and the first tagged one. It is 0.4.0 plus the follow-ups listed under Fixed and Added. There was no 1.0.0 tag, and the versions before this one were not tagged.

### Fixed

- A slice is final only when its escalation rule is met: its latest review passed and it has no doubt signal, or a passing opus review came after its latest attempt. A run no longer closes on a sonnet pass that still needs an opus review, so that review and any further launch of the slice join the same run (ea62c55; [README, The gates](README.md#the-gates), [docs/brief-grammar.md, Run model](docs/brief-grammar.md#run-model)).

### Added

- `ORCH_SESSION_PERSISTENCE=1` keeps session and subagent transcripts in headless runs (`npm run native`, `npm run auto`, the bench), so telemetry records per-agent tokens, turns and models. Unset, headless runs behave as before (ec46ad9; [README, Telemetry and the read log](README.md#telemetry-and-the-read-log)).
- The `d3-reader` bench task (twelve questions over seven documents), the `reader-haiku`, `reader-sonnet` and `reader-routed` arms, and the route-040 benchmark of the read router (17fe23b, 69535bb). Results at n = 2 runs per arm, one task, direction only: the routed arm scored higher than the other two with fewer researcher tokens than `reader-sonnet`, but the model raise and the converted-text notes are confounded, and H14 is not called supported ([docs/benchmark-route-040.md](docs/benchmark-route-040.md)).
- A live probe of the `agent.spawn` mod hook for workflow agents: it runs under `claude -p`, fires for workflow agents and can rewrite their model and prompt. Routing workflow agents this way is feasible but not implemented (724d66f, 9ff6199; [docs/data/live-checks-workflow.md](docs/data/live-checks-workflow.md)).

### What 0.4.0 brought

Details in [README, What 0.4.0 adds to the gates](README.md#what-040-adds-to-the-gates) and [docs/research-2026-10-31.md, Implementation status](docs/research-2026-10-31.md#implementation-status-040).

- Brief and reply lines: `SOURCES:` and `READ:`, `KIND: bugfix`, `VALIDATE: gaps`, `SKILLS:`, `GAP: <0-100>` and `QUOTE:` ([Briefs and replies](README.md#briefs-and-replies)).
- Review precision: the gap cutoff (`ORCH_GAP_MIN`, default 80), validation of gaps before a retry, opus on the third attempt, and the native stall gate (`replan_required`).
- The test baseline (`inform` by default, `allow` opt-in) and the bugfix check for `KIND: bugfix` slices.
- Guards: the researcher Bash guard and the reviewer egress guard, both deny-only. The quote check for researcher `QUOTE:` lines. Plan and constraint re-injection after compaction (`compact-context.mjs`).
- The read router, opt-in (`ORCH_READ_ROUTER=on`) ([How a worker launch is shaped](README.md#how-a-worker-launch-is-shaped)).
- Skill suggestions in the plan check, on by default (`ORCH_SKILL_HINTS=off` to drop).
- Telemetry v2: tokens, turns, models and max-turn hits per agent, the file trail and the read log.
- 15 plugin settings as `userConfig`, bridged to the `ORCH_*` variables; an environment variable still wins ([Switches and plugin settings](README.md#switches-and-plugin-settings)).
- The gated workflow (shipped in 0.3.0) gained `gapMin`, `planCheck`, `planReview`, `refute` and `escalateLast`, all on by default ([The gated workflow](README.md#the-gated-workflow)).
- The native Bash judge hook is registered with `onFailure: "block"` and a 120 s timeout.

### Stability

In 1.x, these do not change incompatibly:

- The brief and reply line grammar ([docs/brief-grammar.md](docs/brief-grammar.md)).
- Gate reason names, such as `file_overlap`, `not_in_plan`, `replan_required` and `opus_review_required` ([README, The gates](README.md#the-gates)).
- The agent names (`researcher`, `implementer`, `reviewer`, `integrator`, `orchestrator`) and the `orchestration:` plugin namespace.
- The `userConfig` keys and the `ORCH_*` switches, with their defaults.
- The install path: marketplace `0xcvaliente/claude-code-orchestration`, plugin `orchestration`.

These stay opt-in or experimental and may change in a minor release:

- The read router (`ORCH_READ_ROUTER`); H14 is undecided.
- The native Bash judge hook (`ORCH_JUDGE=native`).
- The advisor (`ORCH_ADVISOR`).
- The eval suite (`npm run eval`), which has not been smoke-run.

Frozen: the SDK pipeline in `src/`, maintenance only since 0.3.0.

Known limitations are listed in [README, Known limitations](README.md#known-limitations).

### Upgrading

Installed plugin copies pick up the new version after a `/plugin` update or a reinstall, then `/reload-plugins`. No `userConfig` key or default changed after the 0.4.0 release commit (fc7360e), so there is nothing to migrate in settings. `ORCH_SESSION_PERSISTENCE` is a new environment variable for headless runs, not a `userConfig` key, and leaving it unset keeps the earlier behaviour. The one behaviour change is the finality rule above: a run waiting for a slice's opus review now stays open until that review runs or the run goes stale.

## Earlier versions (not tagged)

- 0.4.0 (56ec956 set the version; fc7360e completed the release with the README): see What 0.4.0 brought above.
- 0.3.0 (b193fdf): the gated workflow shipped in the plugin, the deny-only native Bash judge hook (opt-in), the plugin eval suite, native-workflow bench arms, and a plan-check fix for legacy records.
- 0.2.0 (e08d4ca): the review gate waits for running agents, run-scoped plan checks with plan conformance, the constraints ledger and opus escalation, and one parser for briefs.
- 0.1.1–0.1.13 (8c561fc to b287d2d): plugin packaging with the session nudge, a handback-aware review gate, runner detection, the per-implementer review loop guard, no double hook runs, plugin state outside user repos, and the dashboard pane.

[1.4.2]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/v1.4.2
[1.4.1]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/v1.4.1
[1.4.0]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/v1.4.0
[1.3.0]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/v1.3.0
[1.2.2]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/v1.2.2
[1.2.1]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/v1.2.1
[1.2.0]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/v1.2.0
[1.1.0]: https://github.com/0xcvaliente/claude-code-orchestration/releases/tag/v1.1.0
