import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const hook = (name: string) => new URL(`../.claude/hooks/${name}`, import.meta.url).pathname;

function project(events: object[]) {
  const dir = mkdtempSync(join(tmpdir(), "orch-hook-"));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  const lines = events.map((e) => JSON.stringify({ hook_event_name: "SubagentStop", session_id: "s1", ...e }));
  writeFileSync(join(dir, ".claude", "state", "telemetry.jsonl"), lines.join("\n") + "\n");
  return dir;
}
const gate = (dir: string) =>
  spawnSync("node", [hook("review-gate.mjs")], { input: JSON.stringify({ session_id: "s1" }), env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: "utf8" });

for (const prefix of ["", "orchestration:"]) {
  test(`review gate: blocks an implementer with no later reviewer (agent names "${prefix}role")`, () => {
    const r = gate(project([{ agent_type: `${prefix}implementer` }]));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no reviewer has run/);
  });

  test(`review gate: allows after a passing reviewer, blocks after STATUS: fail (agent names "${prefix}role")`, () => {
    const pass = gate(project([{ agent_type: `${prefix}implementer` }, { agent_type: `${prefix}reviewer`, status: "pass" }]));
    assert.equal(pass.status, 0);
    const fail = gate(project([{ agent_type: `${prefix}implementer` }, { agent_type: `${prefix}reviewer`, status: "fail" }]));
    assert.equal(fail.status, 2);
  });
}

test("test gate: blocks a namespaced implementer while the test command fails, lets reviewers through", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-verify-"));
  const run = (agent_type: string, cmd: string) =>
    spawnSync("bash", [hook("verify.sh")], {
      input: JSON.stringify({ agent_type, agent_id: "a1", cwd: dir }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ORCH_TEST_CMD: cmd },
      encoding: "utf8",
    });
  assert.equal(run("orchestration:implementer", "exit 1").status, 2);
  assert.equal(run("orchestration:implementer", "exit 0").status, 0);
  assert.equal(run("orchestration:reviewer", "exit 1").status, 0, "only implementers are gated");
  assert.match(readFileSync(join(dir, ".claude", "state", "gates.jsonl"), "utf8"), /"decision":"block".*"reason":|"reason":"tests_failed"/);
});
