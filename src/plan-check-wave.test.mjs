// The plan check's wave cap (2.1.0, wave_full): implementers running at once in a session, counted from the gates' own
// reading of the logs (run.mjs), plus the launches it allowed that have not started yet; the cap from limits.mjs,
// narrowed for an isolated launch by the suite's recorded run time (run.mjs waveCap, beside stopGateWindowMs). Also the
// skills repository check under a slow git (C1 of slice s2: a git call that ran out of time is not a missing repository).
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gateBudgetS, gateFloorS, latestSuiteS, stopGateWindowMs, waveCap, waveLoad, GATE_OVERRUN_S } from "../.claude/hooks/run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the gate's budget and floor are verify.sh's numbers, and stopGateWindowMs is built on the same budget", () => {
  assert.equal(gateBudgetS({}), 540, "default: the stall limit 600 s less 60");
  assert.equal(gateFloorS({}), 120, "min(120, 540/4, 600)");
  assert.equal(gateBudgetS({ ORCH_HOOK_BUDGET_S: "100" }), 100);
  assert.equal(gateFloorS({ ORCH_HOOK_BUDGET_S: "100" }), 25, "a quarter of a small budget");
  assert.equal(gateFloorS({ ORCH_TEST_TIMEOUT_S: "60" }), 60, "never above the test run's own limit");
  assert.equal(gateBudgetS({ ORCH_HOOK_BUDGET_S: "5000" }), 540, "never above the maximum");
  assert.equal(gateBudgetS({ CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: "1200000" }), 870, "never above 870");
  assert.equal(gateFloorS({ ORCH_HOOK_BUDGET_S: "2" }), 1, "at least 1");
  for (const env of [{}, { ORCH_HOOK_BUDGET_S: "100" }, { CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: "300000" }]) {
    assert.equal(stopGateWindowMs(env), (gateBudgetS(env) + GATE_OVERRUN_S) * 1000);
  }
});

test("an isolated launch's cap narrows to 1 + floor((budget - floor) / suite seconds), between 1 and the base cap", () => {
  // Default budget 540, floor 120: 420 s left after the floor.
  assert.equal(waveCap(4, { isolated: true, suiteS: 200, env: {} }), 3, "1 + floor(420 / 200)");
  assert.equal(waveCap(4, { isolated: true, suiteS: 420, env: {} }), 2);
  assert.equal(waveCap(4, { isolated: true, suiteS: 600, env: {} }), 1, "a suite longer than the budget: one at a time");
  assert.equal(waveCap(4, { isolated: true, suiteS: 10, env: {} }), 4, "never above the base cap");
  assert.equal(waveCap(8, { isolated: true, suiteS: 10, env: {} }), 8);
  assert.equal(waveCap(4, { isolated: true, suiteS: 30, env: { ORCH_HOOK_BUDGET_S: "100" } }), 3, "budget 100, floor 25: 1 + floor(75 / 30)");
  assert.equal(waveCap(4, { isolated: false, suiteS: 600, env: {} }), 4, "a launch in the shared tree is not narrowed");
  assert.equal(waveCap(4, { isolated: true, suiteS: null, env: {} }), 4, "no suite_s on record: no narrowing");
  assert.equal(waveCap(4, { isolated: true, suiteS: 0, env: {} }), 4, "a suite under a second: no narrowing");
});

test("latestSuiteS: the last test-gate record that carries suite_s, in log order", () => {
  assert.equal(latestSuiteS([]), null);
  assert.equal(latestSuiteS([{ gate: "test", suite_s: 300 }, { gate: "test", reason: "no_test_command" }, { gate: "review", suite_s: 9 }]), 300);
  assert.equal(latestSuiteS([{ gate: "test", suite_s: 300 }, { gate: "test", suite_s: 41 }]), 41);
  assert.equal(latestSuiteS([{ gate: "test", suite_s: "300" }, { gate: "test", suite_s: -1 }, { gate: "test", suite_s: 2.5 }]), null, "only whole seconds count");
});

const T0 = Date.parse("2026-11-24T10:00:00.000Z");
/** @param {number} s seconds from T0 */
const at = (s) => new Date(T0 + s * 1000).toISOString();
/** @param {string} id @param {number} s @param {string} [ev] */
const tele = (id, s, ev = "SubagentStart", type = "implementer") => ({ ts: at(s), session_id: "s1", hook_event_name: ev, agent_id: id, agent_type: type });
/** @param {number} s */
const allow = (s, slice = "p", type = "implementer") => ({ ts: at(s), session_id: "s1", decision: "allow", reason: "ok", slice, agent_type: type });
const W = { sessionId: "s1", now: T0 + 600_000, staleMs: 30 * 60_000, pendingMs: 120_000 };

test("waveLoad: running implementers are starts with no later stop; stale starts and other roles do not count", () => {
  const telemetry = [
    tele("a", 0), // running
    tele("b", 10), tele("b", 20, "SubagentStop"), // done
    tele("c", 30), tele("c", 40, "SubagentStop"), tele("c", 50), // resumed: running again
    tele("d", -1900), // started 41 minutes before now, no stop: stale
    tele("r", 60, "SubagentStart", "reviewer"), // not an implementer
    tele("e", 70, "SubagentStart", "orchestration:implementer"),
  ];
  assert.deepEqual(waveLoad({ ...W, telemetry, allows: [] }), { running: 3, pending: 0 });
});

test("waveLoad: an allowed launch with no start after it is on its way, inside the pending window only", () => {
  const telemetry = [tele("a", 500)]; // a's start, after the first allow
  const allows = [allow(490), allow(560), allow(570), allow(400, "old"), { ...allow(565), decision: "block" }, allow(575, "r", "reviewer")];
  // 490 is matched by a's start; 560 and 570 have none; 400 is older than the 120 s window before now (600).
  assert.deepEqual(waveLoad({ ...W, telemetry, allows }), { running: 1, pending: 2 });
  // A resume (a later start of the same agent) is not a new launch's start.
  const resumed = [tele("a", 500), tele("a", 520, "SubagentStop"), tele("a", 580)];
  assert.deepEqual(waveLoad({ ...W, telemetry: resumed, allows: [allow(490), allow(560)] }), { running: 1, pending: 1 });
});

// ---------------------------------------------------------------- the hook, run as Claude Code runs it

const HOOKS = ["state.mjs", "brief.mjs", "run.mjs", "plan-check.mjs", "builtin-agents.mjs", "journal.mjs", "limits.mjs"];
/** A throwaway project with the plan check and its modules; the plan review finished (legacy record) in session s1. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), "plan-wave-"));
  const hooks = join(dir, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of HOOKS) copyFileSync(join(root, ".claude", "hooks", h), join(hooks, h));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  append(dir, "journal.jsonl", { ts: "t", session_id: "s1", slice: "plan", role: "reviewer", status: "pass", agent_id: "r0" });
  return dir;
}
/** @param {string} dir @param {string} name @param {Record<string, unknown>} rec */
function append(dir, name, rec) {
  writeFileSync(join(dir, ".claude", "state", name), `${JSON.stringify(rec)}\n`, { flag: "a" });
}
/** Running implementers: a start `ago` seconds before now and no stop. @param {string} dir @param {number} n */
function running(dir, n, ago = 60, prefix = "i") {
  for (let i = 0; i < n; i++) append(dir, "telemetry.jsonl", { ts: new Date(Date.now() - ago * 1000).toISOString(), session_id: "s1", hook_event_name: "SubagentStart", agent_id: `${prefix}${i}`, agent_type: "implementer" });
}
/** The environment without the person's switches, plus `extra`. @param {string} dir @param {Record<string, string>} [extra] */
function envWith(dir, extra = {}) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(ORCH_|CLAUDE_PLUGIN_|CLAUDE_ASYNC_AGENT_STALL|NODE_OPTIONS$|NODE_TEST)/.test(k)) env[k] = v;
  return { ...env, CLAUDE_PROJECT_DIR: dir, ORCH_SKILL_HINTS: "off", ...extra };
}
/** @param {string} slice @param {Record<string, unknown>} [more] */
const input = (slice, more = {}, type = "implementer", prompt = `SLICE: ${slice}\nFILES: ${slice}.txt\nDEPENDS: none`) => ({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: type, prompt, ...more } });
/** @param {string} dir @param {unknown} payload @param {Record<string, string>} [env] */
const check = (dir, payload, env = {}) => spawnSync(process.execPath, [join(dir, ".claude", "hooks", "plan-check.mjs")], { input: JSON.stringify(payload), env: envWith(dir, env), encoding: "utf8" });
/** @param {string} dir */
const records = (dir) => readFileSync(join(dir, ".claude", "state", "plan-check.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const last = (/** @type {string} */ dir) => records(dir).at(-1);

test("below the cap a launch is allowed; at the cap it is blocked with wave_full, twice, then let through as wave_full_gave_up", () => {
  const dir = project();
  try {
    running(dir, 3);
    const ok = check(dir, input("a"));
    assert.equal(ok.status, 0, ok.stderr);
    assert.deepEqual([last(dir).reason, last(dir).wave?.running, last(dir).wave?.pending, last(dir).wave?.cap], ["ok", 3, 0, 4]);
    // a's launch is now on its way (allowed, not started): 3 running + 1 pending is the cap of 4.
    for (let i = 0; i < 2; i++) {
      const r = check(dir, input("b"));
      assert.equal(r.status, 2, "blocked at the cap");
      assert.match(r.stderr, /^Plan check:/);
      assert.match(r.stderr, /\bwave_full\b/);
      assert.match(r.stderr, /[Ww]ait for a running implementer's report/);
      assert.match(r.stderr, /launch .*again/);
      assert.doesNotMatch(r.stderr, /ORCH_|CLAUDE_PLUGIN_OPTION/);
      assert.deepEqual([last(dir).decision, last(dir).reason, last(dir).slice], ["block", "wave_full", "b"]);
    }
    const third = check(dir, input("b"));
    assert.equal(third.status, 0, "the third attempt of the slice passes");
    assert.equal(last(dir).reason, "wave_full_gave_up");
    assert.ok(last(dir).gave_up.includes("wave_full_gave_up"));
    // Another slice has its own two blocks.
    assert.equal(check(dir, input("c")).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an isolated launch's cap narrows by the latest suite_s on record; with none on record it does not", () => {
  const dir = project();
  try {
    running(dir, 3);
    // No suite_s yet: an isolated launch keeps the cap of 4.
    const plain = check(dir, input("a", { isolation: "worktree" }));
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal(last(dir).wave?.cap, 4);
    const dir2 = project();
    try {
      running(dir2, 2);
      append(dir2, "gates.jsonl", { ts: new Date().toISOString(), gate: "test", decision: "allow", reason: "tests_passed", session_id: "older", agent_id: "x", suite_s: 100 });
      append(dir2, "gates.jsonl", { ts: new Date().toISOString(), gate: "test", decision: "allow", reason: "tests_passed", session_id: "other", agent_id: "y", suite_s: 300 });
      // 1 + floor((540 - 120) / 300) = 2, and 2 run: an isolated launch is full, one in the shared tree is not.
      const iso = check(dir2, input("a", { isolation: "worktree" }));
      assert.equal(iso.status, 2, iso.stderr);
      assert.match(iso.stderr, /\bwave_full\b/);
      assert.match(iso.stderr, /300 s/, "the message says why the cap is lower");
      assert.deepEqual([last(dir2).wave?.cap, last(dir2).wave?.suite_s], [2, 300]);
      const shared = check(dir2, input("b"));
      assert.equal(shared.status, 0, shared.stderr);
      assert.equal(last(dir2).wave?.cap, 4);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a log that cannot be read never blocks with wave_full", () => {
  for (const name of ["telemetry.jsonl", "plan-check.jsonl"]) {
    const dir = project();
    try {
      // Eight implementers on their way, but one of the logs that count them is a folder.
      for (let i = 0; i < 8; i++) append(dir, "plan-check.jsonl", { ts: new Date().toISOString(), session_id: "s1", decision: "allow", reason: "ok", slice: `p${i}`, files: [], depends: [], agent_type: "implementer", run: "none-0" });
      assert.equal(check(dir, input("x")).status, 2, "control: blocked while both logs read");
      const p = join(dir, ".claude", "state", name);
      rmSync(p, { force: true });
      mkdirSync(p);
      if (name === "telemetry.jsonl") {
        const r = check(dir, input("y"));
        assert.equal(r.status, 0, `${name} unreadable: ${r.stderr}`);
        assert.equal(last(dir).wave?.skipped, "log_unreadable");
      } else {
        assert.equal(check(dir, input("y")).status, 0, `${name} unreadable`);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("a start older than the run-stale window with no stop is not counted", () => {
  const dir = project();
  try {
    running(dir, 4, 31 * 60, "old"); // 31 minutes ago, past the default 30
    const r = check(dir, input("a"));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(last(dir).wave?.running, 0);
    running(dir, 4, 60, "new");
    assert.equal(check(dir, input("b")).status, 2, "fresh starts count");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("implementers launched at the same moment as separate processes never pass the cap together", async () => {
  const dir = project();
  try {
    const one = (/** @type {string} */ slice) =>
      new Promise((done) => {
        const p = spawn(process.execPath, [join(dir, ".claude", "hooks", "plan-check.mjs")], { env: envWith(dir, { ORCH_WAVE_MAX: "2" }) });
        let err = "";
        p.stderr.on("data", (d) => (err += d));
        p.on("close", (code) => done({ code, err }));
        p.stdin.end(JSON.stringify(input(slice)));
      });
    const res = /** @type {{ code: number, err: string }[]} */ (await Promise.all(["a", "b", "c", "d", "e", "f"].map(one)));
    assert.equal(res.filter((r) => r.code === 0).length, 2, `exactly two pass: ${res.map((r) => r.code)}`);
    for (const r of res.filter((x) => x.code !== 0)) {
      assert.equal(r.code, 2);
      assert.match(r.err, /\bwave_full\b/);
    }
    assert.equal(existsSync(join(dir, ".claude", "state", "plan-check-wave.lock")), false, "the wave lock is released");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The test above would pass without the wave lock: plan-check.lock (waited for 5 s at the hook's start) already runs
// those hooks one at a time. Here another holder keeps plan-check.lock for the whole round (its mtime refreshed, so it
// never goes stale): every hook's wait for it runs out (the hook then goes on without it, `locked` false, and never
// removes it), and only the wave lock stands between launches judged at the same moment.
test("with plan-check.lock held by someone else, the wave lock alone keeps simultaneous launches within the cap", async (t) => {
  const ROUNDS = 4; // a round in which load made a wave-lock wait run out proves nothing and is repeated
  const CAP = 2;
  const PLAN_WAIT_MS = 5000; // plan-check.mjs WAIT_MS: each hook waits at least this long for the held lock
  const foreign = "held by the test";
  /** @param {string} dir @param {string} slice */
  const one = (dir, slice) =>
    new Promise((done) => {
      const t0 = Date.now();
      const p = spawn(process.execPath, [join(dir, ".claude", "hooks", "plan-check.mjs")], { env: envWith(dir, { ORCH_WAVE_MAX: String(CAP) }) });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => done({ code, err, ms: Date.now() - t0 }));
      p.stdin.end(JSON.stringify(input(slice)));
    });
  const notes = [];
  for (let round = 1; round <= ROUNDS; round++) {
    const dir = project();
    const planLock = join(dir, ".claude", "state", "plan-check.lock");
    mkdirSync(planLock);
    writeFileSync(join(planLock, "owner"), foreign);
    const keep = setInterval(() => {
      try {
        const now = new Date();
        utimesSync(planLock, now, now);
      } catch {
        // gone: the round is judged void below
      }
    }, 250);
    try {
      const res = /** @type {{ code: number, err: string, ms: number }[]} */ (await Promise.all(["a", "b", "c", "d", "e", "f"].map((s) => one(dir, s))));
      clearInterval(keep);
      const recs = records(dir).filter((r) => r.wave);
      const ownerFile = join(planLock, "owner");
      const heldThroughout = existsSync(ownerFile) && readFileSync(ownerFile, "utf8") === foreign;
      const allTaken = recs.length === res.length && recs.every((r) => r.wave.lock === "taken");
      const passed = res.filter((r) => r.code === 0).length;
      for (const r of res.filter((x) => x.code !== 0)) {
        assert.equal(r.code, 2, r.err);
        assert.match(r.err, /\bwave_full\b/);
      }
      assert.equal(existsSync(join(dir, ".claude", "state", "plan-check-wave.lock")), false, "the wave lock is released");
      if (!heldThroughout || !allTaken) {
        notes.push(`round ${round}: ${!heldThroughout ? "plan-check.lock went stale under load" : `wave lock not taken on ${recs.filter((r) => r.wave.lock !== "taken").length} record(s)`}; repeated`);
        continue;
      }
      // Every hook waited out plan-check.lock (a lower bound on its run time, which load can only lengthen).
      for (const r of res) assert.ok(r.ms >= PLAN_WAIT_MS, `a hook ran ${r.ms} ms, less than its wait for the held plan-check.lock`);
      assert.ok(passed <= CAP, `round ${round}: ${passed} launches passed a cap of ${CAP} with every wave lock taken`);
      assert.equal(passed, CAP, `round ${round}: the cap's ${CAP} slots are filled`);
      return;
    } finally {
      clearInterval(keep);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  t.skip(`no round had every wave lock taken under this load: ${notes.join("; ")}`);
});

test("a stale wave lock is taken over: the launch is judged with the lock taken, and the lock is gone afterwards", () => {
  const dir = project();
  try {
    const lock = join(dir, ".claude", "state", "plan-check-wave.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "a launch that died");
    const old = new Date(Date.now() - 60_000); // past plan-check.mjs WAVE_LOCK_STALE_MS (10 s), set, not waited for
    utimesSync(lock, old, old);
    running(dir, 1);
    const r = check(dir, input("a"));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([last(dir).reason, last(dir).wave?.lock], ["ok", "taken"]);
    assert.equal(existsSync(lock), false, "the taken-over lock is released after the record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the wave lock is released after a wave_full block", () => {
  const dir = project();
  try {
    running(dir, 4);
    const r = check(dir, input("a"));
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /\bwave_full\b/);
    assert.deepEqual([last(dir).decision, last(dir).reason, last(dir).wave?.lock], ["block", "wave_full", "taken"]);
    assert.equal(existsSync(join(dir, ".claude", "state", "plan-check-wave.lock")), false, "released after the block's record");
    assert.equal(check(dir, input("b")).status, 2, "the next launch takes the lock again and is judged");
    assert.equal(last(dir).wave?.lock, "taken");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a wave lock that cannot be taken never blocks: the launch is judged without it and the record says so", () => {
  const dir = project();
  try {
    const lock = join(dir, ".claude", "state", "plan-check-wave.lock");
    mkdirSync(lock);
    writeFileSync(join(lock, "owner"), "someone else");
    running(dir, 1);
    const r = check(dir, input("a"));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(last(dir).wave?.lock, "not_taken");
    assert.equal(existsSync(join(lock, "owner")), true, "another holder's lock is left alone");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the maintainer switch is honoured from 1 to 8 and ignored outside that range", () => {
  const dir = project();
  try {
    running(dir, 5);
    assert.equal(check(dir, input("a"), { ORCH_WAVE_MAX: "8" }).status, 0, "8 allows a sixth");
    assert.equal(last(dir).wave?.cap, 8);
    for (const bad of ["9", "0", "x", "3.5"]) {
      const r = check(dir, input(`b${bad.replace(/\W/g, "")}`), { ORCH_WAVE_MAX: bad });
      assert.equal(r.status, 2, `ORCH_WAVE_MAX=${bad} counts as unset (cap 4)`);
      assert.equal(last(dir).wave?.cap, 4);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const one = project();
  try {
    running(one, 1);
    const r = check(one, input("a"), { ORCH_WAVE_MAX: "1" });
    assert.equal(r.status, 2, "1: one at a time");
    assert.equal(last(one).wave?.cap, 1);
  } finally {
    rmSync(one, { recursive: true, force: true });
  }
});

test("a researcher, reviewer or integrator launch is never blocked with wave_full, and writes no wave record", () => {
  const dir = project();
  try {
    running(dir, 8);
    for (const type of ["researcher", "orchestration:researcher", "reviewer", "orchestration:reviewer", "integrator", "orchestration:integrator"]) {
      const r = check(dir, input("a", {}, type, "SLICE: a\nReview it."), { ORCH_WAVE_MAX: "1" });
      assert.equal(r.status, 0, `${type}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /wave_full/);
    }
    assert.equal(existsSync(join(dir, ".claude", "state", "plan-check.jsonl")), false, "no plan-check record for them");
    // The plugin's implementer is held like the project's.
    assert.equal(check(dir, input("a", {}, "orchestration:implementer")).status, 2);
    assert.equal(last(dir).reason, "wave_full");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a launch refused for another reason takes no slot, and a copy of the hooks without limits.mjs judges no wave", () => {
  const dir = project();
  try {
    running(dir, 3);
    // A brief without SLICE is refused before the wave is judged: no wave record, no slot.
    assert.equal(check(dir, input("a", {}, "implementer", "Goal: do it")).status, 2);
    assert.equal(last(dir).reason, "missing_lines");
    assert.equal(last(dir).wave, undefined);
    assert.equal(check(dir, input("b")).status, 0, "the fourth slot is still free");
    rmSync(join(dir, ".claude", "hooks", "limits.mjs"));
    const r = check(dir, input("c"));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(last(dir).reason, "ok");
    assert.equal(last(dir).wave, undefined, "no wave judged: the record is as it was before the wave cap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- C1: a slow git is not a missing skills repository

test("a git that runs out of time is not read as a missing skills repository; a repository that is not set up still blocks", () => {
  const base = mkdtempSync(join(tmpdir(), "plan-slow-git-"));
  try {
    const dir = join(base, "project");
    mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
    for (const h of HOOKS) copyFileSync(join(root, ".claude", "hooks", h), join(dir, ".claude", "hooks", h));
    mkdirSync(join(dir, ".claude", "state"), { recursive: true });
    writeFileSync(join(dir, ".claude", "state", "journal.jsonl"), `${JSON.stringify({ ts: "t", session_id: "s1", slice: "plan", role: "reviewer", status: "pass", agent_id: "r0" })}\n`);
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid", GIT_CONFIG_NOSYSTEM: "1", HOME: base };
    /** A skills folder with scripts/validate.py; a git work tree when `init`. @param {string} name @param {boolean} init */
    const repo = (name, init) => {
      const r = join(base, name);
      mkdirSync(join(r, "scripts"), { recursive: true });
      writeFileSync(join(r, "scripts", "validate.py"), "print('ok')\n");
      writeFileSync(join(r, "README.md"), "# Skills\n");
      if (init) for (const args of [["init", "-q", "-b", "main"], ["add", "-A"], ["commit", "-q", "-m", "init"]]) assert.equal(spawnSync("git", ["-C", r, ...args], { env: gitEnv }).status, 0);
      return r;
    };
    const good = repo("skills-ok", true);
    const plain = repo("skills-plain", false);
    // A fake git first on PATH: the work-tree question hangs (longer than the hook gives one git call); the rest is git.
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const bin = join(base, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do case "$a" in --is-inside-work-tree) case "$*" in *${good}*) exec sleep 40 ;; esac ;; esac; done\nexec '${realGit}' "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    /** @param {string} skillsRepo @param {string} name */
    const run = (skillsRepo, name) => {
      /** @type {Record<string, string>} */
      const env = {};
      for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(ORCH_|CLAUDE_PLUGIN_|GIT_|NODE_OPTIONS$|NODE_TEST)/.test(k)) env[k] = v;
      Object.assign(env, { HOME: base, PATH: `${bin}:${process.env.PATH ?? ""}`, CLAUDE_PROJECT_DIR: dir, CLAUDE_CONFIG_DIR: join(base, "config"), ORCH_SKILL_HINTS: "off", ORCH_SKILLS_REPO_PRIVATE: skillsRepo });
      const prompt = `SLICE: ${name}-slice\nFILES: skills/${name}/, README.md\nDEPENDS: none\nKIND: skill\nSKILL: ${name}\n\nWrite the skill.`;
      return spawnSync(process.execPath, [join(dir, ".claude", "hooks", "plan-check.mjs")], { input: JSON.stringify({ session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "implementer", prompt } }), env, encoding: "utf8", timeout: 60_000 });
    };
    const created = () => readFileSync(join(dir, ".claude", "state", "skill-create.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const t0 = Date.now();
    const slow = run(good, "slow-git");
    const took = Date.now() - t0;
    assert.equal(slow.status, 0, `a slow git is not a missing repository: ${slow.stderr}`);
    assert.doesNotMatch(slow.stderr, /not set up/);
    assert.deepEqual([created().at(-1)?.decision, created().at(-1)?.repo_check], ["allow", "git_timeout"]);
    assert.ok(took < 45_000, `well inside the hook's 60 s timeout: ${took} ms`);
    // Not a git work tree (git answers at once): still skill_repo_missing.
    const missing = run(plain, "plain-folder");
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /not set up on this machine/);
    assert.equal(created().at(-1)?.reason, "skill_repo_missing");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
