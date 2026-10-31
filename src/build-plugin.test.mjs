// Builds the plugin with --out into temp dirs: the workflow ships with namespaced agent types, evals/ is copied only
// when present, the judge hooks are registered only when their files exist, and dist/ is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
    assert.deepEqual(hb.PreToolUse.map((/** @type {any} */ h) => h.matcher), ["Agent|Task"]);
    assert.ok(!existsSync(join(bare, "dist")), "a build with --out writes no dist/");

    build(full, outFull);
    assert.equal(readFileSync(join(outFull, "plugin", "evals", "cases", "one.json"), "utf8"), '{"id":"one"}\n');
    const hf = hooksJson(outFull).hooks;
    const judge = hf.PreToolUse.find((/** @type {any} */ h) => h.matcher === "Bash");
    assert.ok(judge, "judge-hook on PreToolUse Bash");
    assert.equal(judge.hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/judge-hook.mjs" --plugin');
    assert.deepEqual(hf.UserPromptSubmit, [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/prompt-capture.mjs" --plugin' }] }]);
    assert.ok(existsSync(join(outFull, "plugin", "hooks", "judge-hook.mjs")));
    assert.ok(existsSync(join(outFull, "plugin", "workflows", "orchestrate.js")));
  } finally {
    for (const d of [bare, full, outBare, outFull]) rmSync(d, { recursive: true, force: true });
  }
});

test("--out without a directory fails", () => {
  const r = spawnSync("node", [script, "--out"], { cwd: root, encoding: "utf8" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--out needs a directory/);
});
