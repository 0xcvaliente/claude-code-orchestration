#!/usr/bin/env bash
# Regenerates the file-profiler fixtures next to this script (stdlib Python only; -I keeps it isolated).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
python3 -I "$here/make.py" "$here"
