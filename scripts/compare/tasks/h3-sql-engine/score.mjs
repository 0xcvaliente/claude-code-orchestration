// Scores a run dir with the hidden Python grader: node score.mjs <runDir>, or import { score }.
// The grader checks <runDir>/minisql against SQLite and prints "TOTAL n/322".
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export function score(runDir) {
  const tmp = mkdtempSync(join(tmpdir(), "h3-score-"));
  const out = join(tmp, "grade.json");
  try {
    spawnSync("python3", [join(here, "hidden", "grade.py"), runDir, "--out", out], {
      encoding: "utf8", timeout: 600_000, maxBuffer: 64 * 1024 * 1024,
    });
    const j = JSON.parse(readFileSync(out, "utf8"));
    return { pass: j.passed === j.total, passed: j.passed, failed: j.total - j.passed };
  } catch {
    return { pass: false, passed: 0, failed: 0 };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(score(process.argv[2] ?? process.cwd())));
}
