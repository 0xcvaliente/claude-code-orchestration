#!/usr/bin/env node
// Run journal (records spec: docs/brief-grammar.md, "Log records"). Two logs in the state dir, parsed fields only, never
// the brief or reply text:
//   PostToolUse on Agent|Task -> journal-launches.jsonl: a launch record (brief.mjs launchRecord) for every launch of an
//     implementer, reviewer, researcher or integrator: agent_id (from the tool response, else null), bare agent_type,
//     slice (a brief starting with PLAN REVIEW is slice "plan"), the parsed header, the reviewer model, isPlanReview,
//     replan and, for PLAN REVIEW briefs, the parsed plan.
//   SubagentStop of an implementer or reviewer -> journal.jsonl: a stop record (brief.mjs stopRecord): slice, status
//     (parseStatus: any STATUS: fail line fails, else the first STATUS line decides, blockquotes ignored), answers,
//     open and run (the run foldRuns gives the slice at write time).
// An orchestrator asked to resume reads journal.jsonl and skips slices whose last review passed; plan-check.mjs and
// review-gate.mjs fold both logs into runs (run.mjs).
// Headless runs pass --no-session-persistence, so there is no subagent transcript to read the brief from: the slice is
// taken from the launch record with the same agent_id. A background agent's PostToolUse comes first; a foreground
// agent stops before its PostToolUse (verified on Claude Code 2.1.314: its SubagentStop is logged before its
// PostToolUse), so an unmatched stop waits in journal-pending.jsonl, with its status, answers and open, and is written
// when its launch arrives. With a transcript (interactive sessions) the brief is read from it as before.
// Exits 0 on malformed input.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { launchRecord, parseStatus, sliceOfBrief, stopRecord } from "./brief.mjs";
import { readJsonl, sessionRuns } from "./run.mjs";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
if (duplicate("journal.mjs")) process.exit(0); // the project's own copy records this event
let p;
try {
  p = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  process.exit(0);
}
if (!p || typeof p !== "object") process.exit(0);

const LAUNCH_ROLES = ["implementer", "reviewer", "researcher", "integrator"];
const STOP_ROLES = ["implementer", "reviewer"];
const sessionId = typeof p.session_id === "string" ? p.session_id : "";
/** @param {unknown} t */
const bare = (t) => /** @type {string} */ (String(t ?? "").split(":").pop()); // split always yields one element
/** @param {string} name @param {Record<string, unknown>} record */
const append = (name, record) => {
  try {
    ensureStateDir();
    appendFileSync(join(stateDir, name), `${JSON.stringify(record)}\n`);
  } catch {
    // the journal must never fail the agent
  }
};
/** Text of a transcript message: its text blocks and a SubagentHandback message. @param {any} content */
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : b?.type === "tool_use" && b.name === "SubagentHandback" && typeof b.input?.message === "string" ? b.input.message : ""))
          .filter(Boolean)
          .join("\n")
      : "";
// A foreground result may carry the agent id only in its text ("agentId: a1b2...").
/** @param {any} r @returns {string | null} */
const agentIdOf = (r) =>
  (r && typeof r === "object" && typeof r.agentId === "string" && r.agentId) || JSON.stringify(r ?? "").match(/agentId["\\: ]+([A-Za-z0-9_-]{6,})/)?.[1] || null;
/** The run foldRuns gives a slice now: the latest run with the slice, else the open run. @param {string} slice */
const runOf = (slice) => {
  try {
    const { runs, open } = sessionRuns(sessionId);
    return runs.findLast((r) => slice in r.slices)?.id ?? open?.id ?? null;
  } catch {
    return null;
  }
};

if (p.hook_event_name === "PostToolUse") {
  const role = bare(p.tool_input?.subagent_type);
  if (!LAUNCH_ROLES.includes(role)) process.exit(0);
  const agentId = agentIdOf(p.tool_response);
  const rec = launchRecord(p.tool_input, { sessionId, agentId, projectDir: process.env.CLAUDE_PROJECT_DIR || p.cwd || null, pluginRoot: process.env.CLAUDE_PLUGIN_ROOT || null });
  append("journal-launches.jsonl", rec);
  if (agentId && rec.slice && STOP_ROLES.includes(role)) {
    const waiting = readJsonl(stateDir, "journal-pending.jsonl").filter((e) => e.agent_id === agentId).pop();
    if (waiting) append("journal.jsonl", { ...waiting, session_id: sessionId, role, slice: rec.slice, run: runOf(rec.slice) });
  }
  process.exit(0);
}

if (p.hook_event_name !== "SubagentStop" || !STOP_ROLES.includes(bare(p.agent_type))) process.exit(0);
const role = bare(p.agent_type);
const agentId = typeof p.agent_id === "string" && p.agent_id ? p.agent_id : null;

/** @type {any[]} */
let entries = [];
try {
  entries = readFileSync(p.agent_transcript_path, "utf8")
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
} catch {
  // no transcript (headless): the slice comes from the launch record
}
const launch = agentId ? readJsonl(stateDir, "journal-launches.jsonl").filter((e) => e.agent_id === agentId).pop() : undefined;
const slice = (typeof launch?.slice === "string" && launch.slice) || sliceOfBrief(textOf(entries.find((e) => e.type === "user")?.message?.content)) || null;

// The report: the last message when it has a STATUS line, else the latest transcript message that has one, else the
// last message (no status; its answers and OPEN still count).
const last = typeof p.last_assistant_message === "string" ? p.last_assistant_message : "";
let report = parseStatus(last) !== null ? last : undefined;
for (let i = entries.length - 1; report === undefined && i >= 0; i--) {
  if (entries[i].type !== "assistant") continue;
  const text = textOf(entries[i].message?.content);
  if (parseStatus(text) !== null) report = text;
}

const rec = stopRecord({ sessionId, agentId, role, slice, reply: report ?? last, run: slice ? runOf(slice) : null });
append(slice ? "journal.jsonl" : "journal-pending.jsonl", rec);
process.exit(0);
