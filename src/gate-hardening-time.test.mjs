// Gate hardening (release 1.4.0), part 1 of the former src/gate-hardening.test.mjs: the test gate's own time limit and whole-hook
// budget (verify.sh). Real hook processes on temporary folders and git repos; no model call. The parts run in parallel.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

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
  const r = gate(dir, { env: { ORCH_TEST_CMD: HUNG, ORCH_TEST_TIMEOUT_S: "1" }, limitMs: 30000 });
  assert.equal(r.status, 2, `the hook must end on its own and block: ${r.stderr}`);
  assert.ok(r.ms < 15000, `stopped near the limit, took ${r.ms} ms`);
  assert.match(r.stderr, /did not finish within 1 seconds/);
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
  // An agent whose brief is not KIND: bugfix passes as before, budget or not: a fresh repo with a fast suite and the
  // same budget (the slow suite above is what leaves no time for the bugfix check, not what this half checks).
  const fresh = slowBaseRepo();
  const plain = join(tmp("orch-gh-tr-"), "agent.jsonl");
  writeFileSync(plain, `${JSON.stringify({ type: "user", message: { content: "SLICE: fix\nFILES: app.sh\nDEPENDS: none\nFix VALUE." } })}\n`);
  const ok = gate(fresh.dir, { transcript: plain, id: "a2", env, limitMs: 60000 });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(lastTest(fresh.dir).reason, "tests_passed");
});
