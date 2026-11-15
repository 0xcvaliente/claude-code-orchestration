// turn-budget.mjs (PostToolUse, no matcher): warns one of this plugin's workers once, in additionalContext, when its
// turns (telemetry.mjs's count, from its own transcript) reach 80% of its maxTurns. Driven with payloads and fake
// transcripts; the sh pre-filter is run from the real command strings of a temp build and of .claude/settings.json.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// A temp project with this repo's hooks and an implementer whose maxTurns is 10 (so the warning comes at 8).
function project() {
  const dir = mkdtempSync(join(tmpdir(), "turn-budget-"));
  cpSync(join(root, ".claude", "hooks"), join(dir, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  writeFileSync(join(dir, ".claude", "agents", "implementer.md"), "---\nname: implementer\nmaxTurns: 10\n---\nbody\n");
  writeFileSync(join(dir, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\n---\nno maxTurns\n");
  return dir;
}
/** Writes the agent's own transcript with `turns` assistant messages (two lines each, as Claude Code writes them). @param {string} dir @param {string} id @param {number} turns */
function transcript(dir, id, turns) {
  const sub = join(dir, "sess", "subagents");
  mkdirSync(sub, { recursive: true });
  const lines = [{ type: "user", message: { role: "user", content: "SLICE: a\nFILES: x" } }];
  for (let i = 0; i < turns; i++) {
    for (const block of ["text", "tool_use"]) lines.push(/** @type {any} */ ({ type: "assistant", message: { id: `msg_${i}`, model: "claude-opus-5-5", content: [{ type: block }], usage: { input_tokens: 1, output_tokens: 1 } } }));
    lines.push(/** @type {any} */ ({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }));
  }
  writeFileSync(join(sub, `agent-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}
/** @param {string} dir @param {Record<string, unknown>} [extra] */
const payload = (dir, extra = {}) => ({ hook_event_name: "PostToolUse", session_id: "s1", transcript_path: join(dir, "sess.jsonl"), tool_name: "Bash", tool_input: { command: "ls" }, tool_response: {}, agent_id: "ag1", agent_type: "implementer", ...extra });
/** @param {string} dir @param {unknown} input @param {string[]} [args] @param {Record<string, string>} [env] */
const run = (dir, input, args = [], env = {}) =>
  spawnSync("node", [join(dir, ".claude", "hooks", "turn-budget.mjs"), ...args], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: "", CLAUDE_PLUGIN_DATA: join(dir, "data"), ORCH_TURN_WARNING: "", ...env },
    encoding: "utf8",
  });
const TEXT = (/** @type {number} */ n, /** @type {number} */ m) => `You have used ${n} of your ${m} turns. Commit your work and report now; list what is unfinished under OPEN.`;

test("telemetry.mjs exports its turn count and maxTurnsOf, and importing it runs no hook code", async () => {
  const dir = project();
  try {
    transcript(dir, "ag1", 3);
    const t = await import(join(dir, ".claude", "hooks", "telemetry.mjs"));
    assert.equal(t.usageFromTranscript(join(dir, "sess", "subagents", "agent-ag1.jsonl"), "implementer")?.turns, 3);
    assert.equal(typeof t.maxTurnsOf, "function");
    assert.equal(existsSync(join(dir, ".claude", "state", "telemetry.jsonl")), false, "no record written on import");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("warns once at 80% of maxTurns, with the right counts, only for this plugin's workers", () => {
  const dir = project();
  try {
    transcript(dir, "ag1", 7);
    let r = run(dir, payload(dir));
    assert.deepEqual([r.status, r.stdout], [0, ""], "below the threshold: nothing");
    transcript(dir, "ag1", 8);
    r = run(dir, payload(dir));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: TEXT(8, 10) } });
    transcript(dir, "ag1", 9);
    r = run(dir, payload(dir));
    assert.deepEqual([r.status, r.stdout], [0, ""], "a second call: nothing");
    // The namespaced type is ours too; another agent id warns on its own.
    transcript(dir, "ag2", 8);
    r = run(dir, payload(dir, { agent_id: "ag2", agent_type: "orchestration:implementer" }));
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, TEXT(8, 10));
    // Main session, another agent type, another plugin's implementer: nothing.
    transcript(dir, "ag3", 9);
    const { agent_id: _a, agent_type: _t, ...main } = payload(dir);
    for (const p of [main, payload(dir, { agent_id: "ag3", agent_type: "other-plugin:implementer" }), payload(dir, { agent_id: "ag3", agent_type: "general-purpose" })]) {
      r = run(dir, p);
      assert.deepEqual([r.status, r.stdout], [0, ""], JSON.stringify(p));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the switch, a missing transcript, a missing maxTurns, malformed input and the plugin duplicate: exit 0, no output", () => {
  const dir = project();
  try {
    transcript(dir, "ag1", 9);
    const cases = /** @type {[unknown, string[], Record<string, string>][]} */ ([
      [payload(dir), [], { ORCH_TURN_WARNING: "off" }],
      [payload(dir, { agent_id: "nope" }), [], {}],
      [payload(dir, { transcript_path: join(dir, "missing.jsonl") }), [], {}],
      [payload(dir, { agent_type: "reviewer" }), [], {}],
      [payload(dir, { agent_type: "researcher" }), [], {}], // no researcher.md in this project and no plugin root
      ["not json{", [], {}],
      [payload(dir, { session_id: "../x" }), [], {}],
    ]);
    for (const [p, args, env] of cases) {
      const r = run(dir, p, args, env);
      assert.deepEqual([r.status, r.stdout, r.stderr], [0, "", ""], JSON.stringify(p));
    }
    // The plugin copy steps aside where the project registers its own copy.
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "x .claude/hooks/turn-budget.mjs" }] }] } }));
    const r = run(dir, payload(dir), ["--plugin"]);
    assert.deepEqual([r.status, r.stdout], [0, ""], "duplicate");
    // The switch and the duplicate left no marker, so the project copy still warns.
    assert.equal(JSON.parse(run(dir, payload(dir)).stdout).hookSpecificOutput.additionalContext, TEXT(9, 10));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** @param {any} h @returns {any[]} */
const postToolUse = (h) => h.hooks.PostToolUse;

test("wiring: appended last to PostToolUse with no matcher in the project settings and a temp plugin build", () => {
  const out = mkdtempSync(join(tmpdir(), "turn-budget-build-"));
  try {
    const b = spawnSync("node", [join(root, "scripts", "build-plugin.mjs"), "--out", out], { cwd: root, encoding: "utf8" });
    assert.equal(b.status, 0, b.stderr);
    const plugin = JSON.parse(readFileSync(join(out, "plugin", "hooks", "hooks.json"), "utf8"));
    const projectSettings = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    for (const h of [projectSettings, plugin]) {
      const list = postToolUse(h);
      assert.match(list[0].hooks[0].command, /journal\.mjs/);
      const last = list[list.length - 1];
      assert.equal(last.matcher, undefined);
      assert.equal(last.hooks.length, 1);
      assert.match(last.hooks[0].command, /turn-budget\.mjs/);
      assert.equal(last.hooks[0].onFailure, undefined, "never blocks");
      assert.equal(list.filter((/** @type {any} */ e) => JSON.stringify(e).includes("turn-budget")).length, 1);
    }
    assert.ok(postToolUse(plugin).at(-1).hooks[0].command.endsWith(" --plugin"));
    assert.ok(existsSync(join(out, "plugin", "hooks", "turn-budget.mjs")), "the hook ships");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the sh pre-filter starts node only for a subagent's call, passes the payload on, and does nothing without node", () => {
  const out = mkdtempSync(join(tmpdir(), "turn-budget-sh-"));
  try {
    const b = spawnSync("node", [join(root, "scripts", "build-plugin.mjs"), "--out", join(out, "build")], { cwd: root, encoding: "utf8" });
    assert.equal(b.status, 0, b.stderr);
    const pluginCmd = postToolUse(JSON.parse(readFileSync(join(out, "build", "plugin", "hooks", "hooks.json"), "utf8"))).at(-1).hooks[0].command;
    const projectCmd = postToolUse(JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"))).at(-1).hooks[0].command;
    // A stub in place of the hook records that node ran, with its arguments and stdin.
    const marker = join(out, "ran.json");
    const stub = `import { writeFileSync } from "node:fs"; const c = []; for await (const x of process.stdin) c.push(x); writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), input: Buffer.concat(c).toString("utf8") }));\n`;
    for (const d of [join(out, "proj", ".claude", "hooks"), join(out, "plug", "hooks")]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "turn-budget.mjs"), stub);
    }
    const noNode = join(out, "bin");
    mkdirSync(noNode);
    symlinkSync("/bin/sh", join(noNode, "sh"));
    for (const cmd of ["cat", "printf"]) {
      const p = spawnSync("/bin/sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim();
      if (p.startsWith("/")) symlinkSync(p, join(noNode, cmd));
    }
    const env = { CLAUDE_PROJECT_DIR: join(out, "proj"), CLAUDE_PLUGIN_ROOT: join(out, "plug") };
    const sub = JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: "echo 'a \"b\" $HOME \\n'" }, agent_id: "ag1", agent_type: "implementer" });
    const main = JSON.stringify({ session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } });
    for (const [command, args] of /** @type {[string, string[]][]} */ ([[projectCmd, []], [pluginCmd, ["--plugin"]]])) {
      rmSync(marker, { force: true });
      let r = spawnSync("/bin/sh", ["-c", command], { env: { ...process.env, ...env }, input: main, encoding: "utf8" });
      assert.deepEqual([r.status, r.stdout, existsSync(marker)], [0, "", false], `main session starts no node: ${command}`);
      r = spawnSync("/bin/sh", ["-c", command], { env: { ...process.env, ...env }, input: sub, encoding: "utf8" });
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(readFileSync(marker, "utf8")), { args, input: sub }, `subagent payload reaches node intact: ${command}`);
      rmSync(marker, { force: true });
      r = spawnSync("/bin/sh", ["-c", command], { env: { ...env, PATH: noNode }, input: sub, encoding: "utf8" });
      assert.deepEqual([r.status, existsSync(marker)], [0, false], `no node: exit 0: ${command} ${r.stderr}`);
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});
