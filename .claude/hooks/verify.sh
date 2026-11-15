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
# Isolated worktrees (cwd under .claude/worktrees/) follow ORCH_GATE_ISOLATED, because sibling slices
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
# say what is missing, and after two such blocks it allows with bugfix_unverified_gave_up. The tests_failed cap and
# the bugfix cap are counted separately.
# Time budget. The wiring gives this hook 900 s, and a hook killed at its timeout does not block, so the whole hook ends
# within ORCH_HOOK_BUDGET_S (default 870, 30 s under the 900 s timeout for logging and exit):
#   test run    min(ORCH_TEST_TIMEOUT_S (default 600), time left). When it is reached the test command and its
#               children (its own process group) are killed and the stop blocks as a test failure (tests_failed, with
#               timed_out:1 and limit_s; tests_failed_isolated in an isolated worktree in warn mode), under the same
#               loop guard as any test failure. No base run follows a timed-out suite.
#   base run    (after failing tests) or bugfix check (after passing tests; up to two base runs), never both: each
#               base run gets min(ORCH_BASE_TIMEOUT_S, its share of the time left less 10 s for git and node), and the
#               helper is killed when the budget runs out. A baseline that cannot run only loses its note (the block
#               stays); a bugfix check that has no time or is killed blocks as unverified (bugfix_timeout), counted
#               with the other bugfix blocks.
#   So test run + base run (or bugfix check) <= 870 s < 900 s.
# Only portable tools: bash job control (set -m) for the process group, kill, sleep 1 and bash's SECONDS.
# Plugin userConfig: each ORCH_<KEY> setting falls back to CLAUDE_PLUGIN_OPTION_<KEY> when unset (state.mjs mirrors it).
# Exit 2 blocks and returns stderr to the agent; any other exit lets it finish.
# Every decision is appended to gates.jsonl in the state dir (the same rule as state.mjs) so a run can show
# whether the gate fired. Unlike the other hooks this one needs no duplicate check: the project matcher
# (^implementer$) and the plugin's (orchestration:implementer) never fire for the same agent.
set -u

# userConfig bridge (the same key list as state.mjs), before any setting is read.
for _k in TEST_CMD ESCALATION JUDGE JUDGE_TIMEOUT_MS READ_ROUTER GAP_MIN STALL_GATE GUARDS ALLOW_BUILTINS RUN_STALE_MIN BASELINE BUGFIX_CHECK QUOTE_CHECK GATE_ISOLATED SKILL_HINTS HANDBACK_CHECK ALLOW_HAIKU SKILL_CREATE SKILLS_REPO_PRIVATE SKILLS_REPO_PUBLIC; do
  _o="CLAUDE_PLUGIN_OPTION_$_k"
  _v="ORCH_$_k"
  if [ -z "${!_v+x}" ] && [ -n "${!_o:-}" ]; then export "$_v=${!_o}"; fi
done
unset _k _o _v

hooks_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# shellcheck source=test-cmd.sh
source "$(dirname "${BASH_SOURCE[0]}")/test-cmd.sh"

input="$(cat)"
project="${CLAUDE_PROJECT_DIR:-$PWD}"

# State dir: <project>/.claude/state, or for the plugin copy (--plugin) a per-user dir keyed by the project
# path, unless the project registers its own telemetry hook (then every copy shares the project's log).
state="$project/.claude/state"
in_project=1
if [ "${1:-}" = --plugin ] && ! { [ -f "$project/.claude/hooks/telemetry.mjs" ] &&
  grep -qsF .claude/hooks/telemetry.mjs "$project/.claude/settings.json" "$project/.claude/settings.local.json"; }; then
  in_project=0
  key="$(printf '%s' "$project" | LC_ALL=C tr -c 'A-Za-z0-9' '-')"
  [ "${#key}" -gt 200 ] && key="${key: -200}"
  state="${CLAUDE_PLUGIN_DATA:-${HOME:-}/.claude/orchestration}/state/$key"
fi

MAX_BLOCKS=2 # per agent; the cap is the loop guard, so a still-failing agent is rechecked, not waved through

# A whole number of seconds above 0, else the default.
pos_int() { # value default
  case "$1" in '' | *[!0-9]*) printf '%s' "$2" ;; *) if [ "$1" -gt 0 ] 2>/dev/null; then printf '%s' "$((10#$1))"; else printf '%s' "$2"; fi ;; esac
}
budget="$(pos_int "${ORCH_HOOK_BUDGET_S:-}" 870)"
test_limit="$(pos_int "${ORCH_TEST_TIMEOUT_S:-}" 600)"
base_limit="$(pos_int "${ORCH_BASE_TIMEOUT_S:-}" 300)"
time_left() { printf '%s' "$((budget - SECONDS))"; }

# Milliseconds, like the node hooks' records, so foldRuns orders a test-gate record against a stop of the same second.
# node is there wherever the hooks run (the other SubagentStop hooks are node); date's whole seconds only without it.
now_iso() {
  node -e 'process.stdout.write(new Date().toISOString())' 2>/dev/null || date -u +%Y-%m-%dT%H:%M:%SZ
}

log_gate() { # decision reason [extra JSON fields: counts only]
  mkdir -p "$state" 2>/dev/null || return 0
  [ "$in_project" = 0 ] || [ -f "$state/.gitignore" ] || printf '*\n' 2>/dev/null >"$state/.gitignore"
  printf '{"ts":"%s","gate":"test","decision":"%s","reason":"%s","agent_type":"%s","agent_id":"%s","session_id":"%s"%s}\n' \
    "$(now_iso)" "$1" "$2" "${agent_type:-}" "${agent_id:-}" "${session_id:-}" "${3:+,$3}" >> "$state/gates.jsonl" 2>/dev/null || true
}

# Run a command in its own process group, stdin from $2 and stdout to $3 (stderr to $4), for at most $1 seconds; then
# the whole group is killed. Sets lim_rc and lim_timed_out. Portable: job control (set -m) gives the background job its
# own group on bash 3.2 and later, without a terminal; the watchdog polls once a second.
run_limited() { # limit infile outfile errfile cmd...
  local limit="$1" inf="$2" outf="$3" errf="$4" pid wd flag
  shift 4
  lim_rc=0 lim_timed_out=0
  flag="$outf.timedout"
  rm -f "$flag"
  set -m
  "$@" <"$inf" >"$outf" 2>"$errf" &
  pid=$!
  set +m
  (
    end=$((SECONDS + limit))
    while kill -0 "$pid" 2>/dev/null; do
      if [ "$SECONDS" -ge "$end" ]; then
        : >"$flag"
        kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null
        break
      fi
      sleep 1
    done
  ) &
  wd=$!
  wait "$pid" 2>/dev/null
  lim_rc=$?
  kill "$wd" 2>/dev/null
  wait "$wd" 2>/dev/null
  if [ -e "$flag" ]; then lim_timed_out=1; fi
  rm -f "$flag"
  return 0
}

work="$(mktemp -d "${TMPDIR:-/tmp}/orch-verify.XXXXXX" 2>/dev/null)" || work=""
if [ -z "$work" ] || [ ! -d "$work" ]; then
  work="${TMPDIR:-/tmp}/orch-verify.$$"
  mkdir -p "$work" 2>/dev/null || true
fi
trap 'rm -rf "$work" 2>/dev/null' EXIT

# Run bugfix-check.mjs <mode> with $2 on stdin and read its answer into chk_decision, chk_reason, chk_extra and
# chk_message. An empty decision is no opinion (also when node is missing or the helper fails). The reason keeps only
# [a-z_] and the extra only JSON count characters, so the log line stays valid JSON and holds no test output.
# $3 is the number of base runs the mode may make: each gets min(ORCH_BASE_TIMEOUT_S, its share of the time left less
# 10 s), and the helper is killed when the budget runs out. chk_no_time is 1 when there was no time to run it or it was
# killed (then the decision is empty).
check() { # mode stdin runs
  chk_decision="" chk_reason="" chk_extra="" chk_message="" chk_no_time=0
  local res left share
  left="$(time_left)"
  share=$(((left - 10) / $3))
  [ "$share" -le "$base_limit" ] || share="$base_limit"
  if [ "$share" -lt 1 ]; then
    chk_no_time=1
    return 0
  fi
  printf '%s' "$2" >"$work/check.in" 2>/dev/null || return 0
  run_limited "$left" "$work/check.in" "$work/check.out" /dev/null \
    env ORCH_BASE_TIMEOUT_S="$share" node "$hooks_dir/bugfix-check.mjs" "$1" --cmd "$cmd" --state "$state" --isolated "$isolated" --mode "${ORCH_BASELINE:-inform}"
  if [ "$lim_timed_out" = 1 ]; then
    chk_no_time=1
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
  printf '%s' "$input" >"$work/kind.in" 2>/dev/null || return 1
  run_limited 10 "$work/kind.in" "$work/kind.out" /dev/null \
    node --input-type=module -e 'import { readFileSync } from "node:fs"; import { pathToFileURL } from "node:url"; const { agentKind } = await import(pathToFileURL(process.argv[1]).href); process.stdout.write(String(agentKind(process.argv[2], JSON.parse(readFileSync(0, "utf8")))));' "$hooks_dir/bugfix-check.mjs" "$state"
  [ "$lim_timed_out" = 0 ] && [ "$lim_rc" = 0 ] || return 1
  kind="$(cat "$work/kind.out" 2>/dev/null)"
  [ "$kind" = bugfix ]
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
  [ "$seen" = 1 ]
}

# A string field of the event JSON, with its escapes \" \\ and \/ undone (sed -E and bash only: both exist wherever
# the hook runs). The value is a run of non-quote, non-backslash characters or backslash pairs, so an escaped quote
# does not end it. Any other escape (\n, \uXXXX) is left as it is; for cwd that names no folder, so the project dir
# is used, as before.
json_str() { # key
  local v bs='\' q='"' sl='/' mark=$'\001' # a raw control character never appears in JSON text
  v="$(printf '%s' "$input" | sed -n -E 's/.*"'"$1"'"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' | head -n1)"
  v="${v//"$bs$bs"/"$mark"}"
  v="${v//"$bs$q"/"$q"}"
  v="${v//"$bs$sl"/"$sl"}"
  v="${v//"$mark"/"$bs"}"
  printf '%s' "$v"
}
agent_type="$(json_str agent_type)"
agent_id="$(json_str agent_id)"
# session_id lets the run model (brief.mjs foldRuns) check that a test-gate record belongs to its launch's session.
# Only id characters are kept, so the log line stays valid JSON.
session_id="$(json_str session_id | LC_ALL=C tr -cd 'A-Za-z0-9_.-')"

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

# The test run: its own limit, cut to the time left in the hook's budget.
limit="$(time_left)"
[ "$limit" -le "$test_limit" ] || limit="$test_limit"
[ "$limit" -ge 1 ] || limit=1
run_limited "$limit" /dev/null "$work/test.out" "$work/test.out" bash -c "$cmd"
rc="$lim_rc"
timed_out="$lim_timed_out"
out="$(cat "$work/test.out" 2>/dev/null)"
if [ "$timed_out" = 1 ]; then
  [ "$rc" != 0 ] || rc=137
fi
if [ "$rc" = 0 ]; then
  if [ "${ORCH_BUGFIX_CHECK:-}" != off ] && [ "$agent_type" = implementer ]; then
    check bugfix "$input" 2
    if [ "$chk_no_time" = 1 ] && is_bugfix_agent; then
      # No time left to check the reproduction test, or the check was killed: unverified, so it blocks like the
      # helper's own unverified blocks and shares their cap (bugfix-check.mjs counts every bugfix_ block). Only for a
      # KIND: bugfix agent: any other agent passes as before.
      bblocks=0
      if [ -n "$agent_id" ] && [ -f "$state/gates.jsonl" ]; then
        bblocks="$(grep -c "\"decision\":\"block\",\"reason\":\"bugfix_.*\"agent_id\":\"$agent_id\"" "$state/gates.jsonl" 2>/dev/null || true)"
      fi
      if [ "${bblocks:-0}" -ge "$MAX_BLOCKS" ]; then
        log_gate allow bugfix_unverified_gave_up
        exit 0
      fi
      log_gate block bugfix_timeout
      echo "KIND: bugfix: unverified. The check of the reproduction test against the base did not finish within the test gate's time budget ($budget seconds for the whole gate). Make the test suite faster, or report the bug as unverified." >&2
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
  log_gate allow tests_passed
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
base_extra="" base_msg=""
if [ "$timed_out" = 1 ]; then
  base_extra="\"timed_out\":1,\"limit_s\":$limit"
elif [ "${ORCH_BASELINE:-}" != off ]; then
  check baseline "$out" 1
  if [ "$chk_decision" = warn ] && [ "${ORCH_BASELINE:-}" = allow ]; then
    log_gate warn "$chk_reason" "$chk_extra"
    exit 0
  fi
  if [ "$chk_decision" = inform ]; then
    base_extra="$chk_extra"
    base_msg="$chk_message"
  fi
fi

if [ "$isolated" = 1 ] && [ "$mode" != block ]; then
  log_gate warn tests_failed_isolated "$base_extra"
  exit 0
fi

blocks=0
if [ -n "$agent_id" ] && [ -f "$state/gates.jsonl" ]; then
  # Only tests_failed blocks count here; bugfix-check.mjs counts its own bugfix_ blocks.
  blocks="$(grep -c "\"decision\":\"block\",\"reason\":\"tests_failed\",.*\"agent_id\":\"$agent_id\"" "$state/gates.jsonl" 2>/dev/null || true)"
fi
if [ "${blocks:-0}" -ge "$MAX_BLOCKS" ]; then
  log_gate allow max_blocks_reached "$base_extra"
  exit 0
fi

log_gate block tests_failed "$base_extra"
{
  if [ "$timed_out" = 1 ]; then
    echo "Acceptance gate failed: the test suite did not finish within $limit seconds and was stopped: $cmd"
    echo "A test hangs or the suite is too slow. Find the test that does not finish (run the suite with a per-test timeout) and fix it."
  else
    echo "Acceptance gate failed: $cmd"
  fi
  printf '%s\n' "$out" | tail -n 40
  [ -z "$base_msg" ] || printf '%s\n' "$base_msg"
  echo "Fix the root cause and rerun before finishing."
} >&2
exit 2
