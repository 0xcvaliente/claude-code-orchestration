#!/usr/bin/env node
// Turn budget (PostToolUse, no matcher): an agent that reaches its maxTurns stops without a report and fires no
// SubagentStop, so nothing tests or reviews its work. For a tool call of this plugin's researcher, implementer,
// reviewer or integrator (bare or orchestration: type), this counts the agent's turns from its own transcript with
// telemetry.mjs's count (usageFromTranscript) and, the first time they reach 80% of its maxTurns (maxTurnsOf), tells
// it in additionalContext to commit and report. Once per agent: a marker in the state dir keyed by session and agent
// id is created (exclusively) before answering. Advice only: it never blocks, and any failure exits 0 with no output.
// The registered command is an sh pre-filter that starts node only when the payload holds "agent_id" (a main-session
// call carries none). Switch (environment only, no plugin setting): ORCH_TURN_WARNING=off.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentTranscript } from "./egress-guard.mjs";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";
import { maxTurnsOf, usageFromTranscript } from "./telemetry.mjs";

const OWN = /^(?:orchestration:)?(researcher|implementer|reviewer|integrator)$/;
const ID = /^[A-Za-z0-9_-]{1,80}$/;

/**
 * The warning text for a PostToolUse payload, or null (no warning). Creates the once-per-agent marker first.
 * @param {any} p
 * @returns {string | null}
 */
export function turnWarning(p) {
  const role = typeof p?.agent_type === "string" ? p.agent_type.match(OWN)?.[1] : undefined;
  if (!role || typeof p.session_id !== "string" || !ID.test(p.session_id) || typeof p.agent_id !== "string" || !ID.test(p.agent_id)) return null;
  const max = maxTurnsOf(role);
  if (!max) return null;
  const path = agentTranscript(p.transcript_path, p.agent_id);
  if (!path) return null;
  const turns = usageFromTranscript(path, role)?.turns;
  if (typeof turns !== "number" || turns * 5 < max * 4) return null;
  ensureStateDir();
  const dir = join(stateDir, "turn-warnings");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${p.session_id}_${p.agent_id}`), "", { flag: "wx" }); // throws when it already warned
  return `You have used ${turns} of your ${max} turns. Commit your work and report now; list what is unfinished under OPEN.`;
}

if (process.argv[1]?.endsWith("turn-budget.mjs")) {
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    if ((process.env.ORCH_TURN_WARNING ?? "").trim().toLowerCase() === "off") process.exit(0);
    if (duplicate("turn-budget.mjs")) process.exit(0); // the project's own copy warns
    const text = turnWarning(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
    if (text) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: text } }));
  } catch {
    // advice only: malformed input, a missing file or a marker already there means no warning
  }
  process.exit(0);
}
