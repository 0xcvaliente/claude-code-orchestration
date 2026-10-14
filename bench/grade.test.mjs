import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const gradeCli = join(here, "grade.mjs");
const lines = (f) => readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

function grade(campaign, ...extra) {
  const r = spawnSync(process.execPath, [gradeCli, campaign, "--jobs", "2", ...extra], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
}

test("grade.mjs grades snapshots, reuses identical hashes, and is idempotent", () => {
  const tmp = mkdtempSync(join(tmpdir(), "grade-test-"));
  try {
    const campaign = join(tmp, "campaign");
    cpSync(join(here, "test-fixtures", "grade"), campaign, { recursive: true });
    const out = grade(campaign);
    assert.equal(out.split("\n").filter((l) => l.startsWith("graded ")).length, 2, "one progress line per run");

    const rows = lines(join(campaign, "grades.jsonl"));
    assert.equal(rows.length, 5);
    const get = (run, snap) => rows.find((r) => r.run_id === run && r.snap === snap);
    for (const [run, snap] of [["run-a", "t0030"], ["run-b", "t0030"]]) {
      const r = get(run, snap);
      assert.deepEqual([r.pass, r.passed, r.total], [false, 0, 3], `${run}/${snap} stub`);
    }
    for (const [run, snap] of [["run-a", "t0060"], ["run-a", "final"], ["run-b", "final"]]) {
      const r = get(run, snap);
      assert.deepEqual([r.pass, r.passed, r.total], [true, 3, 3], `${run}/${snap} reference`);
    }
    assert.equal(get("run-a", "t0030").secs, 30);
    assert.equal(get("run-a", "t0060").secs, 60);
    assert.equal(get("run-a", "final").secs, 95);
    assert.equal(get("run-b", "final").secs, 60);
    assert.equal(get("run-a", "t0030").hash, get("run-b", "t0030").hash, "identical stubs hash the same");
    assert.equal(get("run-a", "t0060").hash, get("run-a", "final").hash);
    assert.notEqual(get("run-a", "final").hash, get("run-b", "final").hash);

    // Three distinct (task, hash) pairs: stub, reference, reference plus a stray hidden.test.js.
    const cacheFile = join(campaign, "grades-cache.json");
    const cache = JSON.parse(readFileSync(cacheFile, "utf8"));
    assert.equal(Object.keys(cache).length, 3);

    // Proof of reuse: tamper with the cached stub grade, drop grades.jsonl, regrade, and see the tampered value.
    const stubKey = `t2-single:${get("run-a", "t0030").hash}`;
    cache[stubKey].passed = 77;
    writeFileSync(cacheFile, JSON.stringify(cache));
    rmSync(join(campaign, "grades.jsonl"));
    grade(campaign);
    const again = lines(join(campaign, "grades.jsonl"));
    assert.equal(again.length, 5);
    assert.equal(again.find((r) => r.run_id === "run-b" && r.snap === "t0030").passed, 77);

    // A further run appends nothing.
    const before = readFileSync(join(campaign, "grades.jsonl"), "utf8");
    const out3 = grade(campaign);
    assert.equal(readFileSync(join(campaign, "grades.jsonl"), "utf8"), before);
    assert.match(out3, /0 run\(s\) graded/);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("grade.mjs --final-only and --only filter the work", () => {
  const tmp = mkdtempSync(join(tmpdir(), "grade-test-"));
  try {
    const campaign = join(tmp, "campaign");
    cpSync(join(here, "test-fixtures", "grade"), campaign, { recursive: true });
    grade(campaign, "--final-only", "--only", "run-a");
    const rows = lines(join(campaign, "grades.jsonl"));
    assert.deepEqual(rows.map((r) => `${r.run_id}/${r.snap}`), ["run-a/final"]);
    grade(campaign); // resumes: the rest is appended
    assert.equal(lines(join(campaign, "grades.jsonl")).length, 5);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
