// 2.1.x: a reviewer's stop record in journal.jsonl carries `kind` (plan, validate or review) and `model` (from its
// launch record), added fields only: no gate reads them and records with and without them fold alike. The report counts
// review outcomes by kind and model, and splits build from retries per session, run and slice. Spec: docs/logs.md.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { reviewFields } from "../.claude/hooks/brief.mjs";
import { sessionRuns } from "../.claude/hooks/run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const M = 1_000_000;

/** @param {string} file @param {unknown[]} rows */
const writeJsonl = (file, rows) => writeFileSync(file, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
/** @param {string} file @returns {any[]} */
const readJsonl = (file) => {
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
};

/** A scratch project with the real journal hook; no agent files, so a launch without `model` has no model on record. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), "orch-review-kind-"));
  const state = join(dir, ".claude", "state");
  mkdirSync(state, { recursive: true });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: "" };
  /** @param {object} payload */
  const journal = (payload) => {
    const r = spawnSync("node", [join(root, ".claude", "hooks", "journal.mjs")], { input: JSON.stringify({ session_id: "s1", ...payload }), env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  /** @param {string} id @param {string} type @param {string} prompt @param {string} [model] */
  const launch = (id, type, prompt, model) =>
    journal({
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: `orchestration:${type}`, prompt, ...(model ? { model } : {}) },
      tool_response: { status: "async_launched", agentId: id },
    });
  /** @param {string} id @param {string} type @param {string} reply @param {object} [rest] */
  const stop = (id, type, reply, rest = {}) => journal({ hook_event_name: "SubagentStop", agent_id: id, agent_type: `orchestration:${type}`, last_assistant_message: reply, cwd: dir, ...rest });
  const stops = () => readJsonl(join(state, "journal.jsonl"));
  /** @param {string} id */
  const stopOf = (id) => stops().filter((r) => r.agent_id === id).at(-1);
  return { dir, state, launch, stop, stops, stopOf };
}

const PLAN = "PLAN REVIEW\nCONSTRAINTS:\nC1: no paid command\nSLICE: a\nFILES: src/a.mjs\nDEPENDS: none\nGOAL: build a\nRISKY: yes\nCHECKS: C1";

test("journal: a plan review, a gap validation and an ordinary review each get their kind; model from the launch", () => {
  const p = project();
  try {
    p.launch("p1", "reviewer", PLAN, "opus");
    p.stop("p1", "reviewer", "STATUS: pass\nOPEN: none");
    p.launch("v1", "reviewer", "SLICE: a\nVALIDATE: gaps\nCheck these gaps.", "sonnet");
    p.stop("v1", "reviewer", "STATUS: fail\nGAP: 90 the test is missing\nOPEN: none");
    p.launch("r1", "reviewer", "SLICE: a\nCHECKS: C1\nC1: no paid command\nReview the diff.");
    p.stop("r1", "reviewer", "STATUS: pass\nC1: pass (read) a.mjs:1\nOPEN: none");

    assert.equal(p.stopOf("p1")?.kind, "plan");
    assert.equal(p.stopOf("p1")?.model, "opus");
    assert.equal(p.stopOf("v1")?.kind, "validate");
    assert.equal(p.stopOf("v1")?.model, "sonnet");
    assert.equal(p.stopOf("r1")?.kind, "review");
    assert.equal("model" in (p.stopOf("r1") ?? {}), false, "no model on record: left out");
    // The existing fields keep their names and values.
    assert.equal(p.stopOf("v1")?.status, "fail");
    assert.equal(p.stopOf("r1")?.slice, "a");
    assert.equal(p.stopOf("p1")?.slice, "plan");
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("journal: an implementer's stop record gains neither field", () => {
  const p = project();
  try {
    p.launch("i1", "implementer", "SLICE: a\nFILES: src/a.mjs\nDEPENDS: none\nBuild a.", "opus");
    p.stop("i1", "implementer", "STATUS: pass\nOPEN: none");
    const rec = p.stopOf("i1");
    assert.ok(rec, "the implementer has a stop record");
    assert.equal("kind" in rec, false);
    assert.equal("model" in rec, false);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("journal: a stop that waits for its launch gets both fields when the launch arrives; no launch: kind from the brief, no model", () => {
  const p = project();
  try {
    // Foreground: the stop comes first (no transcript, no launch: it waits in journal-pending.jsonl).
    p.stop("v2", "reviewer", "STATUS: pass\nOPEN: none");
    assert.equal(p.stopOf("v2"), undefined);
    p.launch("v2", "reviewer", "SLICE: b\nVALIDATE: gaps", "opus");
    assert.equal(p.stopOf("v2")?.kind, "validate");
    assert.equal(p.stopOf("v2")?.model, "opus");
    assert.equal(p.stopOf("v2")?.slice, "b");

    // No launch record, a transcript holding the brief: kind from the brief, model unknown.
    const transcript = join(p.dir, "t.jsonl");
    writeJsonl(transcript, [{ type: "user", message: { content: "SLICE: c\nVALIDATE: gaps\nCheck." } }]);
    p.stop("v3", "reviewer", "STATUS: pass\nOPEN: none", { agent_transcript_path: transcript });
    assert.equal(p.stopOf("v3")?.kind, "validate");
    assert.equal("model" in (p.stopOf("v3") ?? {}), false);

    // A launch record of another session is not this stop's: neither field from it.
    const launches = join(p.state, "journal-launches.jsonl");
    writeFileSync(launches, readFileSync(launches, "utf8") + JSON.stringify({ ts: new Date().toISOString(), session_id: "s0", agent_id: "x1", agent_type: "reviewer", slice: "d", model: "opus", isPlanReview: false, validate: false }) + "\n");
    p.stop("x1", "reviewer", "STATUS: pass\nOPEN: none");
    const x = p.stopOf("x1");
    assert.ok(x);
    assert.equal("kind" in x, false);
    assert.equal("model" in x, false);
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
  }
});

test("reviewFields: unknown or odd input leaves fields out and never throws", () => {
  assert.deepEqual(reviewFields(undefined), {});
  assert.deepEqual(reviewFields(null, null), {});
  assert.deepEqual(reviewFields("text"), {});
  assert.deepEqual(reviewFields({ slice: "a" }), {}, "a launch record from before `validate`: kind unknown");
  assert.deepEqual(reviewFields({ slice: "a", validate: false, model: "" }), { kind: "review" });
  assert.deepEqual(reviewFields({ slice: "plan", model: "opus" }), { kind: "plan", model: "opus" });
  assert.deepEqual(reviewFields(undefined, "PLAN REVIEW\n"), { kind: "plan" });
  assert.deepEqual(reviewFields(undefined, "SLICE: a"), { kind: "review" });
  const hostile = new Proxy({}, { get() { throw new Error("boom"); } });
  assert.deepEqual(reviewFields(hostile), {});
});

test("fold: a journal with the new fields and the same journal without them give the same runs for the gates", () => {
  const p = project();
  const old = mkdtempSync(join(tmpdir(), "orch-review-kind-old-"));
  try {
    p.launch("p1", "reviewer", PLAN, "opus");
    p.stop("p1", "reviewer", "STATUS: pass\nOPEN: none");
    p.launch("i1", "implementer", "SLICE: a\nFILES: src/a.mjs\nDEPENDS: none\nRISKY: yes\nCHECKS: C1\nC1: no paid command", "opus");
    p.stop("i1", "implementer", "STATUS: pass\nC1: pass (cmd) grep -> none\nOPEN: none");
    p.launch("r1", "reviewer", "SLICE: a\nCHECKS: C1\nC1: no paid command", "sonnet");
    p.stop("r1", "reviewer", "STATUS: fail\nC1: pass (cmd) grep -> none\nGAP: 40 a nit\nOPEN: none");
    p.launch("v1", "reviewer", "SLICE: a\nVALIDATE: gaps", "sonnet");
    p.stop("v1", "reviewer", "STATUS: pass\nOPEN: none");
    p.launch("r2", "reviewer", "SLICE: a\nCHECKS: C1\nC1: no paid command", "opus");
    p.stop("r2", "reviewer", "STATUS: pass\nC1: pass (cmd) grep -> none\nOPEN: none");
    p.launch("r3", "reviewer", "SLICE: a\nCHECKS: C1\nC1: no paid command");
    p.stop("r3", "reviewer", "STATUS: pass\nC1: pass (cmd) grep -> none\nOPEN: none");

    const stops = p.stops();
    const reviewers = stops.filter((r) => r.role === "reviewer");
    assert.equal(reviewers.length, 5);
    assert.ok(reviewers.every((r) => typeof r.kind === "string"), "every new reviewer record carries kind");
    assert.equal(reviewers.filter((r) => typeof r.model === "string").length, 4, "r3 has no model on record");

    // The old journal: the same records without the two fields, every other log identical.
    const oldState = join(old, ".claude", "state");
    mkdirSync(oldState, { recursive: true });
    for (const name of ["journal-launches.jsonl"]) writeFileSync(join(oldState, name), readFileSync(join(p.state, name), "utf8"));
    writeJsonl(join(oldState, "journal.jsonl"), stops.map(({ kind: _k, model: _m, ...rest }) => rest));

    const now = Date.now();
    for (const env of [{}, { ORCH_ESCALATION: "always" }, { ORCH_ESCALATION: "off" }, { ORCH_SECOND_REVIEW: "off" }]) {
      const a = sessionRuns("s1", { dir: p.state, now, env });
      const b = sessionRuns("s1", { dir: oldState, now, env });
      assert.deepEqual(JSON.parse(JSON.stringify({ runs: a.runs, open: a.open })), JSON.parse(JSON.stringify({ runs: b.runs, open: b.open })), JSON.stringify(env));
    }
    // What the gates read of slice a: the opus pass from the launch model in both folds.
    const sa = sessionRuns("s1", { dir: oldState, now, env: {} }).runs.at(-1)?.slices.a;
    assert.ok(sa?.reviews.some((r) => r.model === "opus" && r.status === "pass"));
  } finally {
    rmSync(p.dir, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
});

/** @param {string} dir @returns {string} the report's HTML */
const renderReport = (dir) => {
  const r = spawnSync("node", [join(root, "scripts", "report.mjs"), dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return readFileSync(join(dir, ".claude", "state", "report.html"), "utf8");
};
/** @param {string} html */
const kindSection = (html) => html.slice(html.indexOf("<h3>Review outcomes by kind and model</h3>"), html.indexOf("<h2>Reads by kind and role</h2>"));

test("report: review outcomes by kind and model, kind-less records in the note, a continued record counted once", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-report-kind-"));
  try {
    const state = join(dir, ".claude", "state");
    mkdirSync(state, { recursive: true });
    /** @param {string} id @param {string | null} status @param {object} [rest] */
    const rv = (id, status, rest = {}) => ({ ts: "t", session_id: "s1", agent_id: id, role: "reviewer", slice: "a", run: 1, status, answers: {}, open: [], ...rest });
    writeJsonl(join(state, "journal.jsonl"), [
      rv("p1", "pass", { slice: "plan", kind: "plan", model: "claude-opus-5-5" }),
      rv("v1", "fail", { kind: "validate", model: "claude-sonnet-5-5" }),
      rv("r1", "pass", { kind: "review", model: "claude-sonnet-5-5" }),
      rv("r2", "fail", { kind: "review", model: "claude-sonnet-5-5" }),
      rv("r2", "pass", { kind: "review", model: "claude-sonnet-5-5", continues: true }), // the same reply: replaces the fail
      rv("r3", null, { kind: "review" }), // no model, no status
      rv("o1", "pass"), // written before the field
      rv("o2", "fail", { kind: "other" }), // not a kind this table knows
      { ts: "t", session_id: "s1", agent_id: "i1", role: "implementer", slice: "a", run: 1, status: "pass" },
      "not an object",
    ]);
    writeFileSync(join(state, "telemetry.jsonl"), "");
    const sec = kindSection(renderReport(dir));
    assert.match(sec, /<th>Kind<\/th><th>Model<\/th><th>Pass<\/th><th>Fail<\/th><th>Total<\/th>/);
    /** @param {string} kind @param {string} model @param {number} pass @param {number} fail @param {number} total */
    const row = (kind, model, pass, fail, total) => `<tr><td>${kind}</td><td>${model}</td><td>${pass}</td><td>${fail}</td><td>${total}</td></tr>`;
    assert.ok(sec.includes(row("plan", "claude-opus-5-5", 1, 0, 1)), sec);
    assert.ok(sec.includes(row("validate", "claude-sonnet-5-5", 0, 1, 1)), sec);
    assert.ok(sec.includes(row("review", "claude-sonnet-5-5", 2, 0, 2)), "r2 counts once, as its continued pass");
    assert.ok(sec.includes(row("review", "unknown", 0, 0, 1)), sec);
    assert.equal((sec.match(/<tr><td>/g) ?? []).length, 4);
    assert.ok(sec.indexOf("<td>plan</td>") < sec.indexOf("<td>validate</td>") && sec.indexOf("<td>validate</td>") < sec.indexOf("<td>review</td>"));
    assert.match(sec, /2 earlier reviews carry no kind/);

    // Only kind-less records: no table, the singular note.
    writeJsonl(join(state, "journal.jsonl"), [rv("o1", "pass")]);
    const only = kindSection(renderReport(dir));
    assert.doesNotMatch(only, /<table>/);
    assert.match(only, /1 earlier review carries no kind/);

    // No journal: one line, no crash.
    rmSync(join(state, "journal.jsonl"));
    assert.match(kindSection(renderReport(dir)), /No reviewer stop records in the journal yet\./);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report phase: the first implementer of a later run that reuses a slice id counts as build", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-report-runs-"));
  try {
    const state = join(dir, ".claude", "state");
    mkdirSync(state, { recursive: true });
    /** @param {string} id */
    const stop = (id) => ({ ts: "t", session_id: "s1", hook_event_name: "SubagentStop", agent_id: id, agent_type: "implementer", tokens: { input: 0, output: 0.1 * M, cache_read: 0, cache_write: 0 }, models: ["claude-sonnet-5-5"] });
    writeJsonl(join(state, "telemetry.jsonl"), ["i1", "i2", "i3", "i4"].map(stop));
    /** @param {string} id */
    const launch = (id) => ({ ts: "t", session_id: "s1", agent_id: id, agent_type: "implementer", slice: "a", isPlanReview: false });
    writeJsonl(join(state, "journal-launches.jsonl"), ["i1", "i2", "i3", "i4"].map(launch));
    /** @param {string} id @param {number} run */
    const jr = (id, run) => ({ ts: "t", session_id: "s1", agent_id: id, role: "implementer", slice: "a", run, status: "pass" });
    // i1: run 1 (build); i2: run 2, the same slice id (build, was retries); i3: run 2 again (retries); i4: no journal
    // record, so no known run: decided per session and slice as before (retries).
    writeJsonl(join(state, "journal.jsonl"), [jr("i1", 1), jr("i2", 2), jr("i3", 2)]);
    const html = renderReport(dir);
    const end = html.indexOf("<h3>Tokens and estimated cost per slice whose latest review passed</h3>");
    assert.notEqual(end, -1, "the passed-slice heading ends the phase table");
    const sec = html.slice(html.indexOf("<h2>Tokens and estimated cost by phase</h2>"), end);
    assert.match(sec, /<td>build<\/td><td>2<\/td>/);
    assert.match(sec, /<td>retries<\/td><td>2<\/td>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
