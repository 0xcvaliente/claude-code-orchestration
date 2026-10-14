#!/usr/bin/env bash
# Native headless run with triage: size the task first, then run the cheapest route that fits.
#   plain         one claude -p session, no agent
#   reviewed      the same, then a read-only reviewer agent checks the uncommitted change (one pass, no feedback loop)
#   orchestrate   the orchestrator agent
# A triaged plain or reviewed run that fails falls back to the orchestrator (ORCH_NO_ESCALATE=1 turns that off).
# Usage: scripts/auto.sh "task description" [repo]   (repo defaults to the current directory)
# Env: ORCH_MODE (auto|plain|reviewed|orchestrate, default auto: triage decides), plus everything scripts/orchestrate.sh reads.
# Decisions are appended to <repo>/.claude/state/routes.jsonl (--project-state: beside runs.jsonl, even when the
# repo does not register the hooks).
set -uo pipefail

task="${1:?usage: auto.sh \"task\" [repo]}"
repo="${2:-$PWD}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
requested="${ORCH_MODE:-auto}"

decision="$(cd "$root" && npx --no-install tsx src/route.ts --repo "$repo" --task "$task" --mode "$requested" --project-state)" || exit $?
field() { printf '%s' "$decision" | node -p "JSON.parse(require('fs').readFileSync(0,'utf8')).$1"; }
mode="$(field mode)" || exit 1
echo "route: $mode - $(field reason)" >&2

orchestrate() { ORCH_AGENT=orchestrator exec "$here/orchestrate.sh" "$task" "$repo"; }
[ "$mode" = orchestrate ] && orchestrate

ORCH_AGENT=none "$here/orchestrate.sh" "$task" "$repo"
code=$?

if [ "$code" -eq 0 ] && [ "$mode" = reviewed ]; then
  review_prompt="Review the uncommitted change in this repository against this goal: $task
Use git diff HEAD, read untracked files from git status --short, and run the tests if you can find them. Start your reply with STATUS: pass or STATUS: fail."
  # Read-only tools plus the allow rules of the repo's detected test runner (pytest, cargo, go ...) and nothing broader.
  source "$here/../.claude/hooks/test-cmd.sh"
  reviewer_tools=$'Read\nGrep\nGlob\nBash(git diff*)\nBash(git status*)\nBash(git log*)\nBash(git show*)\nBash(npm test*)\nBash(node *)\nBash(ls*)'
  runner_rules="$(orch_allow_rules "$(orch_detect_test_cmd "$repo")")"
  [ -n "$runner_rules" ] && reviewer_tools+=$'\n'"$runner_rules"
  out="$(ORCH_AGENT=reviewer ORCH_ALLOWED_TOOLS="$reviewer_tools" \
    "$here/orchestrate.sh" "$review_prompt" "$repo")"
  status="$(printf '%s' "$out" | node -p 'const r=JSON.parse(require("fs").readFileSync(0,"utf8")).result||"";(/STATUS:\s*(pass|fail)/i.exec(r)||[,"fail"])[1].toLowerCase()' 2>/dev/null || echo fail)"
  echo "review: $status" >&2
  [ "$status" = pass ] || code=1
fi

if [ "$code" -ne 0 ] && [ "$requested" = auto ] && [ -z "${ORCH_NO_ESCALATE:-}" ]; then
  echo "route: orchestrate (escalated) - the $mode run failed; its edits stay uncommitted, the orchestrator works from HEAD" >&2
  orchestrate
fi
exit "$code"
