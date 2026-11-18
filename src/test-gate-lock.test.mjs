// The suite lock after a gate killed with SIGKILL, and its takeover (verify.sh lock_stale, take_over): the 1.5.0
// "Known and not fixed" lines on the lock. verify.sh runs as the SubagentStop hook, as in test-gate-load.test.mjs.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
 * @param {string} project @param {{ env?: Record<string, string>, id?: string, transcript?: string, onStart?: (c: import("node:child_process").ChildProcess) => void }} [o]
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
    c.stdin.end(JSON.stringify({ hook_event_name: "SubagentStop", agent_type: "implementer", agent_id: o.id ?? "a1", cwd: project, session_id: "s1", ...(o.transcript ? { agent_transcript_path: o.transcript } : {}) }));
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
    // process) takes its place just before the real command runs. ln too, when it names the lock as its source (the
    // takeover's snapshot): the fresh lock replaces the name, as another gate's link would after a release.
    const mark = join(bin, "done");
    const realRm = spawnSync("sh", ["-c", "command -v rm"], { encoding: "utf8" }).stdout.trim();
    for (const name of ["rm", "mv", "ln"]) {
      const real = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      const args = name === "ln" ? `"$1"` : `"$@"`;
      writeFileSync(
        join(bin, name),
        `#!/bin/sh\nfor a in ${args}; do\n  if [ "$a" = '${lockFile(project)}' ] && [ ! -e '${mark}' ]; then : > '${mark}'; '${realRm}' -f '${lockFile(project)}'; echo "${process.pid} $(date +%s)" > '${lockFile(project)}'; break; fi\ndone\nexec '${real}' "$@"\n`,
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

test("a takeover that reads the lock while its name is free never moves the fresh lock that appears there", async () => {
  const project = tmp("orch-glk-free-");
  const box = tmp("orch-glk-box-");
  const bin = tmp("orch-glk-bin-");
  const lock = lockFile(project);
  // The read in take_over returns empty, as when another taker has just moved the stale lock away, and the name then
  // holds a lock (an empty file stands for that moment, since no external command runs between the read and the test).
  // A gate that judges the empty value stale reaches mv: the mv shim lets the other taker's fresh lock A (a live holder:
  // this process) take the name just before the real mv, and the ln shim lets a third gate link its lock C just before
  // the put-back, which then fails and removes A.
  const A = `${process.pid} ${nowS()}`;
  const C = `${process.pid} ${nowS() + 1}`;
  const guardSeen = join(bin, "guard");
  const moved = join(bin, "moved");
  mkdirSync(join(project, ".claude", "state"), { recursive: true });
  writeFileSync(lock, "");
  const real = (/** @type {string} */ n) => spawnSync("sh", ["-c", `command -v ${n}`], { encoding: "utf8" }).stdout.trim();
  const shim = (/** @type {string} */ n, /** @type {string} */ body) => writeFileSync(join(bin, n), `#!/bin/sh\n${body}\nexec '${real(n)}' "$@"\n`, { mode: 0o755 });
  shim("mkdir", `for a in "$@"; do [ "$a" != '${lock}.takeover' ] || : > '${guardSeen}'; done`);
  shim("mv", `if [ "$1" = '${lock}' ] && [ ! -e '${moved}' ]; then : > '${moved}'; '${real("rm")}' -f '${lock}'; echo '${A}' > '${lock}'; fi`);
  shim("ln", `if [ "$2" = '${lock}' ] && [ -e '${moved}' ] && [ ! -e '${bin}/linked' ]; then : > '${bin}/linked'; echo '${C}' > '${lock}'; fi`);
  const started = join(box, "started");
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let child;
  const run = gate(project, { env: { PATH: `${bin}:${process.env.PATH}`, ORCH_TEST_CMD: `date +%s%3N > '${started}'` }, onStart: (c) => (child = c) });
  try {
    const t = Date.now() + 20000;
    while (!existsSync(guardSeen) && Date.now() < t) await sleep(50);
    assert.ok(existsSync(guardSeen), "the gate reached its takeover");
    await sleep(500);
    // The other taker links A now, if the gate has not moved anything (under the fix it read the name as changed).
    if (readFileSync(lock, "utf8") === "") writeFileSync(lock, `${A}\n`);
    await sleep(2500);
    assert.equal(existsSync(moved), false, "the gate never moved the lock");
    assert.equal(readFileSync(lock, "utf8").trim(), A, "the fresh lock is still in place");
    assert.equal(existsSync(started), false, "no suite while the fresh lock's holder runs");
    const released = Date.now();
    rmSync(lock, { force: true }); // A's holder releases its lock
    const r = await run;
    assert.equal(r.status, 0, r.stderr);
    assert.ok(num(started) >= released, `the suite started only after the release (${num(started) - released} ms)`);
  } finally {
    child?.kill("SIGKILL");
    await run;
    rmSync(project, { recursive: true, force: true });
    rmSync(box, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("a lock released and replaced by another gate's between a waiter's read and its takeover is left in place", async () => {
  const project = tmp("orch-glk-rel-");
  const box = tmp("orch-glk-box-");
  const bin = tmp("orch-glk-bin-");
  const lock = lockFile(project);
  // Holder H: a live process (an orphaned sleep), so the waiter's take_lock fails and its takeover reads H's lock. The
  // first external command after the takeover's guard is made and the lock read is the date in lock_stale: its shim
  // plays H's normal release (H ends, its lock goes) and gate C linking its fresh lock (a live holder: this process).
  // A takeover that moves whatever is at the name would then move C's lock; the ln shim lets gate D link its lock just
  // before a put-back, which then fails and loses C's lock.
  const holder = Number(spawnSync("sh", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout.trim());
  const C = join(box, "c.lock");
  writeFileSync(C, `${process.pid} ${nowS()}\n`);
  const inGuard = join(bin, "guard");
  const swapped = join(bin, "swapped");
  mkdirSync(join(project, ".claude", "state"), { recursive: true });
  writeFileSync(lock, `${holder} ${nowS()}\n`);
  const real = (/** @type {string} */ n) => spawnSync("sh", ["-c", `command -v ${n}`], { encoding: "utf8" }).stdout.trim();
  const shim = (/** @type {string} */ n, /** @type {string} */ body) => writeFileSync(join(bin, n), `#!/bin/sh\n${body}\nexec '${real(n)}' "$@"\n`, { mode: 0o755 });
  shim("mkdir", `for a in "$@"; do [ "$a" != '${lock}.takeover' ] || : > '${inGuard}'; done`);
  shim(
    "date",
    `if [ -e '${inGuard}' ] && [ ! -e '${swapped}' ]; then : > '${swapped}'; kill ${holder}; n=0; while kill -0 ${holder} 2>/dev/null && [ $n -lt 100 ]; do '${real("sleep")}' 0.05; n=$((n+1)); done; '${real("rm")}' -f '${lock}'; '${real("ln")}' '${C}' '${lock}'; fi`,
  );
  shim("ln", `case "$1" in '${lock}'.stale.*) [ "$2" != '${lock}' ] || [ -e '${bin}/linked' ] || { : > '${bin}/linked'; echo "${process.pid} 1" > '${lock}'; } ;; esac`);
  const started = join(box, "started");
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let child;
  const run = gate(project, { env: { PATH: `${bin}:${process.env.PATH}`, ORCH_TEST_CMD: `date +%s%3N > '${started}'` }, onStart: (c) => (child = c) });
  try {
    const t = Date.now() + 20000;
    while (!existsSync(swapped) && Date.now() < t) await sleep(50);
    assert.ok(existsSync(swapped), "the holder released and gate C linked its lock during the waiter's takeover");
    await sleep(2500);
    assert.equal(alive(holder), false, "the holder is gone");
    assert.equal(existsSync(lock) && statSync(lock).ino, statSync(C).ino, "gate C's lock (same inode) is still at the name");
    assert.equal(readFileSync(lock, "utf8"), readFileSync(C, "utf8"), "and its content is unchanged");
    assert.equal(existsSync(started), false, "no suite while gate C holds the lock");
    const released = Date.now();
    rmSync(lock, { force: true }); // gate C releases its lock
    const r = await run;
    assert.equal(r.status, 0, r.stderr);
    assert.ok(num(started) >= released, `the waiter's suite started only after the release (${num(started) - released} ms)`);
    assert.equal(records(project).at(-1)?.reason, "tests_passed", "the waiter ends with a decision");
  } finally {
    child?.kill("SIGKILL");
    await run;
    try {
      process.kill(holder, "SIGKILL");
    } catch {
      // gone
    }
    rmSync(project, { recursive: true, force: true });
    rmSync(box, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

test("a stale lock is replaced in place: the lock's path is never the source of a move, and the takeover is logged", async () => {
  const project = tmp("orch-glk-swap-");
  const bin = tmp("orch-glk-bin-");
  const lock = lockFile(project);
  const moves = join(bin, "moves");
  try {
    deadLock(project); // a dead holder, no companion file
    const realMv = spawnSync("sh", ["-c", "command -v mv"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(bin, "mv"), `#!/bin/sh\nfor a in "$@"; do case "$a" in -*) ;; *) [ "$a" != '${lock}' ] || echo "$*" >> '${moves}'; break ;; esac; done\nexec '${realMv}' "$@"\n`, { mode: 0o755 });
    const r = await gate(project, { env: { PATH: `${bin}:${process.env.PATH}`, ORCH_TEST_CMD: "true" } });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([records(project).at(-1)?.reason, records(project).at(-1)?.lock_takeover], ["tests_passed", 1]);
    assert.equal(existsSync(moves), false, `no mv took the lock's path as its source: ${existsSync(moves) ? readFileSync(moves, "utf8") : ""}`);
    assert.equal(existsSync(lock), false, "the lock was released at the end");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(bin, { recursive: true, force: true });
  }
});

// bugfix_timeout: the message says what the gate's time budget went to, from the facts verify.sh has (the wait for
// the suite lock, the test run, the check), so a block caused by another gate's suite does not blame this suite.
/** A KIND: bugfix agent's transcript. @param {string} box */
function bugfixTranscript(box) {
  const f = join(box, "agent.jsonl");
  writeFileSync(f, `${JSON.stringify({ type: "user", message: { content: "SLICE: fix\nFILES: app.sh\nDEPENDS: none\nKIND: bugfix\nFix VALUE." } })}\n`);
  return f;
}
const BUGFIX_ON = { ORCH_BUGFIX_CHECK: "" };

test("bugfix_timeout after waiting for the suite lock: the message names the wait, not the suite", async () => {
  const project = tmp("orch-glk-bfw-");
  const box = tmp("orch-glk-box-");
  try {
    // Another gate holds the lock for the whole budget (a live holder: this process), so the wait runs down to the
    // floor (a quarter of a 16 s budget) and leaves no time for the bugfix check; the suite itself is instant.
    mkdirSync(join(project, ".claude", "state"), { recursive: true });
    writeFileSync(lockFile(project), `${process.pid} ${nowS()}\n`);
    const r = await gate(project, { transcript: bugfixTranscript(box), env: { ...BUGFIX_ON, ORCH_TEST_CMD: "true", ORCH_HOOK_BUDGET_S: "16" } });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(records(project).at(-1)?.reason, "bugfix_timeout");
    assert.match(r.stderr, /KIND: bugfix: unverified/);
    assert.match(r.stderr, /\b(1[0-6]|9) s of it went to waiting for another test gate/, r.stderr);
    assert.match(r.stderr, /the test run took [01] s/, r.stderr);
    assert.doesNotMatch(r.stderr, /Make the test suite faster/, "the wait, not the suite, is to blame");
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(box, { recursive: true, force: true });
  }
});

test("bugfix_timeout after a slow test run: the message names the run and asks for a faster suite", async () => {
  const project = tmp("orch-glk-bfr-");
  const box = tmp("orch-glk-box-");
  try {
    // No lock to wait for; the suite takes 6 s of a 14 s budget, which leaves under the 10 s the check needs.
    const r = await gate(project, { transcript: bugfixTranscript(box), env: { ...BUGFIX_ON, ORCH_TEST_CMD: "sleep 6", ORCH_HOOK_BUDGET_S: "14" } });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(records(project).at(-1)?.reason, "bugfix_timeout");
    assert.match(r.stderr, /the test run took [6-8] s/, r.stderr);
    assert.match(r.stderr, /Make the test suite faster, or report the bug as unverified/);
    assert.doesNotMatch(r.stderr, /went to waiting/);
  } finally {
    rmSync(project, { recursive: true, force: true });
    rmSync(box, { recursive: true, force: true });
  }
});
