// 2.2.0: an implementer's or reviewer's launch record in journal-launches.jsonl carries `run`, the run foldRuns gives the
// launch with it included (the run at launch). An added field only: no gate reads it, a launch in no run and a launch
// with no slice carry none, and records with and without it fold alike. Spec: docs/logs.md, docs/brief-grammar.md.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { foldRuns } from "../.claude/hooks/brief.mjs";
import { loadRecords, sessionRuns } from "../.claude/hooks/run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOK = join(root, ".claude", "hooks", "journal.mjs");

/** @param {string} file @param {unknown[]} rows */
const writeJsonl = (file, rows) => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
/** Parsed lines of a log; a line that does not parse is skipped. @param {string} file @returns {any[]} */
const readJsonl = (file) => {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
};

/** A scratch project driving the real journal hook. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), "orch-launch-run-"));
  const state = join(dir, ".claude", "state");
  mkdirSync(state, { recursive: true });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: "" };
  /** @param {string} input raw stdin */
  const raw = (input) => spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
  /** @param {object} payload */
  const journal = (payload) => {
    const r = raw(JSON.stringify({ session_id: "s1", ...payload }));
    assert.equal(r.status, 0, r.stderr);
  };
  /** @param {string} id @param {string} type @param {string} prompt */
  const launch = (id, type, prompt) =>
    journal({
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: `orchestration:${type}`, prompt },
      tool_response: { status: "async_launched", agentId: id },
    });
  /** @param {string} id @param {string} type @param {string} reply */
  const stop = (id, type, reply) => journal({ hook_event_name: "SubagentStop", agent_id: id, agent_type: `orchestration:${type}`, last_assistant_message: reply, cwd: dir });
  const launches = () => readJsonl(join(state, "journal-launches.jsonl"));
  /** @param {string} id */
  const launchOf = (id) => launches().filter((r) => r.agent_id === id).at(-1);
  /** @param {string} id */
  const stopOf = (id) => readJsonl(join(state, "journal.jsonl")).filter((r) => r.agent_id === id).at(-1);
  return { dir, state, raw, journal, launch, stop, launches, launchOf, stopOf };
}

/** @param {string} slices one planned slice per id @param {number} [replan] */
const plan = (slices, replan) =>
  `PLAN REVIEW\n${replan ? `REPLAN: ${replan}\n` : ""}CONSTRAINTS:\nC1: no paid command\n${slices
    .split(",")
    .map((s) => `SLICE: ${s}\nFILES: src/${s}.mjs\nDEPENDS: none\nGOAL: build ${s}`)
    .join("\n")}`;
/** @param {string} slice @param {string} [extra] */
const impl = (slice, extra = "") => `SLICE: ${slice}\nFILES: src/${slice}.mjs\nDEPENDS: none\n${extra}`;
const PASS = "STATUS: pass\nOPEN: none";

/** The sequence of the first test, shared with the fold check. @param {ReturnType<typeof project>} p */
const planned = (p) => {
  p.launch("p1", "reviewer", plan("a"));
  p.stop("p1", "reviewer", PASS);
  p.launch("i1", "implementer", impl("a"));
  p.launch("r1", "reviewer", "SLICE: a\nReview the diff.");
  p.launch("q1", "researcher", "Find the parser.");
  p.launch("g1", "integrator", "CHECKPOINT the run.");
  p.launch("p2", "reviewer", plan("b"));
  p.launch("p3", "reviewer", plan("b,c", 1));
  p.launch("i2", "implementer", impl("b"));
};

test("journal launch run: a plan review carries the run it opens, a REPLAN the open run, a planned implementer and a slice reviewer their run", () => {
  const p = project();
  try {
    planned(p);
    assert.equal(p.launchOf("p1")?.run, 1, "the first PLAN REVIEW opens run 1");
    assert.equal(p.launchOf("i1")?.run, 1, "an implementer of the reviewed plan joins run 1");
    assert.equal(p.launchOf("r1")?.run, 1, "a slice reviewer: the run its review lands in");
    assert.equal(p.launchOf("p2")?.run, 2, "a second plain PLAN REVIEW opens run 2");
    assert.equal(p.launchOf("p3")?.run, 2, "a REPLAN plan review extends the open run");
    assert.equal(p.launchOf("i2")?.run, 2);
    for (const id of ["q1", "g1"]) assert.equal("run" in (p.launchOf(id) ?? {}), false, `${id}: a launch with no slice carries no run`);
    // The fields the launch record had before are unchanged.
    const i1 = p.launchOf("i1");
    assert.equal(i1?.slice, "a");
    assert.equal(i1?.agent_type, "implementer");
    assert.equal(i1?.reviews_needed, 1);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("journal launch run: a light implementer launch with no open run carries the run it opens; an unplanned one carries none", () => {
  const p = project();
  try {
    p.launch("u1", "implementer", impl("x"));
    assert.equal("run" in (p.launchOf("u1") ?? {}), false, "no run open and not light: the fold places it in no run");
    p.launch("u2", "reviewer", "SLICE: x\nReview.");
    assert.equal("run" in (p.launchOf("u2") ?? {}), false, "a reviewer of a slice in no run, with no run open: none");
    p.launch("l1", "implementer", impl("fix", "PATH: light"));
    assert.equal(p.launchOf("l1")?.run, 1, "the light launch opens run 1");
    p.launch("w1", "implementer", impl("w", "ORCHESTRATION: workflow"));
    assert.equal("run" in (p.launchOf("w1") ?? {}), false, "a workflow brief is left to its script: no run");
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("journal launch run: a foreground launch whose stop came first keeps the stop record's run", () => {
  const p = project();
  try {
    p.launch("p1", "reviewer", plan("a"));
    p.stop("p1", "reviewer", PASS);
    // Foreground: the stop is logged before the launch; it waits in journal-pending.jsonl.
    p.stop("i1", "implementer", PASS);
    assert.equal(p.stopOf("i1"), undefined);
    p.launch("i1", "implementer", impl("a"));
    const s = p.stopOf("i1");
    assert.equal(s?.slice, "a");
    assert.equal(s?.run, 1, "the stop record's run, as runOf gives it after the launch is written");
    assert.equal(p.launchOf("i1")?.run, 1);
    assert.equal(p.launches().filter((l) => l.agent_id === "i1").length, 1, "one launch record, appended once");
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("journal launch run: malformed or empty payloads exit 0 and write nothing wrong", () => {
  const p = project();
  try {
    for (const input of ["", "not json", "null", "[]", "42", '"x"']) assert.equal(p.raw(input).status, 0, JSON.stringify(input));
    p.journal({ hook_event_name: "PostToolUse", tool_input: null, tool_response: null });
    p.journal({ hook_event_name: "PostToolUse", tool_input: { subagent_type: "implementer" }, tool_response: { agentId: "m1xxxx" } });
    p.journal({ hook_event_name: "PostToolUse", tool_input: { subagent_type: "reviewer", prompt: 7 }, tool_response: "agentId: m2xxxx" });
    p.journal({ hook_event_name: "PostToolUse", session_id: 5, tool_input: { subagent_type: "implementer", prompt: impl("z", "PATH: light") }, tool_response: { agentId: "m3xxxx" } });
    // A broken line in the log: the fold reads past it.
    writeFileSync(join(p.state, "journal-launches.jsonl"), `${readFileSync(join(p.state, "journal-launches.jsonl"), "utf8")}{broken\n`);
    p.launch("m4xxxx", "implementer", impl("y", "PATH: light"));
    const recs = p.launches();
    assert.equal(recs.length, 4, "one record per worker launch, none for the malformed inputs");
    for (const r of recs) assert.ok(!("run" in r) || (Number.isInteger(r.run) && r.run > 0), JSON.stringify(r));
    assert.equal("run" in (recs[0] ?? {}), false, "no slice: no run");
    assert.equal("run" in (recs[1] ?? {}), false, "no slice: no run");
    assert.equal(recs[2]?.run, 1, "a session id that is not a string folds as the empty session");
    assert.equal(recs[3]?.run, 1, "session s1's first run");
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("fold: launch records with and without `run` give the same runs", () => {
  const p = project();
  const old = mkdtempSync(join(tmpdir(), "orch-launch-run-old-"));
  try {
    planned(p);
    p.stop("i2", "implementer", PASS);
    p.launch("r2", "reviewer", "SLICE: b\nReview.");
    p.stop("r2", "reviewer", PASS);
    const launches = p.launches();
    assert.ok(launches.filter((l) => "run" in l).length >= 6, "the new field is there to strip");
    const oldState = join(old, ".claude", "state");
    mkdirSync(oldState, { recursive: true });
    writeFileSync(join(oldState, "journal.jsonl"), readFileSync(join(p.state, "journal.jsonl"), "utf8"));
    writeJsonl(join(oldState, "journal-launches.jsonl"), launches.map(({ run: _r, ...rest }) => rest));
    const now = Date.now();
    for (const env of [{}, { ORCH_ESCALATION: "always" }, { ORCH_ESCALATION: "off" }, { ORCH_SECOND_REVIEW: "off" }]) {
      const a = sessionRuns("s1", { dir: p.state, now, env });
      const b = sessionRuns("s1", { dir: oldState, now, env });
      assert.deepEqual(JSON.parse(JSON.stringify({ runs: a.runs, open: a.open })), JSON.parse(JSON.stringify({ runs: b.runs, open: b.open })), JSON.stringify(env));
    }
    // foldRuns with an onLaunch observer folds the same as without one, and reports each launch's run.
    const records = loadRecords("s1", p.state);
    /** @type {[string, number | null][]} */
    const seen = [];
    const withObs = foldRuns(records, { now, sessionId: "s1", onLaunch: (l, run) => seen.push([l.agent_id, run?.id ?? null]) });
    const without = foldRuns(records, { now, sessionId: "s1" });
    assert.deepEqual(JSON.parse(JSON.stringify(withObs)), JSON.parse(JSON.stringify(without)));
    assert.deepEqual(
      seen,
      launches.map((l) => [l.agent_id, l.run ?? null]),
      "the observer gives the run each launch record carries",
    );
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
});
