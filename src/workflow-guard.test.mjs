// 1.6.0: the workflow guard (workflow-guard.mjs, PreToolUse on Workflow) and the nudge's line for the workflow keyword
// (nudge.mjs, UserPromptSubmit). Run as child processes against temp projects; no model call. The input shapes are the
// ones recorded live in docs/data/live-checks-2026-11-17.md, Check 5: {"script": ...} for a script written on the spot,
// {"name": ..., "args": ...} for a saved workflow.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { builtinAgents } from "../.claude/hooks/builtin-agents.mjs";
import { BLOCK_MESSAGE, guardOff, LOG, SAVED_NAMES, workflowDecision } from "../.claude/hooks/workflow-guard.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = (/** @type {string} */ name) => join(root, ".claude", "hooks", name);
const SECRET = "the-script-text-must-never-be-logged";
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCH_") && !k.startsWith("CLAUDE_PLUGIN_")));

/** A temp project, with this repo's saved workflow file unless `workflow` is false. @param {{ workflow?: boolean }} [o] */
function project({ workflow = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orch-wfguard-"));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  if (workflow) {
    mkdirSync(join(dir, ".claude", "workflows"), { recursive: true });
    copyFileSync(join(root, ".claude", "workflows", "orchestrate.js"), join(dir, ".claude", "workflows", "orchestrate.js"));
  }
  return dir;
}
/** @param {string} script @param {string} dir @param {unknown} input @param {Record<string, string>} [extra] @param {string[]} [args] */
function run(script, dir, input, extra = {}, args = []) {
  const r = spawnSync(process.execPath, [script, ...args], { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...baseEnv, CLAUDE_PROJECT_DIR: dir, ...extra }, cwd: dir, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** @param {unknown} toolInput @param {Record<string, unknown>} [more] */
const launch = (toolInput, more = {}) => ({ session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Workflow", tool_input: toolInput, ...more });
/** @param {string} dir @returns {any[]} */
const records = (dir) => {
  const f = join(dir, ".claude", "state", LOG);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const GUARD = hook("workflow-guard.mjs");

test("the saved workflow passes silently: orchestrate and orchestration:orchestrate, with or without args", () => {
  const dir = project();
  try {
    for (const input of [{ name: "orchestrate", args: { task: "toy" } }, { name: "orchestrate" }, { name: "orchestration:orchestrate", args: "x" }, { name: "orchestrate", resumeFromRunId: "wf_1" }]) {
      const r = run(GUARD, dir, launch(input));
      assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""], JSON.stringify(input));
    }
    const recs = records(dir);
    assert.equal(recs.length, 4, "one record per decision");
    for (const rec of recs) assert.deepEqual([rec.gate, rec.decision, rec.reason], ["workflow", "allow", "saved_workflow"]);
    assert.deepEqual(recs[0].keys, ["name", "args"]);
    assert.equal(recs[0].session_id, "s1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("every other launch is refused with the block message and a reason code, and the log holds no script or args", () => {
  const dir = project();
  try {
    /** @type {[unknown, string][]} */
    const cases = [
      [{ script: `export const meta = { name: 'x', description: '${SECRET}', phases: [] }` }, "inline_script"],
      [{ name: "orchestrate", script: SECRET }, "inline_script"],
      [{ scriptPath: `/tmp/${SECRET}.js` }, "script_path"],
      [{ name: "orchestrate", scriptPath: "/tmp/x.js" }, "script_path"],
      [{ name: "deep-research", args: SECRET }, "name_not_allowed"],
      [{ name: "Orchestrate" }, "name_not_allowed"],
      [{ name: "orchestrate " }, "name_not_allowed"],
      [{ name: "other:orchestrate" }, "name_not_allowed"],
      [{ name: "orchestrate", extra: 1 }, "unknown_shape"],
      [{ name: "orchestrate", resumeFromRunId: 7 }, "unknown_shape"],
      [{ name: 3 }, "unknown_shape"],
      [{ args: { task: "x" } }, "unknown_shape"],
      [{}, "unknown_shape"],
      ["orchestrate", "unknown_shape"],
      [null, "unknown_shape"],
      [["orchestrate"], "unknown_shape"],
    ];
    for (const [input, reason] of cases) {
      const r = run(GUARD, dir, launch(input));
      assert.equal(r.code, 2, JSON.stringify(input));
      assert.equal(r.stdout, "", "a refusal prints nothing on stdout");
      assert.ok(r.stderr.includes(BLOCK_MESSAGE), r.stderr);
      assert.ok(r.stderr.includes(`(${reason})`), `${JSON.stringify(input)}: ${r.stderr}`);
    }
    // A tool_input that is missing altogether is an unknown shape too.
    const missing = run(GUARD, dir, { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "Workflow" });
    assert.equal(missing.code, 2);
    const recs = records(dir);
    assert.equal(recs.length, cases.length + 1);
    assert.deepEqual(recs.map((r) => r.reason), [...cases.map((c) => c[1]), "unknown_shape"]);
    assert.ok(recs.every((r) => r.decision === "deny" && r.gate === "workflow"));
    assert.deepEqual(recs[0].keys, ["script"]);
    assert.equal(recs[4].name, "deep-research");
    assert.ok(!readFileSync(join(dir, ".claude", "state", LOG), "utf8").includes(SECRET), "never the script, path or args");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("bare orchestrate needs the saved file in the project; the plugin copy checks its own workflows folder", () => {
  const bare = project({ workflow: false });
  const plug = mkdtempSync(join(tmpdir(), "orch-wfguard-plugin-"));
  const data = mkdtempSync(join(tmpdir(), "orch-wfguard-data-"));
  try {
    const r = run(GUARD, bare, launch({ name: "orchestrate" }));
    assert.equal(r.code, 2);
    assert.ok(r.stderr.includes("(workflow_file_missing)"), r.stderr);
    // The input's cwd counts as a project root too.
    const other = project();
    try {
      assert.equal(run(GUARD, bare, launch({ name: "orchestrate" }, { cwd: other })).code, 0);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
    // The project copy cannot see the plugin, so the namespaced name passes there.
    assert.equal(run(GUARD, bare, launch({ name: "orchestration:orchestrate" })).code, 0);

    // A plugin layout: <root>/hooks/workflow-guard.mjs (+ state.mjs) and <root>/workflows/orchestrate.js.
    mkdirSync(join(plug, "hooks"));
    for (const f of ["workflow-guard.mjs", "state.mjs"]) copyFileSync(hook(f), join(plug, "hooks", f));
    const pluginGuard = join(plug, "hooks", "workflow-guard.mjs");
    const env = { CLAUDE_PLUGIN_DATA: data };
    const noFile = run(pluginGuard, bare, launch({ name: "orchestration:orchestrate" }), env, ["--plugin"]);
    assert.equal(noFile.code, 2);
    assert.ok(noFile.stderr.includes("(workflow_file_missing)"));
    mkdirSync(join(plug, "workflows"));
    copyFileSync(join(root, ".claude", "workflows", "orchestrate.js"), join(plug, "workflows", "orchestrate.js"));
    assert.deepEqual(Object.values(run(pluginGuard, bare, launch({ name: "orchestration:orchestrate" }), env, ["--plugin"])), [0, "", ""]);
    assert.equal(run(pluginGuard, bare, launch({ script: "x" }), env, ["--plugin"]).code, 2);
    assert.equal(records(bare).length, 3, "the plugin copy logs to the per-user state dir, not the project's");

    // Where the project registers its own copy, the plugin copy steps aside (duplicate()).
    mkdirSync(join(bare, ".claude", "hooks"), { recursive: true });
    copyFileSync(hook("workflow-guard.mjs"), join(bare, ".claude", "hooks", "workflow-guard.mjs"));
    writeFileSync(join(bare, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Workflow", hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/workflow-guard.mjs"' }] }] } }));
    assert.deepEqual(Object.values(run(pluginGuard, bare, launch({ script: "x" }), env, ["--plugin"])), [0, "", ""]);
  } finally {
    for (const d of [bare, plug, data]) rmSync(d, { recursive: true, force: true });
  }
});

test("input that is not JSON, another tool's event and another hook event exit 0 with no output and no record", () => {
  const dir = project();
  try {
    for (const input of ["", "not json", "{", "[]", "null", "42"]) assert.deepEqual(Object.values(run(GUARD, dir, input)), [0, "", ""], JSON.stringify(input));
    assert.deepEqual(Object.values(run(GUARD, dir, launch({ script: "x" }, { tool_name: "Bash" }))), [0, "", ""]);
    assert.deepEqual(Object.values(run(GUARD, dir, launch({ script: "x" }, { hook_event_name: "PostToolUse" }))), [0, "", ""]);
    assert.deepEqual(records(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the switch turns it off: the environment, the plugin option, and the environment wins", () => {
  const dir = project();
  try {
    const adhoc = launch({ script: "x" });
    for (const off of ["off", " OFF "]) assert.deepEqual(Object.values(run(GUARD, dir, adhoc, { ORCH_WORKFLOW_GUARD: off })), [0, "", ""]);
    assert.deepEqual(Object.values(run(GUARD, dir, adhoc, { CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD: "off" })), [0, "", ""], "the plugin setting reaches the hook");
    assert.equal(run(GUARD, dir, adhoc, { ORCH_WORKFLOW_GUARD: "", CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD: "off" }).code, 2, "an explicit environment value wins");
    assert.equal(run(GUARD, dir, adhoc, { ORCH_WORKFLOW_GUARD: "on", CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD: "off" }).code, 2);
    assert.equal(run(GUARD, dir, adhoc, { ORCH_WORKFLOW_GUARD: "0" }).code, 2, "only off turns it off");
    assert.equal(records(dir).length, 3, "no record while it is off");
    assert.equal(guardOff({ ORCH_WORKFLOW_GUARD: "off" }), true);
    assert.equal(guardOff({ CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD: "off" }), true);
    assert.equal(guardOff({ ORCH_WORKFLOW_GUARD: "", CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD: "off" }), false);
    assert.equal(guardOff({}), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deny-only: no output ever holds an allow or ask decision, and the source never writes one", () => {
  const dir = project();
  try {
    for (const input of [launch({ name: "orchestrate" }), launch({ script: "x" }), launch({ name: "x" }), "garbage"]) {
      const r = run(GUARD, dir, input);
      assert.equal(r.stdout, "");
      assert.doesNotMatch(r.stdout + r.stderr, /permissionDecision|"allow"|"ask"/);
    }
    assert.doesNotMatch(readFileSync(GUARD, "utf8"), /permissionDecision|hookSpecificOutput/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the block message names no switch and no Claude Code agent type, and says what to use instead", () => {
  assert.doesNotMatch(BLOCK_MESSAGE, /ORCH_|CLAUDE_PLUGIN_OPTION_|workflow_guard|disableWorkflows|CLAUDE_CODE_/);
  for (const name of builtinAgents()) assert.ok(!new RegExp(`\\b${name}\\b`, "i").test(BLOCK_MESSAGE), name);
  assert.match(BLOCK_MESSAGE, /orchestrator agent/);
  assert.match(BLOCK_MESSAGE, /saved orchestrate workflow/);
  assert.match(BLOCK_MESSAGE, /only the person starts/);
  assert.deepEqual([...SAVED_NAMES], ["orchestrate", "orchestration:orchestrate"]);
});

test("workflowDecision: the decision table without a process", () => {
  const env = { CLAUDE_PROJECT_DIR: "/nonexistent-project" };
  assert.equal(workflowDecision(null).decision, "skip");
  assert.equal(workflowDecision({ tool_name: "Read", tool_input: {} }, { env }).decision, "skip");
  assert.equal(workflowDecision({ tool_input: { script: "x" } }, { env }).reason, "inline_script", "a missing tool_name is the matcher's tool");
  assert.equal(workflowDecision(launch({ name: "orchestrate" }), { env }).reason, "workflow_file_missing");
  assert.equal(workflowDecision(launch({ name: "orchestration:orchestrate" }), { env }).decision, "allow");
  assert.equal(workflowDecision(launch({ name: "orchestration:orchestrate" }), { env, plugin: true, pluginRoot: "/nonexistent-plugin" }).reason, "workflow_file_missing");
  assert.equal(workflowDecision(launch({ name: "orchestrate" }), { env: { CLAUDE_PROJECT_DIR: root } }).decision, "allow", "this repo's own saved workflow");
});

// --- The nudge at UserPromptSubmit ---
const NUDGE = hook("nudge.mjs");
/** @param {string} prompt @param {Record<string, string>} [extra] */
const prompted = (prompt, extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "orch-wfnudge-"));
  try {
    return run(NUDGE, dir, { session_id: "s1", hook_event_name: "UserPromptSubmit", prompt }, extra);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

test("nudge: a typed prompt with the word ultracode gets one context line; it never blocks and names no switch", () => {
  for (const prompt of ["ultracode build the parser", "Please ULTRACODE this.", "do it (ultracode)", "a\nUltraCode\nb", "ultracode-mode"]) {
    const r = prompted(prompt);
    assert.equal(r.code, 0, prompt);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(Object.keys(out), ["hookSpecificOutput"], "context only: no decision, no block");
    assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    const line = out.hookSpecificOutput.additionalContext;
    assert.equal(line.split("\n").length, 1, "one line");
    assert.match(line, /workflows started by the ultracode keyword or written on the spot are off in this project/);
    assert.match(line, /orchestrator/);
    assert.doesNotMatch(line, /ORCH_|CLAUDE_PLUGIN_OPTION_|workflow_guard/);
    for (const name of builtinAgents()) assert.ok(!new RegExp(`\\b${name}\\b`, "i").test(line), name);
  }
  // Not the whole word, or not there: nothing, and the routing text of SessionStart is not repeated.
  for (const prompt of ["ultracoder", "myultracode", "ultracode_x", "plain task", ""]) assert.deepEqual(Object.values(prompted(prompt)), [0, "", ""], prompt);
  // Not typed by the person: a subagent's hand-back (the text 2.1.326 delivers, recorded live), a task notification,
  // another session's message, or an input whose origin field says so. Nothing for any of them.
  for (const prompt of [
    'Another Claude session sent a message:\n<agent-message from="a776e6e4572693427">\n[Subagent hand-back] ... grep ultracode ...',
    "<task-notification>\n<task-id>a1</task-id>\n<result>ultracode was mentioned</result>\n</task-notification>",
    "  <teammate-message from=\"r\">ultracode</teammate-message>",
  ]) assert.deepEqual(Object.values(prompted(prompt)), [0, "", ""], prompt);
  const dir = mkdtempSync(join(tmpdir(), "orch-wfnudge-"));
  try {
    for (const extra of [{ source: "poll_event" }, { origin: { kind: "task-notification" } }]) {
      const r = run(NUDGE, dir, { session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: "ultracode x", ...extra });
      assert.deepEqual([r.code, r.stdout], [0, ""], JSON.stringify(extra));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // A typed prompt that only mentions such a message later on still gets the line.
  assert.notEqual(prompted("ultracode: summarise the <agent-message> you got").stdout, "");
  // The line does not depend on the session's routing nudge being on.
  assert.equal(prompted("ultracode x", { ORCH_NO_NUDGE: "1" }).code, 0);
  assert.notEqual(prompted("ultracode x", { ORCH_NO_NUDGE: "1" }).stdout, "");
});
