import assert from "node:assert/strict";
import { test } from "node:test";
import { categories, convert, listUnits } from "./src/index.js";

const near = (a, b) => assert.ok(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const ORDER = {
  length: ["mm", "cm", "m", "km", "in", "ft", "yd", "mi"],
  mass: ["mg", "g", "kg", "t", "oz", "lb"],
  time: ["ms", "s", "min", "h", "d", "wk"],
  data: ["bit", "B", "KB", "MB", "GB", "KiB", "MiB", "GiB"],
  volume: ["mL", "L", "m3", "tsp", "tbsp", "cup", "gal"],
  temperature: ["C", "F", "K"],
};

test("length conversions", () => { near(convert("length", 1, "mi", "km"), 1.609344); near(convert("length", 12, "in", "ft"), 1); near(convert("length", 3, "ft", "yd"), 1); near(convert("length", 250, "mm", "cm"), 25); });
test("length units and errors", () => { assert.deepEqual(listUnits("length"), ORDER.length); assert.throws(() => convert("length", 1, "M", "m"), RangeError); assert.throws(() => convert("length", 1, "m", "kg"), RangeError); });
test("mass conversions", () => { near(convert("mass", 1, "lb", "oz"), 16); near(convert("mass", 2.5, "t", "kg"), 2500); near(convert("mass", 1500, "mg", "g"), 1.5); });
test("mass units and errors", () => { assert.deepEqual(listUnits("mass"), ORDER.mass); assert.throws(() => convert("mass", 1, "stone", "kg"), RangeError); });
test("time conversions", () => { near(convert("time", 2, "wk", "d"), 14); near(convert("time", 90, "min", "h"), 1.5); near(convert("time", 1, "d", "ms"), 86400000); });
test("time units and errors", () => { assert.deepEqual(listUnits("time"), ORDER.time); assert.throws(() => convert("time", 1, "sec", "s"), RangeError); });
test("data conversions", () => { near(convert("data", 1, "KiB", "bit"), 8192); near(convert("data", 1, "GB", "MB"), 1000); near(convert("data", 1, "GiB", "MiB"), 1024); near(convert("data", 1500, "KB", "MB"), 1.5); });
test("data units are case-sensitive", () => { assert.deepEqual(listUnits("data"), ORDER.data); assert.throws(() => convert("data", 1, "mb", "B"), RangeError); assert.throws(() => convert("data", 1, "kib", "B"), RangeError); });
test("volume conversions", () => { near(convert("volume", 1, "gal", "L"), 3.785411784); near(convert("volume", 3, "tsp", "tbsp"), 1); near(convert("volume", 2, "m3", "L"), 2000); near(convert("volume", 16, "tbsp", "cup"), 1); });
test("volume units and errors", () => { assert.deepEqual(listUnits("volume"), ORDER.volume); assert.throws(() => convert("volume", 1, "ml", "L"), RangeError); });
test("temperature C/F/K", () => { near(convert("temperature", 0, "C", "K"), 273.15); near(convert("temperature", -40, "F", "C"), -40); near(convert("temperature", 300, "K", "F"), 80.33); near(convert("temperature", 98.6, "F", "C"), 37); });
test("temperature same unit", () => { near(convert("temperature", 21.5, "C", "C"), 21.5); near(convert("temperature", 0, "K", "K"), 0); });
test("temperature below absolute zero", () => { assert.throws(() => convert("temperature", -1, "K", "C"), RangeError); assert.throws(() => convert("temperature", -274, "C", "K"), RangeError); assert.throws(() => convert("temperature", -460, "F", "C"), RangeError); });
test("temperature units", () => { assert.deepEqual(listUnits("temperature"), ORDER.temperature); assert.throws(() => convert("temperature", 1, "c", "K"), RangeError); });
test("same unit is identity", () => { near(convert("length", 7, "m", "m"), 7); near(convert("data", 3, "bit", "bit"), 3); });
test("round trip", () => { near(convert("mass", convert("mass", 5, "lb", "g"), "g", "lb"), 5); near(convert("temperature", convert("temperature", 37, "C", "F"), "F", "C"), 37); });
test("zero and negative values", () => { near(convert("length", 0, "km", "mi"), 0); near(convert("length", -2, "km", "m"), -2000); });
test("categories sorted", () => assert.deepEqual(categories(), ["data", "length", "mass", "temperature", "time", "volume"]));
test("unknown category", () => { assert.throws(() => convert("speed", 1, "m", "m"), RangeError); assert.throws(() => listUnits("speed"), RangeError); assert.throws(() => convert("toString", 1, "m", "m"), RangeError); });
test("value must be a finite number", () => { for (const v of ["1", NaN, Infinity, null, undefined]) assert.throws(() => convert("length", v, "m", "km"), TypeError); });
test("type error comes before unit checks", () => assert.throws(() => convert("nope", "x", "a", "b"), TypeError));
test("unit inherited from Object is unknown", () => assert.throws(() => convert("length", 1, "constructor", "m"), RangeError));
