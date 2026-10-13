#!/usr/bin/env node
// Appends one summary line per headless run to .claude/state/runs.jsonl.
// Usage: <claude -p --output-format json output> | node scripts/log-run.mjs "task"   (run from the target repo)
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const raw = Buffer.concat(chunks).toString("utf8");

let r = null;
try {
  r = JSON.parse(raw);
} catch {
  // not JSON: record the failure below
}

const line = {
  ts: new Date().toISOString(),
  task: (process.argv[2] ?? "").slice(0, 200),
  ok: Boolean(r) && r.is_error === false,
  cost_usd: r?.total_cost_usd ?? null,
  duration_ms: r?.duration_ms ?? null,
  turns: r?.num_turns ?? null,
  terminal_reason: r?.terminal_reason ?? "unparsed output",
  subagents: r?.subagent_stats?.by_type ?? {},
  result: typeof r?.result === "string" ? r.result.slice(0, 300) : raw.slice(0, 300),
};

const dir = join(process.cwd(), ".claude", "state");
mkdirSync(dir, { recursive: true });
appendFileSync(join(dir, "runs.jsonl"), `${JSON.stringify(line)}\n`);
