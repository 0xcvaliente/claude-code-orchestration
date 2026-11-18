# Limits of 2.0.1

This page lists what release 2.0.1 does not do (sections A to H since 2.0.0, I since 2.0.1): each item says why it stays and, where there is one, what to do about it. An item leaves this page only when a test or a recorded probe shows it handled, and then the changelog says so. Where a detail lives in another document, the item gives the summary and a link.

## A. Items carried from 1.6.1

The nine lines of the 1.6.1 changelog's "Known and not fixed" list. None of them is closed in 2.0.0.

- **K1, a sandboxed implementer writing skill drafts.** Still not shown live. The cause 1.6.1 recorded, `socat` missing, was not the whole cause: with `socat` installed the sandbox gets as far as its seccomp step and still does not start on the test machine, because the kernel restricts nested user namespaces (setting one up needs CAP_SYS_ADMIN) ([probes f4](data/probes-2.0.0-f4.md), Probe 3). `npm run claude-update` only checks that the `allowWrite` entry is there.
- **K2, the worker rows.** Rows in this plugin's format were captured in a live interactive session, pane off and pane on ([probes b2](data/probes-2.0.0-b2.md), Probe 1). The page records the session's own settings file and the installed plugin turned off, not the person's user settings, so which component drew the rows (the mod, or a `subagentStatusLine` of the person's own) was not established; the probe page says what would establish it.
- **K3 and O1, telling a typed prompt from other input.** It rests on the prompt's opening text (`typedPrompt` in `state.mjs`): Claude Code gives no field for it, and the prompt's own transcript record is written after the hook fires. A new kind of message, or a changed opening, counts as typed until `typedPrompt` learns it.
- **K7, `strictMcpConfig` alone.** Not shown to keep account connectors out in a long session, so every SDK role keeps passing both options. A decision.
- **K8, the dollar cap.** Claude Code checks a dollar cap after each request, so one request can overshoot `ORCH_BUDGET_TOKENS`. Treat the cap as a stop after the request that crosses it. A triage on a warm cache is never stopped by the smallest cap, 10k.
- **K9, the workflow guard's reach.** Out of reach: a session that loads no hook, a file changed between the check and Claude Code's read of it, the installed plugin's own file when the project copy decides (it checks the built `dist/plugin` copy), and any project that holds both matching files meets the plugin rule.
- **K10, warnings at startup.** Claude Code warns about the headless rules that need a `*` for a worktree's name: three, six with skill repositories. A `git -C * status*` read rule still matches a command built to pass it; 2.0.0 denies the plain destructive forms of that kind, and the rest is under [D](#d-headless-rules).
- **O4, the old `AUTO` benchmark rows.** They stay flagged (`triage_pre_fix`) and were not re-run: a re-run is a long campaign.
- **A test-gate block and the resume.** Where a worker hands its report back with `SubagentHandback`, the hand-back gate (`verify.sh --handback`) runs the suite first and sends a failing run back to the worker while it still runs ([probes b1](data/probes-2.0.0-b1.md), Run 1). It refuses only for failing tests, within the `tests_failed` cap and while the agent has had fewer than two other hand-backs refused since its latest start; every other outcome lets the report through, and the SubagentStop gate then decides after the report has reached the orchestrator. A block there still reaches the worker only through a resume, and the reviewer hold covers that case (below, under C). Since 2.0.1 every implementer stop the SubagentStop gate takes on leaves a record (an undecided exit logs `test_gate_error`, [probes stop-gate](data/probes-2.0.1-stop-gate.md)), except a gate killed with SIGKILL (I); the gate also read another agent's `agent_type` from `background_tasks` until 2.0.1 and so skipped some stops with no record (30 of 102 in the recorded session).

## B. Bash judge

The SDK judge and the native hook are a deny list that works without a sandbox: best-effort against mistakes, not a boundary. The detail, with examples, is in [The Bash judge, Limits](bash-judge.md#11-limits).

Out of reach:

- a wrapper program not on its list (`WRAPPERS` in `src/judge.ts`), and `ssh host ...`, which runs its words on another machine;
- a program name built at run time where it is not the command word (`cpulimit -l 5 -- $c root` passes; as the command word, `$c root`, it is refused), and an alias or function defined somewhere the guard does not see (a shell's start-up files, an earlier call);
- zsh's `PROMPT4` (`PS4` is read; `PROMPT4` is not);
- in the native hook's refusal of commands that name the prompt store: a glob built from a variable or a command substitution (`"$dir"/*`), a glob that names only a folder above the store, and a recursive tool given such a folder (`grep -r x ~/.claude`).

Over-blocks it states (refused although harmless; each is a row of `src/judge.test.ts` or was run through the classifier for this page):

- unquoted brace expansion (`echo {a,b}`, `cp x.{ts,js} out/`), refused since before 2.0.0;
- a dynamic command word after a keyword (`if $verbose; then ...`, `exec "$@"`);
- `PS4+=...` and `export -n PS1`;
- an unquoted `do`, `then`, `else` or `elif` word before a refused name (`echo do parallel`);
- a refused name anywhere after a wrapper (`xargs grep parallel`, `timeout 5 echo at`);
- a non-literal argument of `sg`, `su`, `runuser`, `flock`, `script` or `watch` (`sg docker -c "docker run $IMAGE"`, `flock /tmp/l ls *.ts`), and an option cluster of those that spells a refused command;
- `echo {rm}`;
- a command over 262,144 characters, or with more than 4,096 of one opener (`MAX_COMMAND_LENGTH`, `MAX_OPENERS`);
- a shell option outside the guard's short list of known harmless ones (`set -o vi`, `setopt autocd`, `shopt -s histappend`, `bash -o vi`; `set -e` and `set -o pipefail` pass): set such an option in a script file, or leave it out;
- `emulate` in any form but `emulate [-L] [-R] zsh` (`emulate sh` is refused);
- a prompt variable set to a value with an expansion (`PS1=$PS1`);
- assigning a variable named `options` (`options=1`, also after another assignment), zsh's options table: use another name;
- in the native hook, a relative glob after a `cd` to a folder it cannot read as one plain path (`cd "$dir" && ls *.txt`; a row of `src/judge-hook.test.mjs`).

## C. Guards and gates

- **The researcher guard is a guard, not a boundary.** Run researcher and reviewer Bash in Claude Code's sandbox for a boundary ([Safety](safety.md)).
- **The researcher guard's over-blocks:** a quote or backslash inside an unquoted bracket expression (`cat [\]]`; naming the file passes), a glob in the command name, a glob in a `sed` operand, `$'...'` quoting together with a glob in a reader's operand, and a command over 65,536 characters or with more than 256 `[` or `{` (`MAX_COMMAND`, `MAX_BRACKETS`). It also refuses a decision that runs past its 10 s deadline.
- **What the researcher guard does not judge:** a FIFO a command opens on its own (an ignore file rg or ugrep reads while searching, git's own files), a file created or swapped between the check and the run, zsh's extendedglob operators (off in a non-interactive shell), and a shell function or alias named `cd` (the comments at the top of `researcher-guard.mjs`).
- **The suite lock.** A reused pid keeps a dead holder's lock until it is 900 s old. Since 2.0.0 a takeover never frees the lock's name (it replaces a stale lock in one rename after checking a hard-link snapshot of it), but four cases stay open (the comment above `take_over` in `verify.sh`): a holder still alive when its lock is more than 900 s old (a machine suspended mid-run, a stopped hook) has its lock replaced while its suite may still run, a gate that links its lock while such a holder releases between a taker's snapshot and rename has it replaced, and such a holder can remove its successor's lock (or companion file) between `release_lock`'s token check and its removal, so two suites can run at once; two gates can be in the takeover at once after a guard folder left by a gate killed or stopped inside its takeover is 2 minutes old, and then the second rename replaces the first taker's new lock; a gate whose pid is the departed holder's, taking the lock within the same second, makes a lock with the very content judged stale, which the comparison then lets be replaced; a lock file that is empty for good (no gate makes one) is never stale, so every gate waits until its floor and then gets `not_run` (isolated) or runs without the lock (shared tree). The lock is per project. These and the other limits of each gate are in [Gates, Limits](gates.md#limits).
- **Bracket ranges** are judged by character code for ASCII names, not by the locale's collation; a name with a character outside ASCII is matched wider.
- **A `QUOTE:` whose source is not in the read cache** (missing, or a symlinked cache entry, which is never read) cannot be verified and passes as unverifiable.
- **Kept test output.** The test gate keeps the tail of a failed run's output under `<state dir>/test-output/` (folder 0700, files 0600). A test suite that prints a secret leaves it there. When `test-output` is a symlink to a folder, the gate does not refuse it: the helper writes through it into the target (its files are made under umask 077), and the gate changes the mode of neither the target nor its files (`note_failures` in `verify.sh`).
- **unittest failfast set by a script.** The `allow` baseline keeps the block when the command or a `.py`, `.cfg`, `.toml` or `.ini` file of the tree names failfast; a `-f` that a script puts into unittest's argv is not seen (`failFastInTree` in `bugfix-check.mjs`).
- **The reviewer hold is stricter with stop records that carry no hand-back id.** Without one, a failed-tests block since the agent's latest start holds the review, whatever came after it, so an ordinary fix loop is held until a passing stop is paired or the hold gives up after two refusals. And a record of an earlier stop that lands after a resume can still be taken for the new stop when it is the only candidate (checked against `stopGateOf` in `run.mjs`). Since 2.0.1 a stop with no paired record gets the pending note (`test_gate_pending`) only within the gate's window (`stopGateWindowMs` in `run.mjs`: its budget, 540 s by default, plus 60 s); past it, or with a `test_gate_error` record, the reviewer is told the gate left no result (`test_gate_no_result`), so a reviewer still runs the tests itself in both cases ([probes stop-gate](data/probes-2.0.1-stop-gate.md), path 4).
- **A test gate started by a worker that is not isolated runs in that worker's folder.** The orchestrator's step 6 no longer starts a non-isolated worker on another worktree's folder; the gate itself does not detect the case.
- **Plan check, path identity.** `file_overlap` now reads symlinks behind `**` and later wildcards, hard links and two Unicode normal forms of one name (`src/plan-check-paths.test.mjs`). Still out of reach: a link or hard link made after the launch, a hard link whose other name lies outside every entry's walk, and, in `not_in_plan`, every name that reading adds.

## D. Headless rules

The deny rules of `scripts/orchestrate.sh` stop mistakes, not a command built to pass them. Each class below is a `LIMITS` row of `src/orchestrate-sh.test.mjs`, which asserts that it passes:

- a destructive option inside a cluster or after another word (`branch -qD main status`, `branch main -D status`);
- an option the list does not name, or a long option cut short (`reset -q HEAD~3 status`, `branch --del main log`);
- a path after a revision or another path (`checkout HEAD -- src status`);
- a plain path, revision or branch name (`restore src status`, `reset main status`);
- a refspec after a word: `git -C <local remote> fetch "$PWD" main:main status` (audit J-11) passes these rules. The SDK judge and the native hook send a fetch or pull whose refspec writes a branch to the judge (`src/judge.test.ts`, J-11 rows); the headless rules have no judge;
- subcommands not listed, plumbing included (`read-tree -u --reset HEAD status`), and a config key of another section or case.

Also: a commit message that holds a denied form after a space is refused (`commit -m "see branch -D old"`, O1). Reword such a message. Without `-C`, `git branch -D` and `git worktree remove --force` stay allowed headless.

## E. Platform and design

- Telling a typed prompt from other input rests on its opening text (A, K3).
- A dollar cap can be overshot by one request (A, K8).
- A session started without hooks is out of every gate's reach.
- The pane reads the gates' settings (`ORCH_RUN_STALE_MIN`, `ORCH_GAP_MIN`, `ORCH_ESCALATION` and their plugin options) at each session start or reload (`loadSettings` in `dashboard/register.tsx`), while the hooks read them at each call. A setting changed during a session shows on the pane only after the next start or reload.
- The workflow guard's reach (A, K9).
- The startup warnings about rules with a `*` for a worktree's name (A, K10).
- `strictMcpConfig` alone (A, K7).
- **The Agent SDK and the installed Claude Code.** The repository is on Agent SDK 0.3.326 (`^0.3.326` in `package.json`, 0.3.326 in `package-lock.json`), which carries Claude Code 2.1.326, and CI installs Claude Code 2.1.326 (`.github/workflows/ci.yml`), so the two agree. A machine whose Claude Code has updated itself to a newer patch (2.1.327 was seen on the release machine) gets a note, not a failure, from the `sdk` check of `npm run claude-update`, and the SDK pipeline there runs the SDK's own bundled 2.1.326. It stays because an SDK bump is a dependency change with its own procedure, not part of this release; nothing in the native toolkit depends on it. To match: follow [Claude Code updates](claude-code-updates.md) (run `npm run claude-update` after every Claude Code update, install the Agent SDK whose patch number matches, then run `npm run check`).

## F. Not built

- Agents the workflow starts get no skill suggestions: they make no Agent call, so they never reach the plan check.
- Leftover worktrees and their branches are not removed after a run.
- A failed judge call's tokens count in the run total only when the failure carried usage.

## G. Benchmark and measurements

- No benchmark campaign was run for 2.0.0: nothing on this release is measured against earlier ones.
- The old `AUTO` rows (`triage_pre_fix`) are historical and were not re-run (A, O4).
- `npm run bench:validate` can need more than its 270 s deadline on a loaded machine. It then prints the finished tasks, names each unfinished one (`NOT DONE`) and exits 3. `node bench/validate.mjs --task <id>` validates one task; `--deadline-s 0` removes the deadline.
- The `py313.py` expectations of tasks k1 and k2 are recorded values: this machine has no CPython 3.13, so they could not be reproduced. Each file's docstring states which value each case holds and what 3.12 and 3.14 give ([probes f4](data/probes-2.0.0-f4.md), Probe 1).
- `bench/arms.test.mjs` skips one test in a clone that lacks the 0.3.0 ref.
- `npm run eval` has three graders that fail for reasons not understood yet ([CLAUDE.md](../CLAUDE.md), Commands; `docs/research-2026-11-10.md`, Open).

## H. Leftovers of the 2.0.0 development run

Three slices of the 1.6.0 run carry stale test-gate blocks in the state log (`gates.jsonl` in the [state dir](glossary.md#s), which for the plugin is per user). They are state, not a code defect; `npm run report` shows them.

The gates sequence diagram (`docs/diagrams/gates-sequence-light.svg` and `-dark.svg`) still says "[implementer allowed, or a researcher or reviewer (never blocked)]". That label predates the reviewer hold, which since 1.6.1 can refuse a reviewer's launch (`tests_failed_after_report`). The text of [docs/gates.md](gates.md) is correct.

## I. Found in 2.0.1 and not fixed

From the three probe pages of 2.0.1 and the reviews of its slices. The fixes are in the changelog's 2.0.1 entry.

**Claude Code's own behaviour behind the reviewer loop** ([probes reviewer-loop](data/probes-2.0.1-reviewer-loop.md), "Not fixable here"). 2.0.1 tells workers to avoid what starts these and tells the orchestrator to ignore the extra notifications; the behaviour itself is Claude Code's and stays.
- **The hand-back enforcement.** A worker that ends with text while `SubagentHandback` is offered gets Claude Code's `[handback-send-enforce]` message, hands back and stops a second time (about 5 s and one more SubagentStop). The journal marks the second stop `continues` and the fold counts one review.
- **A Bash command past 120 s is moved to the background**, and when it ends Claude Code wakes the subagent with a task notification, also after the subagent delivered its report. The worker bodies now ask for the Bash `timeout` parameter and for waiting on such a command before reporting; a worker that still leaves one behind is woken.
- **A new `completed` notification at every later stop** of the same agent, with a new `<result>` holding the woken turn's text. The orchestrator spends a turn on it; its prompt says such a notice is no new report.
- **The report arrives in two envelopes** (an agent message and the notification's `<result>`) at one delivery.
- **A typed prompt can reach a finished subagent** (seen once, 11 hours after delivery). A woken reviewer's stop with no STATUS line gets no stop record, so it adds no review.

**Test gate**
- **No reader can read the block count** (`gates.jsonl` replaced by a folder, so neither node nor grep reads it, and the block's own record cannot be written): `verify.sh` keeps blocking failing tests at every stop, with no cap. The only way to cap it is to let failing tests through on an unreadable log, and a person has to decide whether an unreadable gate log may do that. The bugfix check's count reads unknown as 0 and keeps blocking the same way. The soak exempts exactly this double fault from I1 ([probes soak](data/probes-2.0.1-soak.md), "For docs/limits.md").
- **A gate killed with SIGKILL** runs no trap and writes no record. The plan check then gives the no-result note once the stop is older than the gate's window ([probes stop-gate](data/probes-2.0.1-stop-gate.md), "Claude Code's own doing").
- **`background_tasks` is session-wide** in a SubagentStop event and lists other agents' types. `verify.sh` now parses the event as JSON; without node it falls back to its text match, which can read another agent's value.
- **A stop with no agent id** shares one `tests_failed` cap per session with every other such stop ([probes soak](data/probes-2.0.1-soak.md), finding 5).

**Journal and fold**
- **A headless woken implementer counts as a new attempt.** Without a transcript the journal cannot tell whether the woken implementer worked (a tool call) or only wrote text, so its stop is recorded, as before ([probes soak](data/probes-2.0.1-soak.md), finding 2).
- **A headless resume without STATUS in its last message is dropped.** Without a transcript a resumed reviewer whose new report has no STATUS line in its last message cannot be told from a wake. A report delivered with `SubagentHandback` is not affected ([probes soak](data/probes-2.0.1-soak.md), finding 3).
- **A torn last log line with no newline** merges with the next record written after it, which is then lost to the readers.

**Tests**
- **The CPU-time bound in `src/judge.test.ts`** (2000 ms) failed once at 3285 ms while other tests ran, and did not reproduce. CPU time is not wall time, but a loaded machine still slows it; there is no evidence to change the bound, and `src/judge.ts` was not touched. Next step: run the judge test 20 times beside `npm test` and record the distribution ([probes soak](data/probes-2.0.1-soak.md), finding 9). `src/gate-hardening-time.test.mjs:108` failed the same way once with 13 test files running side by side and passed alone (finding 10).
- **`src/test-gate-lock.test.mjs:114`**, "two gates that find the same stale lock side by side: one takes it over, the suites never overlap", failed once on CI at `4ecf82f` (run 44270898410, "one suite after the other": `false`) and passed on the pull request's run at `bc04989`. Not investigated: the slice that fixed the other test of that run ([probes ci](data/probes-2.0.1-ci.md)) was asked about that test only and did not own the lock test. Next step: run the test 20 times alone and beside other test files and record the rate.

**Reviewers' notes below the cutoff.** Possible issues raised in the reviews of the 2.0.1 slices with a confidence under the cutoff. None is established as a defect; each stays until a test shows it either way.
- `review-gate.mjs` `block()` (:92-109) and `plan-check.mjs` `decide()` (:942-967) may leave a block record that was not returned: when the record is written but its read-back (`appendJsonl`) fails, the reply or launch goes through as `<reason>_unrecorded`, yet the written block can still be counted by the loop guard (`review-gate.mjs` :226-231 and :358; the plan check's `prior`), so a later block may give up one try early.
- `verify.sh` (:585-590) exits 0 when node itself fails on a valid event (a crash or a resource limit), the same way as for input that is not a JSON object: that stop is then not gated and leaves no record.
- `journal.mjs` (:296) judges a woken stop by the stop's last message (`last_assistant_message`): a woken reviewer that writes a STATUS line in that turn is recorded as a new review.
- `handback-check.mjs` (:139-146) leaves a deny record in `gates.jsonl` that did not read back, followed by an allow `<reason>_unconfirmed` whose `voids` names it; a reader that counts denials without reading `voids` counts it.
- The soak's invariants leave out agents without an id (I3, I4 and I7 check only agents with one) and exempt from I4 a headless text stop whose STATUS line is missing or only in the transcript (`unknowable` in `scripts/soak-gates.mjs`); what happens there is checked by the unit tests only.
