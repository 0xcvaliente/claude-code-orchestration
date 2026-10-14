import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDuration } from "./duration.js";

test("valid durations", () => {
  assert.equal(parseDuration("1h30m"), 5400);
  assert.equal(parseDuration("45s"), 45);
  assert.equal(parseDuration("2d"), 172800);
  assert.equal(parseDuration("1d2h3m4s"), 93784);
  assert.equal(parseDuration("0s"), 0);
  assert.equal(parseDuration("90m"), 5400);
});
test("invalid durations throw RangeError", () => {
  for (const bad of ["", "30m1h", "1h1h", "1x", "10", " 1h", "1h ", "h", "1H", "-5s", "1.5h"]) {
    assert.throws(() => parseDuration(bad), RangeError, `expected RangeError for ${JSON.stringify(bad)}`);
  }
});
test("non-strings throw TypeError", () => {
  assert.throws(() => parseDuration(5), TypeError);
  assert.throws(() => parseDuration(null), TypeError);
});
