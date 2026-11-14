#!/usr/bin/env bash
# Headless native orchestration: run the orchestrator agent non-interactively, print its JSON (the session's last
# result, plus orch_totals: the results, turns and wall time of the whole run; scripts/run-result.mjs),
# and log tokens, turns and duration to <repo>/.claude/state/runs.jsonl.
# Usage: scripts/orchestrate.sh "task description" [repo]   (repo: the folder the task is about, default the current directory)
# The folder can be any folder: code, research, writing, analysis or operations. A git repository is needed only for
# code work that uses worktrees. Which agent runs (not ORCH_AGENT=none):
#   1. the folder's own .claude/agents/<name>.md (copy this project's .claude/ in): --agent <name>;
#   2. else the orchestration plugin's copy, --agent orchestration:<name>, when the plugin is enabled in the folder:
#      `claude plugin list --json`, run there (no model call), lists an orchestration@<marketplace> entry with
#      "enabled": true. A folder whose settings disable the plugin counts as not enabled. A line on stderr says so;
#   3. else exit 1 before any model call. Agents under ~/.claude/agents do not count.
# ORCH_AGENT_PREFIX skips both checks; a name that already has a namespace (ORCH_AGENT=orchestration:reviewer) is
# used as it is.
# Env: ORCH_BUDGET_TOKENS (optional token cap, e.g. 500k or 2M, at least 10k; approximate, because claude caps spend only
#        in dollars: converted at 1M tokens per list-price dollar into --max-budget-usd; unset = no cap),
#      ORCH_ALLOWED_TOOLS (one permission rule per line; replaces the default list),
#      ORCH_EXTRA_ALLOWED_TOOLS (one extra permission rule per line, appended to the default list; the default list has
#        no web tools, so add WebSearch and WebFetch for research, scripts/auto.sh does it for a task that is not code),
#      ORCH_MODEL (passes --model, e.g. sonnet or opus, for plain-model baselines),
#      ORCH_TEST_CMD (test command; its permission rules are added automatically, else detected from the repo; a Python
#        runner such as python3 tests/run.py or python3 -m pytest adds Bash(python3 *), so agents can run their own checks),
#      ORCH_AGENT (default orchestrator; "none" = plain session, no agent),
#      ORCH_AGENT_PREFIX (e.g. orchestration: always runs <prefix><name>, the plugin's agents, without checking the
#        folder or the installed plugins; for CI or a plugin loaded another way; a missing trailing colon is added),
#      ORCH_ADD_DIR (extra directory the agents may read, e.g. a project to analyse),
#      ORCH_ADVISOR (e.g. opus; passes --advisor to claude, experimental),
#      ORCH_SESSION_PERSISTENCE=1 (omit --no-session-persistence, so the session and its subagent transcripts are written
#        and telemetry v2 can read per-agent tokens, turns and models at SubagentStop; unset or any other value keeps it),
#      ORCH_DRY_RUN=1 (print the claude arguments, one per line, and exit).
# Every run is told it is unattended (one sentence through --append-system-prompt: nobody can answer a question), so
# the orchestrator plans a new skill without proposing it first. Skill slices: unless ORCH_SKILL_CREATE=off, each
# skills repository set in ORCH_SKILLS_REPO_PRIVATE or ORCH_SKILLS_REPO_PUBLIC (an absolute path to a directory) and
# the draft home <CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/skill-drafts (created when missing) get --add-dir, and
# the Skill tool and the rules for the repositories' validator and the seal command join the allowlist (git -C and git worktree are
# already there). With neither repository set, nothing changes. The rules join a replaced list (ORCH_ALLOWED_TOOLS) too.
set -uo pipefail
export ORCH_NO_NUDGE=1 # the plugin's SessionStart nudge must not re-triage a run that was already routed

task="${1:?usage: orchestrate.sh \"task\" [repo]}"
repo="${2:-$PWD}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# The old dollar cap must fail, not be ignored: a run that relied on it would go uncapped.
if [ -n "${ORCH_BUDGET_USD:-}" ]; then
  echo "ORCH_BUDGET_USD was replaced by ORCH_BUDGET_TOKENS (a token count such as 2M)" >&2
  exit 1
fi
budget_usd=""
if [ -n "${ORCH_BUDGET_TOKENS:-}" ]; then
  budget_usd="$(node "$here/tokens.mjs" budget-usd "$ORCH_BUDGET_TOKENS")" || exit 1
fi
cd "$repo" || exit 1

plugin=orchestration # the plugin name in scripts/build-plugin.mjs
# Whether the plugin is enabled here: claude merges the user, project and local settings of the current folder.
plugin_enabled() {
  claude plugin list --json 2>/dev/null | node -e '
let ok = false;
try {
  const list = JSON.parse(require("fs").readFileSync(0, "utf8"));
  ok = Array.isArray(list) && list.some((p) => typeof p?.id === "string" && p.id.startsWith(process.argv[1] + "@") && p.enabled === true);
} catch {}
process.exit(ok ? 0 : 1);' "$plugin"
}

agent="${ORCH_AGENT:-orchestrator}" # "none" runs a plain session, used as a baseline
if [ "$agent" != none ] && [[ "$agent" != *:* ]]; then
  if [ -n "${ORCH_AGENT_PREFIX:-}" ]; then
    agent="${ORCH_AGENT_PREFIX%:}:$agent"
  elif [ ! -f ".claude/agents/$agent.md" ]; then
    if ! plugin_enabled; then
      echo "no .claude/agents/$agent.md in $repo, and the $plugin plugin is not enabled there (claude plugin list)." >&2
      echo "Copy this project's .claude/ into the folder, or install or enable the plugin; ORCH_AGENT_PREFIX=$plugin: skips this check." >&2
      exit 1
    fi
    echo "agent: $plugin:$agent (the $plugin plugin's; no .claude/agents/$agent.md in $repo)" >&2
    agent="$plugin:$agent"
  fi
fi

# dontAsk denies everything not listed, so an unattended run can never prompt or widen its own access.
# One rule per element: rules contain spaces, so never split them on whitespace.
tools=(
  "Read" "Grep" "Glob" "Agent" "SendMessage" "Edit" "Write"
  "Bash(git status*)" "Bash(git diff*)" "Bash(git log*)" "Bash(git show*)" "Bash(git rev-parse*)"
  "Bash(git add*)" "Bash(git commit*)" "Bash(git merge*)" "Bash(git branch*)" "Bash(git worktree*)"
  "Bash(git -C *)" "Bash(cd *)"
  "Bash(npm *)" "Bash(node *)" "Bash(ls*)" "Bash(mkdir -p *)"
)
if [ -n "${ORCH_ALLOWED_TOOLS:-}" ]; then
  tools=()
  while IFS= read -r rule; do
    [ -n "$rule" ] && tools+=("$rule")
  done <<< "$ORCH_ALLOWED_TOOLS"
else
  # Let the repo's own test runner through (pytest, cargo, go, swift, make ...; a Python runner also gets python3 or
  # python itself, as node is always allowed), then any extra rules.
  source "$here/../.claude/hooks/test-cmd.sh"
  while IFS= read -r rule; do
    [ -n "$rule" ] && tools+=("$rule")
  done < <(orch_allow_rules "$(orch_detect_test_cmd "$repo")")
  while IFS= read -r rule; do
    [ -n "$rule" ] && tools+=("$rule")
  done <<< "${ORCH_EXTRA_ALLOWED_TOOLS:-}"
fi

# Skill slices (see the header): the configured skills repositories and the draft home, and the two commands a skill
# slice runs there that the list above may not cover.
skill_dirs=()
skill_create="$(printf '%s' "${ORCH_SKILL_CREATE:-}" | tr '[:upper:]' '[:lower:]' | tr -d '[:space:]')"
if [ "$skill_create" != off ]; then
  for d in "${ORCH_SKILLS_REPO_PRIVATE:-}" "${ORCH_SKILLS_REPO_PUBLIC:-}"; do
    case "$d" in /*) [ -d "$d" ] && skill_dirs+=("$d") ;; esac
  done
  if [ "${#skill_dirs[@]}" -gt 0 ]; then
    drafts="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/orchestration/skill-drafts"
    # Created in a dry run too: bench/lib/*-launch.sh run claude with the dry run's arguments.
    mkdir -p "$drafts" 2>/dev/null && skill_dirs+=("$drafts")
    # Skill: the implementer loads the authoring skill; dontAsk denies an unlisted tool.
    tools+=("Skill" "Bash(python3 scripts/validate.py*)" "Bash(python3 */scripts/validate.py*)" "Bash(node */skill-seal.mjs *)")
  fi
fi

# Block Claude Code's built-in subagents (general-purpose, Explore, Plan, ...) in headless runs: this repo's own agents
# do those jobs, with gates. DENIED_AGENTS in src/config.ts; src/policy.test.ts fails if this line goes away.
export CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1
# Fork subagents (on by default since v2.1.302) inherit the whole conversation and every tool; Agent(fork) is denied too.
export CLAUDE_CODE_FORK_SUBAGENT=0

args=(-p "$task")
[ "$agent" != none ] && args+=(--agent "$agent")
# The event stream, not --output-format json: a session that waits for agents produces one result per wake-up, and
# json prints the last one only. scripts/run-result.mjs reduces the stream to that last result plus the run's totals.
args+=(--output-format stream-json --verbose --permission-mode dontAsk)
# Without transcripts telemetry v2's per-agent tokens, turns and models stay empty; ORCH_SESSION_PERSISTENCE=1 keeps them.
[ "${ORCH_SESSION_PERSISTENCE:-}" = 1 ] || args+=(--no-session-persistence)
[ -n "$budget_usd" ] && args+=(--max-budget-usd "$budget_usd")
# Experimental advisor (second, stronger model consulted at decision points); see the docs' /advisor page.
[ -n "${ORCH_ADVISOR:-}" ] && args+=(--advisor "$ORCH_ADVISOR")
[ -n "${ORCH_MODEL:-}" ] && args+=(--model "$ORCH_MODEL")
[ -n "${ORCH_ADD_DIR:-}" ] && args+=(--add-dir "$ORCH_ADD_DIR")
# One --add-dir per skills directory: the option is variadic, so each takes exactly one value here.
[ "${#skill_dirs[@]}" -gt 0 ] && for d in "${skill_dirs[@]}"; do args+=(--add-dir "$d"); done
# Headless: nobody reads a question before the run ends (the orchestrator then decides instead of asking).
args+=(--append-system-prompt "This run is unattended: nobody can answer a question during this run, so decide and proceed instead of asking.")
# Never publish or escalate, whatever the folder's settings say (a plugin user's folder has no deny list, and this
# repo's leaves git push to interactive sessions). A deny beats every allow rule, so `Bash(git -C *)` cannot reach a
# push. UNSAFE_BASH in src/config.ts; src/verify.test.ts fails on drift. Variadic: keep it before --allowedTools.
args+=(--disallowedTools "Bash(git push*)" "Bash(git * push*)" "Bash(git remote*)" "Bash(git * remote*)"
  "Bash(sudo*)" "Bash(rm -rf*)" "Bash(rm -fr*)" "Bash(rm -r -f*)" "Bash(rm -f -r*)")
args+=(--allowedTools "${tools[@]}") # variadic: keep it last

if [ -n "${ORCH_DRY_RUN:-}" ]; then
  printf '%s\n' "${args[@]}"
  exit 0
fi

stream="$(mktemp "${TMPDIR:-/tmp}/orch-run.XXXXXX")" || exit 1
trap 'rm -f "$stream"' EXIT
start_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
code=0
claude "${args[@]}" > "$stream" || code=$?
# One JSON document, as before: the last result, with orch_totals (results, turns, wall_ms) for the whole run.
out="$(node "$here/run-result.mjs" "$stream" "$start_ms")" || out="$(cat "$stream")"

printf '%s\n' "$out"
printf '%s' "$out" | node "$here/log-run.mjs" "$task" || true
exit "$code"
