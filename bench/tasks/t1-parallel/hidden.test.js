import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "./slugify.js";
import { capitalize } from "./capitalize.js";

test("slugify basics", () => {
  assert.equal(slugify("Hello, World!"), "hello-world");
  assert.equal(slugify("  Crème Brûlée  "), "creme-brulee");
  assert.equal(slugify("a--b__c"), "a-b-c");
  assert.equal(slugify("---"), "");
  assert.equal(slugify("Already-slugged-123"), "already-slugged-123");
});
test("slugify rejects non-strings", () => {
  assert.throws(() => slugify(123), TypeError);
  assert.throws(() => slugify(null), TypeError);
});
test("capitalize basics", () => {
  assert.equal(capitalize("hello"), "Hello");
  assert.equal(capitalize(""), "");
  assert.equal(capitalize("éa"), "Éa");
  assert.equal(capitalize("hELLO"), "HELLO");
  assert.equal(capitalize("x"), "X");
});
test("capitalize rejects non-strings", () => {
  assert.throws(() => capitalize(undefined), TypeError);
  assert.throws(() => capitalize(5), TypeError);
});
