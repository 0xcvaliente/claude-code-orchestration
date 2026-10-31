// The current run of a session, for the gates: loads the session's log records from the state dir (state.mjs) and folds
// them with brief.mjs's foldRuns (spec: docs/brief-grammar.md, "Run model"). Records read:
//   journal-launches.jsonl  launch records (journal.mjs, PostToolUse on Agent|Task)
//   journal.jsonl           stop records (journal.mjs, SubagentStop)
//   gates.jsonl             test-gate records (verify.sh); joined to a launch by agent_id inside foldRuns
//   telemetry.jsonl         SubagentStart / SubagentStop (telemetry.mjs): which agents are still running
// No side effects at import beyond state.mjs reading settings; the functions only read files, and an unreadable or
// missing log reads as empty. Node built-ins only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { foldRuns, staleMinutes } from "./brief.mjs";
import { stateDir } from "./state.mjs";

/**
 * Parsed JSON lines of a log in `dir`; a missing or unreadable file and unparseable lines read as nothing.
 * @param {string} dir @param {string} name @returns {any[]}
 */
export function readJsonl(dir, name) {
  try {
    return readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter(Boolean)
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
 * The session's records for foldRuns. Test-gate records without a session_id (older verify.sh) are kept: foldRuns
 * joins them to a launch of this session by agent_id.
 * @param {string} sessionId @param {string} [dir]
 * @returns {{ launches: any[], stops: any[], gates: any[], starts: any[] }}
 */
export function loadRecords(sessionId, dir = stateDir) {
  /** @param {any} r */
  const mine = (r) => r.session_id === sessionId;
  return {
    launches: readJsonl(dir, "journal-launches.jsonl").filter(mine),
    stops: readJsonl(dir, "journal.jsonl").filter(mine),
    gates: readJsonl(dir, "gates.jsonl").filter((g) => g.gate === "test" && (g.session_id === undefined || g.session_id === sessionId)),
    starts: readJsonl(dir, "telemetry.jsonl").filter((e) => mine(e) && (e.hook_event_name === "SubagentStart" || e.hook_event_name === "SubagentStop")),
  };
}

/**
 * The session's runs: every run, the open one (not closed, not stale) and the latest one (open, closed or stale; the
 * review gate gates the latest run's unreviewed slices even when it went stale). `env` (default process.env) gives
 * ORCH_RUN_STALE_MIN, ORCH_GAP_MIN and ORCH_ESCALATION to the fold; slice states carry countedFails, stalled and signals.
 * @param {string} sessionId
 * @param {{ dir?: string, now?: number, env?: Record<string, string | undefined> }} [opts]
 */
export function sessionRuns(sessionId, opts = {}) {
  const records = loadRecords(sessionId, opts.dir ?? stateDir);
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
