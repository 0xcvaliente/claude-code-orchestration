import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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

test("session nudge: tells the session to route non-trivial tasks of any kind, not only code, and is silent when ORCH_NO_NUDGE is set", () => {
  const run = (env: Record<string, string>) =>
    spawnSync("node", [hook("nudge.mjs")], { input: "{}", env: { ...process.env, ORCH_NO_NUDGE: "", ...env }, encoding: "utf8" });
  const on = run({});
  assert.equal(on.status, 0);
  const out = JSON.parse(on.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  const context: string = out.hookSpecificOutput.additionalContext;
  assert.match(context, /orchestration:route/);
  for (const kind of ["code", "research", "writing", "analysis", "operations"]) assert.match(context, new RegExp(`\\b${kind}\\b`), `the nudge covers ${kind}`);
  assert.match(context, /Only for code in a git repository: parallel slices use isolation: worktree/, "git machinery is for code only");
  assert.match(context, /Work that changes no code runs in the shared folder, and its slices with disjoint files may run in parallel; code outside a git repository runs one slice at a time/);
  assert.match(context, /send the draft and its sources to orchestration:reviewer before you reply, and to a second, opus reviewer for a risky one/, "an answer the session writes itself is reviewed too");
  assert.match(context, /Skip routing for quick questions/);
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

const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
const gateLog = (dir: string) => join(dir, ".claude", "state", "gates.jsonl");
const writeGateLog = (dir: string, entries: object[]) =>
  writeFileSync(gateLog(dir), entries.map((e) => JSON.stringify({ gate: "review", decision: "block", session_id: "s1", ...e })).join("\n") + "\n");

test("review gate: counts blocks since the last implementer only, so later work in a long session is still gated", () => {
  const dir = project([{ agent_type: "implementer", ts: at(0) }, { agent_type: "implementer", ts: at(5000) }]);
  writeGateLog(dir, [{ ts: at(100) }, { ts: at(200) }, { decision: "allow", reason: "max_blocks_reached", ts: at(300) }, { ts: at(6000), session_id: "other" }]);
  const r = gate(dir);
  assert.equal(r.status, 2, "two blocks for the first implementer must not exempt the second");
  assert.match(r.stderr, /no reviewer has run/);
});

test("review gate: gives up after 2 blocks since the last implementer, and says the reply is unverified", () => {
  const dir = project([{ agent_type: "implementer", ts: at(0) }]);
  writeGateLog(dir, [{ ts: at(100) }]);
  const last = gate(dir);
  assert.equal(last.status, 2);
  assert.match(last.stderr, /last block.*unverified/);
  const giveUp = gate(dir);
  assert.equal(giveUp.status, 0);
  assert.match(JSON.parse(giveUp.stdout).systemMessage, /gave up after 2 blocks \(no_reviewer_after_last_implementer\).*unverified/);
  assert.match(readFileSync(gateLog(dir), "utf8"), /"decision":"allow","reason":"max_blocks_reached"/);
});

// The plugin copy of a hook, run as hooks.json runs it (--plugin), with its data dir in a temp dir.
const pluginHook = (name: string, dir: string, data: string, input: string, env: Record<string, string> = {}) =>
  spawnSync(name.endsWith(".sh") ? "bash" : "node", [hook(name), "--plugin"], {
    input,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_DATA: data, ...env },
    encoding: "utf8",
  });
const stopEventFor = (dir: string, agent_type: string) => JSON.stringify({ hook_event_name: "SubagentStop", session_id: "s1", agent_type, agent_id: "a1", cwd: dir });

test("plugin hooks step aside where the project registers its own copy, so nothing runs twice", () => {
  const dir = project([{ agent_type: "implementer" }]);
  const data = mkdtempSync(join(tmpdir(), "orch-data-"));
  mkdirSync(join(dir, ".claude", "hooks"));
  for (const f of ["telemetry.mjs", "review-gate.mjs"]) writeFileSync(join(dir, ".claude", "hooks", f), "");
  writeFileSync(join(dir, ".claude", "settings.json"), readFileSync(new URL("../.claude/settings.json", import.meta.url)));
  const telemetryBefore = readFileSync(join(dir, ".claude", "state", "telemetry.jsonl"), "utf8");

  const stop = pluginHook("review-gate.mjs", dir, data, JSON.stringify({ session_id: "s1" }));
  assert.deepEqual([stop.status, stop.stdout, stop.stderr], [0, "", ""]);
  assert.equal(existsSync(gateLog(dir)), false, "the plugin copy logs no decision of its own");
  assert.equal(gate(dir).status, 2, "the project copy still gates");
  assert.equal(readFileSync(gateLog(dir), "utf8").trim().split("\n").length, 1);

  assert.equal(pluginHook("telemetry.mjs", dir, data, stopEventFor(dir, "orchestration:reviewer")).status, 0);
  assert.equal(readFileSync(join(dir, ".claude", "state", "telemetry.jsonl"), "utf8"), telemetryBefore);

  // verify.sh has no project twin for namespaced agents, so it runs, and logs where the project's gates do.
  assert.equal(pluginHook("verify.sh", dir, data, stopEventFor(dir, "orchestration:implementer"), { ORCH_TEST_CMD: "exit 1" }).status, 2);
  assert.match(readFileSync(gateLog(dir), "utf8"), /"gate":"test","decision":"block"/);
  assert.equal(existsSync(join(data, "state")), false);
});

type HookFile = { hooks: Record<string, { matcher?: string; hooks: { command: string }[] }[]> };
test("test gate: the project and plugin matchers never fire for the same agent; plugin hooks run with --plugin", () => {
  const read = (path: string): HookFile => JSON.parse(readFileSync(new URL(path, import.meta.url), "utf8"));
  const project = read("../.claude/settings.json");
  const plugin = read("../dist/plugin/hooks/hooks.json");
  const matcher = (h: HookFile) => new RegExp(h.hooks.SubagentStop?.find((e) => e.matcher)?.matcher ?? "^$");
  assert.ok(matcher(project).test("implementer") && !matcher(project).test("orchestration:implementer"));
  assert.ok(matcher(plugin).test("orchestration:implementer") && !matcher(plugin).test("implementer"));
  const commands = Object.values(plugin.hooks).flatMap((list) => list.flatMap((e) => e.hooks.map((h) => h.command)));
  assert.ok(commands.length > 0 && commands.every((c) => c.endsWith(" --plugin")), commands.join("\n"));
});

test("plugin hooks keep state in a per-user dir keyed by the project path, never in the repo", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-é-")); // non-ASCII: the JS and bash keys must still agree
  const data = mkdtempSync(join(tmpdir(), "orch-data-"));
  assert.equal(pluginHook("telemetry.mjs", dir, data, stopEventFor(dir, "orchestration:implementer")).status, 0);
  assert.equal(pluginHook("verify.sh", dir, data, stopEventFor(dir, "orchestration:implementer"), { ORCH_TEST_CMD: "exit 1" }).status, 2);
  const r = pluginHook("review-gate.mjs", dir, data, JSON.stringify({ session_id: "s1" }));
  assert.equal(r.status, 2, "the gate reads the telemetry the plugin copy wrote");
  assert.equal(existsSync(join(dir, ".claude")), false, "nothing is written into the project");
  const keys = readdirSync(join(data, "state"));
  assert.equal(keys.length, 1, `one dir for all three hooks: ${keys.join(", ")}`);
  assert.deepEqual(readdirSync(join(data, "state", keys[0] ?? "")).sort(), ["gates.jsonl", "telemetry.jsonl"]);
  assert.match(readFileSync(join(data, "state", keys[0] ?? "", "gates.jsonl"), "utf8"), /"gate":"test".*\n.*"gate":"review"/);

  // Without CLAUDE_PLUGIN_DATA (older Claude Code) the state goes under ~/.claude/orchestration.
  const home = mkdtempSync(join(tmpdir(), "orch-home-"));
  pluginHook("telemetry.mjs", dir, "", stopEventFor(dir, "orchestration:implementer"), { HOME: home });
  pluginHook("verify.sh", dir, "", stopEventFor(dir, "orchestration:implementer"), { HOME: home, ORCH_TEST_CMD: "exit 0" });
  assert.deepEqual(readdirSync(join(home, ".claude", "orchestration", "state", keys[0] ?? "")).sort(), ["gates.jsonl", "telemetry.jsonl"]);
});

test("project hooks write a .gitignore into .claude/state on first write", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-tel-"));
  assert.equal(telemetry(dir, JSON.stringify({ hook_event_name: "SubagentStart", session_id: "s1" })).status, 0);
  assert.equal(readFileSync(join(dir, ".claude", "state", ".gitignore"), "utf8"), "*\n");
  const other = mkdtempSync(join(tmpdir(), "orch-verify-"));
  spawnSync("bash", [hook("verify.sh")], { input: stopEventFor(other, "implementer"), env: { ...process.env, CLAUDE_PROJECT_DIR: other, ORCH_TEST_CMD: "exit 0" }, encoding: "utf8" });
  assert.equal(readFileSync(join(other, ".claude", "state", ".gitignore"), "utf8"), "*\n");
});

// verify.sh judges "no code changed" from git, so these tests use real repos: a package.json whose test script always
// fails (a test run shows as a block), README.md as prose and app.js as code, committed. Git variables from the
// machine running the tests (for example inside a git hook) are dropped, so every git call stays in the temp repo.
const withoutGitEnv = (): Record<string, string> =>
  Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !e[0].startsWith("GIT_")));
function gitRepo() {
  const dir = mkdtempSync(join(tmpdir(), "orch-git-"));
  const git = (...args: string[]) => {
    const r = spawnSync("git", ["-c", "user.name=orch", "-c", "user.email=orch@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env: withoutGitEnv(), encoding: "utf8" });
    assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  };
  git("init", "-q");
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "exit 1" } }));
  writeFileSync(join(dir, "README.md"), "# project\n");
  writeFileSync(join(dir, "app.js"), "export {};\n");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return { dir, git };
}
// verify.sh as the SubagentStop hook runs it, with ORCH_TEST_CMD unset unless `extra` sets it.
function testGate(dir: string, extra: Record<string, string> = {}, agent_id = "a1") {
  const env: Record<string, string> = { ...withoutGitEnv(), CLAUDE_PROJECT_DIR: dir, ...extra };
  if (!("ORCH_TEST_CMD" in extra)) delete env.ORCH_TEST_CMD;
  return spawnSync("bash", [hook("verify.sh")], { input: JSON.stringify({ agent_type: "orchestration:implementer", agent_id, cwd: dir }), env, encoding: "utf8" });
}
const lastGateEntry = (dir: string) => JSON.parse(readFileSync(gateLog(dir), "utf8").trim().split("\n").pop() ?? "{}");

test("test gate: when only prose files changed, judged from git status and not from the agent, the tests are skipped", () => {
  const { dir, git } = gitRepo();
  writeFileSync(join(dir, "README.md"), "# project\n\nmore\n");
  const modified = testGate(dir);
  assert.equal(modified.status, 0, modified.stderr);
  assert.deepEqual([lastGateEntry(dir).decision, lastGateEntry(dir).reason], ["allow", "no_code_changes"]);

  // Untracked prose with spaces, an upper-case extension and non-ASCII letters, and a staged rename of a modified file.
  writeFileSync(join(dir, "notes with spaces.TXT"), "x\n");
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "ünï.markdown"), "x\n");
  writeFileSync(join(dir, "docs", "Setup.ADOC"), "x\n");
  git("mv", "README.md", "docs/GUIDE.rst");
  const more = testGate(dir, {}, "a2");
  assert.equal(more.status, 0, more.stderr);
  assert.equal(lastGateEntry(dir).reason, "no_code_changes");
});

test("test gate: any changed code, build or dependency path still runs the tests, and the failing test script blocks", () => {
  const changes: Record<string, (dir: string, git: (...args: string[]) => void) => void> = {
    "a modified code file": (dir) => writeFileSync(join(dir, "app.js"), "export const x = 1;\n"),
    "only a requirements.txt": (dir) => writeFileSync(join(dir, "requirements.txt"), "left-pad==1.0\n"),
    "a requirements file in a folder": (dir) => {
      mkdirSync(join(dir, "requirements"));
      writeFileSync(join(dir, "requirements", "base.txt"), "x\n");
    },
    "a constraints file in upper case": (dir) => writeFileSync(join(dir, "Constraints-dev.TXT"), "x\n"),
    "a CMakeLists.txt": (dir) => writeFileSync(join(dir, "CMakeLists.txt"), "project(x)\n"),
    "an .mdx file, which is JSX": (dir) => writeFileSync(join(dir, "page.mdx"), "<Hero />\n"),
    "an untracked code file": (dir) => writeFileSync(join(dir, "extra.JS"), "export {};\n"),
    "a deleted code file": (dir) => unlinkSync(join(dir, "app.js")),
    "prose and code together": (dir) => {
      writeFileSync(join(dir, "README.md"), "more\n");
      writeFileSync(join(dir, "Makefile"), "all:\n");
    },
    "code renamed to a prose name": (_dir, git) => git("mv", "app.js", "app.md"),
  };
  for (const [name, change] of Object.entries(changes)) {
    const { dir, git } = gitRepo();
    change(dir, git);
    const r = testGate(dir);
    assert.equal(r.status, 2, `${name}: ${r.stderr}`);
    assert.match(r.stderr, /Acceptance gate failed: npm test/, name);
    assert.equal(lastGateEntry(dir).reason, "tests_failed", name);
  }
});

test("test gate: prose under a test-data folder is test input and runs the tests; the same file in docs is still prose", () => {
  const docs = gitRepo().dir;
  mkdirSync(join(docs, "docs"));
  writeFileSync(join(docs, "docs", "guide.md"), "x\n");
  assert.equal(testGate(docs).status, 0);
  assert.equal(lastGateEntry(docs).reason, "no_code_changes");

  // Folder names are matched whole and in any case: "specification", "latest" and "test-plans" are ordinary folders.
  const near = gitRepo().dir;
  for (const name of ["specification", "latest", "test-plans"]) {
    mkdirSync(join(near, name));
    writeFileSync(join(near, name, "notes.md"), "x\n");
  }
  assert.equal(testGate(near).status, 0);
  assert.equal(lastGateEntry(near).reason, "no_code_changes");

  const places = ["testdata/expected.txt", ...["test", "Tests", "testdata", "__tests__", "spec", "Fixtures", "__fixtures__", "golden", "snapshots", "__snapshots__"].map((name, i) => `pkg/${name}/${i % 2 ? "expected.txt" : "page.md"}`)];
  for (const path of places) {
    const { dir } = gitRepo();
    mkdirSync(join(dir, path.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(dir, path), "x\n");
    const r = testGate(dir);
    assert.equal(r.status, 2, `${path}: ${r.stderr}`);
    assert.equal(lastGateEntry(dir).reason, "tests_failed", path);
  }
});

test("test gate: a clean tree, a folder outside git and an explicit ORCH_TEST_CMD keep the test run", () => {
  // Nothing changed since the commit: an isolated slice that already committed looks like this.
  const clean = gitRepo().dir;
  assert.equal(testGate(clean).status, 2);
  assert.equal(lastGateEntry(clean).reason, "tests_failed");

  const outside = mkdtempSync(join(tmpdir(), "orch-nogit-"));
  writeFileSync(join(outside, "package.json"), JSON.stringify({ scripts: { test: "exit 1" } }));
  writeFileSync(join(outside, "README.md"), "# not a repository\n");
  assert.equal(testGate(outside).status, 2);

  const { dir } = gitRepo();
  writeFileSync(join(dir, "README.md"), "more\n");
  assert.equal(testGate(dir, { ORCH_TEST_CMD: "exit 1" }).status, 2, "an explicit command runs even when only prose changed");
  assert.equal(lastGateEntry(dir).reason, "tests_failed");
  assert.equal(testGate(dir, { ORCH_TEST_CMD: "exit 0" }, "a2").status, 0);
  assert.equal(lastGateEntry(dir).reason, "tests_passed");
});

// ---- Review gate per slice of a run, through the real telemetry.mjs and journal.mjs (headless: no transcripts). ----
// Every agent is launched in the background: SubagentStart, then the PostToolUse launch record, later its SubagentStop.
const PLAN = "PLAN REVIEW\nCONSTRAINTS:\nC1: no throw\nC2: no deps\nSLICE: a\nFILES: a.py\nDEPENDS: none\nGOAL: a\nCHECKS: C1\nSLICE: b\nFILES: b.py\nDEPENDS: none\nGOAL: b\nRISKY: yes";
function session(extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orch-gate-"));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  const env = { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: "", ORCH_ESCALATION: "", ORCH_RUN_STALE_MIN: "", ORCH_ALLOW_BUILTINS: "", ...extraEnv };
  const run = (name: string, payload: object, more: Record<string, string> = {}) =>
    spawnSync("node", [hook(name)], { input: JSON.stringify({ session_id: "s1", ...payload }), env: { ...env, ...more }, encoding: "utf8" });
  let n = 0;
  const s = {
    dir,
    run,
    /** Launch an agent in the background; returns its agent id. */
    launch(type: string, prompt: string, model?: string) {
      const id = `ag${++n}${type.replace(/\W/g, "")}`;
      run("telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: id, agent_type: type });
      run("journal.mjs", { hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: { subagent_type: type, prompt, ...(model ? { model } : {}) }, tool_response: { status: "async_launched", agentId: id } });
      return id;
    },
    stop(id: string, type: string, reply: string) {
      const p = { hook_event_name: "SubagentStop", agent_id: id, agent_type: type, last_assistant_message: reply };
      run("telemetry.mjs", p);
      run("journal.mjs", p);
    },
    /** One agent from launch to stop. */
    agent(type: string, prompt: string, reply: string, model?: string) {
      const id = s.launch(type, prompt, model);
      s.stop(id, type, reply);
      return id;
    },
    plan(text = PLAN) {
      s.agent("orchestration:reviewer", text, "STATUS: pass");
    },
    impl(slice: string, extra = "") {
      return s.agent("orchestration:implementer", `SLICE: ${slice}\nFILES: ${slice}.py\nDEPENDS: none\n${extra}`, "STATUS: pass");
    },
    review(slice: string, reply: string, opts: { model?: string; checks?: string } = {}) {
      return s.agent("orchestration:reviewer", `SLICE: ${slice}\n${opts.checks ? `CHECKS: ${opts.checks}` : ""}`, reply, opts.model);
    },
    gate(input: object = {}, more: Record<string, string> = {}) {
      return run("review-gate.mjs", input, more);
    },
    decisions() {
      return readFileSync(join(dir, ".claude", "state", "gates.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((g) => g.gate === "review");
    },
    last() {
      return s.decisions().at(-1);
    },
  };
  return s;
}
const running = (type: string, status = "running") => ({ id: "t1", type, status, description: "x", ...(type === "subagent" ? { agent_type: "orchestration:reviewer" } : { name: "w" }) });

test("review gate: a reviewer still running defers the reply (agents_running), from background_tasks or, without them, telemetry", () => {
  const s = session();
  s.plan();
  s.impl("a");
  const rev = s.launch("orchestration:reviewer", "SLICE: a\nCHECKS: C1");
  for (const t of [running("subagent"), running("workflow", "pending"), running("teammate", "queued")]) {
    const r = s.gate({ background_tasks: [t] });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual([s.last().decision, s.last().reason, s.last().source], ["allow", "agents_running", "background_tasks"]);
  }
  // A shell task, a finished subagent and the final Stop's empty list are not agents running: background_tasks is
  // authoritative even though telemetry still shows the reviewer's start without a stop.
  for (const tasks of [[running("shell")], [running("subagent", "completed")]]) {
    const r = s.gate({ background_tasks: tasks });
    assert.equal(r.status, 2, JSON.stringify(tasks));
    assert.equal(s.last().reason, "no_reviewer_after_last_implementer");
  }
  assert.equal(s.gate({ background_tasks: [] }).status, 0, "the third time the loop guard lets it out");
  assert.equal(s.last().reason, "max_blocks_reached");
  // Without background_tasks: the reviewer's SubagentStart has no SubagentStop yet.
  assert.equal(s.gate().status, 0);
  assert.deepEqual([s.last().reason, s.last().source, s.last().agents], ["agents_running", "telemetry", ["reviewer"]]);
  // A start older than ORCH_RUN_STALE_MIN does not defer (a lost stop must not defer forever): the gate gives up as
  // usual after its two blocks, and says so.
  const old = s.gate({}, { ORCH_RUN_STALE_MIN: "0.00001" });
  assert.equal(old.status, 0);
  assert.equal(s.last().reason, "max_blocks_reached");
  assert.match(JSON.parse(old.stdout).systemMessage, /gave up after 2 blocks \(no_reviewer_after_last_implementer\).*slice a.*unverified/);
  // agents_running was never counted as a block, and the reviewer's pass lets the reply out.
  s.stop(rev, "orchestration:reviewer", "STATUS: pass\nC1: pass (cmd) npm test -> 3 pass");
  assert.equal(s.gate().status, 0);
  assert.equal(s.last().reason, "reviewer_passed");
  assert.deepEqual(s.decisions().filter((d) => d.decision === "block").length, 2);
});

test("review gate: nothing running and an unreviewed implementer blocks; every slice of the run needs its own review", () => {
  const s = session();
  s.plan();
  s.impl("a");
  s.impl("b");
  const r = s.gate({ background_tasks: [] });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /slice a \(run 1\): an implementer finished but no reviewer has run since.*Also: slice b/);
  // The old rule let this out (a reviewer passed after the last implementer); per slice, b is still unreviewed.
  s.review("a", "STATUS: pass\nC1: pass (cmd) t -> ok");
  const b = s.gate();
  assert.equal(b.status, 2);
  assert.match(b.stderr, /slice b \(run 1\)/);
  assert.equal(s.last().slice, "b");
  s.review("b", "STATUS: fail\nGAPS: x");
  assert.match(s.gate().stderr, /slice b.*STATUS: fail/);
  assert.equal(s.last().reason, "last_reviewer_failed");
  s.review("b", "Looks fine.");
  assert.equal(s.gate().status, 2);
  assert.equal(s.last().reason, "last_reviewer_no_status");
});

test("review gate: STATUS by parseStatus: any fail line fails, a blockquoted STATUS does not count", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.impl("fix", "PATH: light");
  s.review("fix", "STATUS: pass\nlater:\nSTATUS: fail");
  assert.equal(s.gate().status, 2);
  assert.equal(s.last().reason, "last_reviewer_failed");
  s.review("fix", "> STATUS: fail\nSTATUS: pass");
  assert.equal(s.gate().status, 0);
  assert.equal(s.last().reason, "reviewer_passed");
});

test("review gate: constraints_unchecked until the reviewer answers every CHECKS id with pass; no CHECKS skips (logged); gives up after 2 blocks", () => {
  const s = session();
  s.plan();
  s.impl("a");
  s.review("a", "STATUS: pass\nC1: pass (cmd) npm test -> ok", { checks: "C1, C2" });
  let r = s.gate();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /slice a \(run 1\): the reviewer passed it without answering C2/);
  assert.equal(s.last().reason, "constraints_unchecked");
  s.review("a", "STATUS: pass\nC1: pass (cmd) npm test -> ok\nC2: fail adds a dependency", { checks: "C1, C2" });
  assert.match(s.gate().stderr, /with C2 answered fail.*last block/);
  r = s.gate();
  assert.equal(r.status, 0, "loop guard");
  assert.equal(s.last().reason, "constraints_unchecked_gave_up");
  assert.match(JSON.parse(r.stdout).systemMessage, /gave up after 2 blocks \(constraints_unchecked\).*slice a.*unverified/);
  s.review("a", "STATUS: pass\nC1: pass (cmd) npm test -> ok\nC2: pass (cmd) git diff package.json -> empty", { checks: "C1, C2" });
  assert.equal(s.gate().status, 0);
  assert.equal(s.last().reason, "reviewer_passed");
  // A reviewer brief without CHECKS (old style) skips the check with a logged reason.
  const old = session();
  old.plan();
  old.impl("a");
  old.review("a", "STATUS: pass");
  assert.equal(old.gate().status, 0);
  assert.deepEqual([old.last().reason, old.last().skips], ["reviewer_passed", ["constraints_unchecked:a:no_checks"]]);
});

test("review gate: a doubt signal needs a passing opus review (tool_input model or the agent file); ORCH_ESCALATION off and always", () => {
  const s = session();
  s.plan();
  s.impl("b"); // RISKY: yes in the plan
  s.review("b", "STATUS: pass", { model: "sonnet" });
  let r = s.gate();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /slice b \(run 1\) needs a passing review by an opus reviewer.*doubt signals: risky/);
  assert.equal(s.last().reason, "opus_review_required");
  assert.equal(s.gate({}, { ORCH_ESCALATION: "off" }).status, 0, "off disables the signals");
  s.review("b", "STATUS: pass", { model: "opus" });
  assert.equal(s.gate().status, 0);
  assert.equal(s.last().reason, "reviewer_passed");
  // A relaunch after the opus pass needs a new one (and a review at all first).
  s.impl("b");
  s.review("b", "STATUS: pass");
  assert.equal(s.gate().status, 2);
  assert.equal(s.last().reason, "opus_review_required");
  assert.equal(s.gate().status, 2);
  r = s.gate();
  assert.equal(r.status, 0);
  assert.equal(s.last().reason, "opus_review_required_gave_up");
  assert.match(JSON.parse(r.stdout).systemMessage, /gave up after 2 blocks \(opus_review_required\)/);

  // The model from the project's agent file when the launch names none.
  const f = session();
  mkdirSync(join(f.dir, ".claude", "agents"), { recursive: true });
  writeFileSync(join(f.dir, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\nmodel: opus\n---\nbody\n");
  f.plan();
  f.impl("b");
  f.review("b", "STATUS: pass");
  assert.equal(f.gate().status, 0);
  assert.equal(f.last().reason, "reviewer_passed");

  // always: every slice needs an opus pass, risky or not.
  const a = session({ ORCH_ESCALATION: "always" });
  a.plan();
  a.impl("a");
  a.review("a", "STATUS: pass\nC1: pass (cmd) t -> ok", { model: "sonnet" });
  assert.match(a.gate().stderr, /doubt signals: always/);
  // Retry and open items are signals too.
  const d = session();
  d.plan();
  d.impl("a");
  d.review("a", "STATUS: fail\nGAPS: x");
  d.impl("a");
  d.review("a", "STATUS: pass\nC1: pass (cmd) t -> ok\nOPEN: an edge case");
  assert.match(d.gate().stderr, /doubt signals: retry, open_items/);
});

test("review gate: a slice that failed for good does not block, and the systemMessage names it", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  for (let i = 0; i < 3; i++) {
    s.impl("a");
    s.review("a", "STATUS: fail\nGAPS: still broken");
  }
  const r = s.gate();
  assert.equal(r.status, 0);
  assert.deepEqual([s.last().reason, s.last().failed_for_good], ["slice_failed_for_good", ["a"]]);
  assert.match(JSON.parse(r.stdout).systemMessage, /slice a failed for good.*Report it as failed/);
  // Another slice of the run still blocks; the failed one is not part of the block.
  s.impl("b");
  assert.equal(s.gate().status, 2);
  assert.equal(s.last().slice, "b");
});

test("review gate: the loop guard counts blocks per reason since the last implementer", () => {
  const s = session({ ORCH_ESCALATION: "off" });
  s.plan();
  s.impl("a");
  assert.equal(s.gate().status, 2);
  assert.equal(s.gate().status, 2);
  assert.equal(s.gate().status, 0, "two no_reviewer blocks, then it gives up");
  assert.equal(s.last().reason, "max_blocks_reached");
  s.review("a", "STATUS: fail");
  assert.equal(s.gate().status, 2, "a different reason has its own two blocks");
  assert.equal(s.last().reason, "last_reviewer_failed");
  s.impl("a");
  assert.equal(s.gate().status, 2, "a new implementer stop resets the count");
  assert.equal(s.last().reason, "no_reviewer_after_last_implementer");
});

test("review gate: an implementer stop with no slice info falls back to the old rule (a reviewer after the last implementer)", () => {
  const s = session();
  // A workflow agent: no PreToolUse(Agent) and no launch record, bare agent type, no SLICE line in any record.
  s.run("telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: "wf1", agent_type: "implementer" });
  s.stop("wf1", "implementer", "STATUS: pass");
  const r = s.gate();
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^Review gate: an implementer finished but no reviewer has run since/);
  assert.deepEqual(s.last().skips, ["last_implementer_no_slice"]);
  s.run("telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: "wf2", agent_type: "reviewer" });
  s.stop("wf2", "reviewer", "STATUS: pass");
  assert.equal(s.gate().status, 0);
  assert.equal(s.last().reason, "reviewer_passed");
  assert.equal(spawnSync("node", [hook("review-gate.mjs")], { input: "{", env: { ...process.env, CLAUDE_PROJECT_DIR: s.dir }, encoding: "utf8" }).status, 0, "malformed input exits 0");
});

test("test gate: log lines carry session_id and agent_id", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-verify-"));
  const r = spawnSync("bash", [hook("verify.sh")], { input: JSON.stringify({ session_id: "s-9", agent_type: "implementer", agent_id: "a7", cwd: dir }), env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ORCH_TEST_CMD: "exit 0" }, encoding: "utf8" });
  assert.equal(r.status, 0);
  const entry = JSON.parse(readFileSync(gateLog(dir), "utf8").trim());
  assert.deepEqual([entry.session_id, entry.agent_id, entry.reason], ["s-9", "a7", "tests_passed"]);
});
