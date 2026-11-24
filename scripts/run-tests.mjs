#!/usr/bin/env node
// `npm test`: runs the two test suites with every temporary file under one folder, and removes that folder at the end.
// The tests create thousands of temp folders per run (git repositories, state dirs, fake homes) and most never removed
// theirs, so each run left them in the system temp dir; on a machine whose /tmp is a tmpfs that used up every inode.
// One root set as TMPDIR (TMP and TEMP on Windows) covers every test, the hooks they start and tests added later.
// The exit code is the first failing suite's. ORCH_KEEP_TEST_TMP=1 keeps the folder and prints its path, for debugging.
//
// File order (2.1.0). The src suite runs its files with node:test's run(), under tsx as `tsx --test` did, at the CLI's
// default concurrency (available parallelism - 1), and starts the files SLOW_FIRST names first, slowest first, then the
// rest by name. `node --test` and `tsx --test` sort their files by name, which started the slowest files (skill-*,
// test-gate-*) last: in a profile on a 10-core Mac the src suite took 366 s, and a replay of the same per-file times
// with the slow files first gave about 326 s (docs/data/probes-2.1.0-suite.md). SLOW_FIRST is a hint only: a file it
// names that no longer exists is skipped (src/run-tests.test.mjs fails then, so the list is kept current), and a new
// file runs with the rest.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, "..");

/** The src suite's files that took longest in the 2.1.0 profile (seconds, under load), slowest first. */
export const SLOW_FIRST = [
  "skill-gate.test.mjs", // 241
  "skill-scan-meta.test.mjs", // 223
  "skill-publish.test.mjs", // 189
  "skill-create.test.mjs", // 183
  "hooks.test.ts", // 150
  "test-gate-audit.test.mjs", // 134
  "test-gate-v2.test.mjs", // 115
  "review-gate-v2.test.mjs", // 107
  "orchestrator.test.ts", // 95
  "verify.test.ts", // 86
  "soak-findings.test.mjs", // 85
  "test-gate-handback.test.mjs", // 84
  "plan-check-worktree.test.mjs", // 66
  "build-plugin.test.mjs", // 65
  "judge-hook.test.mjs", // 63
  "test-gate-lock.test.mjs", // 55
  "guards.test.mjs", // 52
  "plan-check-paths.test.mjs", // 51
  "plan-check-overlap.test.mjs", // 51
  "gate-hardening-time.test.mjs", // 51
  "test-gate-records.test.mjs", // 50
  "auto.test.ts", // 45
  "plan-hooks.test.mjs", // 44
  "soak-gates.test.mjs", // 43
  "gate-hardening-trap.test.mjs", // 41
  "test-gate-load.test.mjs", // 39
  "workflow-guard.test.mjs", // 35
  "handback.test.mjs", // 32
  "router.test.mjs", // 26
  "scripts-fixes.test.mjs", // 25
];

/** The src suite's files (names in `src`), in the order they start: SLOW_FIRST's that exist, then the rest by name. */
export function srcFiles(dir = join(ROOT, "src")) {
  const all = readdirSync(dir).filter((n) => /\.test\.(ts|mjs)$/.test(n)).sort();
  const slow = SLOW_FIRST.filter((n) => all.includes(n));
  return [...slow, ...all.filter((n) => !slow.includes(n))];
}

/** The src suite in this process (started under tsx, whose loader the run's file processes inherit). @returns {Promise<number>} */
async function runSrc() {
  const { run } = await import("node:test");
  const { spec } = await import("node:test/reporters");
  let failed = false;
  const stream = run({ files: srcFiles().map((n) => join(ROOT, "src", n)), concurrency: Math.max(1, availableParallelism() - 1) });
  stream.on("test:fail", () => (failed = true));
  stream.on("test:summary", (/** @type {{ file?: string, success: boolean }} */ s) => {
    if (s.file === undefined && !s.success) failed = true;
  });
  for await (const chunk of stream.compose(spec)) process.stdout.write(chunk);
  return failed ? 1 : 0;
}

const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain && process.argv[2] === "--src") {
  process.exitCode = await runSrc();
} else if (isMain) {
  const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
  /** @type {[string, string[], boolean][]} command, arguments, through the shell */
  const SUITES = [
    [process.execPath, [tsxCli, fileURLToPath(import.meta.url), "--src"], false],
    ["node --test bench/*.test.mjs", [], true],
  ];

  const root = mkdtempSync(join(tmpdir(), "orch-test-"));
  const keep = process.env.ORCH_KEEP_TEST_TMP === "1";
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (keep) return console.error(`test temp folder kept: ${root}`);
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      // a file still held open by a dying child: leave it, the run's result matters more
    }
  };
  process.on("exit", cleanup);

  /** @type {import("node:child_process").ChildProcess | undefined} */
  let child;
  for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
    process.on(sig, () => {
      child?.kill(sig);
      cleanup();
      process.exit(sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 129);
    });
  }

  /** @param {string} command @param {string[]} args @param {boolean} shell @returns {Promise<number>} */
  const runSuite = (command, args, shell) =>
    new Promise((resolve) => {
      child = spawn(command, args, { cwd: ROOT, shell, stdio: "inherit", env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root } });
      child.on("error", () => resolve(1));
      child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
    });

  let status = 0;
  for (const [command, args, shell] of SUITES) {
    status = await runSuite(command, args, shell);
    if (status !== 0) break;
  }
  process.exit(status);
}
