// `npm test` runs through scripts/run-tests.mjs, which gives the suites one temp root and removes it at the end, so a run
// leaves nothing in the system temp dir. Run directly (`npx tsx --test src/x.test.ts`), a test file has no such root.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package.json runs the tests through the runner that cleans up", () => {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  assert.equal(scripts.test, "node scripts/run-tests.mjs");
});

test("under npm test the temp dir is the run's own folder", { skip: process.env.npm_lifecycle_event !== "test" && "not run through npm test" }, () => {
  assert.match(basename(tmpdir()), /^orch-test-/);
});
