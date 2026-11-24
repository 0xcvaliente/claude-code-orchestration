import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PLAN_CHECK_BLOCK_REASONS, REVIEW_GATE_BLOCK_REASONS } from "../.claude/hooks/reasons.mjs";

// The pane (dashboard/register.tsx) cannot import .claude/hooks/reasons.mjs: dist/dashboard ships only register.tsx and
// hooks.json. So this test reads its GATE_REASONS from the source text and holds it to the module.

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (/** @type {string} */ rel) => readFileSync(join(root, rel), "utf8");

/**
 * Module reasons the pane does not show, each with why. Empty today: every block reason has a code the pane names.
 * @type {Record<string, string>}
 */
const PANE_EXCEPTIONS = {};

/** The string literals of `const GATE_REASONS = [ ... ]` in a register.tsx text. @param {string} text @returns {string[]} */
function gateReasonsOf(text) {
  const m = text.match(/const GATE_REASONS = \[([\s\S]*?)\]/);
  assert.ok(m, "register.tsx declares GATE_REASONS");
  const body = String(m[1]).replace(/\/\/[^\n]*/g, "");
  const items = [...body.matchAll(/'([a-z_]+)'/g)].map((x) => String(x[1]));
  assert.ok(items.length > 0, "GATE_REASONS has entries");
  return items;
}

/** The reason codes `GATE_PHRASES` maps a message to. @param {string} text @returns {Set<string>} */
function gatePhraseReasonsOf(text) {
  const m = text.match(/const GATE_PHRASES[^=]*= \[([\s\S]*?)\n\]/);
  assert.ok(m, "register.tsx declares GATE_PHRASES");
  return new Set([...String(m[1]).matchAll(/,\s*'([a-z_]+)'\]/g)].map((x) => String(x[1])));
}

const ALL = [...new Set([...PLAN_CHECK_BLOCK_REASONS, ...REVIEW_GATE_BLOCK_REASONS])];

test("reasons.mjs exports two frozen, non-empty lists of reason codes", () => {
  for (const list of [PLAN_CHECK_BLOCK_REASONS, REVIEW_GATE_BLOCK_REASONS]) {
    assert.ok(Object.isFrozen(list));
    assert.ok(list.length > 0);
    for (const r of list) assert.match(r, /^[a-z]+(?:_[a-z]+)+$/);
  }
});

test("reasons.mjs imports nothing and loads alone", async () => {
  const src = read(".claude/hooks/reasons.mjs");
  assert.doesNotMatch(src, /^\s*import\b|\bimport\(|\brequire\(/m);
  const dir = mkdtempSync(join(tmpdir(), "reasons-"));
  copyFileSync(join(root, ".claude/hooks/reasons.mjs"), join(dir, "reasons.mjs"));
  const mod = await import(pathToFileURL(join(dir, "reasons.mjs")).href);
  assert.deepEqual([...mod.PLAN_CHECK_BLOCK_REASONS], [...PLAN_CHECK_BLOCK_REASONS]);
  assert.deepEqual([...mod.REVIEW_GATE_BLOCK_REASONS], [...REVIEW_GATE_BLOCK_REASONS]);
});

test("the pane's GATE_REASONS names every block reason of reasons.mjs, or the test says why not", () => {
  const pane = new Set(gateReasonsOf(read("dashboard/register.tsx")));
  for (const r of ALL) {
    if (Object.hasOwn(PANE_EXCEPTIONS, r)) assert.ok(!pane.has(r), `${r} is on the exception list but the pane names it: drop the exception`);
    else assert.ok(pane.has(r), `dashboard/register.tsx GATE_REASONS lacks ${r}`);
  }
  for (const r of Object.keys(PANE_EXCEPTIONS)) assert.ok(ALL.includes(r), `exception ${r} is not a reason of reasons.mjs`);
  // agents_running is an allow (the review gate defers), not a block reason, and the pane keeps it.
  assert.ok(pane.has("agents_running"), "GATE_REASONS keeps agents_running");
  assert.ok(!ALL.includes("agents_running"), "agents_running is not a block reason");
  // Nothing else: every pane entry is a module reason or agents_running.
  for (const r of pane) assert.ok(r === "agents_running" || ALL.includes(r), `GATE_REASONS names ${r}, which reasons.mjs does not list`);
});

test("every block reason the pane names has a phrase in GATE_PHRASES for messages that do not carry the code", () => {
  const text = read("dashboard/register.tsx");
  const phrased = gatePhraseReasonsOf(text);
  for (const r of ALL) if (!Object.hasOwn(PANE_EXCEPTIONS, r)) assert.ok(phrased.has(r), `GATE_PHRASES has no phrase for ${r}`);
});

test("the shipped pane (dist/dashboard) carries the same GATE_REASONS", () => {
  const src = gateReasonsOf(read("dashboard/register.tsx"));
  assert.deepEqual(gateReasonsOf(read("dist/dashboard/hooks/register.tsx")), src);
});
