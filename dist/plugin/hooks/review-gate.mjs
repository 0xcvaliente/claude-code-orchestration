#!/usr/bin/env node
// Stop gate: if this session ran an implementer, do not let the final reply go out until a reviewer
// has finished after the last implementer, and its STATUS is "pass" (a "fail" or a missing status blocks).
// Reads telemetry.jsonl written by telemetry.mjs, in the state dir from state.mjs. Exit 2 blocks and returns stderr.
// Loop guard: at most MAX_BLOCKS blocks after each implementer run. Then the reply goes out with a systemMessage
// saying the work is unverified, so giving up is never silent.
import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

const MAX_BLOCKS = 2; // since the last implementer finished; a new implementer run resets the count
let sessionId = "";
/** @param {string} decision @param {string} reason @param {number} code */
function decide(decision, reason, code) {
  try {
    ensureStateDir();
    appendFileSync(join(stateDir, "gates.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), gate: "review", decision, reason, session_id: sessionId })}\n`);
  } catch {
    // logging must never change the decision
  }
  process.exit(code);
}
/** @param {number} fd @param {string} text */
const say = (fd, text) => {
  try {
    writeSync(fd, `${text}\n`);
  } catch {
    // a closed stream must not change the decision
  }
};

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
if (duplicate("review-gate.mjs")) process.exit(0); // the project's own copy gates this reply
/** @type {any} */
let input = {};
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  decide("allow", "unparseable_input", 0);
}
sessionId = input.session_id ?? "";

/** @param {string} name @returns {any[]} */
const readLog = (name) =>
  readFileSync(join(stateDir, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

if (!existsSync(join(stateDir, "telemetry.jsonl"))) decide("allow", "no_telemetry", 0);
const events = readLog("telemetry.jsonl").filter((e) => e.hook_event_name === "SubagentStop" && e.session_id === input.session_id);

// Plugin agents arrive namespaced ("orchestration:implementer"); compare the bare role name.
/** @param {any} e */
const role = (e) => String(e.agent_type ?? "").split(":").pop();
const lastImpl = events.map(role).lastIndexOf("implementer");
if (lastImpl === -1) decide("allow", "no_implementer_in_session", 0);

// Count only blocks after the last implementer finished. Counting the whole session would stop gating for good
// after MAX_BLOCKS, so later work in a long session would go out unreviewed. A record with no ts counts them all.
const since = Date.parse(events[lastImpl].ts) || 0;
const priorBlocks = existsSync(join(stateDir, "gates.jsonl"))
  ? readLog("gates.jsonl").filter((g) => g.gate === "review" && g.decision === "block" && g.session_id === sessionId && Date.parse(g.ts) >= since).length
  : 0;
/** @param {string} reason @param {string} message */
const capped = (reason, message) => {
  if (priorBlocks < MAX_BLOCKS) {
    const last = priorBlocks === MAX_BLOCKS - 1 ? " This is the last block: if no reviewer can pass the work, say in your reply that it is unverified and report the slice as failed." : "";
    say(2, message + last);
    decide("block", reason, 2);
  }
  const warning = `Review gate: gave up after ${MAX_BLOCKS} blocks (${reason}). The last implementer's work is unverified; treat it as failed until a reviewer passes it.`;
  say(1, JSON.stringify({ systemMessage: warning }));
  say(2, warning);
  decide("allow", "max_blocks_reached", 0);
};

const reviews = events.slice(lastImpl + 1).filter((e) => role(e) === "reviewer");
if (reviews.length === 0) {
  capped("no_reviewer_after_last_implementer", "Review gate: an implementer finished but no reviewer has run since. Send the result to a reviewer before replying.");
}
if (reviews[reviews.length - 1].status === "fail") {
  capped("last_reviewer_failed", "Review gate: the last reviewer reported STATUS: fail. Retry the implementer with the gaps, or report the slice as failed with evidence.");
}
if (reviews[reviews.length - 1].status !== "pass") {
  capped("last_reviewer_no_status", "Review gate: the last reviewer returned no STATUS line. Rerun the review, or report the slice as failed.");
}
decide("allow", "reviewer_passed", 0);
