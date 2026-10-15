// node --test bench/charts.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderAll } from "./charts.mjs";

const run = (arm, rep, score, tokens, wall, timeline) => ({ arm, rep, score_pct: score, tokens: { total: tokens }, wall_s: wall, task: "t", cap_min: 10, timeline });
const summary = {
  campaigns: [{ manifest: { matrix: { groups: [{ reps: 2 }] } } }],
  runs: ["P-S", "P-O", "O-mix", "O-O"].flatMap((arm, i) => [1, 2].map((rep) => run(arm, rep, 40 + i * 20 + rep, 2e6 + i * 1e6, 300 + i * 20, [[120, 20 + i * 10], [240, 30 + i * 15], [300, 40 + i * 20 + rep]]))),
};

test("renders four charts in light and dark, as complete SVGs with no NaN", () => {
  const out = renderAll(summary, "x");
  assert.equal(Object.keys(out).length, 8);
  for (const [name, svg] of Object.entries(out)) {
    assert.match(name, /^x-(score|timeline|cost|tokens-score)-(light|dark)\.svg$/);
    assert.ok(svg.startsWith("<svg") && svg.trimEnd().endsWith("</svg>"), name);
    assert.match(svg, /<title id="t">.+<\/title>/, name);
    assert.doesNotMatch(svg, /NaN|undefined|Infinity/, name);
  }
});

test("an arm with no runs does not break rendering", () => {
  const out = renderAll({ ...summary, runs: summary.runs.filter((r) => r.arm !== "O-O") }, "y");
  assert.equal(Object.keys(out).length, 8);
});
