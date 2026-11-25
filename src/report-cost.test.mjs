// 1.2.0: the report's cost estimate (scripts/prices.mjs) and its line for agents that started and never stopped.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CACHE_WRITE_1H, CACHE_WRITE_5M, PRICES, costOf, formatUsd, priceOf } from "../scripts/prices.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("prices: a model id is read through provider prefixes, [1m], date and version suffixes; unknown models have no price", () => {
  const opus = PRICES["claude-opus-5-5"];
  assert.ok(opus);
  for (const id of ["claude-opus-5-5", "Claude-Opus-5-5", "claude-opus-5-5[1m]", "us.anthropic.claude-opus-5-5", "anthropic.claude-opus-5-5-v1:0", "claude-opus-5-5-20261001"]) assert.equal(priceOf(id), opus, id);
  for (const id of ["opus", "claude-sonnet-x", "", null, undefined, 5, "__proto__", "constructor"]) assert.equal(priceOf(id), null, String(id));
});

test("prices: the cache-read price is per model, and a cache write costs 1.25x input for five minutes, 2x for an hour", () => {
  assert.deepEqual([CACHE_WRITE_5M, CACHE_WRITE_1H], [1.25, 2]);
  // Fable 5.2, Opus 5.5 and Sonnet 5.5 from the bundled claude-api reference (cached 2026-11-03).
  assert.deepEqual(PRICES["claude-fable-5-2"], { input: 8, output: 40, cacheRead: 0.2 });
  assert.deepEqual(PRICES["claude-opus-5-5"], { input: 4, output: 20, cacheRead: 0.2 });
  assert.deepEqual(PRICES["claude-sonnet-5-5"], { input: 2, output: 10, cacheRead: 0.1 });
  const M = 1_000_000;
  // 1M input, 0.1M output, 10M read, 1M written of which 0.2M for an hour, on Sonnet 5.5: 2 + 1 + 1 + 2 + 0.8.
  assert.equal(Number(costOf({ input: M, output: 0.1 * M, cache_read: 10 * M, cache_write: M, cache_write_1h: 0.2 * M }, "claude-sonnet-5-5")?.toFixed(6)), 6.8);
  // A record from before 1.2.0 (no cache_write_1h) prices every write at the five-minute rate.
  assert.equal(Number(costOf({ input: 0, output: 0, cache_read: 0, cache_write: M }, "claude-opus-5-5")?.toFixed(6)), 5);
  // The one-hour part never exceeds the writes; negative and non-numeric fields count as zero.
  assert.equal(Number(costOf({ cache_write: M, cache_write_1h: 5 * M }, "claude-opus-5-5")?.toFixed(6)), 8);
  assert.equal(costOf({ input: -5, output: "x" }, "claude-opus-5-5"), 0);
  assert.equal(costOf({ input: M }, "claude-sonnet-x"), null);
  assert.equal(costOf(null, "claude-opus-5-5"), null);
  assert.deepEqual([formatUsd(0.0042), formatUsd(1.234), formatUsd(1234.5)], ["$0.004", "$1.23", "$1,235"]);
});

test("report: cost by role and model at list prices, cache rewrites, unpriced stops and agents that never stopped", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-report-cost-"));
  try {
    const state = join(dir, ".claude", "state");
    mkdirSync(state, { recursive: true });
    const M = 1_000_000;
    const stop = (/** @type {string} */ id, /** @type {string} */ type, /** @type {object} */ rest) => ({ ts: "t", session_id: "s1", hook_event_name: "SubagentStop", agent_id: id, agent_type: type, ...rest });
    const start = (/** @type {string} */ id, /** @type {string} */ type) => ({ ts: "t", session_id: "s1", hook_event_name: "SubagentStart", agent_id: id, agent_type: type });
    const tel = [
      start("i1", "orchestration:implementer"),
      stop("i1", "orchestration:implementer", { tokens: { input: M, output: 0.1 * M, cache_read: 10 * M, cache_write: M, cache_write_1h: 0.2 * M }, models: ["claude-sonnet-5-5"], cache_rewrites: { requests: 2, tokens: 300000 } }),
      start("r1", "reviewer"),
      stop("r1", "reviewer", { tokens: { input: 0, output: 50000, cache_read: 5 * M, cache_write: 400000 }, models: ["claude-opus-5-5"] }),
      // Two models in one run, and a model without a listed price: counted, not priced.
      stop("r2", "reviewer", { tokens: { input: 1, output: 1, cache_read: 1, cache_write: 1 }, models: ["claude-opus-5-5", "claude-sonnet-5-5"] }),
      stop("r3", "reviewer", { tokens: { input: 1, output: 1, cache_read: 1, cache_write: 1 }, models: ["claude-sonnet-x"] }),
      // Started and never stopped: the turn limit, a kill, or still running.
      start("i2", "implementer"),
      start("q1", "orchestration:researcher"),
      start("q2", "researcher"),
    ];
    writeFileSync(join(state, "telemetry.jsonl"), tel.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = spawnSync("node", [join(root, "scripts", "report.mjs"), dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(join(state, "report.html"), "utf8");
    assert.match(html, /<h2>Estimated cost by role and model<\/h2>/);
    // The costlier row first: implementer on Sonnet 5.5 at $6.80, then the reviewer on Opus 5.5 at 1 + 1 + 2 = $4.00.
    assert.match(html, /<td>implementer<\/td><td>claude-sonnet-5-5<\/td><td>1<\/td><td>\$6\.80<\/td><td>\$6\.80<\/td>.*<td>2 \(300k\)<\/td>.*<td>reviewer<\/td><td>claude-opus-5-5<\/td><td>1<\/td><td>\$4\.00<\/td><td>\$4\.00<\/td>/s);
    assert.match(html, /Total \$10\.80 at list prices as of \d{4}-\d{2}-\d{2}.*not a bill.*2 agents not priced/);
    assert.match(html, /Started and never stopped \(turn limit, killed, or still running\): implementer 1, researcher 2\./);
    assert.match(html, /<h2>Agents by role<\/h2>/, "the role table stays");

    // No priced stop and nothing left open: the section says so and the line is absent.
    writeFileSync(join(state, "telemetry.jsonl"), `${JSON.stringify(stop("r3", "reviewer", { status: "pass" }))}\n`);
    assert.equal(spawnSync("node", [join(root, "scripts", "report.mjs"), dir], { encoding: "utf8" }).status, 0);
    const bare = readFileSync(join(state, "report.html"), "utf8");
    assert.match(bare, /No priced agents yet/);
    assert.doesNotMatch(bare, /Started and never stopped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report: a continued stop record (G-8, one review recorded twice) counts its skills once; a resume counts again", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-report-continues-"));
  try {
    const state = join(dir, ".claude", "state");
    mkdirSync(state, { recursive: true });
    /** @param {string} id @param {string[]} used @param {object} [rest] */
    const stop = (id, used, rest = {}) => ({ ts: "t", session_id: "s1", agent_id: id, role: "reviewer", slice: "a", run: 1, status: "pass", answers: {}, open: [], skills_used: used, ...rest });
    const rows = [
      stop("r1", ["tdd"]),
      stop("r1", ["tdd", "code-review"], { continues: true }), // the stop after the hand-back: replaces the first
      stop("r2", ["tdd"]),
      stop("r2", ["tdd"]), // a SendMessage resume: another review
    ];
    writeFileSync(join(state, "journal.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    // report.html goes where telemetry is.
    writeFileSync(join(state, "telemetry.jsonl"), `${JSON.stringify({ ts: "t", session_id: "s1", hook_event_name: "SubagentStop", agent_id: "r1", agent_type: "reviewer" })}\n`);
    const r = spawnSync("node", [join(root, "scripts", "report.mjs"), dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(join(state, "report.html"), "utf8");
    assert.match(html, /<td>tdd<\/td><td>0<\/td><td>3<\/td><td>0<\/td>/);
    assert.match(html, /<td>code-review<\/td><td>0<\/td><td>1<\/td><td>0<\/td>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** @param {string} dir @returns {string} the report's HTML */
const renderReport = (dir) => {
  const r = spawnSync("node", [join(root, "scripts", "report.mjs"), dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(join(dir, ".claude", "state", "report.html"), "utf8");
};
/** @param {string} id @param {string} type @param {string} ts @param {object} [rest] */
const tStart = (id, type, ts, rest = {}) => ({ ts, session_id: "s1", hook_event_name: "SubagentStart", agent_id: id, agent_type: type, ...rest });
/** @param {string} id @param {string} type @param {string} ts @param {object} [rest] */
const tStop = (id, type, ts, rest = {}) => ({ ts, session_id: "s1", hook_event_name: "SubagentStop", agent_id: id, agent_type: type, ...rest });
const at = (/** @type {number} */ s) => new Date(Date.UTC(2026, 10, 20, 10, 0, 0) + s * 1000).toISOString();
/** @param {string} html */
const reviewTime = (html) => html.slice(html.indexOf("<h2>Review time</h2>"), html.indexOf("<h2>Reads by kind and role</h2>"));

test("report review time: wall time per agent from its first start to its last stop, median, longest and total per role and model", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-report-wall-"));
  try {
    const state = join(dir, ".claude", "state");
    mkdirSync(state, { recursive: true });
    const opus = { models: ["claude-opus-5-5"] };
    const tel = [
      // One reviewer, one start and one stop: 4 min 12 s.
      tStart("r1", "orchestration:reviewer", at(0)),
      tStop("r1", "orchestration:reviewer", at(252), opus),
      // Two more opus reviewers: 60 s and 600 s, so the median of three is 4 min 12 s and the longest 10 min 0 s.
      tStart("r2", "reviewer", at(0)),
      tStop("r2", "reviewer", at(60), opus),
      tStart("r3", "reviewer", at(10)),
      tStop("r3", "reviewer", at(610), opus),
      // An implementer that stops three times: first start to last stop, 30 min 5 s.
      tStart("i1", "implementer", at(0)),
      tStop("i1", "implementer", at(300), { models: ["claude-opus-5-5"] }),
      tStop("i1", "implementer", at(900), { models: ["claude-opus-5-5"] }),
      tStop("i1", "implementer", at(1805), { models: ["claude-opus-5-5"] }),
      // A sonnet reviewer: its own row.
      tStart("r4", "reviewer", at(0)),
      tStop("r4", "reviewer", at(42), { models: ["claude-sonnet-5-5"] }),
      // A stop with no start and a start with no stop: left out and noted.
      tStop("x1", "reviewer", at(50), opus),
      tStart("x2", "researcher", at(50)),
    ];
    writeFileSync(join(state, "telemetry.jsonl"), tel.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const html = renderReport(dir);
    const sec = reviewTime(html);
    assert.ok(html.indexOf("<h2>Estimated cost by role and model</h2>") < html.indexOf("<h2>Review time</h2>"), "after the cost section");
    assert.match(sec, /<th>Role<\/th><th>Model<\/th><th>Agents<\/th><th>Median<\/th><th>Longest<\/th><th>Total<\/th>/);
    assert.match(sec, /<td>implementer<\/td><td>claude-opus-5-5<\/td><td>1<\/td><td>30 min 5 s<\/td><td>30 min 5 s<\/td><td>30 min 5 s<\/td>/);
    // 252 + 60 + 600 = 912 s total.
    assert.match(sec, /<td>reviewer<\/td><td>claude-opus-5-5<\/td><td>3<\/td><td>4 min 12 s<\/td><td>10 min 0 s<\/td><td>15 min 12 s<\/td>/);
    assert.match(sec, /<td>reviewer<\/td><td>claude-sonnet-5-5<\/td><td>1<\/td><td>42 s<\/td><td>42 s<\/td><td>42 s<\/td>/);
    assert.match(sec, /2 agents without a start or stop record/);
    // No journal: one line, and the page still renders.
    assert.match(sec, /No journal yet \(<code>journal\.jsonl<\/code>\), so reviews per slice cannot be counted\./);
    assert.match(html, /<h2>Gate decisions<\/h2>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report review time: an even count takes the mean of the middle two; nothing timed says so; long runs show hours", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-report-wall2-"));
  try {
    const state = join(dir, ".claude", "state");
    mkdirSync(state, { recursive: true });
    const m = { models: ["claude-sonnet-5-5"] };
    const tel = [
      tStart("a", "reviewer", at(0)), tStop("a", "reviewer", at(10), m),
      tStart("b", "reviewer", at(0)), tStop("b", "reviewer", at(20), m),
      tStart("c", "reviewer", at(0)), tStop("c", "reviewer", at(40), m),
      tStart("d", "reviewer", at(0)), tStop("d", "reviewer", at(3900), m),
    ];
    writeFileSync(join(state, "telemetry.jsonl"), tel.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const sec = reviewTime(renderReport(dir));
    assert.match(sec, /<td>reviewer<\/td><td>claude-sonnet-5-5<\/td><td>4<\/td><td>30 s<\/td><td>1 h 5 min<\/td><td>1 h 6 min<\/td>/);
    assert.doesNotMatch(sec, /without a start or stop record/);

    // Only a stop: nothing timed, the note, exit 0.
    writeFileSync(join(state, "telemetry.jsonl"), `${JSON.stringify(tStop("z", "reviewer", at(5)))}\n`);
    const bare = reviewTime(renderReport(dir));
    assert.match(bare, /No agent with both a start and a stop record yet\./);
    assert.match(bare, /1 agent without a start or stop record/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report review time: reviews per slice from the journal, opus counted from the reviewer's telemetry models", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-report-reviews-"));
  try {
    const state = join(dir, ".claude", "state");
    mkdirSync(state, { recursive: true });
    /** @param {string} id @param {string} slice @param {object} [rest] */
    const review = (id, slice, rest = {}) => ({ ts: "t", session_id: "s1", agent_id: id, role: "reviewer", slice, run: 1, status: "pass", answers: {}, open: [], ...rest });
    const journal = [
      { ts: "t", session_id: "s1", agent_id: "i1", role: "implementer", slice: "a", run: 1, status: "pass" }, // not a review
      review("r1", "a", { status: "fail" }),
      review("r2", "a"),
      review("r2", "a", { continues: true }), // the same reply recorded twice: one review
      review("r3", "a"),
      review("r4", "b"),
      review("r5", "b"), // no telemetry: model unknown, not on opus
    ];
    writeFileSync(join(state, "journal.jsonl"), journal.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const tel = [
      tStart("r1", "reviewer", at(0)), tStop("r1", "reviewer", at(60), { models: ["claude-sonnet-5-5"] }),
      tStart("r2", "reviewer", at(0)), tStop("r2", "reviewer", at(60), { models: ["claude-opus-5-5"] }),
      tStart("r3", "orchestration:reviewer", at(0)), tStop("r3", "orchestration:reviewer", at(60), { models: ["claude-fable-5-2"] }),
      tStart("r4", "reviewer", at(0)), tStop("r4", "reviewer", at(60), { models: ["us.anthropic.claude-opus-5-5"] }),
    ];
    writeFileSync(join(state, "telemetry.jsonl"), tel.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const sec = reviewTime(renderReport(dir));
    assert.match(sec, /<th>Session<\/th><th>Run<\/th><th>Slice<\/th><th>Reviews<\/th><th>On opus<\/th>/);
    assert.match(sec, /<td>s1<\/td><td>1<\/td><td>a<\/td><td>3<\/td><td>1<\/td>/);
    assert.match(sec, /<td>s1<\/td><td>1<\/td><td>b<\/td><td>2<\/td><td>1<\/td>/);
    assert.match(sec, /2 slices, 5 reviews, 2\.5 per slice, 2 of 5 on opus \(40%\)\. 1 review has no model on record and counts as not on opus\./);

    // A journal with no reviewer record.
    writeFileSync(join(state, "journal.jsonl"), `${JSON.stringify(journal[0])}\n`);
    assert.match(reviewTime(renderReport(dir)), /No reviews in the journal yet\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report: an agent that stops several times is counted once, with its last record (each record is a running total)", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-report-once-"));
  try {
    const state = join(dir, ".claude", "state");
    mkdirSync(state, { recursive: true });
    const M = 1_000_000;
    /** @param {string} session @param {string} id @param {string} type @param {number} scale @param {object} [rest] */
    const stop = (session, id, type, scale, rest = {}) => ({
      ts: "t", session_id: session, hook_event_name: "SubagentStop", agent_id: id, agent_type: type,
      tokens: { input: 0, output: 0.1 * M * scale, cache_read: 10 * M * scale, cache_write: 0 }, turns: 10 * scale, models: ["claude-sonnet-5-5"], max_turns_hit: false, ...rest,
    });
    const tel = [
      // One implementer, three stops: the test gate sent it back once, then it was resumed. Each record is the total so far.
      stop("s1", "i1", "implementer", 1),
      stop("s1", "r1", "reviewer", 1),
      stop("s1", "i1", "implementer", 2),
      stop("s1", "i1", "orchestration:implementer", 3, { cache_rewrites: { requests: 1, tokens: 50000 } }),
      // The same agent id in another session is another agent.
      stop("s2", "i1", "implementer", 1),
      // Records with no agent id (older logs) cannot be joined: each counts on its own.
      { ...stop("s1", "", "integrator", 1), agent_id: undefined },
      { ...stop("s1", "", "integrator", 1), agent_id: undefined },
    ];
    writeFileSync(join(state, "telemetry.jsonl"), tel.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = spawnSync("node", [join(root, "scripts", "report.mjs"), dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(join(state, "report.html"), "utf8");
    // Role table: 2 implementers (not 4 stop records), output 0.3M + 0.1M, cache read 30M + 10M, turns 30 + 10.
    assert.match(html, /<td>implementer<\/td><td>2<\/td><td>2<\/td><td>0<\/td><td>400k<\/td><td>40\.0M<\/td><td>0<\/td><td>40<\/td>/);
    assert.match(html, /<td>integrator<\/td><td>2<\/td><td>2<\/td>/);
    // Cost: the three-stop implementer once at its last total (0.3M out, 30M read on Sonnet 5.5 = $3 + $3), plus the
    // other session's (1 + 1): $8.00 over 2 agents. Summing every record gave $14.00 over 4 for this row.
    assert.match(html, /<td>implementer<\/td><td>claude-sonnet-5-5<\/td><td>2<\/td><td>\$8\.00<\/td><td>\$4\.00<\/td><td>400k<\/td><td>40\.0M<\/td><td>0<\/td><td>1 \(50k\)<\/td>/);
    assert.doesNotMatch(html, /<td>implementer<\/td><td>claude-sonnet-5-5<\/td><td>4<\/td>/);
    // With the reviewer ($2) and the two integrator records ($2 each).
    assert.match(html, /Total \$14\.00 at list prices/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
