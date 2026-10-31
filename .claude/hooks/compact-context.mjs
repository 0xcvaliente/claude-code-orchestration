#!/usr/bin/env node
// SessionStart hook (matcher "compact"): after a compaction, puts the session's open orchestration run back in context
// (PostCompact cannot add context; SessionStart with source "compact" can). Prints
// { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } } with the run's planned slices, their
// FILES and states (passed, failed for good, retry due, reviewing, pending; attempts) and the constraint texts, capped
// at about 1,500 characters. No open run (none, closed or stale), another SessionStart source or
// malformed input: exit 0 with no output. Read-only: it writes nothing.
import { readFileSync } from "node:fs";
import { currentReviews } from "./brief.mjs";
import { sessionRuns } from "./run.mjs";
import { duplicate } from "./state.mjs";

export const MAX_CONTEXT = 1500;

/** @param {any} s slice state from foldRuns */
function sliceState(s) {
  if (s.passed) return "passed";
  if (s.gaveUp) return "failed for good";
  const n = s.attempts || s.launches;
  if (!n) return "pending";
  const latest = currentReviews(s).at(-1);
  const tries = `${n} attempt${n === 1 ? "" : "s"}`;
  return latest?.status === "fail" ? `review failed, retry due (${tries})` : `building or reviewing (${tries})`;
}

/** @param {string} text @param {number} max */
const cap = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 16).trimEnd()}\n[... truncated]`);

/**
 * The context text for an open run, or null when there is none.
 * @param {any} run an open Run from foldRuns @returns {string}
 */
export function runContext(run) {
  const ids = run.kind === "planned" && run.planned.length ? run.planned : Object.keys(run.slices);
  const lines = [`Orchestration run ${run.id} is still open in this session (${run.kind}${run.planReviewed ? ", plan reviewed" : ""}). Slices:`];
  for (const id of ids) {
    const s = run.slices[id];
    if (!s) {
      lines.push(`- ${id}: pending`);
      continue;
    }
    const files = s.files.length ? ` FILES: ${s.files.slice(0, 8).join(", ")}${s.files.length > 8 ? ", ..." : ""}` : "";
    lines.push(`- ${id}: ${sliceState(s)}${s.risky ? ", RISKY" : ""}${files}`);
  }
  const constraints = Object.entries(run.constraints ?? {});
  if (constraints.length) {
    lines.push("Constraints:");
    for (const [id, text] of constraints) lines.push(`${id}: ${String(text).slice(0, 200)}`);
  }
  lines.push("Every slice still needs a passing review before the final report.");
  return cap(lines.join("\n"), MAX_CONTEXT);
}

if (process.argv[1]?.endsWith("compact-context.mjs")) {
  if (duplicate("compact-context.mjs")) process.exit(0);
  try {
    const input = JSON.parse(readFileSync(0, "utf8"));
    if (typeof input?.session_id !== "string" || !input.session_id) process.exit(0);
    if (input.source !== undefined && input.source !== "compact") process.exit(0);
    const { open } = sessionRuns(input.session_id);
    if (!open) process.exit(0);
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: runContext(open) } })}\n`);
  } catch {
    // malformed input or an unreadable log: no context, no error
  }
  process.exit(0);
}
