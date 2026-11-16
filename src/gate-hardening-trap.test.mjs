// Gate hardening (release 1.4.0), part 1b of the former src/gate-hardening.test.mjs: the gate's temp folder lives until the hook
// ends, and run_limited's terminate, kill and limit (verify.sh). Real hook processes on temporary folders and git repos;
// no model call. The parts run in parallel.
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
// ---- 1b. The gate's temp folder lives until the hook ends. ----

// run_limited's watchdog is a subshell that the hook stops when the command ends. A SIGTERM that reached it before it
// had reset the traps it inherited ran the hook's EXIT trap there, which removed the hook's temp folder while the hook
// still ran (a fast command on a loaded machine: "check.in: No such file or directory", and the bugfix check skipped).
test("test gate: run_limited's watchdog never runs the hook's EXIT trap, however fast the command ends", () => {
  const fn = spawnSync("sed", ["-n", "/^run_limited() {/,/^}/p", hook("verify.sh")], { encoding: "utf8" }).stdout;
  assert.match(fn, /^run_limited\(\) \{/);
  const work = tmp("orch-gh-trap-");
  const loop = 'i=0\nwhile [ "$i" -lt 40 ]; do\n  run_limited 5 /dev/null "$work/out" /dev/null true\n  [ -d "$work" ] || { echo "temp folder gone after run $i"; exit 3; }\n  i=$((i + 1))\ndone\ntrap - EXIT\n';
  const r = spawnSync("bash", ["-c", `${fn}\nwork="$1"\ntrap 'rm -rf "$work"' EXIT\n${loop}`, "x", work], { encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.ok(existsSync(work));
});

// At its limit run_limited first sends the command's group SIGTERM, so a helper can remove its base worktree, and
// kills the group only when it is still there a few seconds later. The 4 s limit (at least 4 s, since a limit holds
// for between its value and one second more, and the watchdog polls once a second) leaves a loaded machine's bash time to set its TERM trap before the
// SIGTERM comes (at 1 s a slow start died on the default action and never cleaned up).
test("test gate: run_limited terminates the command before it kills it, and kills a group that ignores the terminate", () => {
  const fn = spawnSync("sed", ["-n", "/^run_limited() {/,/^}/p", hook("verify.sh")], { encoding: "utf8" }).stdout;
  const dir = tmp("orch-gh-term-");
  const polite = `trap 'echo cleaned > "${dir}/cleaned"; exit 0' TERM; sleep 60 & wait`;
  const stubborn = `trap '' TERM; sleep 60 & echo $! > "${dir}/child.pid"; wait`;
  // The two calls run at the same time, as two background jobs of the one script; each writes its own flag, and the
  // flags are printed in a fixed order once both have ended.
  const script = `${fn}\n{ run_limited 4 /dev/null "$3/polite.out" /dev/null bash -c "$1"; echo "polite:$lim_timed_out" > "$3/polite.flag"; } &\np=$!\n{ run_limited 4 /dev/null "$3/stubborn.out" /dev/null bash -c "$2"; echo "stubborn:$lim_timed_out" > "$3/stubborn.flag"; } &\ns=$!\nwait "$p"; wait "$s"\ncat "$3/polite.flag" "$3/stubborn.flag"\n`;
  const t0 = Date.now();
  const r = spawnSync("bash", ["-c", script, "x", polite, stubborn, dir], { encoding: "utf8", timeout: 60000 });
  assert.match(r.stdout, /polite:1\nstubborn:1\n/);
  assert.equal(readFileSync(join(dir, "cleaned"), "utf8"), "cleaned\n", "the command got a SIGTERM and could clean up");
  const child = Number(readFileSync(join(dir, "child.pid"), "utf8"));
  assert.ok(child > 0 && goneSoon(child), "a group that ignores SIGTERM is killed after the grace");
  assert.ok(Date.now() - t0 < 40000, `took ${Date.now() - t0} ms`);
});

// bash's SECONDS ticks at whole wall-clock seconds, so a limit counted in it alone ran out up to a second early: a run
// started late in a second (here 0.95 to 0.994 s past it, where the watchdog's poll falls just after the end tick) was
// timed out at 2.0x s of a 3 s limit. Before the fix 5 to 7 of these 12 runs were timed out in every attempt (3 of 3).
test("test gate: run_limited never times out a run that ends before its limit, wherever in a second it starts", () => {
  const fn = spawnSync("sed", ["-n", "/^run_limited() {/,/^}/p", hook("verify.sh")], { encoding: "utf8" }).stdout;
  const fracs = ["0.95", "0.96", "0.965", "0.97", "0.973", "0.976", "0.979", "0.982", "0.985", "0.988", "0.991", "0.994"];
  const one = 'one() {\n  local s=$SECONDS\n  while [ "$SECONDS" = "$s" ]; do :; done\n  sleep "$1"\n  run_limited 3 /dev/null /dev/null /dev/null sleep 2.6\n  echo "$1:$lim_timed_out"\n}\nfor f in "$@"; do one "$f" & done\nwait\n';
  const r = spawnSync("bash", ["-c", `${fn}\n${one}`, "x", ...fracs], { encoding: "utf8", timeout: 60000 });
  const lines = r.stdout.split("\n").filter(Boolean).sort();
  assert.equal(lines.length, fracs.length, `${r.stdout}${r.stderr}`);
  assert.deepEqual(lines.filter((l) => !l.endsWith(":0")), [], "a 2.6 s run under a 3 s limit is never timed out");
});

/**
 * True once `pid` has ended: gone, or a zombie (killed, not yet reaped by its new parent). Polls for up to 10 s, since
 * a killed process can still answer `kill(pid, 0)` for a moment on a loaded machine. @param {number} pid
 */
function goneSoon(pid) {
  const t0 = Date.now();
  for (;;) {
    const stat = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
    if (stat === "" || stat.startsWith("Z")) return true;
    if (Date.now() - t0 > 10000) return false;
    spawnSync("sleep", ["0.1"]);
  }
}

// A suite that removes the hook's temp folder and exits 0 on the SIGTERM at its limit is still a timeout (a block):
// the timeout verdict is the hook's own, not a flag file in that folder.
test("test gate: a suite that deletes the gate's temp folder and exits 0 on SIGTERM at the limit still blocks as timed out", () => {
  const { dir } = changedRepo(null);
  const cmd = 'rm -rf "$TMPDIR"/orch-verify.*; trap "exit 0" TERM; sleep 100 & wait';
  const r = gate(dir, { env: { ORCH_TEST_CMD: cmd, ORCH_TEST_TIMEOUT_S: "2", ORCH_BASELINE: "off" }, limitMs: 60000 });
  assert.equal(r.status, 2, `blocks: ${r.stderr}`);
  assert.deepEqual([lastTest(dir).decision, lastTest(dir).reason, lastTest(dir).timed_out], ["block", "tests_failed", 1]);
  assert.match(r.stderr, /did not finish within 2 seconds/);
});

// The folder is removed again while the helper runs (its base run runs the same command, with the same TMPDIR): the
// helper's answer is lost with it, so a KIND: bugfix stop blocks with bugfix_tmp_lost and never allows.
test("test gate: a KIND: bugfix check whose answer is lost with the temp folder blocks with bugfix_tmp_lost", () => {
  const bug = changedRepo("bugfix");
  write(bug.dir, { "tests/value_test.sh": '. ./app.sh; [ "$VALUE" = 2 ]\n' });
  const cmd = 'rm -rf "$TMPDIR"/orch-verify.*; for f in tests/*_test.sh; do bash "$f" || { echo "FAILED $f::case - no"; exit 1; }; done';
  const env = { ORCH_TEST_CMD: cmd };
  const r = gate(bug.dir, { transcript: bug.transcript, env });
  assert.equal(r.status, 2, r.stderr);
  assert.deepEqual([lastTest(bug.dir).decision, lastTest(bug.dir).reason], ["block", "bugfix_tmp_lost"]);
  assert.match(r.stderr, /KIND: bugfix: unverified\. The test gate's temporary folder/);
  // It shares the bugfix cap: a second block, then the give-up allow, never tests_passed.
  assert.equal(gate(bug.dir, { transcript: bug.transcript, env }).status, 2);
  assert.equal(gate(bug.dir, { transcript: bug.transcript, env }).status, 0);
  assert.equal(lastTest(bug.dir).reason, "bugfix_unverified_gave_up");
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
