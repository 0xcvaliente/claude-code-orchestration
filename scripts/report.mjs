#!/usr/bin/env node
// Renders a repo's logs (runs, agent events, triage and gate decisions) as a local HTML report.html.
// Usage: node scripts/report.mjs [repo]   (repo defaults to the current directory). Nothing is published.
// Each log is read from the first dir that has it: <repo>/.claude/state, then the per-user dirs the plugin hooks log
// to for that repo (.claude/hooks/state.mjs). A headless run with the plugin's agents splits them: runs.jsonl and
// auto.sh's routes.jsonl in the repo, telemetry.jsonl and gates.jsonl in the per-user dir. report.html goes in the
// first dir with telemetry or runs, else routes or gates, so a plugin install's report stays out of the repo too; the
// page holds no hook payloads. With no logs anywhere it writes an empty report where this repo's writers would log.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stateDirFor, userStateDirs } from "../.claude/hooks/state.mjs";
import { TOKENS_PER_USD, formatTokens } from "./tokens.mjs";

const repo = resolve(process.argv[2] ?? process.cwd());
const candidates = [join(repo, ".claude", "state"), ...userStateDirs(repo)];
/** @param {string[]} names */
const has = (names) => (/** @type {string} */ d) => names.some((n) => existsSync(join(d, n)));
const dir =
  candidates.find(has(["telemetry.jsonl", "runs.jsonl"])) ??
  candidates.find(has(["routes.jsonl", "gates.jsonl"])) ??
  stateDirFor(repo).dir;

const sources = new Map(); // dir -> the logs read from it
/** @param {string} name @returns {any[]} */
const read = (name) => {
  const from = candidates.find(has([name]));
  if (!from) return [];
  (sources.get(from) ?? sources.set(from, []).get(from)).push(name);
  return readFileSync(join(from, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
};

/** @param {unknown} v */
const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => /** @type {string} */ (/** @type {Record<string, string>} */ ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]));
const runs = read("runs.jsonl");
const events = read("telemetry.jsonl");
const routes = read("routes.jsonl");
const gates = read("gates.jsonl");
const reads = read("reads.jsonl");
/** @param {string[]} heads @param {unknown[][]} rows */
const table = (heads, rows) =>
  `<table><thead><tr>${heads.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;

/** @type {Map<string, any[]>} */
const bySession = new Map();
for (const e of events) {
  const k = e.session_id ?? "unknown";
  /** @type {any[]} */ (bySession.get(k) ?? bySession.set(k, []).get(k)).push(e);
}

// Tokens of a run; a legacy row (cost_usd, no tokens) shows "≈" + an estimate from its list-price cost.
let estimated = false;
/** @param {any} r */
const tokenCell = (r) => {
  if (typeof r.tokens === "number") return formatTokens(r.tokens);
  if (typeof r.cost_usd !== "number") return "n/a";
  estimated = true;
  return `≈${formatTokens(Math.round(r.cost_usd * TOKENS_PER_USD))}`;
};
const runRows = runs
  .map((r) => `<tr><td>${esc(r.ts)}</td><td>${esc(r.task)}</td><td>${r.ok ? "ok" : "failed"}</td><td>${esc(tokenCell(r))}</td><td>${esc(r.turns ?? "n/a")}</td><td>${esc(Object.entries(r.subagents).map(([k, v]) => `${k}:${v}`).join(" "))}</td></tr>`)
  .join("");

const sessions = [...bySession.entries()]
  .map(([id, evs]) => {
    const rows = evs
      .map((e) => `<tr><td>${esc(e.ts)}</td><td>${esc(e.hook_event_name)}</td><td>${esc(e.agent_type ?? "")}</td><td>${esc(e.status ?? "")}</td></tr>`)
      .join("");
    return `<h3>Session ${esc(id)}</h3><table><thead><tr><th>Time</th><th>Event</th><th>Agent</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
  })
  .join("");

// Telemetry v2 per role, from SubagentStop records (telemetry.mjs). Older records lack tokens, turns, models and
// max_turns_hit: they count as agents only, and "With usage" says how many stops the sums cover.
/** @param {unknown} t */
const bareType = (t) => String(t ?? "").split(":").pop() || "unknown";
/** @type {Map<string, { agents: number, withUsage: number, input: number, output: number, cache_read: number, cache_write: number, turns: number, models: Set<string>, maxHits: number, maxKnown: number }>} */
const roles = new Map();
for (const e of events) {
  if (e.hook_event_name !== "SubagentStop") continue;
  const role = bareType(e.agent_type);
  let r = roles.get(role);
  if (!r) roles.set(role, (r = { agents: 0, withUsage: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, turns: 0, models: new Set(), maxHits: 0, maxKnown: 0 }));
  r.agents++;
  const t = e.tokens && typeof e.tokens === "object" ? e.tokens : null;
  if (t) {
    r.withUsage++;
    for (const k of /** @type {const} */ (["input", "output", "cache_read", "cache_write"])) r[k] += typeof t[k] === "number" ? t[k] : 0;
  }
  if (typeof e.turns === "number") r.turns += e.turns;
  if (Array.isArray(e.models)) for (const m of e.models) if (typeof m === "string") r.models.add(m);
  if (typeof e.max_turns_hit === "boolean") {
    r.maxKnown++;
    if (e.max_turns_hit) r.maxHits++;
  }
}
const roleRows = [...roles].map(([role, r]) => [role, r.agents, r.withUsage, formatTokens(r.input), formatTokens(r.output), formatTokens(r.cache_read), formatTokens(r.cache_write), r.turns, [...r.models].join(", ") || "n/a", r.maxKnown ? `${r.maxHits} of ${r.maxKnown}` : "n/a"]);
const roleTable = roleRows.length ? table(["Role", "Agents", "With usage", "Input", "Output", "Cache read", "Cache write", "Turns", "Models", "Max-turn hits"], roleRows) : "<p>No agent stops logged yet.</p>";

// Reads by kind and role (reads.jsonl from read-log.mjs; a WebFetch counts as kind "web", a main-thread read as "main").
/** @type {Map<string, Map<string, number>>} */
const readCounts = new Map();
/** @type {Set<string>} */
const readRoles = new Set();
for (const r of reads) {
  const kind = r.tool === "WebFetch" ? "web" : typeof r.kind === "string" ? r.kind : "other";
  const role = r.agent_type ? bareType(r.agent_type) : "main";
  readRoles.add(role);
  let m = readCounts.get(kind);
  if (!m) readCounts.set(kind, (m = new Map()));
  m.set(role, (m.get(role) ?? 0) + 1);
}
const roleList = [...readRoles].sort();
const readTable = reads.length
  ? table(["Kind", ...roleList, "Total"], [...readCounts].map(([kind, m]) => [kind, ...roleList.map((r) => m.get(r) ?? 0), [...m.values()].reduce((a, b) => a + b, 0)]))
  : "<p>No reads logged yet.</p>";

// Where each log came from: "<dir> (runs.jsonl, routes.jsonl); <dir> (telemetry.jsonl, gates.jsonl)".
const state = sources.size ? [...sources].map(([d, names]) => `<code>${esc(d)}</code> (${names.join(", ")})`).join("; ") : `<code>${esc(dir)}</code>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orchestration report</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}th,td{border-bottom:1px solid #8884;padding:.4rem .6rem;text-align:left;font-size:13px}th{font-weight:600}</style></head>
<body><h1>Orchestration report</h1><p>${esc(repo)}</p><p>State: ${state}</p>
<h2>Headless runs</h2>${runs.length ? `<table><thead><tr><th>Time</th><th>Task</th><th>Result</th><th>Tokens</th><th>Turns</th><th>Subagents</th></tr></thead><tbody>${runRows}</tbody></table>${estimated ? "<p>≈ marks runs logged before token tracking, estimated from their list-price cost at about 1M tokens per dollar.</p>" : ""}` : "<p>No runs logged yet. Use <code>npm run native</code>.</p>"}
<h2>Agents by role</h2>${roleTable}
<h2>Reads by kind and role</h2>${readTable}
<h2>Agent events</h2>${sessions || "<p>No agent events yet. Run the orchestrator once.</p>"}
<h2>Triage decisions</h2>${routes.length ? table(["Time", "Task", "Mode", "Source", "Reason"], routes.map((r) => [r.ts, r.task, r.mode, r.source, r.reason])) : "<p>No triage decisions yet. Use <code>/route</code> or <code>npm run auto</code>.</p>"}
<h2>Gate decisions</h2>${gates.length ? table(["Time", "Gate", "Decision", "Reason", "Agent or session"], gates.map((g) => [g.ts, g.gate, g.decision, g.reason, g.agent_type || g.session_id])) : "<p>No gate decisions yet.</p>"}</body></html>`;

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "report.html"), html);
console.log(`wrote ${join(dir, "report.html")} (${runs.length} runs, ${events.length} events, ${routes.length} routes, ${gates.length} gates)`);
for (const [d, names] of sources) if (d !== dir) console.log(`also read ${names.join(", ")} from ${d}`);
