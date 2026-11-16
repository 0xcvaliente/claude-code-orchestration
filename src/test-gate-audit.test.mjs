// Regression tests for the 2026-11-16 audit of the test gate (docs/data/audit-2026-11-16/test-gate-guards.md): T-1,
// T-2, T-3, T-4, T-8, T-9, T-12 (budget cap) and T-13. verify.sh runs as the SubagentStop hook, in real temporary git
// repos, as in test-gate-v2.test.mjs.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { inFiles, parseFailures } from "../.claude/hooks/bugfix-check.mjs";

const verifySh = new URL("../.claude/hooks/verify.sh", import.meta.url).pathname;

/** @returns {Record<string, string>} */
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      /** @returns {e is [string, string]} */ (e) => e[1] !== undefined && !/^(GIT_|ORCH_|CLAUDE_PLUGIN_OPTION_|NODE_TEST_CONTEXT$)/.test(e[0]),
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

/** A committed repo with `files`, at `dir` (made) or a fresh temp folder. @param {Record<string, string>} files @param {string} [at] */
function repo(files, at) {
  const dir = at ?? mkdtempSync(join(tmpdir(), "orch-tga-"));
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

/** @param {string} project @param {{ cwd?: string, env?: Record<string, string>, id?: string, transcript?: string }} [o] */
function gate(project, o = {}) {
  /** @type {Record<string, unknown>} */
  const event = { agent_type: "implementer", agent_id: o.id ?? "a1", cwd: o.cwd ?? project, session_id: "s1" };
  if (o.transcript) event.agent_transcript_path = o.transcript;
  const r = spawnSync("bash", [verifySh], {
    input: JSON.stringify(event),
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: project, TMPDIR: mkdtempSync(join(tmpdir(), "orch-tga-tmp-")), ...o.env },
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr };
}
const stateDir = (/** @type {string} */ project) => join(project, ".claude", "state");
const last = (/** @type {string} */ project) => JSON.parse(readFileSync(join(stateDir(project), "gates.jsonl"), "utf8").trim().split("\n").pop() ?? "{}");

/** A transcript whose brief says KIND: bugfix. */
function bugfixTranscript() {
  const t = join(mkdtempSync(join(tmpdir(), "orch-tga-tr-")), "agent.jsonl");
  writeFileSync(t, JSON.stringify({ type: "user", message: { content: "SLICE: fix\nFILES: x\nDEPENDS: none\nKIND: bugfix\nFix it." } }) + "\n");
  return t;
}

const TAP_CMD = "cat failures.txt; ! test -s failures.txt";
const FA = "FAILED tests/test_a.py::a - boom\n";
const FB = "FAILED tests/test_b.py::b - boom\n";
const QUIET = { ORCH_BASELINE: "off", ORCH_BUGFIX_CHECK: "off" };

// ---- T-1: a session that itself runs in a worktree under .claude/worktrees is the shared tree ----

test("T-1: a session worktree's own implementer is gated as the shared tree; an agent worktree inside it stays isolated", () => {
  const top = mkdtempSync(join(tmpdir(), "orch-tga-t1-"));
  const sess = repo({ "app.js": "x\n" }, join(top, "proj", ".claude", "worktrees", "sess"));
  write(sess, { "app.js": "y\n" });
  const shared = gate(sess, { env: { ...QUIET, ORCH_TEST_CMD: "exit 1" } });
  assert.equal(shared.status, 2, "failing tests block the session's own implementer");
  assert.equal(last(sess).reason, "tests_failed");

  const agentWt = join(sess, ".claude", "worktrees", "agent-x");
  mkdirSync(agentWt, { recursive: true });
  const iso = gate(sess, { cwd: agentWt, id: "a2", env: { ...QUIET, ORCH_TEST_CMD: "exit 1" } });
  assert.equal(iso.status, 0);
  assert.equal(last(sess).reason, "tests_failed_isolated");
});

test("T-1: the baseline of a session worktree compares against its HEAD, not the main worktree's fork point", () => {
  const main = repo({ "failures.txt": FA, "app.js": "x\n" });
  const sess = join(main, ".claude", "worktrees", "sess");
  git(main, "worktree", "add", "-q", "-b", "sess", sess);
  write(sess, { "failures.txt": FA + FB });
  git(sess, "commit", "-q", "-am", "session work");
  write(sess, { "app.js": "y\n" });
  const r = gate(sess, { env: { ORCH_TEST_CMD: TAP_CMD, ORCH_BUGFIX_CHECK: "off" } });
  assert.equal(r.status, 2, r.stderr);
  const rec = last(sess);
  assert.deepEqual([rec.reason, rec.failing, rec.on_base], ["tests_failed", 2, 2], "both failures already fail on the session's HEAD");
});

// ---- T-2: committed code plus an uncommitted prose file in an isolated worktree keeps the tests ----

test("T-2: an isolated slice that committed code and left one prose file uncommitted still runs the tests", () => {
  const main = repo({ "package.json": JSON.stringify({ scripts: { test: "node a.js" } }), "a.js": "process.exit(0)\n", ".gitignore": ".claude/\n" });
  const wt = join(main, ".claude", "worktrees", "w");
  git(main, "worktree", "add", "-q", "--detach", wt);
  write(wt, { "a.js": "process.exit(1)\n" });
  git(wt, "commit", "-q", "-am", "breaks the tests");
  write(wt, { "NOTES.md": "notes\n" });
  const block = gate(main, { cwd: wt, env: { ...QUIET, ORCH_GATE_ISOLATED: "block" } });
  assert.equal(block.status, 2, "block mode: the failing suite blocks");
  assert.equal(last(main).reason, "tests_failed");
  const warn = gate(main, { cwd: wt, id: "a2", env: QUIET });
  assert.equal(warn.status, 0);
  assert.equal(last(main).reason, "tests_failed_isolated", "warn mode keeps the doubt signal");

  // Prose committed and prose uncommitted: still skipped.
  const main2 = repo({ "package.json": JSON.stringify({ scripts: { test: "node a.js" } }), "a.js": "process.exit(1)\n", ".gitignore": ".claude/\n" });
  const wt2 = join(main2, ".claude", "worktrees", "w");
  git(main2, "worktree", "add", "-q", "--detach", wt2);
  write(wt2, { "README.md": "docs\n" });
  git(wt2, "add", "-A");
  git(wt2, "commit", "-q", "-m", "docs");
  write(wt2, { "NOTES.md": "notes\n" });
  assert.equal(gate(main2, { cwd: wt2, env: { ...QUIET, ORCH_GATE_ISOLATED: "block" } }).status, 0);
  assert.equal(last(main2).reason, "no_code_changes");
});

// ---- T-3: a file-level failure (import error) on the base is no reproduction ----

test("T-3: a bugfix test whose only failure on the base is a load error of its file is not verified", () => {
  const dir = repo({
    "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test" } }),
    "src/add.mjs": "export const add = (a, b) => a - b;\n",
    "test/smoke.test.mjs": 'import test from "node:test";\ntest("smoke", () => {});\n',
    ".gitignore": ".claude/\n",
  });
  write(dir, {
    "src/helper.mjs": "export const x = 1;\n",
    "test/add.test.mjs": 'import test from "node:test";\nimport { x } from "../src/helper.mjs";\ntest("add is fixed", () => {});\n',
  });
  const r = gate(dir, { transcript: bugfixTranscript() });
  assert.equal(r.status, 2, "the test body never ran on the base");
  assert.equal(last(dir).reason, "bugfix_test_passes_on_base");
  assert.equal(last(dir).new_failing, 0);

  // A real node reproduction (its body fails on the base) is still verified.
  write(dir, {
    "src/add.mjs": "export const add = (a, b) => a + b;\n",
    "test/add.test.mjs": 'import test from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/add.mjs";\ntest("add adds", () => assert.equal(add(2, 2), 4));\n',
  });
  const ok = gate(dir, { transcript: bugfixTranscript(), id: "a2" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual([last(dir).reason, last(dir).new_failing], ["bugfix_verified", 1]);
});

// ---- T-4: unittest output ----

test("T-4: unittest failures are parsed, qualified by the module's file", () => {
  assert.deepEqual(parseFailures("FAIL: test_add (test_add.T.test_add)\n----\nFAILED (failures=1)\n").names, ["test_add.py::T.test_add"]);
  assert.deepEqual(parseFailures("ERROR: test_b (pkg.tests.test_b.Case.test_b)\n").names, ["pkg/tests/test_b.py::Case.test_b"]);
  assert.deepEqual(parseFailures("FAIL: test_add (tests.test_add.T)\n").names, ["tests/test_add.py::T.test_add"], "the form before Python 3.11");
  const loadErr = parseFailures("ERROR: test_add (unittest.loader._FailedTest.test_add)\nImportError: Failed to import test module: test_add\n");
  assert.deepEqual([loadErr.names, loadErr.crash], [[], true], "a module that fails to import is a crash, not a test");
  assert.ok(inFiles("test_add.py::T.test_add", ["test_add.py"]) && inFiles("tests/test_add.py::T.test_add", ["tests/test_add.py"]));
});

const hasPython = spawnSync("python3", ["-c", "1"]).status === 0;
test("T-4: a unittest reproduction test is verified at the first stop", { skip: !hasPython && "python3 missing" }, () => {
  const dir = repo({ "calc.py": "def add(a, b):\n    return a - b\n", "test_smoke.py": "import unittest\nclass T(unittest.TestCase):\n    def test_smoke(self):\n        pass\n", ".gitignore": ".claude/\n__pycache__/\n" });
  write(dir, { "calc.py": "def add(a, b):\n    return a + b\n", "test_add.py": "import unittest\nfrom calc import add\nclass T(unittest.TestCase):\n    def test_add(self):\n        self.assertEqual(add(2, 2), 4)\n" });
  const r = gate(dir, { transcript: bugfixTranscript(), env: { ORCH_TEST_CMD: "python3 -m unittest discover -q" } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([last(dir).reason, last(dir).new_failing], ["bugfix_verified", 1]);
});

// ---- T-13: cargo test --quiet ----

test("T-13: the terse form of cargo test --quiet is parsed, qualified by cargo's rerun hint", () => {
  const lib = "\nrunning 1 test\ntests::adds --- FAILED\n\nfailures:\n\n---- tests::adds stdout ----\n\nthread 'tests::adds' panicked at src/lib.rs:3:30:\n\nfailures:\n    tests::adds\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\nerror: test failed, to rerun pass `--lib`\n";
  assert.deepEqual(parseFailures(lib), { names: ["src/lib.rs::tests::adds"], unqualified: [], crash: false });
  const integ = "\nrunning 1 test\nadds --- FAILED\n\nfailures:\n    adds\n\ntest result: FAILED. 0 passed; 1 failed\n\nerror: test failed, to rerun pass `--test add_test`\n";
  assert.deepEqual(parseFailures(integ).names, ["tests/add_test.rs::adds"]);
  assert.ok(inFiles(parseFailures(integ).names[0] ?? "", ["tests/add_test.rs"]));
  assert.equal(parseFailures("error: test failed, to rerun pass `--lib`\n").crash, true, "the hint with no failed name is still a crash");
});

test("T-13: a workspace member's quiet cargo failure matches the member's changed test file, not another member's", () => {
  const integ = parseFailures("it_works --- FAILED\n\nerror: test failed, to rerun pass `-p mycrate --test foo`\n").names[0] ?? "";
  assert.ok(inFiles(integ, ["crates/mycrate/tests/foo.rs"]), `${integ} in crates/mycrate/tests/foo.rs`);
  assert.ok(!inFiles(integ, ["crates/other/tests/foo.rs"]), `${integ} is not in another member`);
  const lib = parseFailures("tests::adds --- FAILED\n\nerror: test failed, to rerun pass `-p mycrate --lib`\n").names[0] ?? "";
  assert.ok(inFiles(lib, ["crates/mycrate/src/lib.rs"]), `${lib} in crates/mycrate/src/lib.rs`);
  assert.ok(!inFiles(lib, ["crates/other/src/lib.rs"]));
  // A single crate keeps its root-relative qualifier.
  assert.ok(inFiles(parseFailures("adds --- FAILED\nerror: test failed, to rerun pass `--test add_test`\n").names[0] ?? "", ["tests/add_test.rs"]));
});

// ---- T-9: the block caps restart when the agent is started again (a SendMessage resume) ----

/** @param {string} project @param {string} id */
function subagentStart(project, id) {
  mkdirSync(stateDir(project), { recursive: true });
  appendFileSync(join(stateDir(project), "telemetry.jsonl"), JSON.stringify({ ts: new Date().toISOString(), session_id: "s1", agent_id: id, agent_type: "implementer", hook_event_name: "SubagentStart" }) + "\n");
}

test("T-9: the tests_failed cap counts only the blocks since the agent's latest SubagentStart", () => {
  const dir = repo({ "app.js": "x\n" });
  const env = { ...QUIET, ORCH_TEST_CMD: "exit 1" };
  subagentStart(dir, "a1");
  assert.equal(gate(dir, { env }).status, 2);
  assert.equal(gate(dir, { env }).status, 2);
  assert.equal(gate(dir, { env }).status, 0);
  assert.equal(last(dir).reason, "max_blocks_reached");
  subagentStart(dir, "a1"); // resumed
  assert.equal(gate(dir, { env }).status, 2, "the resumed attempt gets its own two blocks");
  assert.equal(last(dir).reason, "tests_failed");
  subagentStart(dir, "other");
  assert.equal(gate(dir, { env }).status, 2, "another agent's start does not reset this one's count");
  assert.equal(gate(dir, { env }).status, 0);
  assert.equal(last(dir).reason, "max_blocks_reached");
});

test("T-9: the bugfix cap counts only the blocks since the agent's latest SubagentStart", () => {
  const dir = repo({ "app.sh": "VALUE=1\n" });
  write(dir, { "app.sh": "VALUE=2\n" });
  const transcript = bugfixTranscript();
  const env = { ORCH_TEST_CMD: "true" };
  assert.equal(gate(dir, { transcript, env }).status, 2);
  assert.equal(gate(dir, { transcript, env }).status, 2);
  assert.equal(gate(dir, { transcript, env }).status, 0);
  assert.equal(last(dir).reason, "bugfix_unverified_gave_up");
  subagentStart(dir, "a1");
  assert.equal(gate(dir, { transcript, env }).status, 2, "the resumed attempt is checked again");
  assert.equal(last(dir).reason, "bugfix_no_test");
});

// ---- T-8: isolated worktree with the allow baseline keeps tests_failed_isolated ----

test("T-8: an isolated failure that also fails on the base is logged tests_failed_isolated, with the baseline's counts", () => {
  const main = repo({ "failures.txt": FA, "app.js": "x\n", ".gitignore": ".claude/\n" });
  const wt = join(main, ".claude", "worktrees", "w");
  git(main, "worktree", "add", "-q", "--detach", wt);
  write(wt, { "app.js": "y\n" });
  git(wt, "commit", "-q", "-am", "slice work");
  const r = gate(main, { cwd: wt, env: { ORCH_TEST_CMD: TAP_CMD, ORCH_BASELINE: "allow", ORCH_BUGFIX_CHECK: "off" } });
  assert.equal(r.status, 0, r.stderr);
  const rec = last(main);
  assert.deepEqual([rec.decision, rec.reason, rec.failing, rec.base_failing], ["warn", "tests_failed_isolated", 1, 1]);
});

// ---- T-12: the hook budget is capped at 870 s ----

test("T-12: a hook budget above 870 s is cut to 870, so the base run's share stays under the hook timeout", () => {
  const dir = repo({ "failures.txt": FA, "app.js": "x\n" });
  write(dir, { "app.js": "y\n" });
  const seen = join(mkdtempSync(join(tmpdir(), "orch-tga-seen-")), "seen");
  const cmd = `printf '%s\\n' "$ORCH_BASE_TIMEOUT_S" >> '${seen}'; ${TAP_CMD}`;
  gate(dir, { env: { ORCH_TEST_CMD: cmd, ORCH_HOOK_BUDGET_S: "5000", ORCH_BASE_TIMEOUT_S: "5000", ORCH_BUGFIX_CHECK: "off" } });
  const share = Number(readFileSync(seen, "utf8").trim().split("\n").pop());
  assert.ok(share > 0 && share <= 860, `the base run got ${share} s`);
});
