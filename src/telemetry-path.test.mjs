// Telemetry keeps transcript paths whole: a path cut at 300 characters no longer ends in .jsonl and `npm run report`
// counts that session's transcript as missing. A path longer than 4,096 characters, or one that is not a string, is left
// out of the record; every other long string field is still cut as before.
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function project() {
  const dir = mkdtempSync(join(tmpdir(), "telemetry-path-"));
  const hooks = join(dir, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of ["state.mjs", "brief.mjs", "run.mjs", "telemetry.mjs"]) copyFileSync(join(root, ".claude", "hooks", h), join(hooks, h));
  return dir;
}
/** @param {string} dir @param {unknown} payload */
const run = (dir, payload) =>
  spawnSync("node", [join(dir, ".claude", "hooks", "telemetry.mjs")], { input: JSON.stringify(payload), env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: "" }, encoding: "utf8" });
/** @param {string} dir @returns {any[]} */
const log = (dir) => {
  try {
    return readFileSync(join(dir, ".claude", "state", "telemetry.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
/** A path of exactly `n` characters ending in .jsonl. @param {number} n */
const longPath = (n) => `/${"d".repeat(n - "/.jsonl".length)}.jsonl`;

test("telemetry: a transcript path longer than 300 characters is recorded whole", () => {
  const dir = project();
  try {
    const transcript_path = longPath(900);
    const agent_transcript_path = longPath(4096);
    const r = run(dir, { hook_event_name: "SubagentStart", session_id: "s1", agent_id: "a1", agent_type: "reviewer", transcript_path, agent_transcript_path });
    assert.equal(r.status, 0, r.stderr);
    const [rec] = log(dir);
    assert.equal(rec.transcript_path, transcript_path);
    assert.equal(rec.agent_transcript_path, agent_transcript_path);
    assert.ok(rec.transcript_path.endsWith(".jsonl"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("telemetry: a path over 4,096 characters is left out, not cut", () => {
  const dir = project();
  try {
    const r = run(dir, { hook_event_name: "SubagentStart", session_id: "s1", agent_id: "a1", agent_type: "reviewer", transcript_path: longPath(4097), agent_transcript_path: longPath(5000) });
    assert.equal(r.status, 0, r.stderr);
    const [rec] = log(dir);
    assert.equal(rec.session_id, "s1");
    assert.ok(!("transcript_path" in rec));
    assert.ok(!("agent_transcript_path" in rec));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("telemetry: a path that is not a string is left out and the hook exits 0", () => {
  for (const bad of [42, null, true, { p: "x.jsonl" }, ["x.jsonl"]]) {
    const dir = project();
    try {
      const event = bad === null ? "SubagentStart" : "SubagentStop";
      const r = run(dir, { hook_event_name: event, session_id: "s1", agent_id: "a1", agent_type: "reviewer", transcript_path: bad, agent_transcript_path: bad });
      assert.equal(r.status, 0, r.stderr);
      const [rec] = log(dir);
      assert.equal(rec.session_id, "s1");
      assert.ok(!("transcript_path" in rec), JSON.stringify(bad));
      assert.ok(!("agent_transcript_path" in rec), JSON.stringify(bad));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("telemetry: another long string field is still cut at 300 characters", () => {
  const dir = project();
  try {
    const cwd = "c".repeat(900);
    const r = run(dir, { hook_event_name: "SubagentStart", session_id: "s1", agent_id: "a1", agent_type: "reviewer", cwd, transcript_path: longPath(900) });
    assert.equal(r.status, 0, r.stderr);
    const [rec] = log(dir);
    assert.equal(rec.cwd, `${"c".repeat(300)}...`);
    assert.equal(rec.transcript_path.length, 900);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
