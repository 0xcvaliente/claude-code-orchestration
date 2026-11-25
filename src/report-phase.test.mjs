// 2.1.x: the report's tokens and estimated cost by phase (with the orchestrator's own tokens from the main-session
// transcript) and per passed slice.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const M = 1_000_000;
const SONNET = ["claude-sonnet-5-5"]; // output $10 per M

/** @param {string} dir @returns {string} the report's HTML */
const renderReport = (dir) => {
  const r = spawnSync("node", [join(root, "scripts", "report.mjs"), dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(join(dir, ".claude", "state", "report.html"), "utf8");
};
/** @param {string} html */
const phaseSection = (html) => html.slice(html.indexOf("<h2>Tokens and estimated cost by phase</h2>"), html.indexOf("<h3>Tokens and estimated cost per passed slice</h3>"));
/** @param {string} html */
const passedSection = (html) => html.slice(html.indexOf("<h3>Tokens and estimated cost per passed slice</h3>"), html.indexOf("<h2>Review time</h2>"));
/** @param {string} file @param {unknown[]} rows */
const writeJsonl = (file, rows) => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));

/** A fixture state folder: every phase, a retry, an unassigned agent, background_tasks, a main transcript and a missing one. */
const fixture = () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-report-phase-"));
  const state = join(dir, ".claude", "state");
  mkdirSync(state, { recursive: true });
  const main = join(dir, "main.jsonl");
  const missing = join(dir, "gone.jsonl");
  /** @param {string} id @param {string} type @param {number} out @param {object} [rest] */
  const stop = (id, type, out, rest = {}) => ({
    ts: "t", session_id: "s1", hook_event_name: "SubagentStop", agent_id: id, agent_type: type, transcript_path: main,
    tokens: { input: 0, output: out * M, cache_read: 0, cache_write: 0 }, models: SONNET, ...rest,
  });
  const tel = [
    { ts: "t", session_id: "s1", hook_event_name: "SubagentStart", agent_id: "p1", agent_type: "reviewer", transcript_path: missing },
    stop("p1", "reviewer", 0.1),
    stop("q1", "orchestration:researcher", 0.1),
    stop("i1", "implementer", 0.1), // an earlier running total: replaced by its last stop
    // A stop record embeds other agents under background_tasks: only top-level fields count.
    stop("i1", "orchestration:implementer", 0.2, { background_tasks: [{ agent_id: "r1", agent_type: "reviewer", tokens: { output: 9 * M }, models: SONNET }] }),
    stop("i2", "implementer", 0.1),
    stop("i3", "implementer", 0.1),
    stop("r1", "reviewer", 0.1),
    stop("r2", "reviewer", 0.1),
    stop("g1", "integrator", 0.1),
    stop("u1", "reviewer", 0.1, { background_tasks: [{ agent_id: "i9", agent_type: "implementer", tokens: { output: 9 * M } }] }), // no launch record
    stop("n1", "reviewer", 0, { tokens: undefined }), // no token data: left out and noted
  ];
  writeJsonl(join(state, "telemetry.jsonl"), tel);
  /** @param {string} id @param {string} type @param {string} slice @param {object} [rest] */
  const launch = (id, type, slice, rest = {}) => ({ ts: "t", session_id: "s1", agent_id: id, agent_type: type, slice, isPlanReview: false, ...rest });
  writeJsonl(join(state, "journal-launches.jsonl"), [
    launch("p1", "reviewer", "plan", { isPlanReview: true }),
    launch("q1", "researcher", "q"),
    launch("i1", "implementer", "a"),
    launch("i3", "implementer", "b"),
    launch("i2", "implementer", "a"), // the second implementer launch of slice a: a retry
    launch("r1", "reviewer", "a"),
    launch("r2", "reviewer", "b"),
    launch("g1", "integrator", "merge"),
  ]);
  /** @param {string} id @param {string} role @param {string} slice @param {string} status */
  const jr = (id, role, slice, status) => ({ ts: "t", session_id: "s1", agent_id: id, role, slice, run: 1, status });
  writeJsonl(join(state, "journal.jsonl"), [
    jr("p1", "reviewer", "plan", "pass"),
    jr("i1", "implementer", "a", "fail"),
    jr("i2", "implementer", "a", "pass"),
    jr("i3", "implementer", "b", "pass"),
    jr("r1", "reviewer", "a", "pass"),
    jr("r2", "reviewer", "b", "fail"), // a failed slice: left out of the per-slice table
  ]);
  /** @param {string} id @param {string} model @param {number} out @param {object} [rest] */
  const msg = (id, model, out, rest = {}) => ({ type: "assistant", message: { id, model, usage: { input_tokens: 0, output_tokens: out } }, ...rest });
  writeJsonl(main, [
    { type: "user", message: { content: "go" } },
    msg("m1", "claude-opus-5-5", 50000), // the same message streamed twice: its largest value counts
    msg("m1", "claude-opus-5-5", 100000),
    msg("m2", "claude-sonnet-5-5", 100000),
    msg("m3", "<synthetic>", 5 * M), // skipped
    msg("m4", "claude-sonnet-5-5", 5 * M, { isSidechain: true }), // a subagent's line: skipped
  ]);
  return { dir, state, main };
};

test("report phase: tokens and estimated cost per phase, the orchestrator from the main transcript, and the same subagents as the cost table", () => {
  const { dir } = fixture();
  try {
    const html = renderReport(dir);
    const sec = phaseSection(html);
    assert.ok(html.indexOf("<h2>Estimated cost by role and model</h2>") < html.indexOf("<h2>Tokens and estimated cost by phase</h2>"));
    assert.match(sec, /<th>Phase<\/th><th>Agents<\/th><th>Input<\/th><th>Output<\/th><th>Cache read<\/th><th>Cache write<\/th><th>Total tokens<\/th><th>Est\. cost \(list prices\)<\/th><th>Not priced<\/th>/);
    /** @param {string} phase @param {number} agents @param {string} out @param {string} cost */
    const row = (phase, agents, out, cost) => new RegExp(`<td>${phase}</td><td>${agents}</td><td>0</td><td>${out}</td><td>0</td><td>0</td><td>${out}</td><td>\\$${cost}</td><td>0</td>`);
    assert.match(sec, row("plan review", 1, "100k", "1\\.00"));
    assert.match(sec, row("explore", 1, "100k", "1\\.00"));
    assert.match(sec, row("build", 2, "300k", "3\\.00")); // i1 at its last total (0.2M) and i3
    assert.match(sec, row("retries", 1, "100k", "1\\.00"));
    assert.match(sec, row("review", 2, "200k", "2\\.00")); // r1 and r2; the plan review is not here
    assert.match(sec, row("integrate", 1, "100k", "1\\.00"));
    assert.match(sec, row("unassigned", 1, "100k", "1\\.00")); // u1; its background_tasks add nothing
    // Main session: m1 on opus (100k out, $2) and m2 on sonnet (100k out, $1).
    assert.match(sec, row("orchestrator", 1, "200k", "3\\.00"));
    assert.match(sec, /9 subagents at \$10\.00 and 1 main-session transcript: 1\.20M tokens and \$13\.00 in all, at list prices as of \d{4}-\d{2}-\d{2}: an estimate for comparing phases, not a bill/);
    assert.match(sec, /1 main-session transcript was missing or unreadable and skipped/);
    assert.match(sec, /1 agent with no token data on the last stop record left out\./);

    // The subagent phases add up to the cost table's agents and total.
    const phaseRows = [...sec.matchAll(/<tr><td>([a-z ]+)<\/td><td>(\d+)<\/td>(?:<td>[^<]*<\/td>){5}<td>\$([\d.]+)<\/td>/g)].filter((m) => m[1] !== "orchestrator");
    assert.equal(phaseRows.reduce((a, m) => a + Number(m[2]), 0), 9);
    const phaseCost = phaseRows.reduce((a, m) => a + Number(m[3]), 0);
    const costTotal = Number(/Total \$([\d.]+) at list prices/.exec(html)?.[1]);
    assert.equal(phaseCost.toFixed(2), costTotal.toFixed(2));
    assert.match(html, /<td>reviewer<\/td><td>claude-sonnet-5-5<\/td><td>4<\/td>/, "the cost table also counts p1, r1, r2 and u1 once each");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report phase: per passed slice, implementers and reviewers with attempts; a failed slice is left out", () => {
  const { dir } = fixture();
  try {
    const sec = passedSection(renderReport(dir));
    assert.match(sec, /<th>Session<\/th><th>Run<\/th><th>Slice<\/th><th>Attempts<\/th><th>Implementers<\/th><th>Reviewers<\/th><th>Tokens<\/th><th>Est\. cost \(list prices\)<\/th><th>Not priced<\/th>/);
    // Slice a: i1 (200k) and i2 (100k), r1 (100k): 400k, $4.00, two attempts.
    assert.match(sec, /<td>s1<\/td><td>1<\/td><td>a<\/td><td>2<\/td><td>2<\/td><td>1<\/td><td>400k<\/td><td>\$4\.00<\/td><td>0<\/td>/);
    assert.equal((sec.match(/<tr><td>s1<\/td>/g) ?? []).length, 1, "only slice a");
    assert.doesNotMatch(sec, /<td>(b|plan|merge)<\/td>/);
    assert.match(sec, /at list prices as of \d{4}-\d{2}-\d{2}: an estimate, not a bill/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report phase: empty, missing and unreadable logs give a note, never a crash", () => {
  const { dir, state } = fixture();
  try {
    // No launch records: every subagent is unassigned, and no slice can be counted.
    rmSync(join(state, "journal-launches.jsonl"));
    let html = renderReport(dir);
    assert.match(phaseSection(html), /<td>unassigned<\/td><td>9<\/td>/);
    assert.match(phaseSection(html), /No launch records \(<code>journal-launches\.jsonl<\/code>\), so every subagent is unassigned\./);
    assert.match(passedSection(html), /No launch records/);

    // An unreadable launch log (a folder in its place): counted as empty and said so.
    mkdirSync(join(state, "journal-launches.jsonl"));
    html = renderReport(dir);
    assert.match(phaseSection(html), /<code>journal-launches\.jsonl<\/code> could not be read and counts as empty\./);
    rmSync(join(state, "journal-launches.jsonl"), { recursive: true });

    // Empty telemetry and journal, the main transcript gone: one line each.
    writeFileSync(join(state, "telemetry.jsonl"), "");
    rmSync(join(state, "journal.jsonl"));
    html = renderReport(dir);
    assert.match(phaseSection(html), /No token data yet/);
    assert.doesNotMatch(phaseSection(html), /<table>/);
    assert.match(passedSection(html), /No journal yet \(<code>journal\.jsonl<\/code>\), so passed slices cannot be counted\./);

    // Only a stop record whose transcript is missing: the skipped count, no table.
    writeJsonl(join(state, "telemetry.jsonl"), [{ ts: "t", session_id: "s1", hook_event_name: "SubagentStop", agent_id: "x", agent_type: "reviewer", transcript_path: join(dir, "nope.jsonl") }]);
    html = renderReport(dir);
    assert.match(phaseSection(html), /No token data yet.*1 main-session transcript was missing or unreadable and skipped/s);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
