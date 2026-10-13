import assert from "node:assert/strict";
import { test } from "node:test";
import { count, usd } from "./args.js";

test("usd accepts positive numbers and rejects NaN, zero, negatives and Infinity", () => {
  assert.equal(usd("--budget", 2.5), 2.5);
  for (const bad of [Number("abc"), 0, -1, Infinity]) assert.throws(() => usd("--budget", bad), /--budget/);
});

test("count accepts integers at or above the minimum and rejects the rest", () => {
  assert.equal(count("--concurrency", 3, 1), 3);
  assert.equal(count("--retries", 0, 0), 0);
  for (const bad of [Number("abc"), 0, 1.5, -2]) assert.throws(() => count("--concurrency", bad, 1), /--concurrency/);
  assert.throws(() => count("--retries", -1, 0), /--retries/);
});
