#!/usr/bin/env node
// Stop gate: if this session ran an implementer, do not let the final reply go out until a reviewer
// has finished after the last implementer, and its STATUS is "pass" (a "fail" or a missing status blocks).
// Reads .claude/state/telemetry.jsonl written by telemetry.mjs. Exit 2 blocks and returns stderr.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const stateDir = join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), ".claude", "state");
const MAX_BLOCKS = 2; // per session; the cap is the loop guard
let sessionId = "";
function decide(decision, reason, code) {
  try {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(join(stateDir, "gates.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), gate: "review", decision, reason, session_id: sessionId })}\n`);
  } catch {
    // logging must never change the decision
  }
  process.exit(code);
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let input = {};
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  decide("allow", "unparseable_input", 0);
}
sessionId = input.session_id ?? "";

const file = join(stateDir, "telemetry.jsonl");
if (!existsSync(file)) decide("allow", "no_telemetry", 0);

const events = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  })
  .filter((e) => e && e.hook_event_name === "SubagentStop" && e.session_id === input.session_id);

// Plugin agents arrive namespaced ("orchestration:implementer"); compare the bare role name.
const role = (e) => String(e.agent_type ?? "").split(":").pop();
const lastImpl = events.map(role).lastIndexOf("implementer");
if (lastImpl === -1) decide("allow", "no_implementer_in_session", 0);

const gateLog = join(stateDir, "gates.jsonl");
const priorBlocks = existsSync(gateLog)
  ? readFileSync(gateLog, "utf8").split("\n").filter((l) => l.includes('"gate":"review"') && l.includes('"decision":"block"') && l.includes(`"session_id":"${sessionId}"`)).length
  : 0;
const capped = (reason, code) => (priorBlocks >= MAX_BLOCKS ? decide("allow", "max_blocks_reached", 0) : decide("block", reason, code));

const reviews = events.slice(lastImpl + 1).filter((e) => role(e) === "reviewer");
if (reviews.length === 0) {
  console.error("Review gate: an implementer finished but no reviewer has run since. Send the result to a reviewer before replying.");
  capped("no_reviewer_after_last_implementer", 2);
}
if (reviews[reviews.length - 1].status === "fail") {
  console.error("Review gate: the last reviewer reported STATUS: fail. Retry the implementer with the gaps, or report the slice as failed with evidence.");
  capped("last_reviewer_failed", 2);
}
if (reviews[reviews.length - 1].status !== "pass") {
  console.error("Review gate: the last reviewer returned no STATUS line. Rerun the review, or report the slice as failed.");
  capped("last_reviewer_no_status", 2);
}
decide("allow", "reviewer_passed", 0);
