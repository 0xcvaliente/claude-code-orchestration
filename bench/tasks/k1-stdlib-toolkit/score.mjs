// Scores a solution dir (containing toolkit/) with the hidden differential grader.
// node score.mjs <dir>, or: import { score } from "./score.mjs"; await score(dir)
// Returns {pass, passed, total, by_cat: {toml: [p, t], ...}, flags}. Never modifies dir.
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
// Worst case per module is about 600 s (MODULE_WALL_S) plus one import and grace;
// modules run in parallel. 40 minutes leaves a wide margin.
const TIMEOUT_MS = 2_400_000;

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

function expectedTotal() {
  try {
    return Object.values(JSON.parse(readFileSync(join(here, "hidden", "modules.json"), "utf8"))).reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}

export async function score(dir) {
  const tmp = mkdtempSync(join(tmpdir(), "k1-score-"));
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
    return {
      pass: j.total > 0 && j.passed === j.total && j.complete === true && !graderError && !timedOut,
      passed: j.passed,
      total: j.total,
      by_cat: j.by_cat,
      flags,
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await score(process.argv[2] ?? process.cwd())));
}
