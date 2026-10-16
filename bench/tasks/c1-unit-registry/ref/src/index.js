// Public API. See task.md.
import { registry } from "./registry.js";

function category(name) {
  const c = Object.hasOwn(registry, name) ? registry[name] : undefined;
  if (!c) throw new RangeError(`unknown category ${name}`);
  return c;
}

export function convert(name, value, from, to) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new TypeError("value must be a finite number");
  const c = category(name);
  for (const u of [from, to]) if (!Object.hasOwn(c.units, u)) throw new RangeError(`unknown ${name} unit ${u}`);
  if (c.convert) return c.convert(value, from, to);
  return (value * c.units[from]) / c.units[to];
}

export function categories() {
  return Object.keys(registry).sort();
}

export function listUnits(name) {
  return Object.keys(category(name).units);
}
