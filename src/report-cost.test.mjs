// 1.2.0: the report's cost estimate (scripts/prices.mjs) and its line for agents that started and never stopped.
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
    assert.match(html, /Total \$10\.80 at list prices as of \d{4}-\d{2}-\d{2}.*not a bill.*2 agent stops not priced/);
    assert.match(html, /Started and never stopped \(turn limit, killed, or still running\): implementer 1, researcher 2\./);
    assert.match(html, /<h2>Agents by role<\/h2>/, "the role table stays");

    // No priced stop and nothing left open: the section says so and the line is absent.
    writeFileSync(join(state, "telemetry.jsonl"), `${JSON.stringify(stop("r3", "reviewer", { status: "pass" }))}\n`);
    assert.equal(spawnSync("node", [join(root, "scripts", "report.mjs"), dir], { encoding: "utf8" }).status, 0);
    const bare = readFileSync(join(state, "report.html"), "utf8");
    assert.match(bare, /No priced agent stops yet/);
    assert.doesNotMatch(bare, /Started and never stopped/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
