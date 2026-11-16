// The test gate under load (live use, 2026-11-16: four isolated implementers of one wave stopped within two minutes,
// each gate ran the whole suite and a base run at once, three records came 554 to 590 s after their stops and the fourth
// agent was failed by Claude Code's 600 s stall limit with no gate record). verify.sh now (1) ends its whole run under
// the stall limit (default budget 540 s), (2) runs one suite at a time per project through a lock in the shared state
// folder, and (3) never skips silently: an isolated agent that cannot get the lock in time gets a tests_failed_isolated
// warn record that says the tests did not run; the shared tree runs the suite anyway. Notes:
// docs/data/audit-2026-11-16/fix-notes-gate-load.md. Real hook processes on scratch projects; no model call.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { foldRuns, launchRecord, stopRecord } from "../.claude/hooks/brief.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const verifySh = join(root, ".claude", "hooks", "verify.sh");
const STALL = "CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS";

// The machine's git, ORCH_, plugin option and stall variables are dropped so every run sees only what a test sets.
/** @returns {Record<string, string>} */
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      /** @returns {e is [string, string]} */ (e) =>
        e[1] !== undefined && !/^(GIT_|ORCH_|CLAUDE_PLUGIN_OPTION_|CLAUDE_PLUGIN_ROOT|CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS$|NODE_TEST_CONTEXT$)/.test(e[0]),
    ),
  );

/** @param {string} dir @param {...string} args */
function git(dir, ...args) {
  const r = spawnSync("git", ["-c", "user.name=orch", "-c", "user.email=orch@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env: cleanEnv(), encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
/** @param {string} dir @param {Record<string, string>} files */
function write(dir, files) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
}
const tmp = (/** @type {string} */ prefix) => mkdtempSync(join(tmpdir(), prefix));
const stateDir = (/** @type {string} */ project) => join(project, ".claude", "state");
const lockFile = (/** @type {string} */ project) => join(stateDir(project), "test-gate.lock");
/** @param {string} project @returns {any[]} */
const testRecords = (project) => {
  const f = join(stateDir(project), "gates.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((g) => g.gate === "test") : [];
};
const lastTest = (/** @type {string} */ project) => testRecords(project).at(-1);

/**
 * verify.sh as the SubagentStop hook runs it, started at once; the promise settles when it ends. `limitMs` kills a hook
 * that hangs, so a missing limit fails the test instead of hanging it.
 * @param {string} project @param {{ cwd?: string, env?: Record<string, string>, id?: string, limitMs?: number, onStart?: (c: import("node:child_process").ChildProcess) => void }} [o]
 * @returns {Promise<{ status: number | null, signal: string | null, stderr: string, ms: number }>}
 */
function gate(project, o = {}) {
  const event = { agent_type: "implementer", agent_id: o.id ?? "a1", cwd: o.cwd ?? project, session_id: "s1" };
  return new Promise((resolve) => {
    const t0 = Date.now();
    const c = spawn("bash", [verifySh], { env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: project, TMPDIR: tmp("orch-gl-tmp-"), ...o.env }, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    c.stderr.on("data", (d) => (stderr += d));
    c.stdout.resume();
    const kill = setTimeout(() => c.kill("SIGKILL"), o.limitMs ?? 60000);
    c.on("close", (status, signal) => {
      clearTimeout(kill);
      resolve({ status, signal, stderr, ms: Date.now() - t0 });
    });
    c.stdin.end(JSON.stringify(event));
    o.onStart?.(c);
  });
}

const QUIET = { ORCH_BASELINE: "off", ORCH_BUGFIX_CHECK: "off" };
const nowS = () => Math.floor(Date.now() / 1000);
/** A lock file as another holder would leave it: "<pid> <start epoch seconds>". @param {string} project @param {number} pid @param {number} start */
function holdLock(project, pid, start) {
  mkdirSync(stateDir(project), { recursive: true });
  writeFileSync(lockFile(project), `${pid} ${start}\n`);
}
/** A main repo and an isolated worktree under its .claude/worktrees. */
function isolatedRepo() {
  const main = tmp("orch-gl-main-");
  git(main, "init", "-q");
  write(main, { "app.js": "x\n", ".gitignore": ".claude/\n" });
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "init");
  const wt = join(main, ".claude", "worktrees", "w");
  git(main, "worktree", "add", "-q", "--detach", wt);
  write(wt, { "app.js": "y\n" });
  return { main, wt };
}
/** @param {number} pid */
const alive = (pid) => {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** @param {number} ms */
const sleep =(ms) => new Promise((r) => setTimeout(r, ms));
/** @param {() => boolean} cond @param {number} ms */
async function until(cond, ms) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(50);
  return cond();
}

// ---- 2. One suite at a time. ----

test("gate load: two gate runs started together on one project run their suites one after the other", async () => {
  const project = tmp("orch-gl-two-");
  const times = join(tmp("orch-gl-times-"), "times");
  // Each suite writes its tag with its start and end second, and sleeps 2 s in between.
  const cmd = `echo "start $TAG $(date +%s)" >> '${times}'; sleep 2; echo "end $TAG $(date +%s)" >> '${times}'`;
  const [a, b] = await Promise.all([
    gate(project, { id: "a1", env: { ...QUIET, ORCH_TEST_CMD: cmd, TAG: "a" } }),
    gate(project, { id: "a2", env: { ...QUIET, ORCH_TEST_CMD: cmd, TAG: "b" } }),
  ]);
  assert.deepEqual([a.status, b.status], [0, 0], a.stderr + b.stderr);
  /** @type {Record<string, { start?: number, end?: number }>} */
  const by = {};
  for (const line of readFileSync(times, "utf8").trim().split("\n")) {
    const [what, tag, t] = line.split(" ");
    (by[tag ?? ""] ??= {})[/** @type {"start" | "end"} */ (what)] = Number(t);
  }
  const [first, second] = Object.values(by).sort((x, y) => (x.start ?? 0) - (y.start ?? 0));
  assert.ok(first?.end !== undefined && second?.start !== undefined, JSON.stringify(by));
  assert.ok(second.start >= first.end, `the second suite started at ${second.start}, before the first ended at ${first.end}`);
  assert.deepEqual(testRecords(project).map((r) => r.reason), ["tests_passed", "tests_passed"]);
  assert.ok(!existsSync(lockFile(project)), "the lock is released after both runs");
});

test("gate load: the lock holds the holder's process id and start time while the suite runs, and is gone after a normal run", async () => {
  const project = tmp("orch-gl-hold-");
  const seen = join(tmp("orch-gl-seen-"), "seen");
  const before = nowS();
  const r = await gate(project, { env: { ...QUIET, ORCH_TEST_CMD: `cat '${lockFile(project)}' > '${seen}'` } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lastTest(project).reason, "tests_passed");
  const m = /^(\d+) (\d+)$/.exec(readFileSync(seen, "utf8").trim());
  assert.ok(m, `lock content: ${readFileSync(seen, "utf8")}`);
  assert.ok(Number(m[2]) >= before - 1 && Number(m[2]) <= nowS() + 1, `start ${m[2]}`);
  assert.ok(!existsSync(lockFile(project)), "the lock is gone after a normal run");
});

test("gate load: the lock is gone after a timed-out run and after the hook is ended by SIGTERM", async () => {
  const project = tmp("orch-gl-to-");
  const seen = join(tmp("orch-gl-seen-"), "seen");
  const hung = `cat '${lockFile(project)}' > '${seen}'; sleep 300`;
  const r = await gate(project, { env: { ...QUIET, ORCH_TEST_CMD: hung, ORCH_TEST_TIMEOUT_S: "1" }, limitMs: 30000 });
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual([lastTest(project).reason, lastTest(project).timed_out], ["tests_failed", 1]);
  assert.match(readFileSync(seen, "utf8"), /^\d+ \d+\n?$/, "the suite ran under the lock");
  assert.ok(!existsSync(lockFile(project)), "the lock is gone after a timed-out run");

  const project2 = tmp("orch-gl-term-");
  const seen2 = join(tmp("orch-gl-seen-"), "seen");
  /** @type {import("node:child_process").ChildProcess | undefined} */
  let child;
  const run = gate(project2, { env: { ...QUIET, ORCH_TEST_CMD: `cat '${lockFile(project2)}' > '${seen2}'; sleep 300` }, limitMs: 30000, onStart: (c) => (child = c) });
  assert.ok(await until(() => existsSync(seen2) && readFileSync(seen2, "utf8").length > 0, 20000), "the suite started");
  child?.kill("SIGTERM");
  await run;
  assert.ok(!existsSync(lockFile(project2)), "the lock is gone after the hook was ended by SIGTERM");
});

test("gate load: a stale lock (its holder gone, or older than the hook timeout) is taken over", async () => {
  const dead = spawnSync("true").pid ?? 999999;
  for (const [name, pid, start] of [["holder gone", dead, nowS()], ["older than the hook timeout", process.pid, nowS() - 1000]]) {
    const project = tmp("orch-gl-stale-");
    holdLock(project, Number(pid), Number(start));
    const seen = join(tmp("orch-gl-seen-"), "seen");
    const r = await gate(project, { env: { ...QUIET, ORCH_TEST_CMD: `cat '${lockFile(project)}' > '${seen}'`, [STALL]: "68000" }, limitMs: 30000 });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(lastTest(project).reason, "tests_passed", String(name));
    const [p, s] = readFileSync(seen, "utf8").trim().split(" ").map(Number);
    assert.ok(p !== pid && (s ?? 0) >= nowS() - 30, `${name}: the suite ran under the gate's own lock, saw ${p} ${s}`);
    assert.ok(r.ms < 6000, `${name}: taken over at once, took ${r.ms} ms`);
    assert.ok(!existsSync(lockFile(project)), `${name}: the lock is gone afterwards`);
  }
});

test("gate load: a lock that vanishes between the failed link and the look at it is tried again, never run without", async () => {
  const project = tmp("orch-gl-race-");
  holdLock(project, process.pid, nowS());
  // An `ln` first on PATH that, the first time the real one fails, removes the lock: the holder released it in between.
  const bin = tmp("orch-gl-bin-");
  const realLn = spawnSync("sh", ["-c", "command -v ln"], { encoding: "utf8" }).stdout.trim();
  const mark = join(bin, "vanished");
  writeFileSync(join(bin, "ln"), `#!/bin/sh\n'${realLn}' "$@" && exit 0\nrc=$?\nif [ ! -e '${mark}' ]; then : > '${mark}'; rm -f '${lockFile(project)}'; fi\nexit $rc\n`, { mode: 0o755 });
  const seen = join(tmp("orch-gl-seen-"), "seen");
  const r = await gate(project, { env: { ...QUIET, PATH: `${bin}:${process.env.PATH}`, ORCH_TEST_CMD: `cat '${lockFile(project)}' > '${seen}' 2>/dev/null; true` }, limitMs: 30000 });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(existsSync(mark), "the lock vanished between the two steps");
  assert.match(existsSync(seen) ? readFileSync(seen, "utf8") : "", /^\d+ \d+\n?$/, "the suite ran under the gate's own lock");
  assert.ok(!existsSync(lockFile(project)), "and released it");
});

test("gate load: TERM to the gate ends its running suite's process group before the lock is released", async () => {
  const project = tmp("orch-gl-sig-");
  const pids = tmp("orch-gl-pids-");
  const suitePid = join(pids, "suite.pid");
  const childPid = join(pids, "child.pid");
  const result = join(pids, "second");
  /** @param {string} f */
  const pidOf = (f) => Number(existsSync(f) ? readFileSync(f, "utf8").trim() : 0);
  try {
    /** @type {import("node:child_process").ChildProcess | undefined} */
    let first;
    const run = gate(project, { env: { ...QUIET, ORCH_TEST_CMD: `echo $$ > '${suitePid}'; sleep 300 & echo $! > '${childPid}'; wait` }, limitMs: 30000, onStart: (c) => (first = c) });
    assert.ok(await until(() => pidOf(suitePid) > 0 && pidOf(childPid) > 0, 20000), "the suite started");
    first?.kill("SIGTERM");
    const r = await run;
    assert.ok(r.status === 143 || r.signal === "SIGTERM", `ended by the signal: ${r.status} ${r.signal}`);
    assert.ok(await until(() => !alive(pidOf(suitePid)) && !alive(pidOf(childPid)), 8000), "the suite and its child are gone shortly after");
    assert.ok(!existsSync(lockFile(project)), "the lock is gone");
    // A second gate started now runs its suite alone.
    const second = await gate(project, { id: "a2", env: { ...QUIET, ORCH_TEST_CMD: `if kill -0 $(cat '${childPid}') 2>/dev/null; then echo overlap; else echo alone; fi > '${result}'` } });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(result, "utf8").trim(), "alone");
  } finally {
    for (const p of [pidOf(suitePid), pidOf(childPid)]) if (p > 0 && alive(p)) process.kill(p, "SIGKILL");
  }
});

// ---- 3. No silent skip. ----

test("gate load: a run that cannot get the lock within its budget writes the warn record in an isolated worktree and runs anyway in the shared tree", async () => {
  const { main, wt } = isolatedRepo();
  holdLock(main, process.pid, nowS()); // a live holder that never lets go
  const held = readFileSync(lockFile(main), "utf8");
  // Stall limit 68 s: budget 8 s, so the wait ends within a few seconds.
  const env = { ...QUIET, [STALL]: "68000" };
  const [iso, shared] = await Promise.all([
    gate(main, { cwd: wt, id: "iso", env: { ...env, ORCH_TEST_CMD: "touch ran.marker" } }),
    gate(main, { id: "shared", env: { ...env, ORCH_TEST_CMD: "touch ran.marker; exit 1" } }),
  ]);
  const recs = testRecords(main);
  const isoRec = recs.find((r) => r.agent_id === "iso");
  const sharedRec = recs.find((r) => r.agent_id === "shared");

  assert.equal(iso.status, 0, iso.stderr);
  assert.equal(iso.stderr, "", "a warn prints nothing");
  assert.ok(iso.ms >= 3000 && iso.ms < 15000, `the isolated gate waited, then gave up within its budget: ${iso.ms} ms`);
  assert.deepEqual([isoRec?.decision, isoRec?.reason, isoRec?.not_run], ["warn", "tests_failed_isolated", 1]);
  assert.equal(typeof isoRec?.lock_wait_s, "number");
  assert.ok(!existsSync(join(wt, "ran.marker")), "the isolated suite did not run");

  assert.equal(shared.status, 2, "the shared tree runs the suite anyway, and its failure blocks");
  assert.deepEqual([sharedRec?.decision, sharedRec?.reason, sharedRec?.not_run], ["block", "tests_failed", undefined]);
  assert.ok(existsSync(join(main, "ran.marker")), "the shared suite ran");
  assert.doesNotMatch(shared.stderr, /ORCH_|CLAUDE_ASYNC/, "no printed message names a switch");

  assert.equal(readFileSync(lockFile(main), "utf8"), held, "neither gate removed a lock it did not hold");

  // The run model counts the record as an isolated test failure of the slice (a doubt signal: opus review).
  const t0 = Date.parse(isoRec.ts);
  const launch = launchRecord({ subagent_type: "implementer", prompt: "SLICE: a\nFILES: app.js\nDEPENDS: none\nPATH: light" }, { ts: new Date(t0 - 60000).toISOString(), sessionId: "s1", agentId: "iso" });
  const stop = stopRecord({ ts: new Date(t0).toISOString(), sessionId: "s1", agentId: "iso", role: "implementer", reply: "STATUS: pass" });
  const { runs } = foldRuns({ launches: [launch], stops: [stop], gates: [isoRec] }, { now: Date.now(), sessionId: "s1" });
  assert.equal(runs[0]?.slices.a?.isolatedTestFailure, true);
  assert.ok(runs[0]?.slices.a?.signals?.includes("tests_failed_isolated"), JSON.stringify(runs[0]?.slices.a?.signals));
});

// ---- 1. Budget under the stall limit. ----

// The base run's share of a failing gate is (time left - 10) when its own limit is larger, so it shows the budget.
const FAIL = "FAILED tests/test_a.py::a - boom\n";
/** @param {Record<string, string>} env */
async function baseShare(env) {
  const dir = tmp("orch-gl-budget-");
  git(dir, "init", "-q");
  write(dir, { "failures.txt": FAIL, "app.js": "x\n" });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, { "app.js": "y\n" });
  const seen = join(tmp("orch-gl-seen-"), "seen");
  const cmd = `printf '%s\\n' "$ORCH_BASE_TIMEOUT_S" >> '${seen}'; cat failures.txt; ! test -s failures.txt`;
  await gate(dir, { env: { ORCH_TEST_CMD: cmd, ORCH_BASE_TIMEOUT_S: "5000", ORCH_BUGFIX_CHECK: "off", ...env } });
  return Number(readFileSync(seen, "utf8").trim().split("\n").pop());
}

test("gate load: the default budget is 540 s with the stall variable unset, follows it when set, and never exceeds 870", async () => {
  /** @type {[string, Record<string, string>, number][]} */
  const cases = [
    ["stall unset: 540", {}, 540],
    ["stall not a number: 540", { [STALL]: "abc" }, 540],
    ["stall 0: 540", { [STALL]: "0" }, 540],
    ["stall 120 s: 60", { [STALL]: "120000" }, 60],
    ["stall 3600 s: capped at 870", { [STALL]: "3600000" }, 870],
    ["stall huge: capped at 870", { [STALL]: "99999999999999999999" }, 870],
    ["a larger budget setting is cut to the stall rule", { ORCH_HOOK_BUDGET_S: "5000", [STALL]: "120000" }, 60],
    ["a larger budget setting with the stall unset is cut to 540", { ORCH_HOOK_BUDGET_S: "5000" }, 540],
    ["a smaller budget setting is respected", { ORCH_HOOK_BUDGET_S: "30" }, 30],
  ];
  const shares = await Promise.all(cases.map(([, env]) => baseShare(env)));
  cases.forEach(([name, , budget], i) => {
    const share = shares[i] ?? NaN;
    // share = budget - (seconds already spent, 0 to 3) - 10
    assert.ok(share <= budget - 10 && share >= budget - 15, `${name}: the base run got ${share} s, expected about ${budget - 10}`);
  });
});
