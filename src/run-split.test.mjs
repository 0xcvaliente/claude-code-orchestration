// Regression: a counted pass must not close a run while the slice still needs an opus pass under the escalation rule
// (docs/brief-grammar.md, "Run model": Final slice, Closed run). Recorded case: benchmark compare-040, d2-docs
// all-haiku r1, light path, slice "answers". The fixture files in src/fixtures/run-split/ are the run's own log records
// as the hooks wrote them (parsed fields only): journal-launches.jsonl, journal.jsonl, journal-pending.jsonl (the
// stops that waited for their foreground launch; foldRuns does not read it) and the test-gate rows of gates.jsonl.
// Replayed through the old fold, run 1 closed at the sonnet pass of 16:27:11 (a retry signal and no opus pass), the
// opus review of 16:27:54 landed in that closed run, and the opus implementer of 16:28:33 opened a run 2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { foldRuns, launchRecord, stopRecord } from "../.claude/hooks/brief.mjs";
import { loadRecords, readJsonl } from "../.claude/hooks/run.mjs";

const dir = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "run-split");
const SID = "9701c6da-69e3-4ec5-b099-9a52b2d0460e";
const records = loadRecords(SID, dir);
const t = (/** @type {string} */ iso) => Date.parse(iso);
const END = t("2026-10-31T16:29:30.000Z");

test("run split: the recorded records are the case the brief describes", () => {
  assert.equal(records.launches.length, 6);
  assert.equal(records.stops.length, 9);
  assert.equal(readJsonl(dir, "journal-pending.jsonl").length, 4);
  // The stops as the old journal numbered them: the opus implementer's stop and the last review went to run 2.
  assert.deepEqual(records.stops.map((s) => s.run), [1, 1, 1, 1, 1, 1, 1, 2, 2]);
});

test("run split: the slice stays in run 1 until it is final; one run in total", () => {
  const { runs, open } = foldRuns(records, { now: END, sessionId: SID, env: {} });
  assert.equal(runs.length, 1, "the opus implementer joins run 1 instead of opening run 2");
  const run = /** @type {import("../.claude/hooks/brief.mjs").Run} */ (runs[0]);
  assert.equal(run.kind, "light");
  assert.equal(run.closed, true, "closed once the opus review passed after the last attempt");
  assert.equal(open, null);
  const s = run.slices.answers;
  assert.ok(s);
  assert.equal(s.launches, 2, "both implementer launches (sonnet, then opus) are in run 1");
  assert.equal(s.attempts, 3);
  assert.deepEqual(
    s.reviews.map((r) => [r.counted, r.model]),
    [["fail", "sonnet"], ["pass", "sonnet"], ["fail", "opus"], ["pass", "opus"]],
    "all four reviews of the slice are in run 1",
  );
  assert.deepEqual([s.final, s.passed, s.gaveUp, s.stalled], [true, true, false, false]);
  assert.deepEqual(s.signals, ["retry"], "what finish() reports for the gates is unchanged");
});

test("run split: at the sonnet pass the slice is not final and the run stays open", () => {
  // Fold only what had happened by 16:27:20 (just after the sonnet pass at 16:27:11, logged at its launch 16:27:11.658).
  const cut = t("2026-10-31T16:27:20.000Z");
  const before = {
    launches: records.launches.filter((l) => t(l.ts) <= cut),
    stops: records.stops.filter((s) => t(s.ts) <= cut),
    gates: records.gates.filter((g) => t(g.ts) <= cut),
    starts: [],
  };
  const { runs, open } = foldRuns(before, { now: cut, sessionId: SID, env: {} });
  assert.equal(runs.length, 1);
  assert.equal(open?.id, 1, "the run stays open: the retry signal still needs an opus pass");
  const s = open?.slices.answers;
  assert.deepEqual([s?.passed, s?.final, s?.signals], [true, false, ["retry"]]);
});

test("run split: every stop gets run 1, the number journal.mjs writes", () => {
  // journal.mjs writes a stop when it arrives, or (a foreground agent) when its launch record arrives; the run is the
  // latest run with the slice in the fold of what was logged by then.
  const launchOf = new Map(records.launches.map((l) => [l.agent_id, l]));
  const writeAt = (/** @type {any} */ s) => Math.max(t(s.ts), t(launchOf.get(s.agent_id)?.ts ?? s.ts));
  const order = [...records.stops].sort((a, b) => writeAt(a) - writeAt(b));
  const runIds = order.map((s, i) => {
    const at = writeAt(s);
    const upTo = { launches: records.launches.filter((l) => t(l.ts) <= at), stops: order.slice(0, i), gates: [], starts: [] };
    const { runs, open } = foldRuns(upTo, { now: at, sessionId: SID, env: {} });
    return runs.findLast((r) => s.slice in r.slices)?.id ?? open?.id ?? null;
  });
  assert.deepEqual(runIds, [1, 1, 1, 1, 1, 1, 1, 1, 1]);
});

// ---- Escalation cases of the finality rule. ----

const T0 = t("2026-10-31T10:00:00.000Z");
const at = (/** @type {number} */ min) => new Date(T0 + min * 60000).toISOString();
/** @param {number} min @param {string} slice @param {string} [extra] @param {string} [model] */
const impl = (min, slice, extra = "", model) => ({
  launch: launchRecord({ subagent_type: "implementer", prompt: `SLICE: ${slice}\nFILES: ${slice}.md\nDEPENDS: none\nPATH: light\n${extra}`, ...(model ? { model } : {}) }, { ts: at(min), sessionId: "s1", agentId: `impl-${min}` }),
});
/** @param {number} min @param {string} agentId */
const implStop = (min, agentId) => ({ stop: stopRecord({ ts: at(min), sessionId: "s1", agentId, role: "implementer", reply: "STATUS: pass\nOPEN: none" }) });
/** @param {number} min @param {string} slice @param {string} reply @param {string} model */
const review = (min, slice, reply, model) => [
  { launch: launchRecord({ subagent_type: "reviewer", prompt: `SLICE: ${slice}`, model }, { ts: at(min - 0.5), sessionId: "s1", agentId: `rev-${min}` }) },
  { stop: stopRecord({ ts: at(min), sessionId: "s1", agentId: `rev-${min}`, role: "reviewer", reply }) },
];
/** @param {any[]} items */
const R = (items) => ({
  launches: items.flatMap((i) => (i.launch ? [i.launch] : [])),
  stops: items.flatMap((i) => (i.stop ? [i.stop] : [])),
  gates: [],
  starts: [],
});
/** A fail then a sonnet pass of the same light slice (a retry signal). */
const retried = [impl(0, "x"), implStop(1, "impl-0"), ...review(2, "x", "STATUS: fail\nGAP: 90 wrong value", "sonnet"), implStop(3, "impl-0"), ...review(4, "x", "STATUS: pass", "sonnet")];
const fold = (/** @type {any[]} */ items, /** @type {Record<string, string>} */ env = {}, now = T0 + 10 * 60000) => foldRuns(R(items), { now, env });

test("finality: with ORCH_ESCALATION=off a counted pass is final whatever the signals", () => {
  const f = fold(retried, { ORCH_ESCALATION: "off" });
  assert.deepEqual([f.runs[0]?.closed, f.runs[0]?.slices.x?.final, f.runs[0]?.slices.x?.signals], [true, true, []]);
  const risky = fold([impl(0, "y", "RISKY: yes"), implStop(1, "impl-0"), ...review(2, "y", "STATUS: pass", "sonnet")], { ORCH_ESCALATION: "off" });
  assert.equal(risky.runs[0]?.closed, true);
});

test("finality: a retry signal keeps the run open until an opus pass after the latest attempt", () => {
  let f = fold(retried);
  assert.deepEqual([f.open?.id, f.open?.slices.x?.passed, f.open?.slices.x?.final], [1, true, false]);
  f = fold([...retried, ...review(5, "x", "STATUS: pass", "opus")]);
  assert.deepEqual([f.runs.length, f.runs[0]?.closed, f.runs[0]?.slices.x?.final, f.open], [1, true, true, null]);
  // An opus pass before the latest attempt does not count: the next attempt needs its own. (A planned run whose slice y
  // is still open, so the run stays open after x's opus pass and x's resume lands in it.)
  const plan = { launch: launchRecord({ subagent_type: "reviewer", prompt: "PLAN REVIEW\nSLICE: x\nFILES: x.md\nDEPENDS: none\nGOAL: x\nSLICE: y\nFILES: y.md\nDEPENDS: none\nGOAL: y" }, { ts: at(-1), sessionId: "s1", agentId: "plan" }) };
  f = fold([plan, ...retried, ...review(5, "x", "STATUS: pass", "opus"), implStop(6, "impl-0"), ...review(7, "x", "STATUS: pass", "sonnet")]);
  assert.deepEqual([f.open?.id, f.open?.slices.x?.passed, f.open?.slices.x?.final, f.open?.slices.x?.signals], [1, true, false, ["retry"]]);
  // A second light implementer while the slice waits for its opus pass joins the same run.
  f = fold([...retried, impl(6, "x", "", "opus"), implStop(7, "impl-6"), ...review(8, "x", "STATUS: pass", "opus")]);
  assert.deepEqual([f.runs.length, f.runs[0]?.slices.x?.launches, f.runs[0]?.closed], [1, 2, true]);
});

test("finality: a RISKY slice needs an opus pass; a sonnet pass leaves the run open", () => {
  const base = [impl(0, "y", "RISKY: yes"), implStop(1, "impl-0"), ...review(2, "y", "STATUS: pass", "sonnet")];
  let f = fold(base);
  assert.deepEqual([f.open?.id, f.open?.slices.y?.final, f.open?.slices.y?.signals], [1, false, ["risky"]]);
  f = fold([...base, ...review(3, "y", "STATUS: pass", "opus")]);
  assert.deepEqual([f.runs[0]?.closed, f.runs[0]?.slices.y?.final], [true, true]);
});

test("finality: ORCH_ESCALATION=always needs an opus pass for every slice", () => {
  const plain = [impl(0, "z"), implStop(1, "impl-0"), ...review(2, "z", "STATUS: pass", "sonnet")];
  assert.equal(fold(plain).runs[0]?.closed, true, "no signal: a sonnet pass is final");
  let f = fold(plain, { ORCH_ESCALATION: "always" });
  assert.deepEqual([f.open?.id, f.open?.slices.z?.final, f.open?.slices.z?.signals], [1, false, ["always"]]);
  f = fold([...plain, ...review(3, "z", "STATUS: pass", "opus")], { ORCH_ESCALATION: "always" });
  assert.deepEqual([f.runs[0]?.closed, f.runs[0]?.slices.z?.final], [true, true]);
});

test("finality: a slice failed for good is final without an opus pass; a run waiting for opus still goes stale", () => {
  const three = [impl(0, "x"), implStop(1, "impl-0"), ...review(2, "x", "STATUS: fail", "sonnet"), implStop(3, "impl-0"), ...review(4, "x", "STATUS: fail", "sonnet"), implStop(5, "impl-0"), ...review(6, "x", "STATUS: fail", "sonnet")];
  const f = fold(three);
  assert.deepEqual([f.runs[0]?.slices.x?.gaveUp, f.runs[0]?.slices.x?.final, f.runs[0]?.closed], [true, true, true]);
  const stale = fold(retried, {}, T0 + 40 * 60000);
  assert.deepEqual([stale.runs[0]?.stale, stale.runs[0]?.closed, stale.open], [true, false, null]);
  // After the stale run, a light implementer opens a new run, as before.
  const next = fold([...retried, impl(40, "w"), implStop(41, "impl-40")], {}, T0 + 42 * 60000);
  assert.deepEqual([next.runs.length, next.open?.id], [2, 2]);
});
