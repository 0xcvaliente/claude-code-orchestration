import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareClaudeDir } from "./arms.mjs";
import { edit, withHooks } from "./variants/o-next.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("O-next overlay applies to the shipped .claude/ and keeps O-mix's models and hooks", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bench-onext-"));
  try {
    prepareClaudeDir("O-next", tmp, root, ["orchestration@m"]);
    const claude = join(tmp, ".claude");
    const orch = readFileSync(join(claude, "agents", "orchestrator.md"), "utf8");
    const rev = readFileSync(join(claude, "agents", "reviewer.md"), "utf8");
    for (const s of ["2a. Plan review", "SLICE: <id>", "review each slice as soon as its implementer returns", "final editor slice", "## Resume"]) assert.ok(orch.includes(s), s);
    for (const s of ["PLAN REVIEW", "FOCUS:"]) assert.ok(rev.includes(s), s);
    const shipped = (a) => readFileSync(join(root, ".claude", "agents", a), "utf8").match(/^---\n[\s\S]*?\n---/)[0];
    assert.equal(orch.match(/^---\n[\s\S]*?\n---/)[0], shipped("orchestrator.md"));
    assert.equal(rev.match(/^---\n[\s\S]*?\n---/)[0], shipped("reviewer.md"));
    for (const h of ["plan-check.mjs", "journal.mjs", "state.mjs"]) assert.ok(existsSync(join(claude, "hooks", h)), h);
    const settings = JSON.parse(readFileSync(join(claude, "settings.json"), "utf8"));
    assert.equal(settings.enabledPlugins["orchestration@m"], false);
    assert.ok(settings.hooks.Stop, "shipped review gate kept");
    assert.ok(settings.hooks.PreToolUse.some((e) => JSON.stringify(e).includes("plan-check.mjs")));
    assert.equal(settings.hooks.SubagentStop.length, 3, "telemetry, verify and journal");
    assert.ok(settings.hooks.PostToolUse.some((e) => JSON.stringify(e).includes("journal.mjs")), "journal records launches");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("edit throws on a missing or repeated anchor; withHooks appends", () => {
  assert.throws(() => edit("a b", [["c", "d"]], "f.md"), /found 0 times in f\.md/);
  assert.throws(() => edit("a a", [["a", "d"]], "f.md"), /found 2 times/);
  assert.equal(edit("a $& b", [["b", "$1"]], "f.md"), "a $& $1");
  const s = withHooks({ hooks: { SubagentStop: [{ x: 1 }] }, model: "m" });
  assert.equal(s.model, "m");
  assert.equal(s.hooks.SubagentStop.length, 2);
  assert.equal(s.hooks.PreToolUse.length, 1);
  assert.equal(s.hooks.PostToolUse.length, 1);
});

// A throwaway project with the variant's hooks and the shipped state.mjs, as a run repo gets them. By default the
// plan review has finished in sessions s1 and other-session, so the plan-review gate is open.
function project({ reviewed = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "bench-onext-hook-"));
  const hooks = join(dir, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  copyFileSync(join(root, ".claude", "hooks", "state.mjs"), join(hooks, "state.mjs"));
  for (const h of ["plan-check.mjs", "journal.mjs"]) copyFileSync(join(root, "bench", "variants", "o-next", "hooks", h), join(hooks, h));
  if (reviewed) {
    mkdirSync(join(dir, ".claude", "state"), { recursive: true });
    const plan = (session) => JSON.stringify({ ts: "t", session_id: session, slice: "plan", role: "reviewer", status: "pass", agent_id: "r0" });
    writeFileSync(join(dir, ".claude", "state", "journal.jsonl"), `${plan("s1")}\n${plan("other-session")}\n`);
  }
  return dir;
}
const run = (dir, script, payload) =>
  spawnSync("node", [join(dir, ".claude", "hooks", script)], { input: typeof payload === "string" ? payload : JSON.stringify(payload), env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: "utf8" });
const launch = (dir, prompt, type = "implementer", session = "s1") =>
  run(dir, "plan-check.mjs", { session_id: session, tool_name: "Agent", tool_input: { subagent_type: type, prompt } });

test("plan check: disjoint slices pass, overlap blocks unless DEPENDS, cycles block, retries keep their files", () => {
  const dir = project();
  try {
    assert.equal(launch(dir, "SLICE: toml\nFILES: toolkit/toml.py, tests/test_toml.py\nDEPENDS: none\nGoal: ...").status, 0);
    assert.equal(launch(dir, "SLICE: csv\nFILES: `toolkit/csv.py`\nDEPENDS: none").status, 0);
    const clash = launch(dir, "SLICE: shlex\nFILES: toolkit/shlex.py, toolkit/toml.py\nDEPENDS: none");
    assert.equal(clash.status, 2);
    assert.match(clash.stderr, /toolkit\/toml\.py \(owned by toml\)/);
    assert.equal(launch(dir, "SLICE: wide\nFILES: toolkit/*\nDEPENDS: none").status, 2, "a glob over owned files overlaps");
    assert.equal(launch(dir, "SLICE: toml\nFILES: toolkit/toml.py\nDEPENDS: none").status, 0, "retry of the same slice");
    assert.equal(launch(dir, "SLICE: editor\nFILES: toolkit/toml.py, toolkit/csv.py\nDEPENDS: toml, csv").status, 0, "editor lists the owners");
    assert.equal(launch(dir, "SLICE: a\nFILES: x.py\nDEPENDS: b").status, 0);
    const cyc = launch(dir, "SLICE: b\nFILES: y.py\nDEPENDS: a");
    assert.equal(cyc.status, 2);
    assert.match(cyc.stderr, /cycle/);
    assert.equal(launch(dir, "SLICE: shlex\nFILES: toolkit/toml.py", "implementer", "other-session").status, 0, "other sessions do not count");
    assert.equal(launch(dir, "no lines", "reviewer").status, 0, "only implementers are checked");
    assert.equal(run(dir, "plan-check.mjs", "not json").status, 0, "malformed input exits 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan check: a brief without SLICE or FILES is blocked twice per session, then let through", () => {
  const dir = project();
  try {
    assert.equal(launch(dir, "Goal: do it").status, 2);
    assert.equal(launch(dir, "SLICE: x\nGoal: do it").status, 2);
    assert.equal(launch(dir, "Goal: do it").status, 0);
    const log = readFileSync(join(dir, ".claude", "state", "plan-check.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(log.map((e) => e.reason), ["missing_lines", "missing_lines", "missing_lines_gave_up"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal: records slice, role and status from the subagent transcript; plan reviews are slice plan", () => {
  const dir = project({ reviewed: false });
  try {
    const transcript = (brief, report) => {
      const f = join(dir, `t-${Math.random()}.jsonl`);
      const lines = [
        { type: "user", message: { content: brief } },
        { type: "assistant", message: { content: [{ type: "text", text: report }] } },
      ];
      writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"));
      return f;
    };
    const stop = (type, brief, report, last) =>
      run(dir, "journal.mjs", { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "a1", agent_type: type, agent_transcript_path: transcript(brief, report), last_assistant_message: last });
    assert.equal(stop("implementer", "SLICE: toml\nFILES: toolkit/toml.py\nDEPENDS: none", "STATUS: pass\nDONE").status, 0);
    assert.equal(stop("orchestration:reviewer", [{ type: "text", text: "SLICE: toml\nFOCUS: dates" }], "x", "STATUS: fail\nGAPS: ...").status, 0);
    assert.equal(stop("reviewer", "PLAN REVIEW\nTask: ...", "Reply in this format: STATUS: pass or fail\n\nSTATUS: pass").status, 0);
    assert.equal(stop("researcher", "SLICE: q1", "STATUS: pass").status, 0);
    assert.equal(stop("implementer", "no slice line", "STATUS: pass").status, 0);
    const log = readFileSync(join(dir, ".claude", "state", "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(log.map((e) => [e.slice, e.role, e.status]), [["toml", "implementer", "pass"], ["toml", "reviewer", "fail"], ["plan", "reviewer", "pass"]]);
    assert.equal(run(dir, "journal.mjs", "{").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan check: launches of one wave that arrive together still see each other", async () => {
  const dir = project();
  try {
    const { spawn } = await import("node:child_process");
    const one = (slice) =>
      new Promise((resolve) => {
        const p = spawn("node", [join(dir, ".claude", "hooks", "plan-check.mjs")], { env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
        p.on("close", resolve);
        p.stdin.end(JSON.stringify({ session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "implementer", prompt: `SLICE: ${slice}\nFILES: shared.py\nDEPENDS: none` } }));
      });
    const codes = await Promise.all(["a", "b", "c", "d"].map(one));
    assert.equal(codes.filter((c) => c === 0).length, 1, `exactly one owner: ${codes}`);
    assert.equal(existsSync(join(dir, ".claude", "state", "plan-check.lock")), false, "lock released");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan check: the first implementers wait for a finished plan review, PATH: light skips it", () => {
  const dir = project({ reviewed: false });
  try {
    const a = "SLICE: a\nFILES: a.py\nDEPENDS: none";
    const blocked = launch(dir, a);
    assert.equal(blocked.status, 2);
    assert.match(blocked.stderr, /PLAN REVIEW/);
    assert.equal(launch(dir, "SLICE: b\nFILES: b.py\nDEPENDS: none").status, 2, "a whole wave waits");
    const lite = (id) => launch(dir, `SLICE: ${id}\nFILES: ${id}.py\nDEPENDS: none\nPATH: light`, "implementer", "s2");
    assert.equal(lite("l1").status, 0, "light path: a single slice");
    assert.equal(lite("l1").status, 0, "a retry of the light slice");
    const multi = lite("l2");
    assert.equal(multi.status, 2, "PATH: light on a second slice waits for a plan review");
    assert.match(multi.stderr, /single slice/);
    // The plan reviewer finishes: journal.mjs records it from its launch and its stop.
    run(dir, "journal.mjs", { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "reviewer", prompt: "PLAN REVIEW\nTask: ..." }, tool_response: { status: "async_launched", agentId: "rev1" } });
    run(dir, "journal.mjs", { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "rev1", agent_type: "reviewer", last_assistant_message: "STATUS: pass" });
    assert.equal(launch(dir, a).status, 0, "open after the plan review");
    assert.equal(launch(dir, "SLICE: b\nFILES: b.py\nDEPENDS: none").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan check: without a plan review each slice is blocked twice, then let through and the gate opens", () => {
  const dir = project({ reviewed: false });
  try {
    const a = "SLICE: a\nFILES: a.py\nDEPENDS: none";
    assert.equal(launch(dir, a).status, 2);
    assert.equal(launch(dir, a).status, 2);
    assert.equal(launch(dir, a).status, 0);
    assert.equal(launch(dir, "SLICE: b\nFILES: b.py\nDEPENDS: none").status, 0, "the gate is open once any implementer ran");
    const log = readFileSync(join(dir, ".claude", "state", "plan-check.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(log.map((e) => e.reason), ["no_plan_review", "no_plan_review", "no_plan_review_gave_up", "ok"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal: headless (no transcript) takes the slice from the launch, in either event order", () => {
  const dir = project({ reviewed: false });
  try {
    const post = (agentId, type, prompt, response) =>
      run(dir, "journal.mjs", { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: type, prompt }, tool_response: response ?? { isAsync: true, status: "async_launched", agentId } });
    const stop = (agentId, type, last) =>
      run(dir, "journal.mjs", { hook_event_name: "SubagentStop", session_id: "s1", agent_id: agentId, agent_type: type, agent_transcript_path: join(dir, "missing.jsonl"), last_assistant_message: last });
    post("bg1", "implementer", "SLICE: toml\nFILES: toolkit/toml.py\nDEPENDS: none");
    stop("bg1", "implementer", "STATUS: pass");
    stop("a5f80f257663a4fed", "orchestration:reviewer", "STATUS: fail\nGAPS: x");
    post("a5f80f257663a4fed", "orchestration:reviewer", "SLICE: toml\nFOCUS: dates", [{ type: "text", text: "STATUS: fail" }, { type: "text", text: "agentId: a5f80f257663a4fed (use SendMessage)" }]);
    post("x1", "researcher", "SLICE: q1");
    post("x2", "implementer", "no slice line");
    const log = readFileSync(join(dir, ".claude", "state", "journal.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(log.map((e) => [e.slice, e.role, e.status, e.agent_id]), [["toml", "implementer", "pass", "bg1"], ["toml", "reviewer", "fail", "a5f80f257663a4fed"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
