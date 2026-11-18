// 2.0.1: findings of the gate soak (scripts/soak-gates.mjs; docs/data/probes-2.0.1-soak.md). One test per defect, each
// driving the real hooks in a throwaway project and state dir, each seen failing against the hooks before its fix:
//   S1 (item a)  quote-check.mjs: an unreadable or unwritable quotes log never refuses a researcher twice.
//   S2 (item b)  journal.mjs: an implementer woken after its delivered report (a late shell, a typed prompt) adds no attempt.
//   S3 (item c)  journal.mjs: a reviewer resumed with SendMessage whose new report has its STATUS line only in the
//                transcript, or none, is a new review, not dropped as a wake.
//   S4           journal.mjs: a resumed reviewer whose text turn is held back and handed back (the continued stop) is a
//                new review, not a replacement of its earlier one.
//   S5           verify.sh: an implementer stop with no agent id is blocked at most twice per session.
//   S6           plan-check.mjs, review-gate.mjs: a refusal whose log cannot be read or written back is not made (no
//                refusal without a cap).
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentReviews } from "../.claude/hooks/brief.mjs";
import { sessionRuns } from "../.claude/hooks/run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = (/** @type {string} */ name) => join(root, ".claude", "hooks", name);
const SECRET = "soak-findings-report-text";
/** @type {Record<string, string>} */
const baseEnv = Object.fromEntries(
  Object.entries(process.env).filter(/** @returns {e is [string, string]} */ (e) => e[1] !== undefined && !/^(ORCH_|CLAUDE_PLUGIN_|CLAUDE_ASYNC_AGENT_STALL|GIT_|NODE_OPTIONS$|NODE_TEST)/.test(e[0])),
);

function project() {
  const dir = mkdtempSync(join(tmpdir(), "orch-soak-findings-"));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  mkdirSync(join(dir, "tmp"));
  writeFileSync(join(dir, "src.txt"), "the quick brown fox\n");
  return dir;
}

/** A preload that makes reads (`full`: whole-file, `tail`: by fd) or writes of one state log fail. @param {string} dir */
function faultPreload(dir) {
  const f = join(dir, "fault.mjs");
  writeFileSync(
    f,
    [
      'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";',
      'const f = JSON.parse(process.env.SOAK_FAULT || "null");',
      "if (f) {",
      '  const hit = (p) => typeof p === "string" && p.endsWith("/" + f.file);',
      '  const err = () => Object.assign(new Error("EACCES"), { code: "EACCES" });',
      "  if (f.full) { const o = fs.readFileSync; fs.readFileSync = (p, ...a) => { if (hit(p)) throw err(); return o(p, ...a); }; }",
      '  if (f.tail) { const o = fs.openSync; fs.openSync = (p, fl, ...a) => { if (hit(p) && (fl === undefined || fl === "r")) throw err(); return o(p, fl, ...a); }; }',
      '  if (f.write) for (const k of ["appendFileSync", "writeFileSync"]) { const o = fs[k]; fs[k] = (p, ...a) => { if (hit(p)) throw err(); return o(p, ...a); }; }',
      "  syncBuiltinESMExports();",
      "}",
    ].join("\n"),
  );
  return f;
}

/**
 * One hook call. `fault`: the state log and the reads or writes that fail (through NODE_OPTIONS, so node helpers of
 * verify.sh get it too).
 * @param {string} dir @param {string} script @param {unknown} payload
 * @param {{ env?: Record<string, string>, fault?: { file: string, full?: boolean, tail?: boolean, write?: boolean }, args?: string[] }} [o]
 */
function run(dir, script, payload, o = {}) {
  const sh = script.endsWith(".sh");
  const env = {
    ...baseEnv,
    CLAUDE_PROJECT_DIR: dir,
    CLAUDE_PLUGIN_ROOT: "",
    TMPDIR: join(dir, "tmp"),
    ORCH_SKILL_HINTS: "off",
    ...(o.fault ? { NODE_OPTIONS: `--import ${pathToFileURL(faultPreload(dir)).href}`, SOAK_FAULT: JSON.stringify(o.fault) } : {}),
    ...o.env,
  };
  const input = JSON.stringify({ session_id: "s1", ...(/** @type {object} */ (payload)) });
  const r = sh ? spawnSync("bash", [hook(script), ...(o.args ?? [])], { input, env, cwd: dir, encoding: "utf8" }) : spawnSync(process.execPath, [hook(script), ...(o.args ?? [])], { input, env, cwd: dir, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** @param {string} dir @param {string} name @returns {any[]} */
const log = (dir, name) => {
  const f = join(dir, ".claude", "state", name);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } }) : [];
};
const pause = (/** @type {number} */ ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// ---- S1: quote check with an unreadable or unwritable quotes log ----

test("S1 quote check: an unreadable quotes log never refuses a researcher twice at its hand-back", () => {
  for (const fault of [{ file: "quotes.jsonl", full: true }, { file: "quotes.jsonl", full: true, tail: true }]) {
    const dir = project();
    try {
      const payload = { hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_use_id: "toolu_q", tool_input: { message: `STATUS: pass\nQUOTE: src.txt:1 | words that are not there\n${SECRET}\nOPEN: none` }, agent_id: "q1", agent_type: "researcher" };
      const codes = [1, 2, 3].map(() => run(dir, "quote-check.mjs", payload, { fault }).code);
      assert.ok(codes.every((c) => c === 0 || c === 2), `exits 0 or 2: ${codes}`);
      assert.ok(codes.filter((c) => c === 2).length <= 1, `refused at most once with ${JSON.stringify(fault)}, got ${codes.join(",")}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("S1 quote check: an unwritable quotes log never refuses a researcher's stop twice", () => {
  const dir = project();
  try {
    const payload = { hook_event_name: "SubagentStop", stop_hook_active: false, agent_id: "q1", agent_type: "researcher", last_assistant_message: `STATUS: pass\nQUOTE: src.txt:1 | words that are not there\n${SECRET}\nOPEN: none`, agent_transcript_path: join(dir, "missing.jsonl") };
    const codes = [1, 2, 3].map((n) => run(dir, "quote-check.mjs", { ...payload, stop_hook_active: n > 1 }, { fault: { file: "quotes.jsonl", write: true } }).code);
    assert.ok(codes.filter((c) => c === 2).length <= 1, `refused at most once, got ${codes.join(",")}`);
    // Control: with a writable log the first stop is refused once, the next ones pass.
    const dir2 = project();
    try {
      assert.deepEqual([1, 2, 3].map((n) => run(dir2, "quote-check.mjs", { ...payload, stop_hook_active: n > 1 }).code), [2, 0, 0]);
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- S2 to S4: a session of real hooks (journal, telemetry, handback-check) with subagent transcripts ----

const PLAN_BRIEF = "PLAN REVIEW\nSLICE: x\nFILES: x.txt\nDEPENDS: none\nGOAL: x";
const WAKE = `That background search only finished now, after my report was delivered. ${SECRET}`;

/** A session driven through the real hooks; each agent has a transcript (null: headless, no transcript). @param {{ headless?: boolean }} [o] */
function session(o = {}) {
  const dir = project();
  const env = { ORCH_ESCALATION: "off" };
  let n = 0;
  const hk = (/** @type {string} */ script, /** @type {object} */ payload) => {
    const r = run(dir, script, payload, { env });
    pause(3); // records of separate steps never share a millisecond
    return r;
  };
  /** @param {string} id */
  const tpath = (id) => (o.headless ? join(dir, "missing.jsonl") : join(dir, `${id}.jsonl`));
  /** @param {string} id @param {any[]} recs */
  const write = (id, recs) => {
    if (!o.headless) appendFileSync(tpath(id), recs.map((r) => `${JSON.stringify({ timestamp: new Date().toISOString(), ...r })}\n`).join(""));
  };
  const text = (/** @type {string} */ t) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t }] } });
  const s = {
    dir,
    /** @param {string} type @param {string} prompt */
    launch(type, prompt) {
      const id = `ag${++n}`;
      write(id, [{ type: "user", message: { role: "user", content: prompt } }]);
      hk("telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: id, agent_type: type });
      hk("journal.mjs", { hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: type, prompt }, tool_response: { status: "async_launched", agentId: id } });
      return id;
    },
    /** @param {string} id @param {string} type */
    start(id, type) {
      hk("telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: id, agent_type: type });
    },
    /** @param {string} id @param {string} type @param {{ last?: string, active?: boolean }} [o2] */
    stop(id, type, o2 = {}) {
      const p = { hook_event_name: "SubagentStop", agent_id: id, agent_type: type, stop_hook_active: o2.active === true, agent_transcript_path: tpath(id), ...(o2.last !== undefined ? { last_assistant_message: o2.last } : {}) };
      hk("telemetry.mjs", p);
      hk("journal.mjs", p);
    },
    /** @param {string} id @param {string} type @param {string} message */
    handback(id, type, message) {
      const tu = `toolu_${++n}`;
      write(id, [{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: tu, name: "SubagentHandback", input: { message } }] } }]);
      return hk("handback-check.mjs", { hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_use_id: tu, tool_input: { message }, agent_id: id, agent_type: type });
    },
    /** A text turn in the transcript. @param {string} id @param {string} t */
    say(id, t) {
      write(id, [text(t)]);
    },
    /** A tool call of the agent (it works). @param {string} id @param {string} name */
    tool(id, name) {
      write(id, [{ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `tu${++n}`, name, input: { file_path: join(dir, "x.txt"), command: "true" } }] } }, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu${n}`, content: "ok" }] } }]);
    },
    /** What wakes a finished agent: a late background shell's notification, or a typed prompt. @param {string} id @param {"shell" | "prompt"} by */
    wakeBy(id, by) {
      write(id, [by === "shell" ? { type: "user", message: { role: "user", content: "<task-notification><status>completed</status></task-notification>" } } : { type: "user", origin: { kind: "human" }, message: { role: "user", content: "continue" } }]);
    },
    /** The coordinator's SendMessage, as a resumed subagent's transcript holds it. @param {string} id */
    resumeMsg(id) {
      write(id, [{ type: "user", isMeta: true, origin: { kind: "coordinator" }, message: { role: "user", content: "Please review the retry and report again." } }]);
    },
    slice() {
      return sessionRuns("s1", { dir: join(dir, ".claude", "state"), env }).latest?.slices.x;
    },
    /** Plan reviewed; one implementer that hands back and stops; one reviewer that hands back `report` and stops. @param {string} report */
    reviewed(report) {
      const p = s.launch("reviewer", PLAN_BRIEF);
      s.stop(p, "reviewer", { last: "STATUS: pass\nOPEN: none" });
      const i = s.launch("implementer", "SLICE: x\nFILES: x.txt\nDEPENDS: none");
      s.tool(i, "Edit");
      assert.equal(s.handback(i, "implementer", `STATUS: pass\n${SECRET}\nOPEN: none`).code, 0);
      s.stop(i, "implementer");
      const r = s.launch("reviewer", "SLICE: x");
      assert.equal(s.handback(r, "reviewer", report).code, 0);
      s.stop(r, "reviewer");
      return { i, r };
    },
  };
  return s;
}

test("S2 journal: an implementer woken after its delivered hand-back adds no attempt and keeps the review current", () => {
  for (const by of /** @type {const} */ (["shell", "prompt"])) {
    for (const withStart of [true, false]) {
      const s = session();
      try {
        const { i } = s.reviewed(`STATUS: pass\n${SECRET}\nOPEN: none`);
        const before = s.slice();
        assert.deepEqual([before?.attempts, before && currentReviews(before).length], [1, 1]);
        if (withStart) s.start(i, "implementer");
        s.wakeBy(i, by);
        s.say(i, WAKE);
        s.stop(i, "implementer", { last: WAKE });
        const after = s.slice();
        assert.ok(after);
        assert.equal(after.attempts, 1, `woken by ${by}${withStart ? " with a start" : ""}: no new attempt`);
        assert.equal(currentReviews(after).length, 1, "the delivered review still reviews the latest attempt");
      } finally {
        rmSync(s.dir, { recursive: true, force: true });
      }
    }
  }
});

test("S2 controls: a resumed implementer that works, or reports, is a new attempt", () => {
  for (const shape of ["works", "reports"]) {
    const s = session();
    try {
      const { i } = s.reviewed(`STATUS: fail\nGAP: 90 x.txt:1 broken\n${SECRET}\nOPEN: none`);
      s.start(i, "implementer");
      s.resumeMsg(i);
      if (shape === "works") {
        s.tool(i, "Edit");
        s.say(i, "Fixed it.");
        s.stop(i, "implementer", { last: "Fixed it." });
      } else {
        s.say(i, `STATUS: pass\n${SECRET}\nOPEN: none`);
        s.stop(i, "implementer", { last: `STATUS: pass\n${SECRET}\nOPEN: none` });
      }
      const x = s.slice();
      assert.equal(x?.attempts, 2, shape);
      assert.equal(x && currentReviews(x).length, 0, `${shape}: the retry is unreviewed`);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  }
});

test("S3 journal: a resumed reviewer whose new report has its STATUS line only in the transcript, or none, is a new review", () => {
  // STATUS only in the transcript: a report turn, then a closing text turn with no STATUS line.
  let s = session();
  try {
    const { r } = s.reviewed(`STATUS: fail\nGAP: 90 x.txt:1 broken\n${SECRET}\nOPEN: none`);
    s.start(r, "reviewer");
    s.resumeMsg(r);
    s.say(r, `STATUS: pass\n${SECRET}\nOPEN: none`);
    s.say(r, "Done; the report is above.");
    s.stop(r, "reviewer", { last: "Done; the report is above." });
    assert.deepEqual(s.slice()?.reviews.map((v) => v.status), ["fail", "pass"]);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
  // No STATUS line at all: a review with no status (the gate then asks for a rerun), never the old verdict standing.
  s = session();
  try {
    const { r } = s.reviewed(`STATUS: pass\n${SECRET}\nOPEN: none`);
    s.start(r, "reviewer");
    s.resumeMsg(r);
    s.say(r, `I found another problem in the parser. ${SECRET}`);
    s.stop(r, "reviewer", { last: `I found another problem in the parser. ${SECRET}` });
    assert.deepEqual(s.slice()?.reviews.map((v) => v.status), ["pass", null]);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
  // Control: a wake (no coordinator message after the delivered report) still adds nothing, even with an old STATUS line
  // in the transcript.
  s = session();
  try {
    const { r } = s.reviewed(`STATUS: pass\n${SECRET}\nOPEN: none`);
    s.say(r, `STATUS: pass\n${SECRET}\nOPEN: none`);
    s.start(r, "reviewer");
    s.wakeBy(r, "shell");
    s.say(r, WAKE);
    s.stop(r, "reviewer", { last: WAKE });
    assert.deepEqual(s.slice()?.reviews.map((v) => v.status), ["pass"]);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("S4 journal: a resumed reviewer's text turn held back and handed back is a new review of the retry, not a replacement", () => {
  for (const headless of [false, true]) {
    const s = session({ headless });
    try {
      const { i, r } = s.reviewed(`STATUS: fail\nGAP: 90 x.txt:1 broken\n${SECRET}\nOPEN: none`);
      // The retry: the implementer is resumed, works and hands back again.
      s.start(i, "implementer");
      s.resumeMsg(i);
      s.tool(i, "Edit");
      assert.equal(s.handback(i, "implementer", `STATUS: pass\n${SECRET}\nOPEN: none`).code, 0);
      s.stop(i, "implementer");
      // The reviewer is resumed, ends with a text turn (held back by Claude Code), then hands back and stops again.
      s.start(r, "reviewer");
      s.resumeMsg(r);
      s.say(r, "Let me sum up.");
      s.stop(r, "reviewer", { last: "Let me sum up." });
      assert.equal(s.handback(r, "reviewer", `STATUS: pass\n${SECRET}\nOPEN: none`).code, 0);
      s.stop(r, "reviewer", { active: true });
      const x = s.slice();
      assert.ok(x);
      assert.deepEqual(x.reviews.map((v) => v.status), ["fail", "pass"], `headless ${headless}: two reviews`);
      assert.deepEqual(currentReviews(x).map((v) => v.status), ["pass"], `headless ${headless}: the retry is reviewed`);
    } finally {
      rmSync(s.dir, { recursive: true, force: true });
    }
  }
});

// ---- S5: the test gate with no agent id ----

test("S5 test gate: an implementer stop with no agent id is blocked at most twice per session", () => {
  const dir = project();
  try {
    const payload = { hook_event_name: "SubagentStop", stop_hook_active: false, agent_type: "implementer", cwd: dir, last_assistant_message: "STATUS: pass", background_tasks: [] };
    const env = { ORCH_TEST_CMD: "echo 'not ok 1 - soak'; exit 1", ORCH_HOOK_BUDGET_S: "30" };
    const codes = [1, 2, 3, 4].map((n) => run(dir, "verify.sh", { ...payload, stop_hook_active: n > 1 }, { env }).code);
    assert.deepEqual(codes, [2, 2, 0, 0], "two blocks, then let through");
    assert.deepEqual(log(dir, "gates.jsonl").map((g) => [g.decision, g.reason]), [["block", "tests_failed"], ["block", "tests_failed"], ["allow", "max_blocks_reached"], ["allow", "max_blocks_reached"]]);
    // Control: an agent with an id keeps its own count (a resume starts it again).
    const withId = [1, 2, 3].map(() => run(dir, "verify.sh", { ...payload, agent_id: "i9" }, { env }).code);
    assert.deepEqual(withId, [2, 2, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- S6: a refusal whose own log cannot be read or written is not made ----

/** Plan reviewed, one implementer of slice x launched and stopped, nothing reviewed. @param {string} dir */
function implementerStopped(dir) {
  const env = { ORCH_ESCALATION: "off" };
  run(dir, "journal.mjs", { hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: "reviewer", prompt: PLAN_BRIEF }, tool_response: { status: "async_launched", agentId: "p1" } }, { env });
  run(dir, "journal.mjs", { hook_event_name: "SubagentStop", agent_id: "p1", agent_type: "reviewer", stop_hook_active: false, last_assistant_message: "STATUS: pass\nOPEN: none" }, { env });
  run(dir, "telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: "i1", agent_type: "implementer" }, { env });
  run(dir, "journal.mjs", { hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: "implementer", prompt: "SLICE: x\nFILES: x.txt\nDEPENDS: none" }, tool_response: { status: "async_launched", agentId: "i1" } }, { env });
  pause(3);
  for (const h of ["telemetry.mjs", "journal.mjs"]) run(dir, h, { hook_event_name: "SubagentStop", agent_id: "i1", agent_type: "implementer", stop_hook_active: false, last_assistant_message: "STATUS: pass\nOPEN: none" }, { env });
  pause(3);
}

test("S6 review gate: a gates log it cannot read, or cannot write, never blocks the reply more than twice", () => {
  for (const fault of [{ file: "gates.jsonl", full: true }, { file: "gates.jsonl", write: true }]) {
    const dir = project();
    try {
      implementerStopped(dir);
      const codes = [1, 2, 3, 4].map(() => run(dir, "review-gate.mjs", { hook_event_name: "Stop", stop_hook_active: false, background_tasks: [] }, { env: { ORCH_ESCALATION: "off" }, fault }).code);
      assert.ok(codes.every((c) => c === 0 || c === 2));
      assert.ok(codes.filter((c) => c === 2).length <= 2, `${JSON.stringify(fault)}: at most two blocks, got ${codes.join(",")}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  // Control: a readable log blocks twice, then gives up with the unverified note.
  const dir = project();
  try {
    implementerStopped(dir);
    const rs = [1, 2, 3].map(() => run(dir, "review-gate.mjs", { hook_event_name: "Stop", stop_hook_active: false, background_tasks: [] }, { env: { ORCH_ESCALATION: "off" } }));
    assert.deepEqual(rs.map((r) => r.code), [2, 2, 0]);
    assert.match(rs[2]?.stdout ?? "", /unverified/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S6 plan check: a plan-check log it cannot read, or cannot write, never blocks a launch more than twice", () => {
  const launch = { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "implementer", prompt: "SLICE: zz\nFILES: zz.txt\nDEPENDS: none" } };
  for (const fault of [{ file: "plan-check.jsonl", full: true }, { file: "plan-check.jsonl", write: true }]) {
    const dir = project();
    try {
      implementerStopped(dir);
      const codes = [1, 2, 3, 4].map(() => run(dir, "plan-check.mjs", launch, { fault }).code);
      assert.ok(codes.filter((c) => c === 2).length <= 2, `${JSON.stringify(fault)}: at most two blocks, got ${codes.join(",")}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const dir = project();
  try {
    implementerStopped(dir);
    assert.deepEqual([1, 2, 3].map(() => run(dir, "plan-check.mjs", launch).code), [2, 2, 0], "control: not_in_plan twice, then let through");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S6 reviewer hold: a hold log it cannot read never refuses a reviewer more than twice", () => {
  const dir = project();
  try {
    implementerStopped(dir);
    appendFileSync(join(dir, ".claude", "state", "gates.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), gate: "test", decision: "block", reason: "tests_failed", agent_type: "implementer", agent_id: "i1", session_id: "s1" })}\n`);
    const launch = { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "reviewer", prompt: "SLICE: x\nReview it." } };
    const codes = [1, 2, 3, 4].map(() => run(dir, "plan-check.mjs", launch, { fault: { file: "review-hold.jsonl", full: true } }).code);
    assert.ok(codes.filter((c) => c === 2).length <= 2, `at most two refusals, got ${codes.join(",")}`);
    assert.deepEqual([1, 2, 3].map(() => run(dir, "plan-check.mjs", launch).code).filter((c) => c === 2).length <= 2, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- S7: the test gate on input that is not a hook event ----

test("S7 test gate: input that is not a JSON object exits 0 and runs nothing, even with failing tests", () => {
  const dir = project();
  try {
    const env = { ORCH_TEST_CMD: `echo run >> '${join(dir, "runs.txt")}'; exit 1`, ORCH_HOOK_BUDGET_S: "30" };
    for (const raw of ["null", "[1,2]", '"x"', "{not json", "", "42"]) {
      for (const args of [[], ["--handback"]]) {
        const r = spawnSync("bash", [hook("verify.sh"), ...args], { input: raw, env: { ...baseEnv, CLAUDE_PROJECT_DIR: dir, TMPDIR: join(dir, "tmp"), ...env }, cwd: dir, encoding: "utf8" });
        assert.equal(r.status, 0, `${JSON.stringify(raw)} ${args.join(" ")}: exit 0`);
      }
    }
    assert.equal(existsSync(join(dir, "runs.txt")), false, "no test run");
    assert.deepEqual(log(dir, "gates.jsonl"), [], "no record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- S8: the test gate's block count when one reader of gates.jsonl fails ----

test("S8 test gate: with the whole-file read of gates.jsonl failing, one agent is blocked twice, then let through", () => {
  const dir = project();
  try {
    run(dir, "telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: "i8", agent_type: "implementer" });
    pause(5);
    const env = { ORCH_TEST_CMD: "echo 'not ok 1 - soak'; exit 1", ORCH_HOOK_BUDGET_S: "30" };
    const payload = { hook_event_name: "SubagentStop", agent_id: "i8", agent_type: "implementer", cwd: dir, last_assistant_message: "STATUS: pass", background_tasks: [] };
    const codes = [1, 2, 3, 4, 5].map((n) => run(dir, "verify.sh", { ...payload, stop_hook_active: n > 1 }, { env, fault: { file: "gates.jsonl", full: true } }).code);
    assert.deepEqual(codes, [2, 2, 0, 0, 0], "two blocks, then the cap's give-up");
    assert.deepEqual(log(dir, "gates.jsonl").map((g) => [g.decision, g.reason]), [["block", "tests_failed"], ["block", "tests_failed"], ["allow", "max_blocks_reached"], ["allow", "max_blocks_reached"], ["allow", "max_blocks_reached"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- S9: the id-less count with a NUL byte in gates.jsonl ----

test("S9 test gate: a NUL byte in gates.jsonl does not reset the cap of a stop with no agent id", () => {
  const dir = project();
  try {
    writeFileSync(join(dir, ".claude", "state", "gates.jsonl"), "\u0000garbage line\n");
    const env = { ORCH_TEST_CMD: "echo 'not ok 1 - soak'; exit 1", ORCH_HOOK_BUDGET_S: "30" };
    const payload = { hook_event_name: "SubagentStop", agent_type: "implementer", cwd: dir, last_assistant_message: "STATUS: pass", background_tasks: [] };
    const codes = [1, 2, 3, 4].map((n) => run(dir, "verify.sh", { ...payload, stop_hook_active: n > 1 }, { env }).code);
    assert.deepEqual(codes, [2, 2, 0, 0], "two blocks, then the cap's give-up");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
