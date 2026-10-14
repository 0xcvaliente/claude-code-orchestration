// Scores the minisql package in dir with the hidden Python grader: the main suite (322 cases)
// and the stress suite (1,062 cases), run in parallel against a temp copy of dir/minisql.
// The grader's expected-results cache (hidden/expected-*.pkl, untracked) is shared across runs.
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runProc } from "../../lib/score.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const hiddenDir = join(here, "hidden");
const SUITES = ["main", "stress"];

async function caseCounts(hidden) {
  const code = "import sys;sys.path.insert(0,sys.argv[1]);import cases,cases_stress;print(len(cases.build_cases()),len(cases_stress.build_cases()))";
  const r = await runProc("python3", ["-c", code, hidden], { cwd: tmpdir(), timeoutMs: 120_000 });
  const [m, s] = r.stdout.trim().split(/\s+/).map(Number);
  return { main: m || 0, stress: s || 0 };
}

export async function score(dir) {
  const tmp = mkdtempSync(join(tmpdir(), "h3-score-"));
  try {
    const sol = join(tmp, "sol");
    const hidden = join(tmp, "hidden");
    cpSync(join(dir, "minisql"), join(sol, "minisql"), { recursive: true, filter: (p) => basename(p) !== "__pycache__" });
    cpSync(hiddenDir, hidden, { recursive: true, filter: (p) => basename(p) !== "__pycache__" });
    const runs = await Promise.all(SUITES.map(async (suite) => {
      const out = join(tmp, `${suite}.json`);
      await runProc("python3", [join(hidden, "grade.py"), sol, "--out", out, "--suite", suite], {
        cwd: tmp, timeoutMs: 900_000,
      });
      try { return JSON.parse(readFileSync(out, "utf8")); } catch { return null; }
    }));
    // Keep freshly computed expected-results caches for the next run.
    for (const f of readdirSync(hidden)) {
      if (/^expected-.*\.pkl$/.test(f) && !existsSync(join(hiddenDir, f))) {
        try {
          cpSync(join(hidden, f), join(hiddenDir, `${f}.${process.pid}.tmp`));
          renameSync(join(hiddenDir, `${f}.${process.pid}.tmp`), join(hiddenDir, f));
        } catch { /* cache is optional */ }
      }
    }
    let counts = null;
    const res = { pass: false, passed: 0, total: 0, by_cat: {}, suites: {}, flags: [] };
    for (let i = 0; i < SUITES.length; i++) {
      const j = runs[i];
      let passed = 0;
      let total;
      if (j) {
        passed = j.passed;
        total = j.total;
        for (const [cat, pt] of Object.entries(j.by_cat ?? {})) res.by_cat[cat] = pt;
        for (const f of j.flags ?? []) if (!res.flags.includes(f)) res.flags.push(f);
      } else {
        counts ??= await caseCounts(hidden);
        total = counts[SUITES[i]];
        res.flags.push(`grader-crash:${SUITES[i]}`);
      }
      res.suites[SUITES[i]] = { passed, total };
      res.passed += passed;
      res.total += total;
    }
    res.pass = res.total > 0 && res.passed === res.total;
    return res;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await score(process.argv[2] ?? process.cwd())));
}
