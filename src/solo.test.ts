import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRequest, AgentResult, RunAgent } from "./agent.js";
import { solo } from "./solo.js";

const result = (over: Partial<AgentResult> = {}): AgentResult => ({
  ok: true, text: "done", tokens: 1000, turns: 1, subtype: "success", durationMs: 1, model: "fake", ...over,
});

/** Sessions write solo.txt; the reviewer rejects every time. Every worker costs 1000 tokens. */
function rejecting() {
  const calls: AgentRequest[] = [];
  const run: RunAgent = async (req) => {
    calls.push(req);
    if (req.role === "solo") {
      writeFileSync(join(req.cwd, "solo.txt"), "x\n");
      return result();
    }
    return result({ structured: { pass: false, issues: ["not yet"], summary: "" } });
  };
  return { run, calls };
}

const dirs = () => ({ repo: mkdtempSync(join(tmpdir(), "solo-repo-")), outRoot: mkdtempSync(join(tmpdir(), "solo-out-")) });

test("reviewed route: a spent token budget stops further rounds and the report says so", async () => {
  const { run, calls } = rejecting();
  const r = await solo({ ...dirs(), task: "t", run, review: true, maxRetries: 5, runBudgetTokens: 2500 });

  // Round 1 (session + reviewer) spends 2000 < 2500, so round 2 starts; after it 4000 >= 2500, so no round 3.
  assert.equal(r.attempts, 2);
  assert.deepEqual(calls.map((c) => c.role), ["solo", "verifier", "solo", "verifier"]);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /run budget exhausted/);
  assert.equal(r.spentTokens, 4000);
});

test("reviewed route without a budget still runs every round", async () => {
  const { run, calls } = rejecting();
  const r = await solo({ ...dirs(), task: "t", run, review: true, maxRetries: 2 });

  assert.equal(r.attempts, 3);
  assert.equal(calls.length, 6);
  assert.match(r.error ?? "", /^review failed/);
});

test("plain route under a budget runs its one session", async () => {
  const { run, calls } = rejecting();
  const r = await solo({ ...dirs(), task: "t", run, runBudgetTokens: 10_000 });

  assert.deepEqual(calls.map((c) => c.role), ["solo"]);
  assert.equal(r.ok, true);
});
