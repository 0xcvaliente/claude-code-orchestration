// The N-UC and W-mix arms' command lines, environment and .claude/ contents. No model calls: native-launch.sh runs against a
// fake `claude` on PATH that prints its arguments and two environment variables.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, command, envAdditions, prepareClaudeDir, runEnv } from "./arms.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const meta = { test_cmd: "python3 tests/run_public.py" };
const run = { budget_tokens: null };

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
  assert.deepEqual(c.args, [join(root, "bench", "lib", "native-launch.sh"), root, "ultracode do it", "/repo"]);
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
    const prompt = "ultracode first line\nsecond line";
    const c = command("N-UC", prompt.replace(/^ultracode /, ""), repo, root);
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
    assert.ok(a.includes("Workflow") && a.includes("Bash(date*)") && a.includes("Bash(git push*)"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
