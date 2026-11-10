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
 * maxTurns of a role from its agent file's frontmatter: the project's .claude/agents/<role>.md, then the plugin
 * root's agents/<role>.md. null when neither has a maxTurns line.
 * @param {string} role bare agent type
 * @returns {number | null}
 */
function maxTurnsOf(role) {
  if (!/^[A-Za-z0-9_-]+$/.test(role)) return null;
  const dirs = [join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), ".claude", "agents"), process.env.CLAUDE_PLUGIN_ROOT ? join(process.env.CLAUDE_PLUGIN_ROOT, "agents") : ""];
  for (const d of dirs) {
    if (!d) continue;
    try {
      const front = readFileSync(join(d, `${role}.md`), "utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? "";
      const n = Number(front.match(/^maxTurns:\s*(\d+)\s*$/m)?.[1]);
      if (Number.isInteger(n) && n > 0) return n;
    } catch {
      // no agent file here
    }
  }
  return null;
}

const REWRITE_MIN = 20000; // a cache write this large after the first request, with little read, is a context paid for again

/**
 * Telemetry v2 from the subagent transcript: token usage, turns, models and whether the agent stopped at maxTurns.
 * Claude Code writes one transcript line per content block, each carrying the message's usage, so each usage field
 * is the maximum over the lines of one message id (a partial usage on an early line cannot undercount), then summed
 * over messages. "<synthetic>" messages (harness-made, no API call) are skipped.
 * max_turns_hit (seen in 2.1.316 transcripts): a maxTurns stop ends the transcript on the tool_result of the last
 * turn's tool call, with no assistant message after it. A killed agent can end the same way, so when the role's
 * maxTurns is known (maxTurnsOf) such an ending counts as a hit only when turns >= maxTurns, and is null below it;
 * without a known maxTurns the ending alone decides. A normal finish ends on an assistant message with stop_reason
 * end_turn, or on the tool_result of a tool that ends the turn (SubagentHandback, toolEndsTurn: true). Anything else
 * (no messages, a user text message last, a max_tokens stop) is null: it cannot tell.
 * 1.2.0 adds two cost fields. tokens.cache_write_1h: the part of cache_write written at the one-hour lifetime
 * (usage.cache_creation.ephemeral_1h_input_tokens), which the API bills at 2x input instead of 1.25x.
 * cache_rewrites: requests after the agent's first that wrote at least REWRITE_MIN tokens to the cache while reading
 * less than a quarter of that from it, with their cache_write tokens summed. That is the mark of a cache that went
 * cold in mid-run (a pause longer than its lifetime, a compaction): the context is paid for again at the write rate.
 * Only numbers and model names are returned, never message text.
 * @param {string} path
 * @param {string} role bare agent type
 */
function usageFromTranscript(path, role) {
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    /** @type {Map<string, { input: number, output: number, cache_read: number, cache_write: number, cache_write_1h: number }>} */
    const perMessage = new Map();
    /** @type {Set<string>} */
    const models = new Set();
    /** @type {any} */
    let lastMsg = null; // the last user or assistant entry
    /** @type {any} */
    let lastAssistant = null;
    let n = 0;
    /** @param {unknown} v */
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
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
      if (typeof m.model === "string" && m.model) models.add(m.model);
      const u = m.usage && typeof m.usage === "object" ? m.usage : {};
      const prev = perMessage.get(id) ?? { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 };
      perMessage.set(id, {
        input: Math.max(prev.input, num(u.input_tokens)),
        output: Math.max(prev.output, num(u.output_tokens)),
        cache_read: Math.max(prev.cache_read, num(u.cache_read_input_tokens)),
        cache_write: Math.max(prev.cache_write, num(u.cache_creation_input_tokens)),
        cache_write_1h: Math.max(prev.cache_write_1h, num(u.cache_creation?.ephemeral_1h_input_tokens)),
      });
    }
    const tokens = { input: 0, output: 0, cache_read: 0, cache_write: 0, cache_write_1h: 0 };
    for (const t of perMessage.values()) for (const k of /** @type {const} */ (["input", "output", "cache_read", "cache_write", "cache_write_1h"])) tokens[k] += t[k];
    // A Map keeps insertion order, so this is the order of the requests.
    const cacheRewrites = { requests: 0, tokens: 0 };
    [...perMessage.values()].forEach((t, i) => {
      if (i === 0 || t.cache_write < REWRITE_MIN || t.cache_read >= t.cache_write / 4) return;
      cacheRewrites.requests++;
      cacheRewrites.tokens += t.cache_write;
    });
    const turns = perMessage.size;
    /** @type {boolean | null} */
    let maxTurnsHit = null;
    const stop = lastAssistant?.message?.stop_reason;
    const content = lastMsg?.message?.content;
    const isToolResult = Array.isArray(content) && content.length > 0 && content.every((b) => b?.type === "tool_result");
    if (lastMsg && lastMsg === lastAssistant && (stop === "end_turn" || stop === "stop_sequence")) maxTurnsHit = false;
    else if (lastMsg?.type === "user" && isToolResult) {
      if (lastMsg.toolEndsTurn === true) maxTurnsHit = false;
      else if (stop === "tool_use") {
        const limit = maxTurnsOf(role);
        maxTurnsHit = limit === null ? true : turns >= limit ? true : null;
      }
    }
    return { tokens, turns, models: [...models], max_turns_hit: maxTurnsHit, cache_rewrites: cacheRewrites };
  } catch {
    return undefined; // missing or unreadable transcript: the fields are left out
  }
}

/** @param {unknown} v */
const clip =(v) => (typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}...` : v);
const slim = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, typeof v === "object" ? v : clip(v)]));

const usage = payload.hook_event_name === "SubagentStop" && typeof payload.agent_transcript_path === "string" ? usageFromTranscript(payload.agent_transcript_path, String(payload.agent_type ?? "").split(":").pop() ?? "") : undefined;

try {
  ensureStateDir();
  appendFileSync(join(stateDir, "telemetry.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), status, ...slim, ...usage })}\n`);
} catch {
  // the log must never fail the agent
}
process.exit(0);
