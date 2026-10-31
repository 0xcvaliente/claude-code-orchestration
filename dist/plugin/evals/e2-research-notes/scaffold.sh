#!/usr/bin/env bash
# Starting files for e2-research-notes. Self-contained (heredocs) so it does not depend on where the eval runner invokes it from.
set -euo pipefail
mkdir -p notes
cat > 'notes/a.md' <<'EVAL_SCAFFOLD_EOF'
# Call with supplier, 2026-03-02

Lead time is 35 days for standard orders. Minimum order quantity stays at 250 units.
EVAL_SCAFFOLD_EOF
cat > 'notes/b.md' <<'EVAL_SCAFFOLD_EOF'
# Supplier email, 2026-06-18

The new plant is running: lead time drops to 21 days from July. The minimum order quantity rises to 400 units for every order placed after 1 July.
EVAL_SCAFFOLD_EOF
cat > 'notes/c.md' <<'EVAL_SCAFFOLD_EOF'
# Price notice, 2026-09-30

List prices rise by 6% from 1 March 2027. Orders confirmed before that date keep the old prices.
EVAL_SCAFFOLD_EOF
