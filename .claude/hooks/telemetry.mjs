#!/usr/bin/env node
// SubagentStart / SubagentStop logger: appends one JSON line per event to .claude/state/telemetry.jsonl.
// Also records the worker's STATUS (pass/fail) when its final message contains one, for review-gate.mjs.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let payload = {};
try {
  payload = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  process.exit(0);
}

const statuses = [...JSON.stringify(payload).matchAll(/STATUS:\s*(pass|fail)/gi)];
const status = statuses.length ? statuses[statuses.length - 1][1].toLowerCase() : undefined;

const clip = (v) => (typeof v === "string" && v.length > 300 ? `${v.slice(0, 300)}...` : v);
const slim = Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, typeof v === "object" ? v : clip(v)]));

const dir = join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), ".claude", "state");
mkdirSync(dir, { recursive: true });
appendFileSync(join(dir, "telemetry.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), status, ...slim })}\n`);
process.exit(0);
