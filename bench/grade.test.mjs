import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("a crashing score() records the meta total with grader-crash and is never cached", () => {
  const tmp = mkdtempSync(join(tmpdir(), "grade-test-"));
  try {
    const campaign = join(tmp, "campaign");
    cpSync(join(here, "test-fixtures", "grade-crash", "campaign"), campaign, { recursive: true });
    const tasks = join(here, "test-fixtures", "grade-crash", "tasks");
    grade(campaign, "--tasks-dir", tasks);
    const rows = lines(join(campaign, "grades.jsonl"));
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].pass, rows[0].passed, rows[0].total], [false, 0, 7]);
    assert.deepEqual(rows[0].flags, ["grader-crash"]);
    let cache = {};
    try { cache = JSON.parse(readFileSync(join(campaign, "grades-cache.json"), "utf8")); } catch { /* none written */ }
    assert.deepEqual(cache, {});

    // A rerun retries the crashed pair: the grader now succeeds, a new row is appended and cached.
    process.env.BOOM_OK = "1";
    try { grade(campaign, "--tasks-dir", tasks); } finally { delete process.env.BOOM_OK; }
    const rows2 = lines(join(campaign, "grades.jsonl"));
    assert.equal(rows2.length, 2);
    assert.deepEqual([rows2[1].pass, rows2[1].passed, rows2[1].total, rows2[1].flags], [true, 7, 7, []]);
    assert.equal(Object.keys(JSON.parse(readFileSync(join(campaign, "grades-cache.json"), "utf8"))).length, 1);

    // Now it is done: a third run appends nothing.
    grade(campaign, "--tasks-dir", tasks);
    assert.equal(lines(join(campaign, "grades.jsonl")).length, 2);
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

// ---------- lenient variant ----------

const K2 = join(here, "tasks", "k2-stdlib-toolkit-xl");
const gradePy = (sol, only, ...extra) => {
  const r = spawnSync("python3", [join(K2, "hidden", "grade.py"), sol, "--only", only, ...extra], { encoding: "utf8", env: { ...process.env, K2_LENIENT_RE: "" } });
  assert.equal(r.status, 0, r.stderr);
  const m = new RegExp(`^\\s+${only}\\s+(\\d+)/\\s*(\\d+)`, "m").exec(r.stdout);
  return { passed: Number(m[1]), total: Number(m[2]), out: r.stdout };
};

test("k2 lenient: tomlparse importing re scores 0 strict, full lenient; regex.py importing re scores 0 in both", () => {
  const tmp = mkdtempSync(join(tmpdir(), "k2-lenient-"));
  try {
    cpSync(join(K2, "ref", "toolkit"), join(tmp, "toolkit"), { recursive: true });
    const patch = (name) => {
      const f = join(tmp, "toolkit", name);
      writeFileSync(f, `import re  # noqa\n${readFileSync(f, "utf8")}`);
    };
    patch("tomlparse.py");
    const strictToml = gradePy(tmp, "toml");
    assert.equal(strictToml.passed, 0);
    assert.ok(strictToml.total > 0);
    const lenToml = gradePy(tmp, "toml", "--lenient");
    assert.deepEqual([lenToml.passed, lenToml.total], [strictToml.total, strictToml.total]);
    assert.match(lenToml.out, /lenient:/, "lenient flags carry the note");
    assert.doesNotMatch(strictToml.out, /lenient:/);

    patch("regex.py");
    assert.equal(gradePy(tmp, "regex").passed, 0);
    assert.equal(gradePy(tmp, "regex", "--lenient").passed, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("grade.mjs --variant lenient grades final/ only, skips tasks without the variant, and is idempotent", () => {
  const tmp = mkdtempSync(join(tmpdir(), "grade-lenient-"));
  try {
    const tasks = join(tmp, "tasks");
    for (const [id, variants] of [["vt", '["lenient"]'], ["plain", "[]"]]) {
      mkdirSync(join(tasks, id), { recursive: true });
      writeFileSync(join(tasks, id, "meta.json"), '{"total":4}');
      writeFileSync(join(tasks, id, "task.md"), "x");
      writeFileSync(join(tasks, id, "score.mjs"), `export const VARIANTS = ${variants};
export async function score(dir, o = {}) { return { pass: !!o.variant, passed: o.variant ? 4 : 1, total: 4, flags: o.variant ? ["lenient: x"] : [] }; }\n`);
    }
    const campaign = join(tmp, "campaign");
    const runs = [];
    for (const [run, task] of [["vt-r1", "vt"], ["plain-r1", "plain"]]) {
      mkdirSync(join(campaign, run, "final"), { recursive: true });
      mkdirSync(join(campaign, run, "snapshots", "t0010"), { recursive: true });
      writeFileSync(join(campaign, run, "final", "a.txt"), run);
      writeFileSync(join(campaign, run, "snapshots", "t0010", "a.txt"), run);
      runs.push({ run_id: run, task, wall_ms: 5000 });
    }
    writeFileSync(join(campaign, "runs.jsonl"), runs.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const out = grade(campaign, "--tasks-dir", tasks, "--variant", "lenient");
    assert.match(out, /not supported by task\(s\) plain/);
    const rows = lines(join(campaign, "grades-lenient.jsonl"));
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].run_id, rows[0].snap, rows[0].pass, rows[0].passed], ["vt-r1", "final", true, 4]);
    assert.deepEqual(rows[0].flags, ["lenient: x"]);
    const cache = JSON.parse(readFileSync(join(campaign, "grades-cache.json"), "utf8"));
    assert.ok(Object.keys(cache).every((k) => k.startsWith("lenient:")), "cache keys carry the variant");
    // Strict grading of the same campaign keeps its own file and cache keys.
    grade(campaign, "--tasks-dir", tasks, "--final-only");
    const strict = lines(join(campaign, "grades.jsonl"));
    assert.deepEqual(strict.map((r) => [r.run_id, r.passed]).sort(), [["plain-r1", 1], ["vt-r1", 1]]);
    // Idempotent.
    const before = readFileSync(join(campaign, "grades-lenient.jsonl"), "utf8");
    grade(campaign, "--tasks-dir", tasks, "--variant", "lenient");
    assert.equal(readFileSync(join(campaign, "grades-lenient.jsonl"), "utf8"), before);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
