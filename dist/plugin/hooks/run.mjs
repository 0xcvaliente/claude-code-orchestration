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
