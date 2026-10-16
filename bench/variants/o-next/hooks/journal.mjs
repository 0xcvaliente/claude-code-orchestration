#!/usr/bin/env node
// Run journal (O-next variant): one line per finished implementer or reviewer in journal.jsonl in the state dir,
// keyed by the SLICE line of the worker's brief (a brief starting with PLAN REVIEW is slice "plan"), with the STATUS
// from its final report. An orchestrator asked to resume reads it and skips slices whose last review passed;
// plan-check.mjs reads it to see that the plan review finished.
// Headless runs pass --no-session-persistence, so there is no subagent transcript to read the brief from. The slice
// is therefore taken at launch instead, from two events of this hook:
//   PostToolUse on Agent: tool_input.prompt (the brief) and tool_response.agentId -> journal-launches.jsonl
//   SubagentStop: agent_id and last_assistant_message -> journal.jsonl, slice looked up by agent_id
// A background agent's PostToolUse comes first; a foreground agent stops before its PostToolUse, so an unmatched
// stop waits in journal-pending.jsonl and is written when its launch arrives. With a transcript (interactive
// sessions) the brief is read from it as before. Exits 0 on malformed input.
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ensureStateDir, stateDir } from "./state.mjs";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let p;
try {
  p = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  process.exit(0);
}
if (!p || typeof p !== "object") process.exit(0);

const ROLES = ["implementer", "reviewer"];
const bare = (t) => String(t ?? "").split(":").pop();
const readLog = (name) =>
  existsSync(join(stateDir, name))
    ? readFileSync(join(stateDir, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];
const append = (name, entry) => {
  try {
    ensureStateDir();
    appendFileSync(join(stateDir, name), `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  } catch {
    // the journal must never fail the agent
  }
};
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n")
      : "";
const sliceOf = (brief) =>
  /^\s*PLAN REVIEW\b/.test(brief) ? "plan" : brief.match(/^[ \t>*_`-]*SLICE:\**[ \t]*([^\s`'"*]+)/im)?.[1];
// Same rule as telemetry.mjs: line-anchored, the last STATUS line wins, the template "pass or fail" does not count.
const statusOf = (text) => {
  const found = [...String(text ?? "").matchAll(/^[ \t>*_`-]*STATUS:\**[ \t]*(pass|fail)\b(?![ \t]+or\b)/gim)];
  return found.length ? found[found.length - 1][1].toLowerCase() : undefined;
};
// A foreground result may carry the agent id only in its text ("agentId: a1b2...").
const agentIdOf = (r) =>
  (r && typeof r === "object" && typeof r.agentId === "string" && r.agentId) ||
  JSON.stringify(r ?? "").match(/agentId["\\: ]+([A-Za-z0-9_-]{6,})/)?.[1];

if (p.hook_event_name === "PostToolUse") {
  const role = bare(p.tool_input?.subagent_type);
  const slice = typeof p.tool_input?.prompt === "string" ? sliceOf(p.tool_input.prompt) : undefined;
  const agentId = agentIdOf(p.tool_response);
  if (!ROLES.includes(role) || !slice || !agentId) process.exit(0);
  append("journal-launches.jsonl", { session_id: p.session_id, agent_id: agentId, slice, role });
  const waiting = readLog("journal-pending.jsonl").filter((e) => e.agent_id === agentId);
  if (waiting.length) {
    const w = waiting[waiting.length - 1];
    append("journal.jsonl", { session_id: p.session_id, slice, role, status: w.status, agent_id: agentId });
  }
  process.exit(0);
}

if (p.hook_event_name !== "SubagentStop" || !ROLES.includes(bare(p.agent_type))) process.exit(0);
const role = bare(p.agent_type);

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
const launch = readLog("journal-launches.jsonl").filter((e) => e.agent_id === p.agent_id).pop();
const slice = launch?.slice ?? sliceOf(textOf(entries.find((e) => e.type === "user")?.message?.content));

let status = statusOf(p.last_assistant_message);
for (let i = entries.length - 1; status === undefined && i >= 0; i--) {
  if (entries[i].type === "assistant") status = statusOf(textOf(entries[i].message?.content));
}

if (slice) append("journal.jsonl", { session_id: p.session_id, slice, role, status, agent_id: p.agent_id });
else append("journal-pending.jsonl", { session_id: p.session_id, role, status, agent_id: p.agent_id });
process.exit(0);
