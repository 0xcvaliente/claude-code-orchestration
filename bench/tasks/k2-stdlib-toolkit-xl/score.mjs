// Scores a solution dir (containing toolkit/) with the hidden differential grader.
// node score.mjs <dir>, or: import { score } from "./score.mjs"; await score(dir)
// Returns {pass, passed, total, by_cat: {toml: [p, t], ...}, flags}. Never modifies dir.
// pass requires every module listed in hidden/modules.json at full marks.
//
// The grader bounds its own run time (per-module budgets, see hidden/grade.py) and
// rewrites its output after every finished module, so even if this wrapper's much
// larger safety timeout fires, the modules that finished keep their scores.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// Worst case per module is MODULE_WALL_S (600 s) plus a 12 s import watchdog and the 2 s + 3 s
// grace of the last case: about 620 s. Modules run in parallel, but this bound assumes they
// ran one after another: 12 modules x 620 s, about 2 h 4 min.
const MODULE_COUNT = 12;
const TIMEOUT_MS = MODULE_COUNT * 620_000;

function run(cmd, args, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    let stderr = "";
    let timedOut = false;
    child.stderr.on("data", (d) => { if (stderr.length < 4000) stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolveRun({ code, stderr, timedOut }); });
    child.on("error", (e) => { clearTimeout(timer); resolveRun({ code: -1, stderr: String(e), timedOut }); });
  });
}

function listedModules() {
  try {
    return JSON.parse(readFileSync(join(here, "hidden", "modules.json"), "utf8"));
  } catch {
    return {};
  }
}

// Sum of the known counts in modules.json (null counts are only known once the adapter loads).
function expectedTotal() {
  return Object.values(listedModules()).reduce((a, b) => a + (Number.isInteger(b) ? b : 0), 0);
}

export async function score(dir) {
  const tmp = mkdtempSync(join(tmpdir(), "k2-score-"));
  const out = join(tmp, "grade.json");
  try {
    const { code, stderr, timedOut } = await run("python3", [join(here, "hidden", "grade.py"), resolve(dir), "--out", out], TIMEOUT_MS);
    let j;
    try {
      j = JSON.parse(readFileSync(existsSync(out) ? out : `${out}.tmp`, "utf8"));
    } catch {
      return { pass: false, passed: 0, total: expectedTotal(), by_cat: {}, flags: [`grader failed (exit ${code}${timedOut ? ", timed out" : ""}): ${stderr.slice(-300)}`] };
    }
    const flags = [...(j.flags ?? [])];
    if (timedOut || !j.complete) flags.push("grader did not finish: unfinished modules score 0");
    const graderError = flags.some((f) => f.startsWith("grader error"));
    const byCat = j.by_cat ?? {};
    const notFull = Object.keys(listedModules()).filter((m) => {
      const pt = byCat[m];
      return !Array.isArray(pt) || !(pt[1] > 0) || pt[0] !== pt[1];
    });
    return {
      pass: j.total > 0 && j.passed === j.total && notFull.length === 0 && j.complete === true && !graderError && !timedOut,
      passed: j.passed,
      total: j.total,
      by_cat: byCat,
      flags,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await score(process.argv[2] ?? process.cwd())));
}
