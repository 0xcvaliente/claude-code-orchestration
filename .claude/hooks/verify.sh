#!/usr/bin/env bash
# SubagentStop gate: block an implementer from finishing while the test command fails.
# Test command: $ORCH_TEST_CMD, else detected by test-cmd.sh (npm, pytest/unittest, cargo, go, swift, make).
# Isolated worktrees (cwd under .claude/worktrees/) follow ORCH_GATE_ISOLATED, because sibling slices
# may not be merged yet: warn (default: run tests, log tests_failed_isolated, never block),
# block (gate as usual), skip (do not run tests).
# Exit 2 blocks and returns stderr to the agent; any other exit lets it finish.
# Every decision is appended to .claude/state/gates.jsonl so a run can show whether the gate fired.
set -u

# shellcheck source=test-cmd.sh
source "$(dirname "${BASH_SOURCE[0]}")/test-cmd.sh"

input="$(cat)"
project="${CLAUDE_PROJECT_DIR:-$PWD}"

MAX_BLOCKS=2 # per agent; the cap is the loop guard, so a still-failing agent is rechecked, not waved through

log_gate() { # decision reason
  mkdir -p "$project/.claude/state" 2>/dev/null || return 0
  printf '{"ts":"%s","gate":"test","decision":"%s","reason":"%s","agent_type":"%s","agent_id":"%s"}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$2" "${agent_type:-}" "${agent_id:-}" >> "$project/.claude/state/gates.jsonl" 2>/dev/null || true
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
if [ -n "$agent_id" ] && [ -f "$project/.claude/state/gates.jsonl" ]; then
  blocks="$(grep -c "\"decision\":\"block\".*\"agent_id\":\"$agent_id\"" "$project/.claude/state/gates.jsonl" 2>/dev/null || true)"
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
