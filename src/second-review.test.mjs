// The second review rule (2.1.0; docs/limits.md, J): a RISKY slice whose latest implementer launch record carries
// `reviews_needed` needs two passing reviews of its latest attempt from two different reviewers, each begun after the
// attempt's hand-back. The launch field through the real journal.mjs; the rule through brief.mjs's fold (run.mjs
// loadRecords on the state dir) and the real review-gate.mjs, on log records written with fixed times.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { foldRuns, launchRecord, stopRecord } from "../.claude/hooks/brief.mjs";
import { loadRecords } from "../.claude/hooks/run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** @param {string} name */
const hook = (name) => join(root, ".claude", "hooks", name);
const SID = "s1";
const PLAN = "PLAN REVIEW\nCONSTRAINTS:\nC1: no throw\nSLICE: a\nFILES: a.py\nDEPENDS: none\nGOAL: a\nCHECKS: C1\nRISKY: yes\nSLICE: b\nFILES: b.py\nDEPENDS: none\nGOAL: b";
/** The environment every hook here runs with: the switches this file is about are cleared unless a test sets them. */
const BASE_ENV = { ORCH_ESCALATION: "", ORCH_RUN_STALE_MIN: "", ORCH_SECOND_REVIEW: "", ORCH_STALL_GATE: "", ORCH_GAP_MIN: "", ORCH_ALLOW_BUILTINS: "", CLAUDE_PLUGIN_ROOT: "" };

/**
 * A project with a state dir and helpers that write log records at fixed times: minute `m` is `T0 + m * 20 s`, with T0
 * 20 minutes ago, so a run is never stale (30 minutes) while the test runs.
 * @param {Record<string, string>} [env] the environment of the launch records and of the hooks
 */
function world(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orch-second-"));
  const state = join(dir, ".claude", "state");
  mkdirSync(state, { recursive: true });
  const T0 = Date.now() - 20 * 60000;
  /** @param {number} m */
  const at = (m) => new Date(T0 + m * 20000).toISOString();
  /** @param {string} file @param {object} rec */
  const put = (file, rec) => appendFileSync(join(state, file), `${JSON.stringify(rec)}\n`);
  /** @param {number} m @param {string} id @param {string} type */
  const start = (m, id, type) => put("telemetry.jsonl", { ts: at(m), session_id: SID, hook_event_name: "SubagentStart", agent_id: id, agent_type: type });
  /** @param {number} m @param {string} id @param {string} type */
  const tstop = (m, id, type) => put("telemetry.jsonl", { ts: at(m), session_id: SID, hook_event_name: "SubagentStop", agent_id: id, agent_type: type });
  const fullEnv = { ...BASE_ENV, ...env };
  const w = {
    dir,
    state,
    at,
    plan(m = 0) {
      start(m, "plan", "orchestration:reviewer");
      put("journal-launches.jsonl", launchRecord({ subagent_type: "orchestration:reviewer", prompt: PLAN }, { ts: at(m), sessionId: SID, agentId: "plan", env: fullEnv }));
      tstop(m + 0.5, "plan", "orchestration:reviewer");
      put("journal.jsonl", stopRecord({ ts: at(m + 0.5), sessionId: SID, agentId: "plan", role: "reviewer", slice: "plan", reply: "STATUS: pass" }));
    },
    /** An implementer launch of `slice` (its brief RISKY when `risky`). @param {number} m @param {string} id @param {{ slice?: string, risky?: boolean, strip?: boolean }} [o] */
    implLaunch(m, id, o = {}) {
      const slice = o.slice ?? "a";
      start(m, id, "orchestration:implementer");
      const rec = launchRecord({ subagent_type: "orchestration:implementer", prompt: `SLICE: ${slice}\nFILES: ${slice}.py\nDEPENDS: none${o.risky === false ? "" : "\nRISKY: yes"}\nCHECKS: C1` }, { ts: at(m), sessionId: SID, agentId: id, env: fullEnv });
      if (o.strip) delete rec.reviews_needed; // a record written before the rule
      put("journal-launches.jsonl", rec);
    },
    /** The implementer hands its report back (handback-check.mjs's capture). @param {number} m @param {string} id */
    handback(m, id) {
      put("handbacks.jsonl", { ts: at(m), session_id: SID, agent_id: id, agent_type: "implementer", status: "pass", answers: {}, open: [] });
    },
    /** The implementer's SubagentStop: telemetry and its journal stop record. @param {number} m @param {string} id @param {string} [slice] */
    implStop(m, id, slice = "a") {
      tstop(m, id, "orchestration:implementer");
      put("journal.jsonl", stopRecord({ ts: at(m), sessionId: SID, agentId: id, role: "implementer", slice, reply: "STATUS: pass" }));
    },
    /** A resumed implementer starts again (SendMessage) under the same id. @param {number} m @param {string} id */
    implResume(m, id) {
      start(m, id, "orchestration:implementer");
    },
    /** One attempt: launch, hand-back, stop. @param {number} m @param {string} id @param {{ slice?: string, risky?: boolean, strip?: boolean }} [o] */
    attempt(m, id, o = {}) {
      w.implLaunch(m, id, o);
      w.handback(m + 1, id);
      w.implStop(m + 1.5, id, o.slice ?? "a");
    },
    /**
     * A reviewer that starts at `from` and stops at `to` with `reply`.
     * @param {number} from @param {number} to @param {string} id @param {string} reply
     * @param {{ model?: string, slice?: string, validate?: boolean, telemetry?: boolean }} [o]
     */
    review(from, to, id, reply, o = {}) {
      const slice = o.slice ?? "a";
      if (o.telemetry !== false) start(from, id, "orchestration:reviewer");
      put("journal-launches.jsonl", launchRecord({ subagent_type: "orchestration:reviewer", prompt: `SLICE: ${slice}${o.validate ? "\nVALIDATE: gaps" : ""}\nCHECKS: C1`, model: o.model ?? "sonnet" }, { ts: at(from), sessionId: SID, agentId: id, env: fullEnv }));
      w.reviewStop(to, id, reply, slice, o.telemetry);
    },
    /** A reviewer's (another) stop record. @param {number} m @param {string} id @param {string} reply @param {string} [slice] @param {boolean} [telemetry] */
    reviewStop(m, id, reply, slice = "a", telemetry = true) {
      if (telemetry !== false) tstop(m, id, "orchestration:reviewer");
      put("journal.jsonl", stopRecord({ ts: at(m), sessionId: SID, agentId: id, role: "reviewer", slice, reply }));
    },
    /** The coordinator resumes a reviewer: a new SubagentStart under its id. @param {number} m @param {string} id */
    reviewResume(m, id) {
      start(m, id, "orchestration:reviewer");
    },
    /** Slice `slice` of the latest run, folded from the state dir as the gates fold it. @param {string} [slice] @param {Record<string, string>} [more] */
    slice(slice = "a", more = {}) {
      const { runs, open } = foldRuns(loadRecords(SID, state), { now: Date.now(), sessionId: SID, env: { ...fullEnv, ...more } });
      const s = runs.at(-1)?.slices[slice];
      assert.ok(s, `slice ${slice} folded`);
      return { s, open };
    },
    /** Run the real review gate; returns its exit status, stderr and latest record. @param {Record<string, string>} [more] */
    gate(more = {}) {
      const r = spawnSync("node", [hook("review-gate.mjs")], {
        input: JSON.stringify({ session_id: SID, hook_event_name: "Stop", background_tasks: [] }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...fullEnv, ...more },
        encoding: "utf8",
      });
      const recs = readFileSync(join(state, "gates.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((g) => g.gate === "review");
      return { status: r.status, stderr: r.stderr, stdout: r.stdout, last: recs.at(-1) };
    },
  };
  return w;
}

const PASS = "STATUS: pass\nC1: pass (cmd) node x.js -> ok\nOPEN: none";
const FAIL = "STATUS: fail\nC1: fail it throws\nGAP: 95 it throws on empty input\nOPEN: none";

test("the field: reviews_needed on this plugin's implementer launches only (2 when RISKY, else 1), absent with the switch off", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-second-field-"));
  const state = join(dir, ".claude", "state");
  mkdirSync(state, { recursive: true });
  /** @param {string} type @param {string} prompt @param {Record<string, string>} [more] */
  const launch = (type, prompt, more = {}) => {
    const r = spawnSync("node", [hook("journal.mjs")], {
      input: JSON.stringify({ session_id: SID, hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: type, prompt }, tool_response: { status: "async_launched", agentId: `ag${Math.random().toString(36).slice(2, 10)}` } }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...BASE_ENV, ...more },
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(readFileSync(join(state, "journal-launches.jsonl"), "utf8").trim().split("\n").at(-1) ?? "{}");
  };
  const risky = "SLICE: a\nFILES: a.py\nDEPENDS: none\nRISKY: yes";
  const plain = "SLICE: b\nFILES: b.py\nDEPENDS: none";
  assert.equal(launch("orchestration:implementer", risky).reviews_needed, 2);
  assert.equal(launch("implementer", risky).reviews_needed, 2, "the bare project copy too");
  assert.equal(launch("orchestration:implementer", plain).reviews_needed, 1);
  for (const type of ["orchestration:reviewer", "orchestration:researcher", "orchestration:integrator", "reviewer"]) {
    const rec = launch(type, risky);
    assert.equal(rec.agent_type, type.split(":").pop());
    assert.ok(!Object.hasOwn(rec, "reviews_needed"), `${type} gets no field`);
  }
  for (const off of ["off", "OFF", " off "]) {
    assert.ok(!Object.hasOwn(launch("orchestration:implementer", risky, { ORCH_SECOND_REVIEW: off }), "reviews_needed"), `switch ${JSON.stringify(off)}`);
  }
  assert.equal(launch("orchestration:implementer", risky, { ORCH_SECOND_REVIEW: "on" }).reviews_needed, 2, "any other value keeps it on");
  // launchRecord itself: no env means on; another plugin's implementer gets no field.
  assert.equal(launchRecord({ subagent_type: "implementer", prompt: risky }).reviews_needed, 2);
  assert.ok(!Object.hasOwn(launchRecord({ subagent_type: "other:implementer", prompt: risky }), "reviews_needed"));
});

test("one pass blocks with second_review_required; the slice is neither passed nor final and the run stays open", () => {
  const w = world();
  w.plan();
  w.attempt(1, "impl1");
  w.review(3, 4, "rev1", PASS);
  const { s, open } = w.slice();
  assert.deepEqual([s.reviewsNeeded, s.secondReview, s.passed, s.final, s.gaveUp], [2, "one", false, false, false]);
  assert.ok(open, "the run stays open");
  const g = w.gate();
  assert.equal(g.status, 2, g.stderr);
  assert.equal(g.last.reason, "second_review_required");
  assert.equal(g.last.slice, "a");
  assert.match(g.stderr, /slice a \(run 1\) is risky and needs two passing reviews of its latest implementer attempt/);
  assert.match(g.stderr, /one more fresh reviewer .* with model: "opus"/, "no pass ran on opus: the next one should");
  assert.doesNotMatch(g.stderr, /ORCH_/, "the message names no switch");
  // A slice that is not RISKY is judged as before: one pass on a slice with no doubt signal passes.
  const p = world();
  p.plan();
  p.attempt(1, "impl1", { slice: "b", risky: false });
  p.review(3, 4, "rev1", PASS, { slice: "b" });
  assert.deepEqual([p.slice("b").s.reviewsNeeded, p.slice("b").s.final], [1, true]);
  assert.equal(p.gate().last.reason, "reviewer_passed");
});

test("two passes from two agents pass; two passes from one agent (a resumed reviewer) do not", () => {
  const w = world();
  w.plan();
  w.attempt(1, "impl1");
  w.review(3, 4, "rev1", PASS);
  w.review(5, 6, "rev2", PASS, { model: "opus" });
  const { s } = w.slice();
  assert.deepEqual([s.secondReview, s.passed, s.final], ["pass", true, true]);
  const g = w.gate();
  assert.equal(g.status, 0, g.stderr);
  assert.equal(g.last.reason, "reviewer_passed");

  const one = world();
  one.plan();
  one.attempt(1, "impl1");
  one.review(3, 4, "rev1", PASS, { model: "opus" });
  one.reviewResume(5, "rev1");
  one.reviewStop(6, "rev1", PASS);
  const t = one.slice().s;
  assert.equal(t.reviews.length, 2);
  assert.deepEqual([t.secondReview, t.passed, t.final], ["one", false, false]);
  const h = one.gate();
  assert.equal(h.last.reason, "second_review_required");
  assert.doesNotMatch(h.stderr, /with model: "opus"/, "a pass ran on opus already");
});

test("a pass and a fail fail the slice in either order", () => {
  for (const [first, second] of /** @type {[string, string][]} */ ([[PASS, FAIL], [FAIL, PASS]])) {
    const w = world();
    w.plan();
    w.attempt(1, "impl1");
    w.review(3, 4, "rev1", first, { model: "opus" });
    w.review(5, 6, "rev2", second, { model: "opus" });
    const { s } = w.slice();
    assert.deepEqual([s.secondReview, s.passed, s.final, s.gaveUp], ["fail", false, false, false]);
    const g = w.gate();
    assert.equal(g.status, 2, g.stderr);
    assert.equal(g.last.reason, "last_reviewer_failed");
    assert.match(g.stderr, /a reviewer of its latest attempt reported STATUS: fail/);
  }
});

test("reviewers launched after the hand-back but before the implementer's stop record count", () => {
  const w = world();
  w.plan();
  w.implLaunch(1, "impl1");
  w.handback(2, "impl1");
  w.review(2.2, 6, "rev1", PASS);
  w.review(2.4, 7, "rev2", PASS, { model: "opus" });
  w.implStop(4, "impl1"); // the stop record lands after both reviewers began
  const { s } = w.slice();
  assert.equal(s.handbackAt, Date.parse(w.at(2)));
  assert.deepEqual(s.reviews.map((r) => r.early), [false, false]);
  assert.deepEqual([s.secondReview, s.passed, s.final], ["pass", true, true]);
  assert.equal(w.gate().last.reason, "reviewer_passed");
  // Without a hand-back capture the stop record is the boundary, so the same two reviews began too early.
  const n = world();
  n.plan();
  n.implLaunch(1, "impl1");
  n.review(2.2, 6, "rev1", PASS);
  n.review(2.4, 7, "rev2", PASS, { model: "opus" });
  n.implStop(4, "impl1");
  assert.deepEqual(n.slice().s.reviews.map((r) => r.early), [true, true]);
  assert.equal(n.gate().last.reason, "no_reviewer_after_last_implementer");
});

test("a review that began before the attempt's hand-back counts neither as a pass nor as a fail", () => {
  // As a pass: an early pass and one later pass are one pass.
  const p = world();
  p.plan();
  p.implLaunch(1, "impl1");
  p.review(1.5, 5, "early", PASS, { model: "opus" });
  p.handback(2, "impl1");
  p.implStop(2.5, "impl1");
  p.review(3, 6, "rev2", PASS, { model: "opus" });
  const s = p.slice().s;
  assert.deepEqual(s.reviews.map((r) => [r.agent, r.early]), [["early", true], ["rev2", false]]);
  assert.equal(s.secondReview, "one");
  assert.equal(p.gate().last.reason, "second_review_required");
  // As a fail: an early fail does not fail an attempt two later reviewers passed.
  const f = world();
  f.plan();
  f.implLaunch(1, "impl1");
  f.review(1.5, 5, "early", FAIL, { model: "opus" });
  f.handback(2, "impl1");
  f.implStop(2.5, "impl1");
  f.review(3, 6, "rev2", PASS, { model: "opus" });
  f.review(3.5, 7, "rev3", PASS);
  const t = f.slice().s;
  assert.deepEqual([t.secondReview, t.passed, t.final], ["pass", true, true]);
  assert.equal(f.gate().last.reason, "reviewer_passed");
  // A reviewer resumed for a later attempt with no start to show when (no telemetry): its launch time decides, so it
  // does not count, and the gate asks for one more.
  const r = world();
  r.plan();
  r.attempt(1, "impl1");
  r.review(3, 4, "old", FAIL, { telemetry: false, model: "opus" });
  r.implResume(5, "impl1");
  r.handback(6, "impl1");
  r.implStop(6.5, "impl1");
  r.reviewStop(8, "old", PASS, "a", false);
  r.review(9, 10, "rev2", PASS, { model: "opus" });
  const u = r.slice().s;
  assert.deepEqual(u.reviews.slice(-2).map((x) => [x.agent, x.early]), [["old", true], ["rev2", false]]);
  assert.equal(u.secondReview, "one");
  // With its resume in the logs, the resumed reviewer counts.
  r.reviewResume(7, "old");
  const v = r.slice().s;
  assert.deepEqual([v.reviews.at(-2)?.early, v.secondReview], [false, "pass"]);
});

test("a validation's pass counts as one of the two", () => {
  const w = world();
  w.plan();
  w.attempt(1, "impl1");
  w.review(3, 4, "rev1", FAIL, { model: "opus" });
  w.review(5, 6, "val", PASS, { validate: true, model: "opus" });
  const s = w.slice().s;
  assert.deepEqual([s.reviews[0]?.superseded, s.secondReview], [true, "one"], "the validation supersedes the fail and is one pass");
  assert.equal(w.gate().last.reason, "second_review_required");
  w.review(7, 8, "rev3", PASS);
  assert.deepEqual([w.slice().s.secondReview, w.slice().s.final], ["pass", true]);
  assert.equal(w.gate().last.reason, "reviewer_passed");
});

test("a new attempt resets the count; after a third attempt passed, gaveUp and final agree with the gate", () => {
  const w = world();
  w.plan();
  w.attempt(1, "impl1");
  w.review(3, 4, "rev1", PASS, { model: "opus" });
  w.review(5, 6, "rev2", FAIL, { model: "opus" });
  // Second attempt (a resume): the earlier reviews no longer count.
  w.implResume(7, "impl1");
  w.handback(8, "impl1");
  w.implStop(8.5, "impl1");
  let s = w.slice().s;
  assert.deepEqual([s.attempts, s.secondReview, s.passed], [2, null, false]);
  assert.equal(w.gate().last.reason, "no_reviewer_after_last_implementer");
  w.review(9, 10, "rev3", FAIL, { model: "opus" });
  w.review(11, 12, "rev4", PASS, { model: "opus" });
  // Third attempt, a fresh implementer on opus.
  w.attempt(13, "impl3");
  w.review(15, 16, "rev5", PASS, { model: "opus" });
  s = w.slice().s;
  assert.deepEqual([s.attempts, s.secondReview, s.passed, s.gaveUp, s.final], [3, "one", false, false, false]);
  assert.equal(w.gate().last.reason, "second_review_required");
  // A fail after it: failed for good, whatever the earlier pass of this attempt said.
  w.review(17, 18, "rev6", FAIL, { model: "opus" });
  s = w.slice().s;
  assert.deepEqual([s.secondReview, s.passed, s.gaveUp, s.final], ["fail", false, true, true]);
  const g = w.gate();
  assert.equal(g.status, 0, g.stderr);
  assert.equal(g.last.reason, "slice_failed_for_good");

  // The same third attempt with a second pass instead: passed and final, and the gate lets it through.
  const p = world();
  p.plan();
  p.attempt(1, "impl1");
  p.review(3, 4, "rev1", FAIL, { model: "opus" });
  p.attempt(5, "impl2");
  p.review(7, 8, "rev2", FAIL, { model: "opus" });
  p.attempt(9, "impl3");
  p.review(11, 12, "rev3", PASS, { model: "opus" });
  p.review(13, 14, "rev4", PASS);
  const t = p.slice().s;
  assert.deepEqual([t.attempts, t.secondReview, t.passed, t.gaveUp, t.final], [3, "pass", true, false, true]);
  assert.equal(p.gate().last.reason, "reviewer_passed");
});

test("a log without the field folds as before: a risky slice with one opus pass is final", () => {
  const w = world();
  w.plan();
  w.attempt(1, "impl1", { strip: true });
  w.review(3, 4, "rev1", PASS, { model: "opus" });
  const s = w.slice().s;
  assert.deepEqual([s.reviewsNeeded, s.secondReview, s.passed, s.final], [1, null, true, true]);
  assert.equal(w.gate().last.reason, "reviewer_passed");
  // The switch off writes no field: the same.
  const off = world({ ORCH_SECOND_REVIEW: "off" });
  off.plan();
  off.attempt(1, "impl1");
  off.review(3, 4, "rev1", PASS, { model: "opus" });
  assert.deepEqual([off.slice().s.reviewsNeeded, off.slice().s.final], [1, true]);
  assert.equal(off.gate().last.reason, "reviewer_passed");
  // A later launch without the field (a record from before the rule) turns it off again for the slice.
  const mix = world();
  mix.plan();
  mix.attempt(1, "impl1");
  mix.review(3, 4, "rev1", FAIL, { model: "opus" });
  mix.attempt(5, "impl2", { strip: true });
  mix.review(7, 8, "rev2", PASS, { model: "opus" });
  assert.deepEqual([mix.slice().s.reviewsNeeded, mix.slice().s.final], [1, true]);
});

test("an unreadable log never blocks: an unreadable handbacks.jsonl leaves every slice on the one-review rule", () => {
  const w = world();
  w.plan();
  w.implLaunch(1, "impl1");
  w.implStop(2, "impl1");
  mkdirSync(join(w.state, "handbacks.jsonl")); // exists, cannot be read as a file
  w.review(3, 4, "rev1", PASS, { model: "opus" });
  assert.equal(loadRecords(SID, w.state).handbacks, null);
  const s = w.slice().s;
  assert.deepEqual([s.reviewsNeeded, s.passed, s.final], [1, true, true]);
  const g = w.gate();
  assert.equal(g.status, 0, g.stderr);
  assert.equal(g.last.reason, "reviewer_passed");
});

test("two failing reviews of one attempt with the same gap do not stall alone; two attempts that fail on it do", () => {
  const w = world();
  w.plan();
  w.attempt(1, "impl1");
  w.review(3, 4, "rev1", FAIL, { model: "opus" });
  w.review(5, 6, "rev2", FAIL, { model: "opus" });
  let s = w.slice().s;
  assert.deepEqual([s.secondReview, s.stalled, s.countedFails], ["fail", false, 2]);
  assert.equal(w.gate().last.reason, "last_reviewer_failed");
  // A second attempt whose reviews fail on the same gap, with a pass after the fail: the attempt failed, and it stalls.
  w.implResume(7, "impl1");
  w.handback(8, "impl1");
  w.implStop(8.5, "impl1");
  w.review(9, 10, "rev3", FAIL, { model: "opus" });
  w.review(11, 12, "rev4", PASS, { model: "opus" });
  s = w.slice().s;
  assert.deepEqual([s.secondReview, s.stalled, s.stallKeys.length], ["fail", true, 1]);
  assert.equal(w.gate().last.reason, "replan_required");
});

test("the rule holds with ORCH_ESCALATION off and always", () => {
  // off: one pass still blocks (and asks for no opus); two sonnet passes pass.
  const off = world({ ORCH_ESCALATION: "off" });
  off.plan();
  off.attempt(1, "impl1");
  off.review(3, 4, "rev1", PASS);
  const g = off.gate();
  assert.equal(g.last.reason, "second_review_required");
  assert.doesNotMatch(g.stderr, /opus/, "off drops only the opus requirement");
  off.review(5, 6, "rev2", PASS);
  assert.deepEqual([off.slice().s.final, off.gate().last.reason], [true, "reviewer_passed"]);
  // always: two sonnet passes still need an opus one; a sonnet and an opus pass pass.
  const always = world({ ORCH_ESCALATION: "always" });
  always.plan();
  always.attempt(1, "impl1");
  always.review(3, 4, "rev1", PASS);
  always.review(5, 6, "rev2", PASS);
  let s = always.slice().s;
  assert.deepEqual([s.secondReview, s.passed, s.final], ["pass", true, false]);
  assert.equal(always.gate().last.reason, "opus_review_required");
  always.review(7, 8, "rev3", PASS, { model: "opus" });
  s = always.slice().s;
  assert.deepEqual([s.final, always.gate().last.reason], [true, "reviewer_passed"]);
  // A not-RISKY slice under always: one opus pass, as before.
  const plain = world({ ORCH_ESCALATION: "always" });
  plain.plan();
  plain.attempt(1, "impl1", { slice: "b", risky: false });
  plain.review(3, 4, "rev1", PASS, { slice: "b", model: "opus" });
  assert.equal(plain.gate().last.reason, "reviewer_passed");
});
