#!/usr/bin/env bash
# Starting files for e1-shared-file. Self-contained (heredocs) so it does not depend on where the eval runner invokes it from.
set -euo pipefail
mkdir -p src test
cat > 'package.json' <<'EVAL_SCAFFOLD_EOF'
{"name":"bench","type":"module","scripts":{"test":"node --test"}}
EVAL_SCAFFOLD_EOF
cat > 'src/registry.js' <<'EVAL_SCAFFOLD_EOF'
// Formatters by name. Each formatter module registers itself here.
export const formatters = {};
export const NAMES = [];
export function format(name, value) {
  const f = formatters[name];
  if (!f) throw new Error(`unknown formatter ${name}`);
  return f(value);
}
EVAL_SCAFFOLD_EOF
cat > 'src/index.js' <<'EVAL_SCAFFOLD_EOF'
export { format, NAMES } from "./registry.js";
EVAL_SCAFFOLD_EOF
cat > 'test/format.test.js' <<'EVAL_SCAFFOLD_EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { format, NAMES } from "../src/index.js";

test("money", () => {
  assert.equal(format("money", 1234.5), "1,234.50 EUR");
  assert.equal(format("money", 0), "0.00 EUR");
  assert.equal(format("money", 1000000), "1,000,000.00 EUR");
});
test("percent", () => {
  assert.equal(format("percent", 0.256), "25.6%");
  assert.equal(format("percent", 1), "100.0%");
});
test("NAMES lists both, sorted", () => assert.deepEqual(NAMES, ["money", "percent"]));
EVAL_SCAFFOLD_EOF
