#!/bin/bash
# Claude Code status line: model, folder, git branch and changes, rate-limit windows and context fill. Needs jq.
# Turn it on with the statusLine setting; see README "Statusline" or run `npm run install-statusline`.
input=$(cat)

MODEL=$(echo "$input" | jq -r '.model.display_name')
DIR=$(echo "$input" | jq -r '.workspace.current_dir')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
ADDED=$(echo "$input" | jq -r '.cost.total_lines_added // 0')
REMOVED=$(echo "$input" | jq -r '.cost.total_lines_removed // 0')

CYAN='\033[36m'; GREEN='\033[32m'; YELLOW='\033[33m'; RED='\033[31m'; PURPLE='\033[38;5;183m'; BLUE='\033[38;5;75m'; RESET='\033[0m'

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
  DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
  [ "$DIRTY" -gt 0 ] && BRANCH="$BRANCH ${YELLOW}*${DIRTY}${RESET}"
fi

LINES=""
if [ "$ADDED" -gt 0 ] || [ "$REMOVED" -gt 0 ]; then
  LINES=" | ${GREEN}+${ADDED}${RESET} ${RED}-${REMOVED}${RESET}"
fi

echo -e "${CYAN}[$MODEL]${RESET} 📁 ${DIR##*/}$BRANCH$LINES"

# Rate limit windows; only present for Claude.ai subscribers after the first response
# usage_window <json key> <fallback label> <color> <short window?>
usage_window() {
  local pct reset name left_txt left filled
  pct=$(echo "$input" | jq -r ".rate_limits.$1.used_percentage // empty" | cut -d. -f1)
  [ -z "$pct" ] && return
  reset=$(echo "$input" | jq -r ".rate_limits.$1.resets_at // empty")
  name="$2"; left_txt=""
  if [ -n "$reset" ]; then
    left=$((reset - $(date +%s)))
    if [ "$4" = short ]; then
      if [ "$left" -ge 3600 ]; then left_txt=" ($((left / 3600))h left)"
      elif [ "$left" -gt 0 ]; then left_txt=" ($((left / 60))m left)"; fi
    else
      name=$(date -r "$reset" +"%b %-d" 2>/dev/null || echo "$2")
      if [ "$left" -ge 86400 ]; then left_txt=" ($(((left + 43200) / 86400))d left)"
      elif [ "$left" -gt 0 ]; then left_txt=" ($((left / 3600))h left)"; fi
    fi
  fi
  filled=$((pct / 10)); [ "$filled" -gt 10 ] && filled=10
  printf '%b' "${3}[${name}]${left_txt} $(dots_bar "$filled" 10) ${pct}%${RESET}  "
}
LIMITS="$(usage_window five_hour 5h "$BLUE" short)$(usage_window seven_day 7d "$PURPLE")"

echo -e "${LIMITS}${BAR_COLOR}[ctx] ${BAR} ${PCT}%${RESET}"
