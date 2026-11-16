// plan-check.mjs: globs in FILES (not_in_plan and file_overlap), path normalisation in file_overlap, session-filtered
// log reads and the lock's ownership. Driven like src/plan-hooks.test.mjs: a throwaway project with the hooks copied in.
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A throwaway project whose plan review finished in session s1 (legacy, run-less), unless `reviewed` is false. */
function project({ reviewed = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "plan-overlap-"));
  const hooks = join(dir, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of ["state.mjs", "brief.mjs", "run.mjs", "plan-check.mjs", "builtin-agents.mjs", "journal.mjs"]) copyFileSync(join(root, ".claude", "hooks", h), join(hooks, h));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  if (reviewed) {
    writeFileSync(join(dir, ".claude", "state", "journal.jsonl"), `${JSON.stringify({ ts: "t", session_id: "s1", slice: "plan", role: "reviewer", status: "pass", agent_id: "r0" })}\n`);
  }
  return dir;
}
const stateOf = (/** @type {string} */ dir) => join(dir, ".claude", "state");

/** @param {string} dir @param {string} script @param {unknown} payload @param {{ preload?: string, env?: Record<string, string> }} [o] */
const run = (dir, script, payload, o = {}) =>
  spawnSync("node", [...(o.preload ? ["--import", pathToFileURL(o.preload).href] : []), join(dir, ".claude", "hooks", script)], {
    input: JSON.stringify(payload),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ...(o.env ?? {}) },
    encoding: "utf8",
  });
/** @param {string} dir @param {string} prompt @param {{ preload?: string, env?: Record<string, string> }} [o] */
const launch = (dir, prompt, o) => run(dir, "plan-check.mjs", { session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "implementer", prompt } }, o);
const lastCheck = (/** @type {string} */ dir) =>
  JSON.parse(readFileSync(join(stateOf(dir), "plan-check.jsonl"), "utf8").trim().split("\n").at(-1) ?? "null");

/** Record a PLAN REVIEW launch and its passing stop through journal.mjs, which opens a planned run. @param {string} dir @param {string} text */
function plan(dir, text) {
  run(dir, "journal.mjs", { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "orchestration:reviewer", prompt: text }, tool_response: { status: "async_launched", agentId: "p1" } });
  run(dir, "journal.mjs", { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "p1", agent_type: "orchestration:reviewer", last_assistant_message: "STATUS: pass" });
}

/**
 * Launch slice a with FILES `a`, then slice b with FILES `b`; returns b's result. `existing`: project files to create first.
 * @param {string} a @param {string} b @param {string[]} [existing]
 */
function pair(a, b, existing = []) {
  const dir = project();
  try {
    for (const f of existing) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), "");
    }
    const first = launch(dir, `SLICE: a\nFILES: ${a}\nDEPENDS: none`);
    assert.equal(first.status, 0, first.stderr);
    const r = launch(dir, `SLICE: b\nFILES: ${b}\nDEPENDS: none`);
    return { status: r.status, stderr: r.stderr, reason: lastCheck(dir).reason, files: lastCheck(dir).files };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("file_overlap: a glob with no fixed folder overlaps only what it can match", () => {
  const md = pair("*.md", "src/a.ts");
  assert.equal(md.status, 0, `*.md and src/a.ts share no file: ${md.stderr}`);
  const readme = pair("*.md", "README.md");
  assert.deepEqual([readme.status, readme.reason], [2, "file_overlap"], "*.md matches README.md");
  assert.equal(pair("*.md", "src/a.ts", ["src/a.ts"]).status, 0, "* stays in one segment, file on disk or not");
  const deep = pair("**/*.ts", "src/a.py", ["src/a.py"]);
  assert.equal(deep.status, 0, `**/*.ts and the regular file src/a.py share no file: ${deep.stderr}`);
  // The stated cost: a plain entry not on disk may be a folder, so a ** glob may match something under it.
  assert.deepEqual([pair("**/*.ts", "src/new.py").status, pair("**/*.ts", "src/new.py").reason], [2, "file_overlap"], "src/new.py may be a folder");
  assert.equal(pair("src/*.ts", "src/new.py").status, 0, "src/*.ts cannot match src/new.py or anything under it");
  assert.deepEqual([pair("**/*.ts", "src/x/a.ts").status, pair("toolkit/*", "toolkit/toml.py").status], [2, 2]);
});

test("file_overlap: a plain entry not on disk may be a folder, whatever its name looks like", () => {
  for (const [a, b] of /** @type {[string, string][]} */ ([
    ["docs/v1.2", "docs/v1.2/x.md"],
    ["docs/v1.2/x.md", "docs/v1.2"],
    ["conf.d", "conf.d/site.conf"],
    ["conf.d/site.conf", "conf.d"],
  ])) {
    const r = pair(a, b);
    assert.deepEqual([r.status, r.reason], [2, "file_overlap"], `${a} then ${b}`);
  }
});

test("not_in_plan: a planned plain entry not on disk covers what is under it", () => {
  const dir = project({ reviewed: false });
  try {
    plan(dir, "PLAN REVIEW\nSLICE: a\nFILES: docs/v1.2\nDEPENDS: none\nGOAL: a");
    const r = launch(dir, "SLICE: a\nFILES: docs/v1.2/x.md\nDEPENDS: none");
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file_overlap: glob beside glob", () => {
  assert.deepEqual([pair("**/*.md", "docs/*.md").status, pair("**/*.md", "docs/*.md").reason], [2, "file_overlap"], "**/*.md and docs/*.md overlap");
  assert.equal(pair("*.md", "*.ts").status, 0, "*.md and *.ts do not overlap");
  assert.deepEqual([pair("src/**", "src/a.ts").status, pair("src/**", "src/a.ts").reason], [2, "file_overlap"], "src/** and src/a.ts overlap");
  assert.equal(pair("src/a?.ts", "src/ab.ts").status, 2, "? matches one character");
  assert.equal(pair("src/a?.ts", "src/abc.ts").status, 0, "? matches exactly one character");
  assert.equal(pair("a*.md", "*b.md").status, 2, "a*.md and *b.md share ab.md");
  assert.equal(pair("src", "src/x/y.ts").status, 2, "a folder overlaps what is under it");
  assert.equal(pair("**/*.ts", "src").status, 2, "a folder may hold what a glob matches");
});

test("file_overlap: the same file written two ways is one file; the log keeps FILES as written", () => {
  const dir = project();
  try {
    assert.equal(launch(dir, "SLICE: a\nFILES: src/a.ts\nDEPENDS: none").status, 0);
    const abs = join(dir, "src", "a.ts");
    let r = launch(dir, `SLICE: b\nFILES: ${abs}\nDEPENDS: none`);
    assert.deepEqual([r.status, lastCheck(dir).reason], [2, "file_overlap"], r.stderr);
    assert.deepEqual(lastCheck(dir).files, [abs], "logged raw");
    r = launch(dir, "SLICE: c\nFILES: src/../src/a.ts\nDEPENDS: none");
    assert.deepEqual([r.status, lastCheck(dir).reason], [2, "file_overlap"], r.stderr);
    assert.deepEqual(lastCheck(dir).files, ["src/../src/a.ts"], "logged raw");
    r = launch(dir, "SLICE: d\nFILES: ./src/b.ts\nDEPENDS: none");
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("not_in_plan: a planned glob covers only the files it matches; a planned folder covers what is under it", () => {
  const dir = project({ reviewed: false });
  try {
    plan(dir, "PLAN REVIEW\nSLICE: a\nFILES: **/*.ts\nDEPENDS: none\nGOAL: a\nSLICE: b\nFILES: lib/*.py, docs\nDEPENDS: none\nGOAL: b");
    let r = launch(dir, "SLICE: a\nFILES: src/a.py\nDEPENDS: none");
    assert.deepEqual([r.status, lastCheck(dir).reason], [2, "not_in_plan"], "src/a.py does not match **/*.ts");
    assert.match(r.stderr, /FILES outside its planned FILES: src\/a\.py/);
    r = launch(dir, "SLICE: a\nFILES: src/x/a.ts, b.ts, src/*.ts\nDEPENDS: none");
    assert.equal(r.status, 0, r.stderr);
    r = launch(dir, "SLICE: b\nFILES: lib/util.py, docs/x/y.md\nDEPENDS: none");
    assert.equal(r.status, 0, r.stderr);
    r = launch(dir, "SLICE: b\nFILES: lib/sub/util.py\nDEPENDS: none");
    assert.deepEqual([r.status, lastCheck(dir).reason], [2, "not_in_plan"], "* stays within one segment");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A preload that counts JSON.parse calls on text containing PARSE_MARK and writes the count to PARSE_OUT at exit. */
function parseCounter(/** @type {string} */ dir) {
  const f = join(dir, "count-parses.mjs");
  writeFileSync(
    f,
    `import { writeFileSync } from "node:fs";
const parse = JSON.parse;
let n = 0;
JSON.parse = function (text, ...rest) {
  if (typeof text === "string" && text.includes(process.env.PARSE_MARK)) n++;
  return parse.call(this, text, ...rest);
};
process.on("exit", () => writeFileSync(process.env.PARSE_OUT, String(n)));
`,
  );
  return f;
}

test("speed: the launch log and the skill-create log are not parsed for other sessions' lines", () => {
  const dir = project();
  try {
    const noise = Array.from({ length: 50 }, (_, i) => JSON.stringify({ ts: "t", session_id: "noise-session", decision: "allow", slice: `n${i}`, files: ["a.py"], run: "none-0", mark: "NOISEMARK" })).join("\n");
    writeFileSync(join(stateOf(dir), "plan-check.jsonl"), `${noise}\n{"session_id":"noise-session","mark":"NOISEMARK" broken\n`);
    writeFileSync(join(stateOf(dir), "skill-create.jsonl"), `${noise}\n`);
    const out = join(dir, "parses.txt");
    const env = { PARSE_MARK: "NOISEMARK", PARSE_OUT: out };
    const preload = parseCounter(dir);
    // Same decisions as before: other sessions' records own nothing here.
    let r = launch(dir, "SLICE: a\nFILES: a.py\nDEPENDS: none\nDRAFTS: some-skill", { preload, env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(out, "utf8"), "0", "no line of another session is parsed");
    r = launch(dir, "SLICE: b\nFILES: a.py\nDEPENDS: none", { preload, env });
    assert.deepEqual([r.status, lastCheck(dir).reason], [2, "file_overlap"], "this session's records still count");
    assert.equal(readFileSync(out, "utf8"), "0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock: a lock taken over by another launch is left in place; an own lock is released", () => {
  const dir = project();
  try {
    const lock = join(stateOf(dir), "plan-check.lock");
    // Between taking the lock and releasing it, another launch takes it over (as after a stale lock).
    const takeover = join(dir, "takeover.mjs");
    writeFileSync(
      takeover,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
const append = fs.appendFileSync;
fs.appendFileSync = function (path, ...rest) {
  if (String(path).endsWith("plan-check.jsonl") && fs.existsSync(${JSON.stringify(lock)})) {
    fs.rmSync(${JSON.stringify(lock)}, { recursive: true, force: true });
    fs.mkdirSync(${JSON.stringify(lock)});
    fs.writeFileSync(join(${JSON.stringify(lock)}, "intruder"), "x");
  }
  return append.call(this, path, ...rest);
};
syncBuiltinESMExports();
`,
    );
    const first = launch(dir, "SLICE: a\nFILES: a.py\nDEPENDS: none", { preload: takeover });
    assert.equal(first.status, 0, first.stderr);
    assert.ok(existsSync(lock), "the other launch's lock is not removed");
    assert.deepEqual(readdirSync(lock).filter((n) => n === "intruder"), ["intruder"]);
    rmSync(lock, { recursive: true, force: true });

    // Without a takeover the hook removes its own lock.
    assert.equal(launch(dir, "SLICE: c\nFILES: c.py\nDEPENDS: none").status, 0);
    assert.ok(!existsSync(lock), "own lock released");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lock: a removal that throws does not turn a block into a crash (exit 1 lets the launch through)", () => {
  const dir = project();
  try {
    assert.equal(launch(dir, "SLICE: a\nFILES: a.py\nDEPENDS: none").status, 0);
    const failing = join(dir, "failing-rm.mjs");
    writeFileSync(
      failing,
      `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rm = fs.rmSync;
fs.rmSync = function (path, ...rest) {
  if (String(path).endsWith("plan-check.lock")) throw new Error("EBUSY");
  return rm.call(this, path, ...rest);
};
syncBuiltinESMExports();
`,
    );
    const r = launch(dir, "SLICE: b\nFILES: a.py\nDEPENDS: none", { preload: failing });
    assert.equal(r.status, 2, r.stderr);
    assert.equal(lastCheck(dir).reason, "file_overlap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
