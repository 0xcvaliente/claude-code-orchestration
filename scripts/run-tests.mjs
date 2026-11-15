#!/usr/bin/env node
// `npm test`: runs the two test suites with every temporary file under one folder, and removes that folder at the end.
// The tests create thousands of temp folders per run (git repositories, state dirs, fake homes) and most never removed
// theirs, so each run left them in the system temp dir; on a machine whose /tmp is a tmpfs that used up every inode.
// One root set as TMPDIR (TMP and TEMP on Windows) covers every test, the hooks they start and tests added later.
// The exit code is the first failing suite's. ORCH_KEEP_TEST_TMP=1 keeps the folder and prints its path, for debugging.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SUITES = ["tsx --test src/*.test.ts src/*.test.mjs", "node --test bench/*.test.mjs"];

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

/** @param {string} command @returns {Promise<number>} */
const run = (command) =>
  new Promise((resolve) => {
    child = spawn(command, { shell: true, stdio: "inherit", env: { ...process.env, TMPDIR: root, TMP: root, TEMP: root } });
    child.on("error", () => resolve(1));
    child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });

let status = 0;
for (const suite of SUITES) {
  status = await run(suite);
  if (status !== 0) break;
}
process.exit(status);
