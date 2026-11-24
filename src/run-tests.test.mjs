// `npm test` runs through scripts/run-tests.mjs, which gives the suites one temp root and removes it at the end, so a run
// leaves nothing in the system temp dir. Run directly (`npx tsx --test src/x.test.ts`), a test file has no such root.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("package.json runs the tests through the runner that cleans up", () => {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  assert.equal(scripts.test, "node scripts/run-tests.mjs");
});

test("the src suite runs every src test file once, the slow ones first in SLOW_FIRST's order, then the rest by name", async () => {
  const { SLOW_FIRST, srcFiles } = await import("../scripts/run-tests.mjs");
  const all = readdirSync(join(root, "src")).filter((n) => /\.test\.(ts|mjs)$/.test(n)).sort();
  const order = srcFiles();
  assert.deepEqual([...order].sort(), all, "every file, none twice, nothing else");
  for (const n of SLOW_FIRST) assert.ok(all.includes(n), `SLOW_FIRST names ${n}, which no longer exists: update the list`);
  assert.deepEqual(order.slice(0, SLOW_FIRST.length), SLOW_FIRST);
  const rest = order.slice(SLOW_FIRST.length);
  assert.deepEqual(rest, [...rest].sort(), "the rest by name");
  // a folder without some of the listed files: those are skipped, the order holds
  const dir = mkdtempSync(join(tmpdir(), "orch-rt-"));
  for (const n of ["b.test.mjs", "a.test.ts", "guards.test.mjs", "skill-gate.test.mjs", "x.txt"]) writeFileSync(join(dir, n), "");
  assert.deepEqual(srcFiles(dir), ["skill-gate.test.mjs", "guards.test.mjs", "a.test.ts", "b.test.mjs"]);
});

test("under npm test the temp dir is the run's own folder", { skip: process.env.npm_lifecycle_event !== "test" && "not run through npm test" }, () => {
  assert.match(basename(tmpdir()), /^orch-test-/);
});
