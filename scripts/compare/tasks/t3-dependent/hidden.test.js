import assert from "node:assert/strict";
import { test } from "node:test";
import { Stack } from "./stack.js";
import { evalRPN } from "./rpn.js";

test("Stack", () => {
  const s = new Stack();
  assert.equal(s.size, 0);
  assert.throws(() => s.pop(), RangeError);
  assert.throws(() => s.peek(), RangeError);
  s.push(1);
  s.push(2);
  assert.equal(s.peek(), 2);
  assert.equal(s.size, 2);
  assert.equal(s.pop(), 2);
  assert.equal(s.pop(), 1);
  assert.equal(s.size, 0);
});
test("evalRPN values", () => {
  assert.equal(evalRPN(["2", "1", "+", "3", "*"]), 9);
  assert.equal(evalRPN(["4", "13", "5", "/", "+"]), 6);
  assert.equal(evalRPN(["10", "6", "9", "3", "+", "-11", "*", "/", "*", "17", "+", "5", "+"]), 22);
  assert.equal(evalRPN(["7", "2", "/"]), 3);
  assert.equal(evalRPN(["-7", "2", "/"]), -3);
  assert.equal(evalRPN(["5"]), 5);
  assert.equal(evalRPN(["3", "4", "-"]), -1);
});
test("evalRPN errors", () => {
  assert.throws(() => evalRPN(["1", "0", "/"]), RangeError);
  assert.throws(() => evalRPN(["+"]), Error);
  assert.throws(() => evalRPN(["1", "+"]), Error);
  assert.throws(() => evalRPN(["1", "2"]), Error);
  assert.throws(() => evalRPN(["a"]), Error);
  assert.throws(() => evalRPN([]), Error);
});
