#!/usr/bin/env bash
# SubagentStop gate: block an implementer from finishing while the test command fails. The gate is for code:
# it does not run when the work changed no code (research, writing, analysis, operations, or a prose-only edit).
# Test command: $ORCH_TEST_CMD, else detected by test-cmd.sh (npm, pytest/unittest, cargo, go, swift, make).
# No code changed (only when ORCH_TEST_CMD is unset; an explicit command always runs): the agent's folder is
# inside a git work tree and every changed path, staged, unstaged or untracked, is prose (*.md, *.mdx, *.markdown,
# *.txt, *.rst, *.adoc, any case). Logs allow no_code_changes and skips the tests. Judged from git, never from
# what the agent says. A clean tree (an isolated slice that already committed), a folder that is not a git
# work tree and any other path keep the test run.
# Isolated worktrees (cwd under .claude/worktrees/) follow ORCH_GATE_ISOLATED, because sibling slices
# may not be merged yet: warn (default: run tests, log tests_failed_isolated, never block),
# block (gate as usual), skip (do not run tests).
# Exit 2 blocks and returns stderr to the agent; any other exit lets it finish.
# Every decision is appended to gates.jsonl in the state dir (the same rule as state.mjs) so a run can show
# whether the gate fired. Unlike the other hooks this one needs no duplicate check: the project matcher
# (^implementer$) and the plugin's (orchestration:implementer) never fire for the same agent.
set -u

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

log_gate() { # decision reason
  mkdir -p "$state" 2>/dev/null || return 0
  [ "$in_project" = 0 ] || [ -f "$state/.gitignore" ] || printf '*\n' 2>/dev/null >"$state/.gitignore"
  printf '{"ts":"%s","gate":"test","decision":"%s","reason":"%s","agent_type":"%s","agent_id":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "${agent_type:-}" "${agent_id:-}" >> "$state/gates.jsonl" 2>/dev/null || true
}

is_prose() { # path: documentation or plain text by extension, any case (patterns, so no bash 4 lowercasing)
  case "$1" in
    *.[mM][dD] | *.[mM][dD][xX] | *.[mM][aA][rR][kK][dD][oO][wW][nN] | *.[tT][xX][tT] | *.[rR][sS][tT] | *.[aA][dD][oO][cC]) return 0 ;;
  esac
  return 1
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

if [ "$isolated" = 1 ] && [ "$mode" != block ]; then
  log_gate warn tests_failed_isolated
  exit 0
fi

blocks=0
if [ -n "$agent_id" ] && [ -f "$state/gates.jsonl" ]; then
  blocks="$(grep -c "\"decision\":\"block\".*\"agent_id\":\"$agent_id\"" "$state/gates.jsonl" 2>/dev/null || true)"
fi
if [ "${blocks:-0}" -ge "$MAX_BLOCKS" ]; then
  log_gate allow max_blocks_reached
  exit 0
fi

log_gate block tests_failed
{
  echo "Acceptance gate failed: $cmd"
  printf '%s\n' "$out" | tail -n 40
  echo "Fix the root cause and rerun before finishing."
} >&2
exit 2
