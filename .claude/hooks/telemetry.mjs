#!/usr/bin/env node
// SubagentStart / SubagentStop logger: appends one JSON line per event to telemetry.jsonl in the state dir
// (state.mjs: .claude/state for the project copy, a per-user dir for the plugin copy).
// Also records the worker's STATUS (pass/fail) from its final report, for review-gate.mjs.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
if (duplicate("telemetry.mjs")) process.exit(0); // the project's own copy logs this event
/** @type {any} */
let payload = {};
try {
  payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  process.exit(0);
}

// Status comes only from the worker's final report, never from the whole payload (it may echo the brief).
// Line-anchored; the format template "STATUS: pass or fail" does not match.
/** @param {unknown} text */
function statusOf(text) {
  if (typeof text !== "string") return undefined;
  const found = [...text.matchAll(/^[ \t>*_`-]*STATUS:\**[ \t]*(pass|fail)\b(?![ \t]+or\b)/gim)];
  return found.length ? /** @type {string} */ (/** @type {RegExpMatchArray} */ (found[found.length - 1])[1]).toLowerCase() : undefined;
}

// Final report from the subagent transcript: the last assistant text block or SubagentHandback message.
/** @param {string} path */
function reportFromTranscript(path) {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(/** @type {string} */ (lines[i]));
      } catch {
        continue;
      }
      const content = entry?.type === "assistant" ? entry.message?.content : undefined;
      if (!Array.isArray(content)) continue;
      for (let j = content.length - 1; j >= 0; j--) {
        const b = content[j];
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) return b.text;
        if (b?.type === "tool_use" && b.name === "SubagentHandback" && typeof b.input?.message === "string") return b.input.message;
      }
    }
  } catch {
    // unreadable transcript means no status
  }
  return undefined;
}

let status;
if (payload.hook_event_name === "SubagentStop") {
  // A reviewer may write a preamble and then call SubagentHandback, so fall back to the transcript whenever the last message has no status.
  const last = payload.last_assistant_message;
  status = typeof last === "string" ? statusOf(last) : undefined;
  if (status === undefined && typeof payload.agent_transcript_path === "string") status = statusOf(reportFromTranscript(payload.agent_transcript_path));
}

/** @param {unknown} v */
const clip = (v) => (typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}...` : v);
const slim = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, typeof v === "object" ? v : clip(v)]));

ensureStateDir();
appendFileSync(join(stateDir, "telemetry.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), status, ...slim })}\n`);
process.exit(0);
