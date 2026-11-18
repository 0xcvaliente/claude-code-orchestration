// The suite lock after a gate killed with SIGKILL, and its takeover (verify.sh lock_stale, take_over): the 1.5.0
// "Known and not fixed" lines on the lock. verify.sh runs as the SubagentStop hook, as in test-gate-load.test.mjs.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const verifySh = new URL("../.claude/hooks/verify.sh", import.meta.url).pathname;
/** @returns {Record<string, string>} */
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      /** @returns {e is [string, string]} */ (e) => e[1] !== undefined && !/^(GIT_|ORCH_|CLAUDE_PLUGIN_OPTION_|CLAUDE_PLUGIN_ROOT|CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS$|NODE_TEST_CONTEXT$)/.test(e[0]),
    ),
  );
const tmp = (/** @type {string} */ p) => mkdtempSync(join(tmpdir(), p));
const lockFile = (/** @type {string} */ project) => join(project, ".claude", "state", "test-gate.lock");
const QUIET = { ORCH_BASELINE: "off", ORCH_BUGFIX_CHECK: "off" };
const nowS = () => Math.floor(Date.now() / 1000);
const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** @param {string} f */
const num = (f) => Number(existsSync(f) ? readFileSync(f, "utf8").trim() : 0);
/** @param {number} pid */
const alive = (pid) => {
  try {
    return pid > 0 && process.kill(pid, 0);
  } catch {
    return false;
  }
};
/** @param {string} project */
const records = (project) => readFileSync(join(project, ".claude", "state", "gates.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

/**
 * @param {string} project @param {{ env?: Record<string, string>, id?: string, onStart?: (c: import("node:child_process").ChildProcess) => void }} [o]
 * @returns {Promise<{ status: number | null, signal: string | null, stderr: string, ms: number }>}
 */
function gate(project, o = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn("bash", [verifySh], { env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: project, TMPDIR: tmp("orch-glk-tmp-"), ...QUIET, ...o.env }, stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    c.stderr.on("data", (d) => (stderr += d));
    const kill = setTimeout(() => c.kill("SIGKILL"), 90000);
    c.on("close", (status, signal) => {
      clearTimeout(kill);
      resolve({ status, signal, stderr, ms: Date.now() - t0 });
    });
    c.stdin.end(JSON.stringify({ hook_event_name: "SubagentStop", agent_type: "implementer", agent_id: o.id ?? "a1", cwd: project, session_id: "s1" }));
    o.onStart?.(c);
  });
}
/** A stale lock: its holder's process is gone. @param {string} project */
function deadLock(project) {
  mkdirSync(join(project, ".claude", "state"), { recursive: true });
  writeFileSync(lockFile(project), `${spawnSync("true").pid ?? 999999} ${nowS()}\n`);
}

test("a gate killed with SIGKILL: its lock is not taken over while its suite still runs, then at once, logged", async () => {
  const project = tmp("orch-glk-kill-");
  const box = tmp("orch-glk-box-");
  const suite = join(box, "suite.pid");
  const result = join(box, "result");
  try {
    /** @type {import("node:child_process").ChildProcess | undefined} */
    let first;
    const run1 = gate(project, { env: { ORCH_TEST_CMD: `echo $$ > '${suite}'; sleep 60` }, onStart: (c) => (first = c) });
    const t = Date.now() + 20000;
    while (num(suite) === 0 && Date.now() < t) await sleep(50);
    assert.ok(num(suite) > 0, "the first suite started");
    first?.kill("SIGKILL"); // no trap runs: the lock stays, and the suite's process group runs on
    await run1;
    assert.ok(existsSync(lockFile(project)) && alive(num(suite)), "a lock whose holder is gone, and its suite still running");
    const run2 = gate(project, { id: "a2", env: { ORCH_TEST_CMD: `if kill -0 ${num(suite)} 2>/dev/null; then echo overlap; else echo alone; fi > '${result}'` } });
    await sleep(3000);
    process.kill(-num(suite), "SIGKILL"); // the killed gate's suite ends
    const r2 = await run2;
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(readFileSync(result, "utf8").trim(), "alone", "never two suites at once");
    assert.ok(r2.ms >= 2500, `it waited for the suite, ${r2.ms} ms`);
    assert.ok(r2.ms < 20000, `and took the lock over at once after it, ${r2.ms} ms`);
    assert.deepEqual([records(project).at(-1).reason, records(project).at(-1).lock_takeover], ["tests_passed", 1]);
    assert.equal(existsSync(lockFile(project)), false);
  } finally {
    try {
      process.kill(-num(suite), "SIGKILL");
    } catch {
      // gone
    }
    rmSync(project, { recursive: true, force: true });
    rmSync(box, { recursive: true, force: true });
  }
});

test("a stale lock without its companion file, and a release without one, add nothing to the hook's stderr", async () => {
  const project = tmp("orch-glk-quiet-");
  try {
    deadLock(project); // no test-gate.lock.run beside it
    // The suite removes the companion file the gate wrote, so the release finds none either; it fails, so stderr is the
    // agent's message.
    const r = await gate(project, { env: { ORCH_TEST_CMD: `rm -f '${lockFile(project)}.run'; echo 'not ok 1 - x'; exit 1` } });
    assert.equal(r.status, 2);
    assert.equal(records(project).at(-1).lock_takeover, 1, "the stale lock was taken over");
    assert.doesNotMatch(r.stderr, /No such file/);
    assert.match(r.stderr, /Fix the root cause and rerun before finishing\.\n$/, "the message ends as it always did");
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("two gates that find the same stale lock side by side: one takes it over, the suites never overlap", async () => {
  const project = tmp("orch-glk-two-");
  const box = tmp("orch-glk-box-");
  try {
    deadLock(project);
    const cmd = (/** @type {string} */ n) => `s=$(date +%s%N); sleep 1; echo "$s $(date +%s%N)" > '${join(box, n)}'`;
    const [r1, r2] = await Promise.all([gate(project, { id: "a1", env: { ORCH_TEST_CMD: cmd("one") } }), gate(project, { id: "a2", env: { ORCH_TEST_CMD: cmd("two") } })]);
    assert.deepEqual([r1.status, r2.status], [0, 0], r1.stderr + r2.stderr);
    const [a, b] = ["one", "two"].map((n) => readFileSync(join(box, n), "utf8").trim().split(" ").map(BigInt));
    assert.ok(a && b && ((a[1] ?? 0n) <= (b[0] ?? 0n) || (b[1] ?? 0n) <= (a[0] ?? 0n)), "one suite after the other");
    assert.equal(records(project).filter((x) => x.lock_takeover === 1).length, 1, "exactly one takeover");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(box, { recursive: true, force: true });
  }
});

test("a fresh lock made between the stale check and the removal is never removed: the taker waits for it", async () => {
  const project = tmp("orch-glk-race-");
  const box = tmp("orch-glk-box-");
  const bin = tmp("orch-glk-bin-");
  try {
    deadLock(project);
    // rm and mv first on PATH: the first time either names the lock, another gate's fresh lock (a live holder: this
    // process) takes its place just before the real command runs.
    const mark = join(bin, "done");
    for (const name of ["rm", "mv"]) {
      const real = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      writeFileSync(
        join(bin, name),
        `#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = '${lockFile(project)}' ] && [ ! -e '${mark}' ]; then : > '${mark}'; echo "${process.pid} $(date +%s)" > '${lockFile(project)}'; break; fi\ndone\nexec '${real}' "$@"\n`,
        { mode: 0o755 },
      );
    }
    const started = join(box, "started");
    const run = gate(project, { env: { PATH: `${bin}:${process.env.PATH}`, ORCH_TEST_CMD: `date +%s%3N > '${started}'` } });
    const t = Date.now() + 20000;
    while (!existsSync(mark) && Date.now() < t) await sleep(50);
    assert.ok(existsSync(mark), "the fresh lock came in between");
    await sleep(2500);
    const released = Date.now();
    rmSync(lockFile(project), { force: true }); // the other gate releases its lock
    const r = await run;
    assert.equal(r.status, 0, r.stderr);
    assert.ok(num(started) >= released, `the suite started only after the other gate released its lock (${num(started) - released} ms)`);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(box, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});
