import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTokens, totalTokens, usageFromResult } from "./tokens.js";

test("usageFromResult sums every model in modelUsage", () => {
  const u = usageFromResult({
    modelUsage: {
      a: { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 },
      b: { inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 },
    },
    usage: { input_tokens: 999, output_tokens: 999 },
  });
  assert.deepEqual(u, { input: 11, output: 22, cacheRead: 33, cacheWrite: 44 });
  assert.equal(totalTokens(u), 110);
});

test("usageFromResult falls back to usage when modelUsage is empty or missing", () => {
  const usage = { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 };
  const want = { input: 5, output: 6, cacheRead: 7, cacheWrite: 8 };
  assert.deepEqual(usageFromResult({ modelUsage: {}, usage }), want);
  assert.deepEqual(usageFromResult({ usage }), want);
  assert.deepEqual(usageFromResult({}), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("usageFromResult counts NaN and missing fields as 0", () => {
  const u = usageFromResult({ modelUsage: { a: { inputTokens: Number.NaN, outputTokens: 5 } } });
  assert.deepEqual(u, { input: 0, output: 5, cacheRead: 0, cacheWrite: 0 });
  assert.equal(totalTokens(usageFromResult({ usage: { input_tokens: Infinity, output_tokens: 2 } })), 2);
});

test("formatTokens: plain, kilo and mega", () => {
  const cases: [number, string][] = [[0, "0"], [950, "950"], [4500, "4.5k"], [45600, "46k"], [456000, "456k"], [1234567, "1.23M"], [12345678, "12.3M"]];
  cases.push([999.6, "1.0k"], [9949, "9.9k"], [9950, "10k"], [999499, "999k"], [999500, "1.00M"], [999999, "1.00M"], [9994999, "9.99M"], [9999999, "10.0M"]);
  for (const [v, s] of cases) assert.equal(formatTokens(v), s);
});
