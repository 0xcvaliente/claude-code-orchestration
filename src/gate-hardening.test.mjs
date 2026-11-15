// Gate hardening (release 1.4.0): the test gate's own time limit and whole-hook budget (verify.sh), the review gate's
// loop guard on a block record with no ts, one read per log per hook call (run.mjs readJsonl, review-gate.mjs,
// quote-check.mjs, handback-check.mjs), test-gate timestamps in milliseconds and a cwd with JSON escapes (verify.sh).
// Real hook processes on temporary folders and git repos; no model call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { foldRuns, launchRecord, stopRecord } from "../.claude/hooks/brief.mjs";
import { loadRecords } from "../.claude/hooks/run.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = (/** @type {string} */ name) => join(root, ".claude", "hooks", name);

// The machine's git, ORCH_ and plugin option variables are dropped so every run sees only what a test sets.
/** @returns {Record<string, string>} */
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      /** @returns {e is [string, string]} */ (e) => e[1] !== undefined && !/^(GIT_|ORCH_|CLAUDE_PLUGIN_OPTION_|CLAUDE_PLUGIN_ROOT)/.test(e[0]),
    ),
  );

/** @param {string} dir @param {...string} args */
function git(dir, ...args) {
  const r = spawnSync("git", ["-c", "user.name=orch", "-c", "user.email=orch@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env: cleanEnv(), encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}
/** @param {string} dir @param {Record<string, string>} files */
function write(dir, files) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
}
const tmp = (/** @type {string} */ prefix) => mkdtempSync(join(tmpdir(), prefix));
/** @param {string} dir @param {string} file @returns {any[]} */
const log = (dir, file) => {
  const f = join(dir, ".claude", "state", file);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

/**
 * verify.sh as the SubagentStop hook runs it; `limitMs` stops a hook that hangs, so a missing limit fails the test
 * instead of hanging it. @param {string} project @param {{ cwd?: string, env?: Record<string, string>, id?: string, transcript?: string, limitMs?: number }} [o]
 */
function gate(project, o = {}) {
  /** @type {Record<string, unknown>} */
  const event = { agent_type: "orchestration:implementer", agent_id: o.id ?? "a1", cwd: o.cwd ?? project, session_id: "s1" };
  if (o.transcript) event.agent_transcript_path = o.transcript;
  const t0 = Date.now();
  const r = spawnSync("bash", [hook("verify.sh")], {
    input: JSON.stringify(event),
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: project, TMPDIR: tmp("orch-gh-tmp-"), ...o.env },
    encoding: "utf8",
    timeout: o.limitMs ?? 60000,
    killSignal: "SIGKILL",
  });
  return { status: r.status, stderr: r.stderr, ms: Date.now() - t0 };
}
const lastTest = (/** @type {string} */ dir) => log(dir, "gates.jsonl").filter((g) => g.gate === "test").at(-1);
/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ---- 1. The test run has its own limit, and the hook a budget under its 900 s timeout. ----

// A suite that never ends, with a child process that would outlive a kill of the shell alone.
const HUNG = "sleep 300 & echo $! > child.pid; sleep 300";

test("test gate: a hung suite is stopped at ORCH_TEST_TIMEOUT_S, with its children, and blocks as a test failure", () => {
  const dir = tmp("orch-gh-hung-");
  const r = gate(dir, { env: { ORCH_TEST_CMD: HUNG, ORCH_TEST_TIMEOUT_S: "2" }, limitMs: 30000 });
  assert.equal(r.status, 2, `the hook must end on its own and block: ${r.stderr}`);
  assert.ok(r.ms < 15000, `stopped near the limit, took ${r.ms} ms`);
  assert.match(r.stderr, /did not finish within 2 seconds/);
  assert.deepEqual([lastTest(dir).decision, lastTest(dir).reason, lastTest(dir).timed_out], ["block", "tests_failed", 1]);
  const child = Number(readFileSync(join(dir, "child.pid"), "utf8"));
  assert.ok(child > 0 && !alive(child), "the suite's child process is killed too");
});

test("test gate: the loop guard still lets a hung suite's agent through after two blocks", () => {
  const dir = tmp("orch-gh-guard-");
  const env = { ORCH_TEST_CMD: HUNG, ORCH_TEST_TIMEOUT_S: "1" };
  assert.equal(gate(dir, { env, limitMs: 30000 }).status, 2);
  assert.equal(gate(dir, { env, limitMs: 30000 }).status, 2);
  const third = gate(dir, { env, limitMs: 30000 });
  assert.equal(third.status, 0);
  assert.deepEqual([lastTest(dir).decision, lastTest(dir).reason], ["allow", "max_blocks_reached"]);
});

test("test gate: an invalid ORCH_TEST_TIMEOUT_S falls back to the default, and a passing suite is unaffected", () => {
  const dir = tmp("orch-gh-ok-");
  for (const bad of ["", "abc", "0", "-5", "1.5"]) {
    const r = gate(dir, { env: { ORCH_TEST_CMD: "echo fine", ORCH_TEST_TIMEOUT_S: bad } });
    assert.equal(r.status, 0, `${bad}: ${r.stderr}`);
    assert.equal(lastTest(dir).reason, "tests_passed", bad);
  }
});

test("test gate budget: the test run is cut to the time left in the hook's budget", () => {
  const dir = tmp("orch-gh-budget-");
  const r = gate(dir, { env: { ORCH_TEST_CMD: HUNG, ORCH_TEST_TIMEOUT_S: "600", ORCH_HOOK_BUDGET_S: "3" }, limitMs: 30000 });
  assert.equal(r.status, 2, r.stderr);
  assert.ok(r.ms < 15000, `took ${r.ms} ms`);
  // The limit is the time left when the run starts: 3 s, or 2 s when the hook's start-up crossed a second.
  assert.match(r.stderr, /did not finish within [23] seconds/);
  assert.ok(lastTest(dir).limit_s <= 3, `limit ${lastTest(dir).limit_s} s`);
});

// A KIND: bugfix repo whose base run hangs (wt.marker exists only in the working tree), so only the hook's budget can
// end the bugfix check before the 900 s hook timeout; ORCH_BASE_TIMEOUT_S stays at its default of 300.
const RUN = 'if [ ! -e wt.marker ]; then sleep 300; fi\nrc=0\nfor f in tests/*_test.sh; do bash "$f" || { echo "FAILED $f::case - no"; rc=1; }; done\nexit $rc\n';
function slowBaseRepo() {
  const dir = tmp("orch-gh-bug-");
  git(dir, "init", "-q");
  write(dir, { "app.sh": "VALUE=1\n", "run.sh": RUN, "tests/ok_test.sh": "true\n", ".gitignore": "wt.marker\n" });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, { "wt.marker": "", "app.sh": "VALUE=2\n", "tests/value_test.sh": '. ./app.sh; [ "$VALUE" = 2 ]\n' });
  const transcript = join(tmp("orch-gh-tr-"), "agent.jsonl");
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: "SLICE: fix\nFILES: app.sh\nDEPENDS: none\nKIND: bugfix\nFix VALUE." } })}\n`);
  return { dir, transcript };
}

test("test gate budget: the bugfix check gets only the time left, and running out of it blocks (never allows)", () => {
  const { dir, transcript } = slowBaseRepo();
  const env = { ORCH_TEST_CMD: "bash run.sh", ORCH_HOOK_BUDGET_S: "12" };
  const r = gate(dir, { transcript, env, limitMs: 60000 });
  assert.equal(r.status, 2, `blocks as unverified: ${r.stderr}`);
  assert.ok(r.ms < 20000, `the hook ends within its budget, took ${r.ms} ms`);
  assert.match(lastTest(dir).reason, /^bugfix_/);
  assert.match(r.stderr, /unverified/);
  // The bugfix cap still applies: two blocks, then the third stop gives up.
  assert.equal(gate(dir, { transcript, env, limitMs: 60000 }).status, 2);
  assert.equal(gate(dir, { transcript, env, limitMs: 60000 }).status, 0);
  assert.equal(lastTest(dir).reason, "bugfix_unverified_gave_up");
});

test("test gate budget: no time left for the bugfix check blocks as unverified", () => {
  const { dir, transcript } = slowBaseRepo();
  // The suite itself takes at least 5 s of a 15 s budget: at most 10 s are left, which leaves no time for two base
  // runs after the 10 s kept for git and node.
  write(dir, { "tests/slow_test.sh": "sleep 5\n" });
  const env = { ORCH_TEST_CMD: "bash run.sh", ORCH_HOOK_BUDGET_S: "15" };
  const r = gate(dir, { transcript, env, limitMs: 60000 });
  assert.equal(r.status, 2, r.stderr);
  assert.ok(r.ms < 25000, `took ${r.ms} ms`);
  assert.equal(lastTest(dir).reason, "bugfix_timeout");
  assert.match(r.stderr, /KIND: bugfix: unverified/);
  // An agent whose brief is not KIND: bugfix passes as before, budget or not.
  const plain = join(tmp("orch-gh-tr-"), "agent.jsonl");
  writeFileSync(plain, `${JSON.stringify({ type: "user", message: { content: "SLICE: fix\nFILES: app.sh\nDEPENDS: none\nFix VALUE." } })}\n`);
  const ok = gate(dir, { transcript: plain, id: "a2", env, limitMs: 60000 });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(lastTest(dir).reason, "tests_passed");
});

// ---- 1b. The gate's temp folder lives until the hook ends. ----

// run_limited's watchdog is a subshell that the hook stops when the command ends. A SIGTERM that reached it before it
// had reset the traps it inherited ran the hook's EXIT trap there, which removed the hook's temp folder while the hook
// still ran (a fast command on a loaded machine: "check.in: No such file or directory", and the bugfix check skipped).
test("test gate: run_limited's watchdog never runs the hook's EXIT trap, however fast the command ends", () => {
  const fn = spawnSync("sed", ["-n", "/^run_limited() {/,/^}/p", hook("verify.sh")], { encoding: "utf8" }).stdout;
  assert.match(fn, /^run_limited\(\) \{/);
  const work = tmp("orch-gh-trap-");
  const loop = 'i=0\nwhile [ "$i" -lt 40 ]; do\n  run_limited 5 /dev/null /dev/null /dev/null true\n  [ -d "$work" ] || { echo "temp folder gone after run $i"; exit 3; }\n  i=$((i + 1))\ndone\ntrap - EXIT\n';
  const r = spawnSync("bash", ["-c", `${fn}\nwork="$1"\ntrap 'rm -rf "$work"' EXIT\n${loop}`, "x", work], { encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(existsSync(work));
});

// At its limit run_limited first sends the command's group SIGTERM, so a helper can remove its base worktree, and
// kills the group only when it is still there a few seconds later.
test("test gate: run_limited terminates the command before it kills it, and kills a group that ignores the terminate", () => {
  const fn = spawnSync("sed", ["-n", "/^run_limited() {/,/^}/p", hook("verify.sh")], { encoding: "utf8" }).stdout;
  const dir = tmp("orch-gh-term-");
  const polite = `trap 'echo cleaned > "${dir}/cleaned"; exit 0' TERM; sleep 60 & wait`;
  const stubborn = `trap '' TERM; sleep 60 & echo $! > "${dir}/child.pid"; wait`;
  const script = `${fn}\nrun_limited 1 /dev/null /dev/null /dev/null bash -c "$1"; echo "polite:$lim_timed_out"\nrun_limited 1 /dev/null /dev/null /dev/null bash -c "$2"; echo "stubborn:$lim_timed_out"\n`;
  const t0 = Date.now();
  const r = spawnSync("bash", ["-c", script, "x", polite, stubborn], { encoding: "utf8", timeout: 60000 });
  assert.match(r.stdout, /polite:1\nstubborn:1\n/);
  assert.equal(readFileSync(join(dir, "cleaned"), "utf8"), "cleaned\n", "the command got a SIGTERM and could clean up");
  const child = Number(readFileSync(join(dir, "child.pid"), "utf8"));
  assert.ok(child > 0 && !alive(child), "a group that ignores SIGTERM is killed after the grace");
  assert.ok(Date.now() - t0 < 40000, `took ${Date.now() - t0} ms`);
});

/** A committed repo with a code change and a transcript whose brief has `kind`. @param {string | null} kind */
function changedRepo(kind) {
  const dir = tmp("orch-gh-lost-");
  git(dir, "init", "-q");
  write(dir, { "app.sh": "VALUE=1\n", "tests/ok_test.sh": "true\n" });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, { "app.sh": "VALUE=2\n" });
  const transcript = join(tmp("orch-gh-tr-"), "agent.jsonl");
  const brief = `SLICE: fix\nFILES: app.sh\nDEPENDS: none\n${kind ? `KIND: ${kind}\n` : ""}Fix VALUE.`;
  writeFileSync(transcript, `${JSON.stringify({ type: "user", message: { content: brief } })}\n`);
  return { dir, transcript };
}

// Whatever removes the hook's temp folder (here the suite itself), the bugfix check still runs: before, the hook could
// not write the helper's input, skipped the check without a word and allowed with tests_passed.
test("test gate: a KIND: bugfix check still runs when the suite removes the gate's temp folder", () => {
  const cmd = 'rm -rf "$TMPDIR"/orch-verify.*; true';
  const bug = changedRepo("bugfix");
  const r = gate(bug.dir, { transcript: bug.transcript, env: { ORCH_TEST_CMD: cmd } });
  assert.equal(r.status, 2, `the check ran and blocks: ${r.stderr}`);
  assert.equal(lastTest(bug.dir).reason, "bugfix_no_test");
  assert.doesNotMatch(r.stderr, /No such file/);
  // Any other agent still passes.
  const plain = changedRepo(null);
  const ok = gate(plain.dir, { transcript: plain.transcript, env: { ORCH_TEST_CMD: cmd } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(lastTest(plain.dir).reason, "tests_passed");
});

// ---- 2. Review gate: a block record with no ts counts toward the loop guard, as the comment says. ----

test("review gate: block records with no ts count toward the loop guard", () => {
  const dir = tmp("orch-gh-rg-");
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  const env = { ...cleanEnv(), CLAUDE_PROJECT_DIR: dir };
  /** @param {string} name @param {object} payload */
  const run = (name, payload) => spawnSync(process.execPath, [hook(name)], { input: JSON.stringify({ session_id: "s1", ...payload }), env, encoding: "utf8" });
  const stopEvent = { hook_event_name: "SubagentStop", agent_id: "i1", agent_type: "orchestration:implementer", last_assistant_message: "STATUS: pass" };
  run("telemetry.mjs", { hook_event_name: "SubagentStart", agent_id: "i1", agent_type: "orchestration:implementer" });
  run("telemetry.mjs", stopEvent);
  const first = run("review-gate.mjs", {});
  assert.equal(first.status, 2, "an implementer with no review blocks");
  // Two older block records without a ts: the guard has spent its blocks.
  const old = JSON.stringify({ gate: "review", decision: "block", reason: "no_reviewer_after_last_implementer", session_id: "s1" });
  writeFileSync(join(dir, ".claude", "state", "gates.jsonl"), `${old}\n${old}\n`);
  const r = run("review-gate.mjs", {});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(log(dir, "gates.jsonl").at(-1)?.reason, "max_blocks_reached");
});

// ---- 3. Each log is read once per hook call, and lines of other sessions are not parsed. ----

/** A preload that counts whole-file reads per file name and writes them to READ_COUNTS on exit. */
function counter() {
  const dir = tmp("orch-gh-count-");
  const file = join(dir, "count.mjs");
  writeFileSync(
    file,
    `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const counts = {};
const orig = fs.readFileSync;
const write = fs.writeFileSync;
fs.readFileSync = function (p, ...rest) {
  const k = String(p).split("/").pop();
  counts[k] = (counts[k] ?? 0) + 1;
  return orig.call(this, p, ...rest);
};
syncBuiltinESMExports();
process.on("exit", () => write(process.env.READ_COUNTS, JSON.stringify(counts)));
`,
  );
  return { url: pathToFileURL(file).href, out: join(dir, "counts.json") };
}
/** @param {string} dir @param {string} name @param {unknown} input @returns {{ status: number | null, counts: Record<string, number> }} */
function counted(dir, name, input) {
  const c = counter();
  const r = spawnSync(process.execPath, ["--import", c.url, hook(name)], {
    input: JSON.stringify(input),
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: dir, READ_COUNTS: c.out },
    cwd: dir,
    encoding: "utf8",
  });
  return { status: r.status, counts: JSON.parse(readFileSync(c.out, "utf8")) };
}
const LOGS = ["telemetry.jsonl", "gates.jsonl", "journal.jsonl", "journal-launches.jsonl", "quotes.jsonl"];
/** @param {Record<string, number>} counts @param {string} what */
const onceEach = (counts, what) => {
  for (const f of LOGS) assert.ok((counts[f] ?? 0) <= 1, `${what}: ${f} read ${counts[f]} times`);
};

/** A state dir with a planned slice whose implementer finished unreviewed, plus another session's records. */
function busyState() {
  const dir = tmp("orch-gh-busy-");
  const state = join(dir, ".claude", "state");
  mkdirSync(state, { recursive: true });
  const ts = new Date(Date.now() - 60000).toISOString();
  const launches = [
    launchRecord({ subagent_type: "orchestration:reviewer", prompt: "PLAN REVIEW\nCONSTRAINTS:\nC1: x\nSLICE: a\nFILES: a.py\nDEPENDS: none\nGOAL: a" }, { ts, sessionId: "s1", agentId: "p1" }),
    launchRecord({ subagent_type: "orchestration:implementer", prompt: "SLICE: a\nFILES: a.py\nDEPENDS: none" }, { ts, sessionId: "s1", agentId: "i1" }),
  ];
  const stops = [stopRecord({ ts, sessionId: "s1", agentId: "p1", role: "reviewer", slice: "plan", reply: "STATUS: pass" }), stopRecord({ ts, sessionId: "s1", agentId: "i1", role: "implementer", reply: "STATUS: pass" })];
  const tel = [
    { ts, session_id: "s1", hook_event_name: "SubagentStart", agent_id: "i1", agent_type: "orchestration:implementer" },
    { ts, session_id: "s1", hook_event_name: "SubagentStop", agent_id: "i1", agent_type: "orchestration:implementer" },
  ];
  const other = (/** @type {object} */ r) => ({ ...r, session_id: "other" });
  /** @param {string} f @param {object[]} rows */
  const put = (f, rows) => writeFileSync(join(state, f), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  put("journal-launches.jsonl", [...launches.map(other), ...launches]);
  put("journal.jsonl", [...stops.map(other), ...stops]);
  put("telemetry.jsonl", [...tel.map(other), ...tel]);
  put("gates.jsonl", [{ ts, gate: "test", decision: "allow", reason: "tests_passed", agent_id: "i1" }, { ts, gate: "review", decision: "block", reason: "x", session_id: "other" }]);
  return dir;
}

test("review gate: telemetry.jsonl and gates.jsonl are each read once per call", () => {
  const dir = busyState();
  const r = counted(dir, "review-gate.mjs", { session_id: "s1" });
  assert.equal(r.status, 2, "slice a is unreviewed");
  onceEach(r.counts, "review gate");
  assert.equal(log(dir, "gates.jsonl").at(-1)?.reason, "no_reviewer_after_last_implementer");
});

test("handback check: each log is read once per call, and a denial still needs its record", () => {
  const dir = busyState();
  const r = counted(dir, "handback-check.mjs", { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_input: { message: "no status" }, agent_id: "w1", agent_type: "orchestration:reviewer" });
  assert.equal(r.status, 2);
  onceEach(r.counts, "handback check");
  const again = counted(dir, "handback-check.mjs", { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_input: { message: "no status" }, agent_id: "w1", agent_type: "orchestration:reviewer" });
  assert.equal(again.status, 0, "denied once only");
});

test("quote check: quotes.jsonl is read once per call, at a hand-back and at a stop", () => {
  const dir = busyState();
  writeFileSync(join(dir, "notes.md"), "hello world\n");
  const wrong = 'STATUS: pass\nQUOTE: notes.md:1 | "goodbye moon"';
  const hb = counted(dir, "quote-check.mjs", { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_input: { message: wrong }, agent_id: "q1", agent_type: "researcher" });
  assert.equal(hb.status, 2);
  onceEach(hb.counts, "quote check at handback");
  const stop = counted(dir, "quote-check.mjs", { session_id: "s1", hook_event_name: "SubagentStop", agent_id: "q2", agent_type: "researcher", last_assistant_message: wrong });
  assert.equal(stop.status, 2);
  onceEach(stop.counts, "quote check at stop");
  const second = counted(dir, "quote-check.mjs", { session_id: "s1", hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_input: { message: wrong }, agent_id: "q1", agent_type: "researcher" });
  assert.equal(second.status, 0, "refused once only");
});

test("loadRecords: lines of other sessions are skipped before JSON.parse; test-gate records with no session_id are kept", () => {
  const dir = tmp("orch-gh-parse-");
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push(JSON.stringify({ ts: "2026-11-01T00:00:00Z", session_id: `other-${i}`, gate: "test", decision: "allow", agent_id: `x${i}` }));
  lines.push(JSON.stringify({ ts: "2026-11-01T00:00:00Z", gate: "test", decision: "warn", reason: "tests_failed_isolated", agent_id: "old" }));
  lines.push(JSON.stringify({ ts: "2026-11-01T00:00:00Z", session_id: "s1", gate: "test", decision: "allow", agent_id: "mine" }));
  writeFileSync(join(dir, "gates.jsonl"), lines.join("\n") + "\n");
  writeFileSync(join(dir, "telemetry.jsonl"), lines.slice(0, 500).join("\n") + "\n");
  const parse = JSON.parse;
  let calls = 0;
  JSON.parse = /** @type {typeof JSON.parse} */ ((/** @type {string} */ text, /** @type {any} */ reviver) => {
    calls++;
    return parse(text, reviver);
  });
  let rec;
  try {
    rec = loadRecords("s1", dir);
  } finally {
    JSON.parse = parse;
  }
  assert.deepEqual(rec.gates.map((g) => g.agent_id), ["old", "mine"]);
  assert.equal(rec.starts.length, 0);
  assert.ok(calls <= 2, `parsed ${calls} lines; only 2 can belong to s1`);
});

// ---- 4. Test-gate records carry milliseconds, so they order against the node hooks' records within a second. ----

test("test gate: its record's ts has milliseconds and is not earlier than the stop it gates", () => {
  const project = tmp("orch-gh-ts-");
  const cwd = join(project, ".claude", "worktrees", "x");
  mkdirSync(cwd, { recursive: true });
  // A review stop logged just before the gate fires, in the same second.
  while (Date.now() % 1000 > 300) {
    // wait for the start of a second, so the hook finishes within it
  }
  const before = Date.now();
  const r = gate(project, { cwd, env: { ORCH_TEST_CMD: "exit 1" } });
  assert.equal(r.status, 0, "isolated: warn");
  const rec = lastTest(project);
  assert.equal(rec.reason, "tests_failed_isolated");
  assert.match(rec.ts, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  assert.ok(Date.parse(rec.ts) >= before, `${rec.ts} is earlier than ${new Date(before).toISOString()}`);
  // The fold then sees the isolated failure as part of the retry that followed the review.
  const launch = launchRecord({ subagent_type: "implementer", prompt: "SLICE: a\nFILES: a.py\nDEPENDS: none\nPATH: light" }, { ts: new Date(before - 60000).toISOString(), sessionId: "s1", agentId: "a1" });
  const impl1 = stopRecord({ ts: new Date(before - 50000).toISOString(), sessionId: "s1", agentId: "a1", role: "implementer", reply: "STATUS: pass" });
  const rev = stopRecord({ ts: new Date(before).toISOString(), sessionId: "s1", agentId: "r1", role: "reviewer", slice: "a", reply: "STATUS: fail\nGAP: 90 x" });
  const impl2 = stopRecord({ ts: new Date(Date.parse(rec.ts)).toISOString(), sessionId: "s1", agentId: "a1", role: "implementer", reply: "STATUS: pass" });
  const { runs } = foldRuns({ launches: [launch], stops: [impl1, rev, impl2], gates: [{ ...rec, session_id: "s1" }] }, { now: Date.now(), sessionId: "s1" });
  assert.equal(runs[0]?.slices.a?.isolatedTestFailure, true);
});

// ---- Follow-up: the test run keeps stdout and stderr in one stream, in the order written (as 2>&1 did). ----

test("test gate: stdout and stderr of the suite both reach the block message whole", () => {
  const dir = tmp("orch-gh-streams-");
  const cmd = 'echo "not ok 1 - src/a.test.mjs real failure"; echo "npm ERR! Test failed" >&2; exit 1';
  const r = gate(dir, { env: { ORCH_TEST_CMD: cmd, ORCH_BASELINE: "off" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /^not ok 1 - src\/a\.test\.mjs real failure$/m);
  assert.match(r.stderr, /^npm ERR! Test failed$/m);
  assert.ok(r.stderr.indexOf("not ok 1") < r.stderr.indexOf("npm ERR!"), "in the order written");
});

test("test gate: the baseline still parses a failing test's name when the suite also writes to stderr", () => {
  const dir = tmp("orch-gh-base-");
  git(dir, "init", "-q");
  write(dir, { "failures.txt": "FAILED tests/test_a.py::a - boom\n", "app.js": "export {};\n" });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, { "app.js": "export const x = 1;\n" });
  const cmd = 'cat failures.txt; echo "npm ERR! the test command failed with a message longer than the failure line" >&2; ! test -s failures.txt';
  const r = gate(dir, { env: { ORCH_TEST_CMD: cmd, ORCH_BASELINE: "allow" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(lastTest(dir).reason, "tests_failed_baseline");
});

// With a controlling terminal (util-linux `script` gives one), a suite that reads /dev/tty must not stop on SIGTTIN in
// its background process group and be counted as a timeout. Skipped where `script -qec` is not util-linux's.
const hasScript = spawnSync("script", ["-qec", "true", "/dev/null"], { stdio: "ignore" }).status === 0;
test("test gate: with a controlling terminal, a suite that reads /dev/tty fails at once instead of stopping", { skip: hasScript ? false : "no util-linux script" }, () => {
  const dir = tmp("orch-gh-tty-");
  const input = join(dir, "in.json");
  writeFileSync(input, JSON.stringify({ agent_type: "implementer", agent_id: "t1", cwd: dir, session_id: "s1" }));
  const cmd = 'read -t 60 x </dev/tty; exit 1';
  const inner = `CLAUDE_PROJECT_DIR='${dir}' ORCH_TEST_TIMEOUT_S=30 ORCH_BASELINE=off ORCH_TEST_CMD='${cmd}' bash '${hook("verify.sh")}' <'${input}' >/dev/null 2>&1`;
  const t0 = Date.now();
  spawnSync("script", ["-qec", inner, "/dev/null"], { env: cleanEnv(), stdio: "ignore", timeout: 60000 });
  const rec = lastTest(dir);
  assert.equal(rec?.reason, "tests_failed");
  assert.equal(rec?.timed_out, undefined, "not counted as a timeout");
  assert.ok(Date.now() - t0 < 20000, `ended long before the 30 s limit, took ${Date.now() - t0} ms`);
});

// ---- Follow-up: json_str unescapes the same way on bash 3.2 through 5 (compat32 and compat42 keep quotes in a
// quoted pattern replacement). ----

test("verify.sh json_str: a value with a space, \\\", \\\\ and \\/ reads the same in default, compat32 and compat42 mode", () => {
  const fn = spawnSync("sed", ["-n", "/^json_str() {/,/^}/p", hook("verify.sh")], { encoding: "utf8" }).stdout;
  assert.match(fn, /^json_str\(\) \{/);
  const input = String.raw`{"session_id":"s1","cwd":"/tmp/a \"b\" c\\d\/e","agent_id":"x"}`;
  for (const mode of ["", "shopt -s compat32 2>/dev/null || exit 3", "shopt -s compat42 2>/dev/null || exit 3"]) {
    const r = spawnSync("bash", ["-c", `${mode}\n${fn}\ninput="$1"\nprintf '%s|%s|%s' "$(json_str cwd)" "$(json_str agent_id)" "$(json_str session_id)"`, "x", input], { encoding: "utf8" });
    if (r.status === 3) continue; // this bash has no such compat level
    assert.equal(r.stdout, '/tmp/a "b" c\\d/e|x|s1', mode || "default");
  }
});

// ---- 5. A cwd with an escaped quote or backslash is read as the path it names. ----

test("test gate: a cwd containing a quote and a backslash is where the tests run", () => {
  const project = tmp("orch-gh-cwd-");
  const cwd = join(project, 'odd "dir\\ name');
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(cwd, "marker"), "");
  const r = gate(project, { cwd, env: { ORCH_TEST_CMD: "test -f marker" } });
  assert.equal(r.status, 0, `tests ran in the project dir instead: ${r.stderr}`);
  assert.equal(lastTest(project).reason, "tests_passed");
});
