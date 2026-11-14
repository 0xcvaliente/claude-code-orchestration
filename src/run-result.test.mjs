// scripts/run-result.mjs: the event stream of a headless run becomes one result document with the run's totals, and
// scripts/log-run.mjs logs those totals. Regression for the run of 2026-11-14 that took two minutes and eleven turns
// and was logged as 8320 ms and one turn (the last wake-up only).
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
  // A stream that was cut before any result (a killed run) leaves only its plain-text lines.
  assert.equal(await reduce([INIT, "Killed", j({ type: "assistant", message: {} })]), "Killed");
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
