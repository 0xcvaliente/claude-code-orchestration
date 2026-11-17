import "./test-tmp.mjs";
// scripts/run-budget.mjs: the arithmetic of the run-wide cap of `npm run auto` (scripts/auto.sh). The launcher's own use
// of it is tested in src/verify.test.ts ("auto.sh run-wide cap: ...").
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_SESSION_TOKENS, nextSession, spentMessage, spentOf, SPENT_EXIT } from "../scripts/run-budget.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "run-budget.mjs");

test("spentOf: dollars first at 1M tokens per dollar, then the call's tokens, then nothing", () => {
  assert.equal(spentOf({ costUsd: 0.0289293, tokens: 14030 }), 28929, "a triage decision: its cost");
  assert.equal(spentOf({ total_cost_usd: 0.25, modelUsage: { m: { inputTokens: 5 } } }), 250000, "a session: its total_cost_usd");
  assert.equal(spentOf({ tokens: 14030 }), 14030, "a decision without a cost: its tokens");
  assert.equal(spentOf({ result: "x", modelUsage: { m: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 30, cacheCreationInputTokens: 4 } } }), 1234);
  for (const odd of [null, undefined, "text", 3, [], {}, { costUsd: -1 }, { total_cost_usd: Number.NaN }]) assert.equal(spentOf(odd), 0, JSON.stringify(odd));
});

test("nextSession: the rest of the cap, and never a session under the smallest cap", () => {
  assert.deepEqual(nextSession(300_000, 50_000), { ok: true, left: 250_000 });
  assert.deepEqual(nextSession(300_000, 300_000 - MIN_SESSION_TOKENS), { ok: true, left: MIN_SESSION_TOKENS });
  assert.deepEqual(nextSession(300_000, 300_000 - MIN_SESSION_TOKENS + 1), { ok: false, left: MIN_SESSION_TOKENS - 1 });
  assert.deepEqual(nextSession(300_000, 400_000), { ok: false, left: 0 }, "overspent: nothing left, not a negative cap");
  assert.equal(MIN_SESSION_TOKENS, 10_000, "the floor of tokens.mjs parseTokens");
});

test("run-budget.mjs CLI: spent reads stdin, next prints the rest or exits 3 with the message", () => {
  const run = (/** @type {string[]} */ args, input = "") => spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8" });
  assert.equal(run(["spent"], JSON.stringify({ total_cost_usd: 0.1 })).stdout, "100000\n");
  assert.equal(run(["spent"], "not json").stdout, "0\n");
  assert.equal(run(["next", "300k", "50000", "reviewer"]).stdout, "250000\n");
  const out = run(["next", "300k", "295000", "reviewer"]);
  assert.equal(out.status, SPENT_EXIT);
  assert.equal(SPENT_EXIT, 3);
  assert.equal(out.stdout, "");
  assert.equal(out.stderr.trim(), spentMessage("300k", 295000, 5000, "reviewer"));
  assert.equal(run(["next", "5", "0", "x"]).status, 1, "a bad cap is an error, not a spent cap");
  assert.equal(run(["next", "300k", "-1", "x"]).status, 1);
});
