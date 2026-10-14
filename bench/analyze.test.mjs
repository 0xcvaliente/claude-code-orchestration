// node --test bench/analyze.test.mjs
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { aucOf, analyze, evaluateHypotheses, outsideGraded, processOf, tokensOf } from "./analyze.mjs";
import { renderHtml, renderMarkdown } from "./report.mjs";
import { classifyClaim } from "./lib/claims.mjs";
import { bootstrapCI, iqr, median, medianDiff, mulberry32, quantile, ratioCI } from "./lib/stats.mjs";

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "test-fixtures", "campaign");

// ---------- stats ----------

test("median and type-7 quantile", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
  assert.equal(median([1, null, 3]), 2);
  assert.equal(quantile([1, 2, 3, 4, 5], 0.25), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.25), 1.75); // R: quantile(1:4, .25, type = 7)
  assert.equal(quantile([10], 0.9), 10);
  assert.deepEqual(iqr([1, 2, 3, 4]), { q1: 1.75, q3: 3.25, width: 1.5 });
});

test("mulberry32 is deterministic and in [0, 1)", () => {
  const a = mulberry32(42);
  const b = mulberry32(42);
  const xs = Array.from({ length: 1000 }, () => a());
  assert.deepEqual(xs.slice(0, 5), Array.from({ length: 5 }, () => b()));
  assert.ok(xs.every((x) => x >= 0 && x < 1));
  assert.notEqual(mulberry32(1)(), mulberry32(2)());
});

test("bootstrap CI is deterministic for a seed and covers a known difference", () => {
  const rand = mulberry32(7);
  const a = Array.from({ length: 30 }, () => 10 + rand() * 4); // centred on 12
  const b = Array.from({ length: 30 }, () => 5 + rand() * 4); // centred on 7
  const one = bootstrapCI(a, b, medianDiff, { seed: 99, iterations: 2000 });
  const two = bootstrapCI(a, b, medianDiff, { seed: 99, iterations: 2000 });
  assert.deepEqual(one, two);
  assert.ok(one.lo <= 5 && 5 <= one.hi, `CI [${one.lo}, ${one.hi}] should cover 5`);
  assert.ok(one.lo > 0, "the difference is clearly positive");
  const other = bootstrapCI(a, b, medianDiff, { seed: 100, iterations: 2000 });
  assert.notDeepEqual(one, other);
  const paired = bootstrapCI([1, 2, 3], [0, 1, 2], medianDiff, { paired: true, iterations: 500 });
  assert.deepEqual([paired.lo, paired.hi, paired.estimate], [1, 1, 1]); // every pair differs by exactly 1
  const r = ratioCI([20, 22, 18], [10, 11, 9], { seed: 3, iterations: 1000 });
  assert.ok(r.lo <= 2 && 2 <= r.hi);
  assert.equal(bootstrapCI([], [1], medianDiff), null);
});

// ---------- claims ----------

test("claims classifier on labelled examples", () => {
  const cases = [
    ["", "none"],
    [undefined, "none"],
    ["Here is a summary of the files I looked at.", "none"],
    ["All 42 tests pass. Implementation complete.", "success"],
    ["Done. 120 passed, 0 failed.", "success"],
    ["Implemented the parser; no failures in the public suite.", "success"],
    ["STATUS: pass\nAll checks pass with zero errors.", "success"],
    ["Finished. No known issues and nothing failed.", "success"],
    ["Added error handling for bad input; all tests passing.", "success"],
    ["The run had no failing tests and no regressions; done.", "success"],
    ["I could not finish the executor; tests are failing.", "failure"],
    ["The task is incomplete: blocked on missing sqlite3.", "failure"],
    ["STATUS: fail - npm test reports 3 failed.", "failure"],
    ["Ran out of time before the tests could run.", "failure"],
    ["Implemented SELECT and WHERE. Known issues: JOIN is not yet supported.", "partial"],
    ["Done with most of it: 300/322 tests pass.", "partial"],
    ["Implemented the scheduler, but 2 tests still fail.", "partial"],
    ["Implemented a.js; b.js is not done.", "partial"],
    ["322/322 tests pass.", "success"],
  ];
  for (const [text, want] of cases) assert.equal(classifyClaim(text), want, JSON.stringify(text));
});

// ---------- pieces ----------

test("tokens sum every result doc plus triage", () => {
  const t = tokensOf(
    [
      { modelUsage: { "claude-sonnet-5-5": { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 } }, total_cost_usd: 9 },
      { modelUsage: { "claude-sonnet-5-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 }, "claude-opus-5-5": { inputTokens: 100 } } },
    ],
    [{ mode: "plain", tokens: 1000 }, { mode: "x" }],
  );
  assert.equal(t.total, 1210);
  assert.equal(t.output_total, 22);
  assert.deepEqual(t.by_model["sonnet-5-5"], { input: 11, output: 22, cache_read: 33, cache_write: 44, total: 110 });
  assert.equal(t.by_model.triage.total, 1000);
  assert.equal(t.by_model["opus-5-5"].total, 100);
  assert.ok(!JSON.stringify(t).includes("cost"));
});

test("auc treats the timeline as a step function from 0", () => {
  assert.equal(aucOf([[60, 75], [120, 100]], 600), 87.5);
  assert.equal(aucOf([], 600), 0);
  assert.equal(aucOf([[300, 100], [900, 50]], 600), 50); // points past the cap are ignored
});

test("max concurrency from Start/Stop intervals", () => {
  const ev = (e, ts, id, type = "implementer", cwd = "/r") => ({ hook_event_name: e, ts: new Date(ts * 1000).toISOString(), agent_id: id, agent_type: type, cwd });
  const p = processOf([
    ev("SubagentStart", 1, "a", "implementer", "/r/.claude/worktrees/a"),
    ev("SubagentStart", 2, "b"),
    ev("SubagentStop", 5, "a"),
    ev("SubagentStart", 5, "c"), // a stop and a start at the same time do not overlap
    ev("SubagentStart", 6, "d", "orchestration:reviewer"),
    ev("SubagentStop", 7, "d", "orchestration:reviewer"),
  ]);
  assert.equal(p.max_concurrent_subagents, 3);
  assert.equal(p.subagent_count, 4);
  assert.deepEqual(p.subagents, { implementer: 3, reviewer: 1 });
  assert.equal(p.worktrees, 1);
  assert.equal(p.reviewer_rounds, 1);
});

test("files outside graded paths", () => {
  assert.deepEqual(outsideGraded(["src/a.js", "notes.md", "src/x/y.js"], ["src/"]), ["notes.md"]);
  assert.deepEqual(outsideGraded(["src/a.js", "src/a.py", "README.md"], ["src/**/*.js"]), ["src/a.py", "README.md"]);
  assert.equal(outsideGraded(["a"], undefined), null);
});

// ---------- the fixture campaign ----------

const summary = analyze([FIXTURE], { now: "2026-10-15T00:00:00Z" });
const run = (id) => summary.runs.find((r) => r.run_id === id);
const cell = (task, arm, c = "main") => summary.cells.find((x) => x.task === task && x.arm === arm && x.cell === c);

test("fixture: counts and exclusions", () => {
  assert.equal(summary.counts.runs, 17);
  assert.equal(summary.counts.excluded, 1);
  assert.equal(summary.counts.rate_limited, 1);
  assert.deepEqual(summary.excluded.map((e) => e.run_id), ["k1-stdlib-toolkit__O-mix__main__r3"]);
  assert.equal(cell("k1-stdlib-toolkit", "O-mix").n, 2);
  assert.equal(cell("k1-stdlib-toolkit", "O-mix").rate_limited, 1);
  assert.equal(summary.cells.length, 8);
});

test("fixture: tokens across several result docs plus triage", () => {
  const r = run("t1-parallel__AUTO__main__r1");
  assert.equal(r.result_docs, 2);
  assert.equal(r.tokens.total, 70000 + 25000 + 5000);
  assert.equal(r.tokens.by_model.triage.total, 5000);
  assert.equal(r.tokens.by_model["sonnet-5-5"].total, 95000);
  assert.equal(r.tokens.output_total, 2300);
  assert.deepEqual(r.routes, ["reviewed"]);
  assert.equal(run("t1-parallel__O-mix__main__r1").tokens.total, 50000 + 200000);
});

test("fixture: score, timeline, t90/t100, auc", () => {
  const a = run("t1-parallel__P-O__main__r1");
  assert.deepEqual(a.timeline, [[60, 75], [120, 100]]);
  assert.equal(a.score_pct, 100);
  assert.equal(a.pass, true);
  assert.equal(a.t90_s, 120);
  assert.equal(a.t100_s, 120);
  assert.equal(a.auc, 87.5);
  const b = run("k1-stdlib-toolkit__O-mix__main__r1");
  assert.equal(b.t90_s, 1200);
  assert.equal(b.t100_s, 1500);
  const c = run("k1-stdlib-toolkit__P-O__main__r1");
  assert.equal(c.t90_s, null);
  assert.equal(c.t100_s, null);
  assert.equal(c.end_reason, "deadline");
  assert.equal(run("k1-stdlib-toolkit__P-O__cap60__r1").auc, 19.92);
});

test("fixture: process metrics", () => {
  const r = run("k1-stdlib-toolkit__O-mix__main__r1");
  assert.equal(r.max_concurrent_subagents, 3);
  assert.equal(r.worktrees, 3);
  assert.equal(r.reviewer_rounds, 2);
  assert.deepEqual(r.subagents, { researcher: 1, implementer: 3, reviewer: 2 });
  assert.deepEqual(r.gates, { "test:block": 1, "test:allow": 1, "review:allow": 1 });
  assert.equal(run("t1-parallel__O-mix__main__r1").max_concurrent_subagents, 2);
  assert.equal(run("t1-parallel__O-mix__main__r1").permission_denials, 1);
  assert.deepEqual(run("t1-parallel__O-mix__main__r1").outside_graded, ["notes.md"]);
  assert.deepEqual(r.outside_graded, ["README.md"]);
});

test("fixture: claims and false success", () => {
  assert.equal(run("t1-parallel__P-O__main__r2").claim, "success");
  assert.equal(run("t1-parallel__P-O__main__r2").false_success, true);
  assert.equal(run("t1-parallel__P-O__main__r1").false_success, false);
  assert.equal(run("k1-stdlib-toolkit__P-O__main__r1").claim, "partial");
  assert.equal(run("k1-stdlib-toolkit__P-O__main__r2").claim, "failure");
  assert.equal(run("k1-stdlib-toolkit__AUTO__main__r1").false_success, true); // the final doc's "STATUS: pass" counts
  assert.equal(cell("t1-parallel", "P-O").false_success, 1);
});

test("fixture: cells and comparisons", () => {
  const c = cell("t1-parallel", "P-O");
  assert.equal(c.pass_rate, 0.5);
  assert.equal(c.score_median, 95);
  assert.equal(c.direction_only, true);
  const cmp = summary.comparisons.find((x) => x.task === "t1-parallel" && x.cell === "main" && x.arm === "O-mix" && x.baseline === "P-O");
  assert.equal(cmp.paired, true);
  assert.equal(cmp.score_diff_pts.estimate, 5);
  assert.equal(cmp.tokens_ratio.estimate, 2.06);
  assert.equal(cmp.wall_diff_s.estimate, 115);
  assert.ok(cmp.score_diff_pts.ci[0] <= 5 && 5 <= cmp.score_diff_pts.ci[1]);
  assert.deepEqual(analyze([FIXTURE], { now: "x" }).comparisons, summary.comparisons); // seeded: same CIs every time
  assert.ok(!summary.comparisons.some((x) => x.baseline === "P-S")); // no P-S in the fixture
});

test("fixture: hypothesis verdicts", () => {
  const v = Object.fromEntries(summary.hypotheses.map((h) => [h.id, h.verdict]));
  assert.deepEqual(v, { H1: "inconclusive", H2: "inconclusive", H4: "supported", H5: "inconclusive", H6: "inconclusive", H7: "inconclusive" });
  const h4 = summary.hypotheses.find((h) => h.id === "H4").evidence;
  assert.deepEqual(h4, { orchestrated: { false_success: 0, n: 4, rate: 0 }, plain: { false_success: 1, n: 4, rate: 0.25 } });
});

// ---------- hypotheses on synthetic runs ----------

const mk = (task, arm, cellName, rep, score, tokens, wall, extra = {}) => ({ task, arm, cell: cellName, rep, score_pct: score, pass: score === 100, tokens: { total: tokens, output_total: 0 }, wall_s: wall, false_success: false, end_reason: "exited", t100_s: null, ...extra });
const pair = (task, arm, cellName, score, tokens, wall) => [1, 2].map((rep) => mk(task, arm, cellName, rep, score, tokens, wall));

test("hypotheses: supported and not supported on synthetic data", () => {
  const k1 = "k1-stdlib-toolkit";
  const h3 = "h3-sql-engine";
  const runs = [
    ...pair(k1, "P-O", "main", 90, 2e6, 1800),
    ...pair(k1, "O-mix", "main", 88, 3e6, 1200),
    ...pair(k1, "O-O", "main", 92, 4e6, 1000),
    ...pair(h3, "P-O", "main", 70, 2e6, 1800),
    ...pair(h3, "O-O", "main", 75, 4e6, 1500),
    ...pair(h3, "O-mix", "main", 75, 3e6, 1500),
    ...pair("t1-parallel", "P-S", "main", 100, 1e5, 60),
    ...pair("t1-parallel", "P-O", "main", 100, 1e5, 60),
    ...pair("t1-parallel", "O-mix", "main", 100, 2e5, 120),
    ...pair("t1-parallel", "O-O", "main", 100, 2e5, 120),
    ...pair("t2-single", "P-S", "main", 100, 1e5, 60),
    ...pair("t2-single", "P-O", "main", 100, 1e5, 60),
    ...pair("t2-single", "O-mix", "main", 100, 1.6e5, 120),
    ...pair("t2-single", "O-O", "main", 100, 1.6e5, 120),
  ];
  for (const t of [k1, h3]) {
    runs.push(...pair(t, "P-O", "cap10", 50, 1e6, 600), ...pair(t, "O-mix", "cap10", 40, 1e6, 600));
    runs.push(...pair(t, "P-O", "cap60", 90, 3e6, 3600), ...pair(t, "O-mix", "cap60", 99, 3e6, 3000));
    runs.push(...pair(t, "P-O", "budget1M", 60, 1e6, 900), ...pair(t, "O-mix", "budget1M", 30, 1e6, 900));
    runs.push(...pair(t, "P-O", "budget3M", 80, 3e6, 1500), ...pair(t, "O-mix", "budget3M", 70, 3e6, 1500));
  }
  runs.find((r) => r.task === "t1-parallel" && r.arm === "P-S").false_success = true;
  const v = Object.fromEntries(evaluateHypotheses(runs).map((h) => [h.id, h.verdict]));
  assert.equal(v.H1, "supported");
  assert.equal(v.H2, "supported");
  assert.equal(v.H4, "supported");
  assert.equal(v.H6, "supported");
  assert.equal(v.H7, "supported"); // k1: -10 < -2 < +9; h3: -10 < +5 < +9; P-O ahead at both budgets
  assert.equal(v.H5, "inconclusive"); // no AUTO runs

  const worse = runs.map((r) => (r.task === h3 && r.arm === "O-O" && r.cell === "main" ? { ...r, score_pct: 60 } : r));
  const w = Object.fromEntries(evaluateHypotheses(worse).map((h) => [h.id, h.verdict]));
  assert.equal(w.H6, "not supported");
  const slow = runs.map((r) => (r.task === k1 && r.arm === "O-mix" && r.cell === "main" ? { ...r, wall_s: 2000 } : r));
  assert.equal(evaluateHypotheses(slow).find((h) => h.id === "H1").verdict, "not supported");
  const cheap = runs.map((r) => (r.task === "t2-single" && r.arm === "O-mix" ? { ...r, tokens: { total: 1.2e5 } } : r));
  assert.equal(evaluateHypotheses(cheap).find((h) => h.id === "H2").verdict, "not supported");
});

test("H5 counts tasks where AUTO is within 10% of the best efficiency", () => {
  const tasks = ["t1-parallel", "t2-single", "h1-query-engine", "h2-scheduler", "k1-stdlib-toolkit", "h3-sql-engine"];
  const runs = tasks.flatMap((t, i) => [...pair(t, "P-O", "main", 100, 1e6, 100), ...pair(t, "AUTO", "main", 100, i < 4 ? 1.05e6 : 2e6, 100)]);
  assert.equal(evaluateHypotheses(runs).find((h) => h.id === "H5").verdict, "supported");
  const bad = tasks.flatMap((t) => [...pair(t, "P-O", "main", 100, 1e6, 100), ...pair(t, "AUTO", "main", 100, 2e6, 100)]);
  assert.equal(evaluateHypotheses(bad).find((h) => h.id === "H5").verdict, "not supported");
});

// ---------- report ----------

test("report renders HTML and Markdown with no dollar figures", () => {
  const html = renderHtml(summary);
  const md = renderMarkdown(summary, { sources: "runs/bench/fixture", htmlPath: "report.html" });
  assert.match(md, /^Generated by bench\/report\.mjs from runs\/bench\/fixture on 2026-10-15; do not edit by hand\.\n/);
  assert.match(html, /<svg /);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.doesNotMatch(html, /<script|https?:\/\//);
  for (const text of [html, md]) assert.doesNotMatch(text, /usd|\$[0-9]|cost/i);
  assert.match(md, /\| t1-parallel \| main \| O-mix vs P-O \|/);
});
