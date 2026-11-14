// The haiku rule in plan-check.mjs: a launch of one of this plugin's own agents on a haiku model is raised to sonnet
// unless ORCH_ALLOW_HAIKU=1 (or the plugin option). Run as a hook in a throwaway project with the hooks copied in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = ["state.mjs", "brief.mjs", "run.mjs", "plan-check.mjs", "builtin-agents.mjs", "file-profile.mjs"];
const CLEAR = ["ORCH_ALLOW_HAIKU", "ORCH_READ_ROUTER", "ORCH_SKILL_HINTS", "ORCH_ALLOW_BUILTINS", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_PLUGIN_ROOT", "CLAUDE_PLUGIN_DATA"];

/** A project with the hooks and agent files whose model: lines are given. @param {Record<string, string>} [models] */
function project(models = {}) {
  const dir = mkdtempSync(join(tmpdir(), "floor-"));
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  for (const h of HOOKS) copyFileSync(join(root, ".claude", "hooks", h), join(dir, ".claude", "hooks", h));
  for (const [agent, model] of Object.entries(models)) writeFileSync(join(dir, ".claude", "agents", `${agent}.md`), `---\nname: ${agent}\nmodel: ${model}\n---\nbody\n`);
  return dir;
}
/** @param {string} dir @param {Record<string, unknown>} toolInput @param {Record<string, string>} [env] */
function launch(dir, toolInput, env = {}) {
  const base = { ...process.env };
  for (const k of CLEAR) delete base[k];
  for (const k of Object.keys(base)) if (k.startsWith("CLAUDE_PLUGIN_OPTION_")) delete base[k];
  return spawnSync(process.execPath, [join(dir, ".claude", "hooks", "plan-check.mjs")], {
    input: JSON.stringify({ session_id: "s1", tool_name: "Agent", tool_input: toolInput }),
    env: { ...base, CLAUDE_PROJECT_DIR: dir, CLAUDE_CONFIG_DIR: join(dir, "no-config"), ORCH_SKILL_HINTS: "off", ORCH_BUILTINS_FILE: "", ...env },
    encoding: "utf8",
  });
}
/** @param {{ stdout: string }} r */
const out = (r) => JSON.parse(r.stdout).hookSpecificOutput;
/** @param {string} dir */
const floorLog = (dir) => {
  const f = join(dir, ".claude", "state", "model-floor.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
};

test("haiku rule: an explicit haiku model on any of this plugin's agents is raised to sonnet, everything else kept", () => {
  const dir = project({ researcher: "sonnet", reviewer: "sonnet", integrator: "sonnet" });
  try {
    for (const type of ["researcher", "orchestration:researcher", "reviewer", "orchestration:reviewer", "integrator", "orchestration:integrator"]) {
      for (const model of ["haiku", "claude-haiku-5-5", " Haiku "]) {
        const input = { subagent_type: type, prompt: "Find the entry point.", model, description: "look", run_in_background: true };
        const r = launch(dir, input);
        assert.equal(r.status, 0, r.stderr);
        const o = out(r);
        assert.equal(o.permissionDecision, "allow");
        assert.deepEqual(o.updatedInput, { ...input, model: "sonnet" }, `${type} ${model}`);
      }
    }
    const log = floorLog(dir);
    assert.equal(log.length, 18);
    assert.ok(log.every((e) => e.decision === "raise" && e.from === "haiku" && e.to === "sonnet" && e.model_source === "call" && e.session_id === "s1"));
    assert.ok(!JSON.stringify(log).includes("entry point"), "no brief text in the log");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("haiku rule: an agent file that still says haiku is raised; sonnet, opus and fable are never touched", () => {
  const dir = project({ researcher: "haiku", reviewer: "sonnet" });
  try {
    const fromFile = launch(dir, { subagent_type: "researcher", prompt: "Read it." });
    assert.equal(out(fromFile).updatedInput.model, "sonnet");
    assert.equal(floorLog(dir).at(-1).model_source, "agent_file");
    // The call's own model wins over the file, as in Claude Code.
    for (const model of ["sonnet", "opus", "fable", "claude-fable-5-2"]) {
      const r = launch(dir, { subagent_type: "researcher", prompt: "Read it.", model });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "", model);
    }
    const reviewer = launch(dir, { subagent_type: "reviewer", prompt: "Review it." });
    assert.equal(reviewer.stdout, "");
    assert.equal(floorLog(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("haiku rule: ORCH_ALLOW_HAIKU=1 or the plugin option leaves haiku alone; any other value does not", () => {
  const dir = project({ researcher: "haiku" });
  try {
    for (const env of /** @type {Record<string, string>[]} */ ([{ ORCH_ALLOW_HAIKU: "1" }, { ORCH_ALLOW_HAIKU: " 1 " }, { CLAUDE_PLUGIN_OPTION_ALLOW_HAIKU: "1" }])) {
      const r = launch(dir, { subagent_type: "researcher", prompt: "Read it.", model: "haiku" }, env);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "", JSON.stringify(env));
    }
    assert.equal(floorLog(dir).length, 0);
    for (const env of /** @type {Record<string, string>[]} */ ([{ ORCH_ALLOW_HAIKU: "0" }, { ORCH_ALLOW_HAIKU: "yes" }, { ORCH_ALLOW_HAIKU: "" }])) {
      assert.equal(out(launch(dir, { subagent_type: "researcher", prompt: "Read it." }, env)).updatedInput.model, "sonnet", JSON.stringify(env));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("haiku rule: built-ins, fork, other plugins' agents and the user's own subagent model setting are left alone", () => {
  const dir = project({ researcher: "sonnet" });
  try {
    for (const type of ["general-purpose", "Explore", "fork", "other:researcher", "my-agent", ""]) {
      const r = launch(dir, { subagent_type: type, prompt: "Look.", model: "haiku" });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "", type);
    }
    const env = launch(dir, { subagent_type: "researcher", prompt: "Look." }, { CLAUDE_CODE_SUBAGENT_MODEL: "haiku" });
    assert.equal(env.stdout, "");
    assert.equal(floorLog(dir).length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("haiku rule: an implementer launch is raised on its allow, and a blocked launch stays blocked", () => {
  const dir = project({ implementer: "opus" });
  try {
    // Light path: no plan review, one implementer with SLICE, FILES, DEPENDS and PATH: light.
    const brief = "SLICE: S1\nFILES: a.js\nDEPENDS: none\nPATH: light\nFix the bug in a.js.";
    const ok = launch(dir, { subagent_type: "implementer", prompt: brief, model: "haiku" });
    assert.equal(ok.status, 0, ok.stderr);
    const o = out(ok);
    assert.equal(o.updatedInput.model, "sonnet");
    assert.equal(o.updatedInput.prompt, brief);
    const blocked = launch(dir, { subagent_type: "implementer", prompt: "no header at all", model: "haiku" });
    assert.equal(blocked.status, 2);
    assert.equal(blocked.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the shipped agent files and role defaults name no haiku model", async () => {
  for (const agent of ["orchestrator", "researcher", "implementer", "reviewer", "integrator"]) {
    const text = readFileSync(join(root, ".claude", "agents", `${agent}.md`), "utf8");
    const model = /^model:\s*(\S+)/m.exec(text)?.[1];
    assert.ok(model && !/haiku/i.test(model), `${agent}.md runs on ${model}`);
  }
  const agents = Object.fromEntries(["orchestrator", "researcher", "implementer", "reviewer", "integrator"].map((a) => [a, /^model:\s*(\S+)/m.exec(readFileSync(join(root, ".claude", "agents", `${a}.md`), "utf8"))?.[1]]));
  // Fable plans, opus does the tasks, sonnet does the rest.
  assert.deepEqual(agents, { orchestrator: "fable", researcher: "sonnet", implementer: "opus", reviewer: "sonnet", integrator: "sonnet" });
  const auto = readFileSync(join(root, "scripts", "auto.sh"), "utf8");
  assert.match(auto, /ORCH_AGENT=none ORCH_MODEL="\$\{ORCH_MODEL:-opus\}"/, "the plain session of npm run auto runs on opus");
});
