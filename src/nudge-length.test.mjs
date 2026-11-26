import "./test-tmp.mjs";
// The nudge's SessionStart context must fit Claude Code's 10,000-character cap on a hook's context: longer output is
// saved to a file and the session sees only its path and a 2,000-character preview. This test runs the hook the way
// Claude Code does and holds what it prints at 9,000 characters, the optional agent-teams warning line included.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const NUDGE = join(fileURLToPath(new URL("..", import.meta.url)), ".claude", "hooks", "nudge.mjs");
const LIMIT = 9000;
const POINTER = /^- orchestrate: follow the orchestrate route as the orchestration:route skill describes it\b/m;

/** Run the hook with a SessionStart payload; returns the exit status and stdout. @param {object} payload @param {Record<string, string>} env */
const run = (payload, env = {}) =>
  spawnSync("node", [NUDGE], { input: JSON.stringify(payload), env: { ...process.env, ORCH_NO_NUDGE: "", CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "", ...env }, encoding: "utf8" });

const START = { session_id: "s1", hook_event_name: "SessionStart", source: "startup" };

/** The context text Claude Code reads from the hook's output. @param {Record<string, string>} env */
function context(env = {}) {
  const r = run(START, env);
  assert.equal(r.status, 0);
  const text = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
  assert.equal(typeof text, "string");
  return text;
}

for (const [name, env] of /** @type {[string, Record<string, string>][]} */ ([["plain session", {}], ["agent teams on", { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }]])) {
  test(`nudge (${name}): the SessionStart context is at most ${LIMIT} characters and points to the route skill`, () => {
    const text = context(env);
    assert.ok(text.length <= LIMIT, `the nudge's context is ${text.length} characters, over ${LIMIT}`);
    assert.match(text, POINTER, "the nudge sends the orchestrate route to the route skill");
    if (env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1") assert.match(text, /agent teams are switched on/, "the warning line is in the measured text");
  });
}

test("nudge: a session that runs as the orchestrator gets no context", () => {
  for (const agent of ["orchestrator", "orchestration:orchestrator"]) {
    const r = run({ ...START, agent_type: agent });
    assert.deepEqual([r.status, r.stdout], [0, ""], agent);
  }
});
