// 1.2.0: the subagent status line the plugin ships (subagent-statusline.mjs), with fixture launch records.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchRecord } from "../.claude/hooks/brief.mjs";
import { indexLaunches, rowFor, sessionLaunches, shortTokens } from "../.claude/hooks/subagent-statusline.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, ".claude", "hooks", "subagent-statusline.mjs");
const at = (/** @type {number} */ min) => new Date(Date.parse("2026-11-10T10:00:00Z") + min * 60000).toISOString();
/** @param {number} min @param {string} type @param {string} prompt @param {string} agentId @param {string} [model] */
const launch = (min, type, prompt, agentId, model) => launchRecord({ subagent_type: type, prompt, ...(model ? { model } : {}) }, { ts: at(min), sessionId: "s1", agentId });
const LAUNCHES = [
  launch(0, "orchestration:reviewer", "PLAN REVIEW\nSLICE: a\nFILES: a.py\nDEPENDS: none\nGOAL: a", "plan1"),
  launch(1, "orchestration:implementer", "SLICE: a\nFILES: a.py\nDEPENDS: none\nRISKY: yes", "impl1"),
  launch(5, "orchestration:reviewer", "SLICE: a\nVALIDATE: gaps", "rev1", "opus"),
  launch(9, "orchestration:implementer", "SLICE: a\nFILES: a.py\nDEPENDS: none\nRISKY: yes", "impl2", "opus"),
  launch(9, "researcher", "SLICE: r1\nSOURCES: docs/a.md", "res1"),
];
/** @param {string} id @param {string} agentType @param {object} [rest] */
const task = (id, agentType, rest = {}) => ({ id, type: "local_agent", agentType, status: "running", description: "Build slice a", label: "Running the tests", startTime: 0, tokenCount: 41200, tokenSamples: [41200], cwd: "/x", ...rest });

test("shortTokens: a value near a tier's top prints in the tier its rounded form belongs to", () => {
  const cases = /** @type {[number, string][]} */ ([
    [999, "999"], [999.4, "999"], [999.5, "1.0k"], [1000, "1.0k"], [1049, "1.0k"], [1050, "1.1k"],
    [99_949, "99.9k"], [99_950, "100k"], [99_999, "100k"], [100_000, "100k"], [100_499, "100k"], [100_500, "101k"],
    [999_499, "999k"], [999_500, "1.0M"], [999_999, "1.0M"], [1_000_000, "1.0M"], [1_049_999, "1.0M"], [1_050_000, "1.1M"],
  ]);
  for (const [n, want] of cases) assert.equal(shortTokens(n), want, String(n));
  for (const bad of [NaN, -1, Infinity * -1]) assert.equal(shortTokens(bad), "0");
});

test("shortTokens: one compact figure per size", () => {
  assert.deepEqual([0, 941, 12345, 128400, 1_240_000].map(shortTokens), ["0", "941", "12.3k", "128k", "1.2M"]);
});

test("rowFor: role, slice, attempt and flags from the launch record; model, tokens, context share and progress from the task", () => {
  assert.equal(rowFor(task("impl1", "orchestration:implementer", { model: "claude-sonnet-5-5", contextWindowSize: 200000 }), LAUNCHES), "implementer a risky · sonnet · 41.2k (21%) · Running the tests");
  // The second fresh launch of the slice is attempt 2.
  assert.equal(rowFor(task("impl2", "implementer", { model: "claude-opus-5-5" }), LAUNCHES), "implementer a #2 risky · opus · 41.2k · Running the tests");
  assert.equal(rowFor(task("rev1", "orchestration:reviewer", { model: "claude-fable-5-2", label: "" }), LAUNCHES), "reviewer a validate · fable · 41.2k · Build slice a");
  assert.equal(rowFor(task("plan1", "reviewer", { status: "completed" }), LAUNCHES), "reviewer plan · 41.2k · completed · Running the tests");
  assert.equal(rowFor(task("res1", "researcher"), LAUNCHES), "researcher r1 · 41.2k · Running the tests");
  // No launch record yet (a foreground launch): the role alone.
  assert.equal(rowFor(task("new", "orchestration:integrator", { label: "merging\n  two   branches" }), LAUNCHES), "integrator · 41.2k · merging two branches");
  // Cut to the row width.
  const cut = rowFor(task("impl1", "implementer", { model: "claude-sonnet-5-5" }), LAUNCHES, 30) ?? "";
  assert.deepEqual([cut.length, cut.endsWith("…")], [30, true]);
});

test("rowFor: other agents keep Claude Code's own row", () => {
  for (const type of ["Explore", "general-purpose", "other-plugin:reviewer-bot", "orchestration:orchestrator", "", undefined]) assert.equal(rowFor(task("x", /** @type {any} */ (type)), LAUNCHES), null, String(type));
  assert.equal(rowFor(null, LAUNCHES), null);
  assert.equal(rowFor({ agentType: "implementer" }, LAUNCHES), null, "a task without an id cannot be answered");
});

test("the command: one JSON line per worker row, this session's launches only, nothing on malformed input", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-substatus-"));
  try {
    const state = join(dir, ".claude", "state");
    mkdirSync(state, { recursive: true });
    const other = launchRecord({ subagent_type: "implementer", prompt: "SLICE: zzz\nFILES: z.py\nDEPENDS: none" }, { ts: at(2), sessionId: "another", agentId: "impl1" });
    writeFileSync(join(state, "journal-launches.jsonl"), [...LAUNCHES, other].map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n");
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCH_") && !k.startsWith("CLAUDE_")));
    /** @param {unknown} input @param {Record<string, string>} [extra] */
    const run = (input, extra = {}) => spawnSync(process.execPath, [script], { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...env, ...extra }, cwd: dir, encoding: "utf8" });
    const input = { session_id: "s1", cwd: dir, columns: 120, tasks: [task("impl1", "orchestration:implementer", { model: "claude-sonnet-5-5" }), task("e1", "Explore"), task("res1", "researcher")] };
    const r = run(input);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(r.stdout.trim().split("\n").map((l) => JSON.parse(l)), [
      { id: "impl1", content: "implementer a risky · sonnet · 41.2k · Running the tests" },
      { id: "res1", content: "researcher r1 · 41.2k · Running the tests" },
    ]);
    // CLAUDE_PROJECT_DIR names the project when the command runs elsewhere.
    assert.match(spawnSync(process.execPath, [script], { input: JSON.stringify({ ...input, cwd: "/nowhere" }), env: { ...env, CLAUDE_PROJECT_DIR: dir }, cwd: tmpdir(), encoding: "utf8" }).stdout, /implementer a risky/);
    // No worker rows, no launch log, and malformed input: exit 0, and nothing printed keeps every default row.
    assert.deepEqual([run({ session_id: "s1", cwd: dir, tasks: [task("e1", "Explore")] }).stdout, run("not json").stdout, run("null").stdout, run({ tasks: "x" }).stdout], ["", "", "", ""]);
    assert.equal(run("not json").status, 0);
    rmSync(join(state, "journal-launches.jsonl"));
    assert.deepEqual(JSON.parse(run(input).stdout.trim().split("\n")[0] ?? "{}"), { id: "impl1", content: "implementer · sonnet · 41.2k · Running the tests" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessionLaunches: parses only the lines that name the session, and keeps the same records", () => {
  const other = launchRecord({ subagent_type: "implementer", prompt: "SLICE: zzz\nFILES: z.py\nDEPENDS: none" }, { ts: at(2), sessionId: "another", agentId: "impl1" });
  const text = [...LAUNCHES, other, ...Array.from({ length: 50 }, () => other)].map((r) => JSON.stringify(r)).join("\n") + "\nnot json\n{\"session_id\":\"s1\"\n";
  const parse = JSON.parse;
  let calls = 0;
  JSON.parse = (/** @type {any[]} */ ...a) => {
    calls++;
    return /** @type {any} */ (parse)(...a);
  };
  let got;
  try {
    got = sessionLaunches(text, "s1");
  } finally {
    JSON.parse = parse;
  }
  assert.deepEqual(got, LAUNCHES.map((r) => parse(JSON.stringify(r))));
  // the five s1 records and the one broken s1 line; the 51 lines of another session are skipped unparsed
  assert.equal(calls, 6);
  // no session id: every record, as before
  assert.equal(sessionLaunches(text, "").length, LAUNCHES.length + 51);
});

test("indexLaunches: attempt numbers counted once for all rows, the same as counting per task", () => {
  const idx = indexLaunches(LAUNCHES);
  assert.deepEqual(["impl1", "impl2", "rev1"].map((id) => idx.nth.get(idx.byAgent.get(id))), [1, 2, undefined]);
  // rowFor uses a given index instead of scanning the launches again
  const many = Array.from({ length: 3 }, () => task("impl2", "implementer", { model: "claude-opus-5-5" }));
  let scans = 0;
  const watched = new Proxy(LAUNCHES, { get: (t, k, r) => (k === "filter" || k === "findLast" ? (scans++, Reflect.get(t, k, r)) : Reflect.get(t, k, r)) });
  for (const t of many) assert.equal(rowFor(t, watched, 0, idx), "implementer a #2 risky · opus · 41.2k · Running the tests");
  assert.equal(scans, 0);
});

test("indexLaunches: attempts count per run; a new PLAN REVIEW starts again at 1, a REPLAN keeps counting", () => {
  const plain = "SLICE: s1\nFILES: s1.py\nDEPENDS: none";
  const two = [
    launch(0, "reviewer", "PLAN REVIEW\nSLICE: s1\nFILES: s1.py\nDEPENDS: none\nGOAL: one", "p1"),
    launch(1, "implementer", plain, "a1"),
    // a second task in the same session reuses the slice id s1
    launch(10, "reviewer", "PLAN REVIEW\nSLICE: s1\nFILES: s1.py\nDEPENDS: none\nGOAL: two", "p2"),
    launch(11, "implementer", plain, "a2"),
    launch(12, "implementer", plain, "a3"),
    // a REPLAN extends the same run: the next launch of s1 is its third attempt there
    launch(13, "reviewer", "PLAN REVIEW\nREPLAN: 1\nSLICE: s1\nFILES: s1.py\nDEPENDS: none\nGOAL: two", "p3"),
    launch(14, "implementer", plain, "a4"),
  ];
  const idx = indexLaunches(two);
  assert.deepEqual(["a1", "a2", "a3", "a4"].map((id) => idx.nth.get(idx.byAgent.get(id))), [1, 1, 2, 3]);
  assert.equal(rowFor(task("a2", "implementer", { model: "claude-opus-5-5", label: "" , description: "" }), two), "implementer s1 · opus · 41.2k");
});
