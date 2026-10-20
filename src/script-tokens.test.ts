// scripts/tokens.mjs: the shared token helpers for the native path's log, report and compare scripts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTokens } from "../scripts/tokens.mjs";

test("formatTokens: the unit and decimals follow the rounded value, so no 1000k or 10.00M", () => {
  const cases: [number, string][] = [
    [950, "950"], [999.6, "1.0k"], [4500, "4.5k"], [9949, "9.9k"], [9950, "10k"], [45600, "46k"], [999499, "999k"],
    [999500, "1.00M"], [999999, "1.00M"], [1234567, "1.23M"], [9994999, "9.99M"], [9999999, "10.0M"], [12345678, "12.3M"],
  ];
  for (const [n, text] of cases) assert.equal(formatTokens(n), text, String(n));
});

test("src/tokens.ts and scripts/tokens.mjs agree on the same fixtures", async () => {
  const { usageFromResult, totalTokens: tsTotal, formatTokens: tsFormat } = await import("./tokens.js");
  const { usageOf, totalTokens: mjsTotal } = await import("../scripts/tokens.mjs");
  const full = { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 };
  const usage = { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 };
  const fixtures: object[] = [
    { modelUsage: { a: full, b: full }, usage },
    { modelUsage: {}, usage },
    { usage },
    {},
    { modelUsage: { a: { inputTokens: 3 } } },
    { modelUsage: { a: { inputTokens: Number.NaN, outputTokens: Infinity, cacheReadInputTokens: -Infinity, cacheCreationInputTokens: 2 } } },
    { usage: { input_tokens: Number.NaN, output_tokens: 4 } },
  ];
  for (const f of fixtures) {
    assert.deepEqual(usageFromResult(f), usageOf(f), JSON.stringify(f));
    assert.equal(tsTotal(usageFromResult(f)), mjsTotal(f), JSON.stringify(f));
  }
  for (const base of [999, 9_999, 99_999, 999_999, 9_999_999]) {
    for (let d = -600; d <= 600; d += 50) {
      const v = base + d;
      assert.equal(tsFormat(v), formatTokens(v), String(v));
    }
  }
  for (const v of [0, 0.4, 0.5, 1, 999.5, 1000, 9949, 9950, 10_000, 999_499, 999_500, 9_994_999, 9_995_000, 1e9]) assert.equal(tsFormat(v), formatTokens(v), String(v));
});
