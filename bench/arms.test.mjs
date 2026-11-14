// The N-UC and W-mix arms' command lines, environment and .claude/ contents. No model calls: native-launch.sh runs against a
// fake `claude` on PATH that prints its arguments and two environment variables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { workflowRunsIn } from "./lib/run-exec.mjs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, NUC_PREFIX, command, envAdditions, prepareClaudeDir, runEnv } from "./arms.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const meta = { test_cmd: "python3 tests/run_public.py" };
const run = { budget_tokens: null };

test("workflowRunsIn: lists wf_*.json of sessions started in the repo, empty when none", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bench-wf-"));
  try {
    const repo = join(tmp, "my repo");
    mkdirSync(repo);
    const projects = join(tmp, "projects");
    assert.deepEqual(workflowRunsIn(repo, projects), []);
    const sess = join(projects, realpathSync(repo).replace(/[^A-Za-z0-9]/g, "-"), "sess-1", "workflows");
    mkdirSync(join(sess, "scripts"), { recursive: true });
    writeFileSync(join(sess, "wf_b.json"), "{}");
    writeFileSync(join(sess, "wf_a.json"), "{}");
    writeFileSync(join(sess, "scripts", "x-wf_a.js"), "");
    assert.deepEqual(workflowRunsIn(repo, projects), ["wf_a", "wf_b"]);
    // A retry reusing the repo path: a stale wf from the first attempt (old mtime, present before launch) is not reported.
    const stale = join(projects, realpathSync(repo).replace(/[^A-Za-z0-9]/g, "-"), "sess-0", "workflows");
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, "wf_old.json"), "{}");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(stale, "wf_old.json"), old, old);
    const before = new Set(workflowRunsIn(repo, projects));
    const t0 = Date.now() - 1000;
    assert.deepEqual(workflowRunsIn(repo, projects, { since: t0 }), ["wf_a", "wf_b"]);
    writeFileSync(join(stale, "wf_new.json"), "{}");
    assert.deepEqual(workflowRunsIn(repo, projects, { since: t0, exclude: before }), ["wf_new"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("workflowRunsIn: counts a workflow cut off before its wf_*.json, once, under the stale filters", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bench-wf-"));
  try {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const projects = join(tmp, "projects");
    const proj = join(projects, realpathSync(repo).replace(/[^A-Za-z0-9]/g, "-"));
    // Present before launch (old mtime, in the pre-launch snapshot): not reported.
    const oldDir = join(proj, "sess-0", "subagents", "workflows", "wf_old");
    mkdirSync(oldDir, { recursive: true });
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(oldDir, old, old);
    const before = new Set(workflowRunsIn(repo, projects));
    assert.deepEqual([...before], ["wf_old"]);
    const t0 = Date.now() - 1000;
    assert.deepEqual(workflowRunsIn(repo, projects, { since: t0, exclude: before }), []);
    // Only the agents' folder, written after launch (killed mid-workflow): reported.
    mkdirSync(join(proj, "sess-1", "subagents", "workflows", "wf_x"), { recursive: true });
    assert.deepEqual(workflowRunsIn(repo, projects, { since: t0, exclude: before }), ["wf_x"]);
    // A finished workflow with its wf_*.json, folder and script: reported once.
    const wf = join(proj, "sess-2", "workflows");
    mkdirSync(join(wf, "scripts"), { recursive: true });
    writeFileSync(join(wf, "wf_987c4129-0f1.json"), "{}");
    writeFileSync(join(wf, "scripts", "implement-toolkit-wf_987c4129-0f1.js"), "");
    mkdirSync(join(proj, "sess-2", "subagents", "workflows", "wf_987c4129-0f1"), { recursive: true });
    assert.deepEqual(workflowRunsIn(repo, projects, { since: t0, exclude: before }), ["wf_987c4129-0f1", "wf_x"]);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("existing arms keep their command line and environment", () => {
  for (const id of ["P-S", "P-O", "O-mix", "O-O", "AUTO"]) {
    const c = command(id, "do it", "/repo", root);
    assert.deepEqual(c, { cmd: "bash", args: [join(root, "scripts", ARMS[id].script), "do it", "/repo"], cwd: root }, id);
    assert.equal(envAdditions(id, meta, run).ORCH_EXTRA_ALLOWED_TOOLS, "Bash(date*)", id);
  }
});

test("N-UC: native launcher, ultracode prefix, Opus, no agent, Workflow allowed", () => {
  const c = command("N-UC", "do it", "/repo", root);
  assert.equal(c.cmd, "bash");
  assert.deepEqual(c.args, [join(root, "bench", "lib", "native-launch.sh"), root, `${NUC_PREFIX}do it`, "/repo"]);
  assert.match(NUC_PREFIX, /^ultracode Use a workflow/);
  assert.equal(ARMS["N-UC"].recordWorkflow, true);
  assert.equal(ARMS["W-mix"].recordWorkflow, true);
  assert.equal(ARMS["O-mix"].recordWorkflow, undefined);
  const add = envAdditions("N-UC", meta, run);
  assert.equal(add.ORCH_AGENT, "none");
  assert.equal(add.ORCH_MODEL, "opus");
  assert.deepEqual(add.ORCH_EXTRA_ALLOWED_TOOLS.split("\n"), ["Bash(date*)", "Workflow"]);
});

test("W-mix: orchestrate.sh with a plain main thread and the /orchestrate workflow command carrying the task", () => {
  const prompt = "line one\nline \"two\"";
  const c = command("W-mix", prompt, "/repo", root);
  assert.equal(c.args[0], join(root, "scripts", "orchestrate.sh"));
  assert.equal(c.args[2], "/repo");
  const m = /^\/orchestrate (.*)$/s.exec(c.args[1]);
  assert.ok(m, c.args[1]);
  assert.deepEqual(JSON.parse(m[1]), { task: prompt, code: true, baseRefHead: true });
  const add = envAdditions("W-mix", meta, run);
  assert.equal(add.ORCH_AGENT, "none");
  assert.equal(add.ORCH_MODEL, undefined);
  assert.ok(add.ORCH_EXTRA_ALLOWED_TOOLS.split("\n").includes("Workflow"));
});

test("prepareClaudeDir: N-UC gets no agents, hooks or workflows; W-mix gets the shipped workflow and agents", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bench-arms-new-"));
  try {
    for (const arm of ["N-UC", "W-mix"]) {
      const repo = join(tmp, arm);
      mkdirSync(repo);
      prepareClaudeDir(arm, repo, root, ["orchestration@m"]);
      const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
      assert.equal(settings.enabledPlugins["orchestration@m"], false, arm);
      const copied = arm === "W-mix";
      assert.equal(existsSync(join(repo, ".claude", "agents")), copied, arm);
      assert.equal(existsSync(join(repo, ".claude", "hooks")), copied, arm);
      assert.equal(existsSync(join(repo, ".claude", "workflows", "orchestrate.js")), copied, arm);
      assert.equal(Boolean(settings.hooks), copied, arm);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("native-launch.sh: orchestrate.sh's arguments with the real prompt, built-in and fork subagents not disabled", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bench-native-"));
  try {
    const bin = join(tmp, "bin");
    const repo = join(tmp, "repo");
    mkdirSync(bin);
    mkdirSync(repo);
    const out = join(tmp, "out.json");
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), builtins: process.env.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS ?? null, fork: process.env.CLAUDE_CODE_FORK_SUBAGENT ?? null }));
`);
    chmodSync(join(bin, "claude"), 0o755);
    const prompt = `${NUC_PREFIX}first line\nsecond line`;
    const c = command("N-UC", "first line\nsecond line", repo, root);
    const env = { ...runEnv("N-UC", meta, run), PATH: `${bin}:${process.env.PATH}`, CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1", CLAUDE_CODE_FORK_SUBAGENT: "0" };
    const r = spawnSync(c.cmd, c.args, { cwd: c.cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const got = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(got.builtins, null);
    assert.equal(got.fork, null);
    assert.equal(got.cwd.endsWith("repo"), true);
    const a = got.args;
    assert.equal(a[a.indexOf("-p") + 1], prompt);
    assert.equal(a.includes("--agent"), false);
    assert.equal(a[a.indexOf("--model") + 1], "opus");
    assert.equal(a[a.indexOf("--permission-mode") + 1], "dontAsk");
    // orchestrate.sh's own runs read the event stream; this arm runs claude itself and needs the one JSON document.
    assert.equal(a[a.indexOf("--output-format") + 1], "json");
    assert.equal(a.includes("--verbose"), false);
    assert.ok(a.includes("Workflow") && a.includes("Bash(date*)") && a.includes("Bash(git push*)"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------- 0.4.0 comparison arms: plugin dir per arm, env per arm ----------

import { BASELINE_030_REF, ensurePluginDir, pluginDirFor } from "./arms.mjs";

test("d2-docs researcher arms: env per arm, .claude/ copied, ORCH_* from the arm survives runEnv", () => {
  const m = { test_cmd: "python3 tools/check.py" };
  const haiku = runEnv("all-haiku", m, run, { ORCH_READ_ROUTER: "on", PATH: "/bin" });
  assert.equal(haiku.ORCH_READ_ROUTER, undefined); // inherited ORCH_* stripped
  assert.equal(haiku.ORCH_AGENT, "orchestrator");
  const sonnet = envAdditions("all-sonnet", m, run);
  assert.equal(sonnet.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, "1");
  assert.equal(sonnet.CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
  assert.match(ARMS["all-sonnet"].label, /every subagent/);
  assert.equal(runEnv("routed", m, run, { PATH: "/bin" }).ORCH_READ_ROUTER, "on");
  for (const a of ["all-haiku", "all-sonnet", "routed"]) {
    assert.equal(ARMS[a].copyClaude, true);
    assert.equal(command(a, "task", "/tmp/repo", root).args[0], join(root, "scripts", "orchestrate.sh"));
  }
});

test("plugin arms: plugin dir per arm, launcher plugin-launch.sh, agent prefix", () => {
  assert.equal(pluginDirFor("O-mix-plugin", root), join(root, "dist", "plugin"));
  assert.equal(pluginDirFor("O-mix-030", root, "/cache"), join("/cache", BASELINE_030_REF, "dist", "plugin"));
  assert.equal(pluginDirFor("O-mix", root), null);
  const c = command("O-mix-030", "task", "/tmp/repo", root);
  assert.equal(c.args[0], join(root, "bench", "lib", "plugin-launch.sh"));
  assert.deepEqual(c.args.slice(1, 4), [root, "task", "/tmp/repo"]);
  assert.ok(c.args[4].endsWith(join(BASELINE_030_REF, "dist", "plugin")));
  const env = envAdditions("O-mix-030", meta, run);
  assert.equal(env.ORCH_AGENT_PREFIX, "orchestration:");
  assert.equal(env.ORCH_AGENT, "orchestrator");
  assert.equal(ARMS["O-mix-030"].copyClaude, false);
});

const hasBaselineRef = spawnSync("git", ["-C", root, "cat-file", "-e", `${BASELINE_030_REF}^{commit}`]).status === 0;
test("ensurePluginDir: extracts dist/plugin at the 0.3.0 ref with git archive, once", { skip: !hasBaselineRef && "ref not in this clone" }, () => {
  const base = mkdtempSync(join(tmpdir(), "bench-plugin-"));
  try {
    const dir = ensurePluginDir("O-mix-030", root, base);
    assert.equal(dir, join(base, BASELINE_030_REF, "dist", "plugin"));
    const manifest = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
    assert.equal(manifest.version, "0.3.0");
    assert.ok(existsSync(join(dir, "agents")));
    writeFileSync(join(dir, "marker"), "x");
    assert.equal(ensurePluginDir("O-mix-030", root, base), dir); // reused, not re-extracted
    assert.ok(existsSync(join(dir, "marker")));
    assert.equal(ensurePluginDir("O-mix", root, base), null);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("plugin-launch.sh: --plugin-dir first, orchestrate.sh arguments with the prompt restored, built-ins stay blocked", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bench-plaunch-"));
  try {
    const plugin = join(tmp, "plugin");
    mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
    writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), "{}");
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const bin = join(tmp, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "claude"), `#!/usr/bin/env bash\nprintf 'ARG:%s\\n' "$@"\necho "BUILTIN=$CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS FORK=$CLAUDE_CODE_FORK_SUBAGENT"\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const c = command("O-mix-plugin", "line one", repo, root);
    c.args[4] = plugin;
    const env = { ...runEnv("O-mix-plugin", meta, run), PATH: `${bin}:${process.env.PATH}` };
    const r = spawnSync(c.cmd, c.args, { cwd: c.cwd, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const args = r.stdout.split("\n").filter((l) => l.startsWith("ARG:")).map((l) => l.slice(4));
    assert.deepEqual(args.slice(0, 4), ["--plugin-dir", plugin, "-p", "line one"]);
    assert.equal(args[args.indexOf("--agent") + 1], "orchestration:orchestrator");
    assert.match(r.stdout, /BUILTIN=1 FORK=0/);
    const missing = spawnSync(c.cmd, [c.args[0], root, "p", repo, join(tmp, "nope")], { cwd: c.cwd, env, encoding: "utf8" });
    assert.notEqual(missing.status, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("d3-reader arms: plain sonnet main session, .claude/ copied, session persistence on, per-arm model and router", () => {
  const m = { test_cmd: "python3 tools/check.py" };
  for (const a of ["reader-haiku", "reader-sonnet", "reader-routed"]) {
    const env = runEnv(a, m, run, { PATH: "/bin" });
    assert.equal(env.ORCH_AGENT, "none");
    assert.equal(env.ORCH_MODEL, "sonnet");
    assert.equal(env.ORCH_SESSION_PERSISTENCE, "1");
    assert.equal(ARMS[a].copyClaude, true);
    assert.equal(command(a, "task", "/tmp/repo", root).args[0], join(root, "scripts", "orchestrate.sh"));
  }
  assert.equal(runEnv("reader-haiku", m, run, { ORCH_READ_ROUTER: "on" }).ORCH_READ_ROUTER, undefined); // inherited ORCH_* stripped
  assert.equal(envAdditions("reader-haiku", m, run).CLAUDE_CODE_SUBAGENT_MODEL, undefined);
  assert.equal(envAdditions("reader-sonnet", m, run).CLAUDE_CODE_SUBAGENT_MODEL_FORCE, "1");
  assert.equal(envAdditions("reader-sonnet", m, run).CLAUDE_CODE_SUBAGENT_MODEL, "sonnet");
  assert.equal(envAdditions("reader-sonnet", m, run).ORCH_READ_ROUTER, undefined);
  assert.equal(envAdditions("reader-routed", m, run).ORCH_READ_ROUTER, "on");
  assert.equal(envAdditions("reader-routed", m, run).CLAUDE_CODE_SUBAGENT_MODEL_FORCE, undefined);
});
