// The docs of release 2.1.0 against the code they describe: every copy of the three caps in the maintainer notes and
// the doc pages equals .claude/hooks/limits.mjs, the maintainer notes name the wave switch, the changelog's newest entry
// is the version in package.json and holds no "Known and not fixed" list, docs/limits.md keeps each item 2.1.0 left
// undone, and docs/development.md names the Claude Code CLI version CI installs. Since the later 2.1.0 slices also: the
// second review rule's reason, field and switch (environment only, so the plugin keeps 22 settings), the block reasons
// module, the state of section J and the changelog's 2.1.0 entry naming the additions. Reads files only; no git history.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLAN_SLICE_CAP, RESEARCH_QUESTION_CAP, WAVE_CAP_CEILING, WAVE_CAP_DEFAULT } from "../.claude/hooks/limits.mjs";
import { REVIEW_GATE_BLOCK_REASONS } from "../.claude/hooks/reasons.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (/** @type {string} */ rel) => readFileSync(join(root, rel), "utf8");

/** The changelog entry of one version: from its heading to the next version heading. @param {string} version */
function changelogEntry(version) {
  const text = read("CHANGELOG.md");
  const head = `## [${version}]`;
  const start = text.indexOf(head);
  if (start < 0) return null;
  const next = text.indexOf("\n## [", start + head.length);
  return text.slice(start, next < 0 ? undefined : next);
}

const S = PLAN_SLICE_CAP;
const Q = RESEARCH_QUESTION_CAP;
const W = WAVE_CAP_DEFAULT;
const C = WAVE_CAP_CEILING;

/**
 * Each copy of a cap: a file (or the 2.1.0 changelog entry), a pattern whose groups are numbers, and the value each group
 * must equal. Every pattern must match at least once, and every match must hold the caps.
 * @type {{ file: string, re: RegExp, want: number[] }[]}
 */
const COPIES = [
  { file: "CLAUDE.md", re: /`PLAN_SLICE_CAP` (\d+), `RESEARCH_QUESTION_CAP` (\d+), `WAVE_CAP_DEFAULT` (\d+), `WAVE_CAP_CEILING` (\d+)/g, want: [S, Q, W, C] },
  { file: "CLAUDE.md", re: /`ORCH_WAVE_MAX` \(1 to (\d+)/g, want: [C] },
  { file: "CLAUDE.md", re: /`maxSlices` (\d+), `waveMax` \(default (\d+), 1 to (\d+)\)[^,]*, at most (\d+) questions/g, want: [S, W, C, Q] },
  { file: ".claude/rules/agents.md", re: /`PLAN_SLICE_CAP` \((\d+)\), `RESEARCH_QUESTION_CAP` \((\d+)\), `WAVE_CAP_DEFAULT` \((\d+)\), `WAVE_CAP_CEILING` \((\d+)\)/g, want: [S, Q, W, C] },
  { file: ".claude/rules/agents.md", re: /`args\.waveMax` \(1 to (\d+), else (\d+)\)/g, want: [C, W] },
  { file: "docs/gates.md", re: /\((\d+) slices per plan, (\d+) researcher questions per run, (\d+) implementers at once\)/g, want: [S, Q, W] },
  { file: "docs/gates.md", re: /(\d+) \(`WAVE_CAP_DEFAULT`\), or `ORCH_WAVE_MAX` when it is a whole number from 1 to (\d+) \(`WAVE_CAP_CEILING`\)/g, want: [W, C] },
  { file: "docs/native-mode.md", re: /at most (\d+) researcher questions and plans at most (\d+) slices\. At most (\d+) implementers run at a time/g, want: [Q, S, W] },
  { file: "docs/native-mode.md", re: /`maxSlices` \(default (\d+)\)/g, want: [S] },
  { file: "docs/native-mode.md", re: /at most (\d+) questions; extra questions are dropped/g, want: [Q] },
  { file: "docs/native-mode.md", re: /`waveMax` \(default (\d+)\)/g, want: [W] },
  { file: "docs/native-mode.md", re: /\| `maxSlices`, `maxRetries` \| (\d+), 2 \|/g, want: [S] },
  { file: "docs/native-mode.md", re: /\| `waveMax` \| (\d+) \| [^|]*from 1 to (\d+)/g, want: [W, C] },
  { file: "docs/settings.md", re: /\| `ORCH_WAVE_MAX` \| [^|]+\| (\d+) \| [^|]*from 1 to (\d+)/g, want: [W, C] },
  { file: "docs/glossary.md", re: /at most (\d+) implementers run at a time: with more ready slices the orchestrator launches (\d+)/g, want: [W, W] },
  { file: "docs/glossary.md", re: /(\d+) by default \(`\.claude\/hooks\/limits\.mjs`\)/g, want: [W] },
  { file: "CHANGELOG 2.1.0", re: /Slices per plan (\d+) \(was 6\), researcher questions per run (\d+) \(was 4\), implementers running at once (\d+) by default with a ceiling of (\d+)/g, want: [S, Q, W, C] },
  { file: "CHANGELOG 2.1.0", re: /state (\d+) slices, (\d+) researcher questions and the wave rule: at most (\d+) implementers at a time; with more ready slices, launch (\d+)/g, want: [S, Q, W, W] },
  { file: "CHANGELOG 2.1.0", re: /`maxSlices` defaults to (\d+); the planner asks at most (\d+) research questions/g, want: [S, Q] },
  { file: "CHANGELOG 2.1.0", re: /builds at most (\d+) slices at a time through a bounded pool, set with the new argument `waveMax` \(1 to (\d+)\)/g, want: [W, C] },
];

test("every copy of the caps in the 2.1.0 docs equals limits.mjs", () => {
  for (const { file, re, want } of COPIES) {
    const text = file === "CHANGELOG 2.1.0" ? (changelogEntry("2.1.0") ?? "") : read(file);
    const matches = [...text.matchAll(re)];
    assert.ok(matches.length > 0, `${file}: no copy found for ${re}`);
    for (const m of matches) assert.deepEqual(m.slice(1).map(Number), want, `${file}: ${m[0]}`);
  }
});

test("the maintainer notes name the wave switch", () => {
  for (const file of ["CLAUDE.md", ".claude/rules/agents.md"]) assert.match(read(file), /`ORCH_WAVE_MAX`/, `${file} names ORCH_WAVE_MAX`);
});

test("the changelog's newest entry is package.json's version and holds no Known and not fixed list", () => {
  const { version } = JSON.parse(read("package.json"));
  const text = read("CHANGELOG.md");
  const first = text.match(/^## \[([^\]]+)\]/m);
  assert.equal(first?.[1], version, "the first entry of CHANGELOG.md is package.json's version");
  const entry = changelogEntry(version);
  assert.ok(entry, `CHANGELOG.md has a ${version} entry`);
  assert.doesNotMatch(entry, /known and not fixed/i, `the ${version} entry has no "Known and not fixed" list`);
  assert.match(entry, /docs\/limits\.md/, `the ${version} entry points to docs/limits.md`);
});

test("the changelog keeps 2.0.3's heading below 2.1.0's, links 2.1.0, and links only versions it has", () => {
  const text = read("CHANGELOG.md");
  const at = (/** @type {string} */ v) => text.search(new RegExp(`^## \\[${v.replace(/\./g, "\\.")}\\] - \\d{4}-\\d{2}-\\d{2}$`, "m"));
  assert.ok(at("2.1.0") >= 0, "CHANGELOG.md has a 2.1.0 heading");
  assert.ok(at("2.0.3") > at("2.1.0"), "the 2.0.3 heading follows the 2.1.0 heading");
  assert.match(
    text,
    /^\[2\.1\.0\]: https:\/\/github\.com\/0xcvaliente\/claude-code-orchestration\/releases\/tag\/v2\.1\.0$/m,
    "CHANGELOG.md has a 2.1.0 link definition in the form of the others",
  );
  const headings = new Set([...text.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]));
  for (const m of text.matchAll(/^\[(\d+\.\d+\.\d+)\]: \S+/gm)) {
    assert.ok(headings.has(m[1]), `CHANGELOG.md links ${m[1]}, which has a heading`);
  }
});

test("docs/limits.md keeps each item 2.1.0 left undone", () => {
  const text = read("docs/limits.md");
  assert.match(text, /^# Limits of 2\.1\.0$/m);
  const j = text.slice(text.indexOf("## J. Found in 2.1.0 and not fixed"));
  assert.ok(j.startsWith("## J."), "docs/limits.md has section J");
  for (const phrase of [
    "The suite's wall time depends on the machine's load",
    "skill-*",
    "statusline/statusline.sh",
    "The wave lock's own case is probabilistic",
    "`wave_full` is a brake, not a guarantee",
    "The gate's budget was not raised",
    "Where the gated workflow still differs from the orchestrator's prompt",
    "The status line fix ran on macOS only",
    "about 516 s",
    "**Second review rule**",
    "A refuted failure costs one more review",
    "A resume the logs do not show is not counted",
    "Two reviewers launched at once can use up the reviewer hold",
    "`.claude/hooks/compact-context.mjs`",
    "The pane follows the rule with two differences",
    "The opus wording of the prompts",
  ]) assert.ok(j.includes(phrase), `docs/limits.md, J, names: ${phrase}`);
});

test("docs/limits.md, J: the items this run closed have left, each pointing to its test where it shrank", () => {
  const text = read("docs/limits.md");
  const j = text.slice(text.indexOf("## J. Found in 2.1.0 and not fixed"));
  for (const gone of [
    "The wave lock's own case has no test",
    "The block reasons have no single exporting module",
    "A second reviewer on risky slices",
    "The status line can leave git running",
    "Not fixed in this release; the suite probes page proposes two fixes",
  ]) assert.ok(!j.includes(gone), `docs/limits.md, J, no longer names: ${gone}`);
  for (const test of ["src/plan-check-wave.test.mjs", "src/statusline.test.ts", "src/second-review.test.mjs"]) {
    assert.ok(j.includes(test), `docs/limits.md, J, points to ${test}`);
  }
});

test("the second review rule: its reason, field and switch are in the docs, the switch environment only with 22 settings", () => {
  assert.ok(REVIEW_GATE_BLOCK_REASONS.includes("second_review_required"), "reasons.mjs lists second_review_required");
  for (const file of ["docs/gates.md", "docs/logs.md", "docs/brief-grammar.md", "docs/glossary.md", "CHANGELOG.md", "CLAUDE.md", ".claude/rules/agents.md"]) {
    assert.match(read(file), /`second_review_required`/, `${file} names second_review_required`);
  }
  for (const file of ["docs/logs.md", "docs/brief-grammar.md", "docs/gates.md", "CLAUDE.md", ".claude/rules/agents.md"]) {
    assert.match(read(file), /`reviews_needed`/, `${file} names the field reviews_needed`);
  }
  for (const file of ["CLAUDE.md", ".claude/rules/agents.md", "docs/settings.md", "docs/gates.md"]) {
    assert.match(read(file), /`ORCH_SECOND_REVIEW/, `${file} names ORCH_SECOND_REVIEW`);
  }
  const row = read("docs/settings.md").split("\n").find((l) => l.startsWith("| `ORCH_SECOND_REVIEW` |"));
  assert.ok(row, "docs/settings.md has a row for ORCH_SECOND_REVIEW");
  assert.match(row, /Environment only: there is no plugin setting for it, so the plugin keeps 22\./);
  assert.match(read("docs/settings.md"), /The plugin declares 22 \[plugin settings\]/);
  const { userConfig } = JSON.parse(read("dist/plugin/.claude-plugin/plugin.json"));
  assert.equal(Object.keys(userConfig).length, 22, "the built plugin declares 22 settings");
  assert.ok(!Object.keys(userConfig).some((k) => /second/i.test(k)), "no plugin setting for the second review rule");
  assert.match(read("docs/dashboard.md"), /`review N\/2`/, "docs/dashboard.md describes the review N/2 mark");
  assert.match(read("docs/native-mode.md"), /Two reviews for a RISKY slice \(2\.1\.0\)/);
});

test("the block reasons module is named in the maintainer notes and the contributor rules", () => {
  for (const file of ["CLAUDE.md", ".claude/rules/agents.md", "docs/development.md", "docs/glossary.md"]) {
    assert.match(read(file), /`\.claude\/hooks\/reasons\.mjs`/, `${file} names .claude/hooks/reasons.mjs`);
  }
  assert.match(read("docs/development.md"), /A new block reason \(2\.1\.0\)/);
});

test("the changelog's 2.1.0 entry names the later additions", () => {
  const entry = changelogEntry("2.1.0") ?? "";
  for (const phrase of [
    "**A second reviewer on risky slices**",
    "`second_review_required`",
    "`reviews_needed`",
    "`ORCH_SECOND_REVIEW=off`",
    "so the plugin keeps 22",
    "`src/second-review.test.mjs`",
    "**One list of block reasons** (`.claude/hooks/reasons.mjs`",
    "`src/reasons.test.mjs`",
    "`review N/2`",
    "**The prompts for a risky slice**",
    "**The wave lock has its own tests**",
    "**The status line no longer leaves git running.**",
  ]) assert.ok(entry.includes(phrase), `the 2.1.0 entry names: ${phrase}`);
});

test("docs/development.md names the Claude Code CLI version CI installs", () => {
  const ci = read(".github/workflows/ci.yml").match(/@anthropic-ai\/claude-code@(\d+\.\d+\.\d+)/);
  assert.ok(ci, "ci.yml installs a pinned Claude Code CLI");
  assert.ok(read("docs/development.md").includes(`Claude Code CLI (${ci[1]})`), `docs/development.md names CLI ${ci[1]}`);
});
