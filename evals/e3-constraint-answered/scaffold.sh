#!/usr/bin/env bash
# Starting files for e3-constraint-answered. Self-contained (heredocs) so it does not depend on where the eval runner invokes it from.
set -euo pipefail
mkdir -p src test
cat > 'package.json' <<'EVAL_SCAFFOLD_EOF'
{"name":"bench","type":"module","scripts":{"test":"node --test"}}
EVAL_SCAFFOLD_EOF
cat > 'src/slug.js' <<'EVAL_SCAFFOLD_EOF'
export function slugify(text) {
  throw new Error("not implemented");
}
EVAL_SCAFFOLD_EOF
cat > 'test/slug.test.js' <<'EVAL_SCAFFOLD_EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";

test("slugify", () => {
  assert.equal(slugify("  Hello, World! 2026 "), "hello-world-2026");
  assert.equal(slugify("a--b"), "a-b");
  assert.equal(slugify("x"), "x");
  assert.throws(() => slugify(3), TypeError);
});
EVAL_SCAFFOLD_EOF
