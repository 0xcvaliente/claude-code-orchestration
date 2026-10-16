import assert from "node:assert/strict";
import { test } from "node:test";
import { categories, convert, listUnits } from "../src/index.js";

const near = (a, b) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} != ${b}`);

test("public: length", () => near(convert("length", 1, "km", "m"), 1000));
test("public: temperature", () => near(convert("temperature", 100, "C", "F"), 212));
test("public: categories", () => assert.deepEqual(categories(), ["data", "length", "mass", "temperature", "time", "volume"]));
test("public: listUnits", () => assert.deepEqual(listUnits("time"), ["ms", "s", "min", "h", "d", "wk"]));
