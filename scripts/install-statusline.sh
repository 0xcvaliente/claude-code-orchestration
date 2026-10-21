#!/usr/bin/env bash
# Copies statusline/statusline.sh to ~/.claude/statusline.sh and prints the setting that turns it on.
# It does not edit settings.json. Refuses to replace a different file there unless run with --force.
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd)/statusline/statusline.sh"
dest="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline.sh"
if [ -e "$dest" ] && ! cmp -s "$src" "$dest" && [ "${1:-}" != "--force" ]; then
  echo "$dest exists and differs from this repo's; rerun with --force to replace it" >&2
  exit 1
fi
mkdir -p "$(dirname "$dest")"
cp "$src" "$dest"
chmod +x "$dest"
command -v jq > /dev/null || echo "note: the status line needs jq (brew install jq)" >&2
echo "installed $dest"
echo 'add this to ~/.claude/settings.json (or ask /statusline to):'
echo '{ "statusLine": { "type": "command", "command": "bash ~/.claude/statusline.sh" } }'
