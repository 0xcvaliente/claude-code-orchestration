// Scores a solution dir (containing toolkit/) with the hidden differential grader.
// node score.mjs <dir>, or: import { score } from "./score.mjs"; await score(dir)
// Returns {pass, passed, total, by_cat: {toml: [p, t], ...}, flags}. Never modifies dir.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function run(cmd, args, timeoutMs) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" } });
    let stderr = "";
    child.stderr.on("data", (d) => { if (stderr.length < 4000) stderr += d; });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => { clearTimeout(timer); resolveRun({ code, stderr }); });
    child.on("error", (e) => { clearTimeout(timer); resolveRun({ code: -1, stderr: String(e) }); });
  });
}

export async function score(dir) {
  const tmp = mkdtempSync(join(tmpdir(), "k1-score-"));
  const out = join(tmp, "grade.json");
  try {
    const { code, stderr } = await run("python3", [join(here, "hidden", "grade.py"), resolve(dir), "--out", out], 1_800_000);
    let j;
    try {
      j = JSON.parse(readFileSync(out, "utf8"));
    } catch {
      return { pass: false, passed: 0, total: 0, by_cat: {}, flags: [`grader failed (exit ${code}): ${stderr.slice(-300)}`] };
    }
    return {
      pass: j.total > 0 && j.passed === j.total,
      passed: j.passed,
      total: j.total,
      by_cat: j.by_cat,
      flags: j.flags ?? [],
    };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await score(process.argv[2] ?? process.cwd())));
}
