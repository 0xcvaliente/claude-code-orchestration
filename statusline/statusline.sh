#!/bin/bash
# Claude Code status line: model, folder, git branch and changes, rate-limit windows and context fill. Needs jq.
# Turn it on with the statusLine setting; see README "Statusline" or run `npm run install-statusline`.
input=$(cat)

if ! command -v jq > /dev/null 2>&1; then
  echo "statusline: jq not found (install jq to see the model, branch and context bar)"
  exit 0
fi

# All fields in one jq call, one per line (newlines inside a value become spaces); a missing field is an empty line.
{
  IFS= read -r MODEL; IFS= read -r DIR; IFS= read -r PCT; IFS= read -r ADDED; IFS= read -r REMOVED
  IFS= read -r FIVE_PCT; IFS= read -r FIVE_RESET; IFS= read -r WEEK_PCT; IFS= read -r WEEK_RESET
} < <(printf '%s' "$input" | jq -r '
  [ .model.display_name, .workspace.current_dir, (.context_window.used_percentage // 0),
    (.cost.total_lines_added // 0), (.cost.total_lines_removed // 0),
    (.rate_limits.five_hour.used_percentage // ""), (.rate_limits.five_hour.resets_at // ""),
    (.rate_limits.seven_day.used_percentage // ""), (.rate_limits.seven_day.resets_at // "") ]
  | .[] | (if type == "string" then . else tojson end) | gsub("[\n\r]"; " ")' 2>/dev/null)

# int <value>: the whole-number part of a number, or empty when the value is not a number
int() {
  local v="${1%%.*}"
  case "$v" in ''|*[!0-9]*) v="" ;; esac
  printf '%s' "$v"
}
PCT=$(int "$PCT"); [ -z "$PCT" ] && PCT=0
ADDED=$(int "$ADDED"); [ -z "$ADDED" ] && ADDED=0
REMOVED=$(int "$REMOVED"); [ -z "$REMOVED" ] && REMOVED=0

# Real escape bytes, so the lines go out through printf '%s' and a backslash in a name is printed as it is.
CYAN=$'\033[36m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; PURPLE=$'\033[38;5;183m'; BLUE=$'\033[38;5;75m'; RESET=$'\033[0m'

# Pick bar color based on context usage
if [ "$PCT" -ge 90 ]; then BAR_COLOR="$RED"
elif [ "$PCT" -ge 70 ]; then BAR_COLOR="$YELLOW"
else BAR_COLOR="$GREEN"; fi

# dots_bar <filled> <total>: spaced dots, e.g. "● ● ○ ○"
dots_bar() {
  local out="" i
  for ((i = 0; i < $2; i++)); do
    if [ "$i" -lt "$1" ]; then out+="● "; else out+="○ "; fi
  done
  printf '%s' "${out% }"
}
BAR=$(dots_bar $((PCT / 10)) 10)

BRANCH=""
if git rev-parse --git-dir > /dev/null 2>&1; then
  BRANCH=" | 🌿 $(git branch --show-current 2>/dev/null)"
  # Tracked changes only, no index lock, and at most about a second (macOS has no `timeout`). git and a watchdog
  # each run in a process group of their own (set -m); the script waits for git itself, and the watchdog kills
  # git's group (git and everything it started) at the limit, in which case the line shows no dirty count. The
  # EXIT trap kills both groups and removes the temp file, also when the script itself is killed.
  # From the temp file to the storing of both job ids, TERM, INT and HUP are only recorded (a signal between a fork
  # and its `$!` assignment had run the EXIT trap with the id still empty, leaving that group running) and acted on
  # once both ids are set. Recorded, never ignored: an ignored signal is inherited by git, which the watchdog ends with TERM.
  DIRTY=""; STATUS_PID=""; WATCH_PID=""; STATUS_OUT=""; GOT_SIG=""
  git_cleanup() {
    local p
    [ -n "$WATCH_PID" ] && kill -TERM -- "-$WATCH_PID" 2>/dev/null
    [ -n "$STATUS_PID" ] && kill -TERM -- "-$STATUS_PID" 2>/dev/null
    # second line of defence: the group of any job still listed
    for p in $(jobs -p 2>/dev/null); do kill -TERM -- "-$p" 2>/dev/null; done
    [ -n "$STATUS_OUT" ] && rm -f "$STATUS_OUT"
    WATCH_PID=""; STATUS_PID=""; STATUS_OUT=""
  }
  trap git_cleanup EXIT
  trap 'GOT_SIG=143' TERM; trap 'GOT_SIG=130' INT; trap 'GOT_SIG=129' HUP
  STATUS_OUT=$(mktemp "${TMPDIR:-/tmp}/statusline.XXXXXX" 2>/dev/null)
  if [ -n "$STATUS_OUT" ] && [ -z "$GOT_SIG" ]; then
    set -m
    git --no-optional-locks status --porcelain --untracked-files=no > "$STATUS_OUT" 2>/dev/null < /dev/null &
    STATUS_PID=$!
    (sleep 1; kill -TERM -- "-$STATUS_PID" || kill -TERM "$STATUS_PID") > /dev/null 2>&1 < /dev/null &
    WATCH_PID=$!
    set +m
  fi
  trap 'exit 143' TERM; trap 'exit 130' INT; trap 'exit 129' HUP
  [ -n "$GOT_SIG" ] && exit "$GOT_SIG"
  if [ -n "$STATUS_PID" ]; then
    wait "$STATUS_PID" 2>/dev/null
    rc=$?
    STATUS_PID=""
    [ "$rc" -lt 128 ] && DIRTY=$(wc -l < "$STATUS_OUT" 2>/dev/null | tr -d ' ')
    git_cleanup
    wait 2>/dev/null
  fi
  case "$DIRTY" in ''|*[!0-9]*) DIRTY=0 ;; esac
  [ "$DIRTY" -gt 0 ] && BRANCH="$BRANCH ${YELLOW}*${DIRTY}${RESET}"
fi

LINES=""
if [ "$ADDED" -gt 0 ] || [ "$REMOVED" -gt 0 ]; then
  LINES=" | ${GREEN}+${ADDED}${RESET} ${RED}-${REMOVED}${RESET}"
fi

printf '%s\n' "${CYAN}[$MODEL]${RESET} 📁 ${DIR##*/}$BRANCH$LINES"

# Rate limit windows; only present for Claude.ai subscribers after the first response
# usage_window <used %> <resets_at epoch> <fallback label> <color> <short window?>
NOW=$(date +%s)
# day_label <epoch>: "Mar 5" in local time; GNU date reads an epoch with -d @N, BSD/macOS date with -r N
day_label() {
  if date --version > /dev/null 2>&1; then date -d "@$1" +"%b %-d" 2>/dev/null; else date -r "$1" +"%b %-d" 2>/dev/null; fi
}
usage_window() {
  local pct reset name left_txt left filled
  pct=$(int "$1")
  [ -z "$pct" ] && return
  reset=$(int "$2")
  name="$3"; left_txt=""
  if [ -n "$reset" ]; then
    left=$((reset - NOW))
    if [ "$5" = short ]; then
      if [ "$left" -ge 3600 ]; then left_txt=" ($((left / 3600))h left)"
      elif [ "$left" -gt 0 ]; then left_txt=" ($((left / 60))m left)"; fi
    else
      name=$(day_label "$reset"); [ -z "$name" ] && name="$3"
      if [ "$left" -ge 86400 ]; then left_txt=" ($(((left + 43200) / 86400))d left)"
      elif [ "$left" -gt 0 ]; then left_txt=" ($((left / 3600))h left)"; fi
    fi
  fi
  filled=$((pct / 10)); [ "$filled" -gt 10 ] && filled=10
  printf '%s' "${4}[${name}]${left_txt} $(dots_bar "$filled" 10) ${pct}%${RESET}  "
}
LIMITS="$(usage_window "$FIVE_PCT" "$FIVE_RESET" 5h "$BLUE" short)$(usage_window "$WEEK_PCT" "$WEEK_RESET" 7d "$PURPLE")"

printf '%s\n' "${LIMITS}${BAR_COLOR}[ctx] ${BAR} ${PCT}%${RESET}"
