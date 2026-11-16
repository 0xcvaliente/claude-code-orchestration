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

// G-7 (audit 2026-11-16): b DEPENDS on a and shares a's file. A fresh retry of a must go through, with its own DEPENDS
// line or with the DEPENDS: b the overlap message used to advise; a real overlap and a real cycle still block every time.
const SEQ = "PLAN REVIEW\nSLICE: a\nFILES: f.txt\nDEPENDS: none\nGOAL: a\nSLICE: b\nFILES: f.txt\nDEPENDS: a\nGOAL: b\nSLICE: c\nFILES: f.txt\nDEPENDS: none\nGOAL: c";
test("file_overlap and dependency_cycle: a retry of a slice that a later slice DEPENDS on goes through", () => {
  const dir = project({ reviewed: false });
  try {
    plan(dir, SEQ);
    for (const [s, d] of [["a", "none"], ["b", "a"], ["a", "none"], ["a", "none"], ["a", "b"], ["a", "b"], ["b", "a"]]) {
      const r = launch(dir, `SLICE: ${s}\nFILES: f.txt\nDEPENDS: ${d}`);
      assert.deepEqual([r.status, lastCheck(dir).reason], [0, "ok"], `launch ${s} DEPENDS ${d}: ${r.stderr}`);
    }
    // A retry's line replaces its earlier one: b with DEPENDS: none would no longer run after a (the base blocked it too).
    const loose = launch(dir, "SLICE: b\nFILES: f.txt\nDEPENDS: none");
    assert.deepEqual([loose.status, lastCheck(dir).reason], [2, "file_overlap"], loose.stderr);
    assert.match(loose.stderr, /f\.txt \(owned by a\)/);
    // c shares f.txt with a and b and is ordered against neither: a real overlap, blocked every time.
    for (let i = 0; i < 3; i++) {
      const r = launch(dir, "SLICE: c\nFILES: f.txt\nDEPENDS: none");
      assert.deepEqual([r.status, lastCheck(dir).reason], [2, "file_overlap"], r.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file_overlap: a retry's DEPENDS on a slice ordered after it adds no order for a later slice", () => {
  const dir = project({ reviewed: false });
  try {
    plan(dir, "PLAN REVIEW\nSLICE: a\nFILES: f.txt\nDEPENDS: none\nGOAL: a\nSLICE: b\nFILES: f.txt\nDEPENDS: a\nGOAL: b\nSLICE: c\nFILES: f.txt\nDEPENDS: a\nGOAL: c");
    for (const [s, d] of [["a", "none"], ["b", "a"], ["a", "none"], ["a", "b"], ["b", "a"], ["a", "b"]]) {
      const r = launch(dir, `SLICE: ${s}\nFILES: f.txt\nDEPENDS: ${d}`);
      assert.deepEqual([r.status, lastCheck(dir).reason], [0, "ok"], `launch ${s} DEPENDS ${d}: ${r.stderr}`);
    }
    // c and b both come after a and are not ordered against each other: a real overlap, every time.
    for (let i = 0; i < 3; i++) {
      const r = launch(dir, "SLICE: c\nFILES: f.txt\nDEPENDS: a");
      assert.deepEqual([r.status, lastCheck(dir).reason], [2, "file_overlap"], r.stderr);
      assert.match(r.stderr, /f\.txt \(owned by b\)/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file_overlap and dependency_cycle: a transitive dependant is ordered after the retried slice; a real cycle still blocks", () => {
  const dir = project({ reviewed: false });
  try {
    plan(dir, "PLAN REVIEW\nSLICE: a\nFILES: f.txt\nDEPENDS: none\nGOAL: a\nSLICE: m\nFILES: m.txt\nDEPENDS: a\nGOAL: m\nSLICE: b\nFILES: f.txt\nDEPENDS: m\nGOAL: b\nSLICE: x\nFILES: x.txt\nDEPENDS: y\nGOAL: x\nSLICE: y\nFILES: y.txt\nDEPENDS: x\nGOAL: y");
    for (const [s, f, d] of [["a", "f.txt", "none"], ["m", "m.txt", "a"], ["b", "f.txt", "m"], ["a", "f.txt", "none"], ["a", "f.txt", "b"], ["x", "x.txt", "y"]]) {
      const r = launch(dir, `SLICE: ${s}\nFILES: ${f}\nDEPENDS: ${d}`);
      assert.deepEqual([r.status, lastCheck(dir).reason], [0, "ok"], `launch ${s} DEPENDS ${d}: ${r.stderr}`);
    }
    for (let i = 0; i < 3; i++) {
      const r = launch(dir, "SLICE: y\nFILES: y.txt\nDEPENDS: x");
      assert.deepEqual([r.status, lastCheck(dir).reason], [2, "dependency_cycle"], r.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// G-7, third attempt: one order graph for both checks. Each slice's edges are the DEPENDS of its latest allowed launch (a
// retry replaces its earlier line); a retry's entry naming a slice that already leads back to it is dropped.
const ABC = "PLAN REVIEW\nSLICE: a\nFILES: f.txt\nDEPENDS: none\nGOAL: a\nSLICE: b\nFILES: f.txt\nDEPENDS: a\nGOAL: b\nSLICE: c\nFILES: f.txt\nDEPENDS: a\nGOAL: c";
/**
 * Launch each [slice, DEPENDS, FILES] in a fresh planned run; every launch but the last must be allowed; returns the last.
 * @param {string} planText @param {[string, string, string?][]} seq
 */
function walk(planText, seq) {
  const dir = project({ reviewed: false });
  try {
    plan(dir, planText);
    /** @type {{ status: number | null, stderr: string, reason: string }} */
    let out = { status: null, stderr: "", reason: "" };
    seq.forEach(([s, d, f = "f.txt"], i) => {
      const r = launch(dir, `SLICE: ${s}\nFILES: ${f}\nDEPENDS: ${d}`);
      out = { status: r.status, stderr: r.stderr, reason: lastCheck(dir).reason };
      if (i < seq.length - 1) assert.deepEqual([out.status, out.reason], [0, "ok"], `launch ${i + 1}, ${s} DEPENDS ${d}: ${out.stderr}`);
    });
    return out;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("file_overlap (G-7): a retry's DEPENDS on its dependant orders nothing for a later slice", () => {
  const r = walk(ABC, [["a", "none"], ["b", "a"], ["a", "b"], ["c", "a"]]);
  assert.deepEqual([r.status, r.reason], [2, "file_overlap"], r.stderr);
  assert.match(r.stderr, /f\.txt \(owned by b\)/);
});

test("file_overlap (G-7): an edge of a superseded launch orders nothing", () => {
  const r = walk(ABC, [["a", "b"], ["a", "none"], ["b", "a"], ["c", "a"]]);
  assert.deepEqual([r.status, r.reason], [2, "file_overlap"], r.stderr);
  assert.match(r.stderr, /f\.txt \(owned by b\)/);
});

test("file_overlap (G-7): the retry of a slice that b DEPENDS on goes through, with DEPENDS: none or DEPENDS: b", () => {
  for (const d of ["none", "b"]) {
    const r = walk(ABC, [["a", "none"], ["b", "a"], ["a", d]]);
    assert.deepEqual([r.status, r.reason], [0, "ok"], `retry a DEPENDS ${d}: ${r.stderr}`);
  }
  const again = walk(ABC, [["a", "none"], ["b", "a"], ["a", "b"], ["a", "none"], ["a", "b"]]);
  assert.deepEqual([again.status, again.reason], [0, "ok"], again.stderr);
});

test("dependency_cycle and file_overlap (G-7): a cycle of first launches and an overlap with no order still block", () => {
  const cyc = "PLAN REVIEW\nSLICE: x\nFILES: f.txt\nDEPENDS: y\nGOAL: x\nSLICE: y\nFILES: f.txt\nDEPENDS: x\nGOAL: y";
  const r1 = walk(cyc, [["x", "y"], ["y", "x"]]);
  assert.deepEqual([r1.status, r1.reason], [2, "dependency_cycle"], r1.stderr);
  const plain = "PLAN REVIEW\nSLICE: a\nFILES: f.txt\nDEPENDS: none\nGOAL: a\nSLICE: c\nFILES: f.txt\nDEPENDS: none\nGOAL: c";
  const r2 = walk(plain, [["a", "none"], ["c", "none"]]);
  assert.deepEqual([r2.status, r2.reason], [2, "file_overlap"], r2.stderr);
  assert.match(r2.stderr, /f\.txt \(owned by a\)/);
});

test("file_overlap (G-7): a retry that drops the only order between two slices sharing a file is blocked", () => {
  // x and y share f.txt and are ordered only through s (x DEPENDS s, s DEPENDS y); s owns another file.
  const p = "PLAN REVIEW\nSLICE: y\nFILES: f.txt\nDEPENDS: none\nGOAL: y\nSLICE: s\nFILES: g.txt\nDEPENDS: y\nGOAL: s\nSLICE: x\nFILES: f.txt\nDEPENDS: s\nGOAL: x";
  const head = /** @type {[string, string, string?][]} */ ([["y", "none"], ["s", "y", "g.txt"], ["x", "s"]]);
  const dropped = walk(p, [...head, ["s", "none", "g.txt"]]);
  assert.deepEqual([dropped.status, dropped.reason], [2, "file_overlap"], dropped.stderr);
  assert.match(dropped.stderr, /x and y/);
  const kept = walk(p, [...head, ["s", "y", "g.txt"]]);
  assert.deepEqual([kept.status, kept.reason], [0, "ok"], kept.stderr);
});

/** planOrder, lifted out of the hook's source: the hook runs on import, so the test cannot import it. */
function liftPlanOrder() {
  const src = readFileSync(join(root, ".claude", "hooks", "plan-check.mjs"), "utf8");
  const m = src.match(/^function planOrder\([\s\S]*?^}$/m);
  assert.ok(m, "plan-check.mjs defines function planOrder");
  return new Function(`${m[0]}\nreturn planOrder;`)();
}

test("file_overlap and dependency_cycle (G-7): every sequence of up to four launches of three slices sharing one file", () => {
  const planOrder = liftPlanOrder();
  const S = ["a", "b", "c"];
  /** Reachability of its own, not the hook's. @param {Map<string, string[]>} g @param {string} from @param {string} to */
  const leads = (g, from, to) => {
    const seen = new Set();
    const todo = [...(g.get(from) ?? [])];
    while (todo.length) {
      const n = /** @type {string} */ (todo.pop());
      if (n === to) return true;
      if (!seen.has(n)) {
        seen.add(n);
        todo.push(...(g.get(n) ?? []));
      }
    }
    return false;
  };
  // Every launch: one of the three slices with each possible DEPENDS line over the other two (none, one, both).
  const choices = S.flatMap((s) => {
    const o = S.filter((x) => x !== s);
    return [[], o.slice(0, 1), o.slice(1), o].map((depends) => ({ slice: s, depends }));
  });
  const started = Date.now();
  let decisions = 0;
  /** @param {{ slice: string, depends: string[] }[]} history allowed launches so far @param {number} left */
  const step = (history, left) => {
    if (left === 0) return;
    for (const c of choices) {
      decisions++;
      const at = `${JSON.stringify(history)} + ${JSON.stringify(c)}`;
      const r = planOrder(history, c.slice, c.depends);
      const before = new Set(history.map((e) => e.slice));
      const all = [...new Set([...before, c.slice])];
      const blocked = r.cycle || r.unordered.length > 0 || r.lost.length > 0;
      // Blocked exactly when the launch closes a cycle or leaves two launched slices (all share f.txt) in no order.
      const cycle = leads(r.graph, c.slice, c.slice);
      const loose = all.some((x) => all.some((y) => x < y && !leads(r.graph, x, y) && !leads(r.graph, y, x)));
      assert.equal(blocked, cycle || loose, at);
      if (before.has(c.slice)) {
        // A retry is never blocked by a slice that depends on it, and its DEPENDS on such a slice is no cycle.
        const dependants = S.filter((x) => x !== c.slice && before.has(x) && leads(r.prior, x, c.slice));
        assert.equal(r.cycle, false, at);
        for (const x of dependants) assert.ok(!r.unordered.includes(x), `blocked by its dependant ${x}: ${at}`);
        // The G-7 retry itself: its latest line, plus any or all of its dependants, goes through.
        const latest = history.filter((e) => e.slice === c.slice).at(-1)?.depends ?? [];
        const own = latest.filter((d) => !leads(r.prior, d, c.slice));
        for (const extra of [[], dependants]) {
          const again = planOrder(history, c.slice, [...own, ...extra]);
          assert.ok(!again.cycle && !again.unordered.length && !again.lost.length, `G-7 retry of ${c.slice} with ${extra}: ${JSON.stringify(history)}`);
        }
      }
      if (blocked) {
        step(history, left - 1);
        continue;
      }
      const next = [...history, c];
      // The graph the next decision starts from is the one this decision allowed, and it orders every two slices.
      assert.deepEqual(planOrder(next, "z", []).prior, r.graph, at);
      for (const x of all) for (const y of all) if (x < y) assert.ok(leads(r.graph, x, y) || leads(r.graph, y, x), `${x} ${y}: ${at}`);
      step(next, left - 1);
    }
  };
  step([], 4);
  const ms = Date.now() - started;
  assert.equal(decisions, 12 + 12 ** 2 + 12 ** 3 + 12 ** 4, "every sequence of up to four launches");
  assert.ok(ms < 10_000, `the walk took ${ms} ms`);
  console.log(`# G-7 walk: ${decisions} launch decisions in ${ms} ms`);
});
