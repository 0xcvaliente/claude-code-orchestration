// src/test-tmp.mjs: a test file run directly makes its own temp root and removes it at exit. Every test file `npm test`
// runs must import it first; the behaviour tests run a tiny test file as a child (`node --test`) with TMPDIR set to a
// fresh scratch folder and look at what is left there afterwards.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const moduleUrl = pathToFileURL(join(here, "test-tmp.mjs")).href;

// the files `npm test` runs (scripts/run-tests.mjs): src/*.test.ts, src/*.test.mjs and bench/*.test.mjs
const PATTERNS = [
  { dir: "src", match: /\.test\.(ts|mjs)$/, line: "./test-tmp.mjs" },
  { dir: "bench", match: /\.test\.mjs$/, line: "../src/test-tmp.mjs" },
];

/** The first statement after a shebang, blank lines and comments, or "" when there is none. @param {string} text */
function firstStatement(text) {
  let rest = text.replace(/^#![^\n]*\n/, "");
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("//")) rest = trimmed.replace(/^\/\/[^\n]*(\n|$)/, "");
    else if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      if (end < 0) return "";
      rest = trimmed.slice(end + 2);
    } else return trimmed.split("\n")[0] ?? "";
  }
}

test("every test file npm test runs imports test-tmp.mjs as its first import", () => {
  let count = 0;
  for (const { dir, match, line } of PATTERNS) {
    for (const name of readdirSync(join(root, dir)).filter((n) => match.test(n)).sort()) {
      count++;
      const first = firstStatement(readFileSync(join(root, dir, name), "utf8"));
      const want = new RegExp(`^import\\s+["']${line.replace(/[.\/]/g, "\\$&")}["'];?\\s*$`);
      assert.match(first, want, `${dir}/${name}: the first import must be \`import "${line}";\`, found: ${first}`);
    }
  }
  assert.ok(count > 0, "no test files found");
});

test("firstStatement skips a shebang and comments and sees anything else", () => {
  assert.equal(firstStatement('#!/usr/bin/env node\n// a\n/* b\n c */\n\nimport "./test-tmp.mjs";\nimport x from "y";'), 'import "./test-tmp.mjs";');
  assert.equal(firstStatement('// a\nimport assert from "node:assert";\nimport "./test-tmp.mjs";'), 'import assert from "node:assert";');
});

// scratch folders for the behaviour tests: short (tsx opens a socket under TMPDIR), removed at the end
const base = mkdtempSync(join(tmpdir(), "tt-"));
after(() => rmSync(base, { recursive: true, force: true }));
let n = 0;

/**
 * Writes a tiny test file that imports test-tmp.mjs, makes a mkdtemp folder, writes its path to `report` and then
 * `body` runs; runs it with `node --test` and TMPDIR set to `tmp`.
 * @param {{ tmp: string, body?: string, env?: Record<string, string>, signal?: NodeJS.Signals }} o
 * @returns {Promise<{ code: number | null, signal: NodeJS.Signals | null, stderr: string, made: string }>}
 */
function runChild({ tmp, body = "", env = {}, signal }) {
  const work = join(base, `w${n++}`);
  mkdirSync(work);
  const report = join(work, "made.txt");
  const file = join(work, "child.test.mjs");
  writeFileSync(
    file,
    `import ${JSON.stringify(moduleUrl)};
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
test("child", async () => {
  const made = mkdtempSync(join(tmpdir(), "made-"));
  writeFileSync(${JSON.stringify(report)}, made);
  ${body}
});
`,
  );
  return new Promise((resolve) => {
    /** @type {NodeJS.ProcessEnv} */
    const childEnv = { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
    // a clean start: no keep switch from outside, and no NODE_TEST_CONTEXT, which turns a nested `node --test` into a
    // reporter for this runner instead of a runner of its own
    delete childEnv.ORCH_KEEP_TEST_TMP;
    delete childEnv.NODE_TEST_CONTEXT;
    Object.assign(childEnv, env);
    // without --test the file runs in this child itself, so a signal reaches the process that imported the module
    const args = signal ? [file] : ["--test", file];
    const child = spawn(process.execPath, args, { env: childEnv, stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let out = "";
    child.stderr.on("data", (b) => (stderr += b));
    child.stdout.on("data", (b) => (out += b));
    if (signal) {
      const poll = setInterval(() => {
        if (existsSync(report)) {
          clearInterval(poll);
          child.kill(signal);
        }
      }, 20);
      child.on("close", () => clearInterval(poll));
    }
    child.on("close", (code, sig) =>
      resolve({ code, signal: sig, stderr: stderr + out, made: existsSync(report) ? readFileSync(report, "utf8") : "" }),
    );
  });
}

const scratch = () => mkdtempSync(join(base, "s-"));

/** Asserts `made` sits in an `orch-test-` folder directly inside `tmp`. @param {string} made @param {string} tmp */
function assertInOwnRoot(made, tmp) {
  assert.ok(made, "the child made no folder");
  const parent = dirname(made);
  assert.match(basename(parent), /^orch-test-/, `the child's folder ${made} is not in an orch-test- root`);
  assert.equal(realpathSync(dirname(parent)), realpathSync(tmp), `the root ${parent} is not directly in the given temp dir`);
}

test("without a given root the child's folders go into its own root, removed at exit", async () => {
  const tmp = scratch();
  const r = await runChild({ tmp });
  assert.equal(r.code, 0, r.stderr);
  assertInOwnRoot(r.made, tmp);
  assert.deepEqual(readdirSync(tmp), [], "the scratch temp dir is not empty");
});

test("the root is removed after a failed test too", async () => {
  const tmp = scratch();
  const r = await runChild({ tmp, body: 'throw new Error("planned failure");' });
  assert.notEqual(r.code, 0, "the child's test was meant to fail");
  assertInOwnRoot(r.made, tmp);
  assert.deepEqual(readdirSync(tmp), [], "the scratch temp dir is not empty");
});

test("a TMPDIR named orch-test-* is someone else's root: nothing is made and nothing removed", async () => {
  const given = join(scratch(), "orch-test-given");
  mkdirSync(given);
  const r = await runChild({ tmp: given });
  assert.equal(r.code, 0, r.stderr);
  assert.ok(existsSync(given), "the given root was removed");
  assert.equal(realpathSync(dirname(r.made)), realpathSync(given), "the child did not use the given root");
  assert.deepEqual(readdirSync(given), [basename(r.made)], "the module made a folder in the given root");
});

test("ORCH_KEEP_TEST_TMP=1 keeps the root and prints its path", async () => {
  const tmp = scratch();
  const r = await runChild({ tmp, env: { ORCH_KEEP_TEST_TMP: "1" } });
  assert.equal(r.code, 0, r.stderr);
  assertInOwnRoot(r.made, tmp);
  const printed = r.stderr.match(/test temp folder kept: (\S+)/)?.[1];
  assert.ok(printed, `no kept path printed: ${r.stderr}`);
  assert.equal(realpathSync(printed), realpathSync(dirname(r.made)));
  assert.ok(existsSync(r.made), "the kept root was removed");
});

test("SIGTERM removes the root and the process still dies of the signal", { skip: process.platform === "win32" && "POSIX signals" }, async () => {
  const tmp = scratch();
  const r = await runChild({ tmp, body: "await new Promise((r) => setTimeout(r, 30000));", signal: "SIGTERM" });
  assert.equal(r.signal, "SIGTERM", `exit code ${r.code}, signal ${r.signal}`);
  assertInOwnRoot(r.made, tmp);
  assert.deepEqual(readdirSync(tmp), [], "the scratch temp dir is not empty");
});
