// Test gate 0.4.0: the test baseline, the KIND: bugfix check (both in .claude/hooks/bugfix-check.mjs, called by
// verify.sh) and the plugin userConfig bridge (state.mjs and verify.sh). Real temporary git repos, as in hooks.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isTestFile, parseFailures } from "../.claude/hooks/bugfix-check.mjs";
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

// A fake runner: prints failures.txt as TAP and fails when it is not empty.
const TAP_CMD = "cat failures.txt; ! test -s failures.txt";

/**
 * verify.sh as the SubagentStop hook runs it. TMPDIR is a fresh dir per call so base worktrees can be checked.
 * @param {string} project @param {{ cwd?: string, env?: Record<string, string>, id?: string, transcript?: string }} [o]
 */
function gate(project, o = {}) {
  const tmp = mkdtempSync(join(tmpdir(), "orch-tg2-tmp-"));
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

test("parseFailures: names from node --test (TAP and spec), jest, vitest, pytest, go and cargo", () => {
  assert.deepEqual(parseFailures("TAP version 13\nok 1 - fine\nnot ok 2 - adds numbers\n  not ok 1 - nested case\nnot ok 3 - later # TODO\n"), ["adds numbers", "nested case"]);
  assert.deepEqual(parseFailures("✔ ok (0.1ms)\n✖ a b (0.47ms)\n✖ failing tests:\n✖ a b (0.47ms)\n"), ["a b"]);
  assert.deepEqual(parseFailures("  ● Math › adds\n    ✕ adds (5 ms)\n"), ["Math › adds", "adds"]);
  assert.deepEqual(parseFailures(" FAIL  src/x.test.ts > suite > case\n × case 3ms\n"), ["case", "src/x.test.ts > suite > case"]);
  assert.deepEqual(parseFailures("FAILED tests/test_x.py::test_a - AssertionError: no\nERROR tests/test_y.py::test_b\n"), ["tests/test_x.py::test_a", "tests/test_y.py::test_b"]);
  assert.deepEqual(parseFailures("--- FAIL: TestAdd (0.00s)\n    --- FAIL: TestAdd/sub (0.00s)\n"), ["TestAdd", "TestAdd/sub"]);
  assert.deepEqual(parseFailures("test tests::adds ... FAILED\ntest tests::ok ... ok\n"), ["tests::adds"]);
  assert.deepEqual(parseFailures("\x1b[31mnot ok 1 - red\x1b[0m\n"), ["red"]);
  assert.deepEqual(parseFailures("Error: boom\nnpm ERR! Test failed.\n"), []);
  assert.deepEqual(parseFailures(undefined), []);
  assert.ok(isTestFile("tests/value_test.sh") && isTestFile("src/a.test.ts") && isTestFile("pkg/test_x.py") && isTestFile("x_test.go"));
  assert.ok(!isTestFile("src/app.ts") && !isTestFile("latest/notes.js"));
});

// ---- baseline ----

test("baseline: a test that already fails on HEAD warns with counts; a new failing test still blocks", () => {
  const dir = repo({ "failures.txt": "not ok 1 - a\n", "app.js": "export {};\n" });
  write(dir, { "app.js": "export const x = 1;\n" });
  const same = gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD } });
  assert.equal(same.status, 0, same.stderr);
  const rec = last(dir);
  assert.deepEqual([rec.decision, rec.reason, rec.failing, rec.base_failing], ["warn", "tests_failed_baseline", 1, 1]);
  assert.doesNotMatch(gateLog(dir), /not ok/, "no test output in gates.jsonl");

  write(dir, { "failures.txt": "not ok 1 - a\nnot ok 2 - b\n" });
  const added = gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD }, id: "a2" });
  assert.equal(added.status, 2);
  assert.equal(last(dir).reason, "tests_failed");
  assert.match(added.stderr, /Acceptance gate failed/);
});

test("baseline: a clean shared tree and output without test names never take the baseline path", () => {
  const clean = repo({ "failures.txt": "not ok 1 - a\n" });
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
  const dir = repo({ "failures.txt": "not ok 1 - a\n", "app.js": "export {};\n" });
  const wt = join(dir, ".claude", "worktrees", "s1");
  git(dir, "worktree", "add", "-q", "-b", "slice", wt);
  // Main moves on and fixes test a; the slice forked before that.
  write(dir, { "failures.txt": "" });
  git(dir, "commit", "-q", "-am", "fix a on main");
  write(wt, { "app.js": "export const x = 1;\n" });
  git(wt, "commit", "-q", "-am", "slice work");
  const r = gate(dir, { cwd: wt, env: { ORCH_TEST_CMD: TAP_CMD, ORCH_GATE_ISOLATED: "block" } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(last(dir).reason, "tests_failed_baseline");
  const forkPoint = git(dir, "rev-parse", "HEAD~1").trim();
  assert.ok(Object.keys(JSON.parse(readFileSync(cacheFile(dir), "utf8"))).some((k) => k.startsWith(forkPoint)), "cached under the fork point");
  assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD").trim(), "slice", "the slice stays on its branch");
});

test("baseline: the base result is cached per base commit and command, and the base worktree is removed", () => {
  const dir = repo({ "failures.txt": "not ok 1 - a\n", "app.js": "export {};\n" });
  const head = git(dir, "rev-parse", "HEAD").trim();
  write(dir, { "app.js": "export const x = 1;\n" });
  const first = gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD } });
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
  cache[keys[0] ?? ""] = { rc: 1, names: ["a", "b"] };
  writeFileSync(cacheFile(dir), JSON.stringify(cache));
  write(dir, { "failures.txt": "not ok 1 - a\nnot ok 2 - b\n" });
  const cached = gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD }, id: "a2" });
  assert.equal(cached.status, 0, cached.stderr);
  assert.equal(last(dir).reason, "tests_failed_baseline");

  // Another command is another cache entry (and runs the base again).
  gate(dir, { env: { ORCH_TEST_CMD: `${TAP_CMD} # other` }, id: "a3" });
  assert.equal(last(dir).reason, "tests_failed");
  assert.equal(Object.keys(JSON.parse(readFileSync(cacheFile(dir), "utf8"))).length, 2);
});

test("baseline: ORCH_BASELINE=off gates as 0.3.0", () => {
  const dir = repo({ "failures.txt": "not ok 1 - a\n", "app.js": "export {};\n" });
  write(dir, { "app.js": "export const x = 1;\n" });
  assert.equal(gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD, ORCH_BASELINE: "off" } }).status, 2);
  assert.equal(last(dir).reason, "tests_failed");
  assert.ok(!existsSync(cacheFile(dir)));
});

// ---- KIND: bugfix ----

const RUN = 'for f in tests/*_test.sh; do [ -e "$f" ] || continue; bash "$f" || { echo "FAILED $f::case - no"; exit 1; }; done\n';
const BUG_CMD = "bash run.sh";
/** A repo with a bug (VALUE=1, should be 2) and a transcript whose brief has `kind`. @param {string | null} [kind] */
function bugRepo(kind = "bugfix") {
  const dir = repo({ "app.sh": "VALUE=1\n", "run.sh": RUN, "tests/ok_test.sh": "true\n" });
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
  assert.match(passes.stderr, /tests\/other_test\.sh.*also pass on/);

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

  const dir = repo({ "failures.txt": "not ok 1 - a\n", "app.js": "export {};\n" });
  write(dir, { "app.js": "export const x = 1;\n" });
  assert.equal(gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD, CLAUDE_PLUGIN_OPTION_BASELINE: "off" } }).status, 2);
  assert.equal(last(dir).reason, "tests_failed");
  assert.equal(gate(dir, { env: { ORCH_TEST_CMD: TAP_CMD, CLAUDE_PLUGIN_OPTION_BASELINE: "off", ORCH_BASELINE: "on" }, id: "a2" }).status, 0);
  assert.equal(last(dir).reason, "tests_failed_baseline");

  const wt = mkdtempSync(join(tmpdir(), "orch-tg2-iso-"));
  const cwd = join(wt, ".claude", "worktrees", "x");
  mkdirSync(cwd, { recursive: true });
  assert.equal(gate(wt, { cwd, env: { ORCH_TEST_CMD: "exit 1", CLAUDE_PLUGIN_OPTION_GATE_ISOLATED: "skip" } }).status, 0);
  assert.equal(last(wt).reason, "isolated_skipped");
});
