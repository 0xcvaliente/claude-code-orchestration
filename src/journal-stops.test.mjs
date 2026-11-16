// G-8 (audit 2026-11-16): one review recorded as two stop records. A worker that ends its turn with a text report gets
// a SubagentStop, is made to hand the report back, and gets a second SubagentStop seconds later with stop_hook_active
// true and no SubagentStart between. journal.mjs marks that second record `continues: true`, and the fold lets it
// replace the reviewer's previous review instead of adding one. Spec: docs/brief-grammar.md, "Log records".
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function project() {
  const dir = mkdtempSync(join(tmpdir(), "orch-journal-stops-"));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: "" };
  /** @param {object} payload */
  const journal = (payload) => spawnSync("node", [join(root, ".claude", "hooks", "journal.mjs")], { input: JSON.stringify({ session_id: "s1", ...payload }), env, encoding: "utf8" });
  /** @param {string} id @param {string} prompt */
  const launch = (id, prompt) =>
    journal({ hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: "orchestration:reviewer", prompt }, tool_response: { status: "async_launched", agentId: id } });
  /** @param {string} id @param {string} reply @param {unknown} [active] */
  const stop = (id, reply, active) =>
    journal({ hook_event_name: "SubagentStop", agent_id: id, agent_type: "orchestration:reviewer", last_assistant_message: reply, ...(active === undefined ? {} : { stop_hook_active: active }) });
  const stops = () =>
    readFileSync(join(dir, ".claude", "state", "journal.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
  return { launch, stop, stops };
}

test("journal: a stop with stop_hook_active true after an earlier stop of the same agent is marked continues", () => {
  const p = project();
  p.launch("r1", "SLICE: a");
  p.stop("r1", "STATUS: pass", false);
  p.stop("r1", "STATUS: pass", true);
  const [first, second] = p.stops();
  assert.equal("continues" in (first ?? {}), false, "the first stop is a review of its own");
  assert.equal(second?.continues, true);
});

test("journal: no mark on a first stop, on a resume (stop_hook_active false or missing), or for another agent", () => {
  const p = project();
  p.launch("r1", "SLICE: a");
  p.launch("r2", "SLICE: a");
  p.stop("r1", "STATUS: fail", true); // stop_hook_active on a first stop: nothing to continue
  p.stop("r1", "STATUS: pass", false); // a SendMessage resume: a new review
  p.stop("r1", "STATUS: pass"); // an older Claude Code without the field
  p.stop("r2", "STATUS: pass", "true"); // not the boolean true
  for (const r of p.stops()) assert.equal("continues" in r, false, JSON.stringify(r));
});
