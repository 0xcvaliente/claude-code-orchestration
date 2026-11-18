#!/usr/bin/env bash
# SubagentStop gate: block an implementer from finishing while the test command fails. It runs the tests when a test
# command exists and judges the changed files only, never the triage fact `code` and never what the agent says. Work
# that changes no code still runs them outside git, with ORCH_TEST_CMD set, or when any non-prose file changed.
# Test command: $ORCH_TEST_CMD, else detected by test-cmd.sh (npm, pytest/unittest, cargo, go, swift, make).
# Prose-only skip (only when ORCH_TEST_CMD is unset; an explicit command always runs): the agent's folder is
# inside a git work tree and every changed path, staged, unstaged or untracked, is prose (*.md, *.markdown, *.rst,
# *.adoc and *.txt, any case). Not prose: .mdx (JSX); a .txt that is CMakeLists.txt or whose path names requirements
# or constraints (build and dependency files); anything under a directory named test, tests, testdata, __tests__,
# spec, fixtures, __fixtures__, golden, snapshots or __snapshots__ (golden files and snapshots feed the tests).
# Logs allow no_code_changes and skips the tests. Judged from git, never from what the agent says. A clean tree (an
# isolated slice that already committed), a folder that is not a git work tree and any other path keep the test run.
# In an isolated worktree the paths the slice committed since its base (the fork point) must be prose as well.
# Isolated worktrees (cwd under .claude/worktrees/, other than the session's own project folder, which is the shared
# tree also when the session itself runs in a worktree) follow ORCH_GATE_ISOLATED, because sibling slices
# may not be merged yet: warn (default: run tests, log tests_failed_isolated, never block),
# block (gate as usual), skip (do not run tests).
# Test baseline (ORCH_BASELINE: inform by default, allow, or off): when the tests fail and the tree has changes against
# its base (HEAD for the shared tree, the fork point from the main worktree's HEAD for an isolated worktree),
# bugfix-check.mjs runs the same command in a clean detached worktree of the base.
#   inform (unset or any value but allow/off): never allows. The gate still blocks with tests_failed; the block message
#     lists the qualified failing tests that also fail on the base as probably pre-existing, and the record logs the
#     counts (failing, on_base).
#   allow (opt-in, HEURISTIC): the gate warns with tests_failed_baseline (counts failing, base_failing) when every
#     failing test, qualified by its file or package, also fails on the base. Runner output cannot be parsed
#     completely, so a failure that shows as no named test may slip through; unqualified names, runner-level crash
#     markers, and a base run that times out (ORCH_BASE_TIMEOUT_S, default 300), cannot use the main worktree's
#     dependencies or fails without parsable names keep the block.
#   off: no base run, as in 0.3.0.
# KIND: bugfix (ORCH_BUGFIX_CHECK=off disables): after the tests pass, an implementer whose brief says KIND: bugfix
# must have changed or added a test file that adds a qualified failing test on the base (bugfix-check.mjs); blocks
# say what is missing, and after two such blocks it allows with bugfix_unverified_gave_up (at once, with
# "cause":"lock_mismatch" in the record, when a lock file differs from the base's: no worker can fix that). The
# review gate clears a block for an environment reason (bugfix_base_unusable, bugfix_no_base, bugfix_timeout,
# bugfix_tmp_lost; never tests_failed or the worker's own bugfix_ reasons) once a later opus review of the slice
# passes. The tests_failed cap and
# the bugfix cap are counted separately, each over the blocks since the agent's latest SubagentStart in telemetry.jsonl
# (a SendMessage resume starts the agent again under its id), or over all its blocks when no start is recorded.
# Time budget. The wiring gives this hook 900 s, and a hook killed at its timeout does not block. Claude Code also fails
# a subagent that makes no progress for its stall limit (CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS, default 600000 ms), and
# time in this stop hook counts (live: an agent was failed while its gate still ran). So the whole hook ends within
# ORCH_HOOK_BUDGET_S, at most min(870, stall limit in seconds - 60), which is also its default: 540 with the stall limit
# unset (600 - 60), never above 870 (30 s under the 900 s timeout for logging and exit), at least 1. A larger setting is
# cut to that maximum, a smaller one is kept.
#   lock wait   the test run and the base run or bugfix check after it hold the project's suite lock (below, at
#               take_lock); waiting for it sleeps and counts against the budget. It ends when the time left falls to the
#               floor (min(120, budget / 4, the test run's own limit), at least 1): an isolated agent then gets
#               tests_failed_isolated with not_run:1 (warn), the shared tree runs without the lock.
#   test run    min(ORCH_TEST_TIMEOUT_S (default 600), time left): with the default budget always the time left, at most
#               540 s. When it is reached the test command and its
#               children (its own process group) are killed and the stop blocks as a test failure (tests_failed, with
#               timed_out:1 and limit_s; tests_failed_isolated in an isolated worktree in warn mode), under the same
#               loop guard as any test failure. No base run follows a timed-out suite.
#   base run    (after failing tests) or bugfix check (after passing tests; up to two base runs), never both: each
#               base run gets min(ORCH_BASE_TIMEOUT_S, its share of the time left less 10 s for git and node), and the
#               helper is killed when the budget runs out. A baseline that cannot run only loses its note (the block
#               stays); a bugfix check that has no time or is killed blocks as unverified (bugfix_timeout), counted
#               with the other bugfix blocks.
#   cache       (2.0.0; test-gate-cache.mjs) each of its helper runs (the tree key, a listing of the trees, the store,
#               the take with its listing) gets min(60, time left - 10) s, and none runs with less than 11 s left (no
#               key or no finished listing: nothing is stored or taken, the suite runs); one that hangs is stopped like
#               any limit, by the time left - 2 s at the latest. At a hand-back: the key, then listing L0 (before the
#               lock and the run; taken again right before the run when the lock had to be waited for), and after the
#               run (the test run's limit being the time left less HB_RESERVE_S, 30 s) listing L1, the key again and
#               the store. At a stop that follows a hand-back: the key and the take with its listing L2, before the lock
#               and the run. Before the run they come out of the time the test run then gets; after it they come out of
#               the base run's (a baseline then only loses its note) and are never followed by the bugfix check (the
#               hand-back gate does not run it), so the worst cases below stand. A listing of this repository's two
#               trees (about 10,600 entries) took 1.3 s cold and 0.3 s warm.
#   So lock wait + test run + base run (or bugfix check) <= budget: <= 540 s < 600 s by default, <= 870 s < 900 s at most.
#   A limit stops a run with SIGTERM to its process group and SIGKILL 5 s later (LIM_GRACE_S) if the leader is still
#   there, so a stopped bugfix-check.mjs removes its base worktree and its record; the helper's limit is the time left
#   less those 5 s, and only a timed-out test run can add them (see the worst case below).
# Temp folder: one mktemp folder per hook run, removed by the EXIT trap of the main shell only (subshells are ended
#   with SIGKILL: a subshell that gets SIGTERM before it has reset its inherited traps would run that trap and remove the
#   folder mid-run). Removed from outside anyway, it is made again before each use; a bugfix check whose input or
#   answer was lost with it blocks as unverified (bugfix_tmp_lost, counted with the other bugfix blocks), never allows.
# Each limit is counted in bash's whole SECONDS plus one (a run gets between limit and limit+1 s, never less) and the
#   watchdog polls once a second, so a run that hangs is signalled within limit+2 s and gone LIM_GRACE_S later: at most
#   limit + 7 s. SECONDS lags the clock by under a second at the hook's start. Worst cases, in seconds of the clock, for
#   a budget B (540 by default, 870 at most; a lock wait only uses part of B, so it adds nothing):
#   - test run timed out: B + 2 + 5 + 1 (lag) = B + 8: 548 < 600 by default, 878 < 900 at most.
#   - bugfix check timed out (its limit is the time left less 5 s), then the kind check (is_bugfix_agent, a 10 s
#     run_limited) also hung: (B - 5 + 2 + 5) + (10 + 2 + 5) + 1 (lag) = B + 20: 560 < 600 by default, 890 < 900 at most.
#   With a stall limit set, B + 20 <= stall limit - 40: the hook ends at least 40 s before it.
# Only portable tools: bash job control (set -m) for the process group, kill, sleep 1 and bash's SECONDS.
# Plugin userConfig: each ORCH_<KEY> setting falls back to CLAUDE_PLUGIN_OPTION_<KEY> when unset (state.mjs mirrors it).
# Exit 2 blocks and returns stderr to the agent; any other exit lets it finish.
# Every decision is appended to gates.jsonl in the state dir (the same rule as state.mjs) so a run can show
# whether the gate fired. Unlike the other hooks this one needs no duplicate check: the project matcher
# (^implementer$) and the plugin's (orchestration:implementer) never fire for the same agent.
set -u

# userConfig bridge (the same key list as state.mjs), before any setting is read.
for _k in TEST_CMD ESCALATION JUDGE JUDGE_TIMEOUT_MS READ_ROUTER GAP_MIN STALL_GATE GUARDS ALLOW_BUILTINS RUN_STALE_MIN BASELINE BUGFIX_CHECK QUOTE_CHECK GATE_ISOLATED SKILL_HINTS HANDBACK_CHECK ALLOW_HAIKU SKILL_CREATE SKILLS_REPO_PRIVATE SKILLS_REPO_PUBLIC WORKFLOW_GUARD REVIEW_HOLD; do
  _o="CLAUDE_PLUGIN_OPTION_$_k"
  _v="ORCH_$_k"
  if [ -z "${!_v+x}" ] && [ -n "${!_o:-}" ]; then export "$_v=${!_o}"; fi
done
unset _k _o _v

hooks_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=test-cmd.sh
source "$(dirname "${BASH_SOURCE[0]}")/test-cmd.sh"

# Arguments: --plugin (the plugin's copy: its state dir rule, below) and --handback (the hand-back mode, below), any order.
# --recent-ms=<n> is for tests only (no hook configuration passes it): the result cache's guard against recent changes
# (test-gate-cache.mjs RECENT_MS, 2000 ms) for this run's store, so a test need not wait out the production guard.
plugin_flag=0 handback=0 recent_ms=""
for _a in "$@"; do
  case "$_a" in
    --plugin) plugin_flag=1 ;;
    --handback) handback=1 ;;
    --recent-ms=*) recent_ms="${_a#--recent-ms=}" ;;
  esac
done
unset _a
case "$recent_ms" in '' | *[!0-9]* | ???????*) recent_ms="" ;; esac

input="$(cat)"
project="${CLAUDE_PROJECT_DIR:-$PWD}"

# State dir: <project>/.claude/state, or for the plugin copy (--plugin) a per-user dir keyed by the project
# path, unless the project registers its own telemetry hook (then every copy shares the project's log).
state="$project/.claude/state"
in_project=1
if [ "$plugin_flag" = 1 ] && ! { [ -f "$project/.claude/hooks/telemetry.mjs" ] &&
  grep -qsF .claude/hooks/telemetry.mjs "$project/.claude/settings.json" "$project/.claude/settings.local.json"; }; then
  in_project=0
  key="$(printf '%s' "$project" | LC_ALL=C tr -c 'A-Za-z0-9' '-')"
  [ "${#key}" -gt 200 ] && key="${key: -200}"
  state="${CLAUDE_PLUGIN_DATA:-${HOME:-}/.claude/orchestration}/state/$key"
fi

MAX_BLOCKS=2 # per agent, since its latest SubagentStart (a resume starts a new count); the cap is the loop guard, so a still-failing agent is rechecked, not waved through

# A whole number of seconds above 0, else the default.
pos_int() { # value default
  case "$1" in '' | *[!0-9]*) printf '%s' "$2" ;; *) if [ "$1" -gt 0 ] 2>/dev/null; then printf '%s' "$((10#$1))"; else printf '%s' "$2"; fi ;; esac
}
# Claude Code fails a subagent that makes no progress for its stall limit (CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS, default
# 600000 ms), and time in this stop hook counts: the gate ends 60 s before it. A value that is not a positive whole
# number of milliseconds reads as 600 s; more than 15 digits is far above 870 s anyway (and would overflow bash's math).
stall_s=600
case "${CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS:-}" in
  '' | *[!0-9]*) ;;
  ????????????????*) stall_s=1000000 ;;
  *) [ "$((10#$CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS))" -lt 1 ] || stall_s="$((10#$CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS / 1000))" ;;
esac
budget_max=$((stall_s - 60))
# Never above 870: a hook killed at its 900 s timeout does not block, so a larger budget could let a slow suite through.
[ "$budget_max" -le 870 ] || budget_max=870
[ "$budget_max" -ge 1 ] || budget_max=1
budget="$(pos_int "${ORCH_HOOK_BUDGET_S:-}" "$budget_max")"
[ "$budget" -le "$budget_max" ] || budget="$budget_max"
test_limit="$(pos_int "${ORCH_TEST_TIMEOUT_S:-}" 600)"
base_limit="$(pos_int "${ORCH_BASE_TIMEOUT_S:-}" 300)"
time_left() { printf '%s' "$((budget - SECONDS))"; }
LIM_GRACE_S=5 # run_limited: seconds between the SIGTERM at a limit and the SIGKILL

# Milliseconds, like the node hooks' records, so foldRuns orders a test-gate record against a stop of the same second.
# node is there wherever the hooks run (the other SubagentStop hooks are node); date's whole seconds only without it.
now_iso() {
  node -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ
}

# Every record also carries link_extra (the hand-back or stop it belongs to: handback_id and at, or after_handback) and
# tree_extra (the cache key's first 16 hex digits, and the record it reused), and after a failed test run fail_extra
# (what failed: failed_count, failed_tests, failed_crash and output, the file in the state folder that keeps the tail of
# the run's output; bugfix-check.mjs failureExtra). Returns 1 when the line was not written.
log_gate() { # decision reason [extra JSON fields: counts only]
  local extra="${link_extra:-}"
  decided=1
  [ -z "${tree_extra:-}" ] || extra="${extra:+$extra,}$tree_extra"
  [ -z "${3:-}" ] || extra="${extra:+$extra,}$3"
  [ -z "${fail_extra:-}" ] || extra="${extra:+$extra,}$fail_extra"
  [ "${took_over:-0}" = 0 ] || extra="${extra:+$extra,}\"lock_takeover\":1" # this gate removed a stale suite lock
  mkdir -p "$state" 2>/dev/null || return 1
  [ "$in_project" = 0 ] || [ -f "$state/.gitignore" ] || printf '*\n' 2>/dev/null >"$state/.gitignore"
  printf '{"ts":"%s","gate":"test","decision":"%s","reason":"%s","agent_type":"%s","agent_id":"%s","session_id":"%s"%s}\n' \
    "$(now_iso)" "$1" "$2" "${agent_type:-}" "${agent_id:-}" "${session_id:-}" "${extra:+,$extra}" >> "$state/gates.jsonl" 2>/dev/null || return 1
  return 0
}
decided=0 link_extra="" tree_extra="" fail_extra=""

# Run a command in its own process group, stdin from $2 and stdout to $3 (stderr to $4), for at most $1 seconds; then
# the whole group is killed. Sets lim_rc and lim_timed_out. Portable: job control (set -m) gives the background job its
# own group on bash 3.2 and later, without a terminal; the watchdog polls once a second. The limit is counted in
# SECONDS plus one, so it holds for between $1 and $1+1 seconds, and a hung run is signalled within $1+2 seconds.
run_limited() { # limit infile outfile errfile cmd...
  local limit="$1" inf="$2" outf="$3" errf="$4" pid wd end
  shift 4
  lim_rc=0 lim_timed_out=0
  # The job's group is a background group. When the hook has a controlling terminal (hooks normally have none), a
  # test that reads /dev/tty would stop on SIGTTIN and only end at the limit; ignored here and so in the job (an
  # ignored signal stays ignored across exec), such a read fails at once instead, and a terminal write goes through.
  trap '' TTIN TTOU
  set -m
  if [ "$errf" = "$outf" ]; then
    "$@" <"$inf" >"$outf" 2>&1 & # one open file: both streams in the order written, as 2>&1 always did
  else
    "$@" <"$inf" >"$outf" 2>"$errf" &
  fi
  pid=$!
  lim_pid="$pid" # for on_signal: a TERM, INT or HUP to the hook ends this group first
  # Under the suite lock, the lock's companion file names this run's process group, so that a hook killed with SIGKILL
  # leaves a lock that is not taken over while its suite still runs (lock_stale), until the lock is LOCK_STALE_S old.
  [ "$lock_held" != 1 ] || { printf '%s\n%s\n' "$lock_token" "$pid" >"$lock.run"; } 2>/dev/null
  set +m
  # The watchdog and the timeout verdict below share it. SECONDS ticks at whole wall-clock seconds, so SECONDS+limit
  # can be reached limit-1 seconds after the start (a run that took 2.6 s was timed out under a 3 s limit); one more
  # second makes the effective limit lie between limit and limit+1 seconds, never under it.
  end=$((SECONDS + limit + 1))
  # The watchdog: at the limit it sends the group SIGTERM (bugfix-check.mjs then removes its base worktree), and SIGKILL
  # when the leader is still there after LIM_GRACE_S seconds. Its first act is to drop the EXIT trap it inherits.
  (
    trap - EXIT
    while kill -0 "$pid" 2>/dev/null; do
      if [ "$SECONDS" -ge "$end" ]; then
        kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
        g=0
        while [ "$g" -lt "${LIM_GRACE_S:-5}" ] && kill -0 "$pid" 2>/dev/null; do
          sleep 1
          g=$((g + 1))
        done
        kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
        exit 124
      fi
      sleep 1
    done
    exit 0
  ) >/dev/null 2>&1 &
  wd=$!
  lim_wd="$wd"
  wait "$pid" 2>/dev/null
  lim_rc=$?
  # Timed out is the hook's own fact, never a file the command could delete: the watchdog exits 124 when it signalled
  # the run, whatever status the run then returned (a suite may exit 0 on SIGTERM). Before the limit it cannot have
  # fired, so it is stopped with SIGKILL, never SIGTERM: a subshell that gets SIGTERM before it has reset the traps it
  # inherited runs the hook's EXIT trap, which removed the hook's temp folder while the hook still ran (seen on loaded
  # machines). From the limit on it is waited for: it ends within its grace.
  if [ "$SECONDS" -lt "$end" ]; then
    kill -KILL "$wd" 2>/dev/null
    wait "$wd" 2>/dev/null
  else
    wait "$wd" 2>/dev/null
    if [ "$?" = 124 ]; then
      lim_timed_out=1
      kill -KILL -- "-$pid" 2>/dev/null # the leader ended on the SIGTERM: its group's stragglers go now
    fi
  fi
  lim_pid="" lim_wd=""
  return 0
}
lim_pid="" lim_wd=""

# A TERM, INT or HUP to the hook: the running command's process group (a test run or the bugfix-check.mjs helper, which
# runs in a group of its own and would outlive the hook) is ended the way a limit ends it, SIGTERM and SIGKILL after
# LIM_GRACE_S while its leader is still there, before the EXIT trap releases the lock, so the next gate's suite never
# overlaps it. bash runs the trap at once while it waits for the job. A hook killed with SIGKILL runs no trap: its lock
# stays, and lock_stale counts it stale only once no process is left in the group test-gate.lock.run names (or once the
# lock is older than LOCK_STALE_S, when that group may still run); the next waiter then takes it over (lock_takeover).
on_signal() { # exit status
  local g=0
  trap '' TERM INT HUP
  [ -z "$lim_wd" ] || kill -KILL "$lim_wd" 2>/dev/null
  if [ -n "$lim_pid" ]; then
    kill -TERM -- "-$lim_pid" 2>/dev/null || kill -TERM "$lim_pid" 2>/dev/null
    while [ "$g" -lt "$LIM_GRACE_S" ] && kill -0 "$lim_pid" 2>/dev/null; do
      sleep 1
      g=$((g + 1))
    done
    kill -KILL -- "-$lim_pid" 2>/dev/null || kill -KILL "$lim_pid" 2>/dev/null
  fi
  exit "$1"
}
trap 'on_signal 143' TERM
trap 'on_signal 130' INT
trap 'on_signal 129' HUP

work="$(mktemp -d "${TMPDIR:-/tmp}/orch-verify.XXXXXX" 2>/dev/null)" || work=""
if [ -z "$work" ] || [ ! -d "$work" ]; then
  work="${TMPDIR:-/tmp}/orch-verify.$$"
  mkdir -p "$work" 2>/dev/null || true
fi
# One suite at a time per project. Every worktree of a project shares the state dir (it comes from CLAUDE_PROJECT_DIR,
# never from the agent's cwd), so a lock file there makes the gates of one wave run their suites, and the base run or
# bugfix check that follows, one after the other instead of all at once (four at once took 554 to 590 s each, live).
# The lock is "<pid> <start epoch seconds>" of its holder, made whole in a private file and hard-linked into place (ln
# fails when the name exists: atomic, and never seen half written). A lock that is older than the hook timeout
# (LOCK_STALE_S), or whose holder is gone and whose companion file (test-gate.lock.run) names no process group that
# still has a member, is stale: one waiter at a time (a takeover dir, itself broken after 2 minutes) removes it and all
# try again. The EXIT trap releases it on every way out (exit, the test run's limit, SIGTERM), and only while it still
# holds this hook's own token; a hook killed with SIGKILL leaves it to the stale rule.
lock="$state/test-gate.lock"
lock_token="" lock_held=0
LOCK_STALE_S=900 # the hook timeout in the settings
# A lock that is gone again when the failed link is looked at was released in between: the link is tried again. Only a
# state dir that is missing or cannot be written (or, after 5 such tries, a file system with no hard links) is "no lock".
take_lock() { # 0: taken; 1: held by another; 2: no lock can be made here (the gate goes on without one)
  local priv="$state/.test-gate.lock.$$" tries=0
  mkdir -p "$state" 2>/dev/null || return 2
  [ "$in_project" = 0 ] || [ -f "$state/.gitignore" ] || printf '*\n' 2>/dev/null >"$state/.gitignore"
  lock_token="$$ $(date +%s)"
  printf '%s\n' "$lock_token" 2>/dev/null >"$priv" || return 2
  while [ "$tries" -lt 5 ]; do
    if ln "$priv" "$lock" 2>/dev/null; then
      rm -f "$priv"
      lock_held=1
      return 0
    fi
    if [ -e "$lock" ]; then
      rm -f "$priv"
      return 1
    fi
    tries=$((tries + 1))
  done
  rm -f "$priv"
  return 2
}
lock_stale() { # $1: the lock's content as read; true when its holder is gone or it is older than the hook timeout
  # (holder gone: only once no member of the process group its companion file names is left, below; content that does
  # not read as "<pid> <start>" is stale too)
  local pid start
  pid="${1%% *}" start="${1#* }"
  case "$pid" in '' | *[!0-9]*) return 0 ;; esac
  case "$start" in '' | *[!0-9]*) return 0 ;; esac
  [ "$(($(date +%s) - 10#$start))" -le "$LOCK_STALE_S" ] || return 0
  kill -0 "$pid" 2>/dev/null && return 1
  ps -p "$pid" >/dev/null 2>&1 && return 1 # alive under another user (kill -0 is refused)
  # The holder is gone (killed with SIGKILL: no trap ran). Its suite runs in a process group of its own and may still
  # run: while a member of the group the lock's companion file names is left, the lock stands.
  local run_tok="" run_pg=""
  { { IFS= read -r run_tok && IFS= read -r run_pg; } <"$lock.run"; } 2>/dev/null # a missing file prints nothing
  if [ "$run_tok" = "$1" ]; then
    case "$run_pg" in '' | *[!0-9]*) ;; *) kill -0 -- "-$run_pg" 2>/dev/null && return 1 ;; esac
  fi
  return 0
}
# One taker at a time (the guard folder; a waiter that finds it older than 2 minutes removes it and does not take over
# that round). The stale lock is renamed away first, an atomic step, and only then compared with what was judged stale:
# a lock some other gate made in between is put back with ln (never over another), not removed, and that gate keeps it.
# While the name is free, a third gate's take_lock can link its own lock there; ln then fails and the renamed lock is
# removed, so the gate that made it runs on without its file and two suites can overlap: that race stays open.
take_over() { # 0 when a stale lock was removed
  local guard="$lock.takeover" seen="" now_seen="" rc=1 grab="$lock.stale.$$"
  if ! mkdir "$guard" 2>/dev/null; then
    [ -z "$(find "$guard" -maxdepth 0 -mmin +2 2>/dev/null)" ] || rmdir "$guard" 2>/dev/null
    return 1
  fi
  { IFS= read -r seen <"$lock"; } 2>/dev/null
  if [ -e "$lock" ] && lock_stale "$seen" && mv "$lock" "$grab" 2>/dev/null; then
    { IFS= read -r now_seen <"$grab"; } 2>/dev/null
    if [ "$now_seen" = "$seen" ]; then
      rc=0 took_over=1
    else
      ln "$grab" "$lock" 2>/dev/null
    fi
    rm -f "$grab" 2>/dev/null
  fi
  rmdir "$guard" 2>/dev/null
  return "$rc"
}
took_over=0
release_lock() {
  local cur="" run_tok=""
  [ "$lock_held" = 1 ] || return 0
  { IFS= read -r run_tok <"$lock.run"; } 2>/dev/null
  [ "$run_tok" != "$lock_token" ] || rm -f "$lock.run" 2>/dev/null
  { IFS= read -r cur <"$lock"; } 2>/dev/null
  [ "$cur" != "$lock_token" ] || rm -f "$lock" 2>/dev/null
  lock_held=0
}
# Waits, sleeping a second at a time, while the time left stays above $1 (the floor). Sets lock_wait_s. 0: the lock is
# held; 1: the time left fell to the floor; 2: no lock can be made here.
acquire_lock() { # floor
  local t0="$SECONDS" r
  while :; do
    take_lock
    r=$?
    lock_wait_s=$((SECONDS - t0))
    [ "$r" = 1 ] || return "$r"
    take_over && continue
    [ "$(time_left)" -gt "$1" ] || return 1
    sleep 1
  done
}

# In the hand-back mode, a hook that ends with no decision (a crash, an error exit, a TERM at Claude Code's hook timeout)
# lets the report through (any exit but 2 does) and says so in the log; the SubagentStop gate then decides.
on_exit() {
  rm -rf "$work" 2>/dev/null
  release_lock
  [ "$handback" = 1 ] && [ "${armed:-0}" = 1 ] && [ "$decided" = 0 ] && log_gate allow handback_gate_error
  return 0
}
armed=0
trap on_exit EXIT
# The folder can still be removed from outside while the hook runs (a suite or a cleaner that sweeps TMPDIR). Before
# each use it is made again; when that fails the caller treats it like no time for the check (never a silent allow).
ensure_work() { [ -d "$work" ] || mkdir -p "$work" 2>/dev/null; }

# Run bugfix-check.mjs <mode> with $2 on stdin and read its answer into chk_decision, chk_reason, chk_extra and
# chk_message. An empty decision is no opinion (also when node is missing or the helper fails). The reason keeps only
# [a-z_] and the extra only JSON count characters, so the log line stays valid JSON and holds no test output.
# $3 is the number of base runs the mode may make: each gets min(ORCH_BASE_TIMEOUT_S, its share of the time left less
# 10 s), and the helper is stopped when the budget runs out. chk_no_time is 1 when there was no time to run it or it was
# stopped, and also (with chk_tmp_lost) when its input or answer was lost with the temp folder; the decision is empty.
check() { # mode stdin runs
  chk_decision="" chk_reason="" chk_extra="" chk_message="" chk_no_time=0 chk_tmp_lost=0
  local res left share
  left="$(time_left)"
  share=$(((left - 10) / $3))
  [ "$share" -le "$base_limit" ] || share="$base_limit"
  if [ "$share" -lt 1 ]; then
    chk_no_time=1
    return 0
  fi
  if ! { ensure_work && printf '%s' "$2" >"$work/check.in"; } 2>/dev/null; then
    chk_no_time=1 chk_tmp_lost=1
    return 0
  fi
  run_limited "$((left - LIM_GRACE_S))" "$work/check.in" "$work/check.out" /dev/null \
    env ORCH_BASE_TIMEOUT_S="$share" node "$hooks_dir/bugfix-check.mjs" "$1" --cmd "$cmd" --state "$state" --isolated "$isolated" --mode "${ORCH_BASELINE:-inform}"
  if [ "$lim_timed_out" = 1 ]; then
    chk_no_time=1
    return 0
  fi
  if [ ! -f "$work/check.out" ]; then # removed with the folder during the run: the answer is lost
    chk_no_time=1 chk_tmp_lost=1
    return 0
  fi
  [ "$lim_rc" = 0 ] || return 0
  res="$(cat "$work/check.out" 2>/dev/null)"
  chk_parse "$res"
}

# True when the agent's brief says KIND: bugfix (bugfix-check.mjs agentKind: its transcript, else its launch record).
# A quick read with no base run, limited to 10 s inside the 30 s the budget leaves under the hook timeout; any failure
# reads as not a bugfix slice, as when node is missing.
is_bugfix_agent() {
  local kind
  { ensure_work && printf '%s' "$input" >"$work/kind.in"; } 2>/dev/null || return 1
  run_limited 10 "$work/kind.in" "$work/kind.out" /dev/null \
    node --input-type=module -e 'import { readFileSync } from "node:fs"; import { pathToFileURL } from "node:url"; const { agentKind } = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(String(agentKind(process.argv[2], JSON.parse(readFileSync(0, "utf8")))));' "$hooks_dir/bugfix-check.mjs" "$state"
  [ "$lim_timed_out" = 0 ] && [ "$lim_rc" = 0 ] || return 1
  kind="$(cat "$work/kind.out" 2>/dev/null)"
  [ "$kind" = bugfix ]
}

# The agent's blocks with reason $1 (a prefix when it ends in _), counted since its latest SubagentStart in
# telemetry.jsonl (bugfix-check.mjs countBlocks): a SendMessage resume starts the agent again under its id, so each
# attempt gets its own cap. With no start record every block counts. When node fails, the grep pattern $2 counts them
# over the whole log, as before.
count_blocks() { # reason grep-pattern
  local n=""
  [ -n "$agent_id" ] || { printf 0; return 0; }
  n="$(node --input-type=module -e 'import { pathToFileURL } from "node:url"; const { countBlocks } = await import(pathToFileURL(process.argv[2]).href); process.stdout.write(String(countBlocks(process.argv[3], process.argv[4], process.argv[5])));' count "$hooks_dir/bugfix-check.mjs" "$state" "$agent_id" "$1" </dev/null 2>/dev/null)"
  case "$n" in
    '' | *[!0-9]*) n="$(grep -c "$2" "$state/gates.jsonl" 2>/dev/null || true)" ;;
  esac
  printf '%s' "${n:-0}"
}

chk_parse() { # helper output
  local res="$1"
  chk_decision="$(printf '%s\n' "$res" | sed -n 1p)"
  chk_reason="$(printf '%s\n' "$res" | sed -n 2p | LC_ALL=C tr -cd 'a-z_')"
  chk_extra="$(printf '%s\n' "$res" | sed -n 3p | LC_ALL=C tr -cd 'a-z_0-9,:"')"
  chk_message="$(printf '%s\n' "$res" | sed -n '4,$p')"
  case "$chk_decision" in allow | warn | block | inform) ;; *) chk_decision="" ;; esac
  [ -n "$chk_reason" ] || chk_decision=""
  return 0
}

# Prose: documentation or plain text by extension, any case (nocasematch: bash 3.2 has no ${var,,}). Not prose:
# .mdx (JSX); a .txt that is CMakeLists.txt or whose path names requirements or constraints (build and dependency
# files); anything under a test-data directory, whatever its extension (golden files and snapshots feed the tests).
is_prose() { # path
  local rc=1 had=0
  shopt -q nocasematch && had=1
  shopt -s nocasematch
  case "/$1" in # the leading slash lets a first-level folder match too
    */test/* | */tests/* | */testdata/* | */__tests__/* | */spec/* | */fixtures/* | */__fixtures__/* | */golden/* | */snapshots/* | */__snapshots__/*) ;;
    *.md | *.markdown | *.rst | *.adoc) rc=0 ;;
    *.txt)
      case "$1" in
        CMakeLists.txt | */CMakeLists.txt | *requirements* | *constraints*) ;;
        *) rc=0 ;;
      esac
      ;;
  esac
  [ "$had" = 1 ] || shopt -u nocasematch
  return "$rc"
}

# True when the current folder is in a git work tree and it lists changed paths, all of them prose. False for a
# clean tree, a folder that is not a git work tree, a failing git, and any other path, so every doubt keeps the tests.
# -z gives raw paths (no quotes or escapes for spaces and non-ASCII) and, for a rename or copy, the new path and
# then the old one: both are judged, because moving code to a prose name is still a code change. GIT_OPTIONAL_LOCKS=0
# keeps this status from taking index.lock while another slice runs git.
only_prose_changed() {
  GIT_OPTIONAL_LOCKS=0 git rev-parse --is-inside-work-tree >/dev/null 2>&1 || return 1
  local entry old seen=0
  while IFS= read -r -d '' entry; do
    seen=1
    is_prose "${entry:3}" || return 1
    case "${entry:0:2}" in
      *[RC]*)
        IFS= read -r -d '' old || return 1
        is_prose "$old" || return 1
        ;;
    esac
  done < <(GIT_OPTIONAL_LOCKS=0 git status --porcelain --untracked-files=all -z 2>/dev/null)
  [ "$seen" = 1 ] || return 1
  # An isolated slice commits its work, so HEAD moves with it: what it committed since its base (the fork point from the
  # main worktree's HEAD, as bugfix-check.mjs baseInfo computes it) must be prose too. A base that cannot be found keeps
  # the tests. --no-renames lists both sides of a move.
  [ "$isolated" = 1 ] || return 0
  local main_wt main_head fork
  main_wt="$(GIT_OPTIONAL_LOCKS=0 git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p' | head -n1)"
  [ -n "$main_wt" ] || return 1
  main_head="$(GIT_OPTIONAL_LOCKS=0 git -C "$main_wt" rev-parse --verify -q HEAD 2>/dev/null)" || return 1
  fork="$(GIT_OPTIONAL_LOCKS=0 git merge-base HEAD "$main_head" 2>/dev/null)" || return 1
  [ -n "$fork" ] || return 1
  while IFS= read -r -d '' entry; do
    is_prose "$entry" || return 1
  done < <(GIT_OPTIONAL_LOCKS=0 git diff --name-only --no-renames -z "$fork" HEAD 2>/dev/null || printf 'x\0')
  return 0
}

# A string field of the event JSON, with its escapes \" \\ and \/ undone (sed -E only: it exists wherever the hook
# runs). The value is a run of non-quote, non-backslash characters or backslash pairs, so an escaped quote does not
# end it. The second sed scans left to right and replaces each pair once, so \\" reads as \ then the closing quote;
# no bash pattern replacement is used, since bash 4.2 and older (macOS /bin/bash 3.2) keep quotes in its replacement.
# Any other escape (\n, \uXXXX) is left as it is; for cwd that names no folder, so the project dir is used, as before.
json_str() { # key
  printf '%s' "$input" | sed -n -E 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' | head -n1 | sed -E 's/\\(["\\/])/\1/g'
}
agent_type="$(json_str agent_type)"
agent_id="$(json_str agent_id)"
# session_id lets the run model (brief.mjs foldRuns) check that a test-gate record belongs to its launch's session.
# Only id characters are kept, so the log line stays valid JSON.
session_id="$(json_str session_id | LC_ALL=C tr -cd 'A-Za-z0-9_.-')"

# Hand-back mode (--handback; PreToolUse on SubagentHandback, after the report checks): the same gate before an
# implementer's report is delivered, so a test failure goes back to the worker while it still runs. Only this plugin's
# implementer: the project copy takes the bare type, the plugin copy the namespaced one (disjoint, as at SubagentStop);
# every other hand-back, and one with no agent id, is left alone. It refuses (exit 2) only for failing tests, within
# the tests_failed cap it shares with the SubagentStop gate and only while the agent has had fewer than two other
# hand-backs refused by any gate since its latest start (Claude Code asks a worker to resend a refused report at most
# three times); every other outcome lets the report through, logged, and the SubagentStop gate still runs and decides.
# Its records carry "at":"handback" and handback_id (the call's tool_use_id); a stop's records carry after_handback, the
# hand-back the stop follows (state.mjs latestHandbackId; telemetry.mjs and journal.mjs store the same value), which
# run.mjs pairs them by. The event's cwd is the agent's worktree for an isolated implementer (probed on 2.1.326, as at
# SubagentStop); a hand-back whose cwd is missing or not a folder is let through, logged (handback_no_cwd).
# ORCH_HANDBACK_GATE=off turns the mode off (environment only).
if [ "$handback" = 1 ]; then
  [ "$(json_str tool_name)" = SubagentHandback ] || exit 0
  if [ "$plugin_flag" = 1 ]; then want_type="orchestration:implementer"; else want_type=implementer; fi
  [ "$agent_type" = "$want_type" ] || exit 0
  [ -n "$agent_id" ] || exit 0
  handback_id="$(json_str tool_use_id | LC_ALL=C tr -cd 'A-Za-z0-9_.:-')"
  link_extra="\"at\":\"handback\",\"handback_id\":\"$handback_id\""
  agent_type=implementer
  if [ "${ORCH_HANDBACK_GATE:-}" = off ]; then
    log_gate allow handback_gate_off
    exit 0
  fi
  armed=1
  _c="$(json_str cwd)"
  if [ -z "$_c" ] || [ ! -d "$_c" ]; then
    log_gate allow handback_no_cwd
    exit 0
  fi
else
  # The hand-back this stop follows, if any since the agent's latest start (test-gate-cache.mjs link).
  after_handback=""
  [ -z "$agent_id" ] || after_handback="$(node "$hooks_dir/test-gate-cache.mjs" link "$state" "${session_id:-}" "$agent_id" </dev/null 2>/dev/null | LC_ALL=C tr -cd 'A-Za-z0-9_.:-')"
  [ -z "$after_handback" ] || link_extra="\"after_handback\":\"$after_handback\""
fi

agent_type="${agent_type##*:}" # plugin agents arrive namespaced ("orchestration:implementer")

# Only gate implementers when the event reports an agent type.
if [ -n "$agent_type" ] && [ "$agent_type" != "implementer" ]; then
  exit 0
fi

# Test where the agent worked: an isolated worktree's cwd when the event reports one.
agent_cwd="$(json_str cwd)"
if [ -n "$agent_cwd" ] && [ -d "$agent_cwd" ]; then
  cd "$agent_cwd" || exit 0
else
  cd "$project" || exit 0
fi

isolated=0
case "$PWD" in */.claude/worktrees/*) isolated=1 ;; esac
# A session that itself runs in a worktree (its project folder under .claude/worktrees/) is the shared tree: inside the
# project folder only a worktree under the project's own .claude/worktrees/ is isolated, never the folder itself.
if [ "$isolated" = 1 ]; then
  here="$(pwd -P)"
  proj_real="$(cd "$project" 2>/dev/null && pwd -P)"
  if [ -n "$proj_real" ]; then
    case "$here/" in
      "$proj_real"/*)
        rel="${here#"$proj_real"}"
        case "$rel/" in /.claude/worktrees/*/*) ;; *) isolated=0 ;; esac
        ;;
    esac
  fi
fi
mode="${ORCH_GATE_ISOLATED:-warn}"
if [ "$isolated" = 1 ] && [ "$mode" = skip ]; then
  log_gate allow isolated_skipped
  exit 0
fi

cmd="$(orch_detect_test_cmd "$PWD")"
if [ -z "$cmd" ]; then
  log_gate allow no_test_command
  exit 0
fi

# An explicit ORCH_TEST_CMD always runs; a detected runner is skipped when only prose changed.
if [ -z "${ORCH_TEST_CMD:-}" ] && only_prose_changed; then
  log_gate allow no_code_changes
  exit 0
fi

# Wait for the project's suite lock, but keep at least the floor for the suite: the smallest of 120 s (about what this
# repository's suite takes on an idle machine), a quarter of the budget (so a small budget still spends most of its time
# waiting) and the test run's own limit (a suite is never given more). When the time left falls to the floor, an agent in
# an isolated worktree gets a warn record that says its tests did not run (tests_failed_isolated, so the run model asks
# for an opus review); the shared tree runs the suite anyway, without the lock, and never skips.
floor=120
[ "$floor" -le "$((budget / 4))" ] || floor=$((budget / 4))
[ "$floor" -le "$test_limit" ] || floor="$test_limit"
[ "$floor" -ge 1 ] || floor=1

# The result cache (test-gate-cache.mjs; its header states the rule and its limits). Only the SubagentStop gate takes
# an outcome, and only the one its own hand-back's gate stored, once, within 30 s, for the same tree key, and only when
# a listing of every entry of the work tree and, for a linked worktree, of the main checkout (git-ignored entries
# included; each tree's .git, .claude/state and .claude/worktrees left out) taken at the stop (L2) equals the listing
# taken just before the hand-back's run began (L0). The hand-back gate stores an outcome only when the listing taken
# just after its run (L1) equals L0 exactly (the suite wrote nothing into the trees and nothing else changed them while
# it ran), no entry's time is within 2 s before L0 or in the future, no symlink points outside the trees, the times
# have sub-second parts, the clock did not go back and the key did not change; else nothing is stored and its record
# says why ("store": the reason code, or "stored"). A suite that writes into the trees therefore gets no reuse: it runs
# at both points. A stop that follows a hand-back and takes nothing says why too ("reuse"). A pass is taken as a pass,
# a fail as a fail, a timed-out run as a timed-out block and a lock-wait give-up as a reason not to wait again; the
# records say so (reused, reused_from: the hand-back). compute_key sets key_out (the tree's key, or ""), and is called
# only where it is used: at a hand-back and at a stop that follows one. Every helper run is cut to the time left in the
# budget less KEY_RESERVE_S, at most 60 s, and skipped when none is left: no key or no finished listing means no record
# and no reuse. The hand-back gate's test run keeps HB_RESERVE_S of the budget for L1, the key and the store after it.
KEY_RESERVE_S=10
HB_RESERVE_S=30
helper_limit() { # prints the limit for a key run, scan or store, or 0 when none is left
  local lim=$(($(time_left) - KEY_RESERVE_S))
  [ "$lim" -le 60 ] || lim=60
  [ "$lim" -ge 1 ] || lim=0
  printf '%s' "$lim"
}
compute_key() {
  local lim
  key_out=""
  lim="$(helper_limit)"
  [ "$lim" -ge 1 ] || return 0
  ensure_work || return 0
  run_limited "$lim" /dev/null "$work/key.out" /dev/null node "$hooks_dir/test-gate-cache.mjs" key "$PWD" "$cmd" "$isolated"
  [ "$lim_timed_out" = 0 ] && [ "$lim_rc" = 0 ] || return 0
  key_out="$(sed -n 1p "$work/key.out" 2>/dev/null | LC_ALL=C tr -cd '0-9a-f')"
  [ "${#key_out}" = 64 ] || key_out=""
  return 0
}
# After the run (or the lock-wait give-up): the key again; key_stable=1 when it is the one taken before.
recheck_key() {
  key_stable=0
  [ -n "$cache_key" ] || return 0
  compute_key
  [ "$key_out" != "$cache_key" ] || key_stable=1
}
# A listing of the trees into $work/$1 (l0.json or l1.json); the file is removed first and left out when the listing
# cannot run or finish, so the store then refuses (l0_missing, l1_missing). The hand-back gate only, with a key.
list_trees() {
  local lim
  [ "$handback" = 1 ] && [ -n "$cache_key" ] || return 0
  ensure_work || return 0
  rm -f "$work/$1" 2>/dev/null
  lim="$(helper_limit)"
  [ "$lim" -ge 1 ] || return 0
  run_limited "$lim" /dev/null "$work/$1" /dev/null node "$hooks_dir/test-gate-cache.mjs" list "$state" "$PWD" "$((lim - 1))"
  [ "$lim_timed_out" = 0 ] && [ "$lim_rc" = 0 ] || rm -f "$work/$1" 2>/dev/null
  return 0
}
# What failed (bugfix-check.mjs failureExtra): sets fail_extra to the failed run's record fields (failed_count, at most
# 10 failing test names as the runner's output shows them, failed_crash, and output: the file under the state folder's
# test-output/ that keeps the last 64 KiB of the run's output; the newest 10 such files are kept). Its run gets
# min(10, time left - KEY_RESERVE_S) s and is skipped with less: no fields then (after a test run that used up the time
# left, as a timed-out stop's run does), never a different decision. The agent's message does not change.
note_failures() {
  local lim
  fail_extra=""
  lim=$(($(time_left) - KEY_RESERVE_S))
  [ "$lim" -le 10 ] || lim=10
  [ "$lim" -ge 1 ] || return 0
  [ -f "$work/test.out" ] || return 0
  # The kept output may hold secrets a test printed: the folder is 0700 and each file 0600, also when an older run or
  # a wider umask left them open (tightened here, before and after the write; a symlink is never followed by chmod).
  # The helper runs under umask 077, so the folder it makes and the file it writes are private from the start.
  local um out f
  out="$state/test-output"
  mkdir -p "$out" 2>/dev/null
  [ -L "$out" ] || chmod 700 "$out" 2>/dev/null
  um="$(umask)"
  umask 077
  run_limited "$lim" "$work/test.out" "$work/fail.out" /dev/null node "$hooks_dir/bugfix-check.mjs" failures --state "$state" --tag "${agent_id:-}-$$"
  umask "$um"
  if [ -d "$out" ] && [ ! -L "$out" ]; then
    for f in "$out"/* "$out"/.[!.]*; do
      [ -f "$f" ] && [ ! -L "$f" ] && chmod 600 "$f" 2>/dev/null
    done
  fi
  [ "$lim_timed_out" = 0 ] && [ "$lim_rc" = 0 ] || return 0
  fail_extra="$(sed -n 1p "$work/fail.out" 2>/dev/null)"
  case "$fail_extra" in '"failed_count":'*) ;; *) fail_extra="" ;; esac
  return 0
}
# The store's verdict goes into the hand-back's record ("store"): "stored" or why not.
store_note() { tree_extra="${tree_extra:+$tree_extra,}\"store\":\"$1\""; }
cache_put() { # result extra message: the hand-back gate only; the helper compares L0 and L1 and may refuse
  local lim code
  [ "$handback" = 1 ] || return 0
  [ -n "$cache_key" ] || { store_note no_key; return 0; }
  [ -n "$handback_id" ] || { store_note no_handback_id; return 0; }
  [ "$key_stable" = 1 ] || { store_note key_changed; return 0; }
  lim="$(helper_limit)"
  [ "$lim" -ge 1 ] || { store_note no_time; return 0; }
  mkdir -p "$state" 2>/dev/null || { store_note no_state; return 0; }
  [ "$in_project" = 0 ] || [ -f "$state/.gitignore" ] || printf '*\n' 2>/dev/null >"$state/.gitignore"
  { ensure_work && printf '%s' "$3" >"$work/put.in"; } 2>/dev/null || { store_note no_work; return 0; }
  run_limited "$lim" "$work/put.in" "$work/put.out" /dev/null node "$hooks_dir/test-gate-cache.mjs" put "$state" "$cache_key" "$1" "$handback_id" "$2" \
    "${session_id:-}" "${agent_id:-}" "$work/l0.json" "$work/l1.json" "$recent_ms" "$fail_extra"
  code="$(sed -n 1p "$work/put.out" 2>/dev/null | LC_ALL=C tr -cd 'a-z0-9_')"
  [ "$lim_timed_out" = 0 ] && [ -n "$code" ] || code=put_failed
  store_note "$code"
  return 0
}
cached="" cached_by="" cached_extra="" cached_fail="" cached_msg="" key_stable=0 cache_key="" take_reason=""
if [ "$handback" = 1 ] || [ -n "${after_handback:-}" ]; then
  compute_key
  cache_key="$key_out"
  [ -n "$cache_key" ] || [ "$handback" = 1 ] || take_reason=no_key
fi
if [ -n "$cache_key" ]; then
  tree_extra="\"tree\":\"${cache_key:0:16}\""
  # Only the SubagentStop gate takes an outcome, and only its own hand-back's (test-gate-cache.mjs cacheTake).
  take_lim="$(helper_limit)"
  if [ "$handback" = 0 ] && [ "$take_lim" -ge 1 ] && ensure_work; then
    run_limited "$take_lim" /dev/null "$work/cache.out" /dev/null node "$hooks_dir/test-gate-cache.mjs" take "$state" "$cache_key" "${session_id:-}" "$agent_id" "$after_handback" "$PWD" "$((take_lim - 1))"
    take_reason=take_failed
    if [ "$lim_timed_out" = 0 ] && [ "$lim_rc" = 0 ]; then
      cached="$(sed -n 1p "$work/cache.out" 2>/dev/null)"
      case "$cached" in
        pass | fail | timeout | lock_wait) take_reason="" ;;
        none)
          cached=""
          take_reason="$(sed -n 2p "$work/cache.out" 2>/dev/null | LC_ALL=C tr -cd 'a-z0-9_')"
          ;;
        *) cached="" ;;
      esac
    fi
  elif [ "$handback" = 0 ]; then
    take_reason=no_time
  fi
  if [ -n "$cached" ]; then
    cached_by="$(sed -n 2p "$work/cache.out" | LC_ALL=C tr -cd 'A-Za-z0-9_.:-')"
    cached_extra="$(sed -n 3p "$work/cache.out" | LC_ALL=C tr -cd 'a-z_0-9,:"')"
    cached_fail="$(sed -n 4p "$work/cache.out")" # cleaned by the helper (cleanFailureExtra); checked again below
    case "$cached_fail" in '"failed_count":'*) ;; *) cached_fail="" ;; esac
    cached_msg="$(sed -n '5,$p' "$work/cache.out")"
    tree_extra="$tree_extra,\"reused\":\"$cached\",\"reused_from\":\"$cached_by\""
  fi
fi
[ -z "$take_reason" ] || tree_extra="${tree_extra:+$tree_extra,}\"reuse\":\"$take_reason\""

lock_wait_s=0 run_s=0 chk_s=0 # where the budget went, for the bugfix_timeout message
timed_out=0 limit=0
reused=0
if [ "$cached" = pass ] || [ "$cached" = fail ] || [ "$cached" = timeout ]; then
  reused=1
  # No lock and no run: the outcome of this very tree, taken from its hand-back's run.
  rc=0
  [ "$cached" = pass ] || rc=1
  if [ "$cached" = timeout ]; then rc=137 timed_out=1; fi
  [ "$cached" = pass ] || fail_extra="$cached_fail" # what failed, as the hand-back's run recorded it
  out=""
else
  if [ "$cached" = lock_wait ]; then
    # The hand-back gate already waited for the suite lock until its floor: this gate does not wait again. An isolated
    # agent gets its not-run warn at once; the shared tree runs without the lock, as after its own wait.
    if [ "$isolated" = 1 ] && [ "$mode" != block ]; then
      log_gate warn tests_failed_isolated "\"not_run\":1,\"lock_wait_s\":0"
      exit 0
    fi
    lock_r=1
  else
    # L0 before the lock: a give-up compares it with L1 after the wait; a run that had to wait lists again before it.
    list_trees l0.json
    acquire_lock "$floor"
    lock_r=$?
  fi
  if [ "$lock_r" = 1 ]; then
    if [ "$handback" = 1 ]; then
      # Stored so that the stop does not wait for the lock a second time (the hand-back and the stop are one wait).
      list_trees l1.json
      recheck_key
      cache_put lock_wait "" ""
      log_gate allow handback_lock_wait "\"not_run\":1,\"lock_wait_s\":$lock_wait_s"
      exit 0
    fi
    if [ "$isolated" = 1 ] && [ "$mode" != block ]; then
      log_gate warn tests_failed_isolated "\"not_run\":1,\"lock_wait_s\":$lock_wait_s"
      exit 0
    fi
  fi

  # The test run: its own limit, cut to the time left in the hook's budget (at a hand-back, less HB_RESERVE_S).
  limit="$(time_left)"
  [ "$handback" = 0 ] || limit=$((limit - HB_RESERVE_S))
  [ "$limit" -le "$test_limit" ] || limit="$test_limit"
  [ "$limit" -ge 1 ] || limit=1
  # L0 again right before the run when the lock had to be waited for (the listing comes out of the run's time).
  if [ "$handback" = 1 ] && [ "${lock_wait_s:-0}" -gt 0 ]; then
    list_trees l0.json
    limit="$(time_left)"
    limit=$((limit - HB_RESERVE_S))
    [ "$limit" -le "$test_limit" ] || limit="$test_limit"
    [ "$limit" -ge 1 ] || limit=1
  fi
  ensure_work
  run_s="$SECONDS"
  run_limited "$limit" /dev/null "$work/test.out" "$work/test.out" bash -c "$cmd"
  run_s=$((SECONDS - run_s))
  rc="$lim_rc"
  timed_out="$lim_timed_out"
  # At a hand-back: L1 at once, then the key again, so that an outcome is stored only for the trees the run began with.
  list_trees l1.json
  out="$(cat "$work/test.out" 2>/dev/null)"
  [ "$handback" = 0 ] || recheck_key
  # A failed run (not pytest's "no tests collected", which allows): what failed goes into its records.
  if [ "$rc" != 0 ] && ! { [ "$rc" = 5 ] && [ "$timed_out" = 0 ] && case "$cmd" in *pytest*) true ;; *) false ;; esac; }; then
    note_failures
  fi
  if [ "$timed_out" = 1 ]; then
    [ "$rc" != 0 ] || rc=137
    if [ "$handback" = 1 ]; then
      # Stored as a timed-out block for the stop to take, so the suite is not started a second time for this tree.
      cache_put timeout "\"timed_out\":1,\"limit_s\":$limit" "$(
        echo "Acceptance gate failed: the test suite did not finish within $limit seconds and was stopped: $cmd"
        echo "A test hangs or the suite is too slow. Find the test that does not finish (run the suite with a per-test timeout) and fix it."
        printf '%s\n' "$out" | tail -n 40
      )"
      log_gate allow handback_timed_out "\"limit_s\":$limit"
      exit 0
    fi
  fi
fi
if [ "$rc" = 0 ]; then
  cache_put pass "" ""
  if [ "$handback" = 1 ]; then
    # The bugfix check stays at the SubagentStop gate, which reuses this pass.
    log_gate allow tests_passed
    exit 0
  fi
  if [ "${ORCH_BUGFIX_CHECK:-}" != off ] && [ "$agent_type" = implementer ]; then
    chk_s="$SECONDS"
    check bugfix "$input" 2
    chk_s=$((SECONDS - chk_s))
    # A temp folder that could not be made again leaves the brief unread too: treated as a bugfix agent (blocks).
    if [ "$chk_no_time" = 1 ] && { is_bugfix_agent || { [ "$chk_tmp_lost" = 1 ] && ! ensure_work; }; }; then
      # No time left to check the reproduction test, or the check was killed: unverified, so it blocks like the
      # helper's own unverified blocks and shares their cap (bugfix-check.mjs counts every bugfix_ block). Only for a
      # KIND: bugfix agent: any other agent passes as before.
      bblocks=0
      if [ -n "$agent_id" ] && [ -f "$state/gates.jsonl" ]; then
        bblocks="$(count_blocks bugfix_ "\"decision\":\"block\",\"reason\":\"bugfix_.*\"agent_id\":\"$agent_id\"")"
      fi
      if [ "${bblocks:-0}" -ge "$MAX_BLOCKS" ]; then
        log_gate allow bugfix_unverified_gave_up
        exit 0
      fi
      if [ "$chk_tmp_lost" = 1 ]; then
        log_gate block bugfix_tmp_lost
        echo "KIND: bugfix: unverified. The test gate's temporary folder under ${TMPDIR:-/tmp} was removed while the gate ran, so the check of the reproduction test against the base could not run or its answer was lost. Stop whatever cleans that folder, or report the bug as unverified." >&2
        exit 2
      fi
      log_gate block bugfix_timeout
      # What the budget went to, from the times this gate measured: the wait for the suite lock (another gate running
      # this project's suite), the test run (none when the hand-back's outcome was reused) and the check itself. The
      # wait is named as the cause when it took at least as long as the run and the check together.
      if [ "$reused" = 1 ]; then ran="the test outcome was the hand-back's run (none here)"; else ran="the test run took $run_s s"; fi
      if [ "$lock_wait_s" -gt 0 ] && [ "$lock_wait_s" -ge $((run_s + chk_s)) ]; then
        echo "KIND: bugfix: unverified. The check of the reproduction test against the base could not finish within the test gate's time budget ($budget seconds for the whole gate): $lock_wait_s s of it went to waiting for another test gate that was running this project's suite (one suite runs at a time), $ran and the check $chk_s s. The wait, not your suite, used the time: stop again once the other gate has finished (your next stop runs the gate again), or report the bug as unverified." >&2
      else
        waited=""
        [ "$lock_wait_s" -le 0 ] || waited=", waiting for another test gate's run of this project's suite $lock_wait_s s"
        echo "KIND: bugfix: unverified. The check of the reproduction test against the base did not finish within the test gate's time budget ($budget seconds for the whole gate): $ran$waited and the check $chk_s s. Make the test suite faster, or report the bug as unverified." >&2
      fi
      exit 2
    fi
    if [ "$chk_decision" = block ]; then
      log_gate block "$chk_reason" "$chk_extra"
      printf '%s\n' "$chk_message" >&2
      exit 2
    elif [ -n "$chk_decision" ]; then
      log_gate "$chk_decision" "$chk_reason" "$chk_extra"
      exit 0
    fi
  fi
  if [ "$reused" = 1 ]; then log_gate allow tests_passed_cached; else log_gate allow tests_passed; fi
  exit 0
fi
case "$cmd" in
  *pytest*)
    if [ "$rc" = 5 ] && [ "$timed_out" = 0 ]; then # pytest: no tests collected
      log_gate allow no_tests_collected
      exit 0
    fi
    ;;
esac

# Failures the base commit already has: inform (default) keeps the block and names them in the message; allow
# (opt-in, heuristic) warns instead of blocking when every failing test also fails on the base. Not after a timeout:
# the output is cut short, and the budget is spent.
# A reused fail keeps the counts and the message its own run gave (no base run again).
base_extra="" base_msg=""
if [ "$reused" = 1 ]; then
  base_extra="$cached_extra"
elif [ "$timed_out" = 1 ]; then
  base_extra="\"timed_out\":1,\"limit_s\":$limit"
elif [ "${ORCH_BASELINE:-}" != off ]; then
  check baseline "$out" 1
  if [ "$chk_decision" = warn ] && [ "${ORCH_BASELINE:-}" = allow ]; then
    # An isolated failure keeps its own reason (a doubt signal), with the baseline's counts as extra fields.
    if [ "$isolated" = 1 ] && [ "$mode" != block ]; then
      log_gate warn tests_failed_isolated "$chk_extra"
      exit 0
    fi
    log_gate warn "$chk_reason" "$chk_extra"
    exit 0
  fi
  if [ "$chk_decision" = inform ]; then
    base_extra="$chk_extra"
    base_msg="$chk_message"
  fi
fi

# What failed, as the block message says it; stored with a fail (never after a timeout, and not under the opt-in
# baseline allow mode, whose warn depends on a base run a reused fail does not repeat).
if [ "$reused" = 1 ]; then
  fail_msg="$cached_msg"
else
  fail_msg="$(
    if [ "$timed_out" = 1 ]; then
      echo "Acceptance gate failed: the test suite did not finish within $limit seconds and was stopped: $cmd"
      echo "A test hangs or the suite is too slow. Find the test that does not finish (run the suite with a per-test timeout) and fix it."
    else
      echo "Acceptance gate failed: $cmd"
    fi
    printf '%s\n' "$out" | tail -n 40
    [ -z "$base_msg" ] || printf '%s\n' "$base_msg"
  )"
  [ "$timed_out" = 1 ] || [ "${ORCH_BASELINE:-}" = allow ] || cache_put fail "$base_extra" "$fail_msg"
fi

if [ "$isolated" = 1 ] && [ "$mode" != block ]; then
  log_gate warn tests_failed_isolated "$base_extra"
  exit 0
fi

blocks=0
if [ -n "$agent_id" ] && [ -f "$state/gates.jsonl" ]; then
  # Only tests_failed blocks count here, since the agent's latest start; bugfix-check.mjs counts its own bugfix_ blocks.
  blocks="$(count_blocks tests_failed "\"decision\":\"block\",\"reason\":\"tests_failed\",.*\"agent_id\":\"$agent_id\"")"
fi
if [ "${blocks:-0}" -ge "$MAX_BLOCKS" ]; then
  log_gate allow max_blocks_reached "$base_extra"
  exit 0
fi

if [ "$handback" = 1 ]; then
  # Claude Code asks a refused worker to resend at most three times: with two other hand-backs of this agent already
  # refused (by any gate, since its latest start), this one goes through and the SubagentStop gate decides.
  refused="$(node "$hooks_dir/test-gate-cache.mjs" refused "$state" "${session_id:-}" "$agent_id" "$handback_id" </dev/null 2>/dev/null | LC_ALL=C tr -cd '0-9')"
  if [ -z "$refused" ] || [ "$refused" -ge 2 ]; then
    log_gate allow handback_resend_cap "$base_extra"
    exit 0
  fi
  # A refusal counts only once its record is written and can be read back: the cap above and at the stop count it.
  log_gate block tests_failed "$base_extra" || exit 0
  tail -n 64 "$state/gates.jsonl" 2>/dev/null | grep -F '"decision":"block","reason":"tests_failed"' | grep -qF "\"handback_id\":\"$handback_id\"" || exit 0
  # Mark the hand-back refused (state.mjs recordHandbackRefusal), so the stop never takes this report's capture.
  printf '{"ts":"%s","session_id":"%s","agent_id":"%s","gate":"test"%s}\n' "$(now_iso)" "${session_id:-}" "$agent_id" \
    "${handback_id:+,\"tool_use_id\":\"$handback_id\"}" >>"$state/handback-refusals.jsonl" 2>/dev/null || true
  {
    printf '%s\n' "$fail_msg"
    echo "Your report was not delivered. Fix the root cause, rerun the failing tests, then send your report again."
  } >&2
  exit 2
fi

log_gate block tests_failed "$base_extra"
{
  printf '%s\n' "$fail_msg"
  echo "Fix the root cause and rerun before finishing."
} >&2
exit 2
