// What a failed test run's gate records say (2.0.0): failed_count, failed_tests (bounded), failed_crash and output,
// the file under <state>/test-output that keeps the tail of the run's output (bugfix-check.mjs failureFields,
// keepOutput, failureExtra; verify.sh note_failures), and the test-only guard argument of verify.sh (--recent-ms).
// verify.sh runs as the hook runs it, in real temporary git repos, as in test-gate-v2.test.mjs.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KEEP_OUTPUTS, MAX_NAME_CHARS, MAX_NAMES, MAX_OUTPUT_BYTES, OUTPUT_DIR, cleanFailureExtra, failureExtra, failureFields, keepOutput } from "../.claude/hooks/bugfix-check.mjs";
import { RECENT_MS, listTrees, scanRoots, storeVerdict } from "../.claude/hooks/test-gate-cache.mjs";

const verifySh = new URL("../.claude/hooks/verify.sh", import.meta.url).pathname;
const SWITCH = /ORCH_|CLAUDE_PLUGIN_OPTION/;

/** @returns {Record<string, string>} */
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      /** @returns {e is [string, string]} */ (e) => e[1] !== undefined && !/^(GIT_|ORCH_|CLAUDE_PLUGIN_OPTION_|CLAUDE_ASYNC_AGENT_STALL|NODE_TEST_CONTEXT$)/.test(e[0]),
    ),
  );

/** @param {string} dir @param {...string} args */
function git(dir, ...args) {
  const r = spawnSync("git", ["-c", "user.name=orch", "-c", "user.email=orch@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env: cleanEnv(), encoding: "utf8" });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
}

function repo() {
  const base = mkdtempSync(join(tmpdir(), "orch-tgr-"));
  const dir = join(base, "repo");
  mkdirSync(dir);
  git(dir, "init", "-q");
  writeFileSync(join(dir, "a.js"), "x\n");
  writeFileSync(join(dir, ".gitignore"), ".claude/\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  writeFileSync(join(dir, "a.js"), "y\n"); // a code change, so the tests run
  const tmp = join(base, "tmp");
  mkdirSync(tmp);
  return { base, dir, tmp };
}
const state = (/** @type {string} */ dir) => join(dir, ".claude", "state");
const records = (/** @type {string} */ dir) => readFileSync(join(state(dir), "gates.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

/**
 * @param {{ dir: string, tmp: string }} s @param {string} cmd
 * @param {{ handback?: boolean, toolUseId?: string, id?: string, env?: Record<string, string> }} [o]
 */
function gate(s, cmd, o = {}) {
  /** @type {Record<string, unknown>} */
  const event = { agent_type: "implementer", agent_id: o.id ?? "a1", session_id: "s1", cwd: s.dir };
  if (o.handback) Object.assign(event, { hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_use_id: o.toolUseId ?? "toolu_1", tool_input: { message: "STATUS: pass" } });
  else event.hook_event_name = "SubagentStop";
  const r = spawnSync("bash", [verifySh, ...(o.handback ? ["--handback"] : []), "--recent-ms=300"], {
    input: JSON.stringify(event),
    env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: s.dir, TMPDIR: s.tmp, ORCH_TEST_CMD: cmd, ORCH_BASELINE: "off", ORCH_BUGFIX_CHECK: "off", ...o.env },
    encoding: "utf8",
  });
  return { status: r.status, stderr: r.stderr };
}

// node --test's spec reporter (also what tsx --test prints): the summary names each failing test after its file.
const SPEC = [
  "✖ adds (1.2ms)",
  "ℹ tests 3",
  "ℹ fail 2",
  "✖ failing tests:",
  "",
  "test at src/add.test.mjs:3:1",
  "✖ adds (1.2ms)",
  "  AssertionError: 1 !== 2",
  "",
  "test at src/sub.test.mjs:9:1",
  "✖ subtracts (0.4ms)",
  "  AssertionError: 3 !== 4",
].join("\n");

test("a failed run's block names what failed, keeps the output's tail in the state folder, and the agent's message is unchanged", () => {
  const s = repo();
  try {
    const out = join(s.base, "out.txt");
    writeFileSync(out, `${Array.from({ length: 60 }, (_, i) => `line ${i}`).join("\n")}\n${SPEC}\n`);
    const cmd = `cat '${out}'; exit 1`;
    const r = gate(s, cmd);
    assert.equal(r.status, 2);
    // The message as before: the command, the last 40 lines of output, the closing line; no field and no switch.
    assert.match(r.stderr, /^Acceptance gate failed: cat /);
    assert.match(r.stderr, /Fix the root cause and rerun before finishing\.\n$/);
    assert.equal(r.stderr.split("\n").length, 1 + 40 + 1 + 1);
    assert.doesNotMatch(r.stderr, /failed_count|test-output|failed_tests/);
    assert.doesNotMatch(r.stderr, SWITCH);
    const rec = records(s.dir).at(-1);
    assert.deepEqual([rec.decision, rec.reason, rec.failed_count, rec.failed_tests], ["block", "tests_failed", 2, ["src/add.test.mjs::adds", "src/sub.test.mjs::subtracts"]]);
    assert.equal(rec.failed_crash, undefined);
    assert.match(rec.output, /^test-output\/\d{8}T\d{9}Z-a1-\d+\.txt$/);
    const kept = readFileSync(join(state(s.dir), rec.output), "utf8");
    assert.ok(kept.includes("line 0") && kept.includes("✖ subtracts"), "the whole output, when it fits");
    assert.deepEqual(readdirSync(join(state(s.dir), OUTPUT_DIR)).filter((f) => f.endsWith(".tmp")), [], "no temporary file left");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("each runner's failing tests are named; output with no readable name gives a count of 0 and no names", () => {
  /** @type {[string, string, string[], boolean?][]} */
  const cases = [
    ["node TAP", "not ok 1 - adds\n  ---\n  location: '/r/src/add.test.mjs:3:1'\n  ...\n", ["/r/src/add.test.mjs::adds"]],
    ["node spec / tsx", SPEC, ["src/add.test.mjs::adds", "src/sub.test.mjs::subtracts"]],
    ["pytest", "FAILED tests/test_a.py::test_one - assert 1 == 2\nFAILED tests/test_b.py::test_two\n", ["tests/test_a.py::test_one", "tests/test_b.py::test_two"]],
    ["unittest", "FAIL: test_add (test_calc.T.test_add)\n----\nFAILED (failures=1)\n", ["test_calc.py::T.test_add"]],
    ["cargo", "     Running tests/api.rs (target/debug/deps/api-1)\ntest api ... FAILED\n", ["tests/api.rs::api"]],
    ["cargo --quiet", "api --- FAILED\nerror: test failed, to rerun pass `--test api`\n", ["tests/api.rs::api"]],
    ["go", "--- FAIL: TestAdd (0.00s)\nFAIL\nFAIL\texample.com/calc\t0.01s\n", ["example.com/calc::TestAdd"]],
    ["jest", "FAIL src/add.test.js\n  ● adds › two numbers\n", ["src/add.test.js::adds › two numbers"]],
    ["vitest", " FAIL  src/add.test.ts > adds\n", ["src/add.test.ts::adds"]],
    ["no names", "Segmentation fault\nmake: *** [test] Error 139\n", []],
  ];
  for (const [runner, output, names] of cases) {
    const f = failureFields(output);
    assert.deepEqual([f.failed_count, f.failed_tests ?? []], [names.length, names], runner);
  }
  assert.deepEqual(failureFields("Test suite failed to run\n"), { failed_count: 0, failed_crash: 1 }, "a crash with no test named");
});

test("the names are bounded in number and length; the kept output in size", () => {
  const many = Array.from({ length: 25 }, (_, i) => `FAILED tests/test_x.py::t${String(i).padStart(2, "0")}`).join("\n");
  const f = failureFields(`${many}\nFAILED tests/test_y.py::${"n".repeat(500)}\n`);
  assert.equal(f.failed_count, 26);
  assert.equal(f.failed_tests?.length, MAX_NAMES);
  const long = failureFields(`FAILED tests/test_y.py::${"n".repeat(500)}\n`).failed_tests?.[0] ?? "";
  assert.equal(long.length, MAX_NAME_CHARS);
  assert.ok(long.endsWith("..."));
  const dir = mkdtempSync(join(tmpdir(), "orch-tgr-state-"));
  try {
    const big = `${"x".repeat(100)}\n`.repeat(2000) + "the end\n";
    const rel = keepOutput(dir, "a1-1", big);
    const kept = readFileSync(join(dir, rel), "utf8");
    assert.ok(Buffer.byteLength(kept) <= MAX_OUTPUT_BYTES);
    assert.ok(kept.endsWith("the end\n") && kept.startsWith("x"), "the tail, from a line start");
    // A record line stays one line of JSON members, whatever the names hold.
    const extra = failureExtra(dir, "a1-2", 'FAILED tests/t.py::q"uote\\back\n');
    assert.doesNotThrow(() => JSON.parse(`{${extra}}`));
    assert.equal(cleanFailureExtra(extra), extra, "read back unchanged");
    assert.equal(cleanFailureExtra('"failed_count":1,"evil":"x"'), '"failed_count":1', "unknown members dropped");
    assert.equal(cleanFailureExtra('"failed_count":1,"output":"../../etc/passwd"'), '"failed_count":1', "only a file of test-output");
    assert.equal(cleanFailureExtra("}{"), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only the newest KEEP_OUTPUTS files are kept, a stale temporary file is removed, a fresh one is not counted", () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-tgr-state-"));
  try {
    const t0 = Date.parse("2026-11-17T10:00:00.000Z");
    mkdirSync(join(dir, OUTPUT_DIR));
    // A crash between the write and the rename leaves only a hidden temporary file, never a half file under a kept name.
    const stale = join(dir, OUTPUT_DIR, ".20261117T095000000Z-a1-1.txt.99.tmp");
    writeFileSync(stale, "half");
    utimesSync(stale, new Date(t0 - 20 * 60000), new Date(t0 - 20 * 60000));
    const fresh = join(dir, OUTPUT_DIR, ".20261117T100000000Z-a1-2.txt.98.tmp");
    writeFileSync(fresh, "half");
    const names = [];
    for (let i = 0; i < KEEP_OUTPUTS + 4; i += 1) names.push(keepOutput(dir, `a1-${i}`, `run ${i}\n`, t0 + i * 1000));
    const left = readdirSync(join(dir, OUTPUT_DIR)).sort();
    assert.deepEqual(left.filter((f) => !f.startsWith(".")), names.slice(4).map((n) => n.slice(OUTPUT_DIR.length + 1)).sort());
    assert.equal(existsSync(stale), false, "a temporary file older than 10 minutes is removed");
    assert.equal(existsSync(fresh), true, "a fresh one may belong to a gate still writing");
    assert.ok(statSync(join(dir, names.at(-1) ?? "")).size > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the gate keeps at most KEEP_OUTPUTS output files over many failed runs, each named by its record", () => {
  const s = repo();
  try {
    for (let i = 0; i < KEEP_OUTPUTS + 2; i += 1) assert.equal(gate(s, `echo 'not ok 1 - r${i}'; exit 1`, { id: `a${i}` }).status, 2);
    const recs = records(s.dir);
    const files = readdirSync(join(state(s.dir), OUTPUT_DIR));
    assert.equal(files.length, KEEP_OUTPUTS);
    for (const r of recs.slice(-KEEP_OUTPUTS)) assert.ok(files.includes(String(r.output).slice(OUTPUT_DIR.length + 1)), r.output);
    assert.deepEqual(recs.map((r) => r.failed_tests?.[0]), Array.from({ length: KEEP_OUTPUTS + 2 }, (_, i) => `r${i}`), "unqualified TAP names are named too");
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("a passing run and pytest's no-tests-collected carry no failure fields", () => {
  const s = repo();
  try {
    assert.equal(gate(s, "true").status, 0);
    assert.equal(gate(s, "echo 'not ok 1 - x'; : python3 -m pytest -q; exit 5").status, 0);
    assert.deepEqual(records(s.dir).map((r) => r.reason), ["tests_passed", "no_tests_collected"]);
    for (const r of records(s.dir)) assert.deepEqual([r.failed_count, r.output], [undefined, undefined], r.reason);
    assert.equal(existsSync(join(state(s.dir), OUTPUT_DIR)), false);
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("the hand-back's block names what failed, and the stop that reuses its fail names the same tests and file", async () => {
  const s = repo();
  try {
    git(s.dir, "add", "-A");
    git(s.dir, "commit", "-q", "-m", "change");
    // The state folder is made BEFORE the wait: making it sets the mtime and ctime of .claude, which the listing watches
    // (only .claude/state itself is left out), so made after the wait it was the newest listed entry and the store
    // refused with recent_change whenever the hook reached its L0 listing within 300 ms (docs/data/probes-2.0.1-ci.md).
    mkdirSync(state(s.dir), { recursive: true });
    await new Promise((r) => setTimeout(r, 700)); // every listed entry older than the 300 ms guard of --recent-ms
    const cmd = "echo 'FAILED tests/test_a.py::test_one - boom'; exit 1";
    const settled = listTrees(scanRoots(s.dir) ?? []);
    assert.ok(settled.hash && Date.now() - settled.maxMs >= 300, `no listed entry changed within the guard (newest ${Date.now() - settled.maxMs} ms old)`);
    writeFileSync(join(state(s.dir), "handbacks.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), session_id: "s1", agent_id: "a1", agent_type: "implementer", tool_use_id: "toolu_H", status: "pass" })}\n`);
    assert.equal(gate(s, cmd, { handback: true, toolUseId: "toolu_H" }).status, 2);
    const hb = records(s.dir).at(-1);
    assert.deepEqual([hb.at, hb.reason, hb.failed_count, hb.failed_tests, hb.store], ["handback", "tests_failed", 1, ["tests/test_a.py::test_one"], "stored"]);
    const stop = gate(s, cmd);
    assert.equal(stop.status, 2);
    const rec = records(s.dir).at(-1);
    assert.deepEqual([rec.reason, rec.reused, rec.failed_count, rec.failed_tests, rec.output], ["tests_failed", "fail", 1, ["tests/test_a.py::test_one"], hb.output]);
    assert.ok(existsSync(join(state(s.dir), hb.output)));
  } finally {
    rmSync(s.base, { recursive: true, force: true });
  }
});

test("the test argument --recent-ms changes only that run's guard; the production default stays RECENT_MS", () => {
  assert.equal(RECENT_MS, 2000, "the production guard is unchanged");
  const t = 1_800_000_000_000;
  const L = { v: "1", hash: "a".repeat(64), reason: "", clock0: t, clock1: t + 100, maxMs: t - 1000, outside: false, coarse: false, future: false, entries: 3 };
  const l1 = { ...L, clock0: t + 5000, clock1: t + 5100 };
  assert.equal(storeVerdict(L, l1), "recent_change", "1 s before L0 is recent under the default guard");
  assert.equal(storeVerdict(L, l1, 500), "", "a shorter guard (tests only)");
  for (const bad of [0, -1, 1.5, 600001, Number.NaN]) assert.equal(storeVerdict(L, l1, bad), "recent_change", `an invalid guard (${bad}) keeps the default`);
  // No hook configuration passes it: the project's and the plugin's hook commands name no --recent-ms.
  for (const f of [new URL("../.claude/settings.json", import.meta.url), new URL("../dist/plugin/hooks/hooks.json", import.meta.url)]) {
    if (existsSync(f)) assert.doesNotMatch(readFileSync(f, "utf8"), /recent-ms/, String(f));
  }
});
