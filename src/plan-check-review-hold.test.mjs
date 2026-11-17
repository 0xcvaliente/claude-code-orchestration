import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHeader, parseReply } from "../.claude/hooks/brief.mjs";
import { BUILTIN_AGENTS } from "../.claude/hooks/builtin-agents.mjs";

const BUILTIN = String(BUILTIN_AGENTS[0]); // a Claude Code built-in, named only in builtin-agents.mjs

// The plan check's reviewer hold (1.6.1): a reviewer of a slice whose latest implementer has a failed-tests block it never
// saw (the test gate decided after the worker's report) is refused with tests_failed_after_report; a stop the gate has not
// reported on yet gets a note in the reviewer's brief.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const T0 = Date.parse("2026-11-17T15:00:00.000Z");
/** @param {number} min */
const at = (min) => new Date(T0 + min * 60000).toISOString();

/** A throwaway project with the plan check and its modules, the plan reviewed (legacy record) in session s1. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), "review-hold-"));
  const hooks = join(dir, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of ["state.mjs", "brief.mjs", "run.mjs", "plan-check.mjs", "builtin-agents.mjs"]) copyFileSync(join(root, ".claude", "hooks", h), join(hooks, h));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  append(dir, "journal.jsonl", { ts: at(-10), session_id: "s1", slice: "plan", role: "reviewer", status: "pass", agent_id: "r0" });
  return dir;
}
/** @param {string} dir @param {string} name @param {Record<string, unknown>} rec */
function append(dir, name, rec) {
  writeFileSync(join(dir, ".claude", "state", name), `${JSON.stringify(rec)}\n`, { flag: "a" });
}
/** An implementer of `slice` that started at `start` and stopped at `stop` (minutes). @param {string} dir */
function implementer(dir, id = "impl1", slice = "a", start = 0, stop = 1) {
  append(dir, "journal-launches.jsonl", { ts: at(start), session_id: "s1", agent_id: id, agent_type: "implementer", slice });
  append(dir, "telemetry.jsonl", { ts: at(start), session_id: "s1", agent_type: "implementer", agent_id: id, hook_event_name: "SubagentStart" });
  if (stop !== null) append(dir, "telemetry.jsonl", { ts: at(stop), session_id: "s1", agent_type: "implementer", agent_id: id, hook_event_name: "SubagentStop" });
}
/** A test-gate record at `min`. @param {string} dir @param {number} min @param {string} decision @param {string} reason @param {Record<string, unknown>} [extra] */
function gate(dir, min, decision, reason, extra = {}, id = "impl1") {
  append(dir, "gates.jsonl", { ts: at(min), gate: "test", decision, reason, agent_type: "implementer", agent_id: id, session_id: "s1", ...extra });
}
/** The environment without the hold's switches, plus `extra`. @param {Record<string, string>} [extra] */
function envWith(extra = {}) {
  /** @type {Record<string, string | undefined>} */
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k === "ORCH_REVIEW_HOLD" || k.startsWith("CLAUDE_PLUGIN_OPTION_") || k === "ORCH_SKILL_HINTS") delete env[k];
  return { ...env, ORCH_SKILL_HINTS: "off", ...extra };
}
/** @param {string} dir @param {string} prompt @param {string} [type] @param {Record<string, string>} [env] */
const launch = (dir, prompt, type = "reviewer", env = {}) =>
  spawnSync("node", [join(dir, ".claude", "hooks", "plan-check.mjs")], {
    input: JSON.stringify({ session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: type, prompt } }),
    env: { ...envWith(env), CLAUDE_PROJECT_DIR: dir },
    encoding: "utf8",
  });
/** @param {string} dir */
const holds = (dir) => {
  const p = join(dir, ".claude", "state", "review-hold.jsonl");
  return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};
const REVIEW = "SLICE: a\nCHECKS: C1\nC1: tests pass\nReview the diff.";
const SWITCH = /ORCH_|CLAUDE_PLUGIN_OPTION|review_hold|REVIEW_HOLD/;

test("a failed-tests block after the stop refuses the slice's reviewer twice, then gives up and is logged", () => {
  const dir = project();
  try {
    implementer(dir);
    gate(dir, 4, "block", "tests_failed", { failing: 3, on_base: 1 });
    for (const n of [1, 2]) {
      const r = launch(dir, REVIEW);
      assert.equal(r.status, 2, `refusal ${n}`);
      assert.equal(r.stdout, "", "a refusal prints no allow");
      assert.match(r.stderr, /tests failed after the worker had reported/);
      assert.match(r.stderr, /tests_failed \(3 failing tests; 1 of them also failing on the base commit\)/);
      assert.match(r.stderr, /SendMessage \(to: impl1\)/);
      assert.match(r.stderr, /then launch the review/);
      assert.doesNotMatch(r.stderr, SWITCH, "the refusal names no switch");
      assert.ok(r.stderr.length < 700, "the message is bounded");
    }
    const third = launch(dir, REVIEW, "orchestration:reviewer");
    assert.equal(third.status, 0, "the third try is let through");
    assert.equal(third.stdout, "", "a give-up adds nothing");
    assert.deepEqual(holds(dir).map((e) => [e.decision, e.reason, e.slice, e.agent_id]), [
      ["block", "tests_failed_after_report", "a", "impl1"],
      ["block", "tests_failed_after_report", "a", "impl1"],
      ["allow", "tests_failed_after_report_gave_up", "a", "impl1"],
    ]);
    assert.equal(existsSync(join(dir, ".claude", "state", "plan-check.jsonl")), false, "reviewer launches write no plan-check record");
    // A new block of the same agent (a later stop, a later block) counts afresh.
    append(dir, "telemetry.jsonl", { ts: at(5), session_id: "s1", agent_type: "implementer", agent_id: "impl1", hook_event_name: "SubagentStart" });
    append(dir, "telemetry.jsonl", { ts: at(6), session_id: "s1", agent_type: "implementer", agent_id: "impl1", hook_event_name: "SubagentStop" });
    gate(dir, 8, "block", "tests_failed", { timed_out: 1, limit_s: 600 });
    const again = launch(dir, REVIEW);
    assert.equal(again.status, 2);
    assert.match(again.stderr, /the suite was stopped after 600 seconds/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a start of the implementer after the block lifts the refusal; a record with no reason still refuses", () => {
  const dir = project();
  try {
    implementer(dir);
    gate(dir, 4, "block", "");
    const r = launch(dir, REVIEW);
    assert.equal(r.status, 2, "a block with no reason is a test failure");
    assert.match(r.stderr, /recorded tests_failed/);
    append(dir, "telemetry.jsonl", { ts: at(5), session_id: "s1", agent_type: "implementer", agent_id: "impl1", hook_event_name: "SubagentStart" });
    const resumed = launch(dir, REVIEW);
    assert.deepEqual([resumed.status, resumed.stdout], [0, ""], "resumed and running: let through, nothing added");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a pending gate adds the note and allows; a passed gate and an environment block add nothing", () => {
  const dir = project();
  try {
    implementer(dir);
    const r = launch(dir, REVIEW);
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "allow");
    assert.ok(out.updatedInput.prompt.startsWith(REVIEW), "the brief is kept");
    const note = out.updatedInput.prompt.slice(REVIEW.length);
    assert.match(note, /test gate has not reported yet/);
    assert.match(note, /Do not rest a pass on the tests having passed/);
    assert.doesNotMatch(note, SWITCH, "the note names no switch");
    const hd = parseHeader(note);
    const rp = parseReply(note);
    assert.ok(!hd.slice && !hd.files.length && !hd.checks.length && rp.status === null && !rp.open.length, "the note parses as no brief or reply line");
    assert.deepEqual(holds(dir).map((e) => [e.decision, e.reason]), [["note", "test_gate_pending"]]);

    gate(dir, 4, "allow", "tests_passed");
    assert.deepEqual([launch(dir, REVIEW).stdout, launch(dir, REVIEW).status], ["", 0], "a passed gate adds nothing");

    gate(dir, 5, "block", "bugfix_timeout");
    const env = launch(dir, REVIEW);
    assert.deepEqual([env.status, env.stdout], [0, ""], "an environment block does not refuse");
    gate(dir, 6, "warn", "tests_failed_isolated");
    assert.deepEqual([launch(dir, REVIEW).status, launch(dir, REVIEW).stdout], [0, ""], "a warning does not refuse");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("other slices, a PLAN REVIEW and other agents are untouched; the allow goes only to our reviewer", () => {
  const dir = project();
  try {
    implementer(dir);
    gate(dir, 4, "block", "tests_failed", { failing: 2 });
    const other = launch(dir, "SLICE: b\nReview it.");
    assert.deepEqual([other.status, other.stdout], [0, ""], "a reviewer of another slice");
    const plan = launch(dir, "PLAN REVIEW\nCONSTRAINTS:\nC1: x\nSLICE: a\nFILES: x.py\nDEPENDS: none\nGOAL: y");
    assert.deepEqual([plan.status, plan.stdout], [0, ""], "a PLAN REVIEW");
    const impl = launch(dir, "SLICE: a\nFILES: x.py\nDEPENDS: none", "implementer");
    assert.equal(impl.status, 0, "an implementer of the slice (its resume or retry) is never refused");
    for (const t of ["researcher", "orchestration:researcher", "integrator", "orchestration:integrator", "otherplugin:reviewer", BUILTIN]) {
      const r = launch(dir, REVIEW, t);
      assert.deepEqual([r.status, r.stdout], [0, ""], t);
    }
    assert.equal(launch(dir, REVIEW).status, 2, "our reviewer of the slice is still refused");
    // The pending note reaches only our reviewer.
    implementer(dir, "impl2", "c", 10, 11);
    for (const t of ["researcher", "integrator", "otherplugin:reviewer", BUILTIN]) assert.equal(launch(dir, "SLICE: c\nReview.", t).stdout, "", t);
    assert.match(launch(dir, "SLICE: c\nReview.", "orchestration:reviewer").stdout, /test gate has not reported/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the switch turns the hold off through the environment and the plugin option, the environment winning", () => {
  const dir = project();
  try {
    implementer(dir);
    gate(dir, 4, "block", "tests_failed");
    assert.deepEqual([launch(dir, REVIEW, "reviewer", { ORCH_REVIEW_HOLD: "off" }).status, holds(dir).length], [0, 0], "environment off");
    assert.deepEqual([launch(dir, REVIEW, "reviewer", { CLAUDE_PLUGIN_OPTION_REVIEW_HOLD: "OFF" }).status, holds(dir).length], [0, 0], "plugin option off");
    assert.equal(launch(dir, REVIEW, "reviewer", { ORCH_REVIEW_HOLD: "on", CLAUDE_PLUGIN_OPTION_REVIEW_HOLD: "off" }).status, 2, "the environment wins");
    implementer(dir, "impl2", "c", 10, 11);
    assert.equal(launch(dir, "SLICE: c\nReview.", "reviewer", { ORCH_REVIEW_HOLD: "off" }).stdout, "", "no note with the hold off");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the agent texts' and the nudge's sentences on the hold name no switch", () => {
  const texts = {
    orchestrator: readFileSync(join(root, ".claude", "agents", "orchestrator.md"), "utf8"),
    reviewer: readFileSync(join(root, ".claude", "agents", "reviewer.md"), "utf8"),
    nudge: readFileSync(join(root, ".claude", "hooks", "nudge.mjs"), "utf8"),
  };
  for (const [name, text] of Object.entries(texts)) {
    const key = name === "reviewer" ? "test gate has not reported" : "tests_failed_after_report";
    const sentences = text.split(/(?<=\.)\s+/).filter((s) => s.includes(key));
    assert.ok(sentences.length > 0, `${name} explains the hold`);
    for (const s of sentences) assert.doesNotMatch(s, SWITCH, `${name}: ${s}`);
  }
  assert.match(texts.orchestrator, /before (its|the) test gate has finished/);
});

/** A PLAN REVIEW launch and its reviewer's stop. @param {string} dir @param {string} id @param {number} min @param {string[]} slices */
function planReview(dir, id, min, slices) {
  const plan = { constraints: {}, slices: slices.map((slice) => ({ slice, files: ["x.py"], depends: [] })) };
  append(dir, "journal-launches.jsonl", { ts: at(min), session_id: "s1", agent_id: id, agent_type: "reviewer", slice: "plan", isPlanReview: true, replan: null, plan });
  append(dir, "journal.jsonl", { ts: at(min + 0.5), session_id: "s1", agent_id: id, role: "reviewer", slice: "plan", status: "pass" });
}
/** A slice reviewer's launch and stop. @param {string} dir @param {string} id @param {string} slice @param {number} min @param {string} status */
function review(dir, id, slice, min, status) {
  append(dir, "journal-launches.jsonl", { ts: at(min), session_id: "s1", agent_id: id, agent_type: "reviewer", slice });
  append(dir, "journal.jsonl", { ts: at(min + 0.25), session_id: "s1", agent_id: id, role: "reviewer", slice, status });
}
/** A project with no legacy plan record: its runs come from PLAN REVIEW records. */
function runProject() {
  const dir = project();
  writeFileSync(join(dir, ".claude", "state", "journal.jsonl"), "");
  return dir;
}

test("an older run's block does not refuse a reviewer of the same slice id in a new run; the current run's block does", () => {
  const dir = runProject();
  try {
    planReview(dir, "p1", -10, ["s1"]);
    implementer(dir, "impl1", "s1", 0, 1);
    review(dir, "rv1", "s1", 2, "fail"); // its latest review failed, so the next plan starts s1 clean
    gate(dir, 4, "block", "tests_failed", {}, "impl1");
    planReview(dir, "p2", 10, ["s1"]);
    const fresh = launch(dir, "SLICE: s1\nReview it.");
    assert.deepEqual([fresh.status, fresh.stderr], [0, ""], "run 1's block is not run 2's");
    implementer(dir, "impl2", "s1", 12, 13);
    gate(dir, 15, "block", "tests_failed", {}, "impl2");
    const held = launch(dir, "SLICE: s1\nReview it.");
    assert.equal(held.status, 2, "a block inside the current run still refuses");
    assert.match(held.stderr, /SendMessage \(to: impl2\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a slice the new plan carries over whole keeps its implementer's block", () => {
  const dir = runProject();
  try {
    planReview(dir, "p1", -10, ["s1"]);
    implementer(dir, "impl1", "s1", 0, 1);
    gate(dir, 4, "block", "tests_failed", {}, "impl1");
    planReview(dir, "p2", 10, ["s1"]); // no failed review after the attempt: s1 moves whole into run 2
    const held = launch(dir, "SLICE: s1\nReview it.");
    assert.equal(held.status, 2);
    assert.match(held.stderr, /SendMessage \(to: impl1\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a test-gate record stamped just before its own stop record belongs to that stop", () => {
  const dir = project();
  try {
    implementer(dir, "impl1", "a", 0, 1);
    gate(dir, 1 - 0.2 / 60, "allow", "no_code_changes"); // the gate decided before telemetry stamped the stop
    const r = launch(dir, REVIEW);
    assert.deepEqual([r.status, r.stdout], [0, ""], "the gate has reported: no note");
    implementer(dir, "impl2", "b", 2, 3);
    gate(dir, 3 - 0.2 / 60, "block", "tests_failed", {}, "impl2");
    assert.equal(launch(dir, "SLICE: b\nReview.").status, 2, "a block stamped before the stop still refuses");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a second stop after a block, with no new start, waits for its own gate record", () => {
  const dir = project();
  try {
    implementer(dir, "impl1", "a", 0, 1);
    gate(dir, 2, "block", "tests_failed");
    append(dir, "telemetry.jsonl", { ts: at(3), session_id: "s1", agent_type: "implementer", agent_id: "impl1", hook_event_name: "SubagentStop" });
    const r = launch(dir, REVIEW);
    assert.equal(r.status, 0, "the block belongs to the first stop");
    assert.match(r.stdout, /test gate has not reported yet/);
    gate(dir, 5, "allow", "tests_passed");
    assert.deepEqual([launch(dir, REVIEW).status, launch(dir, REVIEW).stdout], [0, ""]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2.0.0: stops and test-gate records carry a stop_key; the hold pairs them by it.
/** A stop of impl1 at `min` with `key`. @param {string} dir @param {number} min @param {string} key */
const keyedStop = (dir, min, key) =>
  append(dir, "telemetry.jsonl", { ts: at(min), session_id: "s1", agent_type: "implementer", agent_id: "impl1", hook_event_name: "SubagentStop", stop_key: key });
/** impl1 of slice a, launched and started at 0, with no stop yet. @param {string} dir */
const startOnly = (dir) => {
  append(dir, "journal-launches.jsonl", { ts: at(0), session_id: "s1", agent_id: "impl1", agent_type: "implementer", slice: "a" });
  append(dir, "telemetry.jsonl", { ts: at(0), session_id: "s1", agent_type: "implementer", agent_id: "impl1", hook_event_name: "SubagentStart" });
};

test("2.0.0: an implementer resumed while its earlier gate still runs: the late record belongs to the earlier stop", () => {
  const dir = project();
  try {
    startOnly(dir);
    keyedStop(dir, 1, "uuid:k1");
    // Resumed at 2 (SendMessage), stopped again at 3; the first stop's gate reports a block only at 4.
    append(dir, "telemetry.jsonl", { ts: at(2), session_id: "s1", agent_type: "implementer", agent_id: "impl1", hook_event_name: "SubagentStart" });
    keyedStop(dir, 3, "uuid:k2");
    gate(dir, 4, "block", "tests_failed", { stop_key: "uuid:k1" });
    const r = launch(dir, REVIEW);
    assert.equal(r.status, 0, "the late block is the earlier stop's: no refusal");
    assert.match(r.stdout, /test gate has not reported yet/, "the latest stop is still pending");
    // Its own record arrives: a block refuses, as it did by count.
    gate(dir, 5, "block", "tests_failed", { stop_key: "uuid:k2" });
    assert.equal(launch(dir, REVIEW).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("2.0.0: a keyed stop with a passing record of its own is not held by the earlier stop's late block", () => {
  const dir = project();
  try {
    startOnly(dir);
    keyedStop(dir, 1, "uuid:k1");
    append(dir, "telemetry.jsonl", { ts: at(2), session_id: "s1", agent_type: "implementer", agent_id: "impl1", hook_event_name: "SubagentStart" });
    keyedStop(dir, 3, "uuid:k2");
    gate(dir, 3.5, "allow", "tests_passed_cached", { stop_key: "uuid:k2" });
    gate(dir, 4, "block", "tests_failed", { stop_key: "uuid:k1" });
    const r = launch(dir, REVIEW);
    assert.deepEqual([r.status, r.stdout], [0, ""], "the latest stop's own record passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("2.0.0: the hand-back gate's records are never a stop's record", () => {
  const dir = project();
  try {
    startOnly(dir);
    // A refusal and a pass at the hand-back (before the stop), then the stop with no gate record yet: pending.
    gate(dir, 0.5, "block", "tests_failed", { at: "handback", handback_id: "toolu_1" });
    gate(dir, 0.8, "allow", "tests_passed", { at: "handback", handback_id: "toolu_2" });
    append(dir, "telemetry.jsonl", { ts: at(1), session_id: "s1", agent_type: "implementer", agent_id: "impl1", hook_event_name: "SubagentStop" });
    const r = launch(dir, REVIEW);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /test gate has not reported yet/, "unkeyed stop: the hand-back records are not counted for it");
    gate(dir, 2, "allow", "tests_passed_cached");
    assert.deepEqual([launch(dir, REVIEW).status, launch(dir, REVIEW).stdout], [0, ""]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("when the hold's record cannot be written, the launch is let through rather than refused for good", () => {
  const dir = project();
  try {
    implementer(dir);
    gate(dir, 4, "block", "tests_failed");
    mkdirSync(join(dir, ".claude", "state", "review-hold.jsonl")); // appending to it fails
    for (let i = 0; i < 3; i += 1) assert.equal(launch(dir, REVIEW).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
