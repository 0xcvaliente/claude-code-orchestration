// Builds the plugin with --out into temp dirs: the workflow ships with namespaced agent types, evals/ is copied only
// when present, the judge hooks are registered only when their files exist, and dist/ is never touched. Then checks the
// committed plugin against .claude/settings.json: the 0.4.0 hooks, timeouts, the fail-closed judge and userConfig.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "build-plugin.mjs");

/** @param {string} cwd @param {string} out */
function build(cwd, out) {
  const r = spawnSync("node", [script, "--out", out], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r;
}
/** @param {string} out */
const hooksJson = (out) => JSON.parse(readFileSync(join(out, "plugin", "hooks", "hooks.json"), "utf8"));
/** @param {any} h */
const commands = (h) => JSON.stringify(h);

// Snapshot of dist/: every file path with its size and mtime.
/** @param {string} dir @returns {string[]} */
function snapshot(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => {
      const p = join(e.parentPath, e.name);
      const s = statSync(p);
      return `${p} ${s.size} ${s.mtimeMs}`;
    })
    .sort();
}

// A temp project with this repo's .claude, dashboard and package.json, so judge files and evals/ can be simulated.
/** @param {{ judge?: boolean, evals?: boolean }} o */
function project({ judge = false, evals = false }) {
  const dir = mkdtempSync(join(tmpdir(), "build-plugin-proj-"));
  cpSync(join(root, ".claude"), join(dir, ".claude"), {
    recursive: true,
    filter: (p) => !/[\\/](worktrees|state)([\\/]|$)/.test(p.slice(root.length)) && !/(judge-hook|prompt-capture)\.mjs$/.test(p),
  });
  cpSync(join(root, "dashboard"), join(dir, "dashboard"), { recursive: true });
  cpSync(join(root, "package.json"), join(dir, "package.json"));
  if (judge) {
    writeFileSync(join(dir, ".claude", "hooks", "judge-hook.mjs"), "process.exit(0);\n");
    writeFileSync(join(dir, ".claude", "hooks", "prompt-capture.mjs"), "process.exit(0);\n");
  }
  if (evals) {
    mkdirSync(join(dir, "evals", "cases"), { recursive: true });
    writeFileSync(join(dir, "evals", "cases", "one.json"), '{"id":"one"}\n');
  }
  return dir;
}

test("--out builds from the repo into a temp dir, ships the workflow with namespaced agent types, and leaves dist/ untouched", () => {
  const before = snapshot(join(root, "dist"));
  const out = mkdtempSync(join(tmpdir(), "build-plugin-out-"));
  try {
    build(root, out);
    const wf = readFileSync(join(out, "plugin", "workflows", "orchestrate.js"), "utf8");
    const types = [...wf.matchAll(/agentType: '([^']+)'/g)].map((m) => m[1]);
    assert.ok(types.length >= 4, "the workflow names its agent types");
    for (const t of types) assert.match(String(t), /^orchestration:(implementer|reviewer|researcher|integrator)$/);
    assert.match(wf, /^export const meta = \{/m, "the meta literal is kept");
    // The rest of the script is unchanged.
    const src = readFileSync(join(root, ".claude", "workflows", "orchestrate.js"), "utf8");
    assert.equal(wf.replaceAll("agentType: 'orchestration:", "agentType: '"), src);
    assert.ok(existsSync(join(out, "plugin", ".claude-plugin", "plugin.json")));
    assert.ok(existsSync(join(out, "dashboard", ".claude-plugin", "plugin.json")));
    // The plugin verify.sh matcher matches the agent_type a plugin-workflow implementer reports.
    const stop = hooksJson(out).hooks.SubagentStop;
    assert.ok(stop.some((/** @type {any} */ h) => h.matcher === "orchestration:implementer" && /verify\.sh/.test(commands(h))));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  assert.deepEqual(snapshot(join(root, "dist")), before, "dist/ untouched");
});

test("evals/ is copied when present and skipped when absent; judge hooks only when their files exist", () => {
  const bare = project({});
  const full = project({ judge: true, evals: true });
  const outBare = mkdtempSync(join(tmpdir(), "build-plugin-out-"));
  const outFull = mkdtempSync(join(tmpdir(), "build-plugin-out-"));
  try {
    build(bare, outBare);
    assert.ok(!existsSync(join(outBare, "plugin", "evals")), "no evals/ without a source");
    const hb = hooksJson(outBare).hooks;
    assert.ok(!/judge-hook|prompt-capture/.test(commands(hb)), "no judge hooks without their files");
    assert.equal(hb.UserPromptSubmit, undefined);
    assert.deepEqual(hb.PreToolUse.map((/** @type {any} */ h) => h.matcher), ["Agent|Task", "Bash", "WebFetch", "SubagentHandback"]);
    assert.ok(existsSync(join(outBare, "plugin", "settings.json")), "the subagent status line setting ships with its script");
    assert.ok(!existsSync(join(bare, "dist")), "a build with --out writes no dist/");

    build(full, outFull);
    assert.equal(readFileSync(join(outFull, "plugin", "evals", "cases", "one.json"), "utf8"), '{"id":"one"}\n');
    const hf = hooksJson(outFull).hooks;
    const judge = hf.PreToolUse.find((/** @type {any} */ h) => /judge-hook/.test(commands(h)));
    assert.equal(judge?.matcher, "Bash", "judge-hook on PreToolUse Bash");
    assert.equal(judge.hooks.length, 1);
    assert.equal(judge.hooks[0].command, `sh -c 'command -v node >/dev/null 2>&1 || exit 0; exec node "$0" "$@"' "\${CLAUDE_PLUGIN_ROOT}/hooks/judge-hook.mjs" --plugin`);
    assert.deepEqual([judge.hooks[0].onFailure, judge.hooks[0].timeout], ["block", 120]);
    assert.deepEqual(hf.UserPromptSubmit, [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/prompt-capture.mjs" --plugin' }] }]);
    assert.ok(existsSync(join(outFull, "plugin", "hooks", "judge-hook.mjs")));
    assert.ok(existsSync(join(outFull, "plugin", "workflows", "orchestrate.js")));
  } finally {
    for (const d of [bare, full, outBare, outFull]) rmSync(d, { recursive: true, force: true });
  }
});

// The committed plugin (dist/plugin) next to the project settings: the 0.4.0 hooks, timeouts, the judge's onFailure,
// and userConfig for every switch state.mjs bridges.
/** @param {string} p */
const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
/** @param {any} h @param {string} event @param {string} script @returns {any} */
const entry = (h, event, script) =>
  (h.hooks[event] ?? []).find((/** @type {any} */ e) => e.hooks.some((/** @type {any} */ c) => c.command.includes(`/${script}`)));

test("0.4.0 hooks are registered with the same matchers in the project settings and the plugin, and ship", () => {
  const project = read(".claude/settings.json");
  const plugin = read("dist/plugin/hooks/hooks.json");
  const shared = [
    ["PostToolUse", "read-log.mjs", "Read|WebFetch"],
    ["PreToolUse", "researcher-guard.mjs", "Bash"],
    ["PreToolUse", "egress-guard.mjs", "WebFetch"],
    ["SessionStart", "compact-context.mjs", "compact"],
    ["PreToolUse", "judge-hook.mjs", "Bash"],
    ["PreToolUse", "plan-check.mjs", "Agent|Task"],
  ];
  for (const [event, script, matcher] of shared) {
    for (const h of [project, plugin]) assert.equal(entry(h, String(event), String(script))?.matcher, matcher, `${event} ${script}`);
  }
  // verify.sh has no duplicate() check: its project and plugin matchers are disjoint, so no stop reaches both.
  const vp = new RegExp(entry(project, "SubagentStop", "verify.sh").matcher);
  const vq = new RegExp(entry(plugin, "SubagentStop", "verify.sh").matcher);
  assert.ok(vp.test("implementer") && !vp.test("orchestration:implementer"), "project verify.sh");
  assert.ok(vq.test("orchestration:implementer") && !vq.test("implementer"), "plugin verify.sh");
  // quote-check exits on duplicate() in the plugin, so the project copy must cover both researcher types itself.
  const qp = new RegExp(entry(project, "SubagentStop", "quote-check.mjs").matcher);
  const qq = new RegExp(entry(plugin, "SubagentStop", "quote-check.mjs").matcher);
  assert.equal(qp.source, "(^|:)researcher$");
  assert.ok(qq.test("orchestration:researcher") && !qq.test("researcher"), "plugin quote-check");
  for (const other of ["reviewer", "orchestration:reviewer"]) {
    for (const m of [vp, vq, qp, qq]) assert.ok(!m.test(other), `${m} skips ${other}`);
  }
  for (const m of [qp, qq]) assert.ok(!m.test("implementer") && !m.test("orchestration:implementer"), `${m} skips implementers`);
  const quoteCheck = readFileSync(join(root, ".claude", "hooks", "quote-check.mjs"), "utf8");
  assert.ok(quoteCheck.includes('if (duplicate("quote-check.mjs")) process.exit(0);'), "the plugin copy steps aside");
  const files = ["read-log", "researcher-guard", "egress-guard", "compact-context", "quote-check", "file-profile", "bugfix-check"];
  for (const f of files) assert.ok(existsSync(join(root, "dist", "plugin", "hooks", `${f}.mjs`)), `${f}.mjs ships`);
});

test("the project quote-check matcher matches both the bare and the plugin researcher", () => {
  const m = new RegExp(entry(read(".claude/settings.json"), "SubagentStop", "quote-check.mjs").matcher);
  assert.ok(m.test("researcher"), "researcher");
  assert.ok(m.test("orchestration:researcher"), "orchestration:researcher");
  assert.ok(!m.test("not-researcher") && !m.test("researcher2"));
});

test("explicit timeouts, and only the judge fails closed", () => {
  for (const h of [read(".claude/settings.json"), read("dist/plugin/hooks/hooks.json")]) {
    assert.equal(entry(h, "SubagentStop", "verify.sh").hooks[0].timeout, 900);
    assert.equal(entry(h, "PreToolUse", "plan-check.mjs").hooks[0].timeout, 60);
    const judge = entry(h, "PreToolUse", "judge-hook.mjs").hooks;
    assert.equal(judge.length, 1, "the judge has an entry of its own");
    assert.deepEqual([judge[0].onFailure, judge[0].timeout], ["block", 120]);
    const all = Object.values(h.hooks).flatMap((/** @type {any} */ l) => l.flatMap((/** @type {any} */ e) => e.hooks));
    assert.deepEqual(all.filter((/** @type {any} */ c) => c.onFailure), judge);
  }
});

test("the judge command exits 0 without node, so onFailure never blocks every Bash command, and runs the hook with node", () => {
  const dir = mkdtempSync(join(tmpdir(), "build-plugin-judge-"));
  try {
    const stub = "process.stderr.write(process.argv.slice(2).join(' ')); process.exit(2);\n";
    for (const d of [join(dir, ".claude", "hooks"), join(dir, "plugin", "hooks")]) {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "judge-hook.mjs"), stub);
    }
    const noNode = join(dir, "bin"); // a PATH with sh but no node
    mkdirSync(noNode);
    symlinkSync("/bin/sh", join(noNode, "sh")); // a link, not a copy: macOS kills a copied system binary
    const env = { CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: join(dir, "plugin") };
    const cases = [
      [entry(read(".claude/settings.json"), "PreToolUse", "judge-hook.mjs").hooks[0].command, ""],
      [entry(read("dist/plugin/hooks/hooks.json"), "PreToolUse", "judge-hook.mjs").hooks[0].command, "--plugin"],
    ];
    for (const [command, args] of cases) {
      const missing = spawnSync("/bin/sh", ["-c", command], { env: { ...env, PATH: noNode }, input: "{}", encoding: "utf8" });
      assert.equal(missing.status, 0, `${command}: ${missing.stderr}`);
      const real = spawnSync("/bin/sh", ["-c", command], { env: { ...env, PATH: process.env.PATH }, input: "{}", encoding: "utf8" });
      assert.deepEqual([real.status, real.stderr], [2, args], command);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("userConfig declares every bridged switch with a type, title and a description naming its ORCH_ variable", () => {
  const manifest = read("dist/plugin/.claude-plugin/plugin.json");
  assert.equal(manifest.version, read("package.json").version);
  const state = readFileSync(join(root, ".claude", "hooks", "state.mjs"), "utf8");
  const list = state.match(/OPTION_KEYS = Object\.freeze\(\[([^\]]*)\]/)?.[1] ?? "";
  const keys = [...list.matchAll(/"(\w+)"/g)].map((m) => String(m[1]));
  assert.equal(keys.length, 17);
  assert.deepEqual(Object.keys(manifest.userConfig).sort(), keys.map((k) => k.toLowerCase()).sort());
  const verify = readFileSync(join(root, ".claude", "hooks", "verify.sh"), "utf8");
  assert.ok(verify.includes(`for _k in ${keys.join(" ")}; do`), "verify.sh bridges the same keys");
  /** @type {Record<string, string>} */
  const numbers = { judge_timeout_ms: "number", gap_min: "number", run_stale_min: "number" };
  for (const [key, opt] of Object.entries(manifest.userConfig)) {
    assert.equal(opt.type, numbers[key] ?? "string", key);
    assert.ok(opt.title && opt.description, key);
    assert.ok(opt.description.includes(`ORCH_${key.toUpperCase()}`), `${key} names its variable`);
  }
  const defaults = Object.entries(manifest.userConfig).filter(([, o]) => "default" in o).map(([k, o]) => [k, o.default]);
  assert.deepEqual(Object.fromEntries(defaults), { gap_min: 80, run_stale_min: 30, baseline: "inform" });
});

test("1.2.0: reports are checked at SubagentHandback in the project and the plugin, and the plugin ships the subagent status line", () => {
  for (const [h, tail] of /** @type {[any, string][]} */ ([[read(".claude/settings.json"), ""], [read("dist/plugin/hooks/hooks.json"), " --plugin"]])) {
    const e = h.hooks.PreToolUse.find((/** @type {any} */ x) => x.matcher === "SubagentHandback");
    assert.ok(e, "a SubagentHandback entry");
    const cmds = e.hooks.map((/** @type {any} */ c) => String(c.command));
    assert.equal(cmds.length, 2);
    assert.ok(cmds[0].includes("handback-check.mjs") && cmds[1].includes("quote-check.mjs"));
    for (const c of cmds) assert.ok(c.endsWith(`.mjs"${tail}`), c);
    // Deny-only hooks: neither fails closed, so a crash never holds a report back.
    assert.ok(e.hooks.every((/** @type {any} */ c) => c.onFailure === undefined));
  }
  for (const f of ["handback-check.mjs", "subagent-statusline.mjs"]) assert.ok(existsSync(join(root, "dist", "plugin", "hooks", f)), `${f} ships`);
  // A plugin may set only `agent` and `subagentStatusLine`: the file holds exactly the one key.
  assert.deepEqual(read("dist/plugin/settings.json"), { subagentStatusLine: { type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/subagent-statusline.mjs" --plugin' } });
  // The project's own settings do not set it: the plugin's default, or the person's own row, applies there.
  assert.equal(read(".claude/settings.json").subagentStatusLine, undefined);
});

test("--out without a directory fails", () => {
  const r = spawnSync("node", [script, "--out"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--out needs a directory/);
});
