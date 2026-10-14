import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentResult, RunAgent } from "./agent.js";
import { isTransient, withTransientRetry } from "./retry.js";

const res = (over: Partial<AgentResult>): AgentResult => ({
  ok: true, text: "", tokens: 1000, turns: 1, subtype: "success", durationMs: 1, model: "fake", ...over,
});
const scripted = (results: AgentResult[]) => {
  let n = 0;
  const run: RunAgent = async () => results[Math.min(n++, results.length - 1)]!;
  return { run, calls: () => n };
};
const noWait = { sleep: async () => undefined, backoffMs: () => 0 };

test("isTransient: service errors yes, task failures and our own limits no", () => {
  for (const text of ["429 Too Many Requests", "API Error: overloaded_error", "rate limit reached", "502 Bad Gateway", "read ECONNRESET", "stream ended unexpectedly"]) {
    assert.equal(isTransient(res({ ok: false, subtype: "exception", text })), true, text);
  }
  assert.equal(isTransient(res({ ok: true })), false);
  assert.equal(isTransient(res({ ok: false, subtype: "timeout", text: "429" })), false, "our own timeout is never retried");
  assert.equal(isTransient(res({ ok: false, subtype: "error_max_turns", text: "" })), false);
  assert.equal(isTransient(res({ ok: false, subtype: "exception", text: "tests failed" })), false);
});

test("withTransientRetry: retries a rate limit, then returns the success with summed tokens", async () => {
  const { run, calls } = scripted([res({ ok: false, subtype: "exception", text: "429 rate limit" }), res({ text: "done" })]);
  const seen: number[] = [];
  const r = await withTransientRetry(run, { ...noWait, onRetry: (n) => seen.push(n) })({ role: "writer", prompt: "p", cwd: "." });
  assert.equal(r.ok, true);
  assert.equal(calls(), 2);
  assert.equal(r.tokens, 2000);
  assert.deepEqual(seen, [1]);
});

test("withTransientRetry: sums the usage breakdown across attempts", async () => {
  const usage = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 };
  const { run } = scripted([res({ ok: false, subtype: "exception", text: "429 rate limit", usage }), res({ usage })]);
  const r = await withTransientRetry(run, noWait)({ role: "writer", prompt: "p", cwd: "." });
  assert.deepEqual(r.usage, { input: 2, output: 4, cacheRead: 6, cacheWrite: 8 });
});

test("withTransientRetry: gives up after the retry limit and does not retry task failures", async () => {
  const flaky = scripted([res({ ok: false, subtype: "exception", text: "overloaded" })]);
  const r = await withTransientRetry(flaky.run, { ...noWait, retries: 2 })({ role: "writer", prompt: "p", cwd: "." });
  assert.equal(r.ok, false);
  assert.equal(flaky.calls(), 3, "one try plus two retries");

  const broken = scripted([res({ ok: false, subtype: "error_during_execution", text: "bad code" })]);
  await withTransientRetry(broken.run, noWait)({ role: "writer", prompt: "p", cwd: "." });
  assert.equal(broken.calls(), 1);
});
