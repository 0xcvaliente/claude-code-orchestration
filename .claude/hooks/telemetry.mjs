#!/usr/bin/env node
// SubagentStart / SubagentStop logger: appends one JSON line per event to telemetry.jsonl in the state dir
// (state.mjs: .claude/state for the project copy, a per-user dir for the plugin copy).
// Also records the worker's STATUS (pass/fail) from its final report, for review-gate.mjs. SubagentStart records
// (ts, session_id, agent_id, agent_type) tell run.mjs and review-gate.mjs which agents are still running.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseStatus } from "./brief.mjs";
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
// brief.mjs parseStatus: any STATUS: fail line fails, else the first STATUS line decides; blockquoted lines and the
// format template "STATUS: pass or fail" do not count. No status line is undefined (the field is left out).
/** @param {unknown} text */
const statusOf = (text) => parseStatus(text) ?? undefined;

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

/**
 * Telemetry v2 from the subagent transcript: token usage, turns, models and whether the agent stopped at maxTurns.
 * Claude Code writes one transcript line per content block, each carrying the whole message's usage, so usage is
 * summed once per message id. "<synthetic>" messages (harness-made, no API call) are skipped.
 * max_turns_hit (seen in 2.1.316 transcripts): a maxTurns stop ends the transcript on the tool_result of the last
 * turn's tool call, with no assistant message after it. A normal finish ends on an assistant message with
 * stop_reason end_turn, or on the tool_result of a tool that ends the turn (SubagentHandback, toolEndsTurn: true).
 * Anything else (no messages, a user text message last, a max_tokens stop) is null: it cannot tell.
 * Only numbers and model names are returned, never message text.
 * @param {string} path
 */
function usageFromTranscript(path) {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    /** @type {Set<string>} */
    const ids = new Set();
    /** @type {Set<string>} */
    const models = new Set();
    /** @type {any} */
    let lastMsg = null; // the last user or assistant entry
    /** @type {any} */
    let lastAssistant = null;
    let n = 0;
    for (const l of lines) {
      let e;
      try {
        e = JSON.parse(l);
      } catch {
        continue;
      }
      if (e?.type !== "assistant" && e?.type !== "user") continue;
      lastMsg = e;
      if (e.type !== "assistant") continue;
      const m = e.message;
      if (!m || typeof m !== "object" || m.model === "<synthetic>") continue;
      lastAssistant = e;
      const id = typeof m.id === "string" && m.id ? m.id : `#${n++}`;
      if (ids.has(id)) continue;
      ids.add(id);
      if (typeof m.model === "string" && m.model) models.add(m.model);
      const u = m.usage && typeof m.usage === "object" ? m.usage : {};
      /** @param {unknown} v */
      const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
      tokens.input += num(u.input_tokens);
      tokens.output += num(u.output_tokens);
      tokens.cache_read += num(u.cache_read_input_tokens);
      tokens.cache_write += num(u.cache_creation_input_tokens);
    }
    /** @type {boolean | null} */
    let maxTurnsHit = null;
    const stop = lastAssistant?.message?.stop_reason;
    const content = lastMsg?.message?.content;
    const isToolResult = Array.isArray(content) && content.length > 0 && content.every((b) => b?.type === "tool_result");
    if (lastMsg && lastMsg === lastAssistant && (stop === "end_turn" || stop === "stop_sequence")) maxTurnsHit = false;
    else if (lastMsg?.type === "user" && isToolResult) maxTurnsHit = lastMsg.toolEndsTurn === true ? false : stop === "tool_use" ? true : null;
    return { tokens, turns: ids.size, models: [...models], max_turns_hit: maxTurnsHit };
  } catch {
    return undefined; // missing or unreadable transcript: the fields are left out
  }
}

/** @param {unknown} v */
const clip =(v) => (typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}...` : v);
const slim = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, typeof v === "object" ? v : clip(v)]));

const usage = payload.hook_event_name === "SubagentStop" && typeof payload.agent_transcript_path === "string" ? usageFromTranscript(payload.agent_transcript_path) : undefined;

try {
  ensureStateDir();
  appendFileSync(join(stateDir, "telemetry.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), status, ...slim, ...usage })}\n`);
} catch {
  // the log must never fail the agent
}
process.exit(0);
