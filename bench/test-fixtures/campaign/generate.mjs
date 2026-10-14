#!/usr/bin/env node
// Writes the synthetic campaign used by bench/analyze.test.mjs into this folder (deterministic; rerun after edits):
//   node bench/test-fixtures/campaign/generate.mjs
// 2 tasks (t1-parallel, k1-stdlib-toolkit) x 3 arms (P-O, O-mix, AUTO) x 2 reps in the main cell, a cap60 sweep cell
// on k1 for P-O and O-mix, and one rate-limited run that the analysis must exclude.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = dirname(fileURLToPath(import.meta.url));
const T0 = Date.parse("2026-10-14T08:00:00Z");
const iso = (s) => new Date(T0 + s * 1000).toISOString();
const OPUS = "claude-opus-5-5";
const SONNET = "claude-sonnet-5-5";
const HAIKU = "claude-haiku-4-5";
const mu = (input, output, cacheRead, cacheWrite) => ({ inputTokens: input, outputTokens: output, cacheReadInputTokens: cacheRead, cacheCreationInputTokens: cacheWrite });
const doc = (result, modelUsage, extra = {}) => ({ type: "result", result, is_error: false, num_turns: 10, duration_ms: 1000, modelUsage, permission_denials: [], ...extra });

// Each spec: run identity, wall seconds, end reason, result docs, routes, grades [[snap, secs, passed]], telemetry, gates, diff.
const runs = [];
const add = (s) => runs.push(s);
const impl = (id, start, stop, wt) => [
  { hook_event_name: "SubagentStart", ts: iso(start), agent_type: "implementer", agent_id: id, cwd: wt ? `/tmp/r/.claude/worktrees/${id}` : "/tmp/r" },
  { hook_event_name: "SubagentStop", ts: iso(stop), agent_type: "implementer", agent_id: id, cwd: wt ? `/tmp/r/.claude/worktrees/${id}` : "/tmp/r", status: "pass" },
];
const rev = (id, start, stop) => [
  { hook_event_name: "SubagentStart", ts: iso(start), agent_type: "orchestration:reviewer", agent_id: id, cwd: "/tmp/r" },
  { hook_event_name: "SubagentStop", ts: iso(stop), agent_type: "orchestration:reviewer", agent_id: id, cwd: "/tmp/r", status: "pass" },
];
const res = (id, start, stop) => [
  { hook_event_name: "SubagentStart", ts: iso(start), agent_type: "researcher", agent_id: id, cwd: "/tmp/r" },
  { hook_event_name: "SubagentStop", ts: iso(stop), agent_type: "researcher", agent_id: id, cwd: "/tmp/r" },
];
const orchGates = [
  { gate: "test", decision: "block", reason: "tests_failed" },
  { gate: "test", decision: "allow", reason: "tests_passed" },
  { gate: "review", decision: "allow", reason: "reviewed" },
];

// ---- t1-parallel: 20 tests, 10 min cap ----
const t1 = { task: "t1-parallel", cell: "main", cap_min: 10 };
add({ ...t1, arm: "P-O", rep: 1, wall: 120, end: "exited", docs: [doc("All tests pass.", { [OPUS]: mu(1000, 2000, 100000, 10000) })], grades: [["t0060", 60, 15], ["final", 120, 20]], total: 20 });
add({ ...t1, arm: "P-O", rep: 2, wall: 150, end: "exited", docs: [doc("Done. All 20 tests pass.", { [OPUS]: mu(1200, 2500, 120000, 12000) })], grades: [["t0060", 60, 12], ["final", 150, 18]], total: 20 });
add({
  ...t1, arm: "O-mix", rep: 1, wall: 240, end: "exited",
  docs: [doc("STATUS: pass\nImplemented both modules; 20/20 tests pass.", { [OPUS]: mu(2000, 5000, 40000, 3000), [SONNET]: mu(3000, 7000, 180000, 10000) }, { permission_denials: [{ tool_name: "Bash" }] })],
  grades: [["t0060", 60, 0], ["final", 240, 20]], total: 20,
  telemetry: [...impl("a1", 10, 100, true), ...impl("a2", 11, 110, true), ...rev("r1", 120, 150)], gates: orchGates, diff: ["src/a.js", "src/b.js", "notes.md"],
});
add({
  ...t1, arm: "O-mix", rep: 2, wall: 260, end: "exited",
  docs: [doc("Implemented everything. All tests passing, 0 failed.", { [OPUS]: mu(2100, 5200, 42000, 3100), [SONNET]: mu(3100, 7100, 190000, 10500) })],
  grades: [["t0060", 60, 5], ["final", 260, 20]], total: 20,
  telemetry: [...impl("b1", 10, 120, true), ...impl("b2", 12, 125, true), ...rev("r2", 130, 170)], gates: orchGates, diff: ["src/a.js"],
});
add({
  ...t1, arm: "AUTO", rep: 1, wall: 200, end: "exited",
  docs: [
    doc("Implemented a.js; b.js is not done.", { [SONNET]: mu(500, 1500, 60000, 8000) }),
    doc("STATUS: pass\nReviewed: all tests pass.", { [SONNET]: mu(200, 800, 20000, 4000) }),
  ],
  routes: [{ mode: "reviewed", tokens: 5000 }], grades: [["t0060", 60, 10], ["final", 200, 20]], total: 20,
});
add({
  ...t1, arm: "AUTO", rep: 2, wall: 90, end: "exited",
  docs: [doc("Done; all tests pass.", { [SONNET]: mu(400, 1200, 50000, 6000) })],
  routes: [{ mode: "plain", tokens: 4000 }], grades: [["t0060", 60, 20], ["final", 90, 20]], total: 20,
});

// ---- k1-stdlib-toolkit: 100 tests, 30 min cap ----
const k1 = { task: "k1-stdlib-toolkit", cap_min: 30 };
add({ ...k1, cell: "main", arm: "P-O", rep: 1, wall: 1800, end: "deadline", docs: [doc("Implemented most modules; known issues: 20 tests fail.", { [OPUS]: mu(5000, 40000, 2000000, 100000) })], grades: [["t0060", 60, 10], ["t0600", 600, 50], ["t1200", 1200, 80], ["final", 1800, 80]], total: 100 });
add({ ...k1, cell: "main", arm: "P-O", rep: 2, wall: 1800, end: "deadline", docs: [doc("I ran out of time; the tests are failing.", { [OPUS]: mu(5200, 42000, 2100000, 110000) })], grades: [["t0060", 60, 5], ["t0600", 600, 60], ["t1200", 1200, 85], ["final", 1800, 85]], total: 100 });
add({
  ...k1, cell: "main", arm: "O-mix", rep: 1, wall: 1500, end: "exited",
  docs: [doc("All modules complete; 100/100 tests pass.", { [OPUS]: mu(8000, 30000, 600000, 50000), [SONNET]: mu(9000, 60000, 2500000, 150000), [HAIKU]: mu(1000, 3000, 50000, 5000) })],
  grades: [["t0060", 60, 0], ["t0600", 600, 40], ["t1200", 1200, 95], ["final", 1500, 100]], total: 100,
  telemetry: [...res("q1", 5, 30), ...impl("c1", 40, 900, true), ...impl("c2", 41, 1000, true), ...impl("c3", 42, 950, true), ...rev("r3", 1010, 1100), ...rev("r4", 1110, 1200)], gates: orchGates,
  diff: ["src/list.js", "src/str.js", "README.md"],
});
add({
  ...k1, cell: "main", arm: "O-mix", rep: 2, wall: 1600, end: "exited",
  docs: [doc("Implemented all modules. Known gaps: two date edge cases still fail.", { [OPUS]: mu(8200, 31000, 620000, 52000), [SONNET]: mu(9100, 61000, 2600000, 155000) })],
  grades: [["t0060", 60, 0], ["t0600", 600, 35], ["t1200", 1200, 90], ["final", 1600, 95]], total: 100,
  telemetry: [...impl("d1", 40, 1000, true), ...impl("d2", 41, 1100, true), ...rev("r5", 1110, 1300)], gates: orchGates, diff: ["src/date.js"],
});
add({ ...k1, cell: "main", arm: "O-mix", rep: 3, wall: 30, end: "rate_limited", error: "usage limit reached", docs: [], grades: [], total: 100 });
add({ ...k1, cell: "main", arm: "AUTO", rep: 1, wall: 1700, end: "exited", docs: [doc("Done.", { [SONNET]: mu(4000, 30000, 1500000, 80000) }), doc("STATUS: pass", { [OPUS]: mu(6000, 20000, 500000, 40000) })], routes: [{ mode: "orchestrate", tokens: 6000 }], grades: [["t0060", 60, 0], ["t1200", 1200, 70], ["final", 1700, 90]], total: 100 });
add({ ...k1, cell: "main", arm: "AUTO", rep: 2, wall: 1800, end: "deadline", docs: [doc("Partially implemented: the parser works but JSON is not yet supported.", { [SONNET]: mu(4100, 31000, 1600000, 82000) })], routes: [{ mode: "plain", tokens: 5500 }], grades: [["t0060", 60, 0], ["t1200", 1200, 60], ["final", 1800, 70]], total: 100 });

// ---- k1 cap60 sweep (P-O and O-mix) ----
add({ ...k1, cell: "cap60", cap_min: 60, arm: "P-O", rep: 1, wall: 3000, end: "exited", docs: [doc("All tests pass.", { [OPUS]: mu(9000, 70000, 3500000, 150000) })], grades: [["t0060", 60, 5], ["final", 3000, 95]], total: 100 });
add({ ...k1, cell: "cap60", cap_min: 60, arm: "P-O", rep: 2, wall: 3300, end: "exited", docs: [doc("Done, with 10 tests failing.", { [OPUS]: mu(9500, 72000, 3600000, 160000) })], grades: [["t0060", 60, 5], ["final", 3300, 90]], total: 100 });
add({ ...k1, cell: "cap60", cap_min: 60, arm: "O-mix", rep: 1, wall: 1550, end: "exited", docs: [doc("Complete.", { [OPUS]: mu(8000, 30000, 600000, 50000), [SONNET]: mu(9000, 60000, 2500000, 150000) })], grades: [["t0060", 60, 0], ["final", 1550, 100]], total: 100 });
add({ ...k1, cell: "cap60", cap_min: 60, arm: "O-mix", rep: 2, wall: 1650, end: "exited", docs: [doc("Complete.", { [OPUS]: mu(8100, 30500, 610000, 51000), [SONNET]: mu(9050, 60500, 2550000, 151000) })], grades: [["t0060", 60, 0], ["final", 1650, 100]], total: 100 });

// ---- write ----
for (const s of runs) rmSync(join(DIR, runId(s)), { recursive: true, force: true });
function runId(s) {
  return `${s.task}__${s.arm}__${s.cell}__r${s.rep}`;
}
const rows = [];
const grades = [];
for (const s of runs) {
  const id = runId(s);
  rows.push({
    run_id: id, task: s.task, arm: s.arm, cell: s.cell, rep: s.rep, cap_min: s.cap_min, budget_tokens: null,
    started_at: iso(0), ended_at: iso(s.wall), wall_ms: s.wall * 1000, exit_code: s.end === "exited" ? 0 : 1, end_reason: s.end,
    results: s.docs, routes: s.routes ?? [], dir: `/tmp/bench/${id}`, ...(s.error ? { error: s.error } : {}),
  });
  for (const [snap, secs, passed] of s.grades) {
    grades.push({ run_id: id, snap, secs, pass: passed === s.total, passed, total: s.total, by_cat: {}, suites: {}, flags: [] });
  }
  const state = join(DIR, id, "state");
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, "telemetry.jsonl"), (s.telemetry ?? []).map((e) => `${JSON.stringify(e)}\n`).join(""));
  writeFileSync(join(state, "gates.jsonl"), (s.gates ?? []).map((g, i) => `${JSON.stringify({ ts: iso(100 + i), ...g })}\n`).join(""));
  writeFileSync(join(DIR, id, "diff-files.txt"), (s.diff ?? []).map((p) => `${p}\n`).join(""));
}
const lines = (xs) => xs.map((x) => `${JSON.stringify(x)}\n`).join("");
writeFileSync(join(DIR, "runs.jsonl"), lines(rows));
writeFileSync(join(DIR, "grades.jsonl"), lines(grades));
writeFileSync(
  join(DIR, "manifest.json"),
  `${JSON.stringify({ campaign: "fixture", matrix: "fixture", git_sha: "0000000", claude_version: "9.9.9 (fixture)", plugin_version: "0.1.5", node_version: "v24.0.0", python_version: "3.13.0", sqlite_version: "3.50.0", started_at: iso(0) }, null, 2)}\n`,
);
for (const [task, graded] of [["t1-parallel", ["src/"]], ["k1-stdlib-toolkit", ["src/**/*.js"]]]) {
  mkdirSync(join(DIR, "tasks", task), { recursive: true });
  writeFileSync(join(DIR, "tasks", task, "meta.json"), `${JSON.stringify({ tier: task.startsWith("t") ? "small" : "large", graded_paths: graded, cap_min: task.startsWith("t") ? 10 : 30 }, null, 2)}\n`);
}
console.log(`wrote ${rows.length} runs, ${grades.length} grade rows to ${DIR}`);
