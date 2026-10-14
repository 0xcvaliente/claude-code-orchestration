import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentResult } from "./agent.js";
import { Run } from "./state.js";

test("charge: the telemetry line carries tokens and usage, and no cost", () => {
  const run = new Run("r1", mkdtempSync(join(tmpdir(), "orch-state-")));
  const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
  const res: AgentResult = { ok: true, text: "hello", tokens: 10, usage, turns: 1, subtype: "success", durationMs: 5, model: "fake" };
  run.charge("writer", "a#1", res);
  run.charge("writer", "a#2", { ...res, tokens: Number.NaN, usage: undefined });

  const lines = readFileSync(join(run.dir, "telemetry.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines[0].tokens, 10);
  assert.deepEqual(lines[0].usage, usage);
  assert.equal(lines[0].role, "writer");
  assert.equal("costUsd" in lines[0], false);
  assert.equal(run.spentTokens, 10, "a NaN count adds nothing");
  assert.deepEqual(run.tokensByRole(), { writer: 10 });
});
