// Why a base run could not be used (bugfix-check.mjs): each cause has its own message for the agent and its own
// "cause" detail in the gate record; the node_modules link passes the folder link type Windows needs; the pytest
// summary parser keeps parametrized ids that contain a space. bugfix() is called directly on temporary git repos.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs, { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bugfix, parseFailures } from "../.claude/hooks/bugfix-check.mjs";

/** @param {string} dir @param {...string} args */
function git(dir, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter((e) => e[1] !== undefined && !/^GIT_/.test(e[0])));
  const r = spawnSync("git", ["-c", "user.name=orch", "-c", "user.email=orch@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, env, encoding: "utf8" });
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

const REPRO = '. ./app.sh; [ "$VALUE" = 2 ]\n';
const RUN = 'rc=0\nfor f in tests/*_test.sh; do bash "$f" || { echo "FAILED $f::case - no"; rc=1; }; done\nexit $rc\n';

/** A committed repo with a bug, the fix and a new reproduction test in the tree, and a KIND: bugfix transcript. @param {Record<string, string>} [extra] */
function bugRepo(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "orch-bcr-"));
  git(dir, "init", "-q");
  write(dir, { "app.sh": "VALUE=1\n", "run.sh": RUN, "tests/ok_test.sh": "true\n", ...extra });
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "init");
  write(dir, { "app.sh": "VALUE=2\n", "tests/value_test.sh": REPRO });
  const transcript = join(mkdtempSync(join(tmpdir(), "orch-bcr-tr-")), "agent.jsonl");
  writeFileSync(transcript, JSON.stringify({ type: "user", message: { content: "SLICE: fix\nFILES: app.sh\nDEPENDS: none\nKIND: bugfix\nFix VALUE." } }) + "\n");
  const state = mkdtempSync(join(tmpdir(), "orch-bcr-state-"));
  return { dir, state, event: { agent_id: "a1", agent_transcript_path: transcript } };
}

/** @param {ReturnType<typeof bugRepo>} r @param {string} cmd */
const check = (r, cmd) => bugfix({ cwd: r.dir, cmd, isolated: false, state: r.state, event: r.event });

/** verify.sh keeps only these characters of the extra line: the cause must survive it unchanged. @param {string} extra */
const survivesVerify = (extra) => assert.equal(extra.replace(/[^a-z_0-9,:"]/g, ""), extra);

test("bugfix: a lock file that differs from the base says so, not 'no parsable test names'", async () => {
  const r = bugRepo({ ".gitignore": "node_modules/\n", "package-lock.json": "{}\n" });
  mkdirSync(join(r.dir, "node_modules"));
  write(r.dir, { "package-lock.json": '{"lockfileVersion":3}\n' });
  const res = await check(r, "bash run.sh");
  assert.ok(res);
  assert.deepEqual([res.decision, res.reason], ["block", "bugfix_base_unusable"]);
  assert.match(res.extra, /"cause":"lock_mismatch"/);
  survivesVerify(res.extra);
  assert.match(res.message, /unverified/);
  assert.match(res.message, /package-lock\.json/);
  assert.match(res.message, /dependencies/);
  assert.doesNotMatch(res.message, /parsable/);
});

test("bugfix: a failed git worktree add says so", async () => {
  const r = bugRepo();
  // A file where git keeps its worktree records: `git worktree add` cannot register the base worktree.
  writeFileSync(join(r.dir, ".git", "worktrees"), "");
  const res = await check(r, "bash run.sh");
  assert.ok(res);
  assert.deepEqual([res.decision, res.reason], ["block", "bugfix_base_unusable"]);
  assert.match(res.extra, /"cause":"worktree_add_failed"/);
  survivesVerify(res.extra);
  assert.match(res.message, /worktree/);
  assert.doesNotMatch(res.message, /parsable/);
});

test("bugfix: a base run that times out says it timed out", async () => {
  const r = bugRepo();
  const old = process.env.ORCH_BASE_TIMEOUT_S;
  process.env.ORCH_BASE_TIMEOUT_S = "1";
  try {
    const res = await check(r, "sleep 5");
    assert.ok(res);
    assert.deepEqual([res.decision, res.reason], ["block", "bugfix_base_unusable"]);
    assert.match(res.extra, /"cause":"base_timeout"/);
    survivesVerify(res.extra);
    assert.match(res.message, /timed out/);
    assert.doesNotMatch(res.message, /parsable/);
  } finally {
    if (old === undefined) delete process.env.ORCH_BASE_TIMEOUT_S;
    else process.env.ORCH_BASE_TIMEOUT_S = old;
  }
});

test("bugfix: a base run that fails without test names says so", async () => {
  const r = bugRepo();
  const res = await check(r, "echo boom; exit 1");
  assert.ok(res);
  assert.deepEqual([res.decision, res.reason], ["block", "bugfix_base_unusable"]);
  assert.match(res.extra, /"cause":"no_test_names"/);
  survivesVerify(res.extra);
  assert.match(res.message, /failed without parsable test names/);
  assert.doesNotMatch(res.message, /timed out/);
});

test("runInBase links node_modules as a junction (the folder link type Windows needs)", async () => {
  const r = bugRepo({ ".gitignore": "node_modules/\n", "package-lock.json": "{}\n" });
  mkdirSync(join(r.dir, "node_modules", "dep"), { recursive: true });
  const orig = fs.symlinkSync;
  /** @type {unknown[][]} */
  const calls = [];
  fs.symlinkSync = /** @type {typeof fs.symlinkSync} */ ((/** @type {any[]} */ ...a) => {
    calls.push(a);
    return /** @type {any} */ (orig)(...a);
  });
  syncBuiltinESMExports();
  try {
    const res = await check(r, "test -d node_modules/dep && bash run.sh");
    assert.ok(res);
    assert.equal(res.reason, "bugfix_verified");
  } finally {
    fs.symlinkSync = orig;
    syncBuiltinESMExports();
  }
  assert.ok(calls.length > 0, "node_modules was linked");
  for (const c of calls) assert.equal(c[2], "junction");
});

test("parseFailures: a pytest parametrized id with a space is one qualified name", () => {
  const out = "FAILED t.py::test_x[a b] - AssertionError\nFAILED t.py::test_y[c d]\nFAILED t.py::test_z - boom\nFAILED (failures=3)\n";
  const f = parseFailures(out);
  assert.deepEqual(f.names, ["t.py::test_x[a b]", "t.py::test_y[c d]", "t.py::test_z"]);
  assert.deepEqual(f.unqualified, []);
  assert.equal(f.crash, false);
});
