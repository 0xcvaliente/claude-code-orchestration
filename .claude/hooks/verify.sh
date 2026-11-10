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
# the bugfix cap are counted separately. Hook timeout needed: at least 2 x ORCH_BASE_TIMEOUT_S plus the test run.
# Plugin userConfig: each ORCH_<KEY> setting falls back to CLAUDE_PLUGIN_OPTION_<KEY> when unset (state.mjs mirrors it).
# Exit 2 blocks and returns stderr to the agent; any other exit lets it finish.
# Every decision is appended to gates.jsonl in the state dir (the same rule as state.mjs) so a run can show
# whether the gate fired. Unlike the other hooks this one needs no duplicate check: the project matcher
# (^implementer$) and the plugin's (orchestration:implementer) never fire for the same agent.
set -u

# userConfig bridge (the same key list as state.mjs), before any setting is read.
for _k in TEST_CMD ESCALATION JUDGE JUDGE_TIMEOUT_MS READ_ROUTER GAP_MIN STALL_GATE GUARDS ALLOW_BUILTINS RUN_STALE_MIN BASELINE BUGFIX_CHECK QUOTE_CHECK GATE_ISOLATED SKILL_HINTS HANDBACK_CHECK; do
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

log_gate() { # decision reason [extra JSON fields: counts only]
  mkdir -p "$state" 2>/dev/null || return 0
  [ "$in_project" = 0 ] || [ -f "$state/.gitignore" ] || printf '*\n' 2>/dev/null >"$state/.gitignore"
  printf '{"ts":"%s","gate":"test","decision":"%s","reason":"%s","agent_type":"%s","agent_id":"%s","session_id":"%s"%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "${agent_type:-}" "${agent_id:-}" "${session_id:-}" "${3:+,$3}" >> "$state/gates.jsonl" 2>/dev/null || true
}

# Run bugfix-check.mjs <mode> with $2 on stdin and read its answer into chk_decision, chk_reason, chk_extra and
# chk_message. An empty decision is no opinion (also when node is missing or the helper fails). The reason keeps only
# [a-z_] and the extra only JSON count characters, so the log line stays valid JSON and holds no test output.
check() { # mode stdin
  chk_decision="" chk_reason="" chk_extra="" chk_message=""
  local res
  res="$(printf '%s' "$2" | node "$hooks_dir/bugfix-check.mjs" "$1" --cmd "$cmd" --state "$state" --isolated "$isolated" --mode "${ORCH_BASELINE:-inform}" 2>/dev/null)" || return 0
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

agent_type="$(printf '%s' "$input" | sed -n 's/.*"agent_type"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
agent_id="$(printf '%s' "$input" | sed -n 's/.*"agent_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
# session_id lets the run model (brief.mjs foldRuns) check that a test-gate record belongs to its launch's session.
# Only id characters are kept, so the log line stays valid JSON.
session_id="$(printf '%s' "$input" | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1 | LC_ALL=C tr -cd 'A-Za-z0-9_.-')"

agent_type="${agent_type##*:}" # plugin agents arrive namespaced ("orchestration:implementer")

# Only gate implementers when the event reports an agent type.
if [ -n "$agent_type" ] && [ "$agent_type" != "implementer" ]; then
  exit 0
fi

# Test where the agent worked: an isolated worktree's cwd when the event reports one.
agent_cwd="$(printf '%s' "$input" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n1)"
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

rc=0
out="$(bash -c "$cmd" 2>&1)" || rc=$?
if [ "$rc" = 0 ]; then
  if [ "${ORCH_BUGFIX_CHECK:-}" != off ] && [ "$agent_type" = implementer ]; then
    check bugfix "$input"
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
    if [ "$rc" = 5 ]; then # pytest: no tests collected
      log_gate allow no_tests_collected
      exit 0
    fi
    ;;
esac

# Failures the base commit already has: inform (default) keeps the block and names them in the message; allow
# (opt-in, heuristic) warns instead of blocking when every failing test also fails on the base.
base_extra="" base_msg=""
if [ "${ORCH_BASELINE:-}" != off ]; then
  check baseline "$out"
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
  echo "Acceptance gate failed: $cmd"
  printf '%s\n' "$out" | tail -n 40
  [ -z "$base_msg" ] || printf '%s\n' "$base_msg"
  echo "Fix the root cause and rerun before finishing."
} >&2
exit 2
