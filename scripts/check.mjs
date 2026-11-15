#!/usr/bin/env node
// `npm run check`: runs the independent checks (typecheck, the tests, check-agents, check-plugin) at the same time
// instead of one after another. Each step's output (stdout and stderr together, in arrival order) is held back and
// printed whole under a header naming the step as soon as that step finishes, so two steps never interleave. The exit
// code is 0 only when every step passed, and the last line names every failing step. SIGINT, SIGTERM or SIGHUP stops
// every step (its whole process group on macOS and Linux) and exits 130, 143 or 129.
// The tests run as `npm test`, so `npm_lifecycle_event` is `test` inside them, as when `npm test` is run alone.
// ORCH_CHECK_STEPS (a JSON array of [name, shell command] pairs) replaces the step list; src/check.test.mjs uses it.
// Commands run through the shell, so `npm` resolves to npm.cmd on Windows; there a signal stops each step's shell only.
import { spawn } from "node:child_process";

/** @type {[string, string][]} */
const DEFAULT_STEPS = [
  ["typecheck", "npm run typecheck"],
  ["test", "npm test"],
  ["check-agents", "npm run check-agents"],
  ["check-plugin", "npm run check-plugin"],
];

/** @returns {[string, string][]} */
function steps() {
  const raw = process.env.ORCH_CHECK_STEPS;
  if (!raw) return DEFAULT_STEPS;
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((s) => Array.isArray(s) && s.length === 2 && s.every((x) => typeof x === "string"))) {
    throw new Error("ORCH_CHECK_STEPS must be a JSON array of [name, command] pairs");
  }
  if (parsed.length === 0) throw new Error("ORCH_CHECK_STEPS names no steps: an empty check must never pass");
  return parsed;
}

const posix = process.platform !== "win32";
/** how long a step's pipes may stay open after its process has exited */
const PIPE_GRACE_MS = 500;

// A reader that goes away early (`node scripts/check.mjs | head -1`) makes later writes fail with EPIPE: drop them
// quietly, the exit code still follows the steps.
process.stdout.on("error", (e) => {
  if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EPIPE") throw e;
});
/** @type {Set<import("node:child_process").ChildProcess>} */
const running = new Set();
/** the exit code of the signal that stopped the run, once one has */
let stopped = 0;

/** @param {import("node:child_process").ChildProcess} child @param {NodeJS.Signals} sig */
function stop(child, sig) {
  try {
    // detached on POSIX: the child leads its own process group, so the negative pid reaches npm, node and the test workers
    if (posix && child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    // already gone
  }
}

for (const sig of /** @type {const} */ (["SIGINT", "SIGTERM", "SIGHUP"])) {
  process.on(sig, () => {
    const code = sig === "SIGINT" ? 130 : sig === "SIGTERM" ? 143 : 129;
    if (stopped) return;
    stopped = code;
    for (const child of running) stop(child, sig);
    // the steps get 5 s to clean up (the test runner removes its temp root on SIGTERM), then SIGKILL. The run then ends
    // as usual below, with the exit code of the signal. A step whose pipes stay open past 10 s ends it the hard way.
    setTimeout(() => {
      for (const child of running) stop(child, "SIGKILL");
    }, 5000).unref();
    setTimeout(() => process.exit(code), 10000).unref();
  });
}

/** @param {string} name @param {string} command @returns {Promise<{ name: string, ok: boolean }>} */
const run = (name, command) =>
  new Promise((resolve) => {
    const started = Date.now();
    /** @type {Buffer[]} */
    const out = [];
    const child = spawn(command, { shell: true, detached: posix, stdio: ["ignore", "pipe", "pipe"] });
    running.add(child);
    child.stdout?.on("data", (b) => out.push(b));
    child.stderr?.on("data", (b) => out.push(b));
    /** @param {number | null} code @param {string} [error] @param {string} [secs] */
    const finish = (code, error, secs = ((Date.now() - started) / 1000).toFixed(1)) => {
      if (!running.delete(child)) return;
      const ok = code === 0;
      let text = Buffer.concat(out).toString("utf8");
      if (error) text += `${error}\n`;
      if (text && !text.endsWith("\n")) text += "\n";
      process.stdout.write(`\n=== ${name}: ${ok ? "pass" : `FAIL (exit ${code ?? "signal"})`}, ${secs} s ===\n${text}`);
      resolve({ name, ok });
    };
    child.on("error", (e) => finish(1, String(e)));
    // A step ends when its process exits, not when its pipes close: a background process it leaves behind (a test's
    // `sleep 60`) still holds them open. The pipes get PIPE_GRACE_MS to deliver what is already written, then they are
    // destroyed so that such a process cannot keep check.mjs waiting. The step's time is its time to exit.
    child.on("exit", (code) => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      const done = () => {
        clearTimeout(timer);
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(code, undefined, secs);
      };
      const timer = setTimeout(done, PIPE_GRACE_MS);
      child.once("close", done);
    });
  });

// The process ends by itself once every write has reached stdout: process.exit() here would drop the writes still
// queued for a pipe (CI reads stdout through one), with the summary line among them.
const started = Date.now();
/** @type {[string, string][]} */
let list = [];
try {
  list = steps();
} catch (e) {
  process.stderr.write(`check: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 2;
}
if (list.length) {
  const results = await Promise.all(list.map(([name, command]) => run(name, command)));
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (stopped) {
    process.stdout.write(`\ncheck stopped by a signal (exit ${stopped})\n`);
    process.exitCode = stopped;
  } else if (failed.length) {
    process.stdout.write(`\ncheck failed: ${failed.join(", ")} (${failed.length} of ${list.length} steps, ${secs} s)\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`\ncheck passed: all ${list.length} steps (${list.map(([n]) => n).join(", ")}), ${secs} s\n`);
    process.exitCode = 0;
  }
}
