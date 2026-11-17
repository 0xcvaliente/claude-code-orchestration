// The workflow guard (workflow-guard.mjs, PreToolUse on Workflow; 1.6.0, identity by content since 1.6.1, with the
// stored hashes in workflow-hash.mjs) and the nudge's refusal of the workflow keyword (nudge.mjs, UserPromptSubmit).
// Run as child processes against temp projects; no model call. The input shapes are the ones recorded live in
// docs/data/live-checks-2026-11-17.md, Check 5 ({"script": ...} for a script written on the spot, {"name": ...,
// "args": ...} for a saved workflow) and docs/data/live-checks-2026-11-17-b.md, K9 (a resume by name adds "resumeFromRunId"; a
// resume by file is {"args", "scriptPath", "resumeFromRunId"} with scriptPath the persisted copy of the saved file).
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { builtinAgents } from "../.claude/hooks/builtin-agents.mjs";
import { BLOCK_MESSAGE, guardOff, LOG, RUN_ID, SAVED_NAMES, workflowDecision } from "../.claude/hooks/workflow-guard.mjs";
import { fileHash, fileSha256, MISSING, PLUGIN_WORKFLOW_SHA256, PROJECT_WORKFLOW_SHA256, UNHASHABLE as UNHASHABLE_FILE, workflowSha256 } from "../.claude/hooks/workflow-hash.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = (/** @type {string} */ name) => join(root, ".claude", "hooks", name);
const SOURCE_WF = join(root, ".claude", "workflows", "orchestrate.js");
const BUILT_WF = join(root, "dist", "plugin", "workflows", "orchestrate.js");
const GUARD_FILES = ["workflow-guard.mjs", "workflow-hash.mjs", "state.mjs"];
const SECRET = "the-script-text-must-never-be-logged";
const RUN = "wf_5a36ce0f-de9"; // the form of the run id seen live
const SWITCHES = /ORCH_|CLAUDE_PLUGIN_OPTION_|workflow_guard|disableWorkflows|CLAUDE_CODE_/;
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCH_") && !k.startsWith("CLAUDE_PLUGIN_")));

/**
 * A temp project: this repo's saved workflow unless `workflow` is false (a string is written as the file's content),
 * plus the built plugin copy under dist/plugin/ when `built` (this repository's layout).
 * @param {{ workflow?: boolean | string, built?: boolean }} [o]
 */
function project({ workflow = true, built = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orch-wfguard-"));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  if (workflow !== false) {
    mkdirSync(join(dir, ".claude", "workflows"), { recursive: true });
    const f = join(dir, ".claude", "workflows", "orchestrate.js");
    if (typeof workflow === "string") writeFileSync(f, workflow);
    else copyFileSync(SOURCE_WF, f);
  }
  if (built) {
    mkdirSync(join(dir, "dist", "plugin", "workflows"), { recursive: true });
    copyFileSync(BUILT_WF, join(dir, "dist", "plugin", "workflows", "orchestrate.js"));
  }
  return dir;
}
/** A plugin layout: <root>/hooks/ (the guard and its modules) and, unless false, <root>/workflows/orchestrate.js. @param {boolean | string} [workflow] */
function pluginDir(workflow = true) {
  const plug = mkdtempSync(join(tmpdir(), "orch-wfguard-plugin-"));
  mkdirSync(join(plug, "hooks"));
  for (const f of GUARD_FILES) copyFileSync(hook(f), join(plug, "hooks", f));
  if (workflow !== false) {
    mkdirSync(join(plug, "workflows"));
    if (typeof workflow === "string") writeFileSync(join(plug, "workflows", "orchestrate.js"), workflow);
    else copyFileSync(BUILT_WF, join(plug, "workflows", "orchestrate.js"));
  }
  return plug;
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
/** @param {...string} dirs */
const cleanup = (...dirs) => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
};
/** @param {{ code: number | null, stderr: string }} r @param {string} reason @param {string} what */
const refused = (r, reason, what) => {
  assert.equal(r.code, 2, `${what}: ${r.stderr}`);
  assert.ok(r.stderr.includes(`(${reason})`), `${what}: ${r.stderr}`);
};
const SILENT = [0, "", ""];
const GUARD = hook("workflow-guard.mjs");

// --- The stored hashes stay in step with the workflow files ---

/**
 * One message per workflow file that no longer hashes to its stored value, holding the line to paste into
 * .claude/hooks/workflow-hash.mjs.
 * @param {{ file: string, stored: string, constant: string }[]} entries
 */
function hashDrift(entries) {
  return entries.flatMap(({ file, stored, constant }) => {
    const sha = fileSha256(file);
    return sha === stored ? [] : [`${file} hashes to ${sha}, not the stored value. Paste into .claude/hooks/workflow-hash.mjs:\nexport const ${constant} = "${sha}";`];
  });
}
const STORED = [
  { file: SOURCE_WF, stored: PROJECT_WORKFLOW_SHA256, constant: "PROJECT_WORKFLOW_SHA256" },
  { file: BUILT_WF, stored: PLUGIN_WORKFLOW_SHA256, constant: "PLUGIN_WORKFLOW_SHA256" },
];

test("the stored hashes match .claude/workflows/orchestrate.js and the built dist/plugin/workflows/orchestrate.js", () => {
  const drift = hashDrift(STORED);
  assert.deepEqual(drift, [], `\n${drift.join("\n")}\n(after a workflow change: npm run build-plugin, paste the lines above, then npm run build-plugin again)`);
  assert.notEqual(PROJECT_WORKFLOW_SHA256, PLUGIN_WORKFLOW_SHA256, "the build rewrites agentType, so the two files differ");
  assert.match(PROJECT_WORKFLOW_SHA256, /^[0-9a-f]{64}$/);
  assert.match(PLUGIN_WORKFLOW_SHA256, /^[0-9a-f]{64}$/);
});

test("the hash test fails, printing the value to paste, when a workflow file changes; CRLF line endings do not count", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-wfhash-"));
  try {
    const src = readFileSync(SOURCE_WF, "utf8");
    const changed = join(dir, "changed.js");
    writeFileSync(changed, `${src}// one more line\n`);
    const drift = hashDrift([{ file: changed, stored: PROJECT_WORKFLOW_SHA256, constant: "PROJECT_WORKFLOW_SHA256" }]);
    assert.equal(drift.length, 1);
    const [message = ""] = drift;
    assert.ok(message.includes(`export const PROJECT_WORKFLOW_SHA256 = "${fileSha256(changed)}";`), message);
    const built = join(dir, "built.js");
    writeFileSync(built, readFileSync(BUILT_WF, "utf8").replace("agentType: 'orchestration:", "agentType: '"));
    assert.equal(hashDrift([{ file: built, stored: PLUGIN_WORKFLOW_SHA256, constant: "PLUGIN_WORKFLOW_SHA256" }]).length, 1, "one rewrite undone is a change");
    const crlf = join(dir, "crlf.js");
    writeFileSync(crlf, src.replace(/\n/g, "\r\n"));
    assert.deepEqual(hashDrift([{ file: crlf, stored: PROJECT_WORKFLOW_SHA256, constant: "PROJECT_WORKFLOW_SHA256" }]), [], "a Windows checkout of the same file");
    const lone = join(dir, "lone-cr.js");
    writeFileSync(lone, src.replace("\n", "\r"));
    assert.equal(hashDrift([{ file: lone, stored: PROJECT_WORKFLOW_SHA256, constant: "PROJECT_WORKFLOW_SHA256" }]).length, 1, "only CRLF is read as LF");
    assert.equal(workflowSha256(Buffer.from("a\r\nb")), workflowSha256(Buffer.from("a\nb")));
    assert.equal(fileSha256(join(dir, "missing.js")), null);
    assert.equal(fileSha256(dir), null, "a folder is not a workflow file");
  } finally {
    cleanup(dir);
  }
});

// --- Launches and resumes that pass ---

test("the saved workflow passes silently: by name with or without args, a resume by name, and the plugin name in this repository's layout", () => {
  const dir = project({ built: true });
  try {
    const inputs = [{ name: "orchestrate", args: { task: "toy" } }, { name: "orchestrate" }, { name: "orchestrate", args: { task: "toy" }, resumeFromRunId: RUN }, { name: "orchestration:orchestrate", args: "x" }];
    for (const input of inputs) assert.deepEqual(Object.values(run(GUARD, dir, launch(input))), SILENT, JSON.stringify(input));
    const recs = records(dir);
    assert.equal(recs.length, inputs.length, "one record per decision");
    assert.deepEqual(recs.map((r) => [r.gate, r.decision, r.reason]), [...Array(3).fill(["workflow", "allow", "saved_workflow"]), ["workflow", "allow", "plugin_built_here"]]);
    assert.deepEqual(recs[0].keys, ["name", "args"]);
    assert.deepEqual(recs[2].keys, ["name", "args", "resumeFromRunId"]);
    assert.equal(recs[0].session_id, "s1");
  } finally {
    cleanup(dir);
  }
});

test("a resume by script file passes only for the persisted copy of the saved workflow, with the run it resumes", () => {
  const dir = project();
  const store = mkdtempSync(join(tmpdir(), "orch-wfguard-store-"));
  try {
    const scripts = join(store, "projects", "key", "session", "workflows", "scripts");
    mkdirSync(scripts, { recursive: true });
    const persisted = join(scripts, `orchestrate-${RUN}.js`);
    copyFileSync(SOURCE_WF, persisted);
    const pluginCopy = join(scripts, `orchestration-orchestrate-${RUN}.js`);
    copyFileSync(BUILT_WF, pluginCopy);
    const other = join(scripts, `other-${RUN}.js`);
    writeFileSync(other, `export const meta = { name: 'orchestrate', description: '${SECRET}', phases: [] }\n`);
    // The shape seen live, and its plugin twin.
    for (const p of [persisted, pluginCopy]) {
      assert.deepEqual(Object.values(run(GUARD, dir, launch({ args: { task: "toy" }, scriptPath: p, resumeFromRunId: RUN }))), SILENT, p);
      assert.deepEqual(Object.values(run(GUARD, dir, launch({ scriptPath: p, resumeFromRunId: RUN }))), SILENT, p);
    }
    /** @type {[unknown, string][]} */
    const cases = [
      [{ scriptPath: other, resumeFromRunId: RUN }, "other content"],
      [{ scriptPath: persisted }, "no run id: not seen"],
      [{ scriptPath: persisted, resumeFromRunId: "wf_other-run" }, "the file is not that run's"],
      [{ scriptPath: persisted, resumeFromRunId: "wf_1" }, "not a run id"],
      [{ scriptPath: persisted, resumeFromRunId: RUN, name: "orchestrate" }, "with a name: not seen"],
      [{ scriptPath: persisted, resumeFromRunId: RUN, script: "x" }, "with a script"],
      [{ scriptPath: persisted, resumeFromRunId: RUN, remote: true }, "an unknown key"],
      [{ scriptPath: `orchestrate-${RUN}.js`, resumeFromRunId: RUN }, "a relative path"],
      [{ scriptPath: join(scripts, "..", `orchestrate-${RUN}.js`), resumeFromRunId: RUN }, "not under workflows/scripts"],
      [{ scriptPath: join(scripts, `missing-${RUN}.js`), resumeFromRunId: RUN }, "no file"],
      [{ scriptPath: 7, resumeFromRunId: RUN }, "not a string"],
    ];
    // Same content outside the scripts folder: refused by its path.
    writeFileSync(join(scripts, "..", `orchestrate-${RUN}.js`), readFileSync(SOURCE_WF));
    for (const [input, what] of cases) refused(run(GUARD, dir, launch(input)), Object.hasOwn(/** @type {object} */ (input), "script") ? "inline_script" : "script_path", what);
    const recs = records(dir);
    assert.deepEqual(recs.slice(0, 4).map((r) => r.reason), Array(4).fill("saved_workflow_resume"));
    assert.ok(!readFileSync(join(dir, ".claude", "state", LOG), "utf8").includes(SECRET), "never the script, path or args");
  } finally {
    cleanup(dir, store);
  }
});

// --- Refusals ---

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
      [{ name: "orchestrate", remote: true }, "unknown_shape"],
      [{ name: "orchestrate", resumeFromRunId: 7 }, "unknown_shape"],
      [{ name: "orchestrate", resumeFromRunId: "wf_1" }, "unknown_shape"],
      [{ name: "orchestrate", resumeFromRunId: "../wf_abcdef" }, "unknown_shape"],
      [{ name: 3 }, "unknown_shape"],
      [{ args: { task: "x" } }, "unknown_shape"],
      [{}, "unknown_shape"],
      ["orchestrate", "unknown_shape"],
      [null, "unknown_shape"],
      [["orchestrate"], "unknown_shape"],
    ];
    for (const [input, reason] of cases) {
      const r = run(GUARD, dir, launch(input));
      refused(r, reason, JSON.stringify(input));
      assert.equal(r.stdout, "", "a refusal prints nothing on stdout");
      assert.ok(r.stderr.includes(BLOCK_MESSAGE), r.stderr);
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
    cleanup(dir);
  }
});

test("bare orchestrate: other content at the saved name is refused, a missing file is refused, and every root that has one must match", () => {
  const written = project({ workflow: `export const meta = { name: 'orchestrate', description: 'written on the spot', phases: [] }\nreturn 1\n` });
  const bare = project({ workflow: false });
  const good = project();
  const crlf = project({ workflow: readFileSync(SOURCE_WF, "utf8").replace(/\n/g, "\r\n") });
  const appended = project({ workflow: `${readFileSync(SOURCE_WF, "utf8")}\nawait agent('x')\n` });
  try {
    const go = launch({ name: "orchestrate" });
    refused(run(GUARD, written, go), "workflow_content_mismatch", "a file a model wrote at the saved path");
    refused(run(GUARD, appended, go), "workflow_content_mismatch", "the saved file with one more line");
    refused(run(GUARD, written, launch({ name: "orchestrate", resumeFromRunId: RUN })), "workflow_content_mismatch", "a resume by name runs the file as it is now");
    refused(run(GUARD, bare, go), "workflow_file_missing", "no file");
    assert.deepEqual(Object.values(run(GUARD, crlf, go)), SILENT, "a CRLF checkout of the same file");
    // A folder at the saved path exists and cannot be hashed: refused, never counted as missing.
    const folder = project({ workflow: false });
    mkdirSync(join(folder, ".claude", "workflows", "orchestrate.js"), { recursive: true });
    refused(run(GUARD, folder, go), "workflow_unreadable", "a folder");
    // A FIFO at the saved path neither stalls the hook nor passes.
    const fifo = project({ workflow: false });
    mkdirSync(join(fifo, ".claude", "workflows"), { recursive: true });
    if (spawnSync("mkfifo", [join(fifo, ".claude", "workflows", "orchestrate.js")]).status === 0) {
      const t0 = Date.now();
      refused(run(GUARD, fifo, go), "workflow_unreadable", "a FIFO");
      assert.ok(Date.now() - t0 < 10_000, "the hook did not wait on the FIFO");
    }
    cleanup(folder, fifo);
    // The input's cwd counts as a project root too; a root whose file differs refuses the launch.
    assert.deepEqual(Object.values(run(GUARD, bare, launch({ name: "orchestrate" }, { cwd: good }))), SILENT);
    refused(run(GUARD, good, launch({ name: "orchestrate" }, { cwd: written })), "workflow_content_mismatch", "cwd with other content");
    refused(run(GUARD, written, launch({ name: "orchestrate" }, { cwd: good })), "workflow_content_mismatch", "project dir with other content");
  } finally {
    cleanup(written, bare, good, crlf, appended);
  }
});

/**
 * Puts something that exists but cannot be hashed at `file`: "large" (over the 4 MB cap), "folder", "fifo", "device"
 * (a link to /dev/null), "dangling" (a link to nothing) or "unreadable" (mode 000). False when the platform cannot
 * make it, or (unreadable) when this process reads it anyway (root).
 * @param {string} file @param {string} kind
 */
function unhashable(file, kind) {
  mkdirSync(dirname(file), { recursive: true });
  rmSync(file, { recursive: true, force: true });
  if (kind === "large") writeFileSync(file, Buffer.alloc(5 * 1024 * 1024));
  else if (kind === "folder") mkdirSync(file);
  else if (kind === "fifo") return spawnSync("mkfifo", [file]).status === 0;
  else if (kind === "device") {
    if (!existsSync("/dev/null")) return false;
    symlinkSync("/dev/null", file);
  } else if (kind === "dangling") symlinkSync(join(dirname(file), "nothing-here.js"), file);
  else if (kind === "unreadable") {
    copyFileSync(SOURCE_WF, file);
    chmodSync(file, 0o000);
    try {
      readFileSync(file);
      return false;
    } catch {
      return true;
    }
  }
  return true;
}
const UNHASHABLE = ["large", "folder", "fifo", "device", "dangling", "unreadable"];

test("a candidate file that exists but cannot be hashed refuses the launch; only a path where nothing exists is skipped", () => {
  const made = /** @type {string[]} */ ([]);
  const dirs = /** @type {string[]} */ ([]);
  try {
    for (const kind of UNHASHABLE) {
      // The reported tree: R/.claude/workflows/orchestrate.js cannot be hashed, R/sub holds the real workflow, cwd R/sub.
      const r = project({ workflow: false });
      dirs.push(r);
      mkdirSync(join(r, "sub", ".claude", "workflows"), { recursive: true });
      copyFileSync(SOURCE_WF, join(r, "sub", ".claude", "workflows", "orchestrate.js"));
      if (!unhashable(join(r, ".claude", "workflows", "orchestrate.js"), kind)) continue;
      made.push(kind);
      refused(run(GUARD, r, launch({ name: "orchestrate" }, { cwd: join(r, "sub") })), "workflow_unreadable", `${kind} in the project dir, the real file in cwd`);
      refused(run(GUARD, join(r, "sub"), launch({ name: "orchestrate" }, { cwd: r }), { CLAUDE_PROJECT_DIR: join(r, "sub") }), "workflow_unreadable", `${kind} in cwd, the real file in the project dir`);
      refused(run(GUARD, r, launch({ name: "orchestrate" })), "workflow_unreadable", `${kind} alone`);
      // The both-copies rule: the project copy, plugin name, this repository's layout with an unhashable file.
      const layout = project({ built: true });
      dirs.push(layout);
      assert.deepEqual(Object.values(run(GUARD, layout, launch({ name: "orchestration:orchestrate" }))), SILENT);
      unhashable(join(layout, "dist", "plugin", "workflows", "orchestrate.js"), kind);
      refused(run(GUARD, layout, launch({ name: "orchestration:orchestrate" })), "workflow_unreadable", `${kind} as the built copy`);
      const layout2 = project({ built: true });
      dirs.push(layout2);
      const sub2 = join(layout2, "sub");
      mkdirSync(sub2);
      unhashable(join(sub2, ".claude", "workflows", "orchestrate.js"), kind);
      refused(run(GUARD, layout2, launch({ name: "orchestration:orchestrate" }, { cwd: sub2 })), "workflow_unreadable", `${kind} in a second root of the layout`);
      // The plugin copy's own file.
      const plug = pluginDir(false);
      dirs.push(plug);
      unhashable(join(plug, "workflows", "orchestrate.js"), kind);
      refused(run(join(plug, "hooks", "workflow-guard.mjs"), r, launch({ name: "orchestration:orchestrate" }), { CLAUDE_PLUGIN_DATA: plug }, ["--plugin"]), "workflow_unreadable", `${kind} as the plugin's file`);
      // A resume's scriptPath.
      const scripts = join(r, "store", "workflows", "scripts");
      unhashable(join(scripts, `orchestrate-${RUN}.js`), kind);
      refused(run(GUARD, r, launch({ scriptPath: join(scripts, `orchestrate-${RUN}.js`), resumeFromRunId: RUN })), "script_path", `${kind} as the resume's file`);
    }
    assert.ok(made.includes("large") && made.includes("folder") && made.includes("dangling"), made.join(","));
    // Nothing at all at either root stays refused; nothing at one root is skipped.
    const bare = project({ workflow: false });
    const good = project();
    dirs.push(bare, good);
    refused(run(GUARD, bare, launch({ name: "orchestrate" }, { cwd: join(bare, "nowhere") })), "workflow_file_missing", "no candidate exists");
    assert.deepEqual(Object.values(run(GUARD, bare, launch({ name: "orchestrate" }, { cwd: good }))), SILENT, "a root with nothing is skipped");
    assert.equal(fileHash(join(bare, "missing.js")), MISSING);
    assert.equal(fileHash(join(bare, "missing-dir", "x.js")), MISSING, "a missing folder on the way");
    assert.equal(fileHash(join(SOURCE_WF, "x.js")), MISSING, "a file on the way (ENOTDIR)");
    assert.equal(fileHash(bare), UNHASHABLE_FILE);
    assert.equal(fileHash(SOURCE_WF), PROJECT_WORKFLOW_SHA256);
  } finally {
    for (const d of dirs) {
      try {
        spawnSync("chmod", ["-R", "u+rwx", d]);
      } catch {
        // best effort before removal
      }
    }
    cleanup(...dirs);
  }
});

test("the plugin name: the plugin copy checks its own built workflow; the project copy refuses it outside this repository's layout", () => {
  const plain = project({ workflow: false });
  const copied = project(); // a project carrying a copy of .claude/, no dist/
  const layout = project({ built: true });
  const data = mkdtempSync(join(tmpdir(), "orch-wfguard-data-"));
  const plugins = [pluginDir(), pluginDir(false), pluginDir(readFileSync(SOURCE_WF, "utf8")), pluginDir("export const meta = { name: 'orchestrate', phases: [] }\n")];
  try {
    const go = launch({ name: "orchestration:orchestrate", args: { task: "x" } });
    const env = { CLAUDE_PLUGIN_DATA: data };
    const [real, none, unbuilt, other] = /** @type {[string, string, string, string]} */ (plugins.map((p) => join(p, "hooks", "workflow-guard.mjs")));
    assert.deepEqual(Object.values(run(real, plain, go, env, ["--plugin"])), SILENT, "the plugin's real workflow");
    assert.deepEqual(Object.values(run(real, plain, launch({ name: "orchestration:orchestrate", resumeFromRunId: RUN }), env, ["--plugin"])), SILENT, "and its resume by name");
    refused(run(none, plain, go, env, ["--plugin"]), "workflow_file_missing", "no plugin workflow");
    refused(run(unbuilt, plain, go, env, ["--plugin"]), "workflow_content_mismatch", "the source, not the built copy");
    refused(run(other, plain, go, env, ["--plugin"]), "workflow_content_mismatch", "other content");
    refused(run(real, plain, launch({ script: "x" }), env, ["--plugin"]), "inline_script", "a script");
    assert.equal(records(plain).length, 0, "the plugin copy logs to the per-user state dir, not the project's");
    // The plugin copy also judges the bare name: another project's own `orchestrate` workflow is refused.
    const theirs = project({ workflow: "export const meta = { name: 'orchestrate', description: 'their own', phases: [] }\n" });
    refused(run(real, theirs, launch({ name: "orchestrate" }), env, ["--plugin"]), "workflow_content_mismatch", "another project's own workflow");
    assert.deepEqual(Object.values(run(real, copied, launch({ name: "orchestrate" }), env, ["--plugin"])), SILENT, "a project carrying this repo's workflow");
    cleanup(theirs);

    // The project copy cannot see the installed plugin.
    refused(run(GUARD, plain, go), "plugin_not_located", "a project without the workflow");
    refused(run(GUARD, copied, go), "plugin_not_located", "a project carrying a copy of .claude/ but no dist/");
    assert.deepEqual(Object.values(run(GUARD, layout, go)), SILENT, "this repository's layout");
    const stale = project({ built: true });
    writeFileSync(join(stale, "dist", "plugin", "workflows", "orchestrate.js"), "stale\n");
    refused(run(GUARD, stale, go), "plugin_not_located", "a stale build");
    const staleSource = project({ workflow: "changed\n", built: true });
    refused(run(GUARD, staleSource, go), "plugin_not_located", "a changed source");
    cleanup(stale, staleSource);
  } finally {
    cleanup(plain, copied, layout, data, ...plugins);
  }
});

test("both copies loaded: the plugin copy steps aside and the project copy does not refuse the plugin's real workflow here", () => {
  /** A project that registers its own copy of the guard (the project copy loads), with the plugin on too. @param {boolean} built */
  const registering = (built) => {
    const dir = project({ built });
    mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
    for (const f of GUARD_FILES) copyFileSync(hook(f), join(dir, ".claude", "hooks", f));
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Workflow", hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/workflow-guard.mjs"' }] }] } }));
    return dir;
  };
  const repo = registering(true); // this repository, plugin on
  const elsewhere = registering(false); // another project carrying a copy of .claude/, plugin on
  const plug = pluginDir();
  const data = mkdtempSync(join(tmpdir(), "orch-wfguard-data-"));
  try {
    const pluginGuard = join(plug, "hooks", "workflow-guard.mjs");
    const env = { CLAUDE_PLUGIN_DATA: data };
    /** Both copies run on one event; Claude Code refuses the call when either exits 2. @param {string} dir @param {unknown} ti */
    const both = (dir, ti) => {
      const p = run(pluginGuard, dir, launch(ti), env, ["--plugin"]);
      assert.deepEqual(Object.values(p), SILENT, "the plugin copy steps aside (duplicate())");
      return run(join(dir, ".claude", "hooks", "workflow-guard.mjs"), dir, launch(ti));
    };
    assert.deepEqual(Object.values(both(repo, { name: "orchestration:orchestrate", args: { task: "x" } })), SILENT, "the plugin's real workflow passes in this repository");
    assert.deepEqual(Object.values(both(repo, { name: "orchestration:orchestrate", resumeFromRunId: RUN })), SILENT);
    assert.deepEqual(Object.values(both(repo, { name: "orchestrate" })), SILENT);
    refused(both(repo, { script: "x" }), "inline_script", "the project copy still refuses a script");
    refused(both(repo, { name: "deep-research" }), "name_not_allowed", "and another name");
    // Elsewhere the project copy cannot vouch for the plugin: the plugin name is refused, the project copy's name works.
    refused(both(elsewhere, { name: "orchestration:orchestrate" }), "plugin_not_located", "another project with the plugin on");
    assert.deepEqual(Object.values(both(elsewhere, { name: "orchestrate" })), SILENT);
    assert.deepEqual(records(repo).map((r) => r.reason), ["plugin_built_here", "plugin_built_here", "saved_workflow", "inline_script", "name_not_allowed"]);
  } finally {
    cleanup(repo, elsewhere, plug, data);
  }
});

test("input that is not JSON, another tool's event and another hook event exit 0 with no output and no record", () => {
  const dir = project();
  try {
    for (const input of ["", "not json", "{", "[]", "null", "42"]) assert.deepEqual(Object.values(run(GUARD, dir, input)), SILENT, JSON.stringify(input));
    assert.deepEqual(Object.values(run(GUARD, dir, launch({ script: "x" }, { tool_name: "Bash" }))), SILENT);
    assert.deepEqual(Object.values(run(GUARD, dir, launch({ script: "x" }, { hook_event_name: "PostToolUse" }))), SILENT);
    assert.deepEqual(records(dir), []);
  } finally {
    cleanup(dir);
  }
});

test("the switch turns it off: the environment, the plugin option, and the environment wins", () => {
  const dir = project();
  try {
    const adhoc = launch({ script: "x" });
    for (const off of ["off", " OFF "]) assert.deepEqual(Object.values(run(GUARD, dir, adhoc, { ORCH_WORKFLOW_GUARD: off })), SILENT);
    assert.deepEqual(Object.values(run(GUARD, dir, adhoc, { CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD: "off" })), SILENT, "the plugin setting reaches the hook");
    assert.equal(run(GUARD, dir, adhoc, { ORCH_WORKFLOW_GUARD: "", CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD: "off" }).code, 2, "an explicit environment value wins");
    assert.equal(run(GUARD, dir, adhoc, { ORCH_WORKFLOW_GUARD: "on", CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD: "off" }).code, 2);
    assert.equal(run(GUARD, dir, adhoc, { ORCH_WORKFLOW_GUARD: "0" }).code, 2, "only off turns it off");
    assert.equal(records(dir).length, 3, "no record while it is off");
    assert.equal(guardOff({ ORCH_WORKFLOW_GUARD: "off" }), true);
    assert.equal(guardOff({ CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD: "off" }), true);
    assert.equal(guardOff({ ORCH_WORKFLOW_GUARD: "", CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD: "off" }), false);
    assert.equal(guardOff({}), false);
  } finally {
    cleanup(dir);
  }
});

test("deny-only: no output ever holds an allow or ask decision, and the source never writes one", () => {
  const dir = project({ built: true });
  const written = project({ workflow: "x\n" });
  try {
    for (const [d, input] of /** @type {[string, unknown][]} */ ([
      [dir, launch({ name: "orchestrate" })],
      [dir, launch({ name: "orchestration:orchestrate" })],
      [dir, launch({ name: "orchestrate", resumeFromRunId: RUN })],
      [written, launch({ name: "orchestrate" })],
      [written, launch({ name: "orchestration:orchestrate" })],
      [dir, launch({ script: "x" })],
      [dir, launch({ name: "x" })],
      [dir, launch({ scriptPath: SOURCE_WF, resumeFromRunId: RUN })],
      [dir, "garbage"],
    ])) {
      const r = run(GUARD, d, input);
      assert.equal(r.stdout, "");
      assert.ok(r.code === 0 || r.code === 2, String(r.code));
      assert.doesNotMatch(r.stdout + r.stderr, /permissionDecision|"allow"|"ask"/);
    }
    for (const f of ["workflow-guard.mjs", "workflow-hash.mjs"]) assert.doesNotMatch(readFileSync(hook(f), "utf8"), /permissionDecision|hookSpecificOutput/, f);
  } finally {
    cleanup(dir, written);
  }
});

test("the block message names no switch and no Claude Code agent type, and says what to use instead", () => {
  assert.doesNotMatch(BLOCK_MESSAGE, SWITCHES);
  for (const name of builtinAgents()) assert.ok(!new RegExp(`\\b${name}\\b`, "i").test(BLOCK_MESSAGE), name);
  assert.match(BLOCK_MESSAGE, /orchestrator agent/);
  assert.match(BLOCK_MESSAGE, /saved orchestrate workflow/);
  assert.match(BLOCK_MESSAGE, /only the person starts/);
  assert.deepEqual([...SAVED_NAMES], ["orchestrate", "orchestration:orchestrate"]);
  assert.ok(RUN_ID.test(RUN) && !RUN_ID.test("wf_1") && !RUN_ID.test("WF_abcdef") && !RUN_ID.test("wf_abc/def"));
});

test("workflowDecision: the decision table without a process", () => {
  const env = { CLAUDE_PROJECT_DIR: "/nonexistent-project" };
  assert.equal(workflowDecision(null).decision, "skip");
  assert.equal(workflowDecision({ tool_name: "Read", tool_input: {} }, { env }).decision, "skip");
  assert.equal(workflowDecision({ tool_input: { script: "x" } }, { env }).reason, "inline_script", "a missing tool_name is the matcher's tool");
  assert.equal(workflowDecision(launch({ name: "orchestrate" }), { env }).reason, "workflow_file_missing");
  assert.equal(workflowDecision(launch({ name: "orchestration:orchestrate" }), { env }).reason, "plugin_not_located");
  assert.equal(workflowDecision(launch({ name: "orchestration:orchestrate" }), { env, plugin: true, pluginRoot: "/nonexistent-plugin" }).reason, "workflow_file_missing");
  assert.equal(workflowDecision(launch({ name: "orchestration:orchestrate" }), { env, plugin: true, pluginRoot: join(root, "dist", "plugin") }).decision, "allow", "the built plugin");
  // This repo's own saved workflow, and the plugin name in this repository (the built copy is here).
  assert.equal(workflowDecision(launch({ name: "orchestrate" }), { env: { CLAUDE_PROJECT_DIR: root } }).decision, "allow");
  assert.equal(workflowDecision(launch({ name: "orchestration:orchestrate" }), { env: { CLAUDE_PROJECT_DIR: root } }).reason, "plugin_built_here");
  // Other stored values refuse the same files.
  const hashes = { project: "0".repeat(64), plugin: "1".repeat(64) };
  assert.equal(workflowDecision(launch({ name: "orchestrate" }), { env: { CLAUDE_PROJECT_DIR: root }, hashes }).reason, "workflow_content_mismatch");
  assert.equal(workflowDecision(launch({ name: "orchestration:orchestrate" }), { env: { CLAUDE_PROJECT_DIR: root }, hashes }).reason, "plugin_not_located");
});

// --- The nudge at UserPromptSubmit: a typed prompt with the workflow keyword is refused ---
const NUDGE = hook("nudge.mjs");
/** @param {unknown} input @param {Record<string, string>} [extra] */
const nudged = (input, extra = {}) => {
  const dir = mkdtempSync(join(tmpdir(), "orch-wfnudge-"));
  try {
    return run(NUDGE, dir, input, extra);
  } finally {
    cleanup(dir);
  }
};
/** @param {string} prompt @param {Record<string, string>} [extra] @param {Record<string, unknown>} [more] */
const prompted = (prompt, extra = {}, more = {}) => nudged({ session_id: "s1", hook_event_name: "UserPromptSubmit", prompt, ...more }, extra);
/** @param {{ code: number | null, stdout: string }} r */
const blockReason = (r) => {
  assert.equal(r.code, 0, "a block is a decision on stdout, not an exit code");
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out), ["decision", "reason"]);
  assert.equal(out.decision, "block");
  return /** @type {string} */ (out.reason);
};
const KEYWORD_PROMPTS = ["ultracode build the parser", "Please ULTRACODE this.", "do it (ultracode)", "a\nUltraCode\nb", "ultracode-mode", "ultracode: summarise the <agent-message> you got"];
// Not typed by the person: a subagent's hand-back (the text 2.1.326 delivers, recorded live), a task notification,
// another session's message.
const WRAPPED = [
  'Another Claude session sent a message:\n<agent-message from="a776e6e4572693427">\n[Subagent hand-back] ... grep ultracode ...',
  "<task-notification>\n<task-id>a1</task-id>\n<result>ultracode was mentioned</result>\n</task-notification>",
  '  <teammate-message from="r">ultracode</teammate-message>',
];
const OTHER_PROMPTS = ["ultracoder", "myultracode", "ultracode_x", "plain task", "", "use a workflow to list the files"];

test("nudge: a typed prompt with the word ultracode is blocked with a plain message that names no switch", () => {
  for (const prompt of KEYWORD_PROMPTS) {
    const reason = blockReason(prompted(prompt));
    assert.equal(reason.split("\n").length, 1, "one line");
    assert.match(reason, /Workflows started by the ultracode keyword are off in this project/);
    assert.match(reason, /Type the request again without the word ultracode/);
    assert.match(reason, /orchestrator/);
    assert.doesNotMatch(reason, SWITCHES);
    for (const name of builtinAgents()) assert.ok(!new RegExp(`\\b${name}\\b`, "i").test(reason), name);
  }
  // The routing nudge's own switch does not silence the refusal.
  blockReason(prompted("ultracode x", { ORCH_NO_NUDGE: "1" }));
});

test("nudge: a wrapped message holding the word is not blocked, and every other prompt gets today's output (none)", () => {
  for (const prompt of [...WRAPPED, ...OTHER_PROMPTS]) assert.deepEqual(Object.values(prompted(prompt)), SILENT, prompt);
  for (const more of [{ source: "poll_event" }, { origin: { kind: "task-notification" } }]) assert.deepEqual(Object.values(prompted("ultracode x", {}, more)), SILENT, JSON.stringify(more));
  // A prompt that is not a string is no typed keyword.
  assert.deepEqual(Object.values(nudged({ hook_event_name: "UserPromptSubmit", prompt: ["ultracode"] })), SILENT);
  // The SessionStart nudge is the same whatever the switch says.
  const start = { hook_event_name: "SessionStart", source: "startup" };
  const today = nudged(start, { ORCH_NO_NUDGE: "" });
  assert.match(JSON.parse(today.stdout).hookSpecificOutput.additionalContext, /orchestration:route/);
  assert.deepEqual(nudged(start, { ORCH_NO_NUDGE: "", ORCH_WORKFLOW_GUARD: "off" }), today);
  assert.doesNotMatch(today.stdout, /"decision"/);
});

test("nudge: the workflow guard's switch turns the refusal off too, the environment winning", () => {
  for (const extra of /** @type {Record<string, string>[]} */ ([{ ORCH_WORKFLOW_GUARD: "off" }, { ORCH_WORKFLOW_GUARD: " OFF " }, { CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD: "off" }])) {
    for (const prompt of KEYWORD_PROMPTS) assert.deepEqual(Object.values(prompted(prompt, extra)), SILENT, `${JSON.stringify(extra)} ${prompt}`);
  }
  blockReason(prompted("ultracode x", { ORCH_WORKFLOW_GUARD: "", CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD: "off" }));
  blockReason(prompted("ultracode x", { ORCH_WORKFLOW_GUARD: "0" }));
  assert.match(readFileSync(NUDGE, "utf8"), /import \{ guardOff \} from "\.\/workflow-guard\.mjs"/, "one reading of the switch");
});

test("nudge: the plugin copy steps aside at UserPromptSubmit where the project registers its own", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-wfnudge-"));
  const plug = pluginDir(false);
  const data = mkdtempSync(join(tmpdir(), "orch-wfguard-data-"));
  try {
    copyFileSync(NUDGE, join(plug, "hooks", "nudge.mjs"));
    const input = { session_id: "s1", hook_event_name: "UserPromptSubmit", prompt: "ultracode x" };
    const env = { CLAUDE_PLUGIN_DATA: data };
    blockReason(run(join(plug, "hooks", "nudge.mjs"), dir, input, env, ["--plugin"]));
    mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
    copyFileSync(NUDGE, join(dir, ".claude", "hooks", "nudge.mjs"));
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: 'node "${CLAUDE_PROJECT_DIR}/.claude/hooks/nudge.mjs"' }] }] } }));
    assert.deepEqual(Object.values(run(join(plug, "hooks", "nudge.mjs"), dir, input, env, ["--plugin"])), SILENT);
  } finally {
    cleanup(dir, plug, data);
  }
});
