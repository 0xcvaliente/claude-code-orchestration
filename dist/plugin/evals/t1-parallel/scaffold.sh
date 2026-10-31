#!/usr/bin/env bash
# Generated from bench/tasks/t1-parallel/setup: writes the bench task's starting files into the run workspace.
# Self-contained (heredocs) so it does not depend on where the eval runner invokes it from.
set -euo pipefail
cat > 'package.json' <<'EVAL_SCAFFOLD_EOF'
{"name":"bench","type":"module","scripts":{"test":"node --test"}}
EVAL_SCAFFOLD_EOF
