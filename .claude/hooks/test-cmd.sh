#!/usr/bin/env bash
# Sourceable helpers (no side effects when sourced) shared by verify.sh and scripts/orchestrate.sh.
#   orch_detect_test_cmd <dir>  print the project's test command, or nothing.
#   orch_allow_rules <cmd>      print the permission allow rules needed to run <cmd> (and, for a Python runner, the
#                               interpreter), one per line.

orch_detect_test_cmd() {
  local dir="${1:-.}"
  if [ -n "${ORCH_TEST_CMD:-}" ]; then
    printf '%s\n' "$ORCH_TEST_CMD"
    return 0
  fi
  if [ -f "$dir/package.json" ] && grep -q '"test"' "$dir/package.json" 2>/dev/null; then
    echo "npm test --silent"
    return 0
  fi
  # Python only when real test files exist: config markers alone (e.g. pyproject.toml for linting) do not count.
  if [ -n "$(find "$dir" -maxdepth 4 \( -name node_modules -o -name .venv -o -name venv -o -name .git -o -name .claude \) -prune -o \( -name 'test_*.py' -o -name '*_test.py' \) -type f -print -quit 2>/dev/null)" ]; then
    # Probe from a neutral cwd in isolated mode so a planted pytest.py in the repo is never imported.
    if (cd / && python3 -I -c 'import pytest') >/dev/null 2>&1; then
      echo "python3 -m pytest -q"
    else
      echo "python3 -m unittest discover -q"
    fi
    return 0
  fi
  if [ -f "$dir/Cargo.toml" ]; then echo "cargo test --quiet"; return 0; fi
  if [ -f "$dir/go.mod" ]; then echo "go test ./..."; return 0; fi
  if [ -f "$dir/Package.swift" ]; then echo "swift test"; return 0; fi
  local mk
  for mk in Makefile makefile; do
    if [ -f "$dir/$mk" ] && grep -q '^test:' "$dir/$mk" 2>/dev/null; then
      echo "make test"
      return 0
    fi
  done
  return 0
}

orch_allow_rules() {
  local cmd="${1:-}"
  case "$cmd" in
    *$'\n'* | *$'\r'*)
      echo "orch_allow_rules: ignoring a multi-line test command" >&2
      return 0
      ;;
  esac
  cmd="${cmd#"${cmd%%[![:space:]]*}"}"
  cmd="${cmd%"${cmd##*[![:space:]]}"}"
  [ -n "$cmd" ] || return 0
  # A Python runner also gets its interpreter, as npm and node are always allowed: agents check their work with their
  # own scripts (python3 -c, python3 - <<EOF, scratch/diff.py), not only with the test command. The UNSAFE_BASH denies
  # still win over these rules.
  case "$cmd" in
    "python3 -m pytest"*) echo 'Bash(python3 *)'; echo 'Bash(pytest*)' ;;
    "python -m pytest"*) echo 'Bash(python *)'; echo 'Bash(pytest*)' ;;
    "python3 "*) echo 'Bash(python3 *)' ;;
    "python "*) echo 'Bash(python *)' ;;
    pytest | "pytest "*) echo 'Bash(pytest*)'; echo 'Bash(python3 *)' ;;
    "cargo test"*) echo 'Bash(cargo test*)'; echo 'Bash(cargo build*)' ;;
    "go test"*) echo 'Bash(go test*)'; echo 'Bash(go build*)'; echo 'Bash(go vet*)' ;;
    "swift test"*) echo 'Bash(swift test*)'; echo 'Bash(swift build*)' ;;
    "make test"*) echo 'Bash(make test*)' ;;
    "npm "*) ;;
    *) printf 'Bash(%s*)\n' "$cmd" ;;
  esac
  return 0
}
