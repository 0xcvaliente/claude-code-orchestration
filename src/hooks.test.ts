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

const telemetry = (dir: string, input: string) =>
  spawnSync("node", [hook("telemetry.mjs")], { input, env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: "utf8" });
const lastRecord = (dir: string) => {
  const lines = readFileSync(join(dir, ".claude", "state", "telemetry.jsonl"), "utf8").trim().split("\n");
  return JSON.parse(lines[lines.length - 1] ?? "{}");
};
function stopEvent(dir: string, assistantContent: object[], last = "") {
  const transcript = join(dir, "agent.jsonl");
  writeFileSync(
    transcript,
    [JSON.stringify({ type: "user", message: { content: "Reply in this format: STATUS: pass or fail" } }), JSON.stringify({ type: "assistant", message: { content: assistantContent } })].join("\n") + "\n",
  );
  return JSON.stringify({ hook_event_name: "SubagentStop", session_id: "s1", agent_type: "reviewer", last_assistant_message: last, agent_transcript_path: transcript });
}

test("telemetry: empty last message falls back to the transcript's SubagentHandback or text block", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-tel-"));
  const handback = [{ type: "tool_use", name: "SubagentHandback", input: { message: "STATUS: fail\nCHANGED: none" } }];
  assert.equal(telemetry(dir, stopEvent(dir, handback)).status, 0);
  assert.equal(lastRecord(dir).status, "fail");
  assert.equal(telemetry(dir, stopEvent(dir, [{ type: "text", text: "STATUS: pass\nEVIDENCE: ok" }])).status, 0);
  assert.equal(lastRecord(dir).status, "pass");
  assert.equal(lastRecord(dir).agent_type, "reviewer");
});

test("telemetry: a preamble message without a status falls back to the transcript's SubagentHandback", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-tel-"));
  const content = [{ type: "text", text: "Handing back now." }, { type: "tool_use", name: "SubagentHandback", input: { message: "STATUS: pass\nEVIDENCE: ok" } }];
  assert.equal(telemetry(dir, stopEvent(dir, content, "Handing back now.")).status, 0);
  assert.equal(lastRecord(dir).status, "pass");
});

test("telemetry: the format template, a missing transcript and non-empty messages", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-tel-"));
  telemetry(dir, stopEvent(dir, [{ type: "text", text: "Reply in this format:\nSTATUS: pass or fail" }]));
  assert.equal(lastRecord(dir).status, undefined);
  telemetry(dir, JSON.stringify({ hook_event_name: "SubagentStop", session_id: "s1", last_assistant_message: "", agent_transcript_path: join(dir, "missing.jsonl") }));
  assert.equal(lastRecord(dir).status, undefined);
  telemetry(dir, stopEvent(dir, [], "Done.\nSTATUS: pass"));
  assert.equal(lastRecord(dir).status, "pass");
});

test("telemetry: malformed stdin exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-tel-"));
  assert.equal(telemetry(dir, "not json{").status, 0);
});

test("review gate: blocks when the last reviewer recorded no status", () => {
  const dir = project([{ agent_type: "implementer" }, { agent_type: "reviewer" }]);
  const r = gate(dir);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no STATUS line/);
  assert.match(readFileSync(join(dir, ".claude", "state", "gates.jsonl"), "utf8"), /last_reviewer_no_status/);
});

test("session nudge: tells the session to route non-trivial tasks, and is silent when ORCH_NO_NUDGE is set", () => {
  const run = (env: Record<string, string>) =>
    spawnSync("node", [hook("nudge.mjs")], { input: "{}", env: { ...process.env, ORCH_NO_NUDGE: "", ...env }, encoding: "utf8" });
  const on = run({});
  assert.equal(on.status, 0);
  const out = JSON.parse(on.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(out.hookSpecificOutput.additionalContext, /orchestration:route/);
  const off = run({ ORCH_NO_NUDGE: "1" });
  assert.equal(off.status, 0);
  assert.equal(off.stdout, "");
});

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
