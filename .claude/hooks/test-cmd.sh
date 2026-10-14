#!/usr/bin/env bash
# Sourceable helpers (no side effects when sourced) shared by verify.sh and scripts/orchestrate.sh.
#   orch_detect_test_cmd <dir>  print the project's test command, or nothing.
#   orch_allow_rules <cmd>      print the permission allow rules needed to run <cmd>, one per line.

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
  local py=0 f
  for f in pyproject.toml pytest.ini setup.cfg tox.ini conftest.py; do
    [ -f "$dir/$f" ] && py=1
  done
  if [ "$py" = 0 ] && { compgen -G "$dir/tests/test_*.py" >/dev/null || compgen -G "$dir/test_*.py" >/dev/null; }; then
    py=1
  fi
  if [ "$py" = 1 ]; then
    if python3 -c 'import pytest' >/dev/null 2>&1; then
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
  [ -n "$cmd" ] || return 0
  case "$cmd" in
    "python3 -m pytest"*) echo 'Bash(python3 -m pytest*)'; echo 'Bash(pytest*)' ;;
    "python3 -m unittest"*) echo 'Bash(python3 -m unittest*)' ;;
    "cargo test"*) echo 'Bash(cargo test*)'; echo 'Bash(cargo build*)' ;;
    "go test"*) echo 'Bash(go test*)'; echo 'Bash(go build*)'; echo 'Bash(go vet*)' ;;
    "swift test"*) echo 'Bash(swift test*)'; echo 'Bash(swift build*)' ;;
    "make test"*) echo 'Bash(make test*)' ;;
    "npm "*) ;;
    *) printf 'Bash(%s*)\n' "$cmd" ;;
  esac
  return 0
}
