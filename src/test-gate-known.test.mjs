// Two "Known and not fixed" lines of docs/gates.md (Limits, Test gate), handled in bugfix-check.mjs: a unittest failfast
// set inside a script the command runs (failFastInTree: the allow baseline keeps the block), and a cargo workspace
// member whose folder name differs from its package name (cargoPackageDirs: its bugfix slice is verified).
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cargoPackageDirs, failFastInTree, inFiles, parseFailures } from "../.claude/hooks/bugfix-check.mjs";

const verifySh = new URL("../.claude/hooks/verify.sh", import.meta.url).pathname;
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
/** @param {string} dir @param {Record<string, string>} files */
function write(dir, files) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
}
/** @param {Record<string, string>} files */
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "orch-tgk-"));
  git(dir, "init", "-q");
  write(dir, files);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}
/** @param {string} dir @param {Record<string, string>} env @param {string} [transcript] */
function gate(dir, env, transcript) {
  /** @type {Record<string, unknown>} */
  const event = { hook_event_name: "SubagentStop", agent_type: "implementer", agent_id: "a1", cwd: dir, session_id: "s1" };
  if (transcript) event.agent_transcript_path = transcript;
  const r = spawnSync("bash", [verifySh], { input: JSON.stringify(event), env: { ...cleanEnv(), CLAUDE_PROJECT_DIR: dir, TMPDIR: mkdtempSync(join(tmpdir(), "orch-tgk-tmp-")), ...env }, encoding: "utf8" });
  const rec = JSON.parse(readFileSync(join(dir, ".claude", "state", "gates.jsonl"), "utf8").trim().split("\n").pop() ?? "{}");
  return { status: r.status, stderr: r.stderr, rec };
}

const hasPython = spawnSync("python3", ["-c", "1"]).status === 0;
test("unittest failfast inside a script the command runs: the allow baseline keeps the block", { skip: !hasPython && "python3 missing" }, () => {
  const failing = (/** @type {string} */ n, /** @type {number} */ v) => `import unittest\nclass T(unittest.TestCase):\n    def test_${n}(self):\n        self.assertEqual(1, ${v})\n`;
  const runner = 'import unittest\nif __name__ == "__main__":\n    unittest.main(module=None, argv=["run", "discover", "-q"], failfast=True)\n';
  // test_a fails on the base already; the slice adds test_b, which fails too, but failfast stops at test_a.
  const dir = repo({ "run_tests.py": runner, "test_a.py": failing("a", 2), ".gitignore": ".claude/\n__pycache__/\n" });
  write(dir, { "test_b.py": failing("b", 3) });
  const r = gate(dir, { ORCH_TEST_CMD: "python3 -B run_tests.py", ORCH_BASELINE: "allow", ORCH_BUGFIX_CHECK: "off" });
  assert.equal(r.status, 2, "test_b never ran: no allow");
  assert.equal(r.rec.reason, "tests_failed");
  assert.ok(failFastInTree(dir, "Ran 1 test in 0.001s\n"));
  assert.equal(failFastInTree(dir, "FAILED tests/test_a.py::a\n"), false, "only for unittest's output");
  const plain = repo({ "test_a.py": failing("a", 2) });
  assert.equal(failFastInTree(plain, "Ran 1 test in 0.001s\n"), false, "no failfast in the tree");
  assert.equal(failFastInTree(join(plain, "missing"), "Ran 1 test in 0.001s\n"), true, "a search that cannot run counts as failfast");
});

test("a cargo workspace member whose folder differs from its package: the quiet hint's test file matches", () => {
  const dir = repo({
    "Cargo.toml": '[workspace]\nmembers = ["crates/my-dir", "crates/other"]\n',
    "crates/my-dir/Cargo.toml": '[package]\nname = "mycrate"\nversion = "0.1.0"\n\n[dependencies]\nname = "not-this"\n',
    "crates/other/Cargo.toml": '[package]\nname = "other"\nversion = "0.1.0"\n',
  });
  const files = ["crates/my-dir/tests/foo.rs", "crates/other/tests/foo.rs"];
  const map = cargoPackageDirs(dir, files);
  assert.deepEqual({ ...map }, { mycrate: "crates/my-dir", other: "crates/other" });
  const name = parseFailures("it_works --- FAILED\n\nerror: test failed, to rerun pass `-p mycrate --test foo`\n").names[0] ?? "";
  assert.equal(name, "mycrate/tests/foo.rs::it_works");
  assert.equal(inFiles(name, ["crates/my-dir/tests/foo.rs"]), false, "by name alone it does not match");
  assert.ok(inFiles(name, ["crates/my-dir/tests/foo.rs"], map), "through the package's folder");
  assert.equal(inFiles(name, ["crates/other/tests/foo.rs"], map), false, "never another member's file");
  assert.equal(inFiles("__proto__/tests/foo.rs::x", ["crates/my-dir/tests/foo.rs"], map), false);
});

test("a cargo workspace member whose folder differs from its package: its bugfix slice is verified", () => {
  // A stand-in for `cargo test --quiet` that prints cargo's quiet failure for the member when the reproduction test is
  // present and the bug is there.
  const fake = [
    "#!/bin/sh",
    "if [ -f crates/my-dir/tests/foo.rs ] && grep -q 'BUG' crates/my-dir/src/lib.rs; then",
    "  echo 'it_works --- FAILED'; echo; echo 'error: test failed, to rerun pass `-p mycrate --test foo`'; exit 101",
    "fi",
    "exit 0",
    "",
  ].join("\n");
  const dir = repo({
    "fake-cargo.sh": fake,
    "Cargo.toml": '[workspace]\nmembers = ["crates/my-dir"]\n',
    "crates/my-dir/Cargo.toml": '[package]\nname = "mycrate"\nversion = "0.1.0"\n',
    "crates/my-dir/src/lib.rs": "// BUG\n",
    ".gitignore": ".claude/\n",
  });
  write(dir, { "crates/my-dir/src/lib.rs": "// fixed\n", "crates/my-dir/tests/foo.rs": "#[test]\nfn it_works() {}\n" });
  const t = join(mkdtempSync(join(tmpdir(), "orch-tgk-tr-")), "agent.jsonl");
  writeFileSync(t, `${JSON.stringify({ type: "user", message: { content: "SLICE: fix\nFILES: x\nDEPENDS: none\nKIND: bugfix\nFix it." } })}\n`);
  const r = gate(dir, { ORCH_TEST_CMD: "sh fake-cargo.sh" }, t);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual([r.rec.reason, r.rec.new_failing], ["bugfix_verified", 1]);
});
