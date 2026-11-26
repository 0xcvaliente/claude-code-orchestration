// 2.1.x: the report's tokens and estimated cost by phase (with the orchestrator's own tokens from the main-session
// transcript) and per passed slice.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
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
/**
 * The page from the first of `starts` found up to `end`; fails when no start or the end is missing, so a renamed
 * heading cannot make a helper return nearly the whole page.
 * @param {string} html @param {string[]} starts @param {string} end
 */
const between = (html, starts, end) => {
  const at = starts.map((s) => html.indexOf(s)).find((i) => i >= 0) ?? -1;
  assert.ok(at >= 0, `none of the headings ${starts.join(" | ")} is on the page`);
  const to = html.indexOf(end, at);
  assert.ok(to >= 0, `the end marker ${end} is not on the page after the section`);
  return html.slice(at, to);
};
const PASSED_HEAD = "<h3>Tokens and estimated cost per slice whose latest review passed</h3>";
/** @param {string} html */
const phaseSection = (html) => between(html, ["<h2>Tokens and estimated cost by phase</h2>"], PASSED_HEAD);
/** @param {string} html */
const passedSection = (html) => between(html, [PASSED_HEAD], "<h2>Review time</h2>");
/** The same section under either heading (the one before F1's rename too), for the finding tests. @param {string} html */
const passedAny = (html) => between(html, [PASSED_HEAD, "<h3>Tokens and estimated cost per passed slice</h3>"], "<h2>Review time</h2>");
/** @param {string} html */
const phaseAny = (html) => between(html, ["<h2>Tokens and estimated cost by phase</h2>"], "<h3>Tokens and estimated cost per");
/** @param {string} html */
const kindAny = (html) => between(html, ["<h3>Review outcomes by kind and model</h3>"], "<h2>Reads by kind and role</h2>");
/** A fresh state folder with the three logs. @param {{ tel?: unknown[], launches?: unknown[], journal?: unknown[] }} logs */
const state3 = ({ tel = [], launches = [], journal = [] }) => {
  const dir = mkdtempSync(join(tmpdir(), "orch-report-find-"));
  const state = join(dir, ".claude", "state");
  mkdirSync(state, { recursive: true });
  writeJsonl(join(state, "telemetry.jsonl"), tel);
  writeJsonl(join(state, "journal-launches.jsonl"), launches);
  writeJsonl(join(state, "journal.jsonl"), journal);
  return { dir, state };
};
/** @param {string} id @param {string} type @param {object} [rest] */
const tstop = (id, type, rest = {}) => ({ ts: "2026-11-20T10:00:00Z", session_id: "s1", hook_event_name: "SubagentStop", agent_id: id, agent_type: type, tokens: { input: 0, output: 0.1 * M, cache_read: 0, cache_write: 0 }, models: SONNET, ...rest });
/** @param {string} id @param {string} type @param {string} slice @param {string} ts @param {object} [rest] */
const tlaunch = (id, type, slice, ts, rest = {}) => ({ ts, session_id: "s1", agent_id: id, agent_type: type, slice, isPlanReview: false, ...rest });
/** @param {string} id @param {string} role @param {string} slice @param {number} run @param {string | null} status @param {string} ts @param {object} [rest] */
const tjr = (id, role, slice, run, status, ts, rest = {}) => ({ ts, session_id: "s1", agent_id: id, role, slice, run, status, ...rest });
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
    assert.match(sec, row("main sessions", 1, "200k", "3\\.00"));
    assert.match(sec, /9 subagents at \$10\.00 and 1 main-session transcript: 1\.20M tokens and \$13\.00 in all, at list prices as of \d{4}-\d{2}-\d{2}: an estimate for comparing phases, not a bill/);
    assert.match(sec, /1 main-session transcript was missing or unreadable and skipped/);
    assert.match(sec, /1 agent with no token data on the last stop record left out\./);

    // The subagent phases add up to the cost table's agents and total.
    const phaseRows = [...sec.matchAll(/<tr><td>([a-z ]+)<\/td><td>(\d+)<\/td>(?:<td>[^<]*<\/td>){5}<td>\$([\d.]+)<\/td>/g)].filter((m) => m[1] !== "main sessions");
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

// Findings of the review of the new report sections (fix1). Each test reproduces one finding.

test("report finding F1: a slice whose latest review passed after a failing review of the same attempt carries the marker", () => {
  // A risky slice: the opus reviewer fails it, the default-model reviewer passes it later. The gates fail the slice
  // (any counted fail of the attempt); the table shows it by its latest review and must mark the disagreement.
  const { dir } = state3({
    tel: [tstop("i1", "implementer"), tstop("ro", "reviewer"), tstop("rd", "reviewer"), tstop("j1", "implementer"), tstop("j2", "implementer"), tstop("rf", "reviewer"), tstop("rp", "reviewer")],
    launches: [
      tlaunch("i1", "implementer", "a", "2026-11-20T10:00:00Z"),
      tlaunch("ro", "reviewer", "a", "2026-11-20T10:10:00Z", { model: "opus" }),
      tlaunch("rd", "reviewer", "a", "2026-11-20T10:10:00Z"),
      // Slice b: a failing review, then a new implementer launch (the retry), then a pass: no marker.
      tlaunch("j1", "implementer", "b", "2026-11-20T10:00:00Z"),
      tlaunch("rf", "reviewer", "b", "2026-11-20T10:10:00Z"),
      tlaunch("j2", "implementer", "b", "2026-11-20T10:20:00Z"),
      tlaunch("rp", "reviewer", "b", "2026-11-20T10:30:00Z"),
    ],
    journal: [
      tjr("i1", "implementer", "a", 1, "pass", "2026-11-20T10:05:00Z"),
      tjr("ro", "reviewer", "a", 1, "fail", "2026-11-20T10:15:00Z"),
      tjr("rd", "reviewer", "a", 1, "pass", "2026-11-20T10:16:00Z"),
      tjr("j1", "implementer", "b", 1, "pass", "2026-11-20T10:05:00Z"),
      tjr("rf", "reviewer", "b", 1, "fail", "2026-11-20T10:15:00Z"),
      tjr("j2", "implementer", "b", 1, "pass", "2026-11-20T10:25:00Z"),
      tjr("rp", "reviewer", "b", 1, "pass", "2026-11-20T10:35:00Z"),
    ],
  });
  try {
    const html = renderReport(dir);
    const sec = passedAny(html);
    assert.ok(html.includes(PASSED_HEAD), "the table says what it shows");
    assert.match(sec, /<th>Failing review after latest (launch|attempt)<\/th>/);
    assert.match(sec, /<td>s1<\/td><td>1<\/td><td>a<\/td><td>1<\/td><td>1<\/td><td>2<\/td>(?:<td>[^<]*<\/td>){3}<td>yes<\/td><\/tr>/, sec);
    assert.match(sec, /<td>s1<\/td><td>1<\/td><td>b<\/td><td>2<\/td><td>2<\/td><td>2<\/td>(?:<td>[^<]*<\/td>){3}<td>no<\/td><\/tr>/, sec);
    assert.match(sec, /can differ from the gates' verdict/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report finding F2: a slice carried into a later run keeps the implementers of the earlier run", () => {
  const { dir } = state3({
    tel: [tstop("i1", "implementer"), tstop("p2", "reviewer"), tstop("r2", "reviewer")],
    launches: [
      tlaunch("i1", "implementer", "a", "2026-11-20T10:00:00Z"),
      tlaunch("p2", "reviewer", "plan", "2026-11-20T10:10:00Z", { isPlanReview: true }),
      tlaunch("r2", "reviewer", "a", "2026-11-20T10:20:00Z"),
    ],
    journal: [
      tjr("i1", "implementer", "a", 1, "pass", "2026-11-20T10:05:00Z"),
      tjr("p2", "reviewer", "plan", 2, "pass", "2026-11-20T10:15:00Z"),
      tjr("r2", "reviewer", "a", 2, "pass", "2026-11-20T10:25:00Z"),
    ],
  });
  try {
    const sec = passedAny(renderReport(dir));
    assert.match(sec, /<td>s1<\/td><td>2<\/td><td>a<\/td><td>1<\/td><td>1<\/td><td>1<\/td><td>200k<\/td>/, sec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report finding F7: a later run that reuses a slice id with its own implementer does not take an earlier failed run's agents", () => {
  // Run 1: its own implementer and a failing review (recorded after run 2's launch). Run 2: its own implementer and a
  // passing review. Run 2's passed row holds only run 2's agents.
  const { dir } = state3({
    tel: [tstop("i1", "implementer"), tstop("ra", "reviewer"), tstop("i2", "implementer"), tstop("rb", "reviewer")],
    launches: [
      tlaunch("i1", "implementer", "a", "2026-11-20T10:00:00Z"),
      tlaunch("ra", "reviewer", "a", "2026-11-20T10:10:00Z"),
      tlaunch("i2", "implementer", "a", "2026-11-20T10:20:00Z"),
      tlaunch("rb", "reviewer", "a", "2026-11-20T10:30:00Z"),
    ],
    journal: [
      tjr("i1", "implementer", "a", 1, "pass", "2026-11-20T10:05:00Z"),
      tjr("ra", "reviewer", "a", 1, "fail", "2026-11-20T10:22:00Z"),
      tjr("i2", "implementer", "a", 2, "pass", "2026-11-20T10:25:00Z"),
      tjr("rb", "reviewer", "a", 2, "pass", "2026-11-20T10:35:00Z"),
    ],
  });
  try {
    const sec = passedAny(renderReport(dir));
    assert.match(sec, /<td>s1<\/td><td>2<\/td><td>a<\/td><td>1<\/td><td>1<\/td><td>1<\/td><td>200k<\/td>(?:<td>[^<]*<\/td>){2}<td>no<\/td><\/tr>/, sec);
    assert.equal((sec.match(/<tr><td>s1<\/td>/g) ?? []).length, 1, "only run 2's slice a");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report finding F3: a known-run implementer launch after one with no known run is a retry", () => {
  // i1 stopped at its turn limit: no journal record, so no known run. i2 has one.
  const { dir } = state3({
    tel: [tstop("i1", "implementer"), tstop("i2", "implementer")],
    launches: [tlaunch("i1", "implementer", "a", "2026-11-20T10:00:00Z"), tlaunch("i2", "implementer", "a", "2026-11-20T10:20:00Z")],
    journal: [tjr("i2", "implementer", "a", 1, "pass", "2026-11-20T10:25:00Z")],
  });
  try {
    const sec = phaseAny(renderReport(dir));
    assert.match(sec, /<td>build<\/td><td>1<\/td>/, sec);
    assert.match(sec, /<td>retries<\/td><td>1<\/td>/, sec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report finding F4: the retries note says a resumed attempt writes no launch record", () => {
  const { dir } = fixture();
  try {
    const html = renderReport(dir);
    assert.match(phaseAny(html), /resumes the same agent .*writes no launch record/);
    assert.match(passedAny(html), /resumes the same agent .*writes no launch record/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report finding F5: a reviewer with no model on its stop record takes its launch record's, then its telemetry's", () => {
  const { dir } = state3({
    // r2's telemetry names one model; r3's names two, so it stays unknown.
    tel: [tstop("r1", "reviewer"), tstop("r2", "reviewer", { models: ["claude-opus-5-5"] }), tstop("r3", "reviewer", { models: ["claude-opus-5-5", "claude-sonnet-5-5"] })],
    launches: [tlaunch("r1", "reviewer", "a", "2026-11-20T10:00:00Z", { model: "opus" }), tlaunch("r2", "reviewer", "a", "2026-11-20T10:00:00Z", { model: null }), tlaunch("r3", "reviewer", "a", "2026-11-20T10:00:00Z")],
    journal: [
      tjr("r1", "reviewer", "a", 1, "pass", "2026-11-20T10:05:00Z", { kind: "review" }),
      tjr("r2", "reviewer", "a", 1, "fail", "2026-11-20T10:05:00Z", { kind: "review" }),
      tjr("r3", "reviewer", "a", 1, "pass", "2026-11-20T10:05:00Z", { kind: "review" }),
    ],
  });
  try {
    const sec = kindAny(renderReport(dir));
    /** @param {string} model @param {number} pass @param {number} fail */
    const row = (model, pass, fail) => `<tr><td>review</td><td>${model}</td><td>${pass}</td><td>${fail}</td><td>${pass + fail}</td></tr>`;
    assert.ok(sec.includes(row("opus", 1, 0)), sec);
    assert.ok(sec.includes(row("claude-opus-5-5", 0, 1)), sec);
    assert.ok(sec.includes(row("unknown", 1, 0)), sec);
    assert.match(sec, /launch alias/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report finding F6: a log that exists but cannot be read is named near the top of the page", () => {
  const { dir, state } = fixture();
  try {
    mkdirSync(join(state, "runs.jsonl"));
    mkdirSync(join(state, "gates.jsonl"));
    const html = renderReport(dir);
    const top = html.slice(0, html.indexOf("<h2>Headless runs</h2>"));
    assert.match(top, /could not be read.*<code>runs\.jsonl<\/code>.*<code>gates\.jsonl<\/code>/s, top);
    // A page with every log readable has no such note.
    rmSync(join(state, "runs.jsonl"), { recursive: true });
    rmSync(join(state, "gates.jsonl"), { recursive: true });
    assert.doesNotMatch(renderReport(dir), /could not be read/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Findings of the second review of the new report sections (fix2). Each test reproduces one finding.

test("report finding G1: a failing review before a resumed attempt of the same implementer carries no marker", () => {
  // i1 launched at 10:00, stops at 10:05; the review fails at 10:10; i1 is resumed (no new launch record) and stops
  // again at 10:20; the review passes at 10:30. The fail came before the latest attempt.
  const { dir } = state3({
    tel: [tstop("i1", "implementer"), tstop("rf", "reviewer"), tstop("rp", "reviewer")],
    launches: [
      tlaunch("i1", "implementer", "a", "2026-11-20T10:00:00Z"),
      tlaunch("rf", "reviewer", "a", "2026-11-20T10:06:00Z"),
      tlaunch("rp", "reviewer", "a", "2026-11-20T10:21:00Z"),
    ],
    journal: [
      tjr("i1", "implementer", "a", 1, "pass", "2026-11-20T10:05:00Z"),
      tjr("rf", "reviewer", "a", 1, "fail", "2026-11-20T10:10:00Z"),
      tjr("i1", "implementer", "a", 1, "pass", "2026-11-20T10:20:00Z"),
      tjr("rp", "reviewer", "a", 1, "pass", "2026-11-20T10:30:00Z"),
    ],
  });
  try {
    const sec = passedAny(renderReport(dir));
    assert.match(sec, /<th>Failing review after latest attempt<\/th>/);
    assert.match(sec, /<td>s1<\/td><td>1<\/td><td>a<\/td><td>1<\/td><td>1<\/td><td>2<\/td>(?:<td>[^<]*<\/td>){3}<td>no<\/td><\/tr>/, sec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report finding G2: a message id in two main-session transcripts (a fork or resume) counts once", () => {
  const { dir, state } = state3({});
  const a = join(dir, "a.jsonl");
  const b = join(dir, "b.jsonl");
  /** @param {string} id @param {number} out */
  const msg = (id, out) => ({ type: "assistant", message: { id, model: "claude-sonnet-5-5", usage: { input_tokens: 0, output_tokens: out } } });
  writeJsonl(a, [msg("m1", 100000), msg("m2", 100000)]);
  writeJsonl(b, [msg("m1", 100000), msg("m2", 150000), msg("m3", 100000)]); // the same history, then one more message
  writeJsonl(join(state, "telemetry.jsonl"), [
    { ts: "t", session_id: "s1", hook_event_name: "SubagentStart", agent_id: "x", agent_type: "reviewer", transcript_path: a },
    { ts: "t", session_id: "s2", hook_event_name: "SubagentStart", agent_id: "y", agent_type: "reviewer", transcript_path: b },
  ]);
  try {
    const sec = phaseAny(renderReport(dir));
    // m1 100k, m2 150k (its largest value), m3 100k: 350k at $10 per M output.
    assert.match(sec, /<td>main sessions<\/td><td>2<\/td><td>0<\/td><td>350k<\/td><td>0<\/td><td>0<\/td><td>350k<\/td><td>\$3\.50<\/td><td>0<\/td>/, sec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report finding G3: an implementer launch with no known run makes only the next known-run launch a retry", () => {
  // i1 has no journal record (turn limit), i2 is run 1's retry, i3 is the first implementer of run 2 (same slice id).
  const { dir } = state3({
    tel: [tstop("i1", "implementer"), tstop("i2", "implementer"), tstop("i3", "implementer")],
    launches: [
      tlaunch("i1", "implementer", "a", "2026-11-20T10:00:00Z"),
      tlaunch("i2", "implementer", "a", "2026-11-20T10:20:00Z"),
      tlaunch("i3", "implementer", "a", "2026-11-20T11:00:00Z"),
    ],
    journal: [tjr("i2", "implementer", "a", 1, "pass", "2026-11-20T10:25:00Z"), tjr("i3", "implementer", "a", 2, "pass", "2026-11-20T11:05:00Z")],
  });
  try {
    const sec = phaseAny(renderReport(dir));
    assert.match(sec, /<td>build<\/td><td>2<\/td>/, sec);
    assert.match(sec, /<td>retries<\/td><td>1<\/td>/, sec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report finding G4: the State line names the logs the new sections read, even with no token data", () => {
  const { dir } = state3({
    launches: [tlaunch("r1", "reviewer", "a", "2026-11-20T10:00:00Z", { model: "opus" })],
    journal: [tjr("r1", "reviewer", "a", 1, "pass", "2026-11-20T10:05:00Z", { kind: "review" })],
  });
  try {
    const html = renderReport(dir);
    assert.ok(kindAny(html).includes("<td>opus</td>"), "the kind table used the launch record");
    const state = /<p>State: (.*?)<\/p>/.exec(html)?.[1] ?? "";
    assert.match(state, /journal\.jsonl/, state);
    assert.match(state, /journal-launches\.jsonl/, state);
    assert.equal((state.match(/journal\.jsonl/g) ?? []).length, 1, "each log named once");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Findings of the third review of the new report sections (fix3). Each test reproduces one finding.

test("report finding H1: a carried slice keeps its first-run implementer when the later run launches a fresh one", () => {
  // Run 1: i1 builds slice a, no review of a in run 1. Run 2 (the slice carried by a new plan review): a review fails,
  // a fresh implementer i2 is launched, the next review passes. The row of (run 2, a) holds i1 and i2.
  const { dir } = state3({
    tel: [tstop("i1", "implementer"), tstop("p2", "reviewer"), tstop("ra", "reviewer"), tstop("i2", "implementer"), tstop("rb", "reviewer")],
    launches: [
      tlaunch("i1", "implementer", "a", "2026-11-20T10:00:00Z"),
      tlaunch("p2", "reviewer", "plan", "2026-11-20T10:10:00Z", { isPlanReview: true }),
      tlaunch("ra", "reviewer", "a", "2026-11-20T10:20:00Z"),
      tlaunch("i2", "implementer", "a", "2026-11-20T10:30:00Z"),
      tlaunch("rb", "reviewer", "a", "2026-11-20T10:40:00Z"),
    ],
    journal: [
      tjr("i1", "implementer", "a", 1, "pass", "2026-11-20T10:05:00Z"),
      tjr("p2", "reviewer", "plan", 2, "pass", "2026-11-20T10:15:00Z"),
      tjr("ra", "reviewer", "a", 2, "fail", "2026-11-20T10:25:00Z"),
      tjr("i2", "implementer", "a", 2, "pass", "2026-11-20T10:35:00Z"),
      tjr("rb", "reviewer", "a", 2, "pass", "2026-11-20T10:45:00Z"),
    ],
  });
  try {
    const sec = passedAny(renderReport(dir));
    // Attempts 2, implementers 2, reviewers 2: 400k; the fail came before the latest attempt.
    assert.match(sec, /<td>s1<\/td><td>2<\/td><td>a<\/td><td>2<\/td><td>2<\/td><td>2<\/td><td>400k<\/td>(?:<td>[^<]*<\/td>){2}<td>no<\/td><\/tr>/, sec);
    assert.equal((sec.match(/<tr><td>s1<\/td>/g) ?? []).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report finding H2: an agent with no known run joins a passed slice only when one run has records for that slice id", () => {
  // One session, three tasks that each name their slice x. Task 1: d1 has no stop record (turn limit), i1 is built and
  // its review fails. Task 3: i3 is built and passes. d1 cannot be placed: two runs have records for x.
  const { dir } = state3({
    tel: [tstop("d1", "implementer"), tstop("i1", "implementer"), tstop("ra", "reviewer"), tstop("i3", "implementer"), tstop("rc", "reviewer")],
    launches: [
      tlaunch("d1", "implementer", "x", "2026-11-20T10:00:00Z"),
      tlaunch("i1", "implementer", "x", "2026-11-20T10:10:00Z"),
      tlaunch("ra", "reviewer", "x", "2026-11-20T10:20:00Z"),
      tlaunch("i3", "implementer", "x", "2026-11-20T12:00:00Z"),
      tlaunch("rc", "reviewer", "x", "2026-11-20T12:10:00Z"),
    ],
    journal: [
      tjr("i1", "implementer", "x", 1, "pass", "2026-11-20T10:15:00Z"),
      tjr("ra", "reviewer", "x", 1, "fail", "2026-11-20T10:25:00Z"),
      tjr("i3", "implementer", "x", 3, "pass", "2026-11-20T12:05:00Z"),
      tjr("rc", "reviewer", "x", 3, "pass", "2026-11-20T12:15:00Z"),
    ],
  });
  try {
    const sec = passedAny(renderReport(dir));
    assert.match(sec, /<td>s1<\/td><td>3<\/td><td>x<\/td><td>1<\/td><td>1<\/td><td>1<\/td><td>200k<\/td>/, sec);
    assert.match(sec, /1 agent left out because its run is unknown/, sec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // With only one run that has records for the slice id, the unknown-run agent is attached (and no note).
  const one = state3({
    tel: [tstop("d1", "implementer"), tstop("i3", "implementer"), tstop("rc", "reviewer")],
    launches: [
      tlaunch("d1", "implementer", "x", "2026-11-20T10:00:00Z"),
      tlaunch("i3", "implementer", "x", "2026-11-20T12:00:00Z"),
      tlaunch("rc", "reviewer", "x", "2026-11-20T12:10:00Z"),
    ],
    journal: [tjr("i3", "implementer", "x", 3, "pass", "2026-11-20T12:05:00Z"), tjr("rc", "reviewer", "x", 3, "pass", "2026-11-20T12:15:00Z")],
  });
  try {
    const sec = passedAny(renderReport(one.dir));
    assert.match(sec, /<td>s1<\/td><td>3<\/td><td>x<\/td><td>2<\/td><td>2<\/td><td>1<\/td><td>300k<\/td>/, sec);
    assert.doesNotMatch(sec, /run is unknown/);
  } finally {
    rmSync(one.dir, { recursive: true, force: true });
  }
});

test("report finding H3: the main-session row is named for what it covers, and a too-large transcript is said to be too large", () => {
  const { dir, state } = state3({});
  const main = join(dir, "main.jsonl");
  const big = join(dir, "big.jsonl");
  writeJsonl(main, [{ type: "assistant", message: { id: "m1", model: "claude-sonnet-5-5", usage: { input_tokens: 0, output_tokens: 100000 } } }]);
  // A sparse file past the longest string Node can make: readable, but too large to read in one piece.
  writeFileSync(big, "");
  truncateSync(big, 600 * M);
  writeJsonl(join(state, "telemetry.jsonl"), [
    { ts: "t", session_id: "s1", hook_event_name: "SubagentStart", agent_id: "x", agent_type: "reviewer", transcript_path: main },
    { ts: "t", session_id: "s2", hook_event_name: "SubagentStart", agent_id: "y", agent_type: "reviewer", transcript_path: big },
  ]);
  try {
    const sec = phaseAny(renderReport(dir));
    assert.match(sec, /<td>main sessions<\/td><td>1<\/td><td>0<\/td><td>100k<\/td>/, sec);
    assert.doesNotMatch(sec, /<td>orchestrator<\/td>/);
    assert.match(sec, /main thread of every session that launched a subagent, orchestrator or not/, sec);
    assert.match(sec, /1 main-session transcript was too large to read/, sec);
    assert.doesNotMatch(sec, /missing or unreadable/, sec);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2.2.0: launch records carry `run` (the run at launch). An agent's run is its stop records' run, else its launch
// record's; only an agent with neither is placed by the older rules.

test("report launch run: an implementer with a launch run and no stop record lands in its own run's row and nowhere else", () => {
  // Run 1: d1 hits its turn limit (no stop record; its launch carries run 1), the review passes. Run 2 reuses slice id x
  // with its own implementer and a passing review. Without the launch run d1 was left out (two runs have records for x).
  const { dir } = state3({
    tel: [tstop("d1", "implementer"), tstop("ra", "reviewer"), tstop("i2", "implementer"), tstop("rb", "reviewer")],
    launches: [
      tlaunch("d1", "implementer", "x", "2026-11-20T10:00:00Z", { run: 1 }),
      tlaunch("ra", "reviewer", "x", "2026-11-20T10:20:00Z", { run: 1 }),
      tlaunch("i2", "implementer", "x", "2026-11-20T12:00:00Z", { run: 2 }),
      tlaunch("rb", "reviewer", "x", "2026-11-20T12:10:00Z", { run: 2 }),
    ],
    journal: [
      tjr("ra", "reviewer", "x", 1, "pass", "2026-11-20T10:25:00Z"),
      tjr("i2", "implementer", "x", 2, "pass", "2026-11-20T12:05:00Z"),
      tjr("rb", "reviewer", "x", 2, "pass", "2026-11-20T12:15:00Z"),
    ],
  });
  try {
    const html = renderReport(dir);
    const sec = passedAny(html);
    assert.match(sec, /<tr><td>s1<\/td><td>1<\/td><td>x<\/td><td>1<\/td><td>1<\/td><td>1<\/td><td>200k<\/td>/, sec);
    assert.match(sec, /<tr><td>s1<\/td><td>2<\/td><td>x<\/td><td>1<\/td><td>1<\/td><td>1<\/td><td>200k<\/td>/, sec);
    assert.equal((sec.match(/<tr><td>s1<\/td>/g) ?? []).length, 2, "one row per run");
    assert.doesNotMatch(sec, /run is unknown/, sec);
    assert.match(sec, /else the run its launch record carries/, sec);
    assert.match(sec, /before 2\.2\.0/, sec);
    // A stop record's run wins over the launch record's (a slice carried into a later run is re-homed there).
    const carried = state3({
      tel: [tstop("i1", "implementer"), tstop("rc", "reviewer")],
      launches: [tlaunch("i1", "implementer", "y", "2026-11-20T10:00:00Z", { run: 1 }), tlaunch("rc", "reviewer", "y", "2026-11-20T10:20:00Z", { run: 2 })],
      journal: [tjr("i1", "implementer", "y", 2, "pass", "2026-11-20T10:05:00Z"), tjr("rc", "reviewer", "y", 2, "pass", "2026-11-20T10:25:00Z")],
    });
    try {
      const c = passedAny(renderReport(carried.dir));
      assert.match(c, /<tr><td>s1<\/td><td>2<\/td><td>y<\/td><td>1<\/td><td>1<\/td><td>1<\/td><td>200k<\/td>/, c);
      assert.equal((c.match(/<tr><td>s1<\/td>/g) ?? []).length, 1);
    } finally {
      rmSync(carried.dir, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report launch run: build versus retries uses the launch run, so a later run reusing a slice id starts with a build", () => {
  // d1 (run 1) hit its turn limit: no stop record. i2 is the first implementer of run 2 for the same slice id. Before
  // 2.2.0 the logs could not tell this from a retry of d1; with the launch runs it is a build.
  const withRun = state3({
    tel: [tstop("d1", "implementer"), tstop("i2", "implementer")],
    launches: [tlaunch("d1", "implementer", "a", "2026-11-20T10:00:00Z", { run: 1 }), tlaunch("i2", "implementer", "a", "2026-11-20T11:00:00Z", { run: 2 })],
    journal: [tjr("i2", "implementer", "a", 2, "pass", "2026-11-20T11:05:00Z")],
  });
  try {
    const sec = phaseAny(renderReport(withRun.dir));
    assert.match(sec, /<td>build<\/td><td>2<\/td>/, sec);
    assert.doesNotMatch(sec, /<td>retries<\/td>/, sec);
    assert.match(sec, /else the run its launch record carries/, sec);
    assert.match(sec, /before 2\.2\.0/, sec);
  } finally {
    rmSync(withRun.dir, { recursive: true, force: true });
  }
  // A retry in the same run stays a retry: d1 and i2 both carry run 1.
  const sameRun = state3({
    tel: [tstop("d1", "implementer"), tstop("i2", "implementer")],
    launches: [tlaunch("d1", "implementer", "a", "2026-11-20T10:00:00Z", { run: 1 }), tlaunch("i2", "implementer", "a", "2026-11-20T11:00:00Z", { run: 1 })],
    journal: [tjr("i2", "implementer", "a", 1, "pass", "2026-11-20T11:05:00Z")],
  });
  try {
    const sec = phaseAny(renderReport(sameRun.dir));
    assert.match(sec, /<td>build<\/td><td>1<\/td>/, sec);
    assert.match(sec, /<td>retries<\/td><td>1<\/td>/, sec);
  } finally {
    rmSync(sameRun.dir, { recursive: true, force: true });
  }
  // Records from before 2.2.0 (no launch run) keep the older rule: the same logs count i2 as a retry.
  const old = state3({
    tel: [tstop("d1", "implementer"), tstop("i2", "implementer")],
    launches: [tlaunch("d1", "implementer", "a", "2026-11-20T10:00:00Z"), tlaunch("i2", "implementer", "a", "2026-11-20T11:00:00Z")],
    journal: [tjr("i2", "implementer", "a", 2, "pass", "2026-11-20T11:05:00Z")],
  });
  try {
    const sec = phaseAny(renderReport(old.dir));
    assert.match(sec, /<td>build<\/td><td>1<\/td>/, sec);
    assert.match(sec, /<td>retries<\/td><td>1<\/td>/, sec);
  } finally {
    rmSync(old.dir, { recursive: true, force: true });
  }
});
