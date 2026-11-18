# Safety

What protects your machine and your repository when the orchestrator runs, and what does not. Each layer gets a few lines here; the details and the exact limits are on the page that owns it, linked from [Limits by page](#limits-by-page). Read this before you run it on a repository you care about.

The short version: the deny lists, the [judge](glossary.md#j) and the [guards](glossary.md#g) catch mistakes. None of them is a security boundary. The boundary is a sandbox, a container or a VM.

## What protects what

| Layer | Protects against | Does not protect against | Details |
|---|---|---|---|
| Deny lists | Pushes, remote changes, `sudo`, `rm -rf` spellings, destructive git forms in headless runs, built-in subagent and fork launches | Any command spelled to get around a pattern; code run through `npm` or `node` | [Deny lists](#deny-lists) |
| Bash judge | Pushes, remote changes and recursive deletes the user did not ask for | Scripts, interpreter strings, the Edit and Write tools, other tools that push | [The Bash judge](#the-bash-judge) |
| Guards | A researcher's Bash writing or running things; a reviewer fetching hosts its brief does not name | Bash reaching the network | [Guards](#guards) |
| Sandbox | File writes outside the working folder, network hosts not on the list | Anything its settings leave open; it is off unless you turn it on | [Sandbox](#sandbox) |
| Worktrees | Git state of parallel slices | Shell writes outside the worktree | [Worktrees](#worktrees) |

## Deny lists

Permission rules in Claude Code's settings. A deny rule beats every allow rule.

- **Interactive sessions in this repo.** `.claude/settings.json` denies `git remote`, `sudo` and the `rm -rf` spellings, the built-in subagents listed in `BUILTIN_AGENTS` (`.claude/hooks/builtin-agents.mjs`) and fork. It does not deny `git push`: an interactive session may push as its permission mode allows.
- **The plugin cannot ship deny rules.** Add the ones you want to your own `.claude/settings.json` or `~/.claude/settings.json`. Without them, the [plan check](glossary.md#p) still blocks fork and built-in launches while a run is open (`builtin_agent_in_run`).
- **Headless runs** (`npm run native`, `npm run auto`, through `scripts/orchestrate.sh`) run in `dontAsk` mode: anything not on the allowlist is denied, never prompted. `--disallowedTools` adds `UNSAFE_BASH` (`git push`, `git remote`, `sudo` and the `rm -rf` spellings) and these git denies, for headless runs only:
  - `git -c` and `--config-env` (also after `-C <dir>`);
  - `reset --hard` in any spelling of `--hard`;
  - `git clean` and `git <options> clean -<flag>`;
  - global options that take a separate value: `--namespace`, `--git-dir`, `--work-tree`, `--exec-path`, `--super-prefix`, `--attr-source` and a second `-C`;
  - since 2.0.0, 70 rules in all (`GIT_C_DESTRUCTIVE_DENY` in `scripts/orchestrate.sh`, the `CLOSED` rows of `src/orchestrate-sh.test.mjs`): 68 for the plain destructive forms of `git -C <dir>`, the subcommand word directly followed by a literal token such as `branch -D`, `checkout --`, `checkout .`, `reset --soft`, `stash drop`, `config core.` or `update-ref`, and 2 for `git --git-dir` or `git --work-tree` as the first word.

  `git -C <dir>` is allowed only with the subcommands the workers use (status, diff, log, show, rev-parse, ls-files, rev-list, `branch --show-current`, `worktree list`, `worktree add`, add, commit, merge, `reset --merge`). The write subcommands (`branch --show-current`, `worktree list`, `worktree add`, add, commit, merge, `reset --merge`) are pinned since 1.6.1 to the project folder (as given, its real path and its git top level) and `<repo>/.claude/worktrees/*`, and, with skill repositories set, to each skills repository and `<config dir>/orchestration/skill-drafts/*`; a headless run can no longer `git -C` with them into another folder. The read subcommands stay open for any folder. A folder with a character that cannot be pinned in a rule (`*`, `?`, `[`, a quote, a backslash, `$`, `(`) gets no write rule; one the plan check would quote (a space or a non-ASCII letter) gets its quoted forms. A `git -C` path holding `/../` is denied. Claude Code still warns at startup about the rules that need a `*` for a worktree's name: three, six with skill repositories ([live checks for 1.6.1](data/live-checks-2026-11-17-b.md), K10 and K2).
- **The workers are told never to push.** That is a prompt rule.

What the deny lists do not do:

- They guard against mistakes, not against a command built to pass them. A `git -C * status*` allow rule matches any git command with an allowed subcommand word as a later argument. Since 2.0.0 the plain destructive forms of that kind are denied (`git -C /r branch -D main status`, `git -C /r checkout -- . diff`), but `git -C /r branch -qD main status` and `git -C /r branch main -D status` still pass (the comment above `GIT_C_DESTRUCTIVE_DENY` in `scripts/orchestrate.sh`; [Limits, D](limits.md#d-headless-rules)).
- Without `-C`, `git branch -D` and `git worktree remove --force` are still allowed headless; `git -C <dir> worktree remove -<option>` is denied.
- They over-block too: a commit message that contains ` -c` or ` -C ` is refused headless, and since 2.0.0 so is a `git -C` commit message that holds a denied form after a space (`commit -m "see branch -D old"`, O1). Reword such a message.
- Headless runs allow `Bash(npm *)` and `Bash(node *)` (and the Python interpreter for a Python test runner), which can run any code.

Settings: [Headless runs](native-mode.md#headless-runs) and [Settings, Environment variables](settings.md#environment-variables) (`ORCH_ALLOWED_TOOLS`, `ORCH_EXTRA_ALLOWED_TOOLS`).

## The Bash judge

The Bash judge refuses a few commands outright (the [floor](glossary.md#f): `sudo` and similar, catastrophic or non-plain recursive `rm`, anything it cannot read). It sends `git push`, remote changes and a plain recursive `rm` to an opus model, with the user's own request as the only [authority](glossary.md#a). Every failure is a deny.

- **SDK pipeline.** On by default for the workers with Bash. `ORCH_JUDGE=off` turns it off; pushes and recursive deletes are then denied by rule. See [SDK pipeline, Bash judge](sdk-pipeline.md#bash-judge).
- **Native sessions.** Off by default. `ORCH_JUDGE=native` turns on the native hook. It is deny-only, so it cannot loosen any permission. See [Native hook](bash-judge.md#native-hook).
- **Where the native hook keeps your requests.** What you type is stored in `<CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/judge-prompts/<project key>/prompts.jsonl` (folder 0700, file 0600), outside the project and not in the [state dir](glossary.md#s). A Bash command that names that folder is refused.
- **Environment variables that run programs** (`PATH`, `PAGER`, `PS4`, ...) are denied on a line that runs git, `rm` or a shell. The list is in [The exec-env rule](bash-judge.md#25-the-exec-env-rule).
- **No-op forms that pass:** `GIT_EDITOR=true`, `GIT_EDITOR=:`, `git -c core.editor=true`, `git -c core.editor=:` and an empty `IFS=` ([Relaxed](bash-judge.md#relaxed)).

What it does not do:

- It sees one Bash command line. It does not see scripts, interpreter strings (`python -c`, `node -e`), the Edit and Write tools, or other tools that push (`gh`).
- A model can be wrong both ways, and the request is only as precise as what was typed.
- Some legitimate commands are refused. Examples: `PS4='+ ' bash -x`, a here-document delimiter with `$`, a backtick in a quoted subscript, `set -A`, `commands` as a variable name, `git config --get` of a key that runs a program, and a `filter-branch` filter that is refused as a command of its own. Each has a workaround in [The Bash judge, Limits](bash-judge.md#11-limits).

## Guards

Two deny-only hooks narrow what one role can do. `ORCH_GUARDS=off` turns both off.

- The **researcher guard** holds a researcher's Bash to read-only forms: no redirection except `2>/dev/null` and `2>&1`, no substitution, no reads of a device, a FIFO, `/proc` or `/sys` (since 2.0.0 also through a glob, judged on every path it may expand to). See [Researcher guard](gates.md#researcher-guard).
- The **egress guard** lets a reviewer's `WebFetch` reach only hosts its brief, its launch record or its slice's planned files name. See [Egress guard](gates.md#egress-guard).

A third guard covers every session, not one role. The **workflow guard** (1.6.0) refuses every Workflow launch except this repo's saved `orchestrate` workflow (a launch or a resume, its file checked by content since 1.6.1), so a workflow the model writes on the spot (Claude Code's `ultracode` keyword, or a plain request for a workflow) does not run outside the gates. `ORCH_WORKFLOW_GUARD=off` turns it off. See [Workflow guard](gates.md#workflow-guard).

What they do not do: they are not a boundary. Bash can still reach the network. Web search and fetch are read-only, and fetched pages are data, not instructions: that is a prompt rule plus the egress guard for reviewers, not a sandbox.

## Sandbox

The sandbox is the real boundary. Use it.

- **Native sessions.** Run implementer and reviewer Bash in Claude Code's sandbox with a network allowlist: the package registries and the hosts the task needs. The guards narrow what a researcher or reviewer can reach, but Bash can still reach the network.
- **SDK pipeline.** `ORCH_SANDBOX=on` runs the Bash roles in the SDK's OS sandbox, with writes allowed in the worker's folder and the temp folder and the network hosts in `ORCH_SANDBOX_DOMAINS`. It is opt-in and was smoke-tested on macOS only. See [The OS sandbox](bash-judge.md#9-the-os-sandbox-opt-in).
- **Untrusted repositories.** Run in a container or a VM.

## Worktrees

Parallel code slices run in git [worktrees](glossary.md#w). Worktrees isolate git state, not the file system. Claude Code blocks a worktree agent's edits and git commands into the main checkout, but not shell writes that do not use git, such as `cp` or `>` ([Claude Code worktrees](https://code.claude.com/docs/en/worktrees.md)).

## Other things to know

- **Operations tasks act with your permissions.** Triage counts production work as [risky](glossary.md#r), which buys an independent review. The review comes after the commands have run.
- **Model output is untrusted input.** Plans, slice ids, verdicts and triage facts are checked before use. A triage reply without `code` counts as code, the stricter side.

## Limits by page

Every limit is stated on the page it belongs to:

- [Gates and guards, Limits](gates.md#limits): the plan check's overlap rule, the stall gate, the test baseline, the quote check, the egress guard, the researcher guard, the read router, the review gate.
- [How the native orchestrator works, Limits](native-mode.md#limits): validation and opus on the third attempt are prompt rules, `baseRef` and the start folder, the gated workflow.
- [The Bash judge, Limits](bash-judge.md#11-limits): what the judge does not see, what it over-blocks, and the [native hook's limits](bash-judge.md#limits-of-the-native-hook).
- [SDK pipeline, Limits](sdk-pipeline.md#limits): what the SDK pipeline does not have.
- [Skills, Limits](skills.md#limits): the skill catalog, the skill gate and publishing.
- [Logs and reports, Limits](logs.md#limits): headless runs keep no transcripts by default.
- [The pane and status lines, Limits](dashboard.md#limits): the pane's own view of a run.
- [Benchmark, Plugin eval suite](../bench/README.md#plugin-eval-suite) and [Results](../bench/README.md#results): the benchmarks are small and show direction only.
