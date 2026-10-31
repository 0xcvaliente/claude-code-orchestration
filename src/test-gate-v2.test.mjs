// Test gate 0.4.0: the test baseline, the KIND: bugfix check (both in .claude/hooks/bugfix-check.mjs, called by
// verify.sh) and the plugin userConfig bridge (state.mjs and verify.sh). Real temporary git repos, as in hooks.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cacheKey, complete, inFiles, isTestFile, parseFailures } from "../.claude/hooks/bugfix-check.mjs";
import { bridgeOptions } from "../.claude/hooks/state.mjs";

const hook = (/** @type {string} */ name) => new URL(`../.claude/hooks/${name}`, import.meta.url).pathname;

// The machine's git, ORCH_ and plugin option variables are dropped so every run sees only what a test sets.
/** @returns {Record<string, string>} */
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      /** @returns {e is [string, string]} */ (e) => e[1] !== undefined && !/^(GIT_|ORCH_|CLAUDE_PLUGIN_OPTION_)/.test(e[0]),
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

/** A committed repo with `files`. @param {Record<string, string>} files */
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "orch-tg2-"));
  git(dir, "init", "-q");
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

// A fake runner: prints failures.txt (runner output) and fails when it is not empty.
const TAP_CMD = "cat failures.txt; ! test -s failures.txt";
// Qualified failures in pytest's summary form.
const FA = "FAILED tests/test_a.py::a - boom\n";
const FB = "FAILED tests/test_b.py::b - boom\n";
const ALLOW = { ORCH_BASELINE: "allow" };

/**
 * verify.sh as the SubagentStop hook runs it. TMPDIR is a fresh dir per call (or `o.tmp`) so base worktrees can be checked.
 * @param {string} project @param {{ cwd?: string, env?: Record<string, string>, id?: string, transcript?: string, tmp?: string }} [o]
 */
function gate(project, o = {}) {
  const tmp = o.tmp ?? mkdtempSync(join(tmpdir(), "orch-tg2-tmp-"));
  /** @type {Record<string, unknown>} */
  const event = { agent_type: "orchestration:implementer", agent_id: o.id ?? "a1", cwd: o.cwd ?? project, session_id: "s1" };
  if (o.transcript) event.agent_transcript_path = o.transcript;
  const r = spawnSync("bash", [hook("verify.sh")], {
    input: JSON.stringify(event),
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: project, TMPDIR: tmp, ...o.env },
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr, tmp };
}
const gateLog = (/** @type {string} */ project) => readFileSync(join(project, ".claude", "state", "gates.jsonl"), "utf8");
const last = (/** @type {string} */ project) => JSON.parse(gateLog(project).trim().split("\n").pop() ?? "{}");
const cacheFile = (/** @type {string} */ project) => join(project, ".claude", "state", "baseline-cache.json");

// ---- parser ----

/** @param {string} text @param {string} [root] */
const names = (text, root) => parseFailures(text, root).names;

test("parseFailures: every name is qualified by its file or package", () => {
  const tap = "TAP version 13\nok 1 - fine\nnot ok 2 - adds numbers\n  ---\n  duration_ms: 1\n  location: '/repo/test/a.test.mjs:3:1'\n  ...\nnot ok 3 - later # TODO\n";
  assert.deepEqual(names(tap, "/repo"), ["test/a.test.mjs::adds numbers"]);
  assert.deepEqual(names(tap), ["/repo/test/a.test.mjs::adds numbers"]);
  const spec = "✖ a b (0.47ms)\nℹ fail 1\n\n✖ failing tests:\n\ntest at test/x.test.mjs:1:32\n✖ a b (0.47ms)\n  Error: x\n";
  assert.deepEqual(names(spec), ["test/x.test.mjs::a b"]);
  assert.deepEqual(names("FAIL src/math.test.js\n  ● Math › adds\n    ✕ adds (5 ms)\n"), ["src/math.test.js::Math › adds", "src/math.test.js::adds"]);
  assert.deepEqual(names(" FAIL  src/x.test.ts > suite > case\n ❯ src/y.test.ts (2 tests | 1 failed)\n   × other 3ms\n"), ["src/x.test.ts::suite > case", "src/y.test.ts::other"]);
  assert.deepEqual(names("FAILED tests/test_x.py::test_a - AssertionError: no\nERROR tests/test_y.py::test_b\nFAILED (failures=1)\n"), ["tests/test_x.py::test_a", "tests/test_y.py::test_b"]);
  assert.deepEqual(names("--- FAIL: TestAdd (0.00s)\n    --- FAIL: TestAdd/sub (0.00s)\nFAIL\nFAIL\texample.com/m/calc\t0.01s\n"), ["example.com/m/calc::TestAdd", "example.com/m/calc::TestAdd/sub"]);
  assert.deepEqual(names("     Running unittests src/lib.rs (target/debug/deps/m-1a2b)\ntest tests::adds ... FAILED\ntest tests::ok ... ok\n"), ["src/lib.rs::tests::adds"]);
  assert.deepEqual(names("\x1b[31mFAILED t/test_r.py::red\x1b[0m\n"), ["t/test_r.py::red"]);
  assert.deepEqual(parseFailures("Error: boom\nnpm ERR! Test failed.\n"), { names: [], unqualified: [], crash: false });
  assert.deepEqual(parseFailures(undefined), { names: [], unqualified: [], crash: false });
  assert.ok(isTestFile("tests/value_test.sh") && isTestFile("src/a.test.ts") && isTestFile("pkg/test_x.py") && isTestFile("x_test.go"));
  assert.ok(!isTestFile("src/app.ts") && !isTestFile("latest/notes.js"));
});

test("parseFailures: unqualified names and suite-level crashes are flagged, so they never count as already failing", () => {
  const bareTap = parseFailures("not ok 1 - a\n");
  assert.deepEqual([bareTap.names, bareTap.unqualified, complete(bareTap)], [[], ["a"], false]);
  const goNoPkg = parseFailures("--- FAIL: TestX (0.00s)\n");
  assert.deepEqual([goNoPkg.unqualified, complete(goNoPkg)], [["TestX"], false]);
  assert.equal(complete(parseFailures("  ● Math › adds\n")), false, "jest name without its FAIL header");
  assert.equal(complete(parseFailures("✖ a b (1ms)\n")), false, "spec reporter without the summary");
  for (const crash of [
    "FAIL src/a.test.js\n  ● Test suite failed to run\n",
    "ERROR tests/test_a.py\n!!! Interrupted: 1 error during collection !!!\n",
    "_____ ERROR collecting tests/test_a.py _____\nImportError while importing test module\n",
    "FAIL\texample.com/m [build failed]\n",
    "error: could not compile `m`\n",
    " FAIL  src/a.test.ts [ src/a.test.ts ]\n",
  ]) {
    assert.equal(parseFailures(crash).crash, true, crash);
    assert.equal(complete(parseFailures(`${FA}${crash}`)), false, crash);
  }
  assert.ok(inFiles("tests/v_test.sh::case", ["tests/v_test.sh"]) && inFiles("example.com/m/calc::TestX", ["calc/x_test.go"]));
  assert.ok(!inFiles("tests/other_test.sh::case", ["tests/v_test.sh"]) && !inFiles("case", ["tests/v_test.sh"]));
});

// ---- baseline ----

test("baseline inform (default): a test that already fails on HEAD still blocks, and the message names it", () => {
  const dir = repo({ "failures.txt": FA, "app.js": "export {};\n" });
  write(dir, { "app.js": "export const x = 1;\n" });
  const same = gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD } });
  assert.equal(same.status, 2);
  const rec = last(dir);
  assert.deepEqual([rec.decision, rec.reason, rec.failing, rec.on_base], ["block", "tests_failed", 1, 1]);
  assert.match(same.stderr, /Acceptance gate failed/);
  assert.match(same.stderr, /also fail on the base [0-9a-f]{8} \(probably pre-existing; do not fix them unless your slice touches them; say so in your report\):\n {2}- tests\/test_a\.py::a\n/);
  assert.doesNotMatch(gateLog(dir), /FAILED|boom|test_a/, "no test output or names in gates.jsonl");

  // A new failure: still a block, and only the shared test is named.
  write(dir, { "failures.txt": FA + FB });
  const added = gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD }, id: "a2" });
  assert.equal(added.status, 2);
  assert.deepEqual([last(dir).reason, last(dir).failing, last(dir).on_base], ["tests_failed", 2, 1]);
  assert.doesNotMatch(added.stderr, /- tests\/test_b\.py::b/);

  // Nothing shared: counts only, no note.
  write(dir, { "failures.txt": FB });
  const none = gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD }, id: "a3" });
  assert.equal(none.status, 2);
  assert.equal(last(dir).on_base, 0);
  assert.doesNotMatch(none.stderr, /probably pre-existing/);
});

test("baseline allow (opt-in): a test that already fails on HEAD warns with counts; a new failing test still blocks", () => {
  const dir = repo({ "failures.txt": FA, "app.js": "export {};\n" });
  write(dir, { "app.js": "export const x = 1;\n" });
  const same = gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD, ...ALLOW } });
  assert.equal(same.status, 0, same.stderr);
  const rec = last(dir);
  assert.deepEqual([rec.decision, rec.reason, rec.failing, rec.base_failing], ["warn", "tests_failed_baseline", 1, 1]);
  assert.doesNotMatch(gateLog(dir), /FAILED|boom/, "no test output in gates.jsonl");

  write(dir, { "failures.txt": FA + FB });
  const added = gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD, ...ALLOW }, id: "a2" });
  assert.equal(added.status, 2);
  assert.equal(last(dir).reason, "tests_failed");
  assert.match(added.stderr, /probably pre-existing/);
});

test("baseline allow: runner-level failures without a named test never count as already failing", () => {
  // Each pair: the base fails test a; the working tree fails test a plus a failure that names no test.
  const crashes = {
    "go init panic": "panic: boom in init\nFAIL\texample.com/m/other\t0.01s\n",
    "vitest unhandled errors": "⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯\nVitest caught 1 unhandled error during the test run.\n",
    "cargo binary killed": "error: test failed, to rerun pass `--lib`\nCaused by:\n  process didn't exit successfully: `target/debug/deps/m-1a2b` (signal: 11, SIGSEGV: invalid memory reference)\n",
    "jest coverage threshold": 'Jest: "global" coverage threshold for lines (80%) not met: 70%\n',
  };
  for (const [name, extra] of Object.entries(crashes)) {
    assert.equal(parseFailures(extra).crash, true, name);
    const dir = repo({ "failures.txt": FA, "app.js": "x\n" });
    write(dir, { "failures.txt": FA + extra, "app.js": "y\n" });
    assert.equal(gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD, ...ALLOW } }).status, 2, name);
    assert.equal(last(dir).reason, "tests_failed", name);
  }
  // go: a package line with no pending named test is a crash; with one, it qualifies the name.
  assert.equal(parseFailures("FAIL\texample.com/m\t0.01s\n").crash, true);
  assert.equal(parseFailures("FAIL\texample.com/m [setup failed]\n").crash, true);
  assert.equal(complete(parseFailures("--- FAIL: TestX (0.00s)\nFAIL\nFAIL\texample.com/m\t0.01s\n")), true);
});

test("baseline: a clean shared tree and output without test names never take the baseline path", () => {
  const clean = repo({ "failures.txt": FA });
  assert.equal(gate(clean, { env: { ORCH_TEST_CMD: TAP_CMD } }).status, 2);
  assert.equal(last(clean).reason, "tests_failed");
  assert.ok(!existsSync(cacheFile(clean)), "no base run for a clean tree");

  // The existing hooks.test.ts shape: a committed `exit 1` test script.
  const npm = repo({ "package.json": JSON.stringify({ scripts: { test: "exit 1" } }), "app.js": "export {};\n" });
  assert.equal(gate(npm).status, 2);
  assert.equal(last(npm).reason, "tests_failed");

  const unnamed = repo({ "app.js": "export {};\n" });
  write(unnamed, { "app.js": "export const x = 1;\n" });
  assert.equal(gate(unnamed, { env: { ORCH_TEST_CMD: "echo boom; exit 1" } }).status, 2);
  assert.equal(last(unnamed).reason, "tests_failed");
  assert.ok(!existsSync(cacheFile(unnamed)), "no base run without parsable names");
});

test("baseline: an isolated worktree compares against its fork point, not the main worktree's later HEAD", () => {
  const dir = repo({ "failures.txt": FA, "app.js": "export {};\n" });
  const wt = join(dir, ".claude", "worktrees", "s1");
  git(dir, "worktree", "add", "-q", "-b", "slice", wt);
  // Main moves on and fixes test a; the slice forked before that.
  write(dir, { "failures.txt": "" });
  git(dir, "commit", "-q", "-am", "fix a on main");
  write(wt, { "app.js": "export const x = 1;\n" });
  git(wt, "commit", "-q", "-am", "slice work");
  const r = gate(dir, { cwd: wt, env: { ORCH_TEST_CMD: TAP_CMD, ORCH_GATE_ISOLATED: "block", ...ALLOW } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(last(dir).reason, "tests_failed_baseline");
  const forkPoint = git(dir, "rev-parse", "HEAD~1").trim();
  assert.ok(Object.keys(JSON.parse(readFileSync(cacheFile(dir), "utf8"))).some((k) => k.startsWith(forkPoint)), "cached under the fork point");
  assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD").trim(), "slice", "the slice stays on its branch");
});

test("baseline: the base result is cached per base commit and command, and the base worktree is removed", () => {
  const dir = repo({ "failures.txt": FA, "app.js": "export {};\n" });
  const head = git(dir, "rev-parse", "HEAD").trim();
  write(dir, { "app.js": "export const x = 1;\n" });
  const first = gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD, ...ALLOW } });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(readdirSync(first.tmp).filter((f) => f.startsWith("orch-base-")), [], "temp dir cleaned");
  assert.equal(git(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1, "no base worktree left");
  assert.equal(git(dir, "status", "--porcelain").trim(), "M app.js", "the tree is untouched");
  assert.equal(git(dir, "rev-parse", "HEAD").trim(), head, "nothing committed");

  // Rewrite the cached entry: a failure only the cache knows about is then treated as already failing on the base.
  const cache = JSON.parse(readFileSync(cacheFile(dir), "utf8"));
  const keys = Object.keys(cache);
  assert.equal(keys.length, 1);
  assert.ok(keys[0]?.startsWith(head));
  cache[keys[0] ?? ""] = { rc: 1, names: ["tests/test_a.py::a", "tests/test_b.py::b"] };
  writeFileSync(cacheFile(dir), JSON.stringify(cache));
  write(dir, { "failures.txt": FA + FB });
  const cached = gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD, ...ALLOW }, id: "a2" });
  assert.equal(cached.status, 0, cached.stderr);
  assert.equal(last(dir).reason, "tests_failed_baseline");

  // Another command is another cache entry (and runs the base again).
  gate(dir, { env: { ORCH_TEST_CMD: `${TAP_CMD} # other` }, id: "a3" });
  assert.equal(last(dir).reason, "tests_failed");
  assert.equal(Object.keys(JSON.parse(readFileSync(cacheFile(dir), "utf8"))).length, 2);
});

test("baseline: ORCH_BASELINE=off gates as 0.3.0", () => {
  const dir = repo({ "failures.txt": FA, "app.js": "export {};\n" });
  write(dir, { "app.js": "export const x = 1;\n" });
  assert.equal(gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD, ORCH_BASELINE: "off" } }).status, 2);
  assert.equal(last(dir).reason, "tests_failed");
  assert.ok(!existsSync(cacheFile(dir)));
});

test("baseline: suite crashes in different files and same-named tests in different files are new failures", () => {
  const crash = repo({ "failures.txt": "FAIL src/a.test.js\n  ● Test suite failed to run\n", "app.js": "x\n" });
  write(crash, { "failures.txt": "FAIL src/b.test.js\n  ● Test suite failed to run\n", "app.js": "y\n" });
  assert.equal(gate(crash, { env: { ORCH_TEST_CMD: TAP_CMD, ...ALLOW } }).status, 2);
  assert.equal(last(crash).reason, "tests_failed");

  const same = repo({ "failures.txt": "FAIL src/a.test.js\n  ● math › adds\n", "app.js": "x\n" });
  write(same, { "failures.txt": "FAIL src/b.test.js\n  ● math › adds\n", "app.js": "y\n" });
  assert.equal(gate(same, { env: { ORCH_TEST_CMD: TAP_CMD, ...ALLOW } }).status, 2);
  assert.equal(last(same).reason, "tests_failed");
  // The same test in the same file is already failing on the base.
  write(same, { "failures.txt": "FAIL src/a.test.js\n  ● math › adds\n" });
  assert.equal(gate(same, { env: { ORCH_TEST_CMD: TAP_CMD, ...ALLOW }, id: "a2" }).status, 0);
  assert.equal(last(same).reason, "tests_failed_baseline");
});

// The base worktree lacks the git-ignored env.ok: there the command fails without names, or hangs.
const ENV_CMD = `test -f env.ok || { echo "environment missing"; exit 1; }; ${TAP_CMD}`;
const SLOW_CMD = `test -f env.ok || exec sleep 5; ${TAP_CMD}`;

test("baseline: a base run that fails without names or times out is no baseline and is not cached", () => {
  const dir = repo({ ".gitignore": "env.ok\n", "failures.txt": FA, "app.js": "x\n" });
  write(dir, { "env.ok": "", "app.js": "y\n" });
  assert.equal(gate(dir, { env: { ORCH_TEST_CMD: ENV_CMD, ...ALLOW } }).status, 2);
  assert.equal(last(dir).reason, "tests_failed");
  assert.ok(!existsSync(cacheFile(dir)), "an environment failure is never cached");

  const t0 = Date.now();
  const slow = gate(dir, { env: { ORCH_TEST_CMD: SLOW_CMD, ORCH_BASE_TIMEOUT_S: "1", ...ALLOW }, id: "a2" });
  assert.equal(slow.status, 2);
  assert.equal(last(dir).reason, "tests_failed");
  assert.ok(Date.now() - t0 < 4500, `the base run was cut off at the timeout (${Date.now() - t0} ms)`);
  assert.ok(!existsSync(cacheFile(dir)));
  assert.deepEqual(readdirSync(slow.tmp).filter((f) => f.startsWith("orch-base-")), []);
  assert.equal(git(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
});

test("baseline: a base run prunes worktrees left by killed runs older than an hour", () => {
  const dir = repo({ "failures.txt": FA, "app.js": "x\n" });
  write(dir, { "app.js": "y\n" });
  const tmp = mkdtempSync(join(tmpdir(), "orch-tg2-tmp-"));
  for (const d of ["orch-base-old", "orch-base-new"]) mkdirSync(join(tmp, d));
  git(dir, "worktree", "add", "-q", "--detach", join(tmp, "orch-base-old", "wt"));
  const hourAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(join(tmp, "orch-base-old"), hourAgo, hourAgo);
  assert.equal(gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD, ...ALLOW }, tmp }).status, 0);
  assert.deepEqual(readdirSync(tmp).filter((f) => f.startsWith("orch-base-")), ["orch-base-new"], "only the stale one is removed");
  assert.equal(git(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1, "its worktree record is pruned");
});

test("baseline: on timeout the base run's whole process group is killed", () => {
  const pidDir = mkdtempSync(join(tmpdir(), "orch-tg2-pid-"));
  const pidFile = join(pidDir, "pid");
  // In the base (no env.ok) a background grandchild holds the pipes; killing only bash would leave it running.
  const cmd = `test -f env.ok || { sleep 30 & echo $! > '${pidFile}'; wait; }; ${TAP_CMD}`;
  const dir = repo({ ".gitignore": "env.ok\n", "failures.txt": FA, "app.js": "x\n" });
  write(dir, { "env.ok": "", "app.js": "y\n" });
  const t0 = Date.now();
  const r = gate(dir, { env: { ORCH_TEST_CMD: cmd, ORCH_BASE_TIMEOUT_S: "1", ...ALLOW } });
  assert.equal(r.status, 2);
  assert.equal(last(dir).reason, "tests_failed");
  assert.ok(Date.now() - t0 < 4500, `cut off at the timeout (${Date.now() - t0} ms)`);
  const pid = readFileSync(pidFile, "utf8").trim();
  const ps = spawnSync("ps", ["-o", "stat=", "-p", pid], { encoding: "utf8" });
  assert.ok(ps.stdout.trim() === "" || ps.stdout.trim().startsWith("Z"), `the grandchild ${pid} is gone (ps: ${ps.stdout.trim()})`);
  assert.deepEqual(readdirSync(r.tmp).filter((f) => f.startsWith("orch-base-")), []);
});

test("baseline: the cache key includes the run subdirectory", () => {
  assert.notEqual(cacheKey("abc", "npm test", ""), cacheKey("abc", "npm test", "pkg"));
  assert.equal(cacheKey("abc", "npm test"), cacheKey("abc", "npm test", ""));
  const dir = repo({ "failures.txt": FA, "pkg/failures.txt": FB, "app.js": "x\n" });
  write(dir, { "app.js": "y\n" });
  assert.equal(gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD, ...ALLOW } }).status, 0);
  // From pkg/ the base fails test b, not the root's test a: a key without the folder would reuse the root's result.
  const sub = gate(dir, { cwd: join(dir, "pkg"), env: { ORCH_TEST_CMD: TAP_CMD, ...ALLOW }, id: "a2" });
  assert.equal(sub.status, 0, sub.stderr);
  assert.equal(last(dir).reason, "tests_failed_baseline");
  assert.equal(Object.keys(JSON.parse(readFileSync(cacheFile(dir), "utf8"))).length, 2);
});

test("baseline: node_modules comes from the main worktree, and a lock file that differs from the base skips the base run", () => {
  const dir = repo({ ".gitignore": "node_modules/\n", "package-lock.json": "{}\n", "failures.txt": FA, "app.js": "x\n" });
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  // The base worktree has no node_modules of its own: the check passes there only through the symlink to the main's.
  const nmCmd = `test -d node_modules/dep || { echo "no deps"; exit 1; }; ${TAP_CMD}`;
  write(dir, { "app.js": "y\n" });
  assert.equal(gate(dir, { env: { ORCH_TEST_CMD: nmCmd, ...ALLOW } }).status, 0);
  assert.equal(last(dir).reason, "tests_failed_baseline");

  const changed = repo({ ".gitignore": "node_modules/\n", "package-lock.json": "{}\n", "failures.txt": FA, "app.js": "x\n" });
  mkdirSync(join(changed, "node_modules"));
  write(changed, { "package-lock.json": '{"lockfileVersion":3}\n' });
  const r = gate(changed, { env: { ORCH_TEST_CMD: TAP_CMD, ...ALLOW } });
  assert.equal(r.status, 2, "the base would run against other dependencies: no base run");
  assert.equal(last(changed).reason, "tests_failed");
  assert.ok(!existsSync(cacheFile(changed)));
});

// ---- KIND: bugfix ----

// Runs every tests/*_test.sh and reports each failure as "FAILED <file>::case"; env.ok (git-ignored, present only in
// the working tree) stands for the environment a base worktree may lack.
const RUN = 'if [ -e need-env ] && [ ! -e env.ok ]; then echo "environment missing"; exit 1; fi\nrc=0\nfor f in tests/*_test.sh; do [ -e "$f" ] || continue; bash "$f" || { echo "FAILED $f::case - no"; rc=1; }; done\nexit $rc\n';
const BUG_CMD = "bash run.sh";
/**
 * A repo with a bug (VALUE=1, should be 2) and a transcript whose brief has `kind`.
 * @param {string | null} [kind] @param {Record<string, string>} [extra] more committed files
 */
function bugRepo(kind = "bugfix", extra = {}) {
  const dir = repo({ "app.sh": "VALUE=1\n", "run.sh": RUN, "tests/ok_test.sh": "true\n", ...extra });
  const transcript = join(mkdtempSync(join(tmpdir(), "orch-tg2-tr-")), "agent.jsonl");
  const brief = `SLICE: fix\nFILES: app.sh\nDEPENDS: none\n${kind ? `KIND: ${kind}\n` : ""}Fix VALUE.`;
  writeFileSync(transcript, [JSON.stringify({ type: "user", message: { content: brief } }), JSON.stringify({ type: "assistant", message: { content: [] } })].join("\n") + "\n");
  return { dir, transcript };
}
const REPRO = '. ./app.sh; [ "$VALUE" = 2 ]\n';

test("bugfix: a new test that fails on the base and passes now is verified", () => {
  const { dir, transcript } = bugRepo();
  write(dir, { "app.sh": "VALUE=2\n", "tests/value_test.sh": REPRO });
  const r = gate(dir, { transcript, env: { ORCH_TEST_CMD: BUG_CMD } });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([last(dir).decision, last(dir).reason, last(dir).test_files], ["allow", "bugfix_verified", 1]);
  assert.deepEqual(readdirSync(r.tmp).filter((f) => f.startsWith("orch-base-")), []);
  assert.equal(git(dir, "worktree", "list", "--porcelain").match(/^worktree /gm)?.length, 1);
});

test("bugfix: blocks without a test change, blocks when the test also passes on the base, gives up after two blocks", () => {
  const { dir, transcript } = bugRepo();
  write(dir, { "app.sh": "VALUE=2\n" });
  const none = gate(dir, { transcript, env: { ORCH_TEST_CMD: BUG_CMD } });
  assert.equal(none.status, 2);
  assert.equal(last(dir).reason, "bugfix_no_test");
  assert.match(none.stderr, /no test file is changed or added/);

  write(dir, { "tests/other_test.sh": "true\n" });
  const passes = gate(dir, { transcript, env: { ORCH_TEST_CMD: BUG_CMD } });
  assert.equal(passes.status, 2);
  assert.equal(last(dir).reason, "bugfix_test_passes_on_base");
  assert.match(passes.stderr, /tests\/other_test\.sh.*add no failing test on/);

  const third = gate(dir, { transcript, env: { ORCH_TEST_CMD: BUG_CMD } });
  assert.equal(third.status, 0, "two blocks for this agent: the third stop is let through");
  assert.deepEqual([last(dir).decision, last(dir).reason], ["allow", "bugfix_unverified_gave_up"]);
  assert.equal(gate(dir, { transcript, env: { ORCH_TEST_CMD: BUG_CMD }, id: "other" }).status, 2, "the count is per agent");
});

test("bugfix: ORCH_BUGFIX_CHECK=off, a brief without KIND: bugfix, and the launch record fallback", () => {
  const { dir, transcript } = bugRepo();
  write(dir, { "app.sh": "VALUE=2\n" });
  assert.equal(gate(dir, { transcript, env: { ORCH_TEST_CMD: BUG_CMD, ORCH_BUGFIX_CHECK: "off" } }).status, 0);
  assert.equal(last(dir).reason, "tests_passed");

  const plain = bugRepo(null);
  write(plain.dir, { "app.sh": "VALUE=2\n" });
  assert.equal(gate(plain.dir, { transcript: plain.transcript, env: { ORCH_TEST_CMD: BUG_CMD } }).status, 0);
  assert.equal(last(plain.dir).reason, "tests_passed");
  // The transcript's own brief decides, not another agent's launch record.
  write(plain.dir, { ".claude/state/journal-launches.jsonl": JSON.stringify({ agent_id: "a1", agent_type: "implementer", kind: "bugfix" }) + "\n" });
  assert.equal(gate(plain.dir, { transcript: plain.transcript, env: { ORCH_TEST_CMD: BUG_CMD }, id: "a1" }).status, 0);

  // No transcript (headless): KIND comes from the launch record with the same agent_id.
  const headless = bugRepo(null);
  write(headless.dir, { "app.sh": "VALUE=2\n", ".claude/state/.gitignore": "*\n", ".claude/state/journal-launches.jsonl": JSON.stringify({ agent_id: "h1", agent_type: "implementer", kind: "bugfix" }) + "\n" });
  assert.equal(gate(headless.dir, { env: { ORCH_TEST_CMD: BUG_CMD }, id: "h1" }).status, 2);
  assert.equal(last(headless.dir).reason, "bugfix_no_test");
  assert.equal(gate(headless.dir, { env: { ORCH_TEST_CMD: BUG_CMD }, id: "h2" }).status, 0, "another agent's launch is not read");
});

test("bugfix: unrelated failures on the base do not verify a test that passes there; a real reproduction still does", () => {
  const { dir, transcript } = bugRepo("bugfix", { "tests/broken_test.sh": REPRO });
  write(dir, { "app.sh": "VALUE=2\n", "tests/other_test.sh": "true\n" });
  const r = gate(dir, { transcript, env: { ORCH_TEST_CMD: BUG_CMD } });
  assert.equal(r.status, 2, "the base fails, but only the way it already did without the copied test");
  assert.equal(last(dir).reason, "bugfix_test_passes_on_base");

  write(dir, { "tests/value_test.sh": REPRO });
  const ok = gate(dir, { transcript, env: { ORCH_TEST_CMD: BUG_CMD }, id: "a2" });
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual([last(dir).reason, last(dir).new_failing], ["bugfix_verified", 1]);
});

test("bugfix: an environment failure on the base blocks as unverified and is not cached", () => {
  const { dir, transcript } = bugRepo("bugfix", { "need-env": "", ".gitignore": "env.ok\n" });
  write(dir, { "env.ok": "", "app.sh": "VALUE=2\n", "tests/value_test.sh": REPRO });
  const r = gate(dir, { transcript, env: { ORCH_TEST_CMD: BUG_CMD } });
  assert.equal(r.status, 2);
  assert.equal(last(dir).reason, "bugfix_base_unusable");
  assert.match(r.stderr, /unverified/);
  assert.ok(!existsSync(cacheFile(dir)));
});

test("bugfix blocks and test-failure blocks have separate caps", () => {
  const { dir, transcript } = bugRepo();
  write(dir, { "app.sh": "VALUE=2\n" });
  assert.equal(gate(dir, { transcript, env: { ORCH_TEST_CMD: BUG_CMD } }).status, 2);
  assert.equal(gate(dir, { transcript, env: { ORCH_TEST_CMD: BUG_CMD } }).status, 2);
  assert.equal(last(dir).reason, "bugfix_no_test");
  const failing = gate(dir, { transcript, env: { ORCH_TEST_CMD: "exit 1" } });
  assert.equal(failing.status, 2, "two bugfix blocks do not use up the tests_failed cap");
  assert.equal(last(dir).reason, "tests_failed");
  gate(dir, { transcript, env: { ORCH_TEST_CMD: "exit 1" } });
  assert.equal(gate(dir, { transcript, env: { ORCH_TEST_CMD: "exit 1" } }).status, 0);
  assert.equal(last(dir).reason, "max_blocks_reached");
});

test("bugfix and baseline: malformed hook input exits 0", () => {
  const dir = repo({ "app.js": "x\n" });
  for (const input of ["not json{", "", "[]"]) {
    const r = spawnSync("bash", [hook("verify.sh")], { input, env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: dir, ORCH_TEST_CMD: "exit 0" }, encoding: "utf8" });
    assert.equal(r.status, 0, input);
  }
  for (const mode of ["baseline", "bugfix", "nonsense"]) {
    const r = spawnSync("node", [hook("bugfix-check.mjs"), mode, "--cmd", "exit 1", "--state", join(dir, ".claude", "state")], { cwd: dir, input: "{not json", encoding: "utf8" });
    assert.equal(r.status, 0, mode);
    assert.equal(r.stdout, "", mode);
  }
});

// ---- userConfig bridge ----

test("state.mjs bridges CLAUDE_PLUGIN_OPTION_<KEY> to an unset ORCH_<KEY>, at import and for the fixed keys", () => {
  /** @type {NodeJS.ProcessEnv} */
  const env = { CLAUDE_PLUGIN_OPTION_BASELINE: "off", CLAUDE_PLUGIN_OPTION_GAP_MIN: "", CLAUDE_PLUGIN_OPTION_JUDGE: "native", ORCH_JUDGE: "off", CLAUDE_PLUGIN_OPTION_GUARDS: "x", ORCH_GUARDS: "", CLAUDE_PLUGIN_OPTION_OTHER: "y" };
  bridgeOptions(env);
  assert.equal(env.ORCH_BASELINE, "off");
  assert.equal(env.ORCH_GAP_MIN, undefined, "an empty option is ignored");
  assert.equal(env.ORCH_JUDGE, "off", "an explicit ORCH_ value wins");
  assert.equal(env.ORCH_GUARDS, "", "an explicit empty ORCH_ value wins too");
  assert.equal(env.ORCH_OTHER, undefined, "only the fixed key list");

  const script = `import(${JSON.stringify(hook("state.mjs"))}).then(() => console.log(JSON.stringify([process.env.ORCH_BUGFIX_CHECK, process.env.ORCH_TEST_CMD, process.env.ORCH_RUN_STALE_MIN])))`;
  const r = spawnSync("node", ["-e", script], {
    env: { ...cleanEnv(), CLAUDE_PLUGIN_OPTION_BUGFIX_CHECK: "off", CLAUDE_PLUGIN_OPTION_TEST_CMD: "make t", ORCH_TEST_CMD: "npm t", CLAUDE_PLUGIN_OPTION_RUN_STALE_MIN: "45" },
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), ["off", "npm t", "45"]);
});

test("verify.sh bridges the options before reading any setting; an explicit ORCH_ value wins", () => {
  const outside = mkdtempSync(join(tmpdir(), "orch-tg2-nogit-"));
  assert.equal(gate(outside, { env: { CLAUDE_PLUGIN_OPTION_TEST_CMD: "exit 0" } }).status, 0);
  assert.equal(last(outside).reason, "tests_passed", "the option supplied the test command");
  assert.equal(gate(outside, { env: { CLAUDE_PLUGIN_OPTION_TEST_CMD: "exit 0", ORCH_TEST_CMD: "exit 1" } }).status, 2);
  assert.equal(last(outside).reason, "tests_failed");

  const dir = repo({ "failures.txt": FA, "app.js": "export {};\n" });
  write(dir, { "app.js": "export const x = 1;\n" });
  assert.equal(gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD, CLAUDE_PLUGIN_OPTION_BASELINE: "off" } }).status, 2);
  assert.equal(last(dir).reason, "tests_failed");
  assert.equal(gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD, CLAUDE_PLUGIN_OPTION_BASELINE: "off", ORCH_BASELINE: "allow" }, id: "a2" }).status, 0);
  assert.equal(last(dir).reason, "tests_failed_baseline");

  const wt = mkdtempSync(join(tmpdir(), "orch-tg2-iso-"));
  const cwd = join(wt, ".claude", "worktrees", "x");
  mkdirSync(cwd, { recursive: true });
  assert.equal(gate(wt, { cwd, env: { ORCH_TEST_CMD: "exit 1", CLAUDE_PLUGIN_OPTION_GATE_ISOLATED: "skip" } }).status, 0);
  assert.equal(last(wt).reason, "isolated_skipped");
});
