import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRequest, AgentResult, RunAgent } from "./agent.js";
import { readFileSync } from "node:fs";
import { TRIAGE } from "./config.js";
import { decide, parseFacts, triage, type Facts } from "./triage.js";

const facts = (over: Partial<Facts> = {}): Facts => ({ filesToTouch: 2, linesToChange: 50, independentSlices: 1, risky: false, reason: "", ...over });

test("decide: small or sequential work goes to a plain session", () => {
  assert.equal(decide(facts()).mode, "plain");
  assert.equal(decide(facts({ filesToTouch: 8, independentSlices: 1 })).mode, "plain", "sequential, however many files");
  assert.equal(decide(facts({ filesToTouch: 3, independentSlices: 3 })).mode, "plain", "too little work to parallelise");
});

test("decide: parallel, large or risky work goes to the pipeline", () => {
  assert.equal(decide(facts({ filesToTouch: 5, independentSlices: 2 })).mode, "orchestrate");
  assert.equal(decide(facts({ filesToTouch: 12, independentSlices: 1 })).mode, "orchestrate");
  assert.equal(decide(facts({ filesToTouch: 6, risky: true })).mode, "orchestrate", "risky and spread over files");
  assert.equal(decide(facts({ filesToTouch: 2, independentSlices: 2, risky: true })).mode, "orchestrate", "risky and parallel");
});

test("decide: a small risky change gets a plain session plus an independent reviewer", () => {
  assert.equal(decide(facts({ filesToTouch: 1, risky: true })).mode, "reviewed");
  assert.equal(decide(facts({ filesToTouch: 3, risky: true })).mode, "reviewed");
  assert.equal(decide(facts({ filesToTouch: 4, risky: true })).mode, "orchestrate");
});

test("decide: line count matters, not only files", () => {
  assert.equal(decide(facts({ filesToTouch: 3, linesToChange: 2000, independentSlices: 3 })).mode, "orchestrate", "big and parallel across few files");
  const seq = decide(facts({ filesToTouch: 3, linesToChange: 2000, independentSlices: 1 }));
  assert.equal(seq.mode, "plain");
  assert.match(seq.reason, /coupled design in one context/);
  assert.equal(decide(facts({ filesToTouch: 3, linesToChange: 1499, independentSlices: 3 })).mode, "plain");
  assert.equal(decide(facts({ filesToTouch: 2, linesToChange: 200, risky: true })).mode, "reviewed");
  assert.equal(decide(facts({ filesToTouch: 2, linesToChange: 201, risky: true })).mode, "orchestrate", "risky and too large to review alone");
});

test("route skill mentions every TRIAGE threshold (in-model fallback cannot drift)", () => {
  const skill = readFileSync(new URL("../.claude/skills/route/SKILL.md", import.meta.url), "utf8");
  for (const [k, v] of Object.entries(TRIAGE)) {
    assert.ok(skill.includes(String(v)), `SKILL.md must mention ${k}=${v}`);
  }
});

test("parseFacts: rejects malformed output and clamps numbers", () => {
  for (const bad of [undefined, null, "x", {}, { filesToTouch: "3", linesToChange: 1, independentSlices: 1, risky: false }, { filesToTouch: NaN, linesToChange: 1, independentSlices: 1, risky: false }, { filesToTouch: 1, linesToChange: 1, independentSlices: 1, risky: "no" }, { filesToTouch: 1, independentSlices: 1, risky: false }, { filesToTouch: 1, linesToChange: NaN, independentSlices: 1, risky: false }]) {
    assert.equal(parseFacts(bad), undefined);
  }
  const f = parseFacts({ filesToTouch: -4, linesToChange: -9, independentSlices: 99, risky: false, reason: "x".repeat(1000) })!;
  assert.equal(f.filesToTouch, 0);
  assert.equal(f.linesToChange, 0);
  assert.equal(f.independentSlices, 6);
  assert.equal(f.reason.length, 300);
  assert.equal(parseFacts({ filesToTouch: 2, linesToChange: 5, independentSlices: 0, risky: true, reason: 5 })!.independentSlices, 1);
});

const result = (over: Partial<AgentResult>): AgentResult => ({
  ok: true, text: "", costUsd: 0.04, turns: 1, subtype: "success", durationMs: 1, model: "fake", ...over,
});
const runWith = (res: Partial<AgentResult>): { run: RunAgent; calls: AgentRequest[] } => {
  const calls: AgentRequest[] = [];
  return { calls, run: async (req) => (calls.push(req), result(res)) };
};

test("triage: one read-only triager call, policy applied, cost recorded", async () => {
  const { run, calls } = runWith({ structured: { filesToTouch: 1, linesToChange: 3, independentSlices: 1, risky: false, reason: "typo" } });
  const d = await triage({ run, repo: "/r", task: "fix the typo in README" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.role, "triager");
  assert.ok(calls[0]!.prompt.includes("fix the typo in README"));
  assert.deepEqual([d.mode, d.source, d.costUsd], ["plain", "triage", 0.04]);
  assert.equal(d.facts!.reason, "typo");
});

test("triage: failure or invalid output falls back to the full pipeline", async () => {
  const failed = await triage({ ...runWith({ ok: false, subtype: "error_max_turns" }), repo: "/r", task: "t" });
  assert.deepEqual([failed.mode, failed.source], ["orchestrate", "fallback"]);
  assert.match(failed.reason, /error_max_turns/);
  const invalid = await triage({ ...runWith({ structured: { nope: 1 } }), repo: "/r", task: "t" });
  assert.deepEqual([invalid.mode, invalid.source], ["orchestrate", "fallback"]);
  assert.equal(invalid.costUsd, 0.04, "a failed triage still costs money");
});
