#!/usr/bin/env node
// Renders .claude/state/telemetry.jsonl and runs.jsonl as a local HTML report (.claude/state/report.html).
// Usage: node scripts/report.mjs [repo]   (repo defaults to the current directory). Nothing is published.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(process.argv[2] ?? process.cwd());
const dir = join(repo, ".claude", "state");

const read = (name) =>
  existsSync(join(dir, name))
    ? readFileSync(join(dir, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .flatMap((l) => {
          try {
            return [JSON.parse(l)];
          } catch {
            return [];
          }
        })
    : [];

const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const runs = read("runs.jsonl");
const events = read("telemetry.jsonl");

const bySession = new Map();
for (const e of events) {
  const k = e.session_id ?? "unknown";
  (bySession.get(k) ?? bySession.set(k, []).get(k)).push(e);
}

const runRows = runs
  .map((r) => `<tr><td>${esc(r.ts)}</td><td>${esc(r.task)}</td><td>${r.ok ? "ok" : "failed"}</td><td>${esc(r.cost_usd?.toFixed?.(4) ?? "n/a")}</td><td>${esc(r.turns ?? "n/a")}</td><td>${esc(Object.entries(r.subagents).map(([k, v]) => `${k}:${v}`).join(" "))}</td></tr>`)
  .join("");

const sessions = [...bySession.entries()]
  .map(([id, evs]) => {
    const rows = evs
      .map((e) => `<tr><td>${esc(e.ts)}</td><td>${esc(e.hook_event_name)}</td><td>${esc(e.agent_type ?? "")}</td><td>${esc(e.status ?? "")}</td></tr>`)
      .join("");
    return `<h3>Session ${esc(id)}</h3><table><thead><tr><th>Time</th><th>Event</th><th>Agent</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;
  })
  .join("");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orchestration report</title>
<style>:root{color-scheme:light dark}body{font:15px/1.5 system-ui,sans-serif;max-width:960px;margin:2rem auto;padding:0 1rem}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}th,td{border-bottom:1px solid #8884;padding:.4rem .6rem;text-align:left;font-size:13px}th{font-weight:600}</style></head>
<body><h1>Orchestration report</h1><p>${esc(repo)}</p>
<h2>Headless runs</h2>${runs.length ? `<table><thead><tr><th>Time</th><th>Task</th><th>Result</th><th>Cost USD</th><th>Turns</th><th>Subagents</th></tr></thead><tbody>${runRows}</tbody></table>` : "<p>No runs logged yet. Use <code>npm run native</code>.</p>"}
<h2>Agent events</h2>${sessions || "<p>No agent events yet. Run the orchestrator once.</p>"}</body></html>`;

mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "report.html"), html);
console.log(`wrote ${join(dir, "report.html")} (${runs.length} runs, ${events.length} events)`);
