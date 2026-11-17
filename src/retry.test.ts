import "./test-tmp.mjs";
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
  for (const text of ["API Error: 500", "status 503", "HTTP 502", "503 Service Unavailable", "HTTP/1.1 504 Gateway Timeout"]) {
    assert.equal(isTransient(res({ ok: false, subtype: "exception", text })), true, text);
  }
  assert.equal(isTransient(res({ ok: false, subtype: "exception", text: "expected 500 lines, got 3" })), false, "a bare number is not a status");
  assert.equal(isTransient(res({ ok: true })), false);
  assert.equal(isTransient(res({ ok: false, subtype: "timeout", text: "429" })), false, "our own timeout is never retried");
  assert.equal(isTransient(res({ ok: false, subtype: "error_max_turns", text: "" })), false);
  assert.equal(isTransient(res({ ok: false, subtype: "exception", text: "tests failed" })), false);
});

test("isTransient: 429 and 529 count only in a status context", () => {
  for (const text of ["API Error: 429", "status 429", "HTTP 529", "error: 529", "429 Too Many Requests", "529 overloaded"]) {
    assert.equal(isTransient(res({ ok: false, subtype: "exception", text })), true, text);
  }
  for (const text of ["TypeError: x is undefined\n    at run (index.js:429:12)", "expected 529 rows, got 3", "line 429: syntax error"]) {
    assert.equal(isTransient(res({ ok: false, subtype: "exception", text })), false, text);
  }
});

test("withTransientRetry: a task failure whose stack trace holds :429: is not retried", async () => {
  const broken = scripted([res({ ok: false, subtype: "error_during_execution", text: "TypeError at index.js:429:12" })]);
  await withTransientRetry(broken.run, noWait)({ role: "writer", prompt: "p", cwd: "." });
  assert.equal(broken.calls(), 1);
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

test("withTransientRetry: sums the cost across attempts, and reports none when no attempt had one", async () => {
  const { run } = scripted([res({ ok: false, subtype: "exception", text: "429 rate limit", costUsd: 0.01 }), res({ costUsd: 0.02 })]);
  const req = { role: "triager" as const, prompt: "p", cwd: "." };
  const r = await withTransientRetry(run, noWait)(req);
  assert.ok(Math.abs(r.costUsd! - 0.03) < 1e-12, String(r.costUsd));
  const plain = scripted([res({})]);
  assert.equal("costUsd" in (await withTransientRetry(plain.run, noWait)(req)), false);
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

test("a call stopped by its budget cap is never retried, whatever its error text says", async () => {
  const capped = res({ ok: false, subtype: "error_max_budget_usd", text: "API Error: overloaded" });
  assert.equal(isTransient(capped), false);
  const s = scripted([capped]);
  const r = await withTransientRetry(s.run, noWait)({ role: "triager", prompt: "p", cwd: "." });
  assert.equal(s.calls(), 1);
  assert.equal(r.subtype, "error_max_budget_usd");
});
