// 2.0.0 (w6 items 2 and 3). Item 2: a worker whose last hand-back a check refused, and that then stops without handing
// back again, delivered no report; journal.mjs records that (status null, report "handback_refused", refused_by) instead
// of the refused report read back from the transcript, and the review gate does not read the slice as reviewed.
// Item 3: the quote check and handback-check.mjs run side by side on one PreToolUse; a refusal without tool_use_id is
// written after the capture it refuses even when the quote check gets there first. Hooks run as child processes with
// fixture state; no model call.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { handbackFor } from "../.claude/hooks/state.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = (/** @type {string} */ name) => join(root, ".claude", "hooks", name);
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCH_") && !k.startsWith("CLAUDE_")));

function project() {
  const dir = mkdtempSync(join(tmpdir(), "orch-handback-refused-"));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  return dir;
}
/** @param {string} dir @param {string} script @param {unknown} input */
function run(dir, script, input) {
  const r = spawnSync(process.execPath, [hook(script)], { input: JSON.stringify(input), env: { ...baseEnv, CLAUDE_PROJECT_DIR: dir }, cwd: dir, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** @param {string} dir @param {string} name @returns {any[]} */
const log = (dir, name) => {
  const f = join(dir, ".claude", "state", name);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const ago = (/** @type {number} */ s) => new Date(Date.now() - s * 1000).toISOString();

/** Journal launch through journal.mjs. @param {string} dir @param {string} type @param {string} id @param {string} prompt */
const launch = (dir, type, id, prompt) =>
  assert.equal(run(dir, "journal.mjs", { session_id: "s1", hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: `orchestration:${type}`, prompt }, tool_response: { status: "async_launched", agentId: id } }).code, 0);
/** Telemetry start and stop records, as telemetry.mjs writes them (the fields the review gate reads). @param {string} dir @param {string} type @param {string} id @param {number} start @param {number} stop */
function lifetime(dir, type, id, start, stop) {
  const f = join(dir, ".claude", "state", "telemetry.jsonl");
  const rec = (/** @type {string} */ ev, /** @type {number} */ s) => JSON.stringify({ ts: ago(s), session_id: "s1", agent_id: id, agent_type: `orchestration:${type}`, hook_event_name: ev });
  writeFileSync(f, `${existsSync(f) ? readFileSync(f, "utf8") : ""}${rec("SubagentStart", start)}\n${rec("SubagentStop", stop)}\n`);
}

const PLAN = "PLAN REVIEW\nCONSTRAINTS:\nC1: parsing never throws\nC2: no new dependencies\nSLICE: x\nFILES: a.txt\nDEPENDS: none\nGOAL: the reader\nCHECKS: C1, C2";
const REVIEW_BRIEF = "SLICE: x\nCHECKS: C1, C2\nC1: parsing never throws\nC2: no new dependencies\n\nReview the reader.";
const PARTIAL = "STATUS: pass\nC1: pass (cmd) npm test -> 4 pass\nOPEN: none";

/**
 * A run with one slice x: plan review passed, implementer done, then a reviewer whose passing report skips C2. The
 * hand-back check sends it back; the reviewer stops without handing back again. Returns the reviewer's journal record
 * and the review gate's decision on the session's final Stop.
 * @param {string} dir @param {{ toolUseId?: string }} o
 */
function refusedReview(dir, { toolUseId } = {}) {
  launch(dir, "reviewer", "p1", PLAN);
  assert.equal(run(dir, "journal.mjs", { session_id: "s1", hook_event_name: "SubagentStop", agent_id: "p1", agent_type: "orchestration:reviewer", last_assistant_message: "STATUS: pass\nOPEN: none" }).code, 0);
  launch(dir, "implementer", "i1", "SLICE: x\nFILES: a.txt\nDEPENDS: none\n\nWrite the reader.");
  lifetime(dir, "implementer", "i1", 60, 40);
  assert.equal(run(dir, "journal.mjs", { session_id: "s1", hook_event_name: "SubagentStop", agent_id: "i1", agent_type: "orchestration:implementer", last_assistant_message: "STATUS: pass\nOPEN: none" }).code, 0);
  launch(dir, "reviewer", "r1", REVIEW_BRIEF);
  const hb = { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_input: { message: PARTIAL }, agent_id: "r1", agent_type: "orchestration:reviewer", ...(toolUseId ? { tool_use_id: toolUseId } : {}) };
  const sent = run(dir, "handback-check.mjs", hb);
  assert.equal(sent.code, 2, "the report check sends the report back: C2 unanswered");
  // The reviewer's transcript holds the refused hand-back (and nothing after it); the stop has no last message.
  const transcript = join(dir, "r1.jsonl");
  const lines = [
    { type: "user", message: { role: "user", content: [{ type: "text", text: REVIEW_BRIEF }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: toolUseId ?? "toolu_x", name: "SubagentHandback", input: { message: PARTIAL } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolUseId ?? "toolu_x", is_error: true, content: sent.stderr }] } },
  ];
  writeFileSync(transcript, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  lifetime(dir, "reviewer", "r1", 30, 0);
  assert.equal(run(dir, "journal.mjs", { session_id: "s1", hook_event_name: "SubagentStop", agent_id: "r1", agent_type: "orchestration:reviewer", agent_transcript_path: transcript }).code, 0);
  const record = log(dir, "journal.jsonl").filter((r) => r.agent_id === "r1").at(-1);
  const gate = run(dir, "review-gate.mjs", { session_id: "s1", hook_event_name: "Stop", background_tasks: [] });
  return { record, gate, decision: log(dir, "gates.jsonl").filter((g) => g.gate === "review").at(-1) };
}

for (const toolUseId of ["toolu_r1", undefined]) {
  test(`item 2: a refused hand-back followed by a stop is journalled as not delivered${toolUseId ? "" : " (no tool_use_id)"}, and the review gate does not read it as a review`, () => {
    const dir = project();
    try {
      const { record, gate, decision } = refusedReview(dir, { toolUseId });
      assert.deepEqual([record?.status, record?.report, record?.refused_by, record?.slice], [null, "handback_refused", "handback", "x"]);
      assert.deepEqual(record?.answers, {}, "nothing from the refused report");
      assert.equal(gate.code, 2, gate.stderr);
      // Before 2.0.0 the record held the refused report (a pass answering C1), and the gate read it as a passing review
      // that skipped C2 (constraints_unchecked); now there is no review to count.
      assert.equal(decision?.reason, "last_reviewer_no_status");
      assert.doesNotMatch(gate.stderr, /passed it/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("item 2: after a refusal, a corrected hand-back or a text report with STATUS is the record, as before", () => {
  const dir = project();
  try {
    const hb = (/** @type {string} */ m, /** @type {string} */ id) => ({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_input: { message: m }, agent_id: "i2", agent_type: "orchestration:implementer", tool_use_id: id });
    launch(dir, "implementer", "i2", "SLICE: y\nFILES: b.txt\nDEPENDS: none");
    assert.equal(run(dir, "handback-check.mjs", hb("done", "toolu_1")).code, 2);
    assert.equal(run(dir, "handback-check.mjs", hb("STATUS: fail\nOPEN: lint", "toolu_2")).code, 0);
    assert.equal(run(dir, "journal.mjs", { session_id: "s1", hook_event_name: "SubagentStop", agent_id: "i2", agent_type: "orchestration:implementer" }).code, 0);
    const r = log(dir, "journal.jsonl").filter((e) => e.agent_id === "i2").at(-1);
    assert.deepEqual([r?.status, "report" in r, "refused_by" in r], ["fail", false, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("item 3: a quote-check refusal without tool_use_id that runs ahead of the capture is still written after it", async () => {
  const dir = project();
  try {
    writeFileSync(join(dir, "notes.md"), "The parser never throws.\n");
    const wrong = 'STATUS: pass\nQUOTE: notes.md:1 | "The parser always throws."\nOPEN: none';
    const payload = { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_input: { message: wrong }, agent_id: "q1", agent_type: "orchestration:researcher" };
    // The unlucky order: the quote check has checked the quotes (its quotes.jsonl record is written) before
    // handback-check.mjs has even started.
    const child = spawn(process.execPath, [hook("quote-check.mjs")], { env: { ...baseEnv, CLAUDE_PROJECT_DIR: dir }, cwd: dir, stdio: ["pipe", "ignore", "pipe"] });
    const done = new Promise((res) => child.on("exit", res));
    child.stdin.end(JSON.stringify(payload));
    for (let i = 0; i < 400 && !log(dir, "quotes.jsonl").length; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(log(dir, "quotes.jsonl").length, 1, "the quote check got there first");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(run(dir, "handback-check.mjs", payload).code, 0, "the report has its STATUS line");
    assert.equal(await done, 2, "the quote check refuses the report");
    const [capture] = log(dir, "handbacks.jsonl");
    const [refusal] = log(dir, "handback-refusals.jsonl");
    assert.ok(Date.parse(refusal.ts) >= Date.parse(capture.ts), `the refusal (${refusal.ts}) follows the capture (${capture.ts})`);
    assert.equal(refusal.report_key, capture.report_key, "both carry the report's key");
    assert.match(String(capture.report_key), /^[0-9a-f]{16}$/);
    // So the stop finds no deliverable capture: the refused report is never the researcher's recorded report.
    assert.equal(handbackFor("s1", "q1", ["telemetry.jsonl"], () => true, join(dir, ".claude", "state")), null);
    assert.ok(!readFileSync(join(dir, ".claude", "state", "handback-refusals.jsonl"), "utf8").includes("parser"), "no report text");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
