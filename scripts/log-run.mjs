#!/usr/bin/env node
// Appends one summary line per headless run to .claude/state/runs.jsonl.
// tokens = input + output + cache read + cache write over every model (null when the output is unparsed); usage = that breakdown.
// turns and duration_ms are the whole run's: orch_totals from scripts/run-result.mjs (turns summed over every result of the
// session, wall time measured by orchestrate.sh). A document without orch_totals gives its own num_turns and duration_ms.
// Usage: <the document scripts/orchestrate.sh prints> | node scripts/log-run.mjs "task"   (run from the target repo)
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { totalTokens, usageOf } from "./tokens.mjs";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const raw = Buffer.concat(chunks).toString("utf8");

let r = null;
try {
  r = JSON.parse(raw);
} catch {
  // not JSON: record the failure below
}

/** @param {unknown} v */
const count = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const totals = r?.orch_totals;

const line = {
  ts: new Date().toISOString(),
  task: (process.argv[2] ?? "").slice(0, 200),
  ok: Boolean(r) && r.is_error === false,
  tokens: r ? totalTokens(r) : null,
  usage: r ? usageOf(r) : null,
  duration_ms: count(totals?.wall_ms) ?? r?.duration_ms ?? null,
  turns: count(totals?.turns) ?? r?.num_turns ?? null,
  terminal_reason: r?.terminal_reason ?? "unparsed output",
  subagents: r?.subagent_stats?.by_type ?? {},
  result: typeof r?.result === "string" ? r.result.slice(0, 300) : raw.slice(0, 300),
};

const dir = join(process.cwd(), ".claude", "state");
mkdirSync(dir, { recursive: true });
appendFileSync(join(dir, "runs.jsonl"), `${JSON.stringify(line)}\n`);
