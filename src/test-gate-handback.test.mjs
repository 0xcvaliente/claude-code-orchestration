// Test gate 2.0.0: the hand-back mode of verify.sh (PreToolUse on SubagentHandback), its result cache
// (.claude/hooks/test-gate-cache.mjs) and the stop keys that tie test-gate records to their stop (run.mjs stopGateOf).
// Real temporary git repos, as in test-gate-v2.test.mjs. Every test command counts its runs in a file outside the repo,
// so the count never changes the tree.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { implementerTestStates, stopGateOf } from "../.claude/hooks/run.mjs";
import { CACHE_FILE, MAX_ENTRIES, cacheGet, cachePut, readCache, refusedHandbacks, stopKey, treeKey } from "../.claude/hooks/test-gate-cache.mjs";

const hook = (/** @type {string} */ name) => new URL(`../.claude/hooks/${name}`, import.meta.url).pathname;
const SWITCH = /ORCH_|CLAUDE_PLUGIN_OPTION|handback_gate|HANDBACK_GATE/;

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

/** A committed repo, a counter file outside it, and a fixed TMPDIR. */
function setup(files = { "a.js": "x\n", ".gitignore": "ignored/\n" }) {
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
  return { base, dir, tmp, counter };
}
/** A test command that counts its runs and passes when `pass` exists in `base`. @param {{ base: string, counter: string }} s */
const cmdOf = (s) => `echo run >> '${s.counter}'; echo 'not ok 1 - boom'; test -f '${s.base}/pass'`;
/** @param {{ counter: string }} s */
const runs = (s) => (existsSync(s.counter) ? readFileSync(s.counter, "utf8").split("\n").filter(Boolean).length : 0);

/**
 * verify.sh as a hook runs it. `handback` adds --handback and a SubagentHandback PreToolUse event.
 * @param {{ dir: string, tmp: string, base: string, counter: string }} s
 * @param {{ handback?: boolean, id?: string, type?: string, toolUseId?: string, env?: Record<string, string>, plugin?: boolean, transcript?: string, cmd?: string, tool?: string }} [o]
 */
function gate(s, o = {}) {
  /** @type {Record<string, unknown>} */
  const event = { agent_type: o.type ?? "implementer", agent_id: o.id ?? "a1", cwd: s.dir, session_id: "s1" };
  if (o.handback) Object.assign(event, { hook_event_name: "PreToolUse", tool_name: o.tool ?? "SubagentHandback", tool_use_id: o.toolUseId ?? "toolu_1", tool_input: { message: "STATUS: pass\nOPEN: none" } });
  else event.hook_event_name = "SubagentStop";
  if (o.transcript) event.agent_transcript_path = o.transcript;
  const args = [hook("verify.sh"), ...(o.plugin ? ["--plugin"] : []), ...(o.handback ? ["--handback"] : [])];
  const r = spawnSync("bash", args, {
    input: JSON.stringify(event),
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: s.dir, TMPDIR: s.tmp, ORCH_TEST_CMD: o.cmd ?? cmdOf(s), CLAUDE_PLUGIN_DATA: join(s.base, "plugin-data"), ...o.env },
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
}
/** @param {string} dir */
const stateOf = (dir) => join(dir, ".claude", "state");
/** @param {string} dir @returns {any[]} */
const records = (dir) => {
  const p = join(stateOf(dir), "gates.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
/** @param {string} dir */
const lastRec = (dir) => records(dir).at(-1);

test("failing tests refuse the hand-back with the stop gate's message, log a block and mark the refusal", () => {
  const s = setup();
  try {
    const r = gate(s, { handback: true, toolUseId: "toolu_A" });
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

test("a third refusal never happens: after two the report goes through with the give-up, and the stop reuses the fail", () => {
  const s = setup();
  try {
    assert.deepEqual([1, 2, 3].map((n) => gate(s, { handback: true, toolUseId: `toolu_${n}` }).status), [2, 2, 0]);
    assert.deepEqual(records(s.dir).map((x) => [x.decision, x.reason]), [["block", "tests_failed"], ["block", "tests_failed"], ["allow", "max_blocks_reached"]]);
    assert.equal(runs(s), 1, "the unchanged tree ran its suite once; the later hand-backs reused its fail");
    assert.equal(records(s.dir)[1].reused, "fail");
    const stop = gate(s);
    assert.equal(stop.status, 0, "the SubagentStop gate's cap counts the hand-back blocks");
    assert.deepEqual([lastRec(s.dir).reason, lastRec(s.dir).reused, lastRec(s.dir).reused_from], ["max_blocks_reached", "fail", "handback:toolu_1"]);
    assert.equal(runs(s), 1);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("passing tests let the report through and write the keyed result; the stop reuses it and logs the reuse", () => {
  const s = setup();
  try {
    writeFileSync(join(s.base, "pass"), "");
    const t = join(s.base, "t.jsonl");
    writeFileSync(t, `${JSON.stringify({ type: "user", uuid: "u-1" })}\n${JSON.stringify({ type: "assistant", uuid: "u-2" })}\n`);
    const r = gate(s, { handback: true, toolUseId: "toolu_P" });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
    assert.deepEqual([lastRec(s.dir).decision, lastRec(s.dir).reason, lastRec(s.dir).at], ["allow", "tests_passed", "handback"]);
    const entries = readCache(stateOf(s.dir));
    assert.equal(entries.length, 1);
    assert.deepEqual([entries[0]?.result, entries[0]?.by, entries[0]?.key.slice(0, 16)], ["pass", "handback:toolu_P", lastRec(s.dir).tree]);
    const stop = gate(s, { transcript: t });
    assert.equal(stop.status, 0);
    const rec = lastRec(s.dir);
    assert.deepEqual([rec.reason, rec.reused, rec.reused_from, rec.stop_key], ["tests_passed_cached", "pass", "handback:toolu_P", "uuid:u-2"]);
    assert.equal(runs(s), 1, "the suite did not run twice for one unchanged tree");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("the stop runs the suite again when a tracked file, a staged change or an untracked file changed, or the command differs", () => {
  const s = setup();
  try {
    writeFileSync(join(s.base, "pass"), "");
    let n = 0;
    /** @param {string} what @param {() => void} change */
    const check = (what, change) => {
      assert.equal(gate(s, { handback: true }).status, 0);
      const before = runs(s);
      change();
      n += 1;
      assert.equal(gate(s).status, 0);
      assert.equal(runs(s), before + 1, `${what}: the suite ran again`);
      assert.equal(lastRec(s.dir).reason, "tests_passed", what);
      assert.equal(lastRec(s.dir).reused, undefined, what);
    };
    check("tracked file", () => writeFileSync(join(s.dir, "a.js"), "y\n"));
    check("staged change", () => {
      writeFileSync(join(s.dir, "a.js"), "z\n");
      git(s.dir, "add", "a.js");
    });
    check("untracked file", () => writeFileSync(join(s.dir, "new.js"), "n\n"));
    check("untracked content", () => writeFileSync(join(s.dir, "new.js"), "changed\n"));
    assert.equal(n, 4);
    // The test command differs between the two gates.
    assert.equal(gate(s, { handback: true }).status, 0);
    const before = runs(s);
    assert.equal(gate(s, { cmd: `${cmdOf(s)} && true` }).status, 0);
    assert.equal(runs(s), before + 1, "another command runs");
    assert.equal(lastRec(s.dir).reused, undefined);
    // An ignored file is not part of the key: the result is reused.
    mkdirSync(join(s.dir, "ignored"));
    writeFileSync(join(s.dir, "ignored", "x"), "1");
    assert.equal(gate(s).status, 0);
    assert.equal(lastRec(s.dir).reason, "tests_passed_cached");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("a cached block is never reused as a pass, and a pass is never stored for a tree that changed during the run", () => {
  const s = setup();
  try {
    assert.equal(gate(s, { handback: true }).status, 2);
    // The stop on the same tree reuses the fail as a fail: it blocks (one block so far, under the cap).
    writeFileSync(join(s.base, "pass"), ""); // would pass if it ran: proves the stop did not run it
    const stop = gate(s);
    assert.equal(stop.status, 2);
    assert.deepEqual([lastRec(s.dir).decision, lastRec(s.dir).reason, lastRec(s.dir).reused], ["block", "tests_failed", "fail"]);
    assert.match(stop.stderr, /Fix the root cause and rerun before finishing/);
    // cacheGet never turns one result into the other.
    const key = readCache(stateOf(s.dir))[0]?.key ?? "";
    assert.equal(cacheGet(stateOf(s.dir), key)?.result, "fail");
    // A command that changes the tree while it runs: nothing is stored.
    const s2 = setup();
    try {
      assert.equal(gate(s2, { handback: true, cmd: `echo run >> '${s2.counter}'; date +%N > during.txt` }).status, 0);
      assert.equal(readCache(stateOf(s2.dir)).length, 0, "no key after the run equal to the one before: no entry");
    } finally {
      rmSync(s2.base, { recursive: true, force: true });
    }
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("a hand-back gate that times out, cannot get the lock, or is killed lets the report through, logged; the stop still decides", () => {
  const s = setup();
  try {
    // The suite hangs past the budget: allowed and logged, and nothing is stored.
    const slow = `echo run >> '${s.counter}'; if test -f '${s.base}/slow'; then sleep 30; fi; exit 1`;
    writeFileSync(join(s.base, "slow"), "");
    const t = gate(s, { handback: true, cmd: slow, env: { ORCH_HOOK_BUDGET_S: "3" } });
    assert.equal(t.status, 0);
    assert.deepEqual([lastRec(s.dir).decision, lastRec(s.dir).reason], ["allow", "handback_timed_out"]);
    assert.equal(readCache(stateOf(s.dir)).length, 0);
    rmSync(join(s.base, "slow"));
    const stop = gate(s, { cmd: slow });
    assert.equal(stop.status, 2, "the SubagentStop gate runs the suite and blocks");
    assert.equal(lastRec(s.dir).reused, undefined);

    // The lock held by a live process until the floor: allowed and logged, no run.
    const s2 = setup();
    try {
      mkdirSync(stateOf(s2.dir), { recursive: true });
      writeFileSync(join(stateOf(s2.dir), "test-gate.lock"), `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
      const l = gate(s2, { handback: true, env: { ORCH_HOOK_BUDGET_S: "4" } });
      assert.equal(l.status, 0);
      assert.deepEqual([lastRec(s2.dir).reason, lastRec(s2.dir).not_run], ["handback_lock_wait", 1]);
      assert.equal(runs(s2), 0);
    } finally {
      rmSync(s2.base, { recursive: true, force: true });
    }
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("a hand-back gate killed by Claude Code's timeout (SIGTERM) lets the report through and logs handback_gate_error", async () => {
  const s = setup();
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

test("a hand-back of a reviewer, researcher, integrator or another plugin's implementer is untouched", () => {
  const s = setup();
  try {
    for (const type of ["reviewer", "researcher", "integrator", "other:implementer", "orchestration:implementer", "orchestration:reviewer"]) {
      const r = gate(s, { handback: true, type });
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], type);
    }
    // The plugin copy takes only the namespaced type.
    assert.deepEqual(gate(s, { handback: true, plugin: true, type: "implementer" }).status, 0);
    // Another tool, and a hand-back with no agent id.
    assert.equal(gate(s, { handback: true, tool: "Bash" }).status, 0);
    assert.equal(gate(s, { handback: true, id: "" }).status, 0);
    assert.equal(runs(s), 0, "no suite ran");
    assert.equal(records(s.dir).length, 0, "nothing logged");
    // The plugin copy acts on its own implementer (state in the plugin's per-user folder here).
    assert.equal(gate(s, { handback: true, plugin: true, type: "orchestration:implementer" }).status, 2);
    assert.equal(runs(s), 1);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("with two other hand-backs already refused, failing tests let the report through and the stop gate blocks", () => {
  const s = setup();
  try {
    mkdirSync(stateOf(s.dir), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(
      join(stateOf(s.dir), "handback-refusals.jsonl"),
      `${JSON.stringify({ ts: now, session_id: "s1", agent_id: "a1", gate: "handback", tool_use_id: "toolu_x" })}\n${JSON.stringify({ ts: now, session_id: "s1", agent_id: "a1", gate: "handback", tool_use_id: "toolu_y" })}\n`,
    );
    assert.equal(refusedHandbacks(stateOf(s.dir), "s1", "a1", "toolu_z"), 2);
    assert.equal(refusedHandbacks(stateOf(s.dir), "s1", "a1", "toolu_y"), 1, "the current call is left out");
    const r = gate(s, { handback: true, toolUseId: "toolu_z" });
    assert.equal(r.status, 0);
    assert.equal(lastRec(s.dir).reason, "handback_resend_cap");
    assert.equal(gate(s).status, 2, "the SubagentStop gate decides: a block");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("the hand-back gate's switch lets every hand-back through, logged, and runs nothing", () => {
  const s = setup();
  try {
    const r = gate(s, { handback: true, env: { ORCH_HANDBACK_GATE: "off" } });
    assert.equal(r.status, 0);
    assert.equal(lastRec(s.dir).reason, "handback_gate_off");
    assert.equal(runs(s), 0);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("treeKey changes with the tree and the command; the cache is bounded and written atomically", () => {
  const s = setup();
  try {
    const k = treeKey(s.dir, "npm test");
    assert.match(String(k), /^[0-9a-f]{64}$/);
    assert.equal(treeKey(s.dir, "npm test"), k, "stable");
    assert.notEqual(treeKey(s.dir, "npm test -- x"), k);
    assert.notEqual(treeKey(s.dir, "npm test", { isolated: "1" }), k);
    assert.notEqual(treeKey(s.dir, "npm test", { env: { ...process.env, ORCH_BASELINE: "off" } }), treeKey(s.dir, "npm test", { env: { ...process.env, ORCH_BASELINE: "allow" } }));
    writeFileSync(join(s.dir, "u.txt"), "1");
    assert.notEqual(treeKey(s.dir, "npm test"), k);
    // Not a git work tree, or a repository with submodules: no key.
    assert.equal(treeKey(s.tmp, "npm test"), null);
    writeFileSync(join(s.dir, ".gitmodules"), "");
    assert.equal(treeKey(s.dir, "npm test"), null);
    const state = join(s.base, "state");
    mkdirSync(state);
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) cachePut(state, { key: i.toString(16).padStart(64, "0"), result: "pass", ts: "" });
    assert.equal(readCache(state).length, MAX_ENTRIES);
    assert.deepEqual(readdirSync(state), [CACHE_FILE], "no temporary file left");
    assert.equal(cachePut(state, { key: "z", result: "pass", ts: "" }), false, "a malformed key is refused");
    assert.equal(cachePut(state, { key: "0".repeat(64), result: /** @type {any} */ ("unknown"), ts: "" }), false, "only pass or fail");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("stop keys: verify.sh, telemetry.mjs and journal.mjs store the same stop_key at one stop", () => {
  const s = setup();
  try {
    writeFileSync(join(s.base, "pass"), "");
    const t = join(s.base, "t.jsonl");
    writeFileSync(t, `${JSON.stringify({ type: "user", uuid: "u-1", message: { content: "SLICE: a\nFILES: a.js\nDEPENDS: none" } })}\n${JSON.stringify({ type: "assistant", uuid: "u-9", message: { content: "STATUS: pass" } })}\n`);
    assert.equal(stopKey(t), "uuid:u-9");
    assert.equal(stopKey(join(s.base, "missing")), null);
    const event = { hook_event_name: "SubagentStop", agent_type: "implementer", agent_id: "a1", session_id: "s1", cwd: s.dir, agent_transcript_path: t, last_assistant_message: "STATUS: pass" };
    const env = { ...cleanEnv(), CLAUDE_PROJECT_DIR: s.dir, TMPDIR: s.tmp };
    for (const h of ["telemetry.mjs", "journal.mjs"]) assert.equal(spawnSync("node", [hook(h)], { input: JSON.stringify(event), env, encoding: "utf8" }).status, 0, h);
    gate(s, { transcript: t });
    const tel = readFileSync(join(stateOf(s.dir), "telemetry.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    const jfile = existsSync(join(stateOf(s.dir), "journal.jsonl")) ? "journal.jsonl" : "journal-pending.jsonl";
    const jr = readFileSync(join(stateOf(s.dir), jfile), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
    assert.deepEqual([tel.stop_key, jr.stop_key, lastRec(s.dir).stop_key], ["uuid:u-9", "uuid:u-9", "uuid:u-9"]);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("run.mjs pairs records with stops by key, keeps the count for unkeyed records and never counts a hand-back record", () => {
  const T = Date.parse("2026-11-17T10:00:00.000Z");
  const at = (/** @type {number} */ m) => new Date(T + m * 60000).toISOString();
  /** @param {string} event @param {number} m @param {Record<string, unknown>} [x] */
  const tel = (event, m, x = {}) => ({ ts: at(m), session_id: "s1", agent_id: "i1", agent_type: "implementer", hook_event_name: event, ...x });
  /** @param {number} m @param {string} decision @param {Record<string, unknown>} [x] */
  const g = (m, decision, x = {}) => ({ ts: at(m), gate: "test", decision, reason: decision === "block" ? "tests_failed" : "tests_passed", agent_id: "i1", session_id: "s1", ...x });
  // Resumed while the earlier gate still ran: the late record (k1) is not the new stop's (k2).
  const telemetry = [tel("SubagentStart", 0), tel("SubagentStop", 1, { stop_key: "k1" }), tel("SubagentStart", 2), tel("SubagentStop", 3, { stop_key: "k2" })];
  const late = [g(4, "block", { stop_key: "k1" })];
  assert.equal(implementerTestStates(telemetry, late, "s1").get("i1")?.stopGate, null);
  const own = [...late, g(5, "allow", { stop_key: "k2" })];
  assert.equal(implementerTestStates(telemetry, own, "s1").get("i1")?.stopGate?.decision, "allow");
  // Unkeyed (older logs): by count since the latest start, as before; hand-back records are left out.
  const old = [tel("SubagentStart", 0), tel("SubagentStop", 1)];
  assert.equal(stopGateOf([old[1]], [g(0.5, "block", { at: "handback", handback_id: "t1" })], T), null);
  assert.equal(stopGateOf([old[1]], [g(0.5, "block", { at: "handback", handback_id: "t1" }), g(1.5, "allow")], T)?.decision, "allow");
  assert.equal(implementerTestStates(old, [g(2, "block")], "s1").get("i1")?.stopGate?.decision, "block");
  // A keyed stop never takes a hand-back record, even one that names the same key.
  assert.equal(stopGateOf([tel("SubagentStop", 1, { stop_key: "k" })], [g(1, "allow", { at: "handback", stop_key: "k" })], T), null);
});
