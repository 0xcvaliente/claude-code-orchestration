// plan-check.mjs: two names for one file (a symlink, or another case on a case-insensitive file system) are one file
// in file_overlap and not_in_plan, and the read router's budget stays under the hook's 60 s timeout. Driven end to end
// through the hook like src/plan-check-overlap.test.mjs: a throwaway project with the hooks copied in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = ["state.mjs", "brief.mjs", "run.mjs", "plan-check.mjs", "builtin-agents.mjs", "journal.mjs", "file-profile.mjs"];

/** A throwaway project whose plan review finished in session s1 (legacy, run-less), unless `reviewed` is false. */
function project({ reviewed = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "plan-paths-"));
  const hooks = join(dir, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of HOOKS) copyFileSync(join(root, ".claude", "hooks", h), join(hooks, h));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  if (reviewed) {
    writeFileSync(join(dir, ".claude", "state", "journal.jsonl"), `${JSON.stringify({ ts: "t", session_id: "s1", slice: "plan", role: "reviewer", status: "pass", agent_id: "r0" })}\n`);
  }
  return dir;
}
const stateOf = (/** @type {string} */ dir) => join(dir, ".claude", "state");

/** @param {string} dir @param {string} script @param {unknown} payload @param {Record<string, string>} [env] */
const run = (dir, script, payload, env = {}) => {
  /** @type {Record<string, string | undefined>} */
  const e = { ...process.env, CLAUDE_PROJECT_DIR: dir, ...env };
  if (!("ORCH_TEST_CASE_INSENSITIVE" in env)) delete e.ORCH_TEST_CASE_INSENSITIVE;
  return spawnSync("node", [join(dir, ".claude", "hooks", script)], { input: JSON.stringify(payload), env: e, encoding: "utf8" });
};
/** @param {string} dir @param {string} prompt @param {Record<string, string>} [env] */
const launch = (dir, prompt, env) => run(dir, "plan-check.mjs", { session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "implementer", prompt } }, env);
const lastOf = (/** @type {string} */ dir, /** @type {string} */ log) =>
  JSON.parse(readFileSync(join(stateOf(dir), log), "utf8").trim().split("\n").at(-1) ?? "null");
const lastCheck = (/** @type {string} */ dir) => lastOf(dir, "plan-check.jsonl");

/** Record a PLAN REVIEW launch and its passing stop through journal.mjs, which opens a planned run. @param {string} dir @param {string} text */
function plan(dir, text) {
  run(dir, "journal.mjs", { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "orchestration:reviewer", prompt: text }, tool_response: { status: "async_launched", agentId: "p1" } });
  run(dir, "journal.mjs", { hook_event_name: "SubagentStop", session_id: "s1", agent_id: "p1", agent_type: "orchestration:reviewer", last_assistant_message: "STATUS: pass" });
}

/** A project with src/a.ts on disk and `link` a symlink to the folder src. */
function linked(o = {}) {
  const dir = project(o);
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "a.ts"), "");
  symlinkSync(join(dir, "src"), join(dir, "link"));
  return dir;
}

/** Launch slice a with FILES `a`, then slice b with FILES `b` in `dir`; returns b's status and reason. */
function pairIn(/** @type {string} */ dir, /** @type {string} */ a, /** @type {string} */ b, /** @type {Record<string, string>} */ env = {}) {
  const first = launch(dir, `SLICE: a\nFILES: ${a}\nDEPENDS: none`, env);
  assert.equal(first.status, 0, first.stderr);
  const r = launch(dir, `SLICE: b\nFILES: ${b}\nDEPENDS: none`, env);
  return { status: r.status, stderr: r.stderr, reason: lastCheck(dir).reason };
}

test("file_overlap: a path through a symlink to a folder and the real path are one file, both ways", () => {
  for (const [a, b] of [["link/a.ts", "src/a.ts"], ["src/a.ts", "link/a.ts"], ["link", "src/a.ts"], ["src/*.ts", "link/a.ts"]]) {
    const dir = linked();
    try {
      const r = pairIn(dir, /** @type {string} */ (a), /** @type {string} */ (b));
      assert.deepEqual([r.status, r.reason], [2, "file_overlap"], `${a} then ${b}: ${r.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("file_overlap: a dangling link, a path not on disk yet and an unrelated file keep working as before", () => {
  const dir = linked();
  try {
    symlinkSync(join(dir, "nowhere"), join(dir, "dangling"));
    assert.equal(pairIn(dir, "dangling/x.ts", "src/a.ts").status, 0, "a dangling link is its own name");
    assert.equal(launch(dir, "SLICE: c\nFILES: new/b.ts\nDEPENDS: none").status, 0, "a path not on disk yet");
    const r = launch(dir, "SLICE: d\nFILES: dangling/x.ts\nDEPENDS: none");
    assert.deepEqual([r.status, lastCheck(dir).reason], [2, "file_overlap"], "the dangling name still overlaps itself");
    assert.equal(launch(dir, "SLICE: e\nFILES: link/b.ts\nDEPENDS: none").status, 0, "another file under the link");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("not_in_plan: a planned symlink covers the real path, and a planned real path covers the link", () => {
  for (const [planned, launched] of [["link", "src/a.ts"], ["src", "link/a.ts"], ["src/a.ts", "link/a.ts"]]) {
    const dir = linked({ reviewed: false });
    try {
      plan(dir, `PLAN REVIEW\nSLICE: a\nFILES: ${planned}\nDEPENDS: none\nGOAL: a`);
      const r = launch(dir, `SLICE: a\nFILES: ${launched}\nDEPENDS: none`);
      assert.equal(r.status, 0, `planned ${planned}, launched ${launched}: ${r.stderr}`);
      const o = launch(dir, "SLICE: a\nFILES: other/b.ts\nDEPENDS: none");
      assert.deepEqual([o.status, lastCheck(dir).reason], [2, "not_in_plan"], "a file outside the plan still blocks");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

// ORCH_TEST_CASE_INSENSITIVE is the test seam that replaces the hook's case probe (Linux file systems are case-sensitive).
const INSENSITIVE = { ORCH_TEST_CASE_INSENSITIVE: "1" };
const SENSITIVE = { ORCH_TEST_CASE_INSENSITIVE: "0" };

test("file_overlap: on a case-insensitive file system SRC/a.ts and src/a.ts are one file; on a case-sensitive one two", () => {
  for (const existing of [false, true]) {
    let dir = project();
    try {
      if (existing) {
        mkdirSync(join(dir, "src"));
        writeFileSync(join(dir, "src", "a.ts"), "");
      }
      const r = pairIn(dir, "src/a.ts", "SRC/a.ts", INSENSITIVE);
      assert.deepEqual([r.status, r.reason], [2, "file_overlap"], `insensitive, on disk ${existing}: ${r.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    dir = project();
    try {
      assert.equal(pairIn(dir, "src/a.ts", "SRC/a.ts", SENSITIVE).status, 0, "case-sensitive: two files");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("not_in_plan: on a case-insensitive file system a planned src/a.ts covers SRC/a.ts; on a case-sensitive one not", () => {
  let dir = project({ reviewed: false });
  try {
    plan(dir, "PLAN REVIEW\nSLICE: a\nFILES: src/a.ts\nDEPENDS: none\nGOAL: a");
    const r = launch(dir, "SLICE: a\nFILES: SRC/a.ts\nDEPENDS: none", INSENSITIVE);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  dir = project({ reviewed: false });
  try {
    plan(dir, "PLAN REVIEW\nSLICE: a\nFILES: src/a.ts\nDEPENDS: none\nGOAL: a");
    const r = launch(dir, "SLICE: a\nFILES: SRC/a.ts\nDEPENDS: none", SENSITIVE);
    assert.deepEqual([r.status, lastCheck(dir).reason], [2, "not_in_plan"], r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read router: the profiler budget is clamped at 40 s, under the hook's 60 s timeout", () => {
  for (const [asked, used] of [["59000", 40_000], ["40001", 40_000], ["3000", 3000]]) {
    const dir = project();
    try {
      writeFileSync(join(dir, "a.md"), "text\n");
      // A preload records the timeout the hook gives the profiler's child process (the hook's own spawnSync call).
      const seen = join(dir, "timeout.txt");
      const preload = join(dir, "spy.mjs");
      writeFileSync(
        preload,
        `import cp from "node:child_process"; import { writeFileSync } from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const real = cp.spawnSync;
cp.spawnSync = (cmd, args, opts) => { if (Array.isArray(args) && args.includes("--input-type=module")) writeFileSync(${JSON.stringify(seen)}, String(opts?.timeout)); return real(cmd, args, opts); };
syncBuiltinESMExports();\n`,
      );
      const r = spawnSync("node", ["--import", pathToFileURL(preload).href, join(dir, ".claude", "hooks", "plan-check.mjs")], {
        input: JSON.stringify({ session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "researcher", model: "sonnet", prompt: "SOURCES: a.md\nREAD: lookup\nFind x." } }),
        env: { ...process.env, CLAUDE_PROJECT_DIR: dir, ORCH_READ_ROUTER: "on", ORCH_READ_ROUTER_BUDGET_MS: /** @type {string} */ (asked) },
        encoding: "utf8",
      });
      assert.equal(r.status, 0, r.stderr);
      assert.equal(Number(readFileSync(seen, "utf8")), used, `asked ${asked}`);
      assert.equal(lastOf(dir, "reads-route.jsonl").decision !== "skip" || lastOf(dir, "reads-route.jsonl").reason !== "profiler_timeout", true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("file_overlap: a glob whose first wildcard segment matches a symlink to a folder overlaps the link's target, both ways", () => {
  for (const [a, b] of [["l*/a.ts", "src/a.ts"], ["src/a.ts", "l*/a.ts"], ["?ink/*.ts", "src/a.ts"]]) {
    const dir = linked();
    try {
      const r = pairIn(dir, /** @type {string} */ (a), /** @type {string} */ (b));
      assert.deepEqual([r.status, r.reason], [2, "file_overlap"], `${a} then ${b}: ${r.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("not_in_plan: a planned glob whose wildcard matches a symlink to a folder covers the link's target", () => {
  const dir = linked({ reviewed: false });
  try {
    plan(dir, "PLAN REVIEW\nSLICE: a\nFILES: l*/a.ts\nDEPENDS: none\nGOAL: a");
    const r = launch(dir, "SLICE: a\nFILES: src/a.ts\nDEPENDS: none");
    assert.equal(r.status, 0, r.stderr);
    const o = launch(dir, "SLICE: a\nFILES: src/b.ts\nDEPENDS: none");
    assert.deepEqual([o.status, lastCheck(dir).reason], [2, "not_in_plan"], "l*/a.ts does not cover src/b.ts");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file_overlap: past the alias cap a glob's names cannot be decided, so it overlaps", () => {
  const dir = project();
  try {
    for (let i = 0; i < 40; i++) {
      mkdirSync(join(dir, `d${i}`));
      symlinkSync(join(dir, `d${i}`), join(dir, `l${i}`));
    }
    const r = pairIn(dir, "l*/x.ts", "other/y.ts");
    assert.deepEqual([r.status, r.reason], [2, "file_overlap"], r.stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("file_overlap: with no symlink in the folder a glob is compared as before", () => {
  const dir = project();
  try {
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "lib"));
    writeFileSync(join(dir, "src", "a.ts"), "");
    assert.equal(pairIn(dir, "l*/a.ts", "src/a.ts").status, 0, "lib is a folder, not a link");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("out of reach: a symlink reached only through ** or a later wildcard is not seen as its target", () => {
  // **/link/a.ts matches link/a.ts, which is src/a.ts, yet both launches are allowed today; so is t*/l*/a.ts, whose
  // link sits behind the first wildcard segment.
  for (const [a, b] of [["**/link/a.ts", "src/a.ts"], ["t*/l*/a.ts", "src/a.ts"]]) {
    const dir = linked();
    try {
      mkdirSync(join(dir, "t1"));
      symlinkSync(join(dir, "src"), join(dir, "t1", "link"));
      assert.equal(pairIn(dir, /** @type {string} */ (a), /** @type {string} */ (b)).status, 0, `${a} then ${b}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("out of reach: a hard link to a file is another name the check does not see", () => {
  const dir = linked();
  try {
    linkSync(join(dir, "src", "a.ts"), join(dir, "h.ts"));
    assert.equal(pairIn(dir, "h.ts", "src/a.ts").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("out of reach: two Unicode normal forms of one name are two entries, even where the file system folds them", () => {
  const dir = project();
  try {
    assert.equal(pairIn(dir, "café.md", "café.md", INSENSITIVE).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * A preload that makes readdirSync throw `code` for the one folder `folder` (the tests run as root, so chmod 000 does not
 * deny the read); every other call goes to the real readdirSync.
 * @param {string} dir @param {string} folder @param {string} code
 */
function failingReaddir(dir, folder, code) {
  const preload = join(dir, "readdir-fails.mjs");
  writeFileSync(
    preload,
    `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";
const real = fs.readdirSync;
fs.readdirSync = (p, ...rest) => { if (String(p) === ${JSON.stringify(folder)}) throw Object.assign(new Error(${JSON.stringify(code)}), { code: ${JSON.stringify(code)} }); return real(p, ...rest); };
syncBuiltinESMExports();\n`,
  );
  return preload;
}
/** launch() with a preload. @param {string} dir @param {string} preload @param {string} prompt */
const launchWith = (dir, preload, prompt) => {
  /** @type {Record<string, string | undefined>} */
  const e = { ...process.env, CLAUDE_PROJECT_DIR: dir };
  delete e.ORCH_TEST_CASE_INSENSITIVE;
  return spawnSync("node", ["--import", pathToFileURL(preload).href, join(dir, ".claude", "hooks", "plan-check.mjs")], {
    input: JSON.stringify({ session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: "implementer", prompt } }),
    env: e,
    encoding: "utf8",
  });
};

test("file_overlap: a glob whose fixed folder cannot be listed (EACCES) cannot be decided, so it overlaps, both ways", () => {
  for (const [a, b] of [["sec/l*/a.ts", "other/b.ts"], ["other/b.ts", "sec/l*/a.ts"]]) {
    const dir = project();
    try {
      mkdirSync(join(dir, "sec"));
      const preload = failingReaddir(dir, realpathSync(join(dir, "sec")), "EACCES");
      const first = launchWith(dir, preload, `SLICE: a\nFILES: ${a}\nDEPENDS: none`);
      assert.equal(first.status, 0, first.stderr);
      const r = launchWith(dir, preload, `SLICE: b\nFILES: ${b}\nDEPENDS: none`);
      assert.deepEqual([r.status, lastCheck(dir).reason], [2, "file_overlap"], `${a} then ${b}: ${r.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("file_overlap: a missing fixed folder (ENOENT) or one that is a file (ENOTDIR) adds no aliases, so the pair is allowed", () => {
  for (const kind of ["missing", "file"]) {
    for (const [a, b] of [["sec/l*/a.ts", "other/b.ts"], ["other/b.ts", "sec/l*/a.ts"]]) {
      const dir = project();
      try {
        if (kind === "file") writeFileSync(join(dir, "sec"), "");
        const r = pairIn(dir, /** @type {string} */ (a), /** @type {string} */ (b));
        assert.equal(r.status, 0, `${kind}: ${a} then ${b}: ${r.stderr}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

// A run that planned slice a with FILES sec/l*/a.ts, where sec/lnk is a symlink to the folder real (real/a.ts on disk).
function plannedSec() {
  const dir = project({ reviewed: false });
  mkdirSync(join(dir, "sec"));
  mkdirSync(join(dir, "real"));
  writeFileSync(join(dir, "real", "a.ts"), "");
  symlinkSync(join(dir, "real"), join(dir, "sec", "lnk"));
  plan(dir, "PLAN REVIEW\nSLICE: a\nFILES: sec/l*/a.ts\nDEPENDS: none\nGOAL: a");
  return { dir, preload: failingReaddir(dir, realpathSync(join(dir, "sec")), "EACCES") };
}

test("not_in_plan: a planned glob whose fixed folder cannot be listed covers only what the glob's text matches", () => {
  // Listed, the planned sec/l*/a.ts also covers real/a.ts (its alias through sec/lnk). Unlisted (EACCES) that alias
  // cannot be shown, so a launch of sec/lnk/a.ts (which canon() resolves to real/a.ts) or real/a.ts is refused.
  // One project per refused launch: the loop guard lets a slice through after two not_in_plan blocks.
  for (const f of ["sec/lnk/a.ts", "real/a.ts", "other/b.ts"]) {
    const { dir, preload } = plannedSec();
    try {
      const r = launchWith(dir, preload, `SLICE: a\nFILES: ${f}\nDEPENDS: none`);
      assert.deepEqual([r.status, lastCheck(dir).reason], [2, "not_in_plan"], `${f} cannot be shown covered: ${r.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const { dir, preload } = plannedSec();
  try {
    const ok = launchWith(dir, preload, "SLICE: a\nFILES: sec/lx/a.ts\nDEPENDS: none");
    assert.equal(ok.status, 0, `sec/lx/a.ts matches the planned glob's text: ${ok.stderr}`);
    const listed = launch(dir, "SLICE: a\nFILES: sec/lnk/a.ts\nDEPENDS: none");
    assert.equal(listed.status, 0, `listed, the alias covers sec/lnk/a.ts: ${listed.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
