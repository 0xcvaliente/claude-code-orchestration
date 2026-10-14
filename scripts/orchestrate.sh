#!/usr/bin/env bash
# Headless native orchestration: run the orchestrator agent non-interactively, print its JSON,
# and log cost and turns to <repo>/.claude/state/runs.jsonl.
# Usage: scripts/orchestrate.sh "task description" [repo]   (repo defaults to the current directory)
# The repo needs .claude/agents/ (copy this project's .claude/ into it, or install it at user level).
# Env: ORCH_BUDGET_USD (optional spend cap, an estimate at list price; unset = no dollar cap),
#      ORCH_ALLOWED_TOOLS (one permission rule per line; replaces the default list),
#      ORCH_EXTRA_ALLOWED_TOOLS (one extra permission rule per line, appended to the default list),
#      ORCH_MODEL (passes --model, e.g. sonnet or opus, for plain-model baselines),
#      ORCH_TEST_CMD (test command; its permission rules are added automatically, else detected from the repo),
#      ORCH_AGENT (default orchestrator; "none" = plain session, no agent),
#      ORCH_ADD_DIR (extra directory the agents may read, e.g. a project to analyse),
#      ORCH_ADVISOR (e.g. opus; passes --advisor to claude, experimental),
#      ORCH_DRY_RUN=1 (print the claude arguments, one per line, and exit).
set -uo pipefail
export ORCH_NO_NUDGE=1 # the plugin's SessionStart nudge must not re-triage a run that was already routed

task="${1:?usage: orchestrate.sh \"task\" [repo]}"
repo="${2:-$PWD}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo" || exit 1

agent="${ORCH_AGENT:-orchestrator}" # "none" runs a plain session, used as a baseline
if [ "$agent" != none ] && [ ! -d .claude/agents ]; then
  echo "no .claude/agents in $repo" >&2
  exit 1
fi

# dontAsk denies everything not listed, so an unattended run can never prompt or widen its own access.
# One rule per element: rules contain spaces, so never split them on whitespace.
tools=(
  "Read" "Grep" "Glob" "Agent" "SendMessage" "Edit" "Write"
  "Bash(git status*)" "Bash(git diff*)" "Bash(git log*)" "Bash(git show*)" "Bash(git rev-parse*)"
  "Bash(git add*)" "Bash(git commit*)" "Bash(git merge*)" "Bash(git branch*)" "Bash(git worktree*)"
  "Bash(git -C *)" "Bash(cd *)"
  "Bash(npm *)" "Bash(node *)" "Bash(ls*)"
)
if [ -n "${ORCH_ALLOWED_TOOLS:-}" ]; then
  tools=()
  while IFS= read -r rule; do
    [ -n "$rule" ] && tools+=("$rule")
  done <<< "$ORCH_ALLOWED_TOOLS"
else
  # Let the repo's own test runner through (pytest, cargo, go, swift, make ...), then any extra rules.
  source "$here/../.claude/hooks/test-cmd.sh"
  while IFS= read -r rule; do
    [ -n "$rule" ] && tools+=("$rule")
  done < <(orch_allow_rules "$(orch_detect_test_cmd "$repo")")
  while IFS= read -r rule; do
    [ -n "$rule" ] && tools+=("$rule")
  done <<< "${ORCH_EXTRA_ALLOWED_TOOLS:-}"
fi

args=(-p "$task")
[ "$agent" != none ] && args+=(--agent "$agent")
args+=(--output-format json --permission-mode dontAsk --no-session-persistence)
[ -n "${ORCH_BUDGET_USD:-}" ] && args+=(--max-budget-usd "$ORCH_BUDGET_USD")
# Experimental advisor (second, stronger model consulted at decision points); see the docs' /advisor page.
[ -n "${ORCH_ADVISOR:-}" ] && args+=(--advisor "$ORCH_ADVISOR")
[ -n "${ORCH_MODEL:-}" ] && args+=(--model "$ORCH_MODEL")
[ -n "${ORCH_ADD_DIR:-}" ] && args+=(--add-dir "$ORCH_ADD_DIR")
args+=(--allowedTools "${tools[@]}") # variadic: keep it last

if [ -n "${ORCH_DRY_RUN:-}" ]; then
  printf '%s\n' "${args[@]}"
  exit 0
fi

code=0
out="$(claude "${args[@]}")" || code=$?

printf '%s\n' "$out"
printf '%s' "$out" | node "$here/log-run.mjs" "$task" || true
exit "$code"
