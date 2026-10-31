// Replays real Stop timelines through review-gate.mjs. Fixtures in src/fixtures/gate-replay/ are sanitized plugin logs
// (telemetry SubagentStart/SubagentStop plus a Stop row where the old gate decided): only ts, hook_event_name, renamed
// agent_id/session_id, agent_type and status. Timestamps are shifted to end just before now, so the gate's
// "start younger than ORCH_RUN_STALE_MIN" fallback sees them as recent. Nothing here reads ~/.claude.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const gate = join(root, ".claude", "hooks", "review-gate.mjs");

/**
 * Replay one fixture; returns the gate's reason at each Stop row.
 * @param {string} name @param {boolean} withTasks pass background_tasks derived from the timeline (else the telemetry fallback)
 */
function replay(name, withTasks) {
  const rows = readFileSync(join(root, "src", "fixtures", "gate-replay", `${name}.jsonl`), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const shift = Date.now() - 1000 - Date.parse(rows.at(-1).ts);
  const dir = mkdtempSync(join(tmpdir(), "gate-replay-"));
  const state = join(dir, ".claude", "state");
  mkdirSync(state, { recursive: true });
  /** @type {Map<string, string>} agent id -> type, while running */
  const live = new Map();
  /** @type {string[]} */
  const reasons = [];
  try {
    for (const r of rows) {
      const ts = new Date(Date.parse(r.ts) + shift).toISOString();
      if (r.hook_event_name !== "Stop") {
        appendFileSync(join(state, "telemetry.jsonl"), `${JSON.stringify({ ...r, ts })}\n`);
        if (r.hook_event_name === "SubagentStart") live.set(r.agent_id, r.agent_type);
        else live.delete(r.agent_id);
        continue;
      }
      const background_tasks = [...live].map(([id, type]) => ({ id, type: "subagent", status: "running", description: "x", agent_type: type }));
      const input = { session_id: r.session_id, ...(withTasks ? { background_tasks } : {}) };
      const res = spawnSync("node", [gate], { input: JSON.stringify(input), env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ORCH_RUN_STALE_MIN: "" }, encoding: "utf8" });
      assert.ok(res.status === 0 || res.status === 2, res.stderr);
      const last = readFileSync(join(state, "gates.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
      assert.equal(res.status === 2, last.decision === "block");
      reasons.push(last.reason);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return reasons;
}

const NONE = "no_implementer_in_session";
const RUN = "agents_running";
const cases = {
  // Old gate: block, block, max_blocks_reached while the reviewer ran, then reviewer_passed.
  "reviewer-running-gave-up": ["no_telemetry", RUN, RUN, RUN, NONE, RUN, NONE, NONE, RUN, RUN, RUN, RUN, "reviewer_passed"],
  // Old gate: blocked with nothing running (right), then blocked again while the reviewer ran (wrong).
  "block-then-reviewer-running": [RUN, RUN, RUN, "no_reviewer_after_last_implementer", RUN, "reviewer_passed"],
};

for (const [name, expected] of Object.entries(cases)) {
  for (const withTasks of [false, true]) {
    test(`gate replay ${name} (${withTasks ? "background_tasks" : "telemetry fallback"}): waits while agents run, gates once nothing runs`, () => {
      assert.deepEqual(replay(name, withTasks), expected);
    });
  }
}
