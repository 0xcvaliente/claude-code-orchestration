// Test gate 2.0.0: the hand-back mode of verify.sh (PreToolUse on SubagentHandback), its one-use result cache
// (.claude/hooks/test-gate-cache.mjs) and the after_handback link that ties a stop's test-gate record to its stop
// (state.mjs latestHandbackId, run.mjs stopGateOf). Real temporary git repos, as in test-gate-v2.test.mjs. Every test
// command counts its runs in a file outside the repo, so the count never changes the tree.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { implementerTestStates, stopGateOf } from "../.claude/hooks/run.mjs";
import { latestHandbackId } from "../.claude/hooks/state.mjs";
import { CACHE_FILE, MAX_ENTRIES, REUSE_MAX_S, cachePut, cacheTake, readCache, refusedHandbacks, treeKey } from "../.claude/hooks/test-gate-cache.mjs";

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
 * @param {{ handback?: boolean, id?: string, type?: string, toolUseId?: string, env?: Record<string, string>, plugin?: boolean, cmd?: string, tool?: string, noCwd?: boolean }} [o]
 */
function gate(s, o = {}) {
  /** @type {Record<string, unknown>} */
  const event = { agent_type: o.type ?? "implementer", agent_id: o.id ?? "a1", session_id: "s1" };
  if (!o.noCwd) event.cwd = s.dir;
  if (o.handback) Object.assign(event, { hook_event_name: "PreToolUse", tool_name: o.tool ?? "SubagentHandback", tool_use_id: o.toolUseId ?? "toolu_1", tool_input: { message: "STATUS: pass\nOPEN: none" } });
  else event.hook_event_name = "SubagentStop";
  const args = [hook("verify.sh"), ...(o.plugin ? ["--plugin"] : []), ...(o.handback ? ["--handback"] : [])];
  const r = spawnSync("bash", args, {
    input: JSON.stringify(event),
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: s.dir, TMPDIR: s.tmp, ORCH_TEST_CMD: o.cmd ?? cmdOf(s), CLAUDE_PLUGIN_DATA: join(s.base, "plugin-data"), ...o.env },
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
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

test("failing tests refuse the hand-back with the stop gate's message, log a block and mark the refusal", () => {
  const s = setup();
  try {
    const r = handBack(s, "toolu_A");
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

test("a third refusal never happens: after two the report goes through with the give-up, and the stop reuses that fail", () => {
  const s = setup();
  try {
    assert.deepEqual([1, 2, 3].map((n) => handBack(s, `toolu_${n}`).status), [2, 2, 0]);
    assert.deepEqual(records(s.dir).map((x) => [x.decision, x.reason]), [["block", "tests_failed"], ["block", "tests_failed"], ["allow", "max_blocks_reached"]]);
    assert.equal(runs(s), 3, "a hand-back never reuses a result: each ran the suite");
    const stop = gate(s);
    assert.equal(stop.status, 0, "the SubagentStop gate's cap counts the hand-back blocks");
    const rec = lastRec(s.dir);
    assert.deepEqual([rec.reason, rec.reused, rec.reused_from, rec.after_handback], ["max_blocks_reached", "fail", "toolu_3", "toolu_3"]);
    assert.equal(runs(s), 3);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("passing tests let the report through and write the result; the stop reuses it once and logs the reuse", () => {
  const s = setup();
  try {
    writeFileSync(join(s.base, "pass"), "");
    const r = handBack(s, "toolu_P");
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""]);
    assert.deepEqual([lastRec(s.dir).decision, lastRec(s.dir).reason, lastRec(s.dir).at], ["allow", "tests_passed", "handback"]);
    const entries = readCache(stateOf(s.dir));
    assert.deepEqual([entries.length, entries[0]?.result, entries[0]?.by, entries[0]?.agent_id], [1, "pass", "toolu_P", "a1"]);
    assert.equal(gate(s).status, 0);
    const rec = lastRec(s.dir);
    assert.deepEqual([rec.reason, rec.reused, rec.reused_from, rec.after_handback], ["tests_passed_cached", "pass", "toolu_P", "toolu_P"]);
    assert.equal(runs(s), 1, "the suite did not run twice for one unchanged tree");
    assert.equal(readCache(stateOf(s.dir))[0]?.used, true);
    // A second stop of the same agent (no new hand-back) never reuses the same record again.
    assert.equal(gate(s).status, 0);
    assert.deepEqual([lastRec(s.dir).reason, lastRec(s.dir).reused], ["tests_passed", undefined]);
    assert.equal(runs(s), 2);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("the stop runs the suite when a tracked file, a staged change or an untracked file changed, or the command differs", () => {
  const s = setup();
  try {
    writeFileSync(join(s.base, "pass"), "");
    let n = 0;
    /** @param {string} what @param {() => void} change @param {string} [cmd] */
    const check = (what, change, cmd) => {
      n += 1;
      assert.equal(handBack(s, `toolu_c${n}`).status, 0);
      const before = runs(s);
      change();
      assert.equal(gate(s, cmd ? { cmd } : {}).status, 0);
      assert.equal(runs(s), before + 1, `${what}: the suite ran again`);
      assert.deepEqual([lastRec(s.dir).reason, lastRec(s.dir).reused], ["tests_passed", undefined], what);
    };
    check("tracked file", () => writeFileSync(join(s.dir, "a.js"), "y\n"));
    check("staged change", () => {
      writeFileSync(join(s.dir, "a.js"), "z\n");
      git(s.dir, "add", "a.js");
    });
    check("untracked file", () => writeFileSync(join(s.dir, "new.js"), "n\n"));
    check("untracked content", () => writeFileSync(join(s.dir, "new.js"), "changed\n"));
    check("test command", () => {}, `${cmdOf(s)} && true`);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("the reviewer's cases: an ignored input and an untracked symlink's target changed across a long gap run the suite", () => {
  const s = setup();
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
      assert.equal(handBack(s, `toolu_${what.replace(/ /g, "_")}`, { cmd }).status, 0, what);
      change();
      age(s.dir, REUSE_MAX_S + 1);
      const before = runs(s);
      assert.equal(gate(s, { cmd }).status, 2, `${what}: the stop ran the suite and blocks`);
      assert.equal(runs(s), before + 1);
      assert.equal(lastRec(s.dir).reused, undefined);
    }
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("no reuse for another agent, after a later start of the agent, or for an expired result", () => {
  const s = setup();
  try {
    writeFileSync(join(s.base, "pass"), "");
    // Another agent in the same tree: its own (or no) hand-back, never a1's result.
    assert.equal(handBack(s, "toolu_X").status, 0);
    assert.equal(gate(s, { id: "a2" }).status, 0);
    assert.deepEqual([lastRec(s.dir).agent_id, lastRec(s.dir).reused, runs(s)], ["a2", undefined, 2]);
    append(s.dir, "handbacks.jsonl", { agent_id: "a2", tool_use_id: "toolu_X" }); // the same id, another agent
    assert.equal(gate(s, { id: "a2" }).status, 0);
    assert.equal(lastRec(s.dir).reused, undefined);
    // A later start of a1 (a resume): its stop follows no hand-back since, so nothing is reused.
    append(s.dir, "telemetry.jsonl", { agent_id: "a1", agent_type: "implementer", hook_event_name: "SubagentStart" });
    assert.equal(latestHandbackId("s1", "a1", stateOf(s.dir)), null);
    assert.equal(gate(s).status, 0);
    assert.deepEqual([lastRec(s.dir).reused, lastRec(s.dir).after_handback], [undefined, undefined]);
    // Expired.
    assert.equal(handBack(s, "toolu_E").status, 0);
    age(s.dir, REUSE_MAX_S + 1);
    const before = runs(s);
    assert.equal(gate(s).status, 0);
    assert.deepEqual([lastRec(s.dir).reused, runs(s)], [undefined, before + 1]);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("a cached block is never reused as a pass, and nothing is stored for a tree that changed during the run", () => {
  const s = setup();
  try {
    assert.equal(handBack(s, "toolu_1").status, 2);
    // The worker resends with the same tree, the test would now pass, but the hand-back runs it (no reuse there).
    writeFileSync(join(s.base, "pass"), "");
    assert.equal(handBack(s, "toolu_2").status, 0);
    const key = readCache(stateOf(s.dir)).find((e) => e.by === "toolu_1")?.key ?? "";
    assert.equal(cacheTake(stateOf(s.dir), { key, session: "s1", agent: "a1", handback: "toolu_1" })?.result, "fail", "a fail stays a fail");
    rmSync(join(s.base, "pass"));
    const s2 = setup();
    try {
      assert.equal(handBack(s2, "toolu_D", { cmd: `echo run >> '${s2.counter}'; date +%N > during.txt` }).status, 0);
      assert.equal(readCache(stateOf(s2.dir)).length, 0, "the key after the run differs: no entry");
    } finally {
      rmSync(s2.base, { recursive: true, force: true });
    }
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("a hand-back gate that times out, cannot get the lock, has no cwd, or has no time left for a key lets the report through, logged", () => {
  const s = setup();
  try {
    const slow = `echo run >> '${s.counter}'; if test -f '${s.base}/slow'; then sleep 30; fi; exit 1`;
    writeFileSync(join(s.base, "slow"), "");
    assert.equal(handBack(s, "toolu_T", { cmd: slow, env: { ORCH_HOOK_BUDGET_S: "3" } }).status, 0);
    assert.deepEqual([lastRec(s.dir).decision, lastRec(s.dir).reason], ["allow", "handback_timed_out"]);
    assert.equal(readCache(stateOf(s.dir)).length, 0, "a 3 s budget leaves no time for a key: nothing stored");
    rmSync(join(s.base, "slow"));
    assert.equal(gate(s, { cmd: slow }).status, 2, "the SubagentStop gate runs the suite and blocks");
    assert.equal(lastRec(s.dir).reused, undefined);
    assert.equal(gate(s, { handback: true, noCwd: true, toolUseId: "toolu_N" }).status, 0);
    assert.equal(lastRec(s.dir).reason, "handback_no_cwd");

    const s2 = setup();
    try {
      mkdirSync(stateOf(s2.dir), { recursive: true });
      writeFileSync(join(stateOf(s2.dir), "test-gate.lock"), `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
      assert.equal(handBack(s2, "toolu_L", { env: { ORCH_HOOK_BUDGET_S: "4" } }).status, 0);
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
    assert.equal(gate(s, { handback: true, plugin: true, type: "implementer" }).status, 0, "the plugin copy takes only the namespaced type");
    assert.equal(gate(s, { handback: true, tool: "Bash" }).status, 0);
    assert.equal(gate(s, { handback: true, id: "" }).status, 0);
    assert.equal(runs(s), 0, "no suite ran");
    assert.equal(records(s.dir).length, 0, "nothing logged");
    assert.equal(gate(s, { handback: true, plugin: true, type: "orchestration:implementer" }).status, 2, "the plugin copy acts on its own implementer");
    assert.equal(runs(s), 1);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("with two other hand-backs already refused, failing tests let the report through and the stop gate blocks", () => {
  const s = setup();
  try {
    append(s.dir, "handback-refusals.jsonl", { agent_id: "a1", gate: "handback", tool_use_id: "toolu_x" });
    append(s.dir, "handback-refusals.jsonl", { agent_id: "a1", gate: "handback", tool_use_id: "toolu_y" });
    assert.equal(refusedHandbacks(stateOf(s.dir), "s1", "a1", "toolu_z"), 2);
    assert.equal(refusedHandbacks(stateOf(s.dir), "s1", "a1", "toolu_y"), 1, "the current call is left out");
    assert.equal(handBack(s, "toolu_z").status, 0);
    assert.equal(lastRec(s.dir).reason, "handback_resend_cap");
    assert.equal(gate(s).status, 2, "the SubagentStop gate decides: a block");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("the hand-back gate's switch lets every hand-back through, logged, and runs nothing", () => {
  const s = setup();
  try {
    assert.equal(gate(s, { handback: true, env: { ORCH_HANDBACK_GATE: "off" } }).status, 0);
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
    assert.equal(treeKey(s.tmp, "npm test"), null, "not a git work tree");
    writeFileSync(join(s.dir, ".gitmodules"), "");
    assert.equal(treeKey(s.dir, "npm test"), null, "submodules");
    const state = join(s.base, "state");
    mkdirSync(state);
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) cachePut(state, { key: i.toString(16).padStart(64, "0"), result: "pass", ts: new Date().toISOString(), by: `t${i}`, agent_id: "a", session_id: "s" });
    assert.equal(readCache(state).length, MAX_ENTRIES);
    assert.deepEqual(readdirSync(state), [CACHE_FILE], "no temporary file left");
    assert.equal(cachePut(state, { key: "z", result: "pass", ts: "" }), false, "a malformed key is refused");
    assert.equal(cachePut(state, { key: "0".repeat(64), result: /** @type {any} */ ("unknown"), ts: "" }), false, "only pass or fail");
    const last = (MAX_ENTRIES + 4).toString(16).padStart(64, "0");
    assert.equal(cacheTake(state, { key: last, session: "s", agent: "b", handback: `t${MAX_ENTRIES + 4}` }), null, "another agent");
    assert.equal(cacheTake(state, { key: "1".repeat(64), session: "s", agent: "a", handback: `t${MAX_ENTRIES + 4}` }), null, "another tree");
    assert.equal(cacheTake(state, { key: last, session: "s", agent: "a", handback: `t${MAX_ENTRIES + 4}` })?.result, "pass");
    assert.equal(cacheTake(state, { key: last, session: "s", agent: "a", handback: `t${MAX_ENTRIES + 4}` }), null, "once");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("after_handback: verify.sh, telemetry.mjs and journal.mjs store the same hand-back at one stop", () => {
  const s = setup();
  try {
    writeFileSync(join(s.base, "pass"), "");
    append(s.dir, "telemetry.jsonl", { agent_id: "a1", agent_type: "implementer", hook_event_name: "SubagentStart" });
    assert.equal(handBack(s, "toolu_S").status, 0);
    const event = { hook_event_name: "SubagentStop", agent_type: "implementer", agent_id: "a1", session_id: "s1", cwd: s.dir, last_assistant_message: "STATUS: pass" };
    const env = { ...cleanEnv(), CLAUDE_PROJECT_DIR: s.dir, TMPDIR: s.tmp };
    for (const h of ["telemetry.mjs", "journal.mjs"]) assert.equal(spawnSync("node", [hook(h)], { input: JSON.stringify(event), env, encoding: "utf8" }).status, 0, h);
    assert.equal(gate(s).status, 0);
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
});
