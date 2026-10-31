// 0.4.0 review gate: the gap cutoff (ORCH_GAP_MIN), VALIDATE: gaps supersede and the stall gate (ORCH_STALL_GATE),
// in the fold (brief.mjs foldRuns) and through the real hooks (telemetry.mjs, journal.mjs, review-gate.mjs,
// plan-check.mjs). Spec: docs/brief-grammar.md, "Review counting", "Stall" and "Stall gate and gap cutoff in the gates".
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { doubtSignals, foldRuns, gapKey, gapMinimum, hasOpusPass, launchRecord, stallGateOn, stopRecord } from "../.claude/hooks/brief.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** @param {string} name */
const hook = (name) => join(root, ".claude", "hooks", name);

// ---- Fold helpers (the same shape as src/brief.test.mjs). ----
/** @typedef {{ launch?: object, stop?: object }} Item */
const T0 = Date.parse("2026-10-31T10:00:00Z");
/** @param {number} min */
const at = (min) => new Date(T0 + min * 60000).toISOString();
const PLAN = "PLAN REVIEW\nCONSTRAINTS:\nC1: no throw\nSLICE: a\nFILES: a.py\nDEPENDS: none\nGOAL: a\nCHECKS: C1\nSLICE: b\nFILES: b.py\nDEPENDS: a\nGOAL: b\nRISKY: yes";
const REPLAN = "PLAN REVIEW\nREPLAN: 1\nCONSTRAINTS:\nC1: no throw\nSLICE: a\nFILES: a.py\nDEPENDS: none\nGOAL: a, another way";
/** @param {Item[]} items */
const R = (...items) => ({ launches: items.flatMap((i) => (i.launch ? [i.launch] : [])), stops: items.flatMap((i) => (i.stop ? [i.stop] : [])) });
/** @param {number} min @param {string} [prompt] @returns {Item} */
const planLaunch = (min, prompt = PLAN) => ({ launch: launchRecord({ subagent_type: "orchestration:reviewer", prompt }, { ts: at(min), sessionId: "s1", agentId: `plan${min}` }) });
/** @param {number} min @param {string} slice @returns {Item[]} */
const implAttempt = (min, slice) => {
  const agentId = `impl-${slice}-${min}`;
  return [
    { launch: launchRecord({ subagent_type: "implementer", prompt: `SLICE: ${slice}\nFILES: ${slice}.py\nDEPENDS: none` }, { ts: at(min), sessionId: "s1", agentId }) },
    { stop: stopRecord({ ts: at(min + 0.5), sessionId: "s1", agentId, role: "implementer", reply: "STATUS: pass" }) },
  ];
};
/** A reviewer launched just before `min` and stopping at `min`. @param {number} min @param {string} slice @param {string} reply @param {{ validate?: boolean, model?: string }} [o] @returns {Item[]} */
const review = (min, slice, reply, o = {}) => {
  const agentId = `rev-${slice}-${min}`;
  const input = { subagent_type: "reviewer", prompt: `SLICE: ${slice}${o.validate ? "\nVALIDATE: gaps" : ""}`, model: o.model ?? "sonnet" };
  return [
    { launch: launchRecord(input, { ts: at(min - 0.25), sessionId: "s1", agentId }) },
    { stop: stopRecord({ ts: at(min), sessionId: "s1", agentId, role: "reviewer", reply }) },
  ];
};
/** Slice `slice` of the first run after the items. @param {Item[]} items @param {string} slice @param {Record<string, string>} [env] */
const sliceOf = (items, slice, env = {}) => {
  const s = foldRuns(R(planLaunch(0), ...items), { now: T0 + 30 * 60000, env }).runs[0]?.slices[slice];
  assert.ok(s, `slice ${slice} folded`);
  return s;
};
/** One attempt of slice a reviewed with `reply`. @param {string} reply @param {Record<string, string>} [env] */
const once = (reply, env = {}) => sliceOf([...implAttempt(1, "a"), ...review(2, "a", reply)], "a", env);

test("settings: ORCH_GAP_MIN is an integer 0-100 (else 80); ORCH_STALL_GATE is on unless off", () => {
  assert.equal(gapMinimum({}), 80);
  assert.equal(gapMinimum({ ORCH_GAP_MIN: "" }), 80);
  assert.equal(gapMinimum({ ORCH_GAP_MIN: "0" }), 0);
  assert.equal(gapMinimum({ ORCH_GAP_MIN: " 65 " }), 65);
  assert.equal(gapMinimum({ ORCH_GAP_MIN: "100" }), 100);
  for (const bad of ["101", "-1", "5.5", "abc", "80%", "1e2"]) assert.equal(gapMinimum({ ORCH_GAP_MIN: bad }), 80, bad);
  assert.equal(stallGateOn({}), true);
  assert.equal(stallGateOn({ ORCH_STALL_GATE: "on" }), true);
  assert.equal(stallGateOn({ ORCH_STALL_GATE: "OFF" }), false);
  assert.equal(stallGateOn({ ORCH_STALL_GATE: "off" }), false);
});

test("gap cutoff: a fail counts only with a gap at or above the cutoff; below it counts as a pass with low_confidence_fail", () => {
  const below = once("STATUS: fail\nGAP: 79 maybe an edge case");
  assert.deepEqual([below.reviews[0]?.status, below.reviews[0]?.counted, below.reviews[0]?.lowConfidence], ["fail", "pass", true]);
  assert.deepEqual([below.passed, below.final, below.countedFails], [true, true, 0]);
  assert.deepEqual(below.signals, ["low_confidence_fail"]);
  assert.deepEqual(doubtSignals(below), ["low_confidence_fail"], "the opus escalation applies");
  assert.deepEqual(doubtSignals(below, { ORCH_ESCALATION: "off" }), []);
  assert.equal(hasOpusPass(below), false);

  const atCut = once("STATUS: fail\nGAP: 80 no test for the empty input");
  assert.deepEqual([atCut.reviews[0]?.counted, atCut.passed, atCut.countedFails, atCut.reviews[0]?.keys], ["fail", false, 1, [gapKey("no test for the empty input")]]);
  const above = once("STATUS: fail\nGAP: 95 crashes on empty input\nGAP: 20 naming");
  assert.deepEqual([above.reviews[0]?.counted, above.reviews[0]?.keys], ["fail", [gapKey("crashes on empty input")]], "only gaps at or above the cutoff become keys");

  // The cutoff comes from ORCH_GAP_MIN.
  assert.equal(once("STATUS: fail\nGAP: 85 x", { ORCH_GAP_MIN: "90" }).reviews[0]?.counted, "pass");
  assert.equal(once("STATUS: fail\nGAP: 85 x", { ORCH_GAP_MIN: "bogus" }).reviews[0]?.counted, "fail", "invalid falls back to 80");
  // An opus reviewer's low-confidence fail counts as an opus pass.
  assert.equal(hasOpusPass(sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 30 nit", { model: "opus" })], "a")), true);
});

test("gap cutoff: a null confidence, a failed constraint answer and an old-style fail (no GAP lines) keep failing", () => {
  assert.equal(once("STATUS: fail\nGAP: no confidence given").reviews[0]?.counted, "fail", "null confidence counts as 100");
  assert.deepEqual(once("STATUS: fail\nGAP: no confidence given").reviews[0]?.keys, [gapKey("no confidence given")]);
  assert.equal(once("STATUS: fail\nC1: fail throws on '['\nGAP: 10 style").reviews[0]?.counted, "fail");
  assert.equal(once("STATUS: fail\nGAPS: still broken").reviews[0]?.counted, "fail", "an old-style reply");
  assert.equal(once("STATUS: fail").reviews[0]?.counted, "fail");
  // A pass with gaps stays a pass; a reply without STATUS stays null.
  assert.equal(once("STATUS: pass\nGAP: 95 x").reviews[0]?.counted, "pass");
  assert.equal(once("looks fine\nGAP: 10 x").reviews[0]?.counted, null);
  // A record without the 0.4.0 gaps field folds as before: a fail.
  const items = [...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 10 x")];
  const old = items.map((it) => {
    if (!it.stop) return it;
    const { gaps, quotes, ...rest } = /** @type {any} */ (it.stop);
    return { stop: rest };
  });
  assert.equal(sliceOf(old, "a").reviews[0]?.counted, "fail");
});

test("gap cutoff: ORCH_GAP_MIN=0 makes every fail count (0.3.0 behaviour)", () => {
  const s = once("STATUS: fail\nGAP: 0 tiny\nGAP: 10 nit", { ORCH_GAP_MIN: "0" });
  assert.deepEqual([s.reviews[0]?.counted, s.reviews[0]?.lowConfidence, s.passed, s.countedFails], ["fail", false, false, 1]);
  assert.deepEqual(s.signals, ["retry"], "a counted fail is a retry signal, as in 0.3.0; no low_confidence_fail");
  // The explicit fold option wins over env.
  const f = foldRuns(R(planLaunch(0), ...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 10 nit")), { now: T0 + 30 * 60000, gapMin: 0 });
  assert.equal(f.runs[0]?.slices.a?.reviews[0]?.counted, "fail");
});

test("VALIDATE: gaps supersedes the earlier reviews of the same attempt, and only those", () => {
  const items = [...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 wrong"), ...review(3, "a", "STATUS: pass\nC1: pass (cmd) t -> ok", { validate: true })];
  const s = sliceOf(items, "a");
  assert.deepEqual(s.reviews.map((r) => [r.status, r.counted, r.superseded, r.validate]), [["fail", null, true, false], ["pass", "pass", false, true]]);
  assert.deepEqual([s.passed, s.countedFails], [true, 0]);
  assert.deepEqual(s.signals, [], "a superseded fail is no retry");
  // A validating fail supersedes an earlier pass.
  const v = sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: pass"), ...review(3, "a", "STATUS: fail\nGAP: 90 broken", { validate: true })], "a");
  assert.deepEqual([v.reviews[0]?.counted, v.reviews[1]?.counted, v.passed, v.countedFails], [null, "fail", false, 1]);
  // Reviews of an earlier attempt are not superseded.
  const e = sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 broken"), ...implAttempt(3, "a"), ...review(4, "a", "STATUS: pass", { validate: true })], "a");
  assert.deepEqual([e.reviews[0]?.counted, e.reviews[0]?.superseded, e.countedFails, e.passed], ["fail", false, 1, true]);
  assert.deepEqual(e.signals, ["retry"]);
});

test("stall: the last two counted fails share a gap key at or above the cutoff, and no REPLAN started since", () => {
  const two = [...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 Crashes on empty input"), ...implAttempt(3, "a"), ...review(4, "a", "STATUS: fail\nGAP: 85 crashes on EMPTY input!\nGAP: 90 other")];
  const s = sliceOf(two, "a");
  assert.deepEqual([s.stalled, s.stallKeys, s.stalledAt, s.countedFails, s.final], [true, [gapKey("crashes on empty input")], Date.parse(at(4)), 2, false]);

  // No shared key, a shared key below the cutoff, or a pass between them: no stall.
  assert.equal(sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 one"), ...implAttempt(3, "a"), ...review(4, "a", "STATUS: fail\nGAP: 90 two")], "a").stalled, false);
  assert.equal(sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 one\nGAP: 50 low"), ...implAttempt(3, "a"), ...review(4, "a", "STATUS: fail\nGAP: 90 two\nGAP: 60 low")], "a").stalled, false);
  assert.equal(sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 one"), ...review(3, "a", "STATUS: pass"), ...implAttempt(4, "a"), ...review(5, "a", "STATUS: fail\nGAP: 90 one")], "a").stalled, false);
  // Old-style fails carry no keys: no stall.
  assert.equal(sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail"), ...implAttempt(3, "a"), ...review(4, "a", "STATUS: fail")], "a").stalled, false);
  // A low-confidence fail between two same-key fails counts as a pass between them.
  assert.equal(sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 one"), ...review(3, "a", "STATUS: fail\nGAP: 40 meh"), ...implAttempt(4, "a"), ...review(5, "a", "STATUS: fail\nGAP: 90 one")], "a").stalled, false);

  // A REPLAN plan review started after the second fail clears it; one before it does not.
  assert.equal(sliceOf([...two, planLaunch(5, REPLAN)], "a").stalled, false);
  assert.equal(sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 one"), planLaunch(2.5, REPLAN), ...implAttempt(3, "a"), ...review(4, "a", "STATUS: fail\nGAP: 90 one")], "a").stalled, true);
  // A plain PLAN REVIEW (no REPLAN) opens a new run, where the slice starts fresh.
  const f = foldRuns(R(planLaunch(0), ...two, planLaunch(5)), { now: T0 + 30 * 60000 });
  assert.deepEqual([f.runs[0]?.slices.a?.stalled, f.runs[1]?.slices.a?.stalled], [true, false]);
  // ORCH_GAP_MIN=0 widens the keys: a shared low gap stalls too.
  assert.equal(sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 30 low"), ...implAttempt(3, "a"), ...review(4, "a", "STATUS: fail\nGAP: 30 low")], "a", { ORCH_GAP_MIN: "0" }).stalled, true);
});

test("stall: two same-gap fails of one attempt (a second opinion) do not stall; of two attempts they do", () => {
  const same = sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 crashes on empty input"), ...review(3, "a", "STATUS: fail\nGAP: 95 crashes on empty input")], "a");
  assert.deepEqual([same.stalled, same.countedFails, same.reviews[0]?.implAt === same.reviews[1]?.implAt], [false, 2, true]);
  const diff = sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 crashes on empty input"), ...implAttempt(3, "a"), ...review(4, "a", "STATUS: fail\nGAP: 95 crashes on empty input")], "a");
  assert.deepEqual([diff.stalled, diff.stallKeys, diff.attempts], [true, [gapKey("crashes on empty input")], 2]);
  // A second opinion after the retry keeps the stall: the latest fail is still compared with the earlier attempt's.
  const third = sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 x"), ...implAttempt(3, "a"), ...review(4, "a", "STATUS: fail\nGAP: 90 x"), ...review(5, "a", "STATUS: fail\nGAP: 90 x")], "a");
  assert.equal(third.stalled, true);
  // A pass in the retry's attempt sits between them: no stall.
  const passed = sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 x"), ...implAttempt(3, "a"), ...review(4, "a", "STATUS: pass"), ...review(5, "a", "STATUS: fail\nGAP: 90 x")], "a");
  assert.equal(passed.stalled, false);
});

test("stall: three failed attempts still end the slice for good, which is never stalled", () => {
  const items = [1, 3, 5].flatMap((m) => [...implAttempt(m, "a"), ...review(m + 1, "a", "STATUS: fail\nGAP: 90 same gap")]);
  const s = sliceOf(items, "a");
  assert.deepEqual([s.gaveUp, s.final, s.stalled, s.countedFails, s.attempts], [true, true, false, 3, 3]);
});

// ---- Through the hooks: every agent launched in the background, as src/hooks.test.ts does. ----
/** @param {Record<string, string>} [extraEnv] */
function session(extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orch-gate2-"));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: "", ORCH_ESCALATION: "", ORCH_RUN_STALE_MIN: "", ORCH_ALLOW_BUILTINS: "", ORCH_GAP_MIN: "", ORCH_STALL_GATE: "", ...extraEnv };
  /** @param {string} name @param {object} payload @param {Record<string, string>} [more] */
  const run = (name, payload, more = {}) => spawnSync("node", [hook(name)], { input: JSON.stringify({ session_id: "s1", ...payload }), env: { ...env, ...more }, encoding: "utf8" });
  let n = 0;
  /** @param {string} file */
  const log = (file) =>
    readFileSync(join(dir, ".claude", "state", file), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  const s = {
    dir,
    run,
    /** @param {string} type @param {string} prompt @param {string} reply @param {string} [model] */
    agent(type, prompt, reply, model) {
      const id = `ag${++n}${type.replace(/\W/g, "")}`;
      run("telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: id, agent_type: type });
      run("journal.mjs", { hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: type, prompt, ...(model ? { model } : {}) }, tool_response: { status: "async_launched", agentId: id } });
      const p = { hook_event_name: "SubagentStop", agent_id: id, agent_type: type, last_assistant_message: reply };
      run("telemetry.mjs", p);
      run("journal.mjs", p);
      return id;
    },
    plan(text = PLAN) {
      s.agent("orchestration:reviewer", text, "STATUS: pass");
    },
    /** @param {string} slice */
    impl(slice) {
      return s.agent("orchestration:implementer", `SLICE: ${slice}\nFILES: ${slice}.py\nDEPENDS: none`, "STATUS: pass");
    },
    /** @param {string} slice @param {string} reply @param {{ model?: string, validate?: boolean }} [o] */
    review(slice, reply, o = {}) {
      return s.agent("orchestration:reviewer", `SLICE: ${slice}${o.validate ? "\nVALIDATE: gaps" : ""}`, reply, o.model);
    },
    /** @param {Record<string, string>} [more] */
    gate(more = {}) {
      return run("review-gate.mjs", {}, more);
    },
    /** The plan check on an implementer launch of `slice`. @param {string} slice @param {Record<string, string>} [more] */
    check(slice, more = {}) {
      return run("plan-check.mjs", { hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: { subagent_type: "orchestration:implementer", prompt: `SLICE: ${slice}\nFILES: ${slice}.py\nDEPENDS: none` } }, more);
    },
    last: () => log("gates.jsonl").filter((g) => g.gate === "review").at(-1),
    lastCheck: () => log("plan-check.jsonl").at(-1),
  };
  return s;
}
/** A session with slice a stalled: two attempts whose reviews report the same gap at 90. @param {Record<string, string>} [env] */
function stalled(env = {}) {
  const s = session({ ORCH_ESCALATION: "off", ...env });
  s.plan();
  s.impl("a");
  s.review("a", "STATUS: fail\nGAP: 90 crashes on empty input");
  s.impl("a");
  s.review("a", "STATUS: fail\nGAP: 90 Crashes on empty input.");
  return s;
}

test("Stop gate: a stalled slice blocks with replan_required twice, then gives up as replan_required_gave_up", () => {
  const s = stalled();
  let r = s.gate();
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual([s.last().reason, s.last().slice], ["replan_required", "a"]);
  assert.match(r.stderr, /same gap.*PLAN REVIEW and REPLAN/);
  assert.equal(s.gate().status, 2);
  r = s.gate();
  assert.equal(r.status, 0);
  assert.equal(s.last().reason, "replan_required_gave_up");
  assert.match(JSON.parse(r.stdout).systemMessage, /gave up after 2 blocks \(replan_required\)/);
  // The log holds parsed fields only: no gap text.
  assert.doesNotMatch(readFileSync(join(s.dir, ".claude", "state", "gates.jsonl"), "utf8"), /crashes|empty input/i);
});

test("Stop gate: a REPLAN plan review clears the stall; ORCH_STALL_GATE=off gates as 0.3.0 (last_reviewer_failed)", () => {
  const s = stalled();
  s.plan(REPLAN);
  assert.equal(s.gate().status, 2);
  assert.equal(s.last().reason, "last_reviewer_failed");

  const off = stalled({ ORCH_STALL_GATE: "off" });
  assert.equal(off.gate().status, 2);
  assert.equal(off.last().reason, "last_reviewer_failed");
  assert.equal(off.gate().status, 2);
  assert.equal(off.gate().status, 0);
  assert.equal(off.last().reason, "max_blocks_reached");
});

test("Stop gate: three failed attempts with the same gap still end as slice_failed_for_good", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  for (let i = 0; i < 3; i++) {
    s.impl("a");
    s.review("a", "STATUS: fail\nGAP: 90 still crashes");
  }
  const r = s.gate();
  assert.equal(r.status, 0);
  assert.deepEqual([s.last().reason, s.last().failed_for_good], ["slice_failed_for_good", ["a"]]);
});

test("Stop gate: a low-confidence fail counts as a pass, asks for an opus review, and ORCH_GAP_MIN=0 restores the fail", () => {
  const s = session();
  s.plan();
  s.impl("a");
  s.review("a", "STATUS: fail\nGAP: 40 maybe rename x");
  let r = s.gate();
  assert.equal(r.status, 2);
  assert.equal(s.last().reason, "opus_review_required");
  assert.match(r.stderr, /doubt signals: low_confidence_fail/);
  assert.ok(s.last().skips.includes("last_reviewer_failed:a:low_confidence"));
  s.review("a", "STATUS: pass", { model: "opus" });
  assert.equal(s.gate().status, 0);
  assert.equal(s.last().reason, "reviewer_passed");

  const off = session({ ORCH_ESCALATION: "off" });
  off.plan();
  off.impl("a");
  off.review("a", "STATUS: fail\nGAP: 40 maybe rename x");
  assert.equal(off.gate().status, 0);
  assert.equal(off.last().reason, "reviewer_passed");
  r = off.gate({ ORCH_GAP_MIN: "0" });
  assert.equal(r.status, 2);
  assert.equal(off.last().reason, "last_reviewer_failed");
});

test("Stop gate: a VALIDATE: gaps review supersedes the failed review of the same attempt", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  s.impl("a");
  s.review("a", "STATUS: fail\nGAP: 95 wrong result");
  assert.equal(s.gate().status, 2);
  s.review("a", "STATUS: pass", { validate: true });
  assert.equal(s.gate().status, 0);
  assert.equal(s.last().reason, "reviewer_passed");
});

test("plan check: a stalled slice's implementer launch blocks with replan_required twice, then replan_required_gave_up", () => {
  const s = stalled();
  let r = s.check("a");
  assert.equal(r.status, 2, r.stderr);
  assert.equal(s.lastCheck().reason, "replan_required");
  assert.match(r.stderr, /slice a is stalled.*REPLAN/);
  assert.equal(s.check("a").status, 2);
  r = s.check("a");
  assert.equal(r.status, 0);
  assert.equal(s.lastCheck().reason, "replan_required_gave_up");
  // Another slice is not affected.
  assert.equal(s.check("b").status, 0);
  assert.equal(s.lastCheck().reason, "ok");
});

test("plan check: after a REPLAN plan review, or with ORCH_STALL_GATE=off, the launch goes through", () => {
  const s = stalled();
  assert.equal(s.check("a").status, 2);
  s.plan(REPLAN);
  const r = s.check("a");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.lastCheck().reason, "ok");

  const off = stalled({ ORCH_STALL_GATE: "off" });
  assert.equal(off.check("a").status, 0);
  assert.equal(off.lastCheck().reason, "ok");
  // Not stalled without a shared gap.
  const diff = session({ ORCH_ESCALATION: "off" });
  diff.plan();
  diff.impl("a");
  diff.review("a", "STATUS: fail\nGAP: 90 one thing");
  diff.impl("a");
  diff.review("a", "STATUS: fail\nGAP: 90 another thing");
  assert.equal(diff.check("a").status, 0);
});

test("hooks exit 0 on malformed input with the new switches set", () => {
  const s = session({ ORCH_GAP_MIN: "abc", ORCH_STALL_GATE: "off" });
  for (const name of ["review-gate.mjs", "plan-check.mjs"]) {
    const r = spawnSync("node", [hook(name)], { input: "not json{", env: { ...process.env, CLAUDE_PROJECT_DIR: s.dir }, encoding: "utf8" });
    assert.equal(r.status, 0, name);
  }
});
