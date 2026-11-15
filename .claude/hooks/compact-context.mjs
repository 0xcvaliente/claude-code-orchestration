#!/usr/bin/env node
// SessionStart hook (matcher "compact"): after a compaction, puts the session's open orchestration run back in context
// (PostCompact cannot add context; SessionStart with source "compact" can). Prints
// { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext } } with the run's planned slices, their
// FILES and states (passed, failed for good, retry due, reviewing, pending; attempts) and the constraint texts, capped
// at about 1,500 characters. Over the cap the slice lines give way first (FILES dropped, then a "+N more slices"
// marker), so the constraint texts and the final reminder stay. No open run (none, closed or stale), another SessionStart source or
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
  /** @type {string[]} */
  const tail = [];
  const constraints = Object.entries(run.constraints ?? {});
  if (constraints.length) {
    tail.push("Constraints:");
    for (const [id, text] of constraints) tail.push(`${id}: ${String(text).slice(0, 200)}`);
  }
  const reminder = "Every slice still needs a passing review before the final report.";
  const full = [...lines, ...tail, reminder].join("\n");
  if (full.length <= MAX_CONTEXT) return full;
  // Over the cap: the constraints and the final reminder matter most after a compaction, so the slice lines give way
  // first. Only when the header, the "+N more slices" marker, the constraints and the reminder alone do not fit is the
  // constraints block cut, and then no slice line is shown.
  const marker = ids.length ? `\n- +${ids.length} more slices` : "";
  const minimal = `${lines[0]}${marker}`;
  const constraintsText = tail.join("\n");
  if (minimal.length + 1 + (constraintsText ? constraintsText.length + 1 : 0) + reminder.length > MAX_CONTEXT) {
    const room = MAX_CONTEXT - minimal.length - reminder.length - 2;
    return [minimal, cap(constraintsText, room), reminder].join("\n");
  }
  const end = constraintsText ? `${constraintsText}\n${reminder}` : reminder;
  return `${fitSlices(lines, MAX_CONTEXT - end.length - 1)}\n${end}`;
}

/**
 * The header and slice lines within `max` characters: whole when they fit, else with each slice line's FILES list
 * dropped, else as many slice lines as fit and a "+N more slices" marker. @param {string[]} lines header first
 * @param {number} max
 */
function fitSlices(lines, max) {
  const full = lines.join("\n");
  if (full.length <= max) return full;
  const [head = "", ...slices] = lines.map((l, i) => (i ? l.replace(/ FILES: .*$/, "") : l));
  const out = [head];
  let len = head.length;
  const marker = `- +${slices.length} more slices`.length + 1; // room for the longest marker
  for (const [i, line] of slices.entries()) {
    if (len + 1 + line.length + (i < slices.length - 1 ? marker : 0) > max) {
      out.push(`- +${slices.length - i} more slices`);
      return cap(out.join("\n"), max);
    }
    out.push(line);
    len += 1 + line.length;
  }
  return out.join("\n");
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
