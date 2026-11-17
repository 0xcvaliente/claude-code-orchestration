// run.mjs stopGateOf / implementerTestStates: which test-gate record is the record of an implementer's latest stop,
// when only one of the two (the stop's telemetry record, the gate's record) carries a hand-back id. An older
// telemetry.mjs beside a 2.0.0 verify.sh writes stops without after_handback while the gate's records name the
// hand-back; an older verify.sh beside a newer telemetry.mjs does the reverse. Either way the pairing falls back to the
// count since the agent's latest start, which is what 1.6.1 decided for every record (25a22ed:.claude/hooks/run.mjs,
// implementerTestStates: a.stopGate = stops > 0 && mine.length >= stops ? mine.at(-1) : null, over the records since
// the latest start). Never across a restart.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { implementerTestStates, stopGateOf } from "../.claude/hooks/run.mjs";

const T = Date.parse("2026-11-17T10:00:00.000Z");
const at = (/** @type {number} */ m) => new Date(T + m * 60000).toISOString();
/** @param {string} event @param {number} m @param {Record<string, unknown>} [x] */
const tel = (event, m, x = {}) => ({ ts: at(m), session_id: "s1", agent_id: "i1", agent_type: "implementer", hook_event_name: event, ...x });
/** @param {number} m @param {string} decision @param {Record<string, unknown>} [x] */
const g = (m, decision, x = {}) => ({ ts: at(m), gate: "test", decision, reason: decision === "block" ? "tests_failed" : "tests_passed", agent_id: "i1", session_id: "s1", ...x });

/**
 * What 1.6.1 decided (25a22ed): the latest of the records since the agent's latest start once they are at least as
 * many as its stops since that start, else null. 1.6.1 had no hand-back records, so the cases below give it none.
 * @param {any[]} telemetry @param {any[]} gates
 */
function decided161(telemetry, gates) {
  const start = Math.max(-Infinity, ...telemetry.filter((e) => e.hook_event_name === "SubagentStart").map((e) => Date.parse(e.ts)));
  const stops = telemetry.filter((e) => e.hook_event_name === "SubagentStop" && Date.parse(e.ts) >= start).length;
  const mine = gates.filter((x) => Date.parse(x.ts) >= start).sort((x, y) => Date.parse(x.ts) - Date.parse(y.ts));
  return stops > 0 && mine.length >= stops ? (mine.at(-1) ?? null) : null;
}
/** @param {any[]} telemetry @param {any[]} gates */
const decidedNow = (telemetry, gates) => implementerTestStates(telemetry, gates, "s1").get("i1")?.stopGate ?? null;

test("a failed-tests record with after_handback pairs with a stop that has none (older telemetry.mjs), as 1.6.1 did", () => {
  const telemetry = [tel("SubagentStart", 0), tel("SubagentStop", 1)];
  const gates = [g(2, "block", { after_handback: "h1" })];
  const now = decidedNow(telemetry, gates);
  assert.equal(now?.decision, "block", "the stop's record is the block: the reviewer hold refuses the review");
  assert.equal(now, decided161(telemetry, gates));
  // The record stamped just before its own stop (side by side hooks) still counts for it.
  assert.equal(decidedNow([tel("SubagentStart", 0), tel("SubagentStop", 1)], [g(0.9, "block", { after_handback: "h1" })])?.decision, "block");
});

test("only one side keyed: paired by count since the latest start, the same as 1.6.1, in every case", () => {
  /** @type {[string, any[], any[]][]} */
  const cases = [
    ["unkeyed stop, keyed block", [tel("SubagentStart", 0), tel("SubagentStop", 1)], [g(2, "block", { after_handback: "h1" })]],
    ["two unkeyed stops, one keyed record: the second stop waits", [tel("SubagentStart", 0), tel("SubagentStop", 1), tel("SubagentStop", 3)], [g(2, "block", { after_handback: "h1" })]],
    [
      "two unkeyed stops, two records (one keyed, one not)",
      [tel("SubagentStart", 0), tel("SubagentStop", 1), tel("SubagentStop", 3)],
      [g(2, "block", { after_handback: "h1" }), g(4, "allow")],
    ],
    ["unkeyed stop, no record yet", [tel("SubagentStart", 0), tel("SubagentStop", 1)], []],
    ["keyed stop, unkeyed block (older verify.sh)", [tel("SubagentStart", 0), tel("SubagentStop", 1, { after_handback: "h1" })], [g(2, "block")]],
    ["keyed stop, unkeyed allow (older verify.sh)", [tel("SubagentStart", 0), tel("SubagentStop", 1, { after_handback: "h1" })], [g(2, "allow")]],
    ["no start recorded, unkeyed stop, keyed block", [tel("SubagentStop", 1)], [g(2, "block", { after_handback: "h1" })]],
  ];
  for (const [what, telemetry, gates] of cases) assert.equal(decidedNow(telemetry, gates), decided161(telemetry, gates), what);
});

test("never across a restart: a keyed record from before the latest start is not the record of a later unkeyed stop", () => {
  const telemetry = [tel("SubagentStart", 0), tel("SubagentStop", 1), tel("SubagentStart", 2), tel("SubagentStop", 3)];
  const before = [g(1.5, "block", { after_handback: "h1" })];
  assert.equal(decidedNow(telemetry, before), null);
  assert.equal(decided161(telemetry, before), null);
  // A keyed pass after the restart whose hand-back has no record cannot be told from a late one: pending, never a pass.
  assert.equal(decidedNow(telemetry, [...before, g(4, "allow", { after_handback: "h1" })]), null);
  // Its own (unkeyed) record arrives: paired.
  assert.equal(decidedNow(telemetry, [...before, g(4, "allow")])?.decision, "allow");
  assert.equal(stopGateOf([tel("SubagentStop", 3)], before, T + 2 * 60000), null, "stopGateOf alone: the start bounds the records");
  // Older telemetry: a late block of the stop before the restart, stamped after it, whose hand-back the hand-back gate
  // logged before the restart, is not the new stop's (1.6.1 paired it by time; never across a restart now).
  const handback = g(0.5, "block", { at: "handback", handback_id: "h1" });
  const late = [handback, g(2.5, "block", { after_handback: "h1" })];
  assert.equal(decidedNow(telemetry, late), null);
  assert.equal(decidedNow(telemetry, [...late, g(4, "allow")])?.decision, "allow", "its own record arrives");
  // Newer telemetry (the earlier stop carries its hand-back): a later stop with none followed no hand-back, so a late
  // keyed record is not its own, whatever its time.
  const newer = [tel("SubagentStart", 0), tel("SubagentStop", 1, { after_handback: "h1" }), tel("SubagentStart", 2), tel("SubagentStop", 3)];
  assert.equal(decidedNow(newer, [g(4, "block", { after_handback: "h1" })]), null);
  assert.equal(decidedNow(newer, [g(4, "block", { after_handback: "h1" }), g(5, "block")])?.decision, "block");
});

test("older telemetry, no hand-back record: a late keyed pass from before the restart never replaces the new stop's block", () => {
  // Stop 1 (hand-back h1), restart, stop 3 with no hand-back: its gate blocks (unkeyed) at 4, then stop 1's gate, still
  // running across the restart, writes its pass (keyed h1) at 5. The hand-back gate left no record of h1.
  const telemetry = [tel("SubagentStart", 0), tel("SubagentStop", 1), tel("SubagentStart", 2), tel("SubagentStop", 3)];
  const gates = [g(4, "block"), g(5, "allow", { after_handback: "h1" })];
  assert.equal(decided161(telemetry, gates)?.decision, "allow", "1.6.1 (25a22ed, run in a scratch copy) took the late pass");
  assert.equal(decidedNow(telemetry, gates)?.decision, "block", "the record certainly written since the restart decides");
  // Only the uncertain record so far: as a pass it never stands for the stop (pending); as a block it does (stricter).
  assert.equal(decidedNow(telemetry, [g(5, "allow", { after_handback: "h1" })]), null);
  assert.equal(decidedNow(telemetry, [g(5, "block", { after_handback: "h1" })])?.decision, "block");
  // A keyed record whose hand-back the hand-back gate logged since the restart is certain: a pass then counts.
  assert.equal(decidedNow(telemetry, [g(2.5, "allow", { at: "handback", handback_id: "h2" }), g(5, "allow", { after_handback: "h2" })])?.decision, "allow");
});

test("hand-back records never pair with a stop, keyed or not", () => {
  const telemetry = [tel("SubagentStart", 0), tel("SubagentStop", 1)];
  assert.equal(decidedNow(telemetry, [g(0.5, "block", { at: "handback", handback_id: "h1" })]), null);
  assert.equal(decidedNow(telemetry, [g(0.5, "block", { at: "handback", handback_id: "h1" }), g(2, "allow", { after_handback: "h1" })])?.decision, "allow");
});

test("both keyed: still by key (a late record of an earlier hand-back is not the new stop's)", () => {
  const telemetry = [tel("SubagentStart", 0), tel("SubagentStop", 1, { after_handback: "h1" }), tel("SubagentStop", 3, { after_handback: "h2" })];
  assert.equal(decidedNow(telemetry, [g(2, "allow", { after_handback: "h1" }), g(4, "block", { after_handback: "h1" })]), null);
  assert.equal(decidedNow(telemetry, [g(2, "allow", { after_handback: "h1" }), g(4, "block", { after_handback: "h2" })])?.decision, "block");
});
