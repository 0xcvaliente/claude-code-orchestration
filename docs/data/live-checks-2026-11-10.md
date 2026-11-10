# Live checks, 2026-11-10 (Claude Code 2.1.322)

Three checks behind 1.2.0. Checks A and B ran `claude -p` in a scratch folder with `--setting-sources project`, so only that folder's agents and hooks were loaded. Check C is what the research session itself logged. Summary and decisions: [research-2026-11-10.md](../research-2026-11-10.md).

## Check A: a turn-limit stop fires no SubagentStop

**Question.** When a subagent reaches `maxTurns`, does the SubagentStop hook run?

**Setup.** One agent, `probe` (`model: haiku`, `maxTurns: 2`, `tools: Bash`), told to run the commands in its brief one Bash call at a time. A logging command hook on SubagentStart, SubagentStop, PostToolUse (`Agent|Task`) and Stop appended the event name, agent id and Stop's `background_tasks` to a file.

```bash
claude -p "Launch the probe agent (subagent_type: probe) with exactly this brief: 'Run these five commands, one Bash call each: echo 1, then echo 2, then echo 3, then echo 4, then echo 5.' When it returns, tell me in one line what it reported, and do not launch it again." \
  --model haiku --permission-mode dontAsk --allowedTools "Agent" "Bash(echo*)" --setting-sources project --output-format json
```

**Result.** The whole hook log of the run:

| Time (UTC) | Event | Detail |
|---|---|---|
| 17:48:34.231 | SubagentStart | `agent_type: probe` |
| 17:48:34.232 | PostToolUse | `Agent` (the launch returned at once) |
| 17:48:35.910 | Stop | `background_tasks: ["subagent:running"]`; the reply says the agent is still running |
| 17:48:40.235 | Stop | `background_tasks: []`; the reply says "The probe agent stopped at its 2-turn limit after 2 tool cal…" |

No SubagentStop. The main session was told the agent stopped at its limit, and the final Stop listed no running task.

**Agrees with the logs.** Of 535 subagent starts recorded between 2026-10-31 12:00 and 2026-11-10, two have no stop record: the two researchers that hit their 15-turn limit in the research session. Among 594 stop records with a `max_turns_hit` field, none is `true`.

**Consequence.** `verify.sh` (the test gate) and `journal.mjs` run at SubagentStop, so a turn-limited implementer was never tested and had no stop record: the fold counted no attempt, the review gate did not gate its slice, and with no other implementer in the session the gate allowed with `no_implementer_in_session`. 1.2.0 adds `implementer_unfinished` to the review gate.

## Check B: a denied SubagentHandback is sent again

**Question.** Does a PreToolUse hook matched on `SubagentHandback` receive the report, and does exit 2 make the subagent send it again?

**Setup.** One agent named `reviewer` (`model: haiku`), told to answer its brief in one sentence and nothing else. PreToolUse on `SubagentHandback` ran the logging hook and this repo's `handback-check.mjs`.

```bash
claude -p "Launch the reviewer agent (subagent_type: reviewer) with exactly this brief: 'Is 2+2 equal to 4?' When it returns, repeat its report to me verbatim and stop. Do not launch it again." \
  --model sonnet --permission-mode auto --setting-sources project --output-format json
```

**Result.**

| Time (UTC) | Event | Detail |
|---|---|---|
| 17:57:36.354 | PreToolUse `SubagentHandback` | `agent_type: reviewer`; `handback-check.mjs` logs `deny`, `no_status` and exits 2 |
| 17:57:40.289 | PreToolUse `SubagentHandback` | the same agent, second call; allowed |
| 17:57:40.378 | SubagentStop | `background_tasks: []` |

The main session's reply was the corrected report: `STATUS: pass` followed by "Yes, 2+2 is equal to 4." The first, refused report never reached it. The run's JSON result lists the refused call under `permission_denials` (tool `SubagentHandback`, with its `message`), so a wrapper that counts permission denials will count one per report sent back.

**Limits.** `SubagentHandback` exists only in auto mode, for subagents the Agent tool runs locally. `scripts/orchestrate.sh` runs headless sessions with `--permission-mode dontAsk`, where the report is the subagent's last message and the gates read it at SubagentStop as before.

## Check C: a researcher launched from a plain session cannot search

**Observation.** The research session (interactive, auto mode, this repo's project agents) launched five researchers over local copies of the Claude Code docs. One reported "This session has no Grep tool and the Bash guard refuses grep, cd and pipes" and answered only what it could reach by reading files whole. Two reached the 15-turn limit with no report after about 144k and 158k tokens. Two finished.

`gates.jsonl` shows the guard at work, for example `{"gate":"researcher","decision":"deny","reason":"`grep` is not an allowed command"}`. Since 2026-11-01 the logs hold 43 researcher-guard denials against 26 researcher stop records: `cd` 8, `grep` 7, `cat` 5, `git` 3, `head` 2, `find` 1, redirection 10, a variable assignment 5, the rest unreadable commands.

**Cause.** The tools reference says that on macOS, Linux and WSL the Glob and Grep tools are left out of the default tool set and return when "a subagent lists `Glob` or `Grep` in its `tools` field and leaves out `Bash`". The researcher lists both and also Bash patterns, so it gets neither, and `researcher-guard.mjs` (0.4.0) held its Bash to git, `wc`, `ls` and `du`. Headless runs are not affected: `scripts/orchestrate.sh` names `Grep` and `Glob` in `--allowedTools`, which restores both for the session. Nor is an orchestrator started with `--agent`, which lists the tools and no Bash.

**Fix in 1.2.0.** The researcher's Bash list and the guard allow read-only `grep`, `rg`, `find`, `head`, `tail` and `cat`.

**Re-tested live with the fix.** The same session then launched one researcher (haiku, as shipped) with three lookups that need a search: the file and line that define a constant, a count of test files, and the files containing a string. It answered all three in 4 tool calls, about 25k tokens and 12 seconds, with `grep -rn`, `ls src/ | grep -c` and `grep -rl`, and reported that no tool or command was refused. Its answers were correct (`REWRITE_MIN` at `.claude/hooks/telemetry.mjs:84`). The two researchers that failed earlier had used about 144k and 158k tokens each without producing a report.
