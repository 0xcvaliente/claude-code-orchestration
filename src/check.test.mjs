// scripts/check.mjs (`npm run check`) runs its steps at the same time; these tests drive it with stub steps
// (ORCH_CHECK_STEPS) and check the exit code, the failing-step line, unmixed output, parallelism and signal handling.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "check.mjs");
const dir = mkdtempSync(join(tmpdir(), "check-test-"));
after(() => rmSync(dir, { recursive: true, force: true }));

// stub step: prints `<tag> line <i>` five times (stdout and stderr alternating) 50 ms apart, sleeps, then exits
const stub = join(dir, "stub.mjs");
writeFileSync(
  stub,
  `import { writeFileSync } from "node:fs";
const [tag, code, sleepMs, pidFile] = process.argv.slice(2);
if (pidFile) writeFileSync(pidFile, String(process.pid));
for (let i = 0; i < 5; i++) {
  (i % 2 ? process.stderr : process.stdout).write(tag + " line " + i + "\\n");
  await new Promise((r) => setTimeout(r, 50));
}
await new Promise((r) => setTimeout(r, Number(sleepMs)));
process.exit(Number(code));
`,
);
/** @param {string} tag @param {number} code @param {number} [sleepMs] @param {string} [pidFile] @returns {[string, string]} */
const step = (tag, code, sleepMs = 0, pidFile = "") => [tag, `node "${stub}" ${tag} ${code} ${sleepMs} ${pidFile ? `"${pidFile}"` : ""}`];

/**
 * Runs check.mjs with `steps`, its stdout and stderr through pipes. `slowMs` leaves stdout unread that long, as a slow
 * reader (`| wc -c`, a CI log collector) would, so the pipe fills and check.mjs's writes queue up.
 * @param {[string, string][]} steps @param {number} [slowMs] @returns {Promise<{ code: number | null, out: string, ms: number }>}
 */
const check = (steps, slowMs = 0) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script], { env: { ...process.env, ORCH_CHECK_STEPS: JSON.stringify(steps) }, stdio: "pipe" });
    if (slowMs) {
      child.stdout.pause();
      setTimeout(() => child.stdout.resume(), slowMs);
    }
    let out = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (out += b));
    child.on("close", (code) => resolve({ code, out, ms: Date.now() - started }));
  });

const lastLine = (/** @type {string} */ out) => out.trimEnd().split("\n").at(-1) ?? "";

test("npm run check runs scripts/check.mjs", () => {
  const scripts = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts;
  assert.equal(scripts.check, "node scripts/check.mjs");
});

test("check.mjs runs the four real steps by default, the tests as npm test", () => {
  const src = readFileSync(script, "utf8");
  for (const s of ['"npm run typecheck"', '"npm test"', '"npm run check-agents"', '"npm run check-plugin"']) assert.ok(src.includes(s), s);
});

test("every step passing gives exit 0 and a pass line", async () => {
  const r = await check([step("alpha", 0), step("beta", 0), step("gamma", 0)]);
  assert.equal(r.code, 0, r.out);
  assert.match(lastLine(r.out), /^check passed: all 3 steps/);
  for (const t of ["alpha", "beta", "gamma"]) assert.match(r.out, new RegExp(`=== ${t}: pass`));
});

test("one failing step gives a non-zero exit and the last line names it", async () => {
  const r = await check([step("alpha", 0), step("beta", 3), step("gamma", 0)]);
  assert.notEqual(r.code, 0);
  assert.match(lastLine(r.out), /^check failed: beta \(1 of 3/);
  assert.match(r.out, /=== beta: FAIL \(exit 3\)/);
});

test("two failing steps are both named on the last line", async () => {
  const r = await check([step("alpha", 1), step("beta", 0), step("gamma", 2)]);
  assert.notEqual(r.code, 0);
  assert.match(lastLine(r.out), /^check failed: alpha, gamma \(2 of 3/);
});

test("a step that cannot start counts as failed", async () => {
  const r = await check([step("alpha", 0), ["ghost", "definitely-not-a-command-orch-check"]]);
  assert.notEqual(r.code, 0);
  assert.match(lastLine(r.out), /^check failed: ghost /);
});

test("each step's output is printed whole under its own header, never interleaved", async () => {
  // all three print at the same moments; each block must still hold only its own lines, all five, in order
  const tags = ["alpha", "beta", "gamma"];
  const r = await check(tags.map((t) => step(t, 0)));
  assert.equal(r.code, 0, r.out);
  const blocks = r.out.split(/\n(?==== )/).filter((b) => b.startsWith("=== "));
  assert.equal(blocks.length, 3, r.out);
  for (const block of blocks) {
    const tag = /^=== (\w+):/.exec(block)?.[1] ?? "";
    assert.ok(tags.includes(tag), block);
    const lines = block.split("\n").slice(1).filter((l) => / line \d$/.test(l));
    assert.deepEqual(lines, [0, 1, 2, 3, 4].map((i) => `${tag} line ${i}`), block);
  }
});

test("the steps run at the same time", async () => {
  // each step writes the time it started and the time it ended; run at the same time, the two intervals overlap, run one
  // after another the second starts only after the first has ended. No wall-clock limit, so a loaded machine still passes.
  const timed = join(dir, "timed.mjs");
  writeFileSync(
    timed,
    `import { writeFileSync } from "node:fs";
const [file, sleepMs] = process.argv.slice(2);
const start = Date.now();
await new Promise((r) => setTimeout(r, Number(sleepMs)));
writeFileSync(file, JSON.stringify({ start, end: Date.now() }));
`,
  );
  const [a, b] = [join(dir, "times-alpha.json"), join(dir, "times-beta.json")];
  const r = await check([
    ["alpha", `node "${timed}" "${a}" 1000`],
    ["beta", `node "${timed}" "${b}" 1000`],
  ]);
  assert.equal(r.code, 0, r.out);
  const ta = JSON.parse(readFileSync(a, "utf8"));
  const tb = JSON.parse(readFileSync(b, "utf8"));
  assert.ok(ta.start < tb.end && tb.start < ta.end, `alpha ran ${ta.start}..${ta.end}, beta ${tb.start}..${tb.end}: no overlap`);
});

// 5 MB of output read through a pipe (as CI reads it): nothing may be lost to an exit while writes are still queued
const big = join(dir, "big.mjs");
writeFileSync(big, `process.stdout.write("x".repeat(5_000_000) + "\\n"); process.exitCode = Number(process.argv[2]);\n`);
for (const code of [0, 4]) {
  test(`a step's 5 MB of output and the summary line all arrive through a pipe (step exit ${code})`, async () => {
    const r = await check([["big", `node "${big}" ${code}`], step("small", 0)], 1500);
    const longest = Math.max(0, ...(r.out.match(/x+/g) ?? []).map((x) => x.length));
    assert.equal(longest, 5_000_000, `got ${r.out.length} characters`);
    if (code === 0) {
      assert.equal(r.code, 0);
      assert.match(lastLine(r.out), /^check passed: all 2 steps/);
    } else {
      assert.equal(r.code, 1);
      assert.match(lastLine(r.out), /^check failed: big \(1 of 2/);
    }
  });
}

test("an empty step list is an error, never a pass", async () => {
  const r = await check([]);
  assert.notEqual(r.code, 0);
  assert.doesNotMatch(r.out, /check passed/);
  assert.match(r.out, /no steps/);
});

test("a signal to check.mjs stops the running steps", { skip: process.platform === "win32" && "process groups are POSIX" }, async () => {
  const pidFile = join(dir, "pid");
  const steps = [step("slow", 0, 30000, pidFile)];
  const child = spawn(process.execPath, [script], { env: { ...process.env, ORCH_CHECK_STEPS: JSON.stringify(steps) }, stdio: "ignore" });
  const exited = new Promise((resolve) => child.on("close", (code, signal) => resolve(code ?? signal)));
  const until = Date.now() + 10000;
  while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8")) {
    assert.ok(Date.now() < until, "the stub never started");
    await new Promise((r) => setTimeout(r, 20));
  }
  const pid = Number(readFileSync(pidFile, "utf8"));
  child.kill("SIGTERM");
  assert.equal(await exited, 143);
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const deadline = Date.now() + 3000;
  while (alive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(alive(), false, "the step outlived check.mjs");
});

/** @param {string} pidFile kills the process whose pid the file holds, if any */
const killPidFile = (pidFile) => {
  try {
    process.kill(Number(readFileSync(pidFile, "utf8")), "SIGKILL");
  } catch {
    // never started, or already gone
  }
};

test("a step that leaves a background process holding its output ends when the step exits", { skip: process.platform === "win32" && "POSIX shell" }, async () => {
  // the step's shell exits at once; the sleep it leaves behind keeps the step's stdout open for 30 s
  const pidFile = join(dir, "bg-pid");
  try {
    const r = await check([["bg", `sh -c 'sleep 30 & echo $! > "${pidFile}"; echo hi'`], ["ok", "true"]]);
    assert.ok(r.ms < 3000, `took ${r.ms} ms`);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /=== bg: pass, \d+\.\d s ===\nhi\n/);
    assert.match(lastLine(r.out), /^check passed: all 2 steps/);
  } finally {
    killPidFile(pidFile);
  }
});

test("a step that prints 5 MB and then leaves a background process still delivers the 5 MB", { skip: process.platform === "win32" && "POSIX shell" }, async () => {
  const pidFile = join(dir, "bg-big-pid");
  try {
    const r = await check([["big", `sh -c 'node "${big}" 0; sleep 30 & echo $! > "${pidFile}"'`], step("small", 0)], 1500);
    const longest = Math.max(0, ...(r.out.match(/x+/g) ?? []).map((x) => x.length));
    assert.equal(longest, 5_000_000, `got ${r.out.length} characters`);
    assert.ok(r.ms < 5000, `took ${r.ms} ms`);
    assert.equal(r.code, 0, r.out.slice(-500));
    assert.match(lastLine(r.out), /^check passed: all 2 steps/);
  } finally {
    killPidFile(pidFile);
  }
});

// `node scripts/check.mjs | head -1`: the reader goes away after the first block; the exit code still follows the steps
for (const code of [0, 5]) {
  test(`a reader that closes stdout early gets no EPIPE error and the steps' exit code (late step exit ${code})`, async () => {
    const steps = [step("first", 0), step("late", code, 300)];
    const child = spawn(process.execPath, [script], { env: { ...process.env, ORCH_CHECK_STEPS: JSON.stringify(steps) }, stdio: "pipe" });
    let err = "";
    child.stderr.on("data", (b) => (err += b));
    child.stdout.once("data", () => child.stdout.destroy());
    const exit = await new Promise((resolve) => child.on("close", (c) => resolve(c)));
    assert.equal(exit, code === 0 ? 0 : 1, err);
    assert.doesNotMatch(err, /EPIPE|Error/);
  });
}
