// The current run of a session, for the gates: loads the session's log records from the state dir (state.mjs) and folds
// them with brief.mjs's foldRuns (spec: docs/brief-grammar.md, "Run model"). Records read:
//   journal-launches.jsonl  launch records (journal.mjs, PostToolUse on Agent|Task)
//   journal.jsonl           stop records (journal.mjs, SubagentStop)
//   gates.jsonl             test-gate records (verify.sh); joined to a launch by agent_id inside foldRuns
//   telemetry.jsonl         SubagentStart / SubagentStop (telemetry.mjs): which agents are still running
// No side effects at import beyond state.mjs reading settings; the functions only read files, and an unreadable or
// missing log reads as empty. Node built-ins only. The logs gather every session of a project, so a caller that wants
// one session's records passes its id and lines of other sessions are skipped before JSON.parse. A hook reads each log
// once per call: it passes what it already read to loadRecords or sessionRuns (`raw`), and checks a record it has just
// written with appendJsonl, which reads back only the end of the file.
import { appendFileSync, closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import { foldRuns, staleMinutes } from "./brief.mjs";
import { stateDir } from "./state.mjs";

/**
 * Parsed JSON lines of a log in `dir`; a missing or unreadable file and unparseable lines read as nothing. With
 * `sessionId`, a line that names a session_id but does not contain this id as a JSON string is skipped unparsed: it
 * belongs to another session. Lines with no session_id (older test-gate records) are still parsed. The caller still
 * filters on the parsed field; the skip only saves parsing.
 * @param {string} dir @param {string} name @param {string} [sessionId] @returns {any[]}
 */
export function readJsonl(dir, name, sessionId) {
  const needle = typeof sessionId === "string" ? JSON.stringify(sessionId) : null;
  try {
    return readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter((l) => l && (needle === null || l.includes(needle) || !l.includes('"session_id"')))
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e && typeof e === "object");
  } catch {
    return [];
  }
}

/**
 * Append one record to a log in `dir` and confirm it can be read back, reading only the end of the file (the newest
 * 64 KiB, or twice the record's length if larger), never the whole log. Throws when the append fails; false when the
 * read-back fails or does not find the record.
 * @param {string} dir @param {string} name @param {Record<string, unknown>} record @returns {boolean}
 */
export function appendJsonl(dir, name, record) {
  const line = `${JSON.stringify(record)}\n`;
  const path = join(dir, name);
  appendFileSync(path, line);
  /** @type {number | undefined} */
  let fd;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    const len = Math.min(size, Math.max(64 * 1024, Buffer.byteLength(line) * 2));
    const buf = Buffer.alloc(len);
    const got = readSync(fd, buf, 0, len, size - len);
    return buf.subarray(0, got).toString("utf8").includes(line);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The session's records for foldRuns. Test-gate records without a session_id (older verify.sh) are kept: foldRuns
 * joins them to a launch of this session by agent_id. `raw` holds logs the caller already read with
 * readJsonl(dir, name, sessionId), keyed by file name, so they are not read twice.
 * @param {string} sessionId @param {string} [dir] @param {Record<string, any[]>} [raw]
 * @returns {{ launches: any[], stops: any[], gates: any[], starts: any[] }}
 */
export function loadRecords(sessionId, dir = stateDir, raw = {}) {
  /** @param {any} r */
  const mine = (r) => r.session_id === sessionId;
  /** @param {string} name @returns {any[]} */
  const read = (name) => (Array.isArray(raw[name]) ? /** @type {any[]} */ (raw[name]) : readJsonl(dir, name, sessionId));
  return {
    launches: read("journal-launches.jsonl").filter(mine),
    stops: read("journal.jsonl").filter(mine),
    gates: read("gates.jsonl").filter((g) => g.gate === "test" && (g.session_id === undefined || g.session_id === sessionId)),
    starts: read("telemetry.jsonl").filter((e) => mine(e) && (e.hook_event_name === "SubagentStart" || e.hook_event_name === "SubagentStop")),
  };
}

/**
 * The session's runs: every run, the open one (not closed, not stale) and the latest one (open, closed or stale; the
 * review gate gates the latest run's unreviewed slices even when it went stale). `env` (default process.env) gives
 * ORCH_RUN_STALE_MIN, ORCH_GAP_MIN and ORCH_ESCALATION to the fold; slice states carry countedFails, stalled and signals.
 * `raw` is passed on to loadRecords.
 * @param {string} sessionId
 * @param {{ dir?: string, now?: number, env?: Record<string, string | undefined>, raw?: Record<string, any[]> }} [opts]
 */
export function sessionRuns(sessionId, opts = {}) {
  const records = loadRecords(sessionId, opts.dir ?? stateDir, opts.raw ?? {});
  const env = opts.env ?? process.env;
  // env also sets the gap cutoff (ORCH_GAP_MIN) and the escalation mode of each slice's `signals`.
  const { runs, open } = foldRuns(records, { now: opts.now ?? Date.now(), staleMin: staleMinutes(env), sessionId, env });
  return { records, runs, open, latest: runs.at(-1) ?? null };
}

// Test-gate blocks of implementers, shared by the review gate (implementer_unfinished) and the plan check (a reviewer
// launch held while the slice's implementer has failing tests it never saw), so the two read a block the same way.
// The test gate (verify.sh) runs at an implementer's SubagentStop, beside the journal, and decides minutes later: its
// block lands after the agent ended and its report reached the orchestrator.

/** @param {unknown} ts */
const timeOf = (ts) => Date.parse(String(ts ?? "")) || 0;

/**
 * @typedef {{ id: string, start: number, stop: number, testAt: number, testBlock: boolean, testReason: string, test: any, stopGate: any }} ImplementerTestState
 * Per implementer agent: its latest SubagentStart and SubagentStop (ms; -Infinity when none) and its latest test-gate
 * record (`test`, with its time, whether it blocked and its reason; "" for a record with no reason).
 * stopGate: the test-gate record of the agent's latest stop, or null while the gate has not reported on it. The gate
 * writes one record per implementer stop, and the stops' hooks run side by side: telemetry stamps a stop after reading
 * the transcript, so a fast gate record (no_code_changes, no_test_command) can carry an earlier time than its own stop.
 * So records are paired with stops by key and count, never by time and never across the agent's latest start
 * (stopGateOf): a stop that follows a hand-back and its test-gate record carry the same after_handback (2.0.0); a stop
 * with none (a worker that only stops, or older logs) is paired by count as before. The hand-back gate's records (at
 * "handback", handback_id) belong to a hand-back and are never a stop's record.
 * The review gate keeps comparing times (testBlocked); only the plan check's reviewer hold reads stopGate.
 */

/**
 * The implementer agents of a session with their latest start, stop and test-gate record. `telemetry` holds
 * SubagentStart/SubagentStop records (telemetry.jsonl, or loadRecords' `starts`); only bare or namespaced `implementer`
 * agent types count. `gates` holds gates.jsonl records; only test-gate records with an agent_id of one of those agents and
 * this session (or no session_id, older verify.sh) count, and on equal times the later line wins.
 * @param {any[]} telemetry @param {any[]} gates @param {string} sessionId @returns {Map<string, ImplementerTestState>}
 */
export function implementerTestStates(telemetry, gates, sessionId) {
  /** @type {Map<string, ImplementerTestState>} */
  const agents = new Map();
  for (const e of telemetry) {
    if (String(String(e.agent_type ?? e.role ?? "").split(":").pop()) !== "implementer" || typeof e.agent_id !== "string" || !e.agent_id) continue;
    const a = agents.get(e.agent_id) ?? { id: e.agent_id, start: -Infinity, stop: -Infinity, testAt: -Infinity, testBlock: false, testReason: "", test: null, stopGate: null };
    if (e.hook_event_name === "SubagentStart") a.start = Math.max(a.start, timeOf(e.ts));
    if (e.hook_event_name === "SubagentStop") a.stop = Math.max(a.stop, timeOf(e.ts));
    agents.set(e.agent_id, a);
  }
  for (const g of gates) {
    if (g.gate !== "test" || typeof g.agent_id !== "string" || (g.session_id !== undefined && g.session_id !== sessionId)) continue;
    const a = agents.get(g.agent_id);
    if (!a || timeOf(g.ts) < a.testAt) continue;
    a.testAt = timeOf(g.ts);
    a.testBlock = g.decision === "block";
    a.testReason = typeof g.reason === "string" ? g.reason : "";
    a.test = g;
  }
  for (const a of agents.values()) {
    // Stops since the latest start, in time order (a stable sort keeps line order for equal times).
    const stops = telemetry
      .filter((e) => e.agent_id === a.id && e.hook_event_name === "SubagentStop" && timeOf(e.ts) >= a.start)
      .sort((x, y) => timeOf(x.ts) - timeOf(y.ts));
    const mine = gates
      .filter((g) => g.gate === "test" && g.agent_id === a.id && (g.session_id === undefined || g.session_id === sessionId))
      .sort((x, y) => timeOf(x.ts) - timeOf(y.ts));
    a.stopGate = stopGateOf(stops, mine, a.start);
  }
  return agents;
}

/** The hand-back a stop or a stop's test-gate record follows (state.mjs latestHandbackId), or "". @param {any} r @returns {string} */
const linkOf = (r) => (typeof r?.after_handback === "string" ? r.after_handback : "");
/** A record of the hand-back gate (verify.sh --handback): it belongs to a hand-back, never to a stop. @param {any} g */
const handbackRecord = (g) => g?.at === "handback" || (typeof g?.handback_id === "string" && g.handback_id !== "");

/**
 * The test-gate record of the latest of `stops` (the agent's stops since its latest start, in time order), or null while
 * the gate has not reported on it. Only records since that start count, never the hand-back gate's. The latest stop's
 * group is the stops since the start with its after_handback ("" for none); it has its record once the records with
 * that after_handback are at least as many as the group's stops, and it is the latest of them. So a stop after a
 * hand-back takes only a record of that hand-back's stop (a late record of an earlier stop names another hand-back), and
 * stops with none are paired by count as in 1.6.1. When no record since the start names the stop's hand-back at all
 * (an older verify.sh writes none), the unkeyed records since the start are paired by count against all its stops.
 * @param {any[]} stops @param {any[]} gates the agent's test-gate records, in time order @param {number} start @returns {any}
 */
export function stopGateOf(stops, gates, start) {
  const latest = stops.at(-1);
  if (!latest) return null;
  const key = linkOf(latest);
  const since = gates.filter((g) => !handbackRecord(g) && timeOf(g.ts) >= start);
  const recs = since.filter((g) => linkOf(g) === key);
  if (key && !recs.length) {
    // No record names the stop's hand-back: an older verify.sh beside newer hooks writes no after_handback. Its
    // unkeyed records since the start are paired by count against every stop since the start, as in 1.6.1.
    const unkeyed = since.filter((g) => !linkOf(g));
    return unkeyed.length && unkeyed.length >= stops.length ? (unkeyed.at(-1) ?? null) : null;
  }
  const group = stops.filter((x) => linkOf(x) === key).length;
  return recs.length >= group ? (recs.at(-1) ?? null) : null;
}

/** The agent's latest test-gate record is a block later than its latest stop. @param {{ stop: number, testAt: number, testBlock: boolean }} a */
export const testBlocked = (a) => a.testBlock && a.testAt > a.stop;

/**
 * A bugfix_ block comes after the tests passed: the gate could not verify the reproduction test. Anything else
 * (tests_failed, or an older record with no reason) is a test failure. @param {{ testReason: string }} a
 */
export const notTestFailure = (a) => a.testReason.startsWith("bugfix_");

/**
 * The bugfix_ reasons where the check never ran for a cause outside the worker's code (docs/gates.md, "Bugfix check"):
 * no usable base run, no base or no base worktree, no time left in the gate's budget, the temp folder removed. Named one
 * by one, never a prefix: bugfix_no_test and bugfix_test_passes_on_base are the worker's own to fix, and an unknown
 * reason is not one.
 */
export const ENVIRONMENT_REASONS = new Set(["bugfix_base_unusable", "bugfix_no_base", "bugfix_timeout", "bugfix_tmp_lost"]);

/** @param {{ testReason: string }} a */
export const environmentBlock = (a) => ENVIRONMENT_REASONS.has(a.testReason);

/**
 * The slice's latest implementer (the one started or stopped last among the agents whose stop or launch record names
 * the slice), or null. With `among`, only those agent ids count.
 * @param {Map<string, ImplementerTestState>} agents @param {{ launches: any[], stops: any[] }} records @param {string} slice
 * @param {Set<string>} [among]
 */
export function latestImplementerOf(agents, records, slice, among) {
  /** @type {ImplementerTestState | null} */
  let best = null;
  for (const a of agents.values()) {
    if (sliceOfAgent(records, a.id) !== slice || (among && !among.has(a.id))) continue;
    if (!best || Math.max(a.start, a.stop) >= Math.max(best.start, best.stop)) best = a;
  }
  return best;
}

/**
 * The implementers of `slice` in the run a review of it lands in, as foldRuns places a review: the latest run whose
 * slices hold it (a slice carried whole keeps its implementers; one that starts clean starts with none). With no run
 * holding the slice: the implementers no run holds for it (launched outside any run). Returns the set of agent ids.
 * @param {import("./brief.mjs").Run[]} runs @param {Map<string, ImplementerTestState>} agents
 * @param {{ launches: any[], stops: any[] }} records @param {string} slice @returns {Set<string>}
 */
export function implementersOfRun(runs, agents, records, slice) {
  const run = runs.findLast((r) => Object.hasOwn(r.slices, slice));
  if (run) return new Set(run.slices[slice]?.implementers ?? []);
  const inRuns = new Set(runs.flatMap((r) => (Object.hasOwn(r.slices, slice) ? (r.slices[slice]?.implementers ?? []) : [])));
  return new Set([...agents.keys()].filter((id) => !inRuns.has(id) && sliceOfAgent(records, id) === slice));
}

/**
 * The slice an agent worked on, from its stop records, else its launch record; null when neither names one.
 * @param {{ launches: any[], stops: any[] }} records @param {unknown} agentId @returns {string | null}
 */
export function sliceOfAgent(records, agentId) {
  if (typeof agentId !== "string" || !agentId) return null;
  const stop = records.stops.findLast((s) => s.agent_id === agentId && typeof s.slice === "string" && s.slice);
  if (stop) return stop.slice;
  const launch = records.launches.findLast((l) => l.agent_id === agentId && typeof l.slice === "string" && l.slice);
  return launch ? launch.slice : null;
}
