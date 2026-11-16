#!/usr/bin/env bash
# Launcher for the N-UC arm (bench/arms.mjs): Claude Code as shipped, with built-in subagents and fork subagents allowed.
# Usage: native-launch.sh <root> "prompt" <repo>
# scripts/orchestrate.sh exports CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1 and CLAUDE_CODE_FORK_SUBAGENT=0 for every run,
# which would block native subagents and workflow agents. So this script asks orchestrate.sh for its claude arguments
# (ORCH_DRY_RUN=1, same ORCH_* environment: model, test-command rules, extra allowed tools, budget, unsafe-Bash deny list)
# and runs claude itself with those arguments and without the two exports. orchestrate.sh's per-repo run log is skipped;
# the bench reads tokens from claude's JSON on stdout like every other arm. orchestrate.sh asks claude for its event
# stream and reduces it (scripts/run-result.mjs); nothing reduces it here, so this script asks for the one JSON document.
set -uo pipefail
root="${1:?root}"
prompt="${2:?prompt}"
repo="${3:?repo}"
placeholder="__BENCH_PROMPT_PLACEHOLDER__" # the dry run prints one argument per line, so pass a one-line stand-in
args=()
prev=""
while IFS= read -r a; do
  if [ "$a" = "$placeholder" ]; then args+=("$prompt")
  elif [ "$prev" = "--output-format" ] && [ "$a" = "stream-json" ]; then args+=("json")
  elif [ "$a" = "--verbose" ]; then :
  else args+=("$a"); fi
  prev="$a"
done < <(ORCH_DRY_RUN=1 bash "$root/scripts/orchestrate.sh" "$placeholder" "$repo")
[ "${#args[@]}" -gt 0 ] || { echo "native-launch: orchestrate.sh printed no arguments" >&2; exit 1; }
unset CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS CLAUDE_CODE_FORK_SUBAGENT
cd "$repo" || exit 1
[ -n "${BENCH_LAUNCH_DRY_RUN:-}" ] && { printf '%s\n' "${args[@]}"; exit 0; }
exec claude "${args[@]}"
