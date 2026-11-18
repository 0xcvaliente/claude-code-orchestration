#!/usr/bin/env bash
# Headless native orchestration: run the orchestrator agent non-interactively, print its JSON (the session's last
# result, plus orch_totals: the results, turns and wall time of the whole run; scripts/run-result.mjs; on a terminal, the
# result text and one line of turns, seconds and exit code instead),
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
#      ORCH_AGENT (default orchestrator; "none" = plain session, no agent, also in a folder whose settings name one),
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
here="$(CDPATH='' cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd)" # CDPATH cleared: a relative dirname must not find another folder
# The old dollar cap must fail, not be ignored: a run that relied on it would go uncapped.
if [ -n "${ORCH_BUDGET_USD:-}" ]; then
  echo "ORCH_BUDGET_USD was replaced by ORCH_BUDGET_TOKENS (a token count such as 2M)" >&2
  exit 1
fi
# The plain session's output style (ORCH_AGENT=none only): unset is Claude Code's built-in Concise; "default" or empty
# passes none (Claude Code's default style); any other value must be a plain word, the name of a style.
style="${ORCH_OUTPUT_STYLE-Concise}"
[ "$style" = default ] && style=""
if [ -n "$style" ] && ! [[ "$style" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
  echo "ORCH_OUTPUT_STYLE must be a style name of letters, digits, _ and -, or default" >&2
  exit 1
fi
budget_usd=""
if [ -n "${ORCH_BUDGET_TOKENS:-}" ]; then
  budget_usd="$(node "$here/tokens.mjs" budget-usd "$ORCH_BUDGET_TOKENS")" || exit 1
fi
# Absolute once, before the cd: later steps (the test runner detection) take $repo again, and a relative path would
# then point at <repo>/<repo>. A missing folder stays an error. CDPATH is cleared so cd prints nothing.
repo="$(CDPATH='' cd -- "$repo" && pwd)" || exit 1
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
  "Bash(git reset --merge)" # the integrator's last resort when git merge --abort fails; exactly this form, no other reset
  # git -C <dir> reads (reviewer and researcher), any folder. The `*` for the folder can also stand for other words, so
  # these rules also match some other git commands; the git denies below stop the plain destructive forms, not every one.
  # The git -C writes are pinned to known folders below (git_c_rules).
  "Bash(git -C * status*)" "Bash(git -C * diff*)" "Bash(git -C * log*)" "Bash(git -C * show*)" "Bash(git -C * rev-parse*)"
  "Bash(git -C * ls-files*)" "Bash(git -C * rev-list*)"
  "Bash(cd *)"
  "Bash(npm *)" "Bash(node *)" "Bash(ls*)" "Bash(mkdir -p *)"
)

# git -C <dir> with a subcommand that writes (or names the branch): pinned to the folders the callers use, the project
# folder and its worktrees under <folder>/.claude/worktrees/ (here), a skill slice's skills repositories and draft
# worktrees (below). Claude Code warns that a `*` before the subcommand also stands for options inserted there (`-c`,
# `--exec-path`); a literal folder leaves no such gap, and the worktree's name is the only `*` left before a
# subcommand. A folder is written into a rule only when every character of it is a plain one (letters, digits, bytes of
# a non-ASCII letter, space and _@%+=:,./-): a `*`, `?`, `[`, quote, backslash, `$` or `(` in a folder would widen or
# break the rule, so that folder gets no rule and its git -C writes are refused (plain `git add` and the like in the
# agent's own folder still run). A folder the plan check would quote gets the rule as '<dir>' and "<dir>" (and bare
# too, unless it holds a space).
git_dir_ok() {
  local LC_ALL=C hi=$'\x80'-$'\xff'
  case "$1" in /*) ;; *) return 1 ;; esac
  # shellcheck disable=SC2295 # hi is a byte range for the bracket expression, unquoted on purpose
  [[ "$1" != *[!A-Za-z0-9_@%+=:,./\ ${hi}-]* ]]
}
pinned_dirs=() # folders already given rules, so the same folder is not listed twice
# git_c_rules <dir> <suffix> <subcommand form...>: one allow rule per form for `git -C <dir><suffix> <form>`. The suffix
# is fixed text from this script (the worktree's `/*`), never a path from outside.
git_c_rules() {
  local dir="$1" suffix="$2" d f s
  shift 2
  [ -n "$dir" ] || return 0
  # ${a[@]+...}: bash 3.2 (macOS) with set -u counts an empty array as unbound.
  for d in ${pinned_dirs[@]+"${pinned_dirs[@]}"}; do [ "$d" = "$dir$suffix" ] && return 0; done
  pinned_dirs+=("$dir$suffix")
  if ! git_dir_ok "$dir"; then
    echo "orchestrate.sh: no git -C write rules for $dir$suffix (a character in it cannot be pinned in a permission rule)" >&2
    return 0
  fi
  local forms=("$dir$suffix")
  # Quoted forms for every folder the plan check's sh() quotes (a character outside [A-Za-z0-9_@%+=:,./-], so a space or
  # a non-ASCII letter), so the hook's own `git -C '<dir>' ...` is allowed; a folder with a space has no bare form.
  if ! (LC_ALL=C; [[ "$dir" != *[!A-Za-z0-9_@%+=:,./-]* ]]); then
    forms=("'$dir$suffix'" "\"$dir$suffix\"")
    [[ "$dir" == *' '* ]] || forms+=("$dir$suffix")
  fi
  for f in "${forms[@]}"; do
    for s in "$@"; do tools+=("Bash(git -C $f $s)"); done
  done
}
PROJECT_GIT=("branch --show-current" "worktree list*" "worktree add *" "add *" "commit *" "merge *" "reset --merge")
WORKTREE_GIT=("branch --show-current" "add *" "commit *") # Claude Code still warns about these: the name is a `*`
if [ -z "${ORCH_ALLOWED_TOOLS:-}" ]; then
  # The project folder as given and as its real path, and the top of its git work tree when the folder is below it.
  top="$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null)" || top=""
  for d in "$repo" "$(pwd -P)" "$top"; do
    git_c_rules "$d" "" "${PROJECT_GIT[@]}"
    [ -n "$d" ] && git_c_rules "$d" "/.claude/worktrees/*" "${WORKTREE_GIT[@]}"
  done
fi
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
    # git -C writes there, pinned as above (the default list only: a replaced list had no git -C rules before either):
    # the draft worktree is added from a skills repository, and committed in under skill-drafts/<target>/<name>.
    if [ -z "${ORCH_ALLOWED_TOOLS:-}" ]; then
      for d in "${skill_dirs[@]}"; do
        [ "$d" = "$drafts" ] && continue
        git_c_rules "$d" "" "branch --show-current" "worktree list*" "worktree add *"
        git_c_rules "$(CDPATH='' cd -- "$d" 2>/dev/null && pwd -P)" "" "branch --show-current" "worktree list*" "worktree add *"
      done
      git_c_rules "$drafts" "/*" "${WORKTREE_GIT[@]}"
      git_c_rules "$(CDPATH='' cd -- "$drafts" 2>/dev/null && pwd -P)" "/*" "${WORKTREE_GIT[@]}"
    fi
  fi
fi

# Block Claude Code's built-in subagents (general-purpose, Explore, Plan, ...) in headless runs: this repo's own agents
# do those jobs, with gates. DENIED_AGENTS in src/config.ts; src/policy.test.ts fails if this line goes away.
export CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1
# Fork subagents (on by default since v2.1.302) inherit the whole conversation and every tool; Agent(fork) is denied too.
export CLAUDE_CODE_FORK_SUBAGENT=0

# The task is claude's positional prompt. A task that starts with a dash would be read as an option after -p, so it goes
# after `--` at the very end instead (see the end of this list; probed on Claude Code 2.1.325:
# docs/data/live-checks-2026-11-16.md, Check 5). Any other task keeps its place after -p.
args=(-p)
case "$task" in -*) ;; *) args+=("$task") ;; esac
if [ "$agent" != none ]; then
  args+=(--agent "$agent") # the flag wins over an `agent` setting in the folder
else
  # A plain session must stay plain. A folder's settings can name a main agent (this repo's .claude/settings.json sets
  # "agent": "orchestrator", and a copy of .claude/ carries it along), and `claude -p` would then run as that agent,
  # with its tools. An empty `agent` in the flag settings, which rank above the folder's, gives the default agent back
  # (probed on Claude Code 2.1.325: docs/data/live-checks-2026-11-16.md). The same JSON names the output style, Concise
  # unless ORCH_OUTPUT_STYLE says otherwise (Check 5 there; the key and the case-sensitive name are Claude Code's).
  if [ -z "$style" ]; then
    args+=(--settings '{"agent":""}')
  else
    args+=(--settings "{\"agent\":\"\",\"outputStyle\":\"$style\"}")
  fi
fi
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
# repo's leaves git push to interactive sessions). A deny beats every allow rule. The first line is UNSAFE_BASH in
# src/config.ts (src/verify.test.ts fails on drift). The git lines are for headless runs only. They stop the plain
# destructive forms an agent might run by mistake: -c and --config-env (an alias that pushes, a hooks folder that runs
# any program), reset --hard in any spelling, clean with options; and the global options that take a separate value
# (--namespace, --git-dir, --work-tree, --exec-path, --super-prefix, --attr-source, a second -C), so such a value cannot
# pose as the subcommand of a `git -C * <subcommand>*` rule. They do not stop a command built to get around them: a
# `git -C * status*` rule also matches `git -C /r branch -D main status`. A guard against mistakes, not a boundary.
# `git * -c*` also refuses a commit whose message has " -c" in it. `git -C */../*` stops a path that climbs out of a
# pinned folder (`<repo>/.claude/worktrees/../../x`); it also refuses an argument with `/../` in it. Variadic: keep it before --allowedTools.
# Every `git -C` allow rule has a `*` before a later fixed word (the folder, or a worktree's name), and that `*` can stand
# for a whole subcommand: `git -C * status*` also matches `git -C /r branch -D main status`. GIT_C_DESTRUCTIVE_DENY
# denies these forms after `git -C <dir>`. Claude Code reads every `*` as any run of characters, so `-*D*` is an option
# word followed anywhere later by the letter: a short option inside a cluster (`-qD`), after other words (`branch a b -m`)
# or spelled long (`--delete` holds d) all match.
#   branch with an option holding d, D, m, M, f or C (delete, rename, force, copy over);
#   checkout with `--`, an option holding f, B or m (--force, -B, --merge), --ours or --theirs, or a `.` or `:` path;
#   switch with an option holding f, m or C (--force, --merge, -C), or --discard-changes;
#   restore with any option, or a `.`, `:` or absolute path;
#   reset with an option followed by any word (`reset --merge HEAD~3`, `reset -N x`), any option after a word
#   (`reset main --soft`), --soft, --mixed, --keep or -q anywhere, or HEAD, @ or *_HEAD as its revision; only the bare
#   `reset --merge` (the integrator's last resort) is left, since a rule for "anything after --merge" needs that word;
#   update-ref, symbolic-ref, gc with --prune, reflog expire|delete, worktree remove with an option holding f,
#   stash drop|clear, rebase with an option anywhere or HEAD or @ as its revision, filter-branch;
#   a fetch or pull with a refspec destination (a `:` in a later argument) or an option holding f (--force; in another
#   repository a destination is a push, audit J-11);
#   rm with an option anywhere, tag with an option holding d or f, config with a dotted key or an option (no `git -C`
#   form of rm, tag or config is on the allow list).
# `git --git-dir` and `--work-tree` as the first word are denied too (after it, the denies above already do).
# Over-blocks: a rule cannot tell a commit message or a path from a subcommand. A commit whose message holds one of the
# words above after a space (branch, checkout, switch, restore, reset, rebase, rm, tag, fetch, pull) followed later by an option word
# (a second -m, `--` before paths, --no-verify) or by the phrase a rule names (`reset HEAD`, `fetch of a:b`), or holds
# `config ` followed later by a `.`, is refused; so is a relative `-C` folder that starts with one of those words.
# Out of reach (src/orchestrate-sh.test.mjs pins each as a limit): a form whose argument is a plain path, revision or
# branch name with no option, which a rule cannot tell from an everyday word: `git -C /r restore src status`,
# `reset main status` (also a commit id or origin/main), `rebase main status`, `checkout main src status`,
# `rm src status`, `pull <path> main status` (it merges into that repository's branch), `worktree remove <worktree> status`.
# No rule ends in `:*`, which Claude Code reads as its older prefix form, so the refspec and pathspec-magic rules end in `:**`.
GIT_C_DESTRUCTIVE_DENY=(
  "Bash(git -C * branch* -*d*)" "Bash(git -C * branch* -*D*)" "Bash(git -C * branch* -*m*)" "Bash(git -C * branch* -*M*)"
  "Bash(git -C * branch* -*f*)" "Bash(git -C * branch* -*C*)"
  "Bash(git -C * checkout* -- *)" "Bash(git -C * checkout* -*f*)" "Bash(git -C * checkout* -*B*)" "Bash(git -C * checkout* -*m*)"
  "Bash(git -C * checkout* --o*)" "Bash(git -C * checkout* --th*)" "Bash(git -C * checkout .*)" "Bash(git -C * checkout :**)"
  "Bash(git -C * switch* -*f*)" "Bash(git -C * switch* -*m*)" "Bash(git -C * switch* -*C*)" "Bash(git -C * switch* --di*)"
  "Bash(git -C * restore* -*)" "Bash(git -C * restore .*)" "Bash(git -C * restore :**)" "Bash(git -C * restore /*)"
  "Bash(git -C * reset -* *)" "Bash(git -C * reset * -*)" "Bash(git -C * reset* --s*)" "Bash(git -C * reset* --mi*)"
  "Bash(git -C * reset* --k*)" "Bash(git -C * reset* -q*)" "Bash(git -C * reset HEAD*)" "Bash(git -C * reset @*)"
  "Bash(git -C * reset *_HEAD*)"
  "Bash(git -C * update-ref*)" "Bash(git -C * symbolic-ref*)" "Bash(git -C * gc *--prune*)"
  "Bash(git -C * reflog expire*)" "Bash(git -C * reflog delete*)" "Bash(git -C * worktree remove* -*f*)"
  "Bash(git -C * stash drop*)" "Bash(git -C * stash clear*)"
  "Bash(git -C * rebase* -*)" "Bash(git -C * rebase HEAD*)" "Bash(git -C * rebase @*)" "Bash(git -C * filter-branch*)"
  "Bash(git -C * fetch * *:**)" "Bash(git -C * fetch* -*f*)" "Bash(git -C * pull * *:**)" "Bash(git -C * pull* -*f*)"
  "Bash(git -C * rm* -*)" "Bash(git -C * tag* -*d*)" "Bash(git -C * tag* -*f*)" "Bash(git -C * config *.*)" "Bash(git -C * config -*)"
  "Bash(git --git-dir*)" "Bash(git --work-tree*)"
)
args+=(--disallowedTools "Bash(git push*)" "Bash(git * push*)" "Bash(git remote*)" "Bash(git * remote*)"
  "Bash(sudo*)" "Bash(rm -rf*)" "Bash(rm -fr*)" "Bash(rm -r -f*)" "Bash(rm -f -r*)"
  "Bash(git -c*)" "Bash(git * -c*)" "Bash(git --config-env*)" "Bash(git * --config-env*)"
  "Bash(git reset *--h*)" "Bash(git * reset *--h*)" "Bash(git clean*)" "Bash(git * clean -*)"
  "Bash(git * --namespace*)" "Bash(git * --git-dir*)" "Bash(git * --work-tree*)" "Bash(git * --exec-path*)"
  "Bash(git * --super-prefix*)" "Bash(git * --attr-source*)" "Bash(git * -C *)" "Bash(git -C */../*)"
  "${GIT_C_DESTRUCTIVE_DENY[@]}")
args+=(--allowedTools "${tools[@]}") # variadic: keep it last, or end it with `--`
# `--` ends both the variadic --allowedTools and option parsing, so a dash-led task is the prompt.
case "$task" in -*) args+=(-- "$task") ;; esac

if [ -n "${ORCH_DRY_RUN:-}" ]; then
  printf '%s\n' "${args[@]}"
  exit 0
fi

stream="$(mktemp "${TMPDIR:-/tmp}/orch-run.XXXXXX")" || exit 1
trap 'rm -f "$stream"' EXIT
start_ms="$(node -e 'process.stdout.write(String(Date.now()))')"
code=0
claude "${args[@]}" > "$stream" || code=$?
# One JSON document, as before: the last result, with orch_totals (results, turns, wall_ms, and exit_code and complete
# from claude's exit code, so a run cut short after an interim result is marked) for the whole run.
out="$(node "$here/run-result.mjs" "$stream" "$start_ms" "$code")" || out="$(cat "$stream")"

# A person in a terminal reads the result text and one totals line; a pipe or a capture (auto.sh, the bench, jq) gets the
# JSON document as before.
if [ -t 1 ]; then
  printf '%s' "$out" | node "$here/run-result.mjs" --terminal || printf '%s\n' "$out"
else
  printf '%s\n' "$out"
fi
printf '%s' "$out" | node "$here/log-run.mjs" "$task" "$code" || true
exit "$code"
