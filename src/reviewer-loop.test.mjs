// 2.0.1: the reviewer that goes on after its report reached the orchestrator (diagnosis:
// docs/data/probes-2.0.1-reviewer-loop.md). One test per defect, each run against the real hooks or the real fold:
//   D1/D2  the worker bodies tell a worker to deliver its report once through SubagentHandback and to leave no shell
//          task behind that could wake it after delivery; the orchestrator, the route skill and the nudge say a late
//          `completed` notification of a delivered worker is not a new report.
//   D3     handback-check.mjs never denies when it cannot read earlier denials, and never logs a denial it does not return.
//   D4     a continued reviewer stop (`continues: true`) replaces that reviewer's review and keeps its attempt, even when an
//          implementer of the slice stopped between the two stops.
//   D6     telemetry.jsonl holds no report text (last_assistant_message).
//   H6     a reviewer woken after its delivered hand-back (a late background shell, a typed prompt) that stops again with
//          no new hand-back and no STATUS line adds no review: neither a copy of the delivered one nor an empty one.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { currentReviews, foldRuns } from "../.claude/hooks/brief.mjs";
import { sessionRuns } from "../.claude/hooks/run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = (/** @type {string} */ name) => join(root, ".claude", "hooks", name);
const read = (/** @type {string} */ rel) => readFileSync(join(root, rel), "utf8");
const SECRET = "the-report-body-must-never-be-logged";
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCH_") && !k.startsWith("CLAUDE_PLUGIN_")));

function project() {
  const dir = mkdtempSync(join(tmpdir(), "orch-reviewer-loop-"));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  return dir;
}
/** @param {string} dir @param {string} script @param {unknown} payload @param {{ env?: Record<string, string>, preload?: string }} [o] */
function run(dir, script, payload, o = {}) {
  const args = [...(o.preload ? ["--import", pathToFileURL(o.preload).href] : []), hook(script)];
  const r = spawnSync(process.execPath, args, { input: JSON.stringify({ session_id: "s1", ...(/** @type {object} */ (payload)) }), env: { ...baseEnv, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: "", ...o.env }, cwd: dir, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** @param {string} dir @param {string} name @returns {any[]} */
const log = (dir, name) => {
  const f = join(dir, ".claude", "state", name);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
/** The body of an agent file (after its frontmatter). @param {string} rel */
const body = (rel) => read(rel).replace(/^---\n[\s\S]*?\n---\n/, "");

// ---- D1 / D2: the wording ----

const WORKERS = [".claude/agents/reviewer.md", ".claude/agents/researcher.md", ".claude/agents/implementer.md", ".claude/agents/integrator.md"];

test("D2 bodies: every worker body and the conventions skill deliver the report once through SubagentHandback when it is offered", () => {
  for (const f of [...WORKERS, ".claude/skills/orchestration-conventions/SKILL.md"]) {
    const text = f.endsWith(".md") && f.includes("/agents/") ? body(f) : read(f);
    assert.match(text, /`SubagentHandback` tool is offered/, `${f}: names the hand-back tool`);
    assert.match(text, /deliver (?:your|the) report once through it/i, `${f}: once, through the tool`);
    assert.match(text, /no further tool call/i, `${f}: nothing after delivery`);
    assert.match(text, /not offered, (?:your|the) report is (?:your|the) last message/i, `${f}: the plain reply without the tool`);
  }
});

test("D1 bodies: every worker body forbids a shell task that outlives its report", () => {
  for (const f of WORKERS) {
    const text = body(f);
    assert.match(text, /moved to the background/i, `${f}: a long command moved to the background`);
    assert.match(text, /wait for its (?:result|output) before (?:you )?report/i, `${f}: wait for it before reporting`);
    assert.match(text, /600000/, `${f}: a Bash timeout up to 600000 ms`);
    assert.match(text, /never start a background (?:shell )?task on purpose/i, `${f}: never on purpose`);
  }
});

test("D1 orchestrator, route skill and nudge: a late completed notification of a delivered worker is not a new report", () => {
  for (const f of [".claude/agents/orchestrator.md", ".claude/skills/route/SKILL.md", ".claude/hooks/nudge.mjs"]) {
    assert.match(read(f), /`completed` notification from a worker that already (?:handed back|delivered) its report is not a new report/, f);
    assert.match(read(f), /no new review, retry or reply/, f);
  }
});

// ---- D3: hand-back check with an unreadable log ----

/** A preload that makes reads of gates.jsonl throw: the whole-file read (NOREAD_FULL=1) and the read by fd (NOREAD_TAIL=1). @param {string} dir */
function preload(dir) {
  const f = join(dir, "noread.mjs");
  writeFileSync(
    f,
    [
      'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";',
      "const full = process.env.NOREAD_FULL === '1', tail = process.env.NOREAD_TAIL === '1';",
      "const rf = fs.readFileSync, op = fs.openSync;",
      "if (full) fs.readFileSync = (p, ...a) => { if (String(p).endsWith('gates.jsonl')) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return rf(p, ...a); };",
      "if (tail) fs.openSync = (p, fl, ...a) => { if (String(p).endsWith('gates.jsonl') && fl === 'r') throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return op(p, fl, ...a); };",
      "syncBuiltinESMExports();",
    ].join("\n"),
  );
  return f;
}

test("D3 handback check: an unreadable gates log never denies twice, and every deny record is a denial returned", () => {
  const cases = [
    { name: "full read fails, tail read works", full: "1", tail: "0" },
    { name: "both reads fail", full: "1", tail: "1" },
    { name: "full read works, tail read fails", full: "0", tail: "1" },
  ];
  for (const c of cases) {
    const dir = project();
    try {
      const pre = preload(dir);
      const payload = { hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_input: { message: `Looks fine.\n${SECRET}` }, agent_id: "a1", agent_type: "orchestration:reviewer" };
      const codes = [1, 2, 3].map(() => run(dir, "handback-check.mjs", payload, { preload: pre, env: { NOREAD_FULL: c.full, NOREAD_TAIL: c.tail } }).code);
      const denies = log(dir, "gates.jsonl").filter((g) => g.gate === "handback" && g.decision === "deny");
      assert.ok(codes.filter((x) => x === 2).length <= 1, `${c.name}: denied at most once, got ${codes.join(",")}`);
      assert.equal(denies.length, codes.filter((x) => x === 2).length, `${c.name}: one deny record per denial returned (codes ${codes.join(",")}, deny records ${denies.length})`);
      if (c.full === "1") assert.deepEqual(codes, [0, 0, 0], `${c.name}: earlier denials unreadable, so no denial`);
      assert.ok(!readFileSync(join(dir, ".claude", "state", "gates.jsonl"), "utf8").includes(SECRET));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ---- D4: a continued review stop after a retry's stop ----

const S = "S1";
const T = (/** @type {number} */ s) => new Date(Date.UTC(2026, 10, 18, 0, 0, s)).toISOString();
/** @param {number} s @param {string} id @param {string} type @param {string} slice @param {object} [extra] */
const L = (s, id, type, slice, extra = {}) => ({ ts: T(s), session_id: S, agent_id: id, agent_type: type, slice, files: [`${slice}.txt`], depends: [], checks: [], model: "sonnet", isPlanReview: false, validate: false, ...extra });
/** @param {number} s @param {string} id @param {string} role @param {string} slice @param {string | null} status @param {object} [extra] */
const St = (s, id, role, slice, status, extra = {}) => ({ ts: T(s), session_id: S, agent_id: id, role, slice, status, answers: {}, open: [], gaps: [], ...extra });
const PLAN = [L(-20, "P1", "reviewer", "plan", { isPlanReview: true, plan: { slices: [{ slice: "x", files: ["x.txt"], depends: [] }] } })];
const PLAN_STOP = [St(-15, "P1", "reviewer", "plan", "pass")];
/** @param {any[]} launches @param {any[]} stops */
const sliceX = (launches, stops) => foldRuns({ launches: [...PLAN, ...launches], stops: [...PLAN_STOP, ...stops], gates: [], starts: [] }, { sessionId: S, now: Date.parse(T(200)), env: {} }).runs.at(-1)?.slices.x;

test("D4 fold: a continued reviewer stop after a retry's stop replaces that reviewer's review and keeps its attempt", () => {
  const launches = [L(0, "I1", "implementer", "x"), L(50, "R1", "reviewer", "x"), L(90, "I2", "implementer", "x")];
  const base = [St(10, "I1", "implementer", "x", "pass"), St(100, "R1", "reviewer", "x", "fail", { gaps: [{ confidence: 90, key: "k" }] })];
  // I2 (the retry) stops at 103, between R1's text stop (100) and its continued stop after the forced hand-back (106).
  const s = sliceX(launches, [...base, St(103, "I2", "implementer", "x", "pass"), St(106, "R1", "reviewer", "x", "fail", { continues: true, gaps: [{ confidence: 90, key: "k" }] })]);
  assert.ok(s);
  assert.equal(s.reviews.length, 1, "one review for the two stops");
  assert.equal(s.reviews[0]?.implAt, Date.parse(T(90)), "the review keeps the implAt its first stop had (I2's launch), not I2's stop");
  assert.equal(s.reviews[0]?.ts, Date.parse(T(100)), "and the time of its first stop");
  assert.equal(currentReviews(s).length, 0, "the retry has no review");
  assert.equal(s.countedFails, 1);
  // The delivered report decides: a continued stop with another verdict replaces the first one's.
  const pass = sliceX(launches, [...base, St(103, "I2", "implementer", "x", "pass"), St(106, "R1", "reviewer", "x", "pass", { continues: true })]);
  assert.deepEqual([pass?.reviews.length, pass?.reviews[0]?.status, pass?.countedFails, currentReviews(/** @type {any} */ (pass)).length], [1, "pass", 0, 0]);
  // Unchanged: a double stop with no retry is one review; a resume (no continues) is another review.
  const plain = sliceX(launches.slice(0, 2), [...base, St(106, "R1", "reviewer", "x", "fail", { continues: true })]);
  assert.deepEqual([plain?.reviews.length, plain?.countedFails], [1, 1]);
  const resumed = sliceX(launches, [...base, St(103, "I2", "implementer", "x", "pass"), St(106, "R1", "reviewer", "x", "pass")]);
  assert.deepEqual([resumed?.reviews.length, currentReviews(/** @type {any} */ (resumed)).length], [2, 1]);
});

// ---- D6: no report text in telemetry ----

test("D6 telemetry: a stop record keeps the parsed status but no report text", () => {
  const dir = project();
  try {
    const r = run(dir, "telemetry.mjs", { hook_event_name: "SubagentStop", agent_id: "r1", agent_type: "orchestration:reviewer", last_assistant_message: `STATUS: pass\n${SECRET}\nOPEN: none`, stop_hook_active: false });
    assert.equal(r.code, 0);
    const [rec] = log(dir, "telemetry.jsonl");
    assert.equal(rec?.status, "pass");
    assert.equal(rec?.agent_id, "r1");
    assert.equal(rec?.stop_hook_active, false);
    assert.equal("last_assistant_message" in (rec ?? {}), false);
    assert.ok(!readFileSync(join(dir, ".claude", "state", "telemetry.jsonl"), "utf8").includes(SECRET));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- H6: a reviewer woken after its delivered hand-back ----

const PLAN_BRIEF = "PLAN REVIEW\nSLICE: x\nFILES: x.py\nDEPENDS: none\nGOAL: x";
const WAKE = "That background search only finished now, after my report was delivered.";

/** A session driven through the real hooks; transcripts under the project folder. */
function session() {
  const dir = project();
  const env = { ORCH_ESCALATION: "off" };
  let n = 0;
  /** @param {string} script @param {object} payload */
  const hk = (script, payload) => run(dir, script, payload, { env });
  const s = {
    dir,
    /** @param {string} type @param {string} prompt */
    launch(type, prompt) {
      const id = `ag${++n}`;
      hk("telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: id, agent_type: type });
      hk("journal.mjs", { hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: type, prompt }, tool_response: { status: "async_launched", agentId: id } });
      return id;
    },
    /** A SendMessage resume or a wake: Claude Code starts the agent again under its id. @param {string} id @param {string} type */
    start(id, type) {
      hk("telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: id, agent_type: type });
    },
    /** @param {string} id @param {string} type @param {object} extra */
    stop(id, type, extra) {
      const p = { hook_event_name: "SubagentStop", agent_id: id, agent_type: type, stop_hook_active: false, ...extra };
      hk("telemetry.mjs", p);
      hk("journal.mjs", p);
    },
    /** @param {string} id @param {string} type @param {string} message */
    handback(id, type, message) {
      return hk("handback-check.mjs", { hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_use_id: `toolu_${++n}`, tool_input: { message }, agent_id: id, agent_type: type });
    },
    /** A subagent transcript: the brief, then each entry (a hand-back or a text turn). @param {string} name @param {string} brief @param {Array<{ handback?: string, text?: string }>} turns */
    transcript(name, brief, turns) {
      const f = join(dir, `${name}.jsonl`);
      const lines = [{ type: "user", message: { role: "user", content: brief } }];
      for (const t of turns) {
        if (t.handback !== undefined) lines.push(/** @type {any} */ ({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `tu${++n}`, name: "SubagentHandback", input: { message: t.handback } }] } }));
        if (t.text !== undefined) lines.push(/** @type {any} */ ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: t.text }] } }));
      }
      writeFileSync(f, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
      return f;
    },
    /** The slice's state in the latest run. */
    slice() {
      return sessionRuns("s1", { dir: join(dir, ".claude", "state"), env }).latest?.slices.x;
    },
    gate() {
      return hk("review-gate.mjs", { hook_event_name: "Stop", background_tasks: [] });
    },
    /** Plan, one implementer stop, one reviewer that hands back `report` and stops. @param {string} report */
    reviewed(report) {
      const p = s.launch("orchestration:reviewer", PLAN_BRIEF);
      s.stop(p, "orchestration:reviewer", { last_assistant_message: "STATUS: pass\nOPEN: none" });
      const i = s.launch("orchestration:implementer", "SLICE: x\nFILES: x.py\nDEPENDS: none");
      s.stop(i, "orchestration:implementer", { last_assistant_message: "STATUS: pass\nOPEN: none" });
      const r = s.launch("orchestration:reviewer", "SLICE: x");
      assert.equal(s.handback(r, "orchestration:reviewer", report).code, 0);
      s.stop(r, "orchestration:reviewer", { agent_transcript_path: join(dir, "missing.jsonl") });
      return { i, r };
    },
  };
  return s;
}

test("H6 journal: a reviewer woken after its delivered hand-back adds no review (no copy, no empty one, none for a later attempt)", () => {
  // With a transcript: the woken stop's last message has no STATUS, the transcript holds the delivered hand-back.
  let s = session();
  try {
    const { r } = s.reviewed("STATUS: pass\nOPEN: none");
    assert.deepEqual(s.slice()?.reviews.map((v) => v.status), ["pass"]);
    s.start(r, "orchestration:reviewer");
    s.stop(r, "orchestration:reviewer", { last_assistant_message: WAKE, agent_transcript_path: s.transcript("r", "SLICE: x", [{ handback: "STATUS: pass\nOPEN: none" }, { text: WAKE }]) });
    assert.deepEqual(s.slice()?.reviews.map((v) => v.status), ["pass"], "the wake is not a second review");
    assert.equal(s.gate().code, 0);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
  // Headless (no transcript): the woken stop must not replace the delivered pass with a review that has no status.
  s = session();
  try {
    const { r } = s.reviewed("STATUS: pass\nOPEN: none");
    s.start(r, "orchestration:reviewer");
    s.stop(r, "orchestration:reviewer", { last_assistant_message: WAKE, agent_transcript_path: join(s.dir, "missing.jsonl") });
    assert.deepEqual(s.slice()?.reviews.map((v) => v.status), ["pass"], "no review with no status");
    const g = s.gate();
    assert.equal(g.code, 0, g.stderr);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
  // Woken after the retry of its slice stopped: the old verdict is not a review of the retry.
  s = session();
  try {
    const { i, r } = s.reviewed("STATUS: fail\nGAP: 90 x.py:1 broken\nOPEN: none");
    s.start(i, "orchestration:implementer");
    s.stop(i, "orchestration:implementer", { last_assistant_message: "STATUS: pass\nOPEN: none" });
    s.start(r, "orchestration:reviewer");
    s.stop(r, "orchestration:reviewer", { last_assistant_message: WAKE, agent_transcript_path: s.transcript("r2", "SLICE: x", [{ handback: "STATUS: fail\nGAP: 90 x.py:1 broken\nOPEN: none" }, { text: WAKE }]) });
    const x = s.slice();
    assert.ok(x);
    assert.equal(currentReviews(x).length, 0, "the retry is unreviewed");
    assert.equal(x.reviews.length, 1);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});

test("H6 journal: a real second report after a resume still counts, by its own hand-back or its own STATUS line", () => {
  let s = session();
  try {
    const { r } = s.reviewed("STATUS: fail\nGAP: 90 x.py:1 broken\nOPEN: none");
    s.start(r, "orchestration:reviewer");
    assert.equal(s.handback(r, "orchestration:reviewer", "STATUS: pass\nOPEN: none").code, 0);
    s.stop(r, "orchestration:reviewer", { agent_transcript_path: join(s.dir, "missing.jsonl") });
    assert.deepEqual(s.slice()?.reviews.map((v) => v.status), ["fail", "pass"]);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
  s = session();
  try {
    const { r } = s.reviewed("STATUS: fail\nGAP: 90 x.py:1 broken\nOPEN: none");
    s.start(r, "orchestration:reviewer");
    s.stop(r, "orchestration:reviewer", { last_assistant_message: "STATUS: pass\nOPEN: none", agent_transcript_path: join(s.dir, "missing.jsonl") });
    assert.deepEqual(s.slice()?.reviews.map((v) => v.status), ["fail", "pass"]);
  } finally {
    rmSync(s.dir, { recursive: true, force: true });
  }
});
