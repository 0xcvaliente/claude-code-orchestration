#!/usr/bin/env bash
# Generated from bench/tasks/c1-unit-registry/setup: writes the bench task's starting files into the run workspace.
# Self-contained (heredocs) so it does not depend on where the eval runner invokes it from.
set -euo pipefail
cat > 'package.json' <<'EVAL_SCAFFOLD_EOF'
{"name":"units","type":"module","scripts":{"test":"node --test"}}
EVAL_SCAFFOLD_EOF
mkdir -p 'src'
cat > 'src/index.js' <<'EVAL_SCAFFOLD_EOF'
// Public API. See task.md.
export function convert(category, value, from, to) {
  throw new Error("not implemented");
}
export function categories() {
  throw new Error("not implemented");
}
export function listUnits(category) {
  throw new Error("not implemented");
}
EVAL_SCAFFOLD_EOF
mkdir -p 'src'
cat > 'src/registry.js' <<'EVAL_SCAFFOLD_EOF'
// The one table of unit categories. Every category module in src/units/ must be imported and listed here.
export const registry = {};
EVAL_SCAFFOLD_EOF
mkdir -p 'test'
cat > 'test/public.test.js' <<'EVAL_SCAFFOLD_EOF'
import assert from "node:assert/strict";
import { test } from "node:test";
import { categories, convert, listUnits } from "../src/index.js";

const near = (a, b) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test("public: length", () => near(convert("length", 1, "km", "m"), 1000));
test("public: temperature", () => near(convert("temperature", 100, "C", "F"), 212));
test("public: categories", () => assert.deepEqual(categories(), ["data", "length", "mass", "temperature", "time", "volume"]));
test("public: listUnits", () => assert.deepEqual(listUnits("time"), ["ms", "s", "min", "h", "d", "wk"]));
EVAL_SCAFFOLD_EOF
