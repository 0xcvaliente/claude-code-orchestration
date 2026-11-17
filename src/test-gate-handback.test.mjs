// Test gate 2.0.0: the hand-back mode of verify.sh (PreToolUse on SubagentHandback), its one-use result cache
// (.claude/hooks/test-gate-cache.mjs) and the after_handback link that ties a stop's test-gate record to its stop
// (state.mjs latestHandbackId, run.mjs stopGateOf). Real temporary git repos, as in test-gate-v2.test.mjs. Every test
// command counts its runs in a file outside the repo, so the count never changes the tree. A result is stored only when
// no entry of the trees changed within the recent-change guard before the run, so each repo is left to settle that long
// after it is made. The cases run side by side (each in repos of its own, every hook run a child process the event loop
// waits on), and verify.sh gets its test argument --recent-ms=<GUARD_MS>, so a repo settles in GUARD_MS instead of the
// production guard (RECENT_MS, 2000 ms, unchanged); the case of a recent change uses a longer guard, so that a loaded
// machine cannot make its change look old.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { implementerTestStates, stopGateOf, testBlocked } from "../.claude/hooks/run.mjs";
import { latestHandbackId } from "../.claude/hooks/state.mjs";
import {
  CACHE_FILE,
  MAX_ENTRIES,
  RECENT_MS,
  REUSE_MAX_S,
  cachePut,
  cacheTake,
  cacheTakeWhy,
  listTrees,
  readCache,
  refusedHandbacks,
  scanRoots,
  storeVerdict,
  treeKey,
} from "../.claude/hooks/test-gate-cache.mjs";

const hook = (/** @type {string} */ name) => new URL(`../.claude/hooks/${name}`, import.meta.url).pathname;
const SWITCH = /ORCH_|CLAUDE_PLUGIN_OPTION|handback_gate|HANDBACK_GATE/;
/** The recent-change guard verify.sh gets in these tests (--recent-ms); the production default stays RECENT_MS. */
const GUARD_MS = 300;
/** Cases at once: the hook runs are child processes, so they overlap; the bound keeps a loaded machine responsive. */
const CONCURRENCY = 8;

/** @returns {Record<string, string>} */
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      /** @returns {e is [string, string]} */ (e) => e[1] !== undefined && !/^(GIT_|ORCH_|CLAUDE_PLUGIN_OPTION_|CLAUDE_ASYNC_AGENT_STALL)/.test(e[0]),
    ),
  );

/** @param {string} dir @param {...string} args */
function git(dir, ...args) {
  const r = spawnSync("git", ["-c", "user.name=orch", "-c", "user.email=orch@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env: cleanEnv(), encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** Wait without blocking the event loop. @param {number} [ms] */
const pause = (ms = GUARD_MS + 300) => new Promise((r) => setTimeout(r, ms));
/** Wait until every entry made so far is older than the guard `ms` (GUARD_MS by default). @param {number} [ms] */
const settle = (ms = GUARD_MS) => pause(ms + 300);

/**
 * A process run to its end without blocking the event loop.
 * @param {string} cmd @param {string[]} args @param {{ input?: string, env?: Record<string, string> }} [o]
 * @returns {Promise<{ status: number | null, stdout: string, stderr: string }>}
 */
function run(cmd, args, o = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { env: o.env ?? cleanEnv(), stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(o.input ?? "");
  });
}

/**
 * A committed repo, a counter file outside it, and a fixed TMPDIR; the state folder exists, as it does in a project
 * the hooks have run in. Settled unless `quick` (the caller makes more entries and settles itself).
 */
async function setup(files = { "a.js": "x\n", ".gitignore": "ignored/\nnode_modules/\n.claude/worktrees/\n" }, quick = false) {
  const base = mkdtempSync(join(tmpdir(), "orch-hb-"));
  const dir = join(base, "repo");
  mkdirSync(dir);
  git(dir, "init", "-q");
  for (const [p, body] of Object.entries(files)) writeFileSync(join(dir, p), body);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  const tmp = join(base, "tmp");
  mkdirSync(tmp);
  const counter = join(base, "runs.txt");
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  mkdirSync(join(dir, ".claude", "worktrees"), { recursive: true });
  writeFileSync(join(dir, ".claude", "state", ".gitignore"), "*\n");
  if (!quick) await settle();
  return { base, dir, tmp, counter };
}
/** A test command that counts its runs and passes when `pass` exists in `base`. @param {{ base: string, counter: string }} s */
const cmdOf = (s) => `echo run >> '${s.counter}'; echo 'not ok 1 - boom'; test -f '${s.base}/pass'`;
/** @param {{ counter: string }} s */
const runs = (s) => (existsSync(s.counter) ? readFileSync(s.counter, "utf8").split("\n").filter(Boolean).length : 0);
/** @param {string} dir */
const stateOf = (dir) => join(dir, ".claude", "state");
/** @param {string} dir @param {string} name @param {Record<string, unknown>} rec */
function append(dir, name, rec) {
  mkdirSync(stateOf(dir), { recursive: true });
  // As the hooks leave it: the state folder ignores itself (else the lock taken during a run changes the tree's key).
  if (!existsSync(join(stateOf(dir), ".gitignore"))) writeFileSync(join(stateOf(dir), ".gitignore"), "*\n");
  writeFileSync(join(stateOf(dir), name), `${JSON.stringify({ ts: new Date().toISOString(), session_id: "s1", ...rec })}\n`, { flag: "a" });
}

/**
 * verify.sh as a hook runs it. `handback` adds --handback and a SubagentHandback PreToolUse event.
 * @param {{ dir: string, tmp: string, base: string, counter: string }} s
 * @param {{ handback?: boolean, id?: string, type?: string, toolUseId?: string, env?: Record<string, string>, plugin?: boolean, cmd?: string, tool?: string, noCwd?: boolean, cwd?: string, recentMs?: number }} [o]
 */
async function gate(s, o = {}) {
  /** @type {Record<string, unknown>} */
  const event = { agent_type: o.type ?? "implementer", agent_id: o.id ?? "a1", session_id: "s1" };
  if (!o.noCwd) event.cwd = o.cwd ?? s.dir;
  if (o.handback) Object.assign(event, { hook_event_name: "PreToolUse", tool_name: o.tool ?? "SubagentHandback", tool_use_id: o.toolUseId ?? "toolu_1", tool_input: { message: "STATUS: pass\nOPEN: none" } });
  else event.hook_event_name = "SubagentStop";
  const args = [hook("verify.sh"), ...(o.plugin ? ["--plugin"] : []), ...(o.handback ? ["--handback"] : []), `--recent-ms=${o.recentMs ?? GUARD_MS}`];
  return run("bash", args, {
    input: JSON.stringify(event),
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: s.dir, TMPDIR: s.tmp, ORCH_TEST_CMD: o.cmd ?? cmdOf(s), CLAUDE_PLUGIN_DATA: join(s.base, "plugin-data"), ...o.env },
  });
}
/**
 * A hand-back as Claude Code runs it: handback-check.mjs's capture (handbacks.jsonl), then the gate.
 * @param {{ dir: string, tmp: string, base: string, counter: string }} s @param {string} id @param {Parameters<typeof gate>[1]} [o]
 */
function handBack(s, id, o = {}) {
  append(s.dir, "handbacks.jsonl", { agent_id: o?.id ?? "a1", agent_type: "implementer", tool_use_id: id, status: "pass" });
  return gate(s, { ...o, handback: true, toolUseId: id });
}
/** @param {string} dir @returns {any[]} */
const records = (dir) => {
  const p = join(stateOf(dir), "gates.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
/** @param {string} dir */
const lastRec = (dir) => records(dir).at(-1);
/** Make every stored result `sec` seconds older. @param {string} dir @param {number} sec */
function age(dir, sec) {
  const entries = readCache(stateOf(dir)).map((e) => ({ ...e, ts: new Date(Date.parse(e.ts) - sec * 1000).toISOString() }));
  writeFileSync(join(stateOf(dir), CACHE_FILE), `${JSON.stringify({ entries })}\n`);
}

/**
 * verify.sh without blocking the event loop, so that a file can be changed while a hand-back's suite runs. `during`
 * runs once the suite has started (the counter file grew).
 * @param {{ dir: string, tmp: string, base: string, counter: string }} s
 * @param {{ handback?: boolean, toolUseId?: string, cmd?: string, cwd?: string, during?: () => void }} [o]
 * @returns {Promise<number | null>}
 */
async function gateAsync(s, o = {}) {
  /** @type {Record<string, unknown>} */
  const event = { agent_type: "implementer", agent_id: "a1", session_id: "s1", cwd: o.cwd ?? s.dir };
  if (o.handback) {
    append(s.dir, "handbacks.jsonl", { agent_id: "a1", agent_type: "implementer", tool_use_id: o.toolUseId, status: "pass" });
    Object.assign(event, { hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_use_id: o.toolUseId, tool_input: { message: "STATUS: pass" } });
  } else event.hook_event_name = "SubagentStop";
  const before = runs(s);
  const child = spawn("bash", [hook("verify.sh"), ...(o.handback ? ["--handback"] : []), `--recent-ms=${GUARD_MS}`], {
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: s.dir, TMPDIR: s.tmp, ORCH_TEST_CMD: o.cmd ?? cmdOf(s) },
    stdio: ["pipe", "ignore", "ignore"],
  });
  const exit = new Promise((r) => child.on("exit", (c) => r(c)));
  child.stdin.end(JSON.stringify(event));
  if (o.during) {
    const deadline = Date.now() + 30000;
    while (runs(s) === before && Date.now() < deadline) await pause(50);
    await pause(200);
    o.during();
  }
  return /** @type {Promise<number | null>} */ (exit);
}

/** A linked worktree of `s` under .claude/worktrees. @param {{ dir: string }} s */
function worktree(s) {
  const wt = join(s.dir, ".claude", "worktrees", "w1");
  git(s.dir, "worktree", "add", "-q", "-b", "w1", wt);
  return wt;
}

/** The four ways another process changes a git-ignored input. @type {Record<string, (d: string) => void>} */
const CHANGES = {
  "changed in place": (d) => writeFileSync(join(d, "in.txt"), "no\n"),
  "replaced by rename": (d) => {
    writeFileSync(join(d, ".in.txt.new"), "no\n");
    renameSync(join(d, ".in.txt.new"), join(d, "in.txt"));
  },
  deleted: (d) => unlinkSync(join(d, "in.txt")),
  added: (d) => writeFileSync(join(d, "extra.txt"), "1\n"),
};

describe("test gate at the hand-back", { concurrency: CONCURRENCY }, () => {
  test("failing tests refuse the hand-back with the stop gate's message, log a block and mark the refusal", async () => {
    const s = await setup();
    try {
      const r = await handBack(s, "toolu_A");
      assert.equal(r.status, 2, "refused");
      assert.equal(r.stdout, "", "no allow or other decision printed (deny-only)");
      assert.match(r.stderr, /^Acceptance gate failed: /);
      assert.match(r.stderr, /not ok 1 - boom/);
      assert.match(r.stderr, /Fix the root cause, rerun the failing tests, then send your report again/);
      assert.doesNotMatch(r.stderr, SWITCH, "the refusal names no switch");
      const rec = lastRec(s.dir);
      assert.deepEqual([rec.decision, rec.reason, rec.at, rec.handback_id], ["block", "tests_failed", "handback", "toolu_A"]);
      assert.match(rec.tree, /^[0-9a-f]{16}$/);
      const refusals = readFileSync(join(stateOf(s.dir), "handback-refusals.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.deepEqual(refusals.map((x) => [x.agent_id, x.gate, x.tool_use_id]), [["a1", "test", "toolu_A"]]);
      assert.equal(runs(s), 1);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("a third refusal never happens: after two the report goes through with the give-up, and the stop reuses that fail", async () => {
    const s = await setup();
    try {
      const statuses = [];
      for (const n of [1, 2, 3]) statuses.push((await handBack(s, `toolu_${n}`)).status);
      assert.deepEqual(statuses, [2, 2, 0]);
      assert.deepEqual(records(s.dir).map((x) => [x.decision, x.reason]), [["block", "tests_failed"], ["block", "tests_failed"], ["allow", "max_blocks_reached"]]);
      assert.equal(runs(s), 3, "a hand-back never reuses a result: each ran the suite");
      const stop = await gate(s);
      assert.equal(stop.status, 0, "the SubagentStop gate's cap counts the hand-back blocks");
      const rec = lastRec(s.dir);
      assert.deepEqual([rec.reason, rec.reused, rec.reused_from, rec.after_handback], ["max_blocks_reached", "fail", "toolu_3", "toolu_3"]);
      assert.equal(runs(s), 3);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("passing tests let the report through and write the result; the stop reuses it once and logs the reuse", async () => {
    const s = await setup();
    try {
      writeFileSync(join(s.base, "pass"), "");
      const r = await handBack(s, "toolu_P");
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
      assert.deepEqual([lastRec(s.dir).decision, lastRec(s.dir).reason, lastRec(s.dir).at], ["allow", "tests_passed", "handback"]);
      const entries = readCache(stateOf(s.dir));
      assert.deepEqual([entries.length, entries[0]?.result, entries[0]?.by, entries[0]?.agent_id], [1, "pass", "toolu_P", "a1"]);
      assert.equal((await gate(s)).status, 0);
      const rec = lastRec(s.dir);
      assert.deepEqual([rec.reason, rec.reused, rec.reused_from, rec.after_handback], ["tests_passed_cached", "pass", "toolu_P", "toolu_P"]);
      assert.equal(runs(s), 1, "the suite did not run twice for one unchanged tree");
      assert.equal(readCache(stateOf(s.dir))[0]?.used, true);
      // A second stop of the same agent (no new hand-back) never reuses the same record again.
      assert.equal((await gate(s)).status, 0);
      assert.deepEqual([lastRec(s.dir).reason, lastRec(s.dir).reused], ["tests_passed", undefined]);
      assert.equal(runs(s), 2);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("the stop runs the suite when a tracked file, a staged change or an untracked file changed, or the command differs", async () => {
    const s = await setup();
    try {
      writeFileSync(join(s.base, "pass"), "");
      let n = 0;
      /** @param {string} what @param {() => void} change @param {string} [cmd] */
      const check = async (what, change, cmd) => {
        n += 1;
        assert.equal((await handBack(s, `toolu_c${n}`)).status, 0);
        const before = runs(s);
        change();
        assert.equal((await gate(s, cmd ? { cmd } : {})).status, 0);
        assert.equal(runs(s), before + 1, `${what}: the suite ran again`);
        assert.deepEqual([lastRec(s.dir).reason, lastRec(s.dir).reused], ["tests_passed", undefined], what);
      };
      await check("tracked file", () => writeFileSync(join(s.dir, "a.js"), "y\n"));
      await check("staged change", () => {
        writeFileSync(join(s.dir, "a.js"), "z\n");
        git(s.dir, "add", "a.js");
      });
      await check("untracked file", () => writeFileSync(join(s.dir, "new.js"), "n\n"));
      await check("untracked content", () => writeFileSync(join(s.dir, "new.js"), "changed\n"));
      await check("test command", () => {}, `${cmdOf(s)} && true`);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("the reviewer's cases: an ignored input and an untracked symlink's target changed across a long gap run the suite", async () => {
    const s = await setup();
    try {
      const outside = join(s.base, "outside.txt");
      writeFileSync(outside, "ok\n");
      mkdirSync(join(s.dir, "ignored"));
      writeFileSync(join(s.dir, "ignored", "in.txt"), "ok\n");
      symlinkSync(outside, join(s.dir, "link.txt"));
      const cmd = `echo run >> '${s.counter}'; grep -q ok ignored/in.txt && grep -q ok link.txt`;
      for (const [what, change] of /** @type {[string, () => void][]} */ ([
        ["ignored file", () => writeFileSync(join(s.dir, "ignored", "in.txt"), "bad\n")],
        ["symlink target", () => writeFileSync(outside, "bad\n")],
      ])) {
        writeFileSync(join(s.dir, "ignored", "in.txt"), "ok\n");
        writeFileSync(outside, "ok\n");
        assert.equal((await handBack(s, `toolu_${what.replace(/ /g, "_")}`, { cmd })).status, 0, what);
        change();
        age(s.dir, REUSE_MAX_S + 1);
        const before = runs(s);
        assert.equal((await gate(s, { cmd })).status, 2, `${what}: the stop ran the suite and blocks`);
        assert.equal(runs(s), before + 1);
        assert.equal(lastRec(s.dir).reused, undefined);
      }
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  // 2.0.0, second review: inside the age limit too, a change since the hand-back's run began means the suite runs.
  test("the reviewer's reproduction: an ignored input changed after the run ended, within seconds, runs the suite and blocks", async () => {
    const s = await setup(undefined, true);
    try {
      mkdirSync(join(s.dir, "ignored"));
      writeFileSync(join(s.dir, "ignored", "in.txt"), "ok\n");
      const cmd = `echo run >> '${s.counter}'; grep -q ok ignored/in.txt`;
      await settle();
      assert.equal((await handBack(s, "toolu_R", { cmd })).status, 0);
      assert.equal(readCache(stateOf(s.dir)).length, 1, "the pass was stored");
      writeFileSync(join(s.dir, "ignored", "in.txt"), "bad\n");
      const stop = await gate(s, { cmd });
      assert.equal(stop.status, 2, "the stop ran the suite and blocks");
      assert.deepEqual([lastRec(s.dir).reason, lastRec(s.dir).reused, runs(s)], ["tests_failed", undefined, 2]);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("a symlink to a target outside the trees means no record at all, so the stop runs the suite", async () => {
    const s = await setup(undefined, true);
    try {
      const outside = join(s.base, "outside.txt");
      writeFileSync(outside, "ok\n");
      symlinkSync(outside, join(s.dir, "link.txt"));
      const cmd = `echo run >> '${s.counter}'; grep -q ok link.txt`;
      await settle();
      assert.equal((await handBack(s, "toolu_O", { cmd })).status, 0);
      assert.equal(readCache(stateOf(s.dir)).length, 0, "an outside target: nothing stored");
      writeFileSync(outside, "bad\n");
      assert.equal((await gate(s, { cmd })).status, 2);
      assert.equal(runs(s), 2);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("a suite that writes into the trees gets no reuse: nothing is stored, logged with its reason, and the stop runs it", async () => {
    const s = await setup();
    try {
      const writes = `echo run >> '${s.counter}'; mkdir -p ignored/out; date +%N > ignored/out/report.txt`;
      assert.equal((await handBack(s, "toolu_W1", { cmd: writes })).status, 0);
      assert.deepEqual([lastRec(s.dir).reason, lastRec(s.dir).store], ["tests_passed", "tree_changed"]);
      assert.equal(readCache(stateOf(s.dir)).length, 0);
      assert.equal((await gate(s, { cmd: writes })).status, 0);
      assert.deepEqual([lastRec(s.dir).reason, lastRec(s.dir).reused, lastRec(s.dir).reuse, runs(s)], ["tests_passed", undefined, "no_entry", 2]);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("a linked worktree: a change in the main checkout after the run means no reuse; none means reuse", async () => {
    const s = await setup(undefined, true);
    try {
      const wt = join(s.dir, ".claude", "worktrees", "w1");
      git(s.dir, "worktree", "add", "-q", "-b", "w1", wt);
      mkdirSync(join(s.dir, "ignored"));
      writeFileSync(join(s.dir, "ignored", "dep.js"), "1\n");
      await settle();
      writeFileSync(join(s.base, "pass"), "");
      assert.equal((await handBack(s, "toolu_M1", { cwd: wt })).status, 0);
      assert.equal((await gate(s, { cwd: wt })).status, 0);
      assert.deepEqual([lastRec(s.dir).reason, lastRec(s.dir).reused], ["tests_passed_cached", "pass"]);
      assert.equal((await handBack(s, "toolu_M2", { cwd: wt })).status, 0);
      writeFileSync(join(s.dir, "ignored", "dep.js"), "2\n"); // node_modules-like, in the main checkout
      const before = runs(s);
      assert.equal((await gate(s, { cwd: wt })).status, 0);
      assert.deepEqual([lastRec(s.dir).reused, runs(s)], [undefined, before + 1]);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("a timed-out hand-back run is taken by the stop as a timed-out block, never a pass, and not run again", async () => {
    const s = await setup();
    try {
      const slow = `echo run >> '${s.counter}'; sleep 30`;
      // Budget 36 s: the hand-back's run gets 6 s (30 s kept for the key and the scan), then times out.
      assert.equal((await handBack(s, "toolu_T2", { cmd: slow, env: { ORCH_HOOK_BUDGET_S: "36" } })).status, 0);
      assert.equal(lastRec(s.dir).reason, "handback_timed_out");
      assert.equal(readCache(stateOf(s.dir))[0]?.result, "timeout");
      // The same environment as the hand-back (every ORCH_ variable is part of the key).
      const stop = await gate(s, { cmd: slow, env: { ORCH_HOOK_BUDGET_S: "36" } });
      assert.equal(stop.status, 2);
      const rec = lastRec(s.dir);
      assert.deepEqual([rec.decision, rec.reason, rec.reused, rec.timed_out], ["block", "tests_failed", "timeout", 1]);
      assert.match(stop.stderr, /did not finish within/);
      assert.equal(runs(s), 1, "the suite was not started a second time");
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("a lock-wait give-up at the hand-back: the stop does not wait for the lock again", async () => {
    const s = await setup();
    try {
      writeFileSync(join(s.base, "pass"), "");
      assert.equal((await handBack(s, "toolu_LW")).status, 0);
      // Turn the stored outcome into a lock-wait give-up of that hand-back, then hold the lock with a live process.
      const entries = readCache(stateOf(s.dir)).map((e) => ({ ...e, result: "lock_wait" }));
      writeFileSync(join(stateOf(s.dir), CACHE_FILE), `${JSON.stringify({ entries })}\n`);
      writeFileSync(join(stateOf(s.dir), "test-gate.lock"), `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
      const t = Date.now();
      assert.equal((await gate(s)).status, 0);
      assert.ok(Date.now() - t < 30000, "no second wait for the lock");
      assert.deepEqual([lastRec(s.dir).reason, lastRec(s.dir).reused, runs(s)], ["tests_passed", "lock_wait", 2]);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("no time left for the scan at the stop: the suite runs", async () => {
    const s = await setup();
    try {
      writeFileSync(join(s.base, "pass"), "");
      assert.equal((await handBack(s, "toolu_NT")).status, 0);
      assert.equal((await gate(s, { env: { ORCH_HOOK_BUDGET_S: "10" } })).status, 0);
      assert.deepEqual([lastRec(s.dir).reused, runs(s)], [undefined, 2]);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("no reuse for another agent, after a later start of the agent, or for an expired result", async () => {
    const s = await setup();
    try {
      writeFileSync(join(s.base, "pass"), "");
      // Another agent in the same tree: its own (or no) hand-back, never a1's result.
      assert.equal((await handBack(s, "toolu_X")).status, 0);
      assert.equal((await gate(s, { id: "a2" })).status, 0);
      assert.deepEqual([lastRec(s.dir).agent_id, lastRec(s.dir).reused, runs(s)], ["a2", undefined, 2]);
      append(s.dir, "handbacks.jsonl", { agent_id: "a2", tool_use_id: "toolu_X" }); // the same id, another agent
      assert.equal((await gate(s, { id: "a2" })).status, 0);
      assert.equal(lastRec(s.dir).reused, undefined);
      // A later start of a1 (a resume): its stop follows no hand-back since, so nothing is reused.
      append(s.dir, "telemetry.jsonl", { agent_id: "a1", agent_type: "implementer", hook_event_name: "SubagentStart" });
      assert.equal(latestHandbackId("s1", "a1", stateOf(s.dir)), null);
      assert.equal((await gate(s)).status, 0);
      assert.deepEqual([lastRec(s.dir).reused, lastRec(s.dir).after_handback], [undefined, undefined]);
      // Expired.
      assert.equal((await handBack(s, "toolu_E")).status, 0);
      age(s.dir, REUSE_MAX_S + 1);
      const before = runs(s);
      assert.equal((await gate(s)).status, 0);
      assert.deepEqual([lastRec(s.dir).reused, runs(s)], [undefined, before + 1]);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("a cached block is never reused as a pass, and nothing is stored for a tree that changed during the run", async () => {
    const [s, s2] = await Promise.all([setup(), setup()]);
    try {
      assert.equal((await handBack(s, "toolu_1")).status, 2);
      // The worker resends with the same tree, the test would now pass, but the hand-back runs it (no reuse there).
      writeFileSync(join(s.base, "pass"), "");
      assert.equal((await handBack(s, "toolu_2")).status, 0);
      const key = readCache(stateOf(s.dir)).find((e) => e.by === "toolu_1")?.key ?? "";
      const q = { key, session: "s1", agent: "a1", handback: "toolu_1", roots: scanRoots(s.dir), exclude: [stateOf(s.dir)] };
      assert.equal(cacheTake(stateOf(s.dir), q)?.result, "fail", "a fail stays a fail");
      rmSync(join(s.base, "pass"));
      assert.equal((await handBack(s2, "toolu_D", { cmd: `echo run >> '${s2.counter}'; date +%N > during.txt` })).status, 0);
      assert.equal(readCache(stateOf(s2.dir)).length, 0, "the key after the run differs: no entry");
    } finally {
      rmSync(s2.base, { recursive: true, force: true });
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("a hand-back gate that times out, cannot get the lock, has no cwd, or has no time left for a key lets the report through, logged", async () => {
    const [s, s2] = await Promise.all([setup(), setup()]);
    try {
      const timedOut = (async () => {
        const slow = `echo run >> '${s.counter}'; if test -f '${s.base}/slow'; then sleep 30; fi; exit 1`;
        writeFileSync(join(s.base, "slow"), "");
        assert.equal((await handBack(s, "toolu_T", { cmd: slow, env: { ORCH_HOOK_BUDGET_S: "3" } })).status, 0);
        assert.deepEqual([lastRec(s.dir).decision, lastRec(s.dir).reason], ["allow", "handback_timed_out"]);
        assert.equal(readCache(stateOf(s.dir)).length, 0, "a 3 s budget leaves no time for a key: nothing stored");
        rmSync(join(s.base, "slow"));
        assert.equal((await gate(s, { cmd: slow })).status, 2, "the SubagentStop gate runs the suite and blocks");
        assert.equal(lastRec(s.dir).reused, undefined);
        assert.equal((await gate(s, { handback: true, noCwd: true, toolUseId: "toolu_N" })).status, 0);
        assert.equal(lastRec(s.dir).reason, "handback_no_cwd");
      })();
      const lockWait = (async () => {
        mkdirSync(stateOf(s2.dir), { recursive: true });
        writeFileSync(join(stateOf(s2.dir), "test-gate.lock"), `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
        assert.equal((await handBack(s2, "toolu_L", { env: { ORCH_HOOK_BUDGET_S: "4" } })).status, 0);
        assert.deepEqual([lastRec(s2.dir).reason, lastRec(s2.dir).not_run], ["handback_lock_wait", 1]);
        assert.equal(runs(s2), 0);
      })();
      const settled = await Promise.allSettled([timedOut, lockWait]);
      for (const r of settled) if (r.status === "rejected") throw r.reason;
    } finally {
      rmSync(s2.base, { recursive: true, force: true });
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("a hand-back gate killed by Claude Code's timeout (SIGTERM) lets the report through and logs handback_gate_error", async () => {
    const s = await setup();
    try {
      const event = { hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_use_id: "toolu_K", agent_type: "implementer", agent_id: "a1", session_id: "s1", cwd: s.dir };
      const child = spawn("bash", [hook("verify.sh"), "--handback"], {
        env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: s.dir, TMPDIR: s.tmp, ORCH_TEST_CMD: `echo run >> '${s.counter}'; sleep 60` },
        stdio: ["pipe", "ignore", "ignore"],
      });
      child.stdin.end(JSON.stringify(event));
      const deadline = Date.now() + 20000;
      while (runs(s) === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
      child.kill("SIGTERM");
      const code = await new Promise((r) => child.on("exit", (c) => r(c)));
      assert.notEqual(code, 2, "not a refusal");
      assert.deepEqual([lastRec(s.dir).decision, lastRec(s.dir).reason, lastRec(s.dir).handback_id], ["allow", "handback_gate_error", "toolu_K"]);
      assert.equal(existsSync(join(stateOf(s.dir), "test-gate.lock")), false, "the lock is released");
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("a hand-back of a reviewer, researcher, integrator or another plugin's implementer is untouched", async () => {
    const s = await setup();
    try {
      for (const type of ["reviewer", "researcher", "integrator", "other:implementer", "orchestration:implementer", "orchestration:reviewer"]) {
        const r = await gate(s, { handback: true, type });
        assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], type);
      }
      assert.equal((await gate(s, { handback: true, plugin: true, type: "implementer" })).status, 0, "the plugin copy takes only the namespaced type");
      assert.equal((await gate(s, { handback: true, tool: "Bash" })).status, 0);
      assert.equal((await gate(s, { handback: true, id: "" })).status, 0);
      assert.equal(runs(s), 0, "no suite ran");
      assert.equal(records(s.dir).length, 0, "nothing logged");
      assert.equal((await gate(s, { handback: true, plugin: true, type: "orchestration:implementer" })).status, 2, "the plugin copy acts on its own implementer");
      assert.equal(runs(s), 1);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("with two other hand-backs already refused, failing tests let the report through and the stop gate blocks", async () => {
    const s = await setup();
    try {
      append(s.dir, "handback-refusals.jsonl", { agent_id: "a1", gate: "handback", tool_use_id: "toolu_x" });
      append(s.dir, "handback-refusals.jsonl", { agent_id: "a1", gate: "handback", tool_use_id: "toolu_y" });
      assert.equal(refusedHandbacks(stateOf(s.dir), "s1", "a1", "toolu_z"), 2);
      assert.equal(refusedHandbacks(stateOf(s.dir), "s1", "a1", "toolu_y"), 1, "the current call is left out");
      assert.equal((await handBack(s, "toolu_z")).status, 0);
      assert.equal(lastRec(s.dir).reason, "handback_resend_cap");
      assert.equal((await gate(s)).status, 2, "the SubagentStop gate decides: a block");
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("the hand-back gate's switch lets every hand-back through, logged, and runs nothing", async () => {
    const s = await setup();
    try {
      assert.equal((await gate(s, { handback: true, env: { ORCH_HANDBACK_GATE: "off" } })).status, 0);
      assert.equal(lastRec(s.dir).reason, "handback_gate_off");
      assert.equal(runs(s), 0);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("treeKey changes with the tree and the command; the cache is bounded and written atomically", async () => {
    const s = await setup(undefined, true);
    try {
      const k = treeKey(s.dir, "npm test");
      assert.match(String(k), /^[0-9a-f]{64}$/);
      assert.equal(treeKey(s.dir, "npm test"), k, "stable");
      assert.notEqual(treeKey(s.dir, "npm test -- x"), k);
      assert.notEqual(treeKey(s.dir, "npm test", { isolated: "1" }), k);
      assert.notEqual(treeKey(s.dir, "npm test", { env: { ...process.env, ORCH_BASELINE: "off" } }), treeKey(s.dir, "npm test", { env: { ...process.env, ORCH_BASELINE: "allow" } }));
      writeFileSync(join(s.dir, "u.txt"), "1");
      assert.notEqual(treeKey(s.dir, "npm test"), k);
      assert.equal(treeKey(s.tmp, "npm test"), null, "not a git work tree");
      writeFileSync(join(s.dir, ".gitmodules"), "");
      assert.equal(treeKey(s.dir, "npm test"), null, "submodules");
      const state = join(s.base, "state");
      mkdirSync(state);
      await settle(RECENT_MS); // storeVerdict below runs with the production guard
      const roots = scanRoots(s.dir) ?? [];
      const l0 = listTrees(roots, { exclude: [state] });
      const l1 = listTrees(roots, { exclude: [state] });
      assert.equal(storeVerdict(l0, l1), "", "a settled, unchanged repo may be stored");
      for (let i = 0; i < MAX_ENTRIES + 5; i += 1) cachePut(state, { key: i.toString(16).padStart(64, "0"), result: "pass", ts: new Date().toISOString(), by: `t${i}`, agent_id: "a", session_id: "s" }, l0, l1);
      assert.equal(readCache(state).length, MAX_ENTRIES);
      assert.deepEqual(readdirSync(state), [CACHE_FILE], "no temporary file left");
      assert.equal(cachePut(state, { key: "z", result: "pass", ts: "" }, l0, l1), "bad_entry", "a malformed key is refused");
      assert.equal(cachePut(state, { key: "0".repeat(64), result: /** @type {any} */ ("unknown"), ts: "" }, l0, l1), "bad_entry", "only the four outcomes");
      assert.equal(cachePut(state, { key: "e".repeat(64), result: "pass", ts: new Date().toISOString(), by: "tx", agent_id: "a", session_id: "s" }, l0, null), "l1_missing", "no L1, no store");
      const last = "f".repeat(64);
      assert.equal(cachePut(state, { key: last, result: "pass", ts: new Date().toISOString(), by: "tl", agent_id: "a", session_id: "s" }, l0, l1), "stored");
      const q = { key: last, session: "s", agent: "a", handback: "tl", roots, exclude: [state] };
      assert.equal(cacheTakeWhy(state, { ...q, agent: "b" }).reason, "no_entry", "another agent");
      assert.equal(cacheTakeWhy(state, { ...q, key: "1".repeat(64) }).reason, "key_changed", "another tree key");
      assert.equal(cacheTakeWhy(state, { ...q, roots: null }).reason, "l2_missing", "no roots");
      assert.equal(cacheTakeWhy(state, { ...q, deadline: Date.now() - 1 }).reason, "l2_deadline", "a listing that cannot finish");
      assert.equal(cacheTakeWhy(state, { ...q, now: Date.now() + (REUSE_MAX_S + 1) * 1000 }).reason, "too_old", "expired");
      assert.equal(REUSE_MAX_S, 30);
      assert.equal(cacheTake(state, q)?.result, "pass");
      assert.equal(cacheTakeWhy(state, q).reason, "used", "once");
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("after_handback: verify.sh, telemetry.mjs and journal.mjs store the same hand-back at one stop", async () => {
    const s = await setup();
    try {
      writeFileSync(join(s.base, "pass"), "");
      append(s.dir, "telemetry.jsonl", { agent_id: "a1", agent_type: "implementer", hook_event_name: "SubagentStart" });
      assert.equal((await handBack(s, "toolu_S")).status, 0);
      const event = { hook_event_name: "SubagentStop", agent_type: "implementer", agent_id: "a1", session_id: "s1", cwd: s.dir, last_assistant_message: "STATUS: pass" };
      const env = { ...cleanEnv(), CLAUDE_PROJECT_DIR: s.dir, TMPDIR: s.tmp };
      for (const h of ["telemetry.mjs", "journal.mjs"]) assert.equal((await run("node", [hook(h)], { input: JSON.stringify(event), env })).status, 0, h);
      assert.equal((await gate(s)).status, 0);
      const tel = readFileSync(join(stateOf(s.dir), "telemetry.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
      const jfile = existsSync(join(stateOf(s.dir), "journal.jsonl")) ? "journal.jsonl" : "journal-pending.jsonl";
      const jr = readFileSync(join(stateOf(s.dir), jfile), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
      assert.deepEqual([tel.after_handback, jr.after_handback, lastRec(s.dir).after_handback], ["toolu_S", "toolu_S", "toolu_S"]);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("run.mjs pairs by the hand-back a stop follows, never across the latest start, and unkeyed records by count", () => {
    const T = Date.parse("2026-11-17T10:00:00.000Z");
    const at = (/** @type {number} */ m) => new Date(T + m * 60000).toISOString();
    /** @param {string} event @param {number} m @param {Record<string, unknown>} [x] */
    const tel = (event, m, x = {}) => ({ ts: at(m), session_id: "s1", agent_id: "i1", agent_type: "implementer", hook_event_name: event, ...x });
    /** @param {number} m @param {string} decision @param {Record<string, unknown>} [x] */
    const g = (m, decision, x = {}) => ({ ts: at(m), gate: "test", decision, reason: decision === "block" ? "tests_failed" : "tests_passed", agent_id: "i1", session_id: "s1", ...x });
    // Resumed while the earlier gate still ran, then handed back again: the late record (h1) is not the new stop's (h2).
    const telemetry = [tel("SubagentStart", 0), tel("SubagentStop", 1, { after_handback: "h1" }), tel("SubagentStart", 2), tel("SubagentStop", 3, { after_handback: "h2" })];
    const late = [g(4, "block", { after_handback: "h1" })];
    assert.equal(implementerTestStates(telemetry, late, "s1").get("i1")?.stopGate, null);
    assert.equal(implementerTestStates(telemetry, [...late, g(5, "allow", { after_handback: "h2" })], "s1").get("i1")?.stopGate?.decision, "allow");
    // A record of the same hand-back from before the latest start never counts.
    assert.equal(stopGateOf([tel("SubagentStop", 3, { after_handback: "h1" })], [g(1.5, "block", { after_handback: "h1" })], T + 2 * 60000), null);
    // Two stops after one hand-back: the second waits for its own record.
    const two = [tel("SubagentStop", 1, { after_handback: "h1" }), tel("SubagentStop", 2, { after_handback: "h1" })];
    assert.equal(stopGateOf(two, [g(1.5, "block", { after_handback: "h1" })], T), null);
    // Unkeyed (a worker that only stops, or older logs): by count since the start; hand-back records are left out.
    const stop = tel("SubagentStop", 1);
    assert.equal(stopGateOf([stop], [g(0.5, "block", { at: "handback", handback_id: "t1" })], T), null);
    assert.equal(stopGateOf([stop], [g(0.5, "block", { at: "handback", handback_id: "t1" }), g(1.5, "allow")], T)?.decision, "allow");
    assert.equal(implementerTestStates([tel("SubagentStart", 0), stop], [g(2, "block")], "s1").get("i1")?.stopGate?.decision, "block");
    // A stop after a hand-back whose only record has no key (an older verify.sh): paired by count, not pending for ever.
    const keyed = tel("SubagentStop", 1, { after_handback: "h1" });
    assert.equal(stopGateOf([keyed], [g(2, "block")], T)?.decision, "block");
    assert.equal(stopGateOf([keyed], [], T), null);
  });

  // ---- 2.0.0, third review: the listing rule. L0 just before the hand-back's run, L1 just after it, L2 at the stop. ----

  test("a git-ignored input changed in place, replaced by rename, deleted or added, during the run or after it, in the work tree or the main checkout: never reused", async () => {
    /** @param {"tree" | "main"} where @param {"during" | "after"} when @param {string} how */
    const one = async (where, when, how) => {
      const s = await setup(undefined, true);
      try {
        const wt = where === "main" ? worktree(s) : s.dir;
        // In the main checkout: a dependency the worktree resolves through it (node_modules/x/index.js's folder).
        const d = where === "main" ? join(s.dir, "node_modules", "x") : join(s.dir, "ignored");
        mkdirSync(d, { recursive: true });
        writeFileSync(join(d, "in.txt"), "ok\n");
        await settle();
        // The suite reads its inputs first, then works on (sleeps) while the other process changes one.
        const cmd = `grep -q ok '${d}/in.txt' && test ! -e '${d}/extra.txt'; r=$?; echo run >> '${s.counter}'; sleep ${when === "during" ? 1.5 : 0}; exit $r`;
        const change = () => CHANGES[how]?.(d);
        const hb = await gateAsync(s, { handback: true, toolUseId: "toolu_G", cmd, cwd: wt, ...(when === "during" ? { during: change } : {}) });
        const what = `${how} ${when} the run (${where})`;
        assert.equal(hb, 0, `${what}: the report goes through`);
        assert.equal(lastRec(s.dir).store, when === "during" ? "tree_changed" : "stored", what);
        if (when === "after") change();
        // The stop ran the suite, which now fails: a block in the shared tree, the isolated warn in a linked worktree.
        const stop = await gateAsync(s, { cmd, cwd: wt });
        assert.equal(stop, where === "main" ? 0 : 2, `${what}: the stop's exit`);
        const rec = lastRec(s.dir);
        const failed = where === "main" ? "tests_failed_isolated" : "tests_failed";
        assert.deepEqual([rec.reason, rec.reused, rec.reuse, runs(s)], [failed, undefined, when === "during" ? "no_entry" : "tree_changed", 2], what);
      } finally {
        rmSync(s.base, { recursive: true, force: true });
      }
    };
    const cases = [];
    for (const where of /** @type {const} */ (["tree", "main"])) for (const when of /** @type {const} */ (["during", "after"])) for (const how of Object.keys(CHANGES)) cases.push(one(where, when, how));
    const failed = (await Promise.allSettled(cases)).flatMap((r) => (r.status === "rejected" ? [String(r.reason?.message ?? r.reason)] : []));
    assert.deepEqual(failed, []);
  });

  test("a renamed folder, a retargeted symlink, an mtime set back after a change, or a symlink to outside: never reused", async () => {
    /** @param {string} what @param {(s: { dir: string, base: string }) => void} make @param {(s: { dir: string, base: string }) => void} change @param {string} check @param {string} [store] */
    const one = async (what, make, change, check, store = "stored") => {
      const s = await setup(undefined, true);
      try {
        mkdirSync(join(s.dir, "ignored", "dir"), { recursive: true });
        writeFileSync(join(s.dir, "ignored", "dir", "in.txt"), "ok\n");
        make(s);
        await settle();
        const cmd = `echo run >> '${s.counter}'; ${check}`;
        assert.equal(await gateAsync(s, { handback: true, toolUseId: "toolu_F", cmd }), 0, what);
        assert.equal(lastRec(s.dir).store, store, what);
        change(s);
        assert.equal(await gateAsync(s, { cmd }), 2, `${what}: the stop ran the suite`);
        assert.deepEqual([lastRec(s.dir).reused, runs(s)], [undefined, 2], what);
      } finally {
        rmSync(s.base, { recursive: true, force: true });
      }
    };
    const ign = (/** @type {{ dir: string }} */ s, /** @type {string[]} */ ...p) => join(s.dir, "ignored", ...p);
    await Promise.all([
      one(
        "a folder renamed",
        () => {},
        (s) => renameSync(ign(s, "dir"), ign(s, "dir2")),
        "grep -q ok ignored/dir/in.txt",
      ),
      one(
        "a symlink retargeted inside the tree",
        (s) => {
          writeFileSync(ign(s, "b.txt"), "no\n");
          symlinkSync("dir/in.txt", ign(s, "link.txt"));
        },
        (s) => {
          unlinkSync(ign(s, "link.txt"));
          symlinkSync("b.txt", ign(s, "link.txt"));
        },
        "grep -q ok ignored/link.txt",
      ),
      one(
        "an mtime set back with the content changed, same size",
        () => {},
        (s) => {
          const p = ign(s, "dir", "in.txt");
          const ref = join(s.base, "mtime-ref");
          const st = lstatSync(p, { bigint: true });
          assert.equal(spawnSync("touch", ["-r", p, ref]).status, 0);
          writeFileSync(p, "no\n");
          assert.equal(spawnSync("touch", ["-m", "-r", ref, p]).status, 0, "touch -r: the old mtime back, to the nanosecond");
          assert.equal(lstatSync(p, { bigint: true }).mtimeNs, st.mtimeNs, "the mtime is the old one again");
        },
        "grep -q ok ignored/dir/in.txt",
      ),
      one(
        "a symlink to outside the trees",
        (s) => {
          writeFileSync(join(s.base, "outside.txt"), "ok\n");
          symlinkSync(join(s.base, "outside.txt"), ign(s, "out.txt"));
        },
        (s) => writeFileSync(join(s.base, "outside.txt"), "no\n"),
        "grep -q ok ignored/out.txt",
        "symlink_outside",
      ),
    ]);
  });

  test("an entry changed within RECENT_MS before the run: nothing stored (recent_change), the stop runs the suite", async () => {
    // A guard of 8 s (settled for it first): the fresh entry stays recent at L0 however loaded the machine is.
    const guard = 8000;
    const s = await setup(undefined, true);
    try {
      await settle(guard);
      writeFileSync(join(s.base, "pass"), "");
      mkdirSync(join(s.dir, "ignored"));
      writeFileSync(join(s.dir, "ignored", "fresh.txt"), "1\n");
      assert.equal((await handBack(s, "toolu_RC", { recentMs: guard })).status, 0);
      assert.deepEqual([lastRec(s.dir).reason, lastRec(s.dir).store], ["tests_passed", "recent_change"]);
      assert.equal((await gate(s)).status, 0);
      assert.deepEqual([lastRec(s.dir).reused, lastRec(s.dir).reuse, runs(s)], [undefined, "no_entry", 2]);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("changes inside .claude/state and .claude/worktrees, during the run and after it, do not prevent the reuse (C10)", async () => {
    const s = await setup(undefined, true);
    try {
      mkdirSync(join(s.dir, ".claude", "worktrees", "other"), { recursive: true });
      writeFileSync(join(s.base, "pass"), "");
      await settle();
      const cmd = `echo run >> '${s.counter}'; sleep 1; test -f '${s.base}/pass'`;
      const touch = () => {
        writeFileSync(join(stateOf(s.dir), "busy.jsonl"), `${Date.now()}\n`, { flag: "a" });
        writeFileSync(join(s.dir, ".claude", "worktrees", "other", "f.txt"), `${Date.now()}\n`);
        mkdirSync(join(s.dir, ".claude", "worktrees", `n${Date.now()}`));
      };
      assert.equal(await gateAsync(s, { handback: true, toolUseId: "toolu_X1", cmd, during: touch }), 0);
      assert.equal(lastRec(s.dir).store, "stored");
      touch();
      assert.equal(await gateAsync(s, { cmd }), 0);
      assert.deepEqual([lastRec(s.dir).reason, lastRec(s.dir).reused, runs(s)], ["tests_passed_cached", "pass", 1]);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("listTrees: every entry, git-ignored ones included, the left-out folders not; a deadline gives no hash", async () => {
    const s = await setup();
    try {
      const roots = scanRoots(s.dir) ?? [];
      const state = stateOf(s.dir);
      const l = listTrees(roots, { exclude: [state] });
      assert.match(String(l.hash), /^[0-9a-f]{64}$/);
      assert.deepEqual([l.outside, l.coarse, l.future, l.reason], [false, false, false, ""]);
      assert.equal(listTrees(roots, { exclude: [state] }).hash, l.hash, "stable");
      writeFileSync(join(state, "x.jsonl"), "1\n");
      mkdirSync(join(s.dir, ".claude", "worktrees", "z"), { recursive: true });
      writeFileSync(join(s.dir, ".git", "x"), "1\n");
      assert.equal(listTrees(roots, { exclude: [state] }).hash, l.hash, ".claude/state, .claude/worktrees and .git are left out");
      mkdirSync(join(s.dir, "ignored"));
      assert.notEqual(listTrees(roots, { exclude: [state] }).hash, l.hash, "a git-ignored folder counts");
      const late = listTrees(roots, { deadline: Date.now() - 1 });
      assert.deepEqual([late.hash, late.reason], [null, "deadline"]);
      assert.equal(storeVerdict(late, l), "l0_deadline");
      assert.equal(storeVerdict(l, late), "l1_deadline");
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("storeVerdict: each condition that prevents a store has its own reason code", () => {
    const t = 1_800_000_000_000;
    /** @param {Partial<import("../.claude/hooks/test-gate-cache.mjs").Listing>} x @returns {import("../.claude/hooks/test-gate-cache.mjs").Listing} */
    const L = (x = {}) => ({ v: "1", hash: "a".repeat(64), reason: "", clock0: t, clock1: t + 100, maxMs: t - 10000, outside: false, coarse: false, future: false, entries: 3, ...x });
    const l1 = L({ clock0: t + 5000, clock1: t + 5100 });
    assert.equal(storeVerdict(L(), l1), "");
    assert.equal(storeVerdict(null, l1), "l0_missing");
    assert.equal(storeVerdict(L({ hash: null, reason: "mount" }), l1), "l0_mount");
    assert.equal(storeVerdict(L(), { ...l1, hash: null, reason: "read_error" }), "l1_read_error");
    assert.equal(storeVerdict(L({ outside: true }), l1), "symlink_outside");
    assert.equal(storeVerdict(L({ coarse: true }), l1), "coarse_times");
    assert.equal(storeVerdict(L({ future: true }), l1), "future_time");
    assert.equal(storeVerdict(L(), { ...l1, clock0: t - 5000, clock1: t - 4900 }), "clock_backwards");
    assert.equal(storeVerdict(L({ maxMs: t - RECENT_MS + 1 }), l1), "recent_change");
    assert.equal(storeVerdict(L(), { ...l1, hash: "b".repeat(64) }), "tree_changed");
    // At the stop, L2 must equal the stored L0.
    const state = mkdtempSync(join(tmpdir(), "orch-hb-state-"));
    try {
      const key = "c".repeat(64);
      assert.equal(cachePut(state, { key, result: "fail", ts: new Date().toISOString(), by: "h", agent_id: "a", session_id: "s", message: "m" }, L(), l1), "stored");
      const q = { key, session: "s", agent: "a", handback: "h" };
      assert.equal(cacheTakeWhy(state, { ...q, l2: L({ hash: "d".repeat(64), clock0: t + 9000 }) }).reason, "tree_changed");
      assert.equal(cacheTakeWhy(state, { ...q, l2: L({ clock0: t - 1 }) }).reason, "clock_backwards");
      assert.equal(cacheTakeWhy(state, { ...q, l2: L({ clock0: t + 9000, hash: null, reason: "deadline" }) }).reason, "l2_deadline");
      assert.equal(cacheTakeWhy(state, { ...q, l2: L({ clock0: t + 9000 }) }).entry?.result, "fail", "a fail is taken as a fail");
    } finally {
      rmSync(state, { recursive: true, force: true });
    }
  });

  test("GAP 2: a hand-back allow after a SubagentStop tests_failed block never clears it", () => {
    const T = Date.parse("2026-11-17T10:00:00.000Z");
    const at = (/** @type {number} */ m) => new Date(T + m * 60000).toISOString();
    const telemetry = [
      { ts: at(0), session_id: "s1", agent_id: "i1", agent_type: "implementer", hook_event_name: "SubagentStart" },
      { ts: at(1), session_id: "s1", agent_id: "i1", agent_type: "implementer", hook_event_name: "SubagentStop" },
    ];
    const block = { ts: at(2), gate: "test", decision: "block", reason: "tests_failed", agent_id: "i1", session_id: "s1" };
    const hbAllow = { ts: at(3), gate: "test", decision: "allow", reason: "tests_passed", agent_id: "i1", session_id: "s1", at: "handback", handback_id: "t9" };
    const a = implementerTestStates(telemetry, [block, hbAllow], "s1").get("i1");
    assert.ok(a && testBlocked(a), "still blocked: implementer_unfinished holds");
    assert.deepEqual([a?.testReason, a?.stopGate?.decision], ["tests_failed", "block"]);
    // A SubagentStop record (a reuse is one) does replace it.
    const reuse = { ts: at(4), gate: "test", decision: "allow", reason: "tests_passed_cached", agent_id: "i1", session_id: "s1", after_handback: "t9" };
    assert.equal(testBlocked(/** @type {any} */ (implementerTestStates(telemetry, [block, hbAllow, reuse], "s1").get("i1"))), false);
  });
});
