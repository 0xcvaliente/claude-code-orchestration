import "../src/test-tmp.mjs";
// The eval's test-result graders (evals/*/graders/results-nonempty.md and results-pass.md) against real node:test output.
// bench/README.md, "Smoke run": two graders failed on t2-single and whether a coloured summary caused it was unproven.
// Here node:test runs a tiny passing suite with each reporter, with colour forced on and off, and every results grader's
// pattern (read from its file, as `claude plugin eval` reads it) must match each output. The third failing grader of that
// run, `orch-agent-used`, matched agent use, not test output, and was removed from t2-single in 1.5.0.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// bench/validate.mjs at its deadline: the caller survives and reads a non-zero code, the graders it started are gone,
// and it leaves nothing in the temp folder. Linux only (reads /proc).
test("validate.mjs deadline: the caller survives, no grader is left running, no scratch is left", { skip: !existsSync("/proc/self/cmdline"), timeout: 40_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "validate-deadline-"));
  try {
    const script = join(dirname(new URL(import.meta.url).pathname), "validate.mjs");
    const r = spawnSync("bash", ["-c", `node ${JSON.stringify(script)} --task h3-sql-engine --deadline-s 8; echo after=$?`], {
      env: { ...process.env, TMPDIR: tmp }, encoding: "utf8", timeout: 30_000,
    });
    const out = `${r.stdout}${r.stderr}`;
    const after = out.match(/after=(\d+)/);
    assert.ok(after, `the caller's next line ran: ${out.slice(-400)}`);
    assert.notEqual(after[1], "0");
    assert.match(out, /NOT DONE h3-sql-engine/);
    await new Promise((res) => setTimeout(res, 3000));
    const alive = [];
    for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
      try { if (readFileSync(`/proc/${pid}/cmdline`, "utf8").includes(tmp)) alive.push(pid); } catch { /* gone */ }
    }
    assert.deepEqual(alive, [], "no process of the run is alive");
    assert.deepEqual(readdirSync(tmp), [], "the run left nothing in its temp folder");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every results-*.md grader under evals/: its file, pattern and flags (YAML single-quoted, so backslashes are literal). */
function resultGraders() {
  /** @type {{ file: string, re: RegExp }[]} */
  const out = [];
  for (const c of readdirSync(join(root, "evals"))) {
    const dir = join(root, "evals", c, "graders");
    if (!existsSync(dir)) continue;
    for (const g of readdirSync(dir).filter((f) => /^results-.*\.md$/.test(f))) {
      const text = readFileSync(join(dir, g), "utf8");
      const pattern = /^pattern: '(.*)'$/m.exec(text)?.[1];
      const flags = /^flags: (\w+)$/m.exec(text)?.[1] ?? "";
      assert.ok(pattern, `${c}/${g} has a single-quoted pattern`);
      out.push({ file: `${c}/${g}`, re: new RegExp(pattern.replace(/''/g, "'"), flags) });
    }
  }
  return out;
}

/** node:test output of a two-test passing suite. @param {string} reporter @param {boolean} colour */
function nodeTestOutput(reporter, colour) {
  const dir = mkdtempSync(join(tmpdir(), "eval-graders-"));
  try {
    writeFileSync(join(dir, "a.test.mjs"), 'import { test } from "node:test";\ntest("one", () => {});\ntest("two", () => {});\n');
    const env = { ...process.env, ...(colour ? { FORCE_COLOR: "1" } : { NO_COLOR: "1", FORCE_COLOR: "0" }) };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, ["--test", `--test-reporter=${reporter}`, "a.test.mjs"], { cwd: dir, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("eval graders: results-nonempty and results-pass match node:test summaries, coloured or plain, spec or tap", () => {
  const graders = resultGraders();
  assert.ok(graders.some((g) => g.file.endsWith("results-nonempty.md")) && graders.some((g) => g.file.endsWith("results-pass.md")));
  const outputs = [
    ["spec, colour", nodeTestOutput("spec", true)],
    ["spec, plain", nodeTestOutput("spec", false)],
    ["tap", nodeTestOutput("tap", false)],
  ];
  assert.match(String(outputs[0]?.[1]), /\x1b\[/, "the coloured run really has escape sequences");
  assert.doesNotMatch(String(outputs[1]?.[1]), /\x1b\[/);
  for (const [name, out] of outputs) {
    for (const g of graders) assert.match(String(out), g.re, `${g.file} on ${name}`);
  }
  // The patterns of the 2026-11-10 smoke run (before commit 85a3fbf) had no escape prefix: colour alone fails them, plain
  // output passes them. Whether that run's file was coloured is not known (its files were removed).
  for (const old of [/^(?:#|ℹ) pass [1-9]/m, /^(?:#|ℹ) fail 0\b/m]) {
    assert.doesNotMatch(String(outputs[0]?.[1]), old);
    assert.match(String(outputs[1]?.[1]), old);
  }
});

test("eval graders: a failing run or an empty file does not pass them", () => {
  const graders = resultGraders();
  const pass = graders.filter((g) => g.file.endsWith("results-pass.md"));
  for (const g of pass) {
    assert.doesNotMatch("\x1b[34mℹ pass 1\x1b[39m\n\x1b[34mℹ fail 1\x1b[39m\n", g.re, g.file);
    assert.doesNotMatch("# fail 10\n", g.re, g.file);
  }
  for (const g of graders) assert.doesNotMatch("", g.re, g.file);
});
