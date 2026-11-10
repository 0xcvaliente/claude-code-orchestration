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
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseReply } from "./brief.mjs";
import { readJsonl } from "./run.mjs";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

const WORKERS = new Set(["researcher", "implementer", "reviewer", "integrator"]);

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

// Run as a hook only when executed directly (the tests import reportProblem).
if (process.argv[1]?.endsWith("handback-check.mjs")) {
  if ((process.env.ORCH_HANDBACK_CHECK ?? "").trim().toLowerCase() === "off") process.exit(0);
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
  if (input.tool_name !== "SubagentHandback" || !WORKERS.has(role) || typeof message !== "string") process.exit(0);
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const agentId = typeof input.agent_id === "string" && input.agent_id ? input.agent_id : null;

  /** @type {string[]} */
  let checks = [];
  let deniedBefore = false;
  try {
    if (agentId) {
      const launch = readJsonl(stateDir, "journal-launches.jsonl").findLast((l) => l.session_id === sessionId && l.agent_id === agentId);
      if (Array.isArray(launch?.checks)) checks = launch.checks.filter((/** @type {unknown} */ c) => typeof c === "string");
      deniedBefore = readJsonl(stateDir, "gates.jsonl").some((g) => g.gate === "handback" && g.decision === "deny" && g.session_id === sessionId && g.agent_id === agentId);
    }
  } catch {
    // unreadable logs: no CHECKS ids, and no earlier denial is known
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
    const rec = { ts: new Date().toISOString(), gate: "handback", decision: deny ? "deny" : "allow", reason: deny ? problem.reason : `${problem.reason}_gave_up`, ...(problem.missing ? { missing: problem.missing } : {}), session_id: sessionId, agent_id: agentId, agent_type: role };
    appendFileSync(join(stateDir, "gates.jsonl"), `${JSON.stringify(rec)}\n`);
    recorded = readJsonl(stateDir, "gates.jsonl").some((g) => g.gate === "handback" && g.decision === "deny" && g.session_id === sessionId && g.agent_id === agentId);
  } catch {
    // no record, so no denial
  }
  if (!deny || !recorded) process.exit(0);
  process.stderr.write(`${problem.message}\n`);
  process.exit(2);
}
