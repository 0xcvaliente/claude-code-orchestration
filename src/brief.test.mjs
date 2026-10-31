// brief.mjs against docs/brief-grammar.md: every fixture in src/fixtures/briefs against expected.json (the dashboard can
// reuse the same pair as a contract test), then one test per rule of the spec, and parity with today's hooks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MAX_RETRIES,
  RUN_STALE_MIN_DEFAULT,
  agentModel,
  currentReviews,
  doubtSignals,
  escalationMode,
  foldRuns,
  hasOpusPass,
  isOpusModel,
  isPlanReview,
  launchRecord,
  modelFromAgentFile,
  normalizeFiles,
  parseHeader,
  parsePlan,
  parseReply,
  parseStatus,
  sliceOfBrief,
  staleMinutes,
  stopRecord,
} from "../.claude/hooks/brief.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(root, "src", "fixtures", "briefs");
const HOOK = join(root, ".claude", "hooks", "brief.mjs");

test("every fixture parses to its expected.json entry, and every fixture has one", () => {
  /** @type {Record<string, { header: unknown, plan: unknown, reply: unknown }>} */
  const expected = JSON.parse(readFileSync(join(FIX, "expected.json"), "utf8"));
  const files = readdirSync(FIX).filter((f) => f.endsWith(".txt")).sort();
  assert.deepEqual(files, Object.keys(expected).sort(), "fixtures and expected.json list the same files");
  for (const f of files) {
    const text = readFileSync(join(FIX, f), "utf8");
    const want = /** @type {{ header: unknown, plan: unknown, reply: unknown }} */ (expected[f]);
    assert.deepEqual(parseHeader(text), want.header, `${f}: header`);
    assert.deepEqual(parsePlan(text), want.plan, `${f}: plan`);
    assert.deepEqual(parseReply(text), want.reply, `${f}: reply`);
  }
});

test("C1: no parser throws on empty, malformed or non-string input; fields come back empty", () => {
  const junk = [undefined, null, 42, {}, [], "", "\n\n", ":::", "SLICE:", "FILES: ,,, none", "C1: pass (", "OPEN:", "STATUS:", "\u0000￿", "x".repeat(100000)];
  for (const v of junk) {
    const h = parseHeader(v);
    assert.equal(typeof h.risky, "boolean");
    assert.ok(Array.isArray(h.files) && Array.isArray(h.depends) && Array.isArray(h.checks));
    const p = parsePlan(v);
    assert.ok(Array.isArray(p.slices));
    const r = parseReply(v);
    assert.ok(Array.isArray(r.open));
    parseStatus(v);
    isPlanReview(v);
    sliceOfBrief(v);
    modelFromAgentFile(v);
    isOpusModel(v);
    normalizeFiles(v, "/base");
    agentModel(v, { projectDir: "/nonexistent", pluginRoot: "/nonexistent" });
  }
  assert.deepEqual(parseHeader(undefined), { slice: null, files: [], depends: [], path: null, risky: false, checks: [], focus: null, workflow: false });
  assert.deepEqual(parsePlan(null), { isPlanReview: false, replan: null, constraints: {}, slices: [] });
  assert.deepEqual(parseReply(42), { status: null, open: [], answers: {} });
  assert.deepEqual(foldRuns(/** @type {any} */ ("nope")), { runs: [], open: null });
  assert.deepEqual(foldRuns(/** @type {any} */ ({ launches: [null, 3, { ts: {} }], stops: "x", gates: [{ gate: "test" }] })), { runs: [], open: null });
  assert.deepEqual(foldRuns(/** @type {any} */ ([null, 3])), { runs: [], open: null });
  launchRecord(42);
  stopRecord(/** @type {any} */ ("x"));
});

test("C7: brief.mjs imports only node: built-ins and has no side effects at import", () => {
  const src = readFileSync(HOOK, "utf8");
  const imports = [...src.matchAll(/^import\b[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(imports.length > 0);
  for (const i of imports) assert.match(String(i), /^node:/, `${i} is a Node built-in`);
  const dir = mkdtempSync(join(tmpdir(), "brief-import-"));
  try {
    copyFileSync(HOOK, join(dir, "brief.mjs"));
    const r = spawnSync("node", ["--input-type=module", "-e", `await import(${JSON.stringify(join(dir, "brief.mjs"))})`], { cwd: dir, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout + r.stderr, "");
    assert.deepEqual(readdirSync(dir), ["brief.mjs"], "importing writes no files");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("header: first matching line wins, keys are case-insensitive, list and emphasis prefixes are allowed", () => {
  const h = parseHeader("slice: one\nFILES: a.py\nSLICE: two\nFILES: b.py");
  assert.equal(h.slice, "one");
  assert.deepEqual(h.files, ["a.py"]);
  assert.equal(parseHeader("> * **SLICE:** `s-1` extra words").slice, "s-1");
  assert.equal(parseHeader("SLICE: 'q'").slice, "q");
  assert.deepEqual(parseHeader("FILES: `a.py`, './b.py', \"c d.md\", none, ").files, ["a.py", "b.py", "c d.md"]);
  assert.deepEqual(parseHeader("DEPENDS: none").depends, []);
  assert.deepEqual(parseHeader("DEPENDS: A0, A1").depends, ["A0", "A1"]);
  assert.equal(parseHeader("Body text mentioning SLICE: x mid-line").slice, null, "a key must start the line");
});

test("header: PATH light, RISKY yes, CHECKS ids, FOCUS and the workflow marker", () => {
  assert.equal(parseHeader("PATH: light").path, "light");
  assert.equal(parseHeader("PATH: Light (one slice)").path, "light");
  assert.equal(parseHeader("PATH: lightweight").path, null);
  assert.equal(parseHeader("PATH: full").path, null);
  assert.equal(parseHeader("RISKY: yes").risky, true);
  assert.equal(parseHeader("RISKY: YES, payments").risky, true);
  assert.equal(parseHeader("RISKY: no").risky, false);
  assert.equal(parseHeader("RISKY: maybe").risky, false);
  assert.deepEqual(parseHeader("CHECKS: C1, c3, C3, C10 and notes").checks, ["C1", "C3", "C10"]);
  assert.deepEqual(parseHeader("CHECKS: none").checks, []);
  assert.equal(parseHeader("FOCUS: the error path").focus, "the error path");
  assert.equal(parseHeader("FOCUS:   ").focus, null);
  assert.equal(parseHeader("intro\n- ORCHESTRATION: workflow\nSLICE: s").workflow, true);
  assert.equal(parseHeader("ORCHESTRATION: manual").workflow, false);
});

test("PLAN REVIEW: the brief must start with it (leading whitespace allowed, case-sensitive)", () => {
  assert.equal(isPlanReview("PLAN REVIEW\nx"), true);
  assert.equal(isPlanReview("  \n PLAN REVIEW of the toml task"), true);
  assert.equal(isPlanReview("plan review"), false);
  assert.equal(isPlanReview("Intro\nPLAN REVIEW"), false);
  assert.equal(sliceOfBrief("PLAN REVIEW\nSLICE: s1"), "plan");
  assert.equal(sliceOfBrief("SLICE: s1\nFILES: a"), "s1");
  assert.equal(sliceOfBrief("no header"), null);
});

test("plan: REPLAN number, constraints block and per-slice lines", () => {
  const p = parsePlan(
    [
      "PLAN REVIEW",
      "REPLAN: 3",
      "CONSTRAINTS:",
      "C1: first",
      "",
      "- C2: second",
      "C1: duplicate is ignored",
      "C3:",
      "Then prose ends the block.",
      "C9: outside the block, not a constraint",
      "SLICE: plan",
      "SLICE: a, the parser",
      "FILES: a.py",
      "GOAL: ignored, inline goal first",
      "SLICE: b",
      "DEPENDS: a",
      "RISKY: yes",
      "CHECKS: C2",
      "SLICE: a",
      "CHECKS: C1",
    ].join("\n"),
  );
  assert.equal(p.replan, 3);
  assert.deepEqual(p.constraints, { C1: "first", C2: "second" });
  assert.deepEqual(p.slices, [
    { slice: "a", files: ["a.py"], depends: [], goal: "the parser", risky: false, checks: ["C1"] },
    { slice: "b", files: [], depends: ["a"], goal: null, risky: true, checks: ["C2"] },
  ]);
  assert.equal(parsePlan("PLAN REVIEW\nREPLAN: soon").replan, null);
  assert.equal(parsePlan("PLAN REVIEW\nREPLAN: 0").replan, 0);
  assert.deepEqual(parsePlan("SLICE: s1\nFILES: a.py"), { isPlanReview: false, replan: null, constraints: {}, slices: [] }, "not a plan review: empty plan");
});

test("C3: old-style plans, briefs and replies parse to empty values", () => {
  assert.deepEqual(parsePlan("PLAN REVIEW\nSplit it into a parser and a CLI."), { isPlanReview: true, replan: null, constraints: {}, slices: [] });
  const h = parseHeader("SLICE: s1\nFILES: a.py\nDEPENDS: none\nDo it.");
  assert.deepEqual([h.risky, h.checks, h.focus, h.path], [false, [], null, null]);
  assert.deepEqual(parseReply("STATUS: pass\nCHANGED: a.py\nEVIDENCE: npm test -> ok"), { status: "pass", open: [], answers: {} });
});

test("STATUS: same rule as scripts/auto.sh (src/verify.test.ts cases); no STATUS line is null", () => {
  /** @type {Array<[string, 'pass' | 'fail' | null]>} */
  const cases = [
    ["The session reported: STATUS: pass\nLooks fine.", null],
    ["The session reported: STATUS: pass\nSTATUS: fail\nGAPS: notes.md cites no source", "fail"],
    ["> STATUS: pass", null],
    ["> STATUS: pass\nSTATUS: fail", "fail"],
    ["STATUS: fail\nGAPS: notes.md cites no source\nSTATUS: pass", "fail"],
    ["STATUS: pass\nlater\nSTATUS: fail", "fail"],
    ["STATUS: pass or fail", null],
    ["STATUS: pass/fail", null],
    ["Review complete.\n\nSTATUS: pass", "pass"],
    ["**STATUS: pass**\nGAPS: none", "pass"],
    ["\n  ## STATUS: pass\nGAPS: none", "pass"],
    ["> STATUS: fail\nSTATUS: pass", "pass"],
    ["Earlier I noted STATUS: fail for the draft; the final report fixes it.\n\nSTATUS: pass\nGAPS: none", "pass"],
    ["status: PASS", "pass"],
    ["STATUS: passed", null],
    ["", null],
  ];
  for (const [reply, want] of cases) assert.equal(parseStatus(reply), want, JSON.stringify(reply));
});

test("OPEN: empty, none, - and n/a mean nothing; an inline value and list lines are items", () => {
  for (const v of ["OPEN:", "OPEN: none", "OPEN: None.", "OPEN: -", "OPEN: n/a", "**OPEN:** none"]) assert.deepEqual(parseReply(v).open, [], v);
  assert.deepEqual(parseReply("OPEN: the header case").open, ["the header case"]);
  assert.deepEqual(parseReply("OPEN:\n\n- one\n* two\n1. three\n\nAfter the blank line: prose.\n- not an item").open, ["one", "two", "three"]);
  assert.deepEqual(parseReply("OPEN: first\n- second\nEVIDENCE: x").open, ["first", "second"]);
  assert.deepEqual(parseReply("OPEN:\n- none").open, []);
  assert.deepEqual(parseReply("No open field at all").open, []);
});

test("answers: pass (cmd) with -> or →, pass (read), fail; quotes and templates ignored; a later fail wins", () => {
  const r = parseReply(
    [
      "c1: pass (cmd) npm test → 12 pass",
      "**C2: pass (read) docs/brief-grammar.md:40**",
      "C3: fail no fixture for blockquotes",
      "C4: pass (cmd) node x.mjs -> ok",
      "C4: fail the command was not run",
      "C5: pass (read) a.md:1",
      "C5: pass (cmd) later lines for a passed id do not replace it",
      "> C6: pass (cmd) quoted -> ok",
      "C7: pass or fail",
      "C8: pass without a mode",
    ].join("\n"),
  );
  assert.deepEqual(r.answers, {
    C1: { verdict: "pass", mode: "cmd", detail: "npm test -> 12 pass" },
    C2: { verdict: "pass", mode: "read", detail: "docs/brief-grammar.md:40" },
    C3: { verdict: "fail", mode: null, detail: "no fixture for blockquotes" },
    C4: { verdict: "fail", mode: null, detail: "the command was not run" },
    C5: { verdict: "pass", mode: "read", detail: "a.md:1" },
    C8: { verdict: "pass", mode: null, detail: "without a mode" },
  });
});

test("normalizeFiles: relative against baseDir, absolute kept, trailing slashes stripped, duplicates dropped", () => {
  assert.deepEqual(normalizeFiles(["src/a.ts", "./src/a.ts", "/abs/dir/", "docs/", "", 7, "src/../lib/b.js", "src/**/*.ts"], "/repo/"), [
    "/repo/src/a.ts",
    "/abs/dir",
    "/repo/docs",
    "/repo/lib/b.js",
    "/repo/src/**/*.ts",
  ]);
  assert.deepEqual(normalizeFiles(["a/", "/x/"], undefined), ["a", "/x"], "without a baseDir relative entries stay relative");
  assert.deepEqual(normalizeFiles(["/"], "/repo"), ["/"]);
  assert.deepEqual(normalizeFiles("a.py", "/repo"), []);
});

test("reviewer model: tool_input.model, else project agent file, else plugin agent file, else unknown; opus by name", () => {
  const dir = mkdtempSync(join(tmpdir(), "brief-model-"));
  try {
    const project = join(dir, "project");
    const plugin = join(dir, "plugin");
    mkdirSync(join(project, ".claude", "agents"), { recursive: true });
    mkdirSync(join(plugin, "agents"), { recursive: true });
    writeFileSync(join(project, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\nmodel: opus\n---\nbody model: haiku\n");
    writeFileSync(join(plugin, "agents", "reviewer.md"), "---\nmodel: sonnet\n---\n");
    writeFileSync(join(plugin, "agents", "researcher.md"), "---\nname: researcher\nmodel: \"claude-haiku-4\"  # cheap\n---\n");
    writeFileSync(join(plugin, "agents", "integrator.md"), "no frontmatter\nmodel: opus\n");
    const dirs = { projectDir: project, pluginRoot: plugin };
    assert.equal(agentModel({ subagent_type: "orchestration:reviewer", model: "haiku" }, dirs), "haiku");
    assert.equal(agentModel({ subagent_type: "orchestration:reviewer" }, dirs), "opus");
    assert.equal(agentModel({ subagent_type: "reviewer" }, { pluginRoot: plugin }), "sonnet");
    assert.equal(agentModel({ subagent_type: "researcher" }, dirs), "claude-haiku-4");
    assert.equal(agentModel({ subagent_type: "integrator" }, dirs), null);
    assert.equal(agentModel({ subagent_type: "implementer" }, dirs), null);
    assert.equal(agentModel({ subagent_type: "../../etc/passwd" }, dirs), null);
    assert.equal(agentModel({}, {}), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(isOpusModel("opus"), true);
  assert.equal(isOpusModel("claude-opus-5-5"), true);
  assert.equal(isOpusModel("Claude-OPUS"), true);
  assert.equal(isOpusModel("sonnet"), false);
  assert.equal(isOpusModel(null), false);
});

test("env: ORCH_RUN_STALE_MIN and ORCH_ESCALATION", () => {
  assert.equal(RUN_STALE_MIN_DEFAULT, 30);
  assert.equal(staleMinutes({}), 30);
  assert.equal(staleMinutes({ ORCH_RUN_STALE_MIN: "5" }), 5);
  assert.equal(staleMinutes({ ORCH_RUN_STALE_MIN: "0" }), 30);
  assert.equal(staleMinutes({ ORCH_RUN_STALE_MIN: "soon" }), 30);
  assert.equal(escalationMode({}), "auto");
  assert.equal(escalationMode({ ORCH_ESCALATION: "OFF" }), "off");
  assert.equal(escalationMode({ ORCH_ESCALATION: "always" }), "always");
  assert.equal(escalationMode({ ORCH_ESCALATION: "sometimes" }), "auto");
});

// Run model helpers: log records at minutes from a fixed start, in session s1.
/** @typedef {import("../.claude/hooks/brief.mjs").Records} Records */
/** @typedef {{ launch?: object, stop?: object, gate?: object }} Item */
const T0 = Date.parse("2026-10-31T10:00:00Z");
/** @param {number} min */
const at = (min) => new Date(T0 + min * 60000).toISOString();
const PLAN = "PLAN REVIEW\nCONSTRAINTS:\nC1: no throw\nSLICE: a\nFILES: a.py\nDEPENDS: none\nGOAL: a\nCHECKS: C1\nSLICE: b\nFILES: b.py\nDEPENDS: a\nGOAL: b\nRISKY: yes";
/** @param {Item[]} items @returns {Records} */
const R = (...items) => ({
  launches: items.flatMap((i) => (i.launch ? [i.launch] : [])),
  stops: items.flatMap((i) => (i.stop ? [i.stop] : [])),
  gates: items.flatMap((i) => (i.gate ? [i.gate] : [])),
});
/** @param {number} min @param {string} [prompt] @returns {Item} */
const planLaunch = (min, prompt = PLAN) => ({ launch: launchRecord({ subagent_type: "orchestration:reviewer", prompt }, { ts: at(min), sessionId: "s1", agentId: `plan${min}` }) });
/** @param {number} min @param {string} slice @param {string} [extra] @param {string} [agentId] @returns {Item} */
const impl = (min, slice, extra = "", agentId = `impl-${slice}-${min}`) => ({
  launch: launchRecord({ subagent_type: "implementer", prompt: `SLICE: ${slice}\nFILES: ${slice}.py\nDEPENDS: none\n${extra}` }, { ts: at(min), sessionId: "s1", agentId }),
});
/** An implementer stop; the slice is joined from the launch by agent id (a SendMessage resume has no new launch). @param {number} min @param {string} agentId @returns {Item} */
const implStop = (min, agentId) => ({ stop: stopRecord({ ts: at(min), sessionId: "s1", agentId, role: "implementer", reply: "STATUS: pass" }) });
/** A reviewer launched just before `min` and stopping at `min`. @param {number} min @param {string} slice @param {string} reply @param {string | null} [model] @returns {Item[]} */
const review = (min, slice, reply, model = "sonnet") => {
  const agentId = `rev-${slice}-${min}`;
  const input = { subagent_type: "reviewer", prompt: `SLICE: ${slice}\nCHECKS: C1`, ...(model ? { model } : {}) };
  return [
    { launch: launchRecord(input, { ts: at(min - 0.5), sessionId: "s1", agentId }) },
    { stop: stopRecord({ ts: at(min), sessionId: "s1", agentId, role: "reviewer", reply }) },
  ];
};
/** An implementer attempt: launch, stop, review. @param {number} min @param {string} slice @param {string} verdict @param {string} [extra] @returns {Item[]} */
const attempt = (min, slice, verdict, extra = "") => [impl(min, slice, extra), implStop(min + 1, `impl-${slice}-${min}`), ...review(min + 2, slice, `STATUS: ${verdict}`)];

test("launch and stop records carry parsed fields, never the brief or reply text", () => {
  const l = launchRecord({ subagent_type: "orchestration:implementer", prompt: "SLICE: a\nFILES: a.py\nDEPENDS: none\nRISKY: yes\nCHECKS: C2\nsecret body text" }, { ts: "t", sessionId: "s", agentId: "x1" });
  assert.deepEqual(l, { ts: "t", session_id: "s", agent_id: "x1", agent_type: "implementer", slice: "a", files: ["a.py"], depends: [], path: null, risky: true, checks: ["C2"], focus: null, workflow: false, model: null, isPlanReview: false, replan: null });
  assert.doesNotMatch(JSON.stringify(l), /secret body text/);
  const p = launchRecord({ subagent_type: "reviewer", model: "opus", prompt: PLAN }, { ts: "t" });
  assert.equal(p.slice, "plan");
  assert.equal(p.model, "opus");
  assert.equal(p.isPlanReview, true);
  assert.deepEqual(p.plan?.constraints, { C1: "no throw" });
  assert.deepEqual(p.plan?.slices.map((s) => s.slice), ["a", "b"]);
  assert.equal(p.agent_id, null);
  const s = stopRecord({ ts: "t", sessionId: "s", agentId: "r1", role: "orchestration:reviewer", slice: "a", reply: "STATUS: pass\nC1: pass (read) a.py:1\nOPEN: none\nquoted secret" });
  assert.deepEqual(s, { ts: "t", session_id: "s", agent_id: "r1", role: "reviewer", slice: "a", status: "pass", answers: { C1: { verdict: "pass", mode: "read", detail: "a.py:1" } }, open: [], run: null });
  assert.equal(stopRecord(/** @type {any} */ (null)).status, null);
  assert.equal(launchRecord(undefined).agent_type, "");
});

test("C3: old journal records (no parsed fields, no answers) fold without errors", () => {
  const f = foldRuns({
    launches: [
      { ts: at(0), session_id: "s1", agent_id: "r0", slice: "plan", role: "reviewer" },
      { ts: at(1), session_id: "s1", agent_id: "i1", slice: "a", role: "implementer" },
    ],
    stops: [{ ts: at(2), session_id: "s1", slice: "a", role: "implementer", status: "pass", agent_id: "i1" }],
  }, { now: T0 + 3 * 60000 });
  assert.equal(f.open?.kind, "planned");
  assert.deepEqual(f.open?.planned, []);
  assert.equal(f.open?.slices.a?.attempts, 1);
});

test("run model: a PLAN REVIEW opens a planned run; REPLAN extends it; a new PLAN REVIEW closes it", () => {
  const replan = "PLAN REVIEW\nREPLAN: 1\nCONSTRAINTS:\nC2: keep API\nSLICE: c\nFILES: c.py\nDEPENDS: none\nGOAL: c";
  let f = foldRuns(R(planLaunch(0), impl(1, "a"), planLaunch(2, replan)), { now: T0 + 3 * 60000 });
  assert.equal(f.runs.length, 1);
  const run = /** @type {import("../.claude/hooks/brief.mjs").Run} */ (f.open);
  assert.equal(run.kind, "planned");
  assert.deepEqual(run.planned, ["a", "b", "c"]);
  assert.deepEqual(run.constraints, { C1: "no throw", C2: "keep API" });
  assert.equal(run.slices.a?.launches, 1);
  assert.deepEqual(run.slices.a?.checks, ["C1"]);
  assert.equal(run.slices.b?.risky, true);
  f = foldRuns(R(planLaunch(0), impl(1, "a"), planLaunch(2)), { now: T0 + 3 * 60000 });
  assert.equal(f.runs.length, 2);
  assert.equal(f.runs[0]?.closed, true);
  assert.equal(f.open?.id, 2);
  assert.equal(f.open?.slices.a?.launches, 0, "the new run starts its own counts");
  assert.equal(foldRuns(R(planLaunch(0, replan)), { now: T0 }).open?.planned.join(), "c", "a REPLAN with no open run opens one");
});

test("run model: records of other sessions are dropped when sessionId is given", () => {
  const other = { launch: launchRecord({ subagent_type: "reviewer", prompt: "PLAN REVIEW\nSLICE: z\nFILES: z" }, { ts: at(1), sessionId: "s2", agentId: "o1" }) };
  const f = foldRuns(R(planLaunch(0), other), { now: T0 + 2 * 60000, sessionId: "s1" });
  assert.equal(f.runs.length, 1);
  assert.deepEqual(f.open?.planned, ["a", "b"]);
  assert.equal(foldRuns(R(planLaunch(0), other), { now: T0 + 2 * 60000, sessionId: "s3" }).runs.length, 0);
});

test("run model: a light implementer opens a run only when none is open; other launches outside a run are not tracked", () => {
  let f = foldRuns(R(impl(0, "x")), { now: T0 });
  assert.deepEqual([f.runs.length, f.open], [0, null]);
  f = foldRuns(R(...attempt(0, "fix", "pass", "PATH: light")), { now: T0 + 3 * 60000 });
  assert.equal(f.runs[0]?.kind, "light");
  assert.equal(f.runs[0]?.closed, true, "a light run closes when its slice is final");
  assert.equal(f.open, null);
  f = foldRuns(R(planLaunch(0), impl(1, "a", "PATH: light")), { now: T0 + 2 * 60000 });
  assert.equal(f.runs.length, 1, "a light brief inside an open run joins it");
  assert.equal(f.open?.slices.a?.launches, 1);
  f = foldRuns(R(impl(0, "w", "ORCHESTRATION: workflow\nPATH: light")), { now: T0 });
  assert.equal(f.runs.length, 0, "workflow briefs are not part of the run model");
});

test("run model: attempts are implementer stops; failed for good after 3 attempts, resumes included", () => {
  assert.equal(MAX_RETRIES, 2);
  const two = [planLaunch(0), ...attempt(1, "a", "fail"), ...attempt(4, "a", "fail")];
  let f = foldRuns(R(...two), { now: T0 + 7 * 60000 });
  assert.deepEqual([f.open?.slices.a?.attempts, f.open?.slices.a?.final], [2, false], "2 attempts: a retry is left");
  f = foldRuns(R(...two, ...attempt(7, "a", "fail")), { now: T0 + 10 * 60000 });
  assert.deepEqual([f.open?.slices.a?.attempts, f.open?.slices.a?.final, f.open?.slices.a?.gaveUp, f.open?.slices.a?.passed], [3, true, true, false]);
  // Retries by SendMessage resume the same agent: one launch, three stops (joined by agent id), three failed reviews.
  f = foldRuns(
    R(planLaunch(0), impl(1, "a", "", "A"), implStop(2, "A"), ...review(3, "a", "STATUS: fail"), implStop(4, "A"), ...review(5, "a", "STATUS: fail"), implStop(6, "A"), ...review(7, "a", "STATUS: fail")),
    { now: T0 + 8 * 60000 },
  );
  assert.deepEqual([f.open?.slices.a?.launches, f.open?.slices.a?.attempts, f.open?.slices.a?.gaveUp], [1, 3, true]);
  // A test-gate block makes the implementer stop again before any review: still one attempt.
  f = foldRuns(R(planLaunch(0), impl(1, "a", "", "A"), implStop(2, "A"), implStop(3, "A"), implStop(4, "A"), ...review(5, "a", "STATUS: fail")), { now: T0 + 6 * 60000 });
  assert.deepEqual([f.open?.slices.a?.attempts, f.open?.slices.a?.final], [1, false]);
});

test("run model: only a review after the latest implementer launch or stop counts; a planned run closes when all slices are final", () => {
  let f = foldRuns(R(planLaunch(0), ...attempt(1, "a", "pass"), impl(5, "a")), { now: T0 + 6 * 60000 });
  assert.equal(f.open?.slices.a?.final, false, "relaunched after its pass");
  f = foldRuns(R(planLaunch(0), ...attempt(1, "a", "pass"), implStop(5, "impl-a-1")), { now: T0 + 6 * 60000 });
  assert.equal(f.open?.slices.a?.final, false, "resumed after its pass");
  f = foldRuns(R(planLaunch(0), ...attempt(1, "a", "pass"), ...attempt(4, "b", "pass")), { now: T0 + 7 * 60000 });
  assert.deepEqual([f.runs[0]?.closed, f.open], [true, null]);
  f = foldRuns(R(impl(0, "fix", "PATH: light"), implStop(1, "impl-fix-0"), ...review(2, "fix", "looks fine")), { now: T0 + 3 * 60000 });
  assert.equal(f.open?.slices.fix?.final, false, "a review with no STATUS line is not a pass");
});

test("run model: a run with no launch or stop for ORCH_RUN_STALE_MIN minutes is stale; a late stop still lands in it", () => {
  let f = foldRuns(R(planLaunch(0), impl(1, "a")), { now: T0 + 32 * 60000 });
  assert.deepEqual([f.runs[0]?.stale, f.runs[0]?.closed, f.open], [true, false, null]);
  f = foldRuns(R(planLaunch(0), impl(1, "a")), { now: T0 + 32 * 60000, staleMin: 60 });
  assert.equal(f.open?.id, 1);
  // A light launch after a stale run opens a new run; the stale run keeps its slice for the review gate.
  f = foldRuns(R(planLaunch(0), impl(1, "a"), impl(40, "fix", "PATH: light"), implStop(41, "impl-a-1"), ...review(42, "a", "STATUS: pass")), { now: T0 + 43 * 60000 });
  assert.equal(f.runs.length, 2);
  assert.equal(f.runs[0]?.stale, true);
  assert.equal(f.runs[0]?.slices.a?.passed, true, "the late stops are recorded in the run that has the slice");
  assert.equal(f.open?.kind, "light");
  // A worker that outlives staleness: its stop is activity, so the run is not stale at the end.
  f = foldRuns(R(planLaunch(0), impl(1, "a"), implStop(44, "impl-a-1"), ...review(45, "a", "STATUS: pass")), { now: T0 + 46 * 60000 });
  assert.equal(f.open?.id, 1);
  assert.equal(f.open?.slices.a?.passed, true);
});

test("doubt signals: risky, retry, read answer, open items, isolated test failure; ORCH_ESCALATION off/always", () => {
  /** @param {Item[]} items @param {string} slice */
  const sliceOf = (items, slice) => {
    const s = foldRuns(R(planLaunch(0), ...items), { now: T0 + 20 * 60000 }).runs[0]?.slices[slice];
    assert.ok(s);
    return s;
  };
  const ok = (/** @type {string} */ reply) => [impl(1, "a"), implStop(2, "impl-a-1"), ...review(3, "a", reply)];
  assert.deepEqual(doubtSignals(sliceOf(ok("STATUS: pass\nC1: pass (cmd) npm test -> ok\nOPEN: none"), "a")), []);
  assert.deepEqual(doubtSignals(sliceOf(attempt(1, "b", "pass"), "b")), ["risky"]);
  assert.deepEqual(doubtSignals(sliceOf([impl(1, "a", "RISKY: yes")], "a")), ["risky"], "RISKY on the implementer brief counts too");
  assert.deepEqual(doubtSignals(sliceOf([...attempt(1, "a", "fail"), ...attempt(4, "a", "pass")], "a")), ["retry"]);
  assert.deepEqual(doubtSignals(sliceOf(ok("STATUS: pass\nC1: pass (read) a.py:3"), "a")), ["read_answer"]);
  assert.deepEqual(doubtSignals(sliceOf(ok("STATUS: pass\nOPEN: edge case untested"), "a")), ["open_items"]);
  // Test-gate records name no slice: they join a launch by agent id. Old records have no session_id.
  /** @param {number} min @param {string} agentId @param {string} [session] @returns {Item} */
  const gate = (min, agentId, session) => ({ gate: { ts: at(min), gate: "test", decision: "warn", reason: "tests_failed_isolated", agent_type: "implementer", agent_id: agentId, ...(session ? { session_id: session } : {}) } });
  assert.deepEqual(doubtSignals(sliceOf([impl(1, "a"), gate(2, "impl-a-1", "s1"), implStop(2, "impl-a-1")], "a")), ["tests_failed_isolated"]);
  assert.deepEqual(doubtSignals(sliceOf([impl(1, "a"), implStop(2, "impl-a-1"), gate(2, "impl-a-1")], "a")), ["tests_failed_isolated"], "gate after the stop, no session_id");
  assert.deepEqual(doubtSignals(sliceOf([impl(1, "a"), gate(2, "impl-a-1", "s2")], "a")), [], "another session's gate");
  assert.deepEqual(doubtSignals(sliceOf([impl(1, "a"), gate(2, "unknown-agent", "s1")], "a")), [], "an agent id with no launch");
  // Only for the latest attempt: a gate before a failed review belongs to the earlier attempt.
  assert.deepEqual(doubtSignals(sliceOf([impl(1, "a", "", "A"), gate(2, "A", "s1"), implStop(2, "A"), ...review(3, "a", "STATUS: fail"), implStop(4, "A")], "a")), ["retry"]);
  assert.deepEqual(doubtSignals(sliceOf(attempt(1, "b", "pass"), "b"), { ORCH_ESCALATION: "off" }), []);
  assert.deepEqual(doubtSignals(sliceOf([impl(1, "a")], "a"), { ORCH_ESCALATION: "always" }), ["always"]);
  // An opus pass after the latest implementer satisfies them; one before a relaunch does not; the model comes from the launch.
  const opus = sliceOf([impl(1, "b"), implStop(2, "impl-b-1"), ...review(3, "b", "STATUS: pass", "claude-opus-5-5")], "b");
  assert.equal(hasOpusPass(opus), true);
  const relaunched = sliceOf([impl(1, "b"), implStop(2, "impl-b-1"), ...review(3, "b", "STATUS: pass", "opus"), impl(4, "b")], "b");
  assert.equal(hasOpusPass(relaunched), false);
  assert.equal(currentReviews(relaunched).length, 0);
  assert.equal(hasOpusPass(sliceOf([impl(1, "b"), implStop(2, "impl-b-1"), ...review(3, "b", "STATUS: pass", null)], "b")), false, "unknown model is not opus");
});

// Parity with today's hooks: brief.mjs must read SLICE, FILES and DEPENDS exactly as plan-check.mjs logs them,
// and the slice as journal.mjs keys it, so slice A1 can switch to it without a change in behaviour.
test("parity: parseHeader matches plan-check.mjs, sliceOfBrief matches journal.mjs", () => {
  const dir = mkdtempSync(join(tmpdir(), "brief-parity-"));
  try {
    const hooks = join(dir, ".claude", "hooks");
    const state = join(dir, ".claude", "state");
    mkdirSync(hooks, { recursive: true });
    mkdirSync(state, { recursive: true });
    for (const h of ["state.mjs", "plan-check.mjs", "journal.mjs"]) copyFileSync(join(root, ".claude", "hooks", h), join(hooks, h));
    const briefs = [
      "SLICE: toml\nFILES: toolkit/toml.py, ./tests/test_toml.py\nDEPENDS: none",
      "- **SLICE:** auth extra\n- FILES: `src/auth.ts`, 'src/session/'\n- DEPENDS: A0, A1",
      "> slice: q.1\nfiles: a.md,,b.md, none\ndepends: NONE",
      "Intro line\nSLICE: late\nFILES: x\nDEPENDS: y\nSLICE: later\nFILES: z",
    ];
    briefs.forEach((prompt, i) => {
      const session = `p${i}`;
      writeFileSync(join(state, "journal.jsonl"), `${JSON.stringify({ ts: "t", session_id: session, slice: "plan", role: "reviewer", status: "pass" })}\n`, { flag: "a" });
      const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
      spawnSync("node", [join(hooks, "plan-check.mjs")], { input: JSON.stringify({ session_id: session, tool_input: { subagent_type: "implementer", prompt } }), env, encoding: "utf8" });
      const logged = readFileSync(join(state, "plan-check.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.session_id === session).pop();
      const h = parseHeader(prompt);
      assert.deepEqual({ slice: h.slice, files: h.files, depends: h.depends }, { slice: logged.slice, files: logged.files, depends: logged.depends }, prompt);
      spawnSync("node", [join(hooks, "journal.mjs")], { input: JSON.stringify({ hook_event_name: "PostToolUse", session_id: session, tool_input: { subagent_type: "implementer", prompt }, tool_response: { agentId: `agent${i}xx` } }), env, encoding: "utf8" });
      const launch = readFileSync(join(state, "journal-launches.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.session_id === session).pop();
      assert.equal(sliceOfBrief(prompt), launch.slice, prompt);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
