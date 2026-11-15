// scripts/check.mjs (`npm run check`) runs its steps at the same time; these tests drive it with stub steps
// (ORCH_CHECK_STEPS) and check the exit code, the failing-step line, unmixed output, parallelism and signal handling.
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

/** @param {[string, string][]} steps @returns {Promise<{ code: number | null, out: string, ms: number }>} */
const check = (steps) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script], { env: { ...process.env, ORCH_CHECK_STEPS: JSON.stringify(steps) } });
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
  // two steps of about 1.25 s each (0.25 s of output, 1 s sleep): one after another would take over 2.5 s
  const r = await check([step("alpha", 0, 1000), step("beta", 0, 1000)]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.ms < 2000, `took ${r.ms} ms`);
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
