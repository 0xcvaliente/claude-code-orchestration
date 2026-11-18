// 2.0.1 (D5, docs/data/probes-2.0.1-stop-gate.md): every implementer stop the test gate handles leaves a record that
// run.mjs stopGateOf can pair with it, and the plan check tells a reviewer the gate is pending only while the gate may
// still be running.
// Section 1 drives the real verify.sh in stop mode (after the real hand-back mode where the case has one) in temporary
// git repos, with SubagentStop events shaped as Claude Code 2.1.326 sends them: `background_tasks` lists the session's
// in-flight work after the agent's own fields, one `agent_type` per running subagent. Section 2 drives the real
// plan-check.mjs in a throwaway project, as src/plan-check-review-hold.test.mjs does.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseHeader, parseReply } from "../.claude/hooks/brief.mjs";
import * as runModule from "../.claude/hooks/run.mjs";

const { implementerTestStates } = runModule;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = (/** @type {string} */ name) => join(root, ".claude", "hooks", name);
const SWITCH = /ORCH_|CLAUDE_PLUGIN_OPTION|review_hold|REVIEW_HOLD|HOOK_BUDGET/;

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
}
const pause = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
/** The recent-change guard verify.sh gets here (--recent-ms), as in test-gate-handback.test.mjs. */
const GUARD_MS = 300;

/**
 * A committed repo with an isolated worktree under .claude/worktrees that changed a.js, a counter file outside it and a
 * TMPDIR of its own; the state folder exists and ignores itself, as the hooks leave it.
 */
async function setup() {
  const base = mkdtempSync(join(tmpdir(), "orch-sg-"));
  const dir = join(base, "repo");
  mkdirSync(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.js"), "x\n");
  writeFileSync(join(dir, ".gitignore"), ".claude/worktrees/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  writeFileSync(join(dir, ".claude", "state", ".gitignore"), "*\n");
  const wt = join(dir, ".claude", "worktrees", "agent-a1");
  git(dir, "worktree", "add", "-q", "-b", "w1", wt);
  writeFileSync(join(wt, "a.js"), "y\n");
  const tmp = join(base, "tmp");
  mkdirSync(tmp);
  await pause(GUARD_MS + 300);
  return { base, dir, wt, tmp, counter: join(base, "runs.txt") };
}
/** @typedef {Awaited<ReturnType<typeof setup>>} Repo */
/** @param {Repo} s */
const runs = (s) => (existsSync(s.counter) ? readFileSync(s.counter, "utf8").split("\n").filter(Boolean).length : 0);
/** @param {string} dir @returns {any[]} */
const records = (dir) => {
  const p = join(dir, ".claude", "state", "gates.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
/** @param {string} dir */
const stopRecords = (dir) => records(dir).filter((r) => r.at !== "handback");

/** The session's in-flight work as Claude Code lists it at a SubagentStop: the agent itself, a shell, then a reviewer. */
const BACKGROUND = [
  { id: "a1", type: "subagent", status: "running", description: "s6 slice", agent_type: "implementer" },
  { id: "b1", type: "shell", status: "running", description: "suite", command: "npm test" },
  { id: "r1", type: "subagent", status: "running", description: "s5 review", agent_type: "reviewer" },
];

/**
 * verify.sh as Claude Code runs it, without blocking the event loop. `handback`: a SubagentHandback PreToolUse event
 * (after handback-check.mjs's capture in handbacks.jsonl); otherwise a SubagentStop event with `background`.
 * @param {Repo} s
 * @param {{ handback?: string, cwd?: string, cmd: string, env?: Record<string, string>, background?: unknown[], extra?: Record<string, unknown>, onStart?: (pid: number) => void }} o
 * @returns {Promise<{ status: number | null, signal: string | null, stderr: string }>}
 */
function verify(s, o) {
  /** @type {Record<string, unknown>} */
  const event = { session_id: "s1", transcript_path: "/x.jsonl", cwd: o.cwd ?? s.wt, permission_mode: "auto", agent_id: "a1", agent_type: "implementer" };
  if (o.handback) {
    writeFileSync(
      join(s.dir, ".claude", "state", "handbacks.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), session_id: "s1", agent_id: "a1", agent_type: "implementer", tool_use_id: o.handback, status: "pass" })}\n`,
      { flag: "a" },
    );
    Object.assign(event, { hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_input: { message: "STATUS: pass\nOPEN: none" }, tool_use_id: o.handback });
  } else {
    Object.assign(event, {
      hook_event_name: "SubagentStop",
      stop_hook_active: false,
      agent_transcript_path: "/a.jsonl",
      last_assistant_message: "STATUS: pass",
      background_tasks: o.background ?? BACKGROUND,
      session_crons: [],
    });
  }
  Object.assign(event, o.extra ?? {});
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [hook("verify.sh"), ...(o.handback ? ["--handback"] : []), `--recent-ms=${GUARD_MS}`], {
      env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: s.dir, TMPDIR: s.tmp, ORCH_TEST_CMD: o.cmd, ...o.env },
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({ status, signal, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(event));
    if (o.onStart && child.pid) o.onStart(child.pid);
  });
}

/** @param {Repo} s */
const PASS = (s) => `echo run >> '${s.counter}'; true`;
/** @param {Repo} s */
const FAIL = (s) => `echo run >> '${s.counter}'; echo 'not ok 1 - boom'; exit 1`;
/** @param {Repo} s */
const SLOW = (s) => `echo run >> '${s.counter}'; sleep 30`;

describe("verify.sh: every implementer stop leaves a record its stop can be paired with", { concurrency: 6 }, () => {
  // One case per kind of hand-back gate record seen at the 30 stops of session 66cac1f1 that had no stop record, and a
  // stop with no hand-back. The last running subagent the stop event lists is a reviewer in every case (it was in all 30).
  /** @type {Array<{ name: string, handback?: { reason: string, cmd: (s: Repo) => string, env?: Record<string, string> }, stopCmd: (s: Repo) => string, env?: Record<string, string>, lock?: boolean, want: [string, string] }>} */
  const KINDS = [
    { name: "no hand-back", stopCmd: PASS, want: ["allow", "tests_passed"] },
    { name: "after a tests_passed hand-back", handback: { reason: "tests_passed", cmd: PASS }, stopCmd: PASS, want: ["allow", "tests_passed_cached"] },
    { name: "after a tests_failed_isolated hand-back", handback: { reason: "tests_failed_isolated", cmd: FAIL }, stopCmd: FAIL, want: ["warn", "tests_failed_isolated"] },
    {
      name: "after a handback_timed_out hand-back",
      handback: { reason: "handback_timed_out", cmd: SLOW, env: { ORCH_TEST_TIMEOUT_S: "2", ORCH_HOOK_BUDGET_S: "60" } },
      stopCmd: SLOW,
      env: { ORCH_TEST_TIMEOUT_S: "2", ORCH_HOOK_BUDGET_S: "60" },
      want: ["warn", "tests_failed_isolated"],
    },
    {
      name: "after a handback_lock_wait hand-back",
      handback: { reason: "handback_lock_wait", cmd: PASS, env: { ORCH_HOOK_BUDGET_S: "8" } },
      stopCmd: PASS,
      env: { ORCH_HOOK_BUDGET_S: "8" },
      lock: true,
      want: ["warn", "tests_failed_isolated"],
    },
  ];
  for (const k of KINDS) {
    test(`${k.name}: a stop whose event lists a reviewer last is the implementer's stop and leaves its record`, async () => {
      const s = await setup();
      /** @type {import("node:child_process").ChildProcess | null} */
      let holder = null;
      try {
        if (k.lock) {
          // Another gate holds the project's suite lock (a live process, a fresh lock): this gate waits until its floor.
          holder = spawn("sleep", ["120"], { stdio: "ignore" });
          writeFileSync(join(s.dir, ".claude", "state", "test-gate.lock"), `${holder.pid} ${Math.floor(Date.now() / 1000)}\n`);
        }
        if (k.handback) {
          const hb = await verify(s, { handback: "toolu_H1", cmd: k.handback.cmd(s), env: k.handback.env });
          assert.equal(hb.status, 0, "the hand-back is let through");
          assert.deepEqual([records(s.dir).at(-1)?.at, records(s.dir).at(-1)?.reason], ["handback", k.handback.reason], "the hand-back gate's record");
        }
        const st = await verify(s, { cmd: k.stopCmd(s), env: k.env });
        assert.equal(st.status, 0, "an isolated stop never blocks");
        const mine = stopRecords(s.dir);
        assert.equal(mine.length, 1, "the stop wrote one test-gate record");
        assert.deepEqual([mine[0].decision, mine[0].reason, mine[0].agent_id, mine[0].session_id], [...k.want, "a1", "s1"]);
        if (k.handback) assert.equal(mine[0].after_handback, "toolu_H1", "keyed to the hand-back it follows");
        // run.mjs pairs it with the stop (rule 1 when keyed, the sole candidate otherwise).
        const stop = { ts: new Date().toISOString(), session_id: "s1", agent_type: "implementer", agent_id: "a1", hook_event_name: "SubagentStop", ...(k.handback ? { after_handback: "toolu_H1" } : {}) };
        const start = { ts: new Date(Date.now() - 60000).toISOString(), session_id: "s1", agent_type: "implementer", agent_id: "a1", hook_event_name: "SubagentStart" };
        const paired = implementerTestStates([start, stop], records(s.dir), "s1").get("a1")?.stopGate;
        assert.equal(paired?.reason, k.want[1], "stopGateOf pairs the record with the stop");
      } finally {
        holder?.kill();
        rmSync(s.base, { recursive: true, force: true });
      }
    });
  }

  test("the shared tree: failing tests at a stop listed with a reviewer last still block with tests_failed", async () => {
    const s = await setup();
    try {
      const st = await verify(s, { cwd: s.dir, cmd: FAIL(s) });
      assert.equal(st.status, 2, "blocked");
      assert.match(st.stderr, /^Acceptance gate failed: /);
      assert.deepEqual(stopRecords(s.dir).map((r) => [r.decision, r.reason]), [["block", "tests_failed"]]);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("the agent's own fields win over the same keys nested deeper in the event", async () => {
    const s = await setup();
    try {
      const nested = [...BACKGROUND, { id: "x", type: "subagent", agent_type: "implementer", agent_id: "zz9", session_id: "other", cwd: "/" }];
      const st = await verify(s, { cmd: PASS(s), background: nested });
      assert.equal(st.status, 0);
      assert.deepEqual(stopRecords(s.dir).map((r) => [r.reason, r.agent_id, r.session_id]), [["tests_passed", "a1", "s1"]]);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("a stop gate ended by a TERM (Claude Code's hook timeout) logs test_gate_error and lets the agent finish", async () => {
    const s = await setup();
    try {
      /** @type {number} */
      let pid = 0;
      const done = verify(s, { cmd: SLOW(s), background: [], onStart: (p) => (pid = p) });
      const deadline = Date.now() + 20000;
      while (runs(s) === 0 && Date.now() < deadline) await pause(50);
      assert.equal(runs(s), 1, "the suite started");
      process.kill(pid, "SIGTERM");
      const st = await done;
      assert.notEqual(st.status, 2, "a gate that did not decide never blocks");
      const mine = stopRecords(s.dir);
      assert.deepEqual(mine.map((r) => [r.decision, r.reason, r.interrupted]), [["allow", "test_gate_error", 1]]);
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });

  test("controls: another agent's stop writes nothing; malformed input exits 0", async () => {
    const s = await setup();
    try {
      const other = await verify(s, { cmd: PASS(s), extra: { agent_type: "reviewer" } });
      assert.equal(other.status, 0);
      assert.equal(runs(s), 0, "no suite ran");
      assert.deepEqual(records(s.dir), [], "no record: the reviewer's stop is not the test gate's");
      const bad = spawnSync("bash", [hook("verify.sh")], { input: "{not json", env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: s.dir, TMPDIR: s.tmp, ORCH_TEST_CMD: "true" }, encoding: "utf8" });
      assert.equal(bad.status, 0, "malformed input exits 0");
    } finally {
      rmSync(s.base, { recursive: true, force: true });
    }
  });
});

// Section 2: the plan check's reviewer hold.
/** A throwaway project with the plan check and its modules, the plan reviewed (legacy record) in session s1. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), "stop-gate-hold-"));
  const hooks = join(dir, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of ["state.mjs", "brief.mjs", "run.mjs", "plan-check.mjs", "builtin-agents.mjs"]) copyFileSync(hook(h), join(hooks, h));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  return dir;
}
/** @param {string} dir @param {string} name @param {Record<string, unknown>} rec */
function append(dir, name, rec) {
  writeFileSync(join(dir, ".claude", "state", name), `${JSON.stringify(rec)}\n`, { flag: "a" });
}
/** @param {number} sAgo seconds before now */
const ago = (sAgo) => new Date(Date.now() - sAgo * 1000).toISOString();
/** impl1 of slice a: plan reviewed, launched and started `startAgo` s ago, stopped `stopAgo` s ago. */
function implementer(/** @type {string} */ dir, startAgo = 1200, stopAgo = 30, extra = {}) {
  append(dir, "journal.jsonl", { ts: ago(startAgo + 60), session_id: "s1", slice: "plan", role: "reviewer", status: "pass", agent_id: "r0" });
  append(dir, "journal-launches.jsonl", { ts: ago(startAgo), session_id: "s1", agent_id: "impl1", agent_type: "implementer", slice: "a" });
  append(dir, "telemetry.jsonl", { ts: ago(startAgo), session_id: "s1", agent_type: "implementer", agent_id: "impl1", hook_event_name: "SubagentStart" });
  append(dir, "telemetry.jsonl", { ts: ago(stopAgo), session_id: "s1", agent_type: "implementer", agent_id: "impl1", hook_event_name: "SubagentStop", ...extra });
}
/** @param {string} dir @param {number} sAgo @param {string} decision @param {string} reason @param {Record<string, unknown>} [extra] */
function gate(dir, sAgo, decision, reason, extra = {}) {
  append(dir, "gates.jsonl", { ts: ago(sAgo), gate: "test", decision, reason, agent_type: "implementer", agent_id: "impl1", session_id: "s1", ...extra });
}
/** @param {Record<string, string>} [extra] */
function envWith(extra = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(ORCH_|CLAUDE_PLUGIN_OPTION_|CLAUDE_ASYNC_AGENT_STALL)/.test(k)) delete env[k];
  return { ...env, ORCH_SKILL_HINTS: "off", ...extra };
}
/** @param {string} dir @param {Record<string, string>} [env] */
const launch = (dir, env = {}) =>
  spawnSync("node", [join(dir, ".claude", "hooks", "plan-check.mjs")], {
    input: JSON.stringify({ session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "reviewer", prompt: REVIEW } }),
    env: { ...envWith(env), CLAUDE_PROJECT_DIR: dir },
    encoding: "utf8",
  });
/** @param {string} dir @returns {any[]} */
const holds = (dir) => {
  const p = join(dir, ".claude", "state", "review-hold.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};
const REVIEW = "SLICE: a\nReview the diff.";
/** The note the launch carries (what the plan check appended to the brief), or "" when it added nothing. @param {ReturnType<typeof launch>} r */
const noteOf = (r) => (r.stdout ? String(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.prompt).slice(REVIEW.length) : "");

describe("plan check: pending only while the test gate may still run", () => {
  test("the window is the gate's budget plus its worst-case overrun: 540 s + 60 s by default, cut with the budget", () => {
    /** @type {(env: Record<string, string | undefined>) => number} */
    const stopGateWindowMs = /** @type {any} */ (runModule).stopGateWindowMs;
    assert.equal(typeof stopGateWindowMs, "function", "run.mjs exports stopGateWindowMs");
    assert.equal(stopGateWindowMs({}), 600_000);
    assert.equal(stopGateWindowMs({ ORCH_HOOK_BUDGET_S: "60" }), 120_000, "a smaller budget is kept");
    assert.equal(stopGateWindowMs({ ORCH_HOOK_BUDGET_S: "5000" }), 600_000, "a larger one is cut to the maximum");
    assert.equal(stopGateWindowMs({ CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: "1200000" }), 930_000, "870 s at most");
    assert.equal(stopGateWindowMs({ CLAUDE_ASYNC_AGENT_STALL_TIMEOUT_MS: "x" }), 600_000, "an unreadable stall limit reads as 600 s");
  });

  test("a recent stop with no record keeps the pending note", () => {
    const dir = project();
    try {
      implementer(dir, 1200, 30);
      const r = launch(dir);
      assert.equal(r.status, 0);
      assert.match(noteOf(r), /test gate has not reported yet/);
      assert.deepEqual(holds(dir).map((e) => e.reason), ["test_gate_pending"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a stop older than the gate can run, with no record, gets the no-result note, never the pending one", () => {
    const dir = project();
    try {
      implementer(dir, 3600, 20 * 60);
      const r = launch(dir);
      assert.equal(r.status, 0, "never refused");
      const note = noteOf(r);
      assert.doesNotMatch(note, /has not reported yet|may still fail/);
      assert.match(note, /test gate left no result/);
      assert.match(note, /Do not rest a pass on the tests having passed/);
      assert.doesNotMatch(note, SWITCH, "the note names no switch");
      const hd = parseHeader(note);
      const rp = parseReply(note);
      assert.ok(!hd.slice && !hd.files.length && !hd.checks.length && rp.status === null && !rp.open.length, "the note parses as no brief or reply line");
      assert.deepEqual(holds(dir).map((e) => [e.decision, e.reason, e.slice, e.agent_id]), [["note", "test_gate_no_result", "a", "impl1"]]);
      // With a smaller budget the window is shorter: a stop 3 minutes old is past it.
      const dir2 = project();
      try {
        implementer(dir2, 3600, 180);
        assert.match(noteOf(launch(dir2)), /has not reported yet/, "default window: still pending");
        assert.match(noteOf(launch(dir2, { ORCH_HOOK_BUDGET_S: "60" })), /test gate left no result/);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a test_gate_error record of the stop gives the no-result note, never a silent pass", () => {
    const dir = project();
    try {
      implementer(dir, 1200, 30, { after_handback: "toolu_1" });
      gate(dir, 20, "allow", "test_gate_error", { after_handback: "toolu_1", interrupted: 1 });
      const r = launch(dir);
      assert.equal(r.status, 0);
      assert.match(noteOf(r), /test gate left no result/);
      assert.deepEqual(holds(dir).map((e) => e.reason), ["test_gate_no_result"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failed-tests block of an old stop still refuses with tests_failed_after_report; a pass adds nothing", () => {
    const dir = project();
    try {
      implementer(dir, 3600, 20 * 60);
      gate(dir, 19 * 60, "block", "tests_failed", { failing: 2 });
      const r = launch(dir);
      assert.equal(r.status, 2);
      assert.match(r.stderr, /tests failed after the worker had reported/);
      const dir2 = project();
      try {
        implementer(dir2, 3600, 20 * 60);
        gate(dir2, 19 * 60, "allow", "tests_passed");
        assert.deepEqual([launch(dir2).status, launch(dir2).stdout], [0, ""]);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
