#!/usr/bin/env bash
# Starting files for e4-plan-before-build. Self-contained (heredocs) so it does not depend on where the eval runner invokes it from.
set -euo pipefail
mkdir -p test
cat > 'package.json' <<'EVAL_SCAFFOLD_EOF'
{"name":"bench","type":"module","scripts":{"test":"node --test"}}
EVAL_SCAFFOLD_EOF
cat > 'test/config.test.js' <<'EVAL_SCAFFOLD_EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parse.js";
import { validate } from "../src/validate.js";

test("parse", () => {
  assert.deepEqual(parse("# c\nport = 8080\n\nhost = example.org\n"), { port: 8080, host: "example.org" });
  assert.throws(() => parse("ok = 1\nbroken"), (e) => e instanceof SyntaxError && /2/.test(e.message));
});
test("validate", () => {
  assert.deepEqual(validate({ port: 1, host: "h" }, { port: "number", host: "string" }), []);
  assert.deepEqual(validate({ port: "x" }, { port: "number", host: "string" }), ["port is not a number", "missing host"]);
});
EVAL_SCAFFOLD_EOF
