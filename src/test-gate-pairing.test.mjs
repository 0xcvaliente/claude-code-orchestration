// run.mjs stopGateOf / implementerTestStates: which test-gate record stands for an implementer's latest stop, read by
// the plan check's reviewer hold. The rule (run.mjs, stopGateOf): the pairing may only make the hold stricter than the
// base's, never weaker. The base is the real run.mjs of the release-1.6.1 branch (2.0.0's first pairing), taken from
// git with what it imports into a scratch folder, and run on the same records as the branch's. For every row and every
// random sequence: the branch holds at least as much as the base, where a failed-tests block (the hold refuses) is
// stricter than pending (no record yet: the review goes through with a note), which is stricter than a pass.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { implementerTestStates } from "../.claude/hooks/run.mjs";

const repo = new URL("..", import.meta.url).pathname;
/** The base's run.mjs and the hook modules it imports, from git, or null when this clone lacks the ref. */
async function loadBase() {
  for (const ref of ["release-1.6.1", "7b408fe"]) {
    const dir = mkdtempSync(join(tmpdir(), "orch-pair-base-"));
    const todo = ["run.mjs"];
    const done = new Set();
    let ok = true;
    while (todo.length && ok) {
      const name = todo.pop() ?? "";
      if (done.has(name)) continue;
      done.add(name);
      const r = spawnSync("git", ["show", `${ref}:.claude/hooks/${name}`], { cwd: repo, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      if (r.status !== 0) ok = false;
      else {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, name), r.stdout);
        for (const m of r.stdout.matchAll(/from "\.\/([\w.-]+\.mjs)"/g)) todo.push(m[1] ?? "");
      }
    }
    if (ok) return { ref, mod: await import(pathToFileURL(join(dir, "run.mjs")).href) };
  }
  return null;
}
const base = await loadBase();
const skip = base ? false : "the release-1.6.1 base is not in this clone";

const T = Date.parse("2026-11-17T10:00:00.000Z");
const at = (/** @type {number} */ m) => new Date(T + m * 60000).toISOString();
/** @param {number} m @param {string} [agent] */
const start = (m, agent = "i1") => ({ ts: at(m), session_id: "s1", agent_id: agent, agent_type: "implementer", hook_event_name: "SubagentStart" });
/** @param {number} m @param {string} [key] @param {string} [agent] */
const stop = (m, key = "", agent = "i1") => ({ ts: at(m), session_id: "s1", agent_id: agent, agent_type: "implementer", hook_event_name: "SubagentStop", ...(key ? { after_handback: key } : {}) });
/** A stop's test-gate record. @param {number} m @param {string} decision @param {string} [key] @param {string} [agent] @param {string} [reason] */
const rec = (m, decision, key = "", agent = "i1", reason = decision === "block" ? "tests_failed" : "tests_passed") => ({
  ts: at(m),
  gate: "test",
  decision,
  reason,
  agent_id: agent,
  session_id: "s1",
  ...(key ? { after_handback: key } : {}),
});
/** A hand-back gate's record. @param {number} m @param {string} id @param {string} decision @param {string} [agent] */
const hb = (m, id, decision, agent = "i1") => ({ ...rec(m, decision, "", agent), at: "handback", handback_id: id });

/** Hold level: 2 the hold refuses (a failed-tests block), 1 pending, 0 a pass (or a bugfix_ block, which the hold lets through). @param {any} r */
const level = (r) => (!r ? 1 : r.decision === "block" && !String(r.reason ?? "").startsWith("bugfix_") ? 2 : 0);
/** @param {any} mod @param {any[]} events @param {string} agent */
const decide = (mod, events, agent) => {
  const telemetry = events.filter((e) => e.hook_event_name);
  const gates = events.filter((e) => e.gate === "test");
  return mod.implementerTestStates(telemetry, gates, "s1").get(agent)?.stopGate ?? null;
};
const NAMES = ["pass", "pending", "block"];

/**
 * The comparison for one sequence: the branch never holds less than the base, never returns a record from before the
 * agent's latest start or a hand-back gate's record. Returns both levels.
 * @param {any[]} events @param {string} what @param {string} [agent] @returns {[number, number]}
 */
function compare(events, what, agent = "i1") {
  const b = decide(base?.mod, events, agent);
  const n = decide({ implementerTestStates }, events, agent);
  assert.ok(level(n) >= level(b), `${what}: the branch gives ${NAMES[level(n)]} where the base gives ${NAMES[level(b)]}`);
  const latestStart = Math.max(-Infinity, ...events.filter((e) => e.hook_event_name === "SubagentStart" && e.agent_id === agent).map((e) => Date.parse(e.ts)));
  if (n) {
    assert.ok(Date.parse(n.ts) >= latestStart, `${what}: never a record from before the latest start`);
    assert.equal(n.at, undefined, `${what}: never a hand-back record`);
  }
  return [level(b), level(n)];
}

/** @type {[string, any[], string?, number?][]} name, events, agent, the branch's expected level */
const ROWS = [
  ["A: unkeyed stop; unkeyed block; hand-back h1 logged after; a pass keyed h1", [start(0), stop(1), rec(2, "block"), hb(2.5, "h1", "allow"), rec(3, "allow", "h1")], "i1", 2],
  ["A': the same with h1 logged before the block", [start(0), stop(1), hb(1.5, "h1", "allow"), rec(2, "block"), rec(3, "allow", "h1")], "i1", 2],
  ["B: two unkeyed stops; hand-back h2; a block keyed h2; a late unkeyed pass", [start(0), stop(1), hb(2, "h2", "allow"), stop(3), rec(3.5, "block", "h2"), rec(4, "allow")], "i1", 2],
  ["unkeyed stop, unkeyed block", [start(0), stop(1), rec(2, "block")], "i1", 2],
  ["unkeyed stop, unkeyed pass", [start(0), stop(1), rec(2, "allow")], "i1", 0],
  ["unkeyed stop, keyed block (an older telemetry hook)", [start(0), stop(1), rec(2, "block", "h1")], "i1", 2],
  ["unkeyed stop, keyed pass (an older telemetry hook)", [start(0), stop(1), rec(2, "allow", "h1")], "i1", 1],
  ["keyed stop, unkeyed block (an older verify.sh)", [start(0), stop(1, "h1"), rec(2, "block")], "i1", 2],
  ["keyed stop, unkeyed pass (an older verify.sh)", [start(0), stop(1, "h1"), rec(2, "allow")], "i1", 0],
  ["keyed stop, its own block", [start(0), stop(1, "h1"), rec(2, "block", "h1")], "i1", 2],
  ["keyed stop, its own pass", [start(0), stop(1, "h1"), rec(2, "allow", "h1")], "i1", 0],
  ["keyed stop, no record yet", [start(0), stop(1, "h1")], "i1", 1],
  ["a late block of the stop before a restart, the new stop pending", [start(0), stop(1, "h1"), start(2), stop(3, "h2"), rec(4, "block", "h1")], "i1", 1],
  ["the same, the new stop's own pass arrives", [start(0), stop(1, "h1"), start(2), stop(3, "h2"), rec(3.5, "allow", "h2"), rec(4, "block", "h1")], "i1", 0],
  ["a late block of an earlier stop since the start, the latest pending", [start(0), stop(1, "h1"), stop(2, "h2"), rec(2.5, "block", "h1")], "i1", 1],
  ["two stops after one hand-back, one block so far", [start(0), stop(1, "h1"), rec(1.5, "block", "h1"), stop(2, "h1")], "i1", 2],
  ["two stops after one hand-back, both records", [start(0), stop(1, "h1"), rec(1.5, "block", "h1"), stop(2, "h1"), rec(2.5, "allow", "h1")], "i1", 0],
  ["a restart after a refused hand-back, the new stop pending", [start(0), hb(0.5, "h1", "block"), start(1), hb(1.5, "h2", "allow"), stop(2, "h2")], "i1", 1],
  ["a restart after a refused hand-back, the new stop passed", [start(0), hb(0.5, "h1", "block"), start(1), hb(1.5, "h2", "allow"), stop(2, "h2"), rec(3, "allow", "h2")], "i1", 0],
  ["older telemetry: a late pass from before a restart after the new stop's block", [start(0), stop(1), start(2), stop(3), rec(4, "block"), rec(5, "allow", "h1")], "i1", 2],
  ["older telemetry: a late keyed pass after a restart, nothing else", [start(0), stop(1), start(2), stop(3), rec(5, "allow", "h1")], "i1", 1],
  ["older telemetry: a fix loop (block, then a pass) within one start", [start(0), stop(1), rec(2, "block"), stop(3), rec(4, "allow")], "i1", 2],
  ["a fix loop with hand-back ids within one start", [start(0), hb(0.5, "h1", "allow"), stop(1, "h1"), rec(2, "block", "h1"), hb(2.5, "h2", "allow"), stop(3, "h2"), rec(4, "allow", "h2")], "i1", 0],
  ["an older run's records with the same agent id, before the latest start", [rec(-5, "allow"), rec(-4, "block", "h9"), start(0), stop(1)], "i1", 1],
  ["two implementers on one slice: the first's block", [start(0, "i1"), start(0.5, "i2"), stop(1, "", "i1"), stop(1.5, "h1", "i2"), rec(2, "block", "", "i1"), rec(2.5, "allow", "h1", "i2")], "i1", 2],
  ["two implementers on one slice: the second's pass", [start(0, "i1"), start(0.5, "i2"), stop(1, "", "i1"), stop(1.5, "h1", "i2"), rec(2, "block", "", "i1"), rec(2.5, "allow", "h1", "i2")], "i2", 0],
  ["a bugfix_ block of the stop's own hand-back", [start(0), stop(1, "h1"), rec(2, "block", "h1", "i1", "bugfix_timeout")], "i1", 0],
  ["a bugfix_ block and a pass, unkeyed stop", [start(0), stop(1), rec(2, "block", "", "i1", "bugfix_timeout"), rec(3, "allow")], "i1", 1],
  ["only a refused hand-back's record", [start(0), hb(0.5, "h1", "block"), stop(1)], "i1", 1],
  ["no start recorded", [stop(1), rec(2, "block", "h1")], "i1", 2],
  ["no stop yet", [start(0), rec(1, "block")], "i1", 1],
];

test("every row: the branch holds at least as much as the base (release-1.6.1), never across the latest start", { skip }, () => {
  let stricter = 0;
  for (const [what, events, agent = "i1", want] of ROWS) {
    const [b, n] = compare(events, what, agent);
    if (want !== undefined) assert.equal(NAMES[n], NAMES[want], `${what}: the branch's decision`);
    if (n > b) stricter += 1;
  }
  assert.ok(ROWS.length >= 30);
  assert.ok(stricter >= 5, `the branch is stricter than the base in some rows (${stricter})`);
});

test("sequences A and B (where the previous attempt let the review through): the branch holds", { skip }, () => {
  assert.deepEqual(compare(ROWS[0]?.[1] ?? [], "A"), [2, 2], "A: base block, branch block");
  assert.deepEqual(compare(ROWS[1]?.[1] ?? [], "A'"), [2, 2]);
  assert.deepEqual(compare(ROWS[2]?.[1] ?? [], "B"), [1, 2], "B: base pending, branch block");
});

test("400 random sequences (fixed seed): the branch never holds less than the base", { skip }, () => {
  let seed = 20261118;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (/** @type {any[]} */ xs) => xs[Math.floor(rnd() * xs.length)];
  const KEYS = ["", "", "h1", "h2", "h3"];
  let stricter = 0;
  for (let i = 0; i < 400; i += 1) {
    /** @type {any[]} */
    const events = [];
    const n = 3 + Math.floor(rnd() * 9);
    for (let t = 0; t < n; t += 1) {
      const agent = rnd() < 0.15 ? "i2" : "i1";
      const r = rnd();
      if (r < 0.15) events.push(start(t, agent));
      else if (r < 0.3) events.push(hb(t, pick(KEYS.slice(2)), pick(["allow", "block"]), agent));
      else if (r < 0.6) events.push(stop(t, pick(KEYS), agent));
      else events.push(rec(t, pick(["allow", "block", "block"]), pick(KEYS), agent, rnd() < 0.1 ? "bugfix_timeout" : undefined));
    }
    for (const agent of ["i1", "i2"]) {
      const [b, s] = compare(events, `sequence ${i} (${agent}): ${JSON.stringify(events.map((e) => [e.hook_event_name ?? e.at ?? e.decision, e.after_handback ?? e.handback_id ?? "", e.agent_id]))}`, agent);
      if (s > b) stricter += 1;
    }
  }
  assert.ok(stricter > 0);
});
