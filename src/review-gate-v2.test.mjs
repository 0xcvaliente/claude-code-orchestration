// 0.4.0 review gate: the gap cutoff (ORCH_GAP_MIN), VALIDATE: gaps supersede and the stall gate (ORCH_STALL_GATE),
// in the fold (brief.mjs foldRuns) and through the real hooks (telemetry.mjs, journal.mjs, review-gate.mjs,
// plan-check.mjs). Spec: docs/brief-grammar.md, "Review counting", "Stall" and "Stall gate and gap cutoff in the gates".
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { currentReviews, doubtSignals, foldRuns, gapKey, gapMinimum, hasOpusPass, launchRecord, stallGateOn, stopRecord } from "../.claude/hooks/brief.mjs";

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
/** The plan reviewer `agentId` (plan<launch min>) stops at `min`. @param {number} min @param {string} agentId @returns {Item} */
const planStop = (min, agentId) => ({ stop: stopRecord({ ts: at(min), sessionId: "s1", agentId, role: "reviewer", slice: "plan", reply: "STATUS: pass" }) });
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
  // Changed for f1-run-split: low_confidence_fail is a doubt signal, so the counted pass is not final until an opus pass.
  assert.deepEqual([below.passed, below.final, below.countedFails], [true, false, 0]);
  const confirmed = sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 79 maybe an edge case"), ...review(3, "a", "STATUS: pass", { model: "opus" })], "a");
  assert.deepEqual([confirmed.passed, confirmed.final], [true, true], "the opus pass makes it final");
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

test("stall: the last two counted fails share a gap key at or above the cutoff, and no REPLAN finished since", () => {
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

  // A REPLAN plan review whose reviewer stopped after the second fail clears it; one still running does not, nor one
  // that finished before the stall. The REPLAN need not name the slice (replacement slices get new ids).
  assert.equal(sliceOf([...two, planLaunch(5, REPLAN)], "a").stalled, true, "a REPLAN still running keeps the stall");
  assert.equal(sliceOf([...two, planLaunch(5, REPLAN), planStop(6, "plan5")], "a").stalled, false, "a finished REPLAN clears it");
  const other = "PLAN REVIEW\nREPLAN: 1\nSLICE: a2\nFILES: a.py\nDEPENDS: none\nGOAL: a, split";
  assert.equal(sliceOf([...two, planLaunch(5, other), planStop(6, "plan5")], "a").stalled, false, "a REPLAN with a replacement slice id clears it too");
  assert.equal(sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 one"), planLaunch(2.5, REPLAN), planStop(2.7, "plan2.5"), ...implAttempt(3, "a"), ...review(4, "a", "STATUS: fail\nGAP: 90 one")], "a").stalled, true);
  // Launched before the second fail, finished after it: it finished after the stall, so it clears it.
  assert.equal(sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 one"), planLaunch(2.5, REPLAN), ...implAttempt(3, "a"), ...review(4, "a", "STATUS: fail\nGAP: 90 one"), planStop(5, "plan2.5")], "a").stalled, false);
  // A plan reviewer stop of a plain plan review (no REPLAN) does not count.
  assert.equal(sliceOf([...two, planStop(5, "plan0")], "a").stalled, true);
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

test("VALIDATE: a validation reply with no STATUS supersedes nothing, so a stall stays", () => {
  const items = [...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 x"), ...implAttempt(3, "a"), ...review(4, "a", "STATUS: fail\nGAP: 90 x"), ...review(5, "a", "I looked at it.", { validate: true })];
  const s = sliceOf(items, "a");
  assert.deepEqual(s.reviews.map((r) => [r.status, r.counted, r.superseded]), [["fail", "fail", false], ["fail", "fail", false], [null, null, false]]);
  assert.deepEqual([s.stalled, s.countedFails], [true, 2]);
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
      const id = s.launch(type, prompt, model);
      s.stop(id, type, reply);
      return id;
    },
    /** Launch an agent in the background; returns its agent id. @param {string} type @param {string} prompt @param {string} [model] */
    launch(type, prompt, model) {
      const id = `ag${++n}${type.replace(/\W/g, "")}`;
      run("telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: id, agent_type: type });
      run("journal.mjs", { hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: type, prompt, ...(model ? { model } : {}) }, tool_response: { status: "async_launched", agentId: id } });
      return id;
    },
    /** @param {string} id @param {string} type @param {string} reply */
    stop(id, type, reply) {
      const p = { hook_event_name: "SubagentStop", agent_id: id, agent_type: type, last_assistant_message: reply };
      run("telemetry.mjs", p);
      run("journal.mjs", p);
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

test("Stop gate: a finished REPLAN plan review clears the stall, a running one does not; ORCH_STALL_GATE=off gates as 0.3.0", () => {
  const s = stalled();
  const replan = s.launch("orchestration:reviewer", REPLAN);
  // background_tasks [] so the gate does not defer for the running reviewer: the stall is what is judged.
  assert.equal(s.run("review-gate.mjs", { background_tasks: [] }).status, 2);
  assert.equal(s.last().reason, "replan_required", "a REPLAN still running keeps the stall");
  s.stop(replan, "orchestration:reviewer", "STATUS: pass");
  assert.equal(s.gate().status, 2);
  assert.equal(s.last().reason, "last_reviewer_failed", "a finished REPLAN clears it");

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

test("Stop gate: a slice id like constructor or __proto__ does not crash the gate; the unreviewed slice still blocks", () => {
  for (const id of ["constructor", "__proto__"]) {
    const s = session({ ORCH_ESCALATION: "off" });
    s.agent("orchestration:implementer", `SLICE: ${id}\nPATH: light\nFILES: a.py\nDEPENDS: none`, "STATUS: pass");
    const r = s.gate();
    assert.equal(r.status, 2, `${id}: ${r.stderr}`);
    assert.equal(s.last().reason, "no_reviewer_after_last_implementer");
    assert.match(r.stderr, new RegExp(`slice ${id} \\(run 1\\)`));
  }
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

test("plan check: after a finished REPLAN plan review, or with ORCH_STALL_GATE=off, the launch goes through", () => {
  const s = stalled();
  assert.equal(s.check("a").status, 2);
  const replan = s.launch("orchestration:reviewer", REPLAN);
  assert.equal(s.check("a").status, 2, "a REPLAN still running keeps the stall");
  assert.equal(s.lastCheck().reason, "replan_required");
  s.stop(replan, "orchestration:reviewer", "STATUS: pass");
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

// ---- 1.2.0: implementer_unfinished. A subagent that runs out of turns fires no SubagentStop, so its implementer has a
// SubagentStart and a launch record and nothing else: no test gate ran and the fold counts no attempt. ----
const IMPL = "orchestration:implementer";
/** @param {string} slice @param {string} [extra] */
const implBrief = (slice, extra = "") => `SLICE: ${slice}\nFILES: ${slice}.py\nDEPENDS: none${extra}`;

test("Stop gate: an implementer that started and never stopped blocks with implementer_unfinished, then gives up", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  const id = s.launch(IMPL, implBrief("a"));
  // Still listed as running: the gate defers, as before.
  assert.equal(s.run("review-gate.mjs", { background_tasks: [{ id, type: "subagent", status: "running", agent_type: IMPL }] }).status, 0);
  assert.equal(s.last().reason, "agents_running");
  // Nothing runs any more and it never stopped: the turn limit, or a kill.
  let r = s.run("review-gate.mjs", { background_tasks: [] });
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual([s.last().reason, s.last().slice], ["implementer_unfinished", "a"]);
  assert.match(r.stderr, new RegExp(`slice a: its implementer \\(agent ${id}\\) started and never finished.*SendMessage \\(to: ${id}\\)`));
  assert.equal(s.run("review-gate.mjs", { background_tasks: [] }).status, 2);
  r = s.run("review-gate.mjs", { background_tasks: [] });
  assert.equal(r.status, 0);
  assert.equal(s.last().reason, "implementer_unfinished_gave_up");
  assert.match(JSON.parse(r.stdout).systemMessage, /gave up after 2 blocks \(implementer_unfinished\).*slice a is unverified/);
});

test("Stop gate: the light path's only implementer, unfinished, is no longer no_implementer_in_session", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  const id = s.launch(IMPL, implBrief("solo", "\nPATH: light"));
  const r = s.run("review-gate.mjs", { background_tasks: [] });
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual([s.last().reason, s.last().slice], ["implementer_unfinished", "solo"]);
  // Resumed with SendMessage, it starts again and stops: now the usual review rule gates the slice.
  s.run("telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: id, agent_type: IMPL });
  s.stop(id, IMPL, "STATUS: pass");
  assert.equal(s.run("review-gate.mjs", { background_tasks: [] }).status, 2);
  assert.equal(s.last().reason, "no_reviewer_after_last_implementer");
  s.review("solo", "STATUS: pass");
  assert.equal(s.run("review-gate.mjs", { background_tasks: [] }).status, 0);
  assert.equal(s.last().reason, "reviewer_passed");
});

test("Stop gate: a fresh implementer that finishes the slice takes an unfinished one over; another slice's stop does not", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  s.launch(IMPL, implBrief("a"));
  s.impl("b"); // a sibling slice finishing later does not cover slice a
  s.review("b", "STATUS: pass", { model: "opus" });
  assert.equal(s.run("review-gate.mjs", { background_tasks: [] }).status, 2);
  assert.deepEqual([s.last().reason, s.last().slice], ["implementer_unfinished", "a"]);
  s.impl("a"); // a fresh implementer for the same slice
  assert.equal(s.run("review-gate.mjs", { background_tasks: [] }).status, 2);
  assert.deepEqual([s.last().reason, s.last().slice], ["no_reviewer_after_last_implementer", "a"]);
  s.review("a", "STATUS: pass\nC1: pass (cmd) pytest -> 3 passed");
  assert.equal(s.run("review-gate.mjs", { background_tasks: [] }).status, 0);
  assert.equal(s.last().reason, "reviewer_passed");
});

test("Stop gate: an implementer start with no launch record (a workflow agent) is left to its script", () => {
  const s = session();
  s.run("telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: "wf-impl-1", agent_type: "implementer" });
  assert.equal(s.run("review-gate.mjs", { background_tasks: [] }).status, 0);
  assert.equal(s.last().reason, "no_implementer_in_session");
  // The same for a launch whose brief carries the workflow marker.
  const t = session();
  t.launch(IMPL, `ORCHESTRATION: workflow\n${implBrief("a")}`);
  assert.equal(t.run("review-gate.mjs", { background_tasks: [] }).status, 0);
  assert.equal(t.last().reason, "no_implementer_in_session");
});

test("Stop gate: an unfinished implementer is gated once for the session: two blocks, one give-up, then left alone", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  const orphan = s.launch(IMPL, implBrief("a"));
  const stop = () => s.run("review-gate.mjs", { background_tasks: [] });
  assert.deepEqual([stop().status, stop().status], [2, 2]);
  assert.deepEqual(s.last().unfinished, [orphan], "each block records the agents it named");
  assert.equal(stop().status, 0);
  assert.deepEqual([s.last().reason, s.last().unfinished], ["implementer_unfinished_gave_up", [orphan]]);
  // After the give-up it is silent, with no systemMessage.
  const quiet = stop();
  assert.deepEqual([quiet.status, quiet.stdout, s.last().reason], [0, "", "no_implementer_in_session"]);
  // Later work in the session is judged on its own: a new implementer stop does not bring the old one back.
  s.impl("b");
  assert.equal(stop().status, 2);
  assert.deepEqual([s.last().reason, s.last().slice, s.last().unfinished], ["no_reviewer_after_last_implementer", "b", undefined]);
  s.review("b", "STATUS: pass", { model: "opus" });
  assert.equal(stop().status, 0);
  assert.equal(s.last().reason, "reviewer_passed");
});

test("Stop gate: an unfinished implementer next to another open problem is named in every block and still given up on once", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  const orphan = s.launch(IMPL, implBrief("a"));
  s.impl("b");
  s.review("b", "STATUS: fail\nGAP: 90 broken");
  const stop = () => s.run("review-gate.mjs", { background_tasks: [] });
  // The unfinished implementer comes first; the failed review is listed with it.
  const first = stop();
  assert.equal(first.status, 2);
  assert.equal(s.last().reason, "implementer_unfinished");
  assert.match(first.stderr, /never finished.*Also: slice b.*STATUS: fail/s);
  assert.equal(stop().status, 2);
  // Its two blocks are spent: the failed review of b now carries the block, still naming the unfinished one.
  assert.equal(stop().status, 2);
  assert.deepEqual([s.last().reason, s.last().unfinished], ["last_reviewer_failed", [orphan]]);
  assert.equal(stop().status, 2);
  const gaveUp = stop();
  assert.equal(gaveUp.status, 0);
  assert.match(JSON.parse(gaveUp.stdout).systemMessage, /gave up after 2 blocks \(implementer_unfinished, last_reviewer_failed\)/);
  assert.deepEqual(s.last().unfinished, [orphan]);
});

// ---- T-9 (audit 2026-11-16, fold side): a test gate that gave up for the slice's latest attempt is a doubt signal. ----
test("T-9 fold: max_blocks_reached (gate test) or bugfix_unverified_gave_up of the latest attempt adds test_gate_gave_up", () => {
  const items = [...implAttempt(1, "a"), ...review(2, "a", "STATUS: pass")];
  /** @param {string} reason @param {number} min @param {string} [gate] */
  const fold = (reason, min, gate = "test") => {
    const recs = { ...R(planLaunch(0), ...items), gates: [{ ts: at(min), gate, decision: "allow", reason, session_id: "s1", agent_id: "impl-a-1" }] };
    return foldRuns(recs, { now: T0 + 30 * 60000, env: {} }).runs[0]?.slices.a;
  };
  for (const reason of ["max_blocks_reached", "bugfix_unverified_gave_up"]) {
    const s = fold(reason, 1.6);
    assert.deepEqual([s?.signals, s?.passed, s?.final], [["test_gate_gave_up"], true, false], reason);
  }
  assert.deepEqual(fold("max_blocks_reached", 1.6, "review")?.signals, [], "only the test gate's give-up");
  assert.deepEqual(fold("tests_passed", 1.6)?.signals, []);
  assert.deepEqual(foldRuns({ ...R(planLaunch(0), ...items), gates: [{ ts: at(1.6), gate: "test", reason: "max_blocks_reached", session_id: "s1", agent_id: "impl-a-1" }] }, { now: T0, env: { ORCH_ESCALATION: "off" } }).runs[0]?.slices.a?.signals, []);
});

// ---- G-8 (audit 2026-11-16): a reviewer stop marked `continues` (journal.mjs: stop_hook_active true after an earlier
// stop of the same agent, the stop after a forced hand-back) replaces that reviewer's previous review of the slice. ----
/** A second stop record of the reviewer that stopped at `min` in review(min, ...). @param {number} min @param {string} slice @param {string} reply @param {boolean} continues @returns {Item} */
const again = (min, slice, reply, continues) => {
  const first = `rev-${slice}-${min}`;
  const rec = stopRecord({ ts: at(min + 0.1), sessionId: "s1", agentId: first, role: "reviewer", reply });
  return { stop: continues ? { ...rec, continues: true } : rec };
};
test("G-8 fold: a continued reviewer stop is the same review; an unmarked second stop (a resume) is another review", () => {
  const env = { ORCH_ESCALATION: "" };
  const one = sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 broken"), again(2, "a", "STATUS: fail\nGAP: 90 broken", true)], "a", env);
  assert.deepEqual([one.reviews.length, one.countedFails], [1, 1]);
  // The later record replaces the earlier: the delivered report decides.
  const replaced = sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: pass\nOPEN: none"), again(2, "a", "STATUS: pass\nOPEN: the edge case", true)], "a", env);
  assert.deepEqual([replaced.reviews.length, replaced.signals], [1, ["open_items"]]);
  // A resume of the same reviewer that turns a fail into a pass is two reviews: the fail still counts (retry).
  const resumed = sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 broken"), again(2, "a", "STATUS: pass", false)], "a", env);
  assert.deepEqual([resumed.reviews.length, resumed.signals], [2, ["retry"]]);
  // 2.0.1 (D4): a continued stop after an implementer attempt of the slice still replaces that review, where it stands:
  // it keeps its attempt, so the later attempt stays unreviewed (it used to count as a review of the later attempt).
  const later = sliceOf([...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 broken"), ...implAttempt(2.05, "a"), again(2, "a", "STATUS: pass", true)], "a", env);
  assert.deepEqual([later.reviews.length, later.reviews[0]?.status, currentReviews(later).length], [1, "pass", 0]);
});

// ---- G-2 (audit 2026-11-16): the test gate runs beside the journal at an implementer's stop and decides minutes later,
// so it can block after a reviewer already passed the slice. An implementer whose latest test-gate record is a block
// with no later SubagentStop is gated like an unfinished one. ----
/** @param {{ dir: string }} s @param {string} agentId @param {string} decision @param {string} reason */
const testGate = (s, agentId, decision, reason) =>
  appendFileSync(join(s.dir, ".claude", "state", "gates.jsonl"), `${JSON.stringify({ ts: new Date(Date.now() + 5).toISOString(), gate: "test", decision, reason, session_id: "s1", agent_id: agentId })}\n`);

test("G-2 Stop gate: a test-gate block after a passing review, with no later stop, blocks as implementer_unfinished, then gives up", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  const id = s.impl("a");
  s.review("a", "STATUS: pass");
  testGate(s, id, "block", "tests_failed");
  const stop = () => s.run("review-gate.mjs", { background_tasks: [] });
  let r = stop();
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual([s.last().reason, s.last().slice, s.last().unfinished], ["implementer_unfinished", "a", [id]]);
  assert.match(r.stderr, new RegExp(`test gate.*SendMessage \\(to: ${id}\\)`));
  assert.equal(stop().status, 2);
  r = stop();
  assert.equal(r.status, 0);
  assert.equal(s.last().reason, "implementer_unfinished_gave_up");
});

test("2.0.0 Stop gate: a hand-back gate's allow after a SubagentStop tests_failed block never clears it (implementer_unfinished)", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  const id = s.impl("a");
  s.review("a", "STATUS: pass");
  testGate(s, id, "block", "tests_failed");
  const later = { ts: new Date(Date.now() + 50).toISOString(), gate: "test", decision: "allow", reason: "tests_passed", session_id: "s1", agent_id: id, at: "handback", handback_id: "toolu_z" };
  appendFileSync(join(s.dir, ".claude", "state", "gates.jsonl"), `${JSON.stringify(later)}\n`);
  const r = s.run("review-gate.mjs", { background_tasks: [] });
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual([s.last().reason, s.last().slice, s.last().unfinished], ["implementer_unfinished", "a", [id]]);
});

test("G-2 Stop gate: a test-gate block followed by a stop of the same implementer is answered; an allow record never gates", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  const id = s.impl("a");
  testGate(s, id, "block", "tests_failed");
  // The agent fixed the tests and stopped again; then the review passed.
  s.stop(id, IMPL, "STATUS: pass");
  s.review("a", "STATUS: pass");
  assert.equal(s.run("review-gate.mjs", { background_tasks: [] }).status, 0);
  assert.equal(s.last().reason, "reviewer_passed");
  const t = session({ ORCH_ESCALATION: "off" });
  t.plan();
  const other = t.impl("a");
  t.review("a", "STATUS: pass");
  testGate(t, other, "allow", "tests_passed");
  assert.equal(t.run("review-gate.mjs", { background_tasks: [] }).status, 0);
  assert.equal(t.last().reason, "reviewer_passed");
});

// ---- K1 (run of 2026-11-17): a test-gate block that is not a test failure (a bugfix_ reason: the gate could not
// check the reproduction test, after the tests passed) was reported as "the tests failed" and nothing but the give-up
// cleared it. Now the message names the reason, and a block for an environment reason (the check never ran) is cleared
// by a later passing opus review of the slice, as strong as the give-up's doubt signal. The worker's own reasons
// (bugfix_no_test, bugfix_test_passes_on_base), tests_failed and unknown reasons are never cleared by a review. ----
const TESTS_FAILED_TEXT = "was sent back by the test gate (the tests failed) and never finished after that, so the failing tests were never fixed or reviewed";
/** A session where slice a passed review, then the test gate blocked its implementer with `reason`. @param {string} reason */
function blockedAfterReview(reason) {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  const id = s.impl("a");
  s.review("a", "STATUS: pass");
  testGate(s, id, "block", reason);
  return { s, id, stop: () => s.run("review-gate.mjs", { background_tasks: [] }) };
}

test("K1 Stop gate: a tests_failed block keeps its message and still holds the slice after a later passing opus review", () => {
  const { s, id, stop } = blockedAfterReview("tests_failed");
  s.review("a", "STATUS: pass", { model: "opus" }); // a review cannot vouch for tests the gate saw fail
  const r = stop();
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual([s.last().reason, s.last().slice, s.last().unfinished], ["implementer_unfinished", "a", [id]]);
  assert.ok(r.stderr.includes(TESTS_FAILED_TEXT), r.stderr);
});

test("K1 Stop gate: bugfix_no_test, bugfix_test_passes_on_base and an unknown bugfix_ reason are not cleared by a passing opus review", () => {
  for (const reason of ["bugfix_no_test", "bugfix_test_passes_on_base", "bugfix_x"]) {
    const { s, id, stop } = blockedAfterReview(reason);
    s.review("a", "STATUS: pass", { model: "opus" });
    const r = stop();
    assert.equal(r.status, 2, `${reason}: ${r.stderr}`);
    assert.deepEqual([s.last().reason, s.last().unfinished], ["implementer_unfinished", [id]], reason);
    assert.ok(r.stderr.includes(reason), r.stderr);
    assert.ok(!r.stderr.includes("(the tests failed)"), r.stderr);
    assert.doesNotMatch(r.stderr, /opus review of the slice clears it/, "only an environment reason can be cleared by a review");
  }
});

test("K1 Stop gate: a bugfix_base_unusable block names its reason, a sonnet pass does not clear it, a passing opus review does", () => {
  const { s, id, stop } = blockedAfterReview("bugfix_base_unusable");
  s.review("a", "STATUS: pass"); // after the block, on the reviewer's default model (not opus)
  const r = stop();
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual([s.last().reason, s.last().slice, s.last().unfinished], ["implementer_unfinished", "a", [id]]);
  assert.match(r.stderr, /bugfix_base_unusable/);
  assert.match(r.stderr, /the tests themselves passed/);
  assert.match(r.stderr, /a passing opus review of the slice clears it/);
  assert.ok(!r.stderr.includes("(the tests failed)"), r.stderr);
  assert.doesNotMatch(r.stderr, /ORCH_/, "no switch in a block message");
  s.review("a", "STATUS: pass", { model: "opus" });
  const ok = stop();
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(s.last().reason, "reviewer_passed");
  assert.ok(s.last().skips?.includes("implementer_unfinished:a:bugfix_base_unusable_cleared_by_review"), JSON.stringify(s.last()));
});

test("K1 Stop gate: a failing opus review after an environment block does not clear it", () => {
  const { s, stop } = blockedAfterReview("bugfix_timeout");
  s.review("a", "STATUS: fail\nGAP: 90 broken", { model: "opus" });
  assert.equal(stop().status, 2);
  assert.equal(s.last().reason, "implementer_unfinished");
});

test("K1 Stop gate: bugfix_no_base, bugfix_timeout and bugfix_tmp_lost blocks are cleared by a later passing opus review", () => {
  for (const reason of ["bugfix_no_base", "bugfix_timeout", "bugfix_tmp_lost"]) {
    const { s, stop } = blockedAfterReview(reason);
    s.review("a", "STATUS: pass", { model: "opus" });
    const r = stop();
    assert.equal(r.status, 0, `${reason}: ${r.stderr}`);
    assert.equal(s.last().reason, "reviewer_passed", reason);
  }
});

test("K1 Stop gate: a passing review of another slice does not clear a bugfix_ block", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  const id = s.impl("a");
  s.review("a", "STATUS: pass");
  s.impl("b");
  testGate(s, id, "block", "bugfix_no_base");
  s.review("b", "STATUS: pass", { model: "opus" });
  const r = s.run("review-gate.mjs", { background_tasks: [] });
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual([s.last().reason, s.last().slice], ["implementer_unfinished", "a"]);
  assert.match(r.stderr, /bugfix_no_base/);
});

// ---- G-1 (audit 2026-11-16): a second plain PLAN REVIEW while slices are in flight. The run it closes hands an
// unreviewed attempt of a slice the new plan names again to the new run, and a slice that was final and passed there
// counts as final in the new run until it is launched again. Spec: docs/brief-grammar.md, "Run model". ----
test("G-1 fold: an unreviewed attempt of a re-planned slice moves into the new run with its launches", () => {
  const env = { ORCH_ESCALATION: "off" };
  const { runs } = foldRuns(R(planLaunch(0), ...implAttempt(1, "a"), planLaunch(2), ...review(3, "a", "STATUS: pass")), { now: T0 + 10 * 60000, env });
  assert.equal(runs.length, 2);
  assert.equal(runs[0]?.closed, true);
  assert.equal(runs[0]?.slices.a, undefined, "the attempt left the closed run");
  const a = runs[1]?.slices.a;
  assert.deepEqual([a?.launches, a?.attempts, a?.reviews.length, a?.passed, a?.final], [1, 1, 1, true, true]);
});

test("G-1 fold: a re-planned slice whose attempt was reviewed and failed starts clean in the new run", () => {
  const { runs } = foldRuns(R(planLaunch(0), ...implAttempt(1, "a"), ...review(2, "a", "STATUS: fail\nGAP: 90 broken"), planLaunch(3)), { now: T0 + 10 * 60000, env: { ORCH_ESCALATION: "off" } });
  assert.deepEqual([runs[0]?.slices.a?.attempts, runs[0]?.slices.a?.countedFails], [1, 1], "the failed attempt stays in the closed run");
  assert.deepEqual([runs[1]?.slices.a?.attempts, runs[1]?.slices.a?.reviews.length, runs[1]?.slices.a?.final], [0, 0, false]);
});

test("G-1 fold: a slice final and passed in the closed run counts as final in the new run until it is launched again", () => {
  const env = { ORCH_ESCALATION: "off" };
  const now = T0 + 20 * 60000;
  const base = [planLaunch(0), ...implAttempt(1, "a"), ...review(2, "a", "STATUS: pass"), planLaunch(3), ...implAttempt(4, "b"), ...review(5, "b", "STATUS: pass")];
  let { runs, open } = foldRuns(R(...base), { now, env });
  assert.equal(runs[0]?.closed, true);
  assert.deepEqual([runs[1]?.slices.a?.final, runs[1]?.slices.a?.attempts], [true, 0]);
  assert.deepEqual([runs[1]?.closed, open], [true, null], "the new run closes once its other slices are final");
  // Launched again in the new run, the slice is open work of that run.
  const head = [planLaunch(0), ...implAttempt(1, "a"), ...review(2, "a", "STATUS: pass"), planLaunch(3)];
  ({ runs, open } = foldRuns(R(...head, ...implAttempt(4, "a"), ...implAttempt(5, "b"), ...review(6, "b", "STATUS: pass")), { now, env }));
  assert.equal(open?.id, 2);
  assert.deepEqual([runs[1]?.closed, runs[1]?.slices.a?.final, runs[1]?.slices.a?.attempts], [false, false, 1]);
});

test("G-1 fold: a resume of the carried-final slice's implementer (a stop, no launch) ends its final state; a failing review then holds it", () => {
  const env = { ORCH_ESCALATION: "off" };
  const now = T0 + 20 * 60000;
  const only = "PLAN REVIEW\nSLICE: a\nFILES: a.py\nDEPENDS: none\nGOAL: a";
  const head = [planLaunch(0), ...implAttempt(1, "a"), ...review(2, "a", "STATUS: pass"), planLaunch(3, only)];
  // The SendMessage resume of impl-a-1: a new stop record of the same agent, no launch record.
  const resume = { stop: stopRecord({ ts: at(4), sessionId: "s1", agentId: "impl-a-1", role: "implementer", reply: "STATUS: pass" }) };
  let { runs } = foldRuns(R(...head, resume), { now, env });
  let a = runs[1]?.slices.a;
  assert.deepEqual([runs[1]?.closed, a?.final, a?.passed, a?.attempts], [false, false, false, 1], "the resumed slice is open work of the new run");
  ({ runs } = foldRuns(R(...head, resume, ...review(5, "a", "STATUS: fail\nGAP: 90 broken")), { now, env }));
  a = runs[1]?.slices.a;
  assert.deepEqual([runs[1]?.closed, a?.final, a?.passed, a?.reviews.at(-1)?.counted], [false, false, false, "fail"]);
});

test("G-1 Stop gate: a resume of a carried-final slice that a reviewer then fails blocks", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  const id = s.impl("a");
  s.review("a", "STATUS: pass");
  s.plan("PLAN REVIEW\nSLICE: a\nFILES: a.py\nDEPENDS: none\nGOAL: a");
  s.run("telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: id, agent_type: IMPL });
  s.stop(id, IMPL, "STATUS: pass");
  s.review("a", "STATUS: fail\nGAP: 90 broken");
  const r = s.gate();
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual([s.last().reason, s.last().slice], ["last_reviewer_failed", "a"]);
});

test("G-1 Stop gate: a slice built before a second PLAN REVIEW and passed after it is allowed", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  s.impl("a");
  s.plan();
  s.review("a", "STATUS: pass");
  const r = s.gate();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.last().reason, "reviewer_passed");
});

// fix-run-pane item 1: a counted failing review of a carried-final slice in the new run ends its carried state, the way
// implementer work does; a passing review, a fail that counts as a pass and a reply with no STATUS leave it final.
test("G-1 fold: a counted failing review of a carried-final slice, with no implementer between, ends its final state", () => {
  const env = { ORCH_ESCALATION: "off" };
  const now = T0 + 20 * 60000;
  const only = "PLAN REVIEW\nSLICE: a\nFILES: a.py\nDEPENDS: none\nGOAL: a";
  // Slice b of the first plan is never built, so the first run is still open when the second plan closes it.
  const head = [planLaunch(0), ...implAttempt(1, "a"), ...review(2, "a", "STATUS: pass"), planLaunch(3, only), planStop(3.5, "plan3")];
  let { runs, open } = foldRuns(R(...head, ...review(4, "a", "STATUS: fail\nGAP: 90 broken")), { now, env });
  let a = runs[1]?.slices.a;
  assert.deepEqual([a?.carriedFinal, a?.final, a?.passed, a?.countedFails], [false, false, false, 1], "judged like any slice of the run");
  assert.deepEqual([runs[1]?.closed, open?.id], [false, 2], "the run stays open");
  // A retry that passes makes it final again and closes the run.
  ({ runs, open } = foldRuns(R(...head, ...review(4, "a", "STATUS: fail\nGAP: 90 broken"), ...implAttempt(5, "a"), ...review(6, "a", "STATUS: pass")), { now, env }));
  a = runs[1]?.slices.a;
  assert.deepEqual([a?.final, a?.passed, a?.attempts, runs[1]?.closed, open], [true, true, 1, true, null]);
  // Reviews that are not a counted fail leave it final: a pass, a fail whose gaps are all below the cutoff, no STATUS.
  for (const reply of ["STATUS: pass", "STATUS: fail\nGAP: 50 maybe", "I ran out of turns"]) {
    ({ runs, open } = foldRuns(R(...head, ...review(4, "a", reply)), { now, env }));
    a = runs[1]?.slices.a;
    assert.deepEqual([a?.carriedFinal, a?.final, a?.passed, runs[1]?.closed, open], [true, true, true, true, null], reply);
  }
});

test("G-1 hooks: a failing review of a carried-final slice keeps the new run open; the Stop gate does not gate it (no attempt in the run)", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  const only = "PLAN REVIEW\nSLICE: a\nFILES: a.py\nDEPENDS: none\nGOAL: a";
  s.plan(); // slices a and b: b is never built, so this run is open when the second plan closes it
  s.impl("a");
  s.review("a", "STATUS: pass");
  s.plan(only);
  s.review("a", "STATUS: fail\nGAP: 90 broken");
  // The run is open: an implementer of a slice the plan does not name is blocked.
  assert.equal(s.check("c").status, 2);
  assert.equal(s.lastCheck().reason, "not_in_plan");
  // The review gate gates the slices of the latest run that have an implementer attempt there, and the last implementer's
  // slice in the run where it has one (run 1, whose latest review of a passed): it allows. Pinned as it is today; the
  // slice's retry is due, but the gate would need a change to ask for it (fix notes, fix-run-pane item 1).
  const r = s.gate();
  assert.equal(r.status, 0, r.stderr);
  assert.equal(s.last().reason, "reviewer_passed");
});

test("G-1 Stop gate: a slice built before a second PLAN REVIEW and failed after it blocks, though a later slice passed", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  s.impl("a");
  s.plan();
  s.review("a", "STATUS: fail\nGAP: 90 broken");
  s.impl("b");
  s.review("b", "STATUS: pass");
  const r = s.gate();
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual([s.last().reason, s.last().slice], ["last_reviewer_failed", "a"]);
});
