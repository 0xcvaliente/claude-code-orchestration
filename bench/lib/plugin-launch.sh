#!/usr/bin/env bash
# Launcher for the plugin arms (O-mix-plugin, O-mix-030 in bench/arms.mjs): the orchestrator from a plugin folder loaded with
# --plugin-dir, so a run can use a plugin build other than the installed one (the 0.3.0 baseline is dist/plugin at ef62288).
# Usage: plugin-launch.sh <root> "prompt" <repo> <plugin dir>
# Asks scripts/orchestrate.sh for its claude arguments (ORCH_DRY_RUN=1, same ORCH_* environment; the arm sets
# ORCH_AGENT_PREFIX=orchestration: so the agent is orchestration:orchestrator without a plugin check), puts
# --plugin-dir <plugin dir> first and runs claude in the repo. Unlike native-launch.sh it keeps orchestrate.sh's two
# exports that block built-in and fork subagents, as a normal orchestrated run has them. orchestrate.sh's per-repo run
# log is skipped; the bench reads tokens from claude's JSON on stdout like every other arm.
set -uo pipefail
root="${1:?root}"
prompt="${2:?prompt}"
repo="${3:?repo}"
plugin="${4:?plugin dir}"
[ -f "$plugin/.claude-plugin/plugin.json" ] || { echo "plugin-launch: no .claude-plugin/plugin.json in $plugin" >&2; exit 1; }
placeholder="__BENCH_PROMPT_PLACEHOLDER__" # the dry run prints one argument per line, so pass a one-line stand-in
args=(--plugin-dir "$plugin")
n=0
while IFS= read -r a; do
  n=$((n + 1))
  if [ "$a" = "$placeholder" ]; then args+=("$prompt"); else args+=("$a"); fi
done < <(ORCH_DRY_RUN=1 bash "$root/scripts/orchestrate.sh" "$placeholder" "$repo")
[ "$n" -gt 0 ] || { echo "plugin-launch: orchestrate.sh printed no arguments" >&2; exit 1; }
export CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1 CLAUDE_CODE_FORK_SUBAGENT=0 ORCH_NO_NUDGE=1
cd "$repo" || exit 1
[ -n "${BENCH_LAUNCH_DRY_RUN:-}" ] && { printf '%s\n' "${args[@]}"; exit 0; }
exec claude "${args[@]}"
