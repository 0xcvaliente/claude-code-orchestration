// scripts/run-result.mjs: the event stream of a headless run becomes one result document with the run's totals, and
// scripts/log-run.mjs logs those totals. Regression for the run of 2026-11-14 that took two minutes and eleven turns
// and was logged as 8320 ms and one turn (the last wake-up only).
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { reduce } from "../scripts/run-result.mjs";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const j = JSON.stringify;
const MODELS = { "claude-opus-5-5": { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 300, cacheCreationInputTokens: 40 } };
// What `claude -p --output-format stream-json --verbose` prints for a session that waited for two agents.
const INIT = j({ type: "system", subtype: "init", session_id: "s1" });
const STREAM = [
  INIT,
  j({ type: "assistant", message: { content: [{ type: "text", text: 'a line with {"type":"result"} inside a string' }] } }),
  j({ type: "result", subtype: "success", is_error: false, result: "still running", num_turns: 6, duration_ms: 27000, result_index: 0 }),
  j({ type: "system", subtype: "task_notification" }),
  j({ type: "result", subtype: "success", is_error: false, result: "review started", num_turns: 2, duration_ms: 12000, result_index: 1 }),
  j({ type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1, duration_ms: 8320, result_index: 2, modelUsage: MODELS, subagent_stats: { by_type: { "orchestration:implementer": 1 } } }),
];

test("reduce: the last result, with turns summed over every result and the wall time", async () => {
  const doc = JSON.parse(await reduce(STREAM, 128000.4));
  assert.equal(doc.result, "done");
  assert.equal(doc.num_turns, 1, "the last result's own fields stay as claude gave them");
  assert.equal(doc.duration_ms, 8320);
  assert.deepEqual(doc.modelUsage, MODELS);
  assert.deepEqual(doc.orch_totals, { results: 3, turns: 9, wall_ms: 128000 });
});

test("reduce: one result, no start time; a result without num_turns counts as zero turns", async () => {
  const one = JSON.parse(await reduce([j({ type: "result", is_error: false, result: "ok", num_turns: 4 })]));
  assert.deepEqual(one.orch_totals, { results: 1, turns: 4, wall_ms: null });
  const none = JSON.parse(await reduce([j({ type: "result", is_error: true, result: "budget" })], 5));
  assert.deepEqual(none.orch_totals, { results: 1, turns: 0, wall_ms: 5 });
});

test("reduce: output that is not an event stream is printed unchanged", async () => {
  assert.equal(await reduce(["error: unknown option '--agent'"]), "error: unknown option '--agent'");
  const legacy = j({ is_error: false, result: "x", num_turns: 3 }); // one document without a type
  assert.equal(await reduce([legacy]), legacy);
  const pretty = JSON.stringify({ is_error: false, result: "x" }, null, 2).split("\n");
  assert.equal(await reduce(pretty), pretty.join("\n"));
  assert.equal(await reduce([]), "");
  // A stream that was cut before any result (a killed run): a document of its own that keeps its plain-text lines.
  const killed = JSON.parse(await reduce([INIT, "Killed", j({ type: "assistant", message: {} })]));
  assert.equal(killed.result, "Killed");
  assert.equal(killed.subtype, "no_result");
});

// Audit W-6: claude crashed or was killed after start-up, so the stream has records but no result record.
const NO_RESULT = [
  INIT,
  j({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "a" }] } }),
  j({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", name: "Read" }] } }),
  j({ type: "user", message: { content: [] } }),
  j({ type: "assistant", message: { id: "m2", content: [{ type: "text", text: "b" }] } }),
];

test("reduce: a stream with records but no result gives an error document with the run's totals", async () => {
  const doc = JSON.parse(await reduce(NO_RESULT, 4200.6, 1));
  assert.equal(doc.type, "result");
  assert.equal(doc.subtype, "no_result");
  assert.equal(doc.is_error, true);
  assert.equal(doc.result, "");
  // two assistant messages (m1 came in two records): the turns seen
  assert.deepEqual(doc.orch_totals, { results: 0, turns: 2, wall_ms: 4201, exit_code: 1, complete: false });
  // exit code 0 without a result is still not complete; without an exit code or a start time, those stay unknown
  assert.deepEqual(JSON.parse(await reduce(NO_RESULT, 10, 0)).orch_totals, { results: 0, turns: 2, wall_ms: 10, exit_code: 0, complete: false });
  assert.deepEqual(JSON.parse(await reduce(NO_RESULT)).orch_totals, { results: 0, turns: 2, wall_ms: null, complete: false });
});

test("orchestrate.sh: a run with no result record prints the no_result document and logs its wall time and turns", () => {
  const { r, log } = runOrchestrate(`${NO_RESULT.join("\n")}\n`, 1);
  assert.equal(r.status, 1);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.subtype, "no_result");
  assert.equal(doc.orch_totals.exit_code, 1);
  assert.equal(log[0].ok, false);
  assert.ok(typeof log[0].duration_ms === "number" && log[0].duration_ms >= 200, `wall time logged, got ${log[0].duration_ms}`);
  assert.equal(log[0].turns, 2);
  assert.equal(log[0].terminal_reason, "no_result");
  assert.deepEqual([log[0].exit_code, log[0].complete], [1, false]);
});

test("log-run.mjs: an older record without orch_totals or terminal_reason is still logged", () => {
  const repo = mkdtempSync(join(tmpdir(), "log-run-"));
  try {
    const r = spawnSync("node", [join(scripts, "log-run.mjs"), "t", "0"], { cwd: repo, input: j({ type: "result", is_error: false, result: "x" }), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const row = JSON.parse(readFileSync(join(repo, ".claude", "state", "runs.jsonl"), "utf8"));
    assert.deepEqual([row.ok, row.turns, row.duration_ms, row.terminal_reason, row.exit_code, row.complete], [true, null, null, "unparsed output", 0, true]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

/** A folder, a fake `claude` that prints `stdout`, and orchestrate.sh run on it. */
function runOrchestrate(/** @type {string} */ stdout, /** @type {number} */ exitCode = 0) {
  const tmp = mkdtempSync(join(tmpdir(), "run-result-"));
  const bin = join(tmp, "bin");
  const repo = join(tmp, "repo");
  mkdirSync(bin);
  mkdirSync(repo);
  writeFileSync(join(tmp, "stdout.txt"), stdout);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${tmp}/args"\nsleep 0.2\ncat "${tmp}/stdout.txt"\nexit ${exitCode}\n`);
  chmodSync(join(bin, "claude"), 0o755);
  const r = spawnSync("bash", [join(scripts, "orchestrate.sh"), "the task", repo], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORCH_AGENT: "none", ORCH_DRY_RUN: "", ORCH_TEST_CMD: "", ORCH_BUDGET_TOKENS: "", ORCH_BUDGET_USD: "", ORCH_MODEL: "", ORCH_ADD_DIR: "", ORCH_ADVISOR: "", ORCH_SESSION_PERSISTENCE: "", ORCH_ALLOWED_TOOLS: "", ORCH_EXTRA_ALLOWED_TOOLS: "" },
    encoding: "utf8",
  });
  const args = readFileSync(join(tmp, "args"), "utf8").split("\n");
  const log = readFileSync(join(repo, ".claude", "state", "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  rmSync(tmp, { recursive: true, force: true });
  return { r, args, log };
}

test("orchestrate.sh: asks for the event stream, prints one document and logs the whole run's turns and duration", () => {
  const { r, args, log } = runOrchestrate(`${STREAM.join("\n")}\n`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--verbose"), "stream-json needs --verbose in print mode");
  const doc = JSON.parse(r.stdout); // one document: auto.sh parses the whole of stdout
  assert.equal(doc.result, "done");
  assert.equal(doc.orch_totals.results, 3);
  assert.equal(doc.orch_totals.turns, 9);
  assert.equal(log.length, 1);
  assert.equal(log[0].ok, true);
  assert.equal(log[0].turns, 9, "not the last wake-up's 1");
  assert.ok(log[0].duration_ms >= 200 && log[0].duration_ms !== 8320, `wall time of the run, got ${log[0].duration_ms}`);
  assert.equal(log[0].duration_ms, doc.orch_totals.wall_ms);
  assert.equal(log[0].tokens, 370);
  assert.deepEqual(log[0].subagents, { "orchestration:implementer": 1 });
});

test("orchestrate.sh: an error text and claude's exit code pass through, and the run is logged as failed", () => {
  const { r, log } = runOrchestrate("error: not logged in\n", 3);
  assert.equal(r.status, 3);
  assert.equal(r.stdout, "error: not logged in\n");
  assert.equal(log[0].ok, false);
  assert.equal(log[0].terminal_reason, "unparsed output");
  assert.equal(log[0].turns, null);
});

test("log-run.mjs: a document without orch_totals keeps its own num_turns and duration_ms", () => {
  const repo = mkdtempSync(join(tmpdir(), "log-run-"));
  try {
    const r = spawnSync("node", [join(scripts, "log-run.mjs"), "t"], { cwd: repo, input: j({ is_error: false, num_turns: 3, duration_ms: 77, result: "x" }), encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const row = JSON.parse(readFileSync(join(repo, ".claude", "state", "runs.jsonl"), "utf8"));
    assert.equal(row.turns, 3);
    assert.equal(row.duration_ms, 77);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// A run cut short: claude dies after an interim wake-up, so the last result in the stream is not the final answer.
const CUT = STREAM.slice(0, 3);

test("reduce: a run cut short after an interim result carries claude's exit code and complete: false", async () => {
  const doc = JSON.parse(await reduce(CUT, 1000, 137));
  assert.equal(doc.result, "still running");
  assert.deepEqual(doc.orch_totals, { results: 1, turns: 6, wall_ms: 1000, exit_code: 137, complete: false });
  const whole = JSON.parse(await reduce(STREAM, 1000, 0));
  assert.deepEqual(whole.orch_totals, { results: 3, turns: 9, wall_ms: 1000, exit_code: 0, complete: true });
});

test("orchestrate.sh: a run cut short is logged with its exit code and complete: false; the exit status passes through", () => {
  const { r, log } = runOrchestrate(`${CUT.join("\n")}\n`, 137);
  assert.equal(r.status, 137);
  const doc = JSON.parse(r.stdout);
  assert.equal(doc.result, "still running");
  assert.equal(doc.orch_totals.exit_code, 137);
  assert.equal(doc.orch_totals.complete, false);
  assert.equal(log[0].exit_code, 137);
  assert.equal(log[0].complete, false);
  assert.equal(log[0].turns, 6);
  const full = runOrchestrate(`${STREAM.join("\n")}\n`);
  assert.deepEqual([full.log[0].exit_code, full.log[0].complete], [0, true]);
  // An error text has no orch_totals: the exit code still reaches the log.
  const text = runOrchestrate("error: not logged in\n", 3);
  assert.deepEqual([text.log[0].exit_code, text.log[0].complete], [3, false]);
});
