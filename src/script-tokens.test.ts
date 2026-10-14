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
