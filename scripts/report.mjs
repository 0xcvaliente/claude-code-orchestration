#!/usr/bin/env node
// Renders a repo's logs (runs, agent events, triage and gate decisions) as a local HTML report.html.
// Usage: node scripts/report.mjs [repo]   (repo defaults to the current directory). Nothing is published.
// Each log is read from the first dir that has it: <repo>/.claude/state, then the per-user dirs the plugin hooks log
// to for that repo (.claude/hooks/state.mjs). A headless run with the plugin's agents splits them: runs.jsonl and
// auto.sh's routes.jsonl in the repo, telemetry.jsonl and gates.jsonl in the per-user dir. report.html goes in the
// first dir with telemetry or runs, else routes or gates, so a plugin install's report stays out of the repo too; the
// page holds no hook payloads. With no logs anywhere it writes an empty report where this repo's writers would log.
// The Skills section (skills.jsonl, journal.jsonl, skill-create.jsonl, skill-gate.jsonl) appears only when those logs
// name a skill, so the report of a run without skills is the one it was before.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stateDirFor, userStateDirs } from "../.claude/hooks/state.mjs";
import { PRICES_AS_OF, costOf, formatUsd } from "./prices.mjs";
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
/**
 * A log read like `read`, but listed under "State:" only once `note` is called, so logs that every run writes
 * (journal.jsonl) do not change the page of a run that has no skill data.
 * @param {string} name @returns {{ rows: any[], note: () => void }}
 */
const readQuiet = (name) => {
  const from = candidates.find(has([name]));
  if (!from) return { rows: [], note: () => {} };
  const rows = readFileSync(join(from, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  return { rows, note: () => void (sources.get(from) ?? sources.set(from, []).get(from)).push(name) };
};
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
  .map((r) => `<tr><td>${esc(r.ts)}</td><td>${esc(r.task)}</td><td>${r.ok ? "ok" : "failed"}</td><td>${esc(tokenCell(r))}</td><td>${esc(r.turns ?? "n/a")}</td><td>${esc(Object.entries(r.subagents ?? {}).map(([k, v]) => `${k}:${v}`).join(" "))}</td></tr>`)
  .join("");

const sessions = [...bySession.entries()]
  .map(([id, evs]) => {
    const rows = evs
      .map((e) => `<tr><td>${esc(e.ts)}</td><td>${esc(e.hook_event_name)}</td><td>${esc(e.agent_type ?? "")}</td><td>${esc(e.status ?? "")}</td></tr>`)
      .join("");
    return `<h3>Session ${esc(id)}</h3><table><thead><tr><th>Time</th><th>Event</th><th>Agent</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
  })
  .join("");

// One stop record per agent: its last. An agent stops more than once (the test gate sends an implementer back, a
// SendMessage resume, the stop before and after a hand-back), and telemetry.mjs reads the whole transcript at every
// stop, so each record carries the agent's running total. Summing every record counted such an agent's tokens two or
// three times: in the logs of 2026-11-01 to 11-03 implementer cache reads came out 72% to 76% too high. A record
// without an agent id (older logs) cannot be joined to another, so it counts on its own.
/** @type {Map<string, any>} */
const lastStops = new Map();
let anonymous = 0;
for (const e of events) {
  if (e.hook_event_name !== "SubagentStop") continue;
  const id = typeof e.agent_id === "string" && e.agent_id ? `${e.session_id ?? ""}\n${e.agent_id}` : `\n#${anonymous++}`;
  lastStops.delete(id); // re-insert, so the map keeps the order of each agent's last stop
  lastStops.set(id, e);
}
const finalStops = [...lastStops.values()];

// Telemetry v2 per role, from each agent's last SubagentStop record (telemetry.mjs). Older records lack tokens, turns,
// models and max_turns_hit: they count as agents only, and "With usage" says how many agents the sums cover.
/** @param {unknown} t */
const bareType = (t) => String(t ?? "").split(":").pop() || "unknown";
/** @type {Map<string, { agents: number, withUsage: number, input: number, output: number, cache_read: number, cache_write: number, turns: number, models: Set<string>, maxHits: number, maxKnown: number }>} */
const roles = new Map();
for (const e of finalStops) {
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

// Estimated cost by role and model (1.2.0), from each agent's last stop record at list prices (scripts/prices.mjs). An
// agent is priced only when it used exactly one model with a listed price; the rest are counted as unpriced. "Cache rewrites"
// are requests after an agent's first that wrote most of their context to the cache again (telemetry.mjs
// cache_rewrites): a cache that went cold in mid-run, paid for at the write rate.
/** @type {Map<string, { role: string, model: string, agents: number, cost: number, output: number, cache_read: number, cache_write: number, rewrites: number, rewriteTokens: number }>} */
const costs = new Map();
let unpriced = 0;
for (const e of finalStops) {
  if (!e.tokens || typeof e.tokens !== "object") continue;
  const model = Array.isArray(e.models) && e.models.length === 1 ? e.models[0] : null;
  const cost = costOf(e.tokens, model);
  if (cost === null) {
    unpriced++;
    continue;
  }
  const role = bareType(e.agent_type);
  const key = `${role}\n${model}`;
  let c = costs.get(key);
  if (!c) costs.set(key, (c = { role, model, agents: 0, cost: 0, output: 0, cache_read: 0, cache_write: 0, rewrites: 0, rewriteTokens: 0 }));
  c.agents++;
  c.cost += cost;
  for (const k of /** @type {const} */ (["output", "cache_read", "cache_write"])) c[k] += typeof e.tokens[k] === "number" ? e.tokens[k] : 0;
  if (e.cache_rewrites && typeof e.cache_rewrites === "object") {
    c.rewrites += typeof e.cache_rewrites.requests === "number" ? e.cache_rewrites.requests : 0;
    c.rewriteTokens += typeof e.cache_rewrites.tokens === "number" ? e.cache_rewrites.tokens : 0;
  }
}
const costRows = [...costs.values()]
  .sort((a, b) => b.cost - a.cost)
  .map((c) => [c.role, c.model, c.agents, formatUsd(c.cost), formatUsd(c.cost / c.agents), formatTokens(c.output), formatTokens(c.cache_read), formatTokens(c.cache_write), c.rewrites ? `${c.rewrites} (${formatTokens(c.rewriteTokens)})` : "0"]);
const costTotal = [...costs.values()].reduce((a, c) => a + c.cost, 0);
const unpricedNote = unpriced ? ` ${unpriced} agent${unpriced === 1 ? "" : "s"} not priced (several models in one run, or a model without a listed price).` : "";
const costTable = costRows.length
  ? `${table(["Role", "Model", "Agents", "Est. cost", "Per agent", "Output", "Cache read", "Cache write", "Cache rewrites"], costRows)}<p>Total ${esc(formatUsd(costTotal))} at list prices as of ${PRICES_AS_OF}: an estimate for comparing roles and models, not a bill (a subscription is not billed per token).${unpricedNote}</p>`
  : `<p>No priced agents yet: the estimate needs a stop record with tokens and one model that has a listed price.${unpricedNote}</p>`;

// Agents that started and logged no stop (1.2.0). A subagent that runs out of turns or is killed fires no SubagentStop,
// so this is where a turn-limit stop shows; an agent still running when the report is written is listed too.
/** @type {Map<string, { role: string, start: boolean, stop: boolean }>} */
const lifecycles = new Map();
for (const e of events) {
  if (typeof e.agent_id !== "string" || !e.agent_id || (e.hook_event_name !== "SubagentStart" && e.hook_event_name !== "SubagentStop")) continue;
  const a = lifecycles.get(e.agent_id) ?? { role: bareType(e.agent_type), start: false, stop: false };
  if (e.hook_event_name === "SubagentStart") a.start = true;
  else a.stop = true;
  lifecycles.set(e.agent_id, a);
}
/** @type {Map<string, number>} */
const noStop = new Map();
for (const a of lifecycles.values()) if (a.start && !a.stop) noStop.set(a.role, (noStop.get(a.role) ?? 0) + 1);
const noStopLine = noStop.size ? `<p>Started and never stopped (turn limit, killed, or still running): ${esc([...noStop].map(([role, count]) => `${role} ${count}`).join(", "))}.</p>` : "";

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

// Skills: per skill how often the plan check suggested it (skills.jsonl, decision "hint"), and how often a worker said
// it used or skipped it (journal.jsonl stop records, skills_used and skills_skipped from the SKILLS-USED and
// SKILLS-SKIPPED reply lines); the drafts skill slices created (skill-create.jsonl, decision "allow", the last per
// session and skill) with the skill gate's last result for each (skill-gate.jsonl); and "worth revising": a skill
// skipped three or more times, or used in a slice whose latest review failed.
const skillLogs = { hints: readQuiet("skills.jsonl"), journal: readQuiet("journal.jsonl"), create: readQuiet("skill-create.jsonl"), gate: readQuiet("skill-gate.jsonl") };
/** @param {unknown} v @returns {string[]} */
const names = (v) => (Array.isArray(v) ? v.filter((n) => typeof n === "string" && n.length > 0 && n.length <= 100) : []);
/** @type {Map<string, { suggested: number, used: number, skipped: number }>} */
const skillCounts = new Map();
/** @param {string} n */
const countOf = (n) => skillCounts.get(n) ?? skillCounts.set(n, { suggested: 0, used: 0, skipped: 0 }).get(n) ?? { suggested: 0, used: 0, skipped: 0 };
for (const r of skillLogs.hints.rows) if (r?.decision === "hint") for (const n of names(r.names)) countOf(n).suggested++;
/** @param {any} r */
const sliceKey = (r) => `${r?.session_id ?? ""}\n${r?.run ?? ""}\n${r?.slice ?? ""}`;
/** @type {Map<string, string | null>} the latest review status of each slice */
const lastReview = new Map();
/** @type {{ skill: string, key: string, slice: string }[]} */
const usedIn = [];
for (const r of skillLogs.journal.rows) {
  if (!r || typeof r !== "object") continue;
  if (String(r.role ?? r.agent_type ?? "").split(":").pop() === "reviewer" && r.slice) lastReview.set(sliceKey(r), typeof r.status === "string" ? r.status : null);
  for (const n of names(r.skills_used)) {
    countOf(n).used++;
    if (r.slice) usedIn.push({ skill: n, key: sliceKey(r), slice: String(r.slice) });
  }
  for (const n of names(r.skills_skipped)) countOf(n).skipped++;
}
/** @type {Map<string, any>} the last allow per session and skill */
const drafts = new Map();
for (const r of skillLogs.create.rows) if (r?.decision === "allow" && typeof r.skill === "string") drafts.set(`${r.session_id ?? ""}\n${r.skill}`, r);
/** @type {Map<string, any>} the last gate record per session and skill */
const gateLast = new Map();
for (const r of skillLogs.gate.rows) if (typeof r?.skill === "string") gateLast.set(`${r.session_id ?? ""}\n${r.skill}`, r);
/** @param {any} g */
const gateText = (g) => {
  if (!g) return "not run";
  const failed = names(g.failed).join(", ");
  if (g.decision === "allow" && g.reason === "ok") return "passed";
  if (g.reason === "skill_gate_gave_up") return `gave up after its blocks${failed ? ` (${failed})` : ""}`;
  return `${g.decision === "block" ? "blocked" : String(g.decision ?? "?")}${failed ? ` (${failed})` : ""}`;
};
/** @type {Map<string, string[]>} */
const revise = new Map();
for (const [n, c] of skillCounts) if (c.skipped >= 3) revise.set(n, [`skipped ${c.skipped} times`]);
for (const u of usedIn) {
  if (lastReview.get(u.key) !== "fail") continue;
  const why = `used in slice ${u.slice}, whose review failed`;
  const list = revise.get(u.skill) ?? revise.set(u.skill, []).get(u.skill) ?? [];
  if (!list.includes(why)) list.push(why);
}
const skillsSection = (() => {
  if (!skillCounts.size && !drafts.size) return "";
  for (const l of Object.values(skillLogs)) if (l.rows.length) l.note();
  const countTable = skillCounts.size
    ? table(["Skill", "Suggested", "Used", "Skipped"], [...skillCounts].sort(([a], [b]) => a.localeCompare(b)).map(([n, c]) => [n, c.suggested, c.used, c.skipped]))
    : "";
  const draftTable = drafts.size
    ? `<h3>Drafts created</h3>${table(["Time", "Skill", "Target", "Branch", "Slice", "Skill gate"], [...drafts].map(([k, r]) => [r.ts, r.skill, r.target ?? "private", r.branch ?? `skill/${r.skill}`, r.slice ?? "", gateText(gateLast.get(k))]))}`
    : "";
  const reviseList = revise.size ? `<h3>Worth revising</h3><ul>${[...revise].map(([n, why]) => `<li><code>${esc(n)}</code>: ${esc(why.join("; "))}</li>`).join("")}</ul>` : "";
  return `\n<h2>Skills</h2>${countTable}${draftTable}${reviseList}`;
})();

// Where each log came from: "<dir> (runs.jsonl, routes.jsonl); <dir> (telemetry.jsonl, gates.jsonl)".
const state = sources.size ? [...sources].map(([d, names]) => `<code>${esc(d)}</code> (${names.join(", ")})`).join("; ") : `<code>${esc(dir)}</code>`;

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orchestration report</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}th,td{border-bottom:1px solid #8884;padding:.4rem .6rem;text-align:left;font-size:13px}th{font-weight:600}</style></head>
<body><h1>Orchestration report</h1><p>${esc(repo)}</p><p>State: ${state}</p>
<h2>Headless runs</h2>${runs.length ? `<table><thead><tr><th>Time</th><th>Task</th><th>Result</th><th>Tokens</th><th>Turns</th><th>Subagents</th></tr></thead><tbody>${runRows}</tbody></table>${estimated ? "<p>≈ marks runs logged before token tracking, estimated from their list-price cost at about 1M tokens per dollar.</p>" : ""}` : "<p>No runs logged yet. Use <code>npm run native</code>.</p>"}
<h2>Agents by role</h2>${roleTable}${noStopLine}
<h2>Estimated cost by role and model</h2>${costTable}
<h2>Reads by kind and role</h2>${readTable}${skillsSection}
<h2>Agent events</h2>${sessions || "<p>No agent events yet. Run the orchestrator once.</p>"}
<h2>Triage decisions</h2>${routes.length ? table(["Time", "Task", "Mode", "Source", "Reason"], routes.map((r) => [r.ts, r.task, r.mode, r.source, r.reason])) : "<p>No triage decisions yet. Use <code>/route</code> or <code>npm run auto</code>.</p>"}
<h2>Gate decisions</h2>${gates.length ? table(["Time", "Gate", "Decision", "Reason", "Agent or session"], gates.map((g) => [g.ts, g.gate, g.decision, g.reason, g.agent_type || g.session_id])) : "<p>No gate decisions yet.</p>"}</body></html>`;

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "report.html"), html);
console.log(`wrote ${join(dir, "report.html")} (${runs.length} runs, ${events.length} events, ${routes.length} routes, ${gates.length} gates)`);
for (const [d, names] of sources) if (d !== dir) console.log(`also read ${names.join(", ")} from ${d}`);
