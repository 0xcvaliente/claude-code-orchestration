// Claude Code 2.1.327 to 2.1.331 (release 2.1.0): each decision of docs/data/probes-2.1.0-claude-code.md that rests on
// code, pinned against the real hooks and scripts. Model-free: hooks run on payloads shaped as the changelog entries
// describe, and scripts/orchestrate.sh runs on a fake `claude` first on PATH.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
/** @param {string} name */
const hook = (name) => join(root, ".claude", "hooks", name);
/** @param {string} p */
const readJson = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

/** A project folder with a state dir, and the real hooks run in it (session s1). */
function session() {
  const dir = mkdtempSync(join(tmpdir(), "orch-cc331-"));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: "", ORCH_ESCALATION: "", ORCH_RUN_STALE_MIN: "", ORCH_ALLOW_BUILTINS: "", ORCH_GAP_MIN: "", ORCH_STALL_GATE: "" };
  /** @param {string} name @param {object} payload */
  const run = (name, payload) => spawnSync("node", [hook(name)], { input: JSON.stringify({ session_id: "s1", ...payload }), env, encoding: "utf8", timeout: 60000 });
  /** @param {string} file @returns {any[]} */
  const log = (file) => {
    const p = join(dir, ".claude", "state", file);
    return existsSync(p) ? readFileSync(p, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };
  return { dir, run, log, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// 2.1.329: "Changed Stop and SubagentStop hooks to list a Monitor's script as `monitor`, not `shell`, in
// `background_tasks`". Decision: no change. Only the review gate reads the list, and only subagent, workflow and
// teammate entries defer it (ACTIVE_TYPES): a monitor, like a shell before it, is not an agent whose report is coming,
// and one that watches for the whole session would defer every Stop. verify.sh reads top-level fields only (2.0.1).
test("2.1.329: a running monitor in background_tasks does not defer the review gate; a running subagent does", () => {
  const s = session();
  try {
    const id = "agimpl1";
    const IMPL = "orchestration:implementer";
    s.run("telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: id, agent_type: IMPL });
    s.run("journal.mjs", { hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: IMPL, prompt: "SLICE: a\nFILES: a.py\nDEPENDS: none" }, tool_response: { status: "async_launched", agentId: id } });
    // The implementer's own stop, with the session's in-flight work listed after its fields, a monitor among them.
    const monitor = { id: "m1", type: "monitor", status: "running", description: "tail -f build.log" };
    const stop = { hook_event_name: "SubagentStop", agent_id: id, agent_type: IMPL, last_assistant_message: "STATUS: pass", background_tasks: [monitor] };
    assert.equal(s.run("telemetry.mjs", stop).status, 0);
    assert.equal(s.run("journal.mjs", stop).status, 0);
    assert.deepEqual(s.log("journal.jsonl").map((r) => [r.agent_id, r.role]), [[id, "implementer"]], "the stop is the implementer's own");

    // No reviewer ran: with only a monitor (and a shell) running, the gate judges and blocks.
    let r = s.run("review-gate.mjs", { hook_event_name: "Stop", background_tasks: [monitor, { id: "b1", type: "shell", status: "running" }] });
    assert.equal(r.status, 2, r.stderr);
    const last = () => s.log("gates.jsonl").filter((g) => g.gate === "review").at(-1);
    assert.notEqual(last()?.reason, "agents_running");
    // A running subagent beside the monitor still defers, as before.
    r = s.run("review-gate.mjs", { hook_event_name: "Stop", background_tasks: [monitor, { id: "r1", type: "subagent", status: "running", agent_type: "orchestration:reviewer" }] });
    assert.equal(r.status, 0);
    assert.deepEqual([last()?.reason, last()?.agents], ["agents_running", ["orchestration:reviewer"]]);
  } finally {
    s.done();
  }
});

/** scripts/orchestrate.sh on a fake `claude` that records two variables of its environment. @param {Record<string, string>} more */
function headlessEnv(more) {
  const tmp = mkdtempSync(join(tmpdir(), "orch-cc331-sh-"));
  try {
    const bin = join(tmp, "bin");
    const repo = join(tmp, "repo");
    mkdirSync(bin);
    mkdirSync(repo);
    const result = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1 });
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nprintf '%s\\n' "ceiling=$CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS" "fork=$CLAUDE_CODE_FORK_SUBAGENT" > "${tmp}/env"\nprintf '%s\\n' '${result}'\nexit 0\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const r = spawnSync("bash", [join(root, "scripts", "orchestrate.sh"), "the task", repo], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, ORCH_AGENT: "none", ORCH_DRY_RUN: "", ORCH_TEST_CMD: "", ORCH_BUDGET_TOKENS: "", ORCH_BUDGET_USD: "", ORCH_MODEL: "", ORCH_ADD_DIR: "", ORCH_ADVISOR: "", ORCH_SESSION_PERSISTENCE: "", ORCH_ALLOWED_TOOLS: "", ORCH_EXTRA_ALLOWED_TOOLS: "", CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "", ...more },
      encoding: "utf8",
      timeout: 120000,
    });
    assert.equal(r.status, 0, r.stderr);
    return Object.fromEntries(readFileSync(join(tmp, "env"), "utf8").trim().split("\n").map((l) => /** @type {[string, string]} */ (l.split("="))));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// 2.1.328: "Changed `claude -p` with `CLAUDE_CODE_FORK_SUBAGENT=0` to count a background subagent and those it waits for
// against one 10-minute wait; raise `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS` for longer chains". Decision: changed. The
// 2.1.331 program stops background tasks that still run that long after the last turn (default 600000). An implementer's
// work plus its test gate (verify.sh's budget is at most 870 s) can pass that with no orchestrator turn in between.
test("2.1.328: headless runs wait an hour for background agents unless the environment says otherwise", () => {
  const plain = headlessEnv({});
  assert.deepEqual(plain, { ceiling: "3600000", fork: "0" });
  assert.ok(Number(plain.ceiling) > (870 + 60) * 1000 + 600000, "longer than a test gate's whole budget on top of Claude Code's default");
  assert.equal(headlessEnv({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "0" }).ceiling, "0", "0 (no limit) is kept");
  assert.equal(headlessEnv({ CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS: "7200000" }).ceiling, "7200000", "a person's own value wins");
});

// 2.1.327: "Changed subagents launched without a model to stay on the model they started on when resumed, including
// after `/model`"; 2.1.330: "Changed a subagent's model fallback to carry over". Decision: no change. Every agent of this
// repo names its model in its file, the retry's resume is a SendMessage, which the plan check (model floor, read router)
// never sees, and the third attempt is a fresh launch with model opus, which the plan check sees as before.
test("2.1.327 and 2.1.330: model choice happens at launch only; a SendMessage resume never reaches the plan check", () => {
  const agents = join(root, ".claude", "agents");
  for (const f of readdirSync(agents).filter((n) => n.endsWith(".md"))) {
    assert.match(readFileSync(join(agents, f), "utf8"), /^model: \S+$/m, `${f} names its model`);
  }
  const settings = readJson(".claude/settings.json");
  const plugin = readJson("dist/plugin/hooks/hooks.json");
  for (const hooks of [settings.hooks, plugin.hooks]) {
    const pre = hooks.PreToolUse.filter((/** @type {any} */ m) => m.hooks.some((/** @type {any} */ h) => /plan-check\.mjs/.test(h.command)));
    assert.deepEqual(pre.map((/** @type {any} */ m) => m.matcher), ["Agent|Task"]);
  }
  const s = session();
  try {
    const r = s.run("plan-check.mjs", { hook_event_name: "PreToolUse", tool_name: "SendMessage", tool_input: { to: "agimpl1", message: "GAP: 90 fix the empty case" } });
    assert.deepEqual([r.status, r.stdout], [0, ""]);
  } finally {
    s.done();
  }
});

// 2.1.328: "Changed managed `PostToolUse` hooks to no longer fire for calls refused before they ran". Decision: no change.
// journal.mjs, read-log.mjs and turn-budget.mjs are project and plugin hooks, never managed settings, and none needs a
// PostToolUse for a refused call: a launch the plan check refused must leave no launch record anyway.
test("2.1.328: the PostToolUse hooks are project and plugin hooks, not managed ones", () => {
  const want = ["journal.mjs", "read-log.mjs", "turn-budget.mjs"];
  for (const hooks of [readJson(".claude/settings.json").hooks, readJson("dist/plugin/hooks/hooks.json").hooks]) {
    const post = hooks.PostToolUse.flatMap((/** @type {any} */ m) => m.hooks.map((/** @type {any} */ h) => /([\w-]+\.mjs)/.exec(h.command)?.[1]));
    assert.deepEqual(post, want);
  }
  assert.equal(existsSync(join(root, "managed-settings.json")), false, "the repo ships no managed settings");
});

// 2.1.328: "Added `\"onFailure\": \"block\"` for `mcp_tool` hooks"; 2.1.331: "Added `optionalDependencies` to plugin
// manifests" and "Fixed a permission rule on a subagent's model, such as `Agent(model:*)`, blocking Claude's follow-up
// message". Decision: no change. Every hook here is a command hook, the plugin depends on no other plugin, and no
// permission rule names a subagent's model.
test("2.1.328 and 2.1.331: no mcp_tool hook, no plugin dependency, no Agent(model:...) rule", () => {
  const settings = readJson(".claude/settings.json");
  for (const hooks of [settings.hooks, readJson("dist/plugin/hooks/hooks.json").hooks]) {
    for (const list of Object.values(hooks)) for (const m of list) for (const h of m.hooks) assert.equal(h.type, "command");
  }
  for (const p of [".claude-plugin/plugin.json", "dist/plugin/.claude-plugin/plugin.json"].filter((f) => existsSync(join(root, f)))) {
    const manifest = readJson(p);
    assert.equal(manifest.dependencies, undefined, p);
    assert.equal(manifest.optionalDependencies, undefined, p);
  }
  const rules = [...(settings.permissions?.allow ?? []), ...(settings.permissions?.deny ?? []), ...(settings.permissions?.ask ?? [])];
  assert.ok(!rules.some((/** @type {string} */ r) => /^Agent\(model:/.test(r)), "no rule on a subagent's model");
});

// Release 2.1.0 checks against Claude Code 2.1.331: the Agent SDK carries it (0.3.N carries 2.1.N) and CI installs it.
test("2.1.0: the Agent SDK and the CI's Claude Code CLI are the checked version", () => {
  const sdk = JSON.parse(readFileSync(join(dirname(createRequire(join(root, "package.json")).resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8")).version;
  const pkg = readJson("package.json");
  assert.equal(pkg.dependencies["@anthropic-ai/claude-agent-sdk"], `^${sdk}`);
  const patch = sdk.split(".")[2];
  assert.match(readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8"), new RegExp(`npm install -g @anthropic-ai/claude-code@2\\.1\\.${patch}\\b`));
});
