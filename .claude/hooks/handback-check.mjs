#!/usr/bin/env node
// PreToolUse hook (matcher SubagentHandback): reads a worker's report before it is delivered (1.2.0).
// Since Claude Code 2.1.271 a subagent in auto mode delivers its final report through the SubagentHandback tool, and a
// PreToolUse hook on that tool receives the report as tool_input.message; a denied call is not delivered, and Claude Code
// tells the subagent, up to three times, to send it again (docs: hooks, "PreToolUse `ask` decisions in auto mode").
// So a report the gates could not read is sent back to its author here, instead of reaching the orchestrator and
// costing a new review: the review gate would only see it later, as last_reviewer_no_status or constraints_unchecked.
// Two checks, denying a worker at most once (and only when that denial's record is written; the second report always goes through, so a worker that cannot
// comply still reports, and the gates judge that report as before):
//   no_status          the report has no STATUS line (brief.mjs parseStatus), for any of this plugin's workers;
//   checks_unanswered  a reviewer's passing report leaves an id of its brief's CHECKS line without an answer line. The
//                      CHECKS ids come from the reviewer's launch record (journal-launches.jsonl), which a background
//                      launch has by now; a foreground launch has none yet, so this check skips.
// Deny-only: exit 2 with the reason on stderr, or exit 0 with no output. It never prints an allow or ask decision and
// never changes the report. Acts only for the bare agent types researcher, implementer, reviewer and integrator; any
// other agent, a session in another permission mode (no SubagentHandback tool: the report is the last message, and
// the gates read it at SubagentStop as before) and malformed input exit 0. ORCH_HANDBACK_CHECK=off disables it.
// Decisions go to gates.jsonl in the state dir (gate "handback": the reason and ids only, never report text).
// It also captures every hand-back's parsed fields (handbackFields) in handbacks.jsonl (state.mjs recordHandback), for
// any agent type with an agent id and even with ORCH_HANDBACK_CHECK=off: at SubagentStop journal.mjs and telemetry.mjs
// read the report from that capture, since the stop payload of a hand-back carries no last_assistant_message and the
// subagent transcript does not hold the report just handed back yet. A hand-back this hook refuses is also marked in
// handback-refusals.jsonl (state.mjs recordHandbackRefusal), so the stop never takes the undelivered capture.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseReply, stopRecord } from "./brief.mjs";
import { appendJsonl, readJsonl, readJsonlOrNull } from "./run.mjs";
import { duplicate, ensureStateDir, recordHandback, recordHandbackRefusal, stateDir } from "./state.mjs";

const WORKERS = new Set(["researcher", "implementer", "reviewer", "integrator"]);

/**
 * A key for one hand-back's report that both hooks on its PreToolUse compute alike, whichever finishes first (2.0.0):
 * the first 16 hex digits of the report's SHA-256. Never report text. A capture carries it as `report_key`, and so does
 * a refusal, so a refusal written before its capture (no tool_use_id) can still be matched (journal.mjs).
 * quote-check.mjs computes the same key with its own copy (it runs where this file may be absent): keep them equal.
 * @param {string} message
 */
export const reportKey = (message) => createHash("sha256").update(message, "utf8").digest("hex").slice(0, 16);

/**
 * What is wrong with a worker's report, or null. `checks` are the ids of the reviewer's CHECKS line, when known.
 * @param {string} role bare agent type @param {string} message @param {string[]} [checks]
 * @returns {{ reason: "no_status" | "checks_unanswered", missing?: string[], message: string } | null}
 */
export function reportProblem(role, message, checks = []) {
  const reply = parseReply(message);
  if (reply.status === null) {
    return {
      reason: "no_status",
      message: "Report check: your report has no STATUS line, so its result cannot be read. Send the same report again with `STATUS: pass` or `STATUS: fail` as its first line, on a line of its own and not quoted.",
    };
  }
  if (role === "reviewer" && reply.status === "pass") {
    const missing = checks.filter((id) => !reply.answers[id]);
    if (missing.length) {
      return {
        reason: "checks_unanswered",
        missing,
        message: `Report check: your report passes the slice without answering ${missing.join(", ")}. Send it again with one line per checked id: \`C1: pass (cmd) <command> -> <result>\`, \`C1: pass (read) <file:line or URL>\` or \`C1: fail <reason>\` (a fail answer means STATUS: fail).`,
      };
    }
  }
  return null;
}

const CAPTURED = ["status", "answers", "open", "gaps", "quotes", "draft", "skills_used", "skills_skipped"];
/**
 * The parsed fields of a report that a stop record takes from it (brief.mjs stopRecord): status, answers, open, gaps
 * (confidence and key), the quote count, and draft, skills_used and skills_skipped only when the report has them.
 * Never report text beyond what stopRecord itself keeps.
 * @param {string} message
 */
export function handbackFields(message) {
  const r = /** @type {Record<string, unknown>} */ (stopRecord({ reply: message }));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const k of CAPTURED) if (k in r) out[k] = r[k];
  return out;
}

// Run as a hook only when executed directly (the tests import reportProblem).
if (process.argv[1]?.endsWith("handback-check.mjs")) {
  if (duplicate("handback-check.mjs")) process.exit(0);
  /** @type {any} */
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) process.exit(0);
  const role = typeof input.agent_type === "string" ? (input.agent_type.split(":").pop() ?? "") : "";
  const message = input.tool_input?.message;
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const agentId = typeof input.agent_id === "string" && input.agent_id ? input.agent_id : null;
  // The capture for the stop records (state.mjs, HANDBACK_LOG): every agent with an id that hands a report back, and
  // whether or not the check below is switched off. Each attempt is captured, so after a report is sent back the
  // corrected one is the latest. Parsed fields only.
  const toolUseId = typeof input.tool_use_id === "string" && input.tool_use_id ? input.tool_use_id : null;
  if (input.tool_name === "SubagentHandback" && typeof message === "string" && agentId) {
    try {
      recordHandback({ session_id: sessionId, agent_id: agentId, agent_type: role, ...(toolUseId ? { tool_use_id: toolUseId } : {}), report_key: reportKey(message), ...handbackFields(message) });
    } catch {
      // the capture must never hold a report back
    }
  }
  if ((process.env.ORCH_HANDBACK_CHECK ?? "").trim().toLowerCase() === "off") process.exit(0);
  if (input.tool_name !== "SubagentHandback" || !WORKERS.has(role) || typeof message !== "string") process.exit(0);

  /** @type {string[]} */
  let checks = [];
  // An earlier denial that cannot be ruled out counts as one (2.0.1, D3): a log that exists and cannot be read in full
  // (readJsonlOrNull null) must never read as "no denial", or a worker is denied at every try and its report is lost.
  let deniedBefore = true;
  let logUnreadable = false;
  try {
    if (agentId) {
      const launch = readJsonl(stateDir, "journal-launches.jsonl", sessionId).findLast((l) => l.session_id === sessionId && l.agent_id === agentId);
      if (Array.isArray(launch?.checks)) checks = launch.checks.filter((/** @type {unknown} */ c) => typeof c === "string");
      const gates = readJsonlOrNull(stateDir, "gates.jsonl", sessionId);
      logUnreadable = gates === null;
      deniedBefore = gates === null || gates.some((g) => g.gate === "handback" && g.decision === "deny" && g.session_id === sessionId && g.agent_id === agentId);
    }
  } catch {
    // unreadable logs: no CHECKS ids, and an earlier denial cannot be ruled out
    logUnreadable = true;
  }
  const problem = reportProblem(role, message, checks);
  if (!problem) process.exit(0);
  // Without an agent id the hook cannot tell a second report from the first, so it never denies: a worker must not
  // be sent back three times and end with no report at all.
  const deny = !deniedBefore && agentId !== null;
  // A denial counts only once its record is written and readable: without it the next report could not be told from
  // this one, and a worker denied three times ends with no report delivered.
  let recorded = false;
  try {
    ensureStateDir();
    const rec = { ts: new Date().toISOString(), gate: "handback", decision: deny ? "deny" : "allow", reason: deny ? problem.reason : `${problem.reason}_gave_up`, ...(problem.missing ? { missing: problem.missing } : {}), ...(logUnreadable ? { log_unreadable: true } : {}), session_id: sessionId, agent_id: agentId, agent_type: role };
    // The record is read back from the end of the log only, so the log is read in full once per call; when that tail
    // read fails, the full read that found no earlier denial confirms it instead (the reader the next call uses).
    recorded = appendJsonl(stateDir, "gates.jsonl", rec);
    if (!recorded && deny) recorded = (readJsonlOrNull(stateDir, "gates.jsonl", sessionId) ?? []).some((g) => g.gate === "handback" && g.decision === "deny" && g.ts === rec.ts && g.agent_id === agentId);
    // A deny record that cannot be read back is not returned: a record right after it says so, so the log never
    // holds a denial that was not returned without its correction (and the next call still sees a denial).
    if (deny && !recorded) appendJsonl(stateDir, "gates.jsonl", { ...rec, ts: new Date().toISOString(), decision: "allow", reason: `${problem.reason}_unconfirmed`, voids: rec.ts });
    recorded = recorded && deny;
  } catch {
    // no record, so no denial
  }
  if (!deny || !recorded) process.exit(0);
  // The capture above is now a report that is not delivered: mark it, so the stop never takes it (G-14).
  // report_key: the key journal.mjs matches a refusal without tool_use_id by (an added field; state.mjs keeps it).
  const refusal = { session_id: sessionId, agent_id: agentId, tool_use_id: toolUseId, gate: "handback", report_key: reportKey(message) };
  recordHandbackRefusal(refusal);
  process.stderr.write(`${problem.message}\n`);
  process.exit(2);
}
