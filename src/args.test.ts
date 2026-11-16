import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { count, parseCount, parseTokens } from "./args.js";

test("parseTokens accepts plain, k and M counts", () => {
  assert.equal(parseTokens("--budget", "250000"), 250_000);
  assert.equal(parseTokens("--budget", "500k"), 500_000);
  assert.equal(parseTokens("--budget", "1.5M"), 1_500_000);
  assert.equal(parseTokens("--budget", "2m"), 2_000_000);
});

test("parseTokens rejects text, zero, negatives, values below 10k and other notations", () => {
  for (const bad of ["abc", "0", "-1", "5", "1e6", "Infinity", "2MB", ""]) {
    assert.throws(() => parseTokens("--budget", bad), /--budget must be a token count of at least 10k/, bad);
  }
});

test("parseCount accepts only plain decimal counts at or above the minimum", () => {
  assert.equal(parseCount("--retries", "0", 0), 0);
  assert.equal(parseCount("--retries", "2", 0), 2);
  assert.equal(parseCount("--concurrency", "12", 1), 12);
  for (const bad of ["", " ", "0x2", "1e1", "1.0", "-1", "+1", " 2", "2 ", "abc", "99999999999999999999"]) {
    assert.throws(() => parseCount("--retries", bad, 0), /--retries must be/, JSON.stringify(bad));
  }
  assert.throws(() => parseCount("--concurrency", "0", 1), /--concurrency must be/);
});

test("count accepts integers at or above the minimum and rejects the rest", () => {
  assert.equal(count("--concurrency", 3, 1), 3);
  assert.equal(count("--retries", 0, 0), 0);
  for (const bad of [Number("abc"), 0, 1.5, -2]) assert.throws(() => count("--concurrency", bad, 1), /--concurrency/);
  assert.throws(() => count("--retries", -1, 0), /--retries/);
});
