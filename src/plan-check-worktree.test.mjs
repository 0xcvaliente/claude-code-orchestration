// The plan check's worktree base check (worktree_base_not_head): an implementer launched with isolation "worktree"
// while the effective worktree.baseRef is not "head" and HEAD differs from origin's default branch is blocked twice,
// then let through. Temporary git repositories with an origin/HEAD ref; settings in a temp project and config dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS = ["state.mjs", "brief.mjs", "run.mjs", "plan-check.mjs", "builtin-agents.mjs"];

/** @param {string} dir @param {string[]} args */
const git = (dir, args) =>
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/**
 * A project (hooks, a finished plan review in session s1) that is also a git repository with two commits; origin's
 * default branch points at the first unless `originAt: "head"`, or is missing with `origin: false`.
 * @param {{ origin?: boolean, originAt?: 'first' | 'head' }} [o]
 */
function setup({ origin = true, originAt = "first" } = {}) {
  const top = mkdtempSync(join(tmpdir(), "pc-worktree-"));
  const dir = join(top, "project");
  const config = join(top, "config");
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  mkdirSync(config, { recursive: true });
  for (const h of HOOKS) copyFileSync(join(root, ".claude", "hooks", h), join(dir, ".claude", "hooks", h));
  writeFileSync(join(dir, ".claude", "state", "journal.jsonl"), `${JSON.stringify({ ts: "t", session_id: "s1", slice: "plan", role: "reviewer", status: "pass", agent_id: "r0" })}\n`);
  git(dir, ["init", "-q"]);
  writeFileSync(join(dir, "a.txt"), "1");
  git(dir, ["add", "a.txt"]);
  git(dir, ["commit", "-q", "-m", "one"]);
  const first = git(dir, ["rev-parse", "HEAD"]);
  writeFileSync(join(dir, "a.txt"), "2");
  git(dir, ["commit", "-q", "-am", "two"]);
  const head = git(dir, ["rev-parse", "HEAD"]);
  if (origin) {
    git(dir, ["update-ref", "refs/remotes/origin/main", originAt === "head" ? head : first]);
    git(dir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  }
  return { top, dir, config };
}

/** @param {string} file @param {unknown} value */
const writeJson = (file, value) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
};

/**
 * @param {{ dir: string, config: string }} s @param {Record<string, unknown>} toolInput
 * @param {{ cwd?: string | null, env?: Record<string, string> }} [o]
 */
function launch(s, toolInput, { cwd = s.dir, env = {} } = {}) {
  const base = { ...process.env };
  for (const k of Object.keys(base)) if (k.startsWith("ORCH_") || k.startsWith("CLAUDE_") || k.startsWith("GIT_")) delete base[k];
  const payload = { session_id: "s1", tool_name: "Agent", tool_input: toolInput, ...(cwd ? { cwd } : {}) };
  return spawnSync(process.execPath, [join(s.dir, ".claude", "hooks", "plan-check.mjs")], {
    input: JSON.stringify(payload),
    env: { ...base, CLAUDE_PROJECT_DIR: s.dir, CLAUDE_CONFIG_DIR: s.config, ORCH_SKILL_HINTS: "off", ORCH_SOURCES_NOTE: "off", ORCH_BUILTINS_FILE: "", ...env },
    encoding: "utf8",
  });
}
/** @param {string} slice @param {string} file */
const impl = (slice, file, isolation = "worktree") => ({ subagent_type: "implementer", isolation, prompt: `SLICE: ${slice}\nFILES: ${file}\nDEPENDS: none\nDo it.` });
/** @param {string} dir */
const log = (dir) => {
  const f = join(dir, ".claude", "state", "plan-check.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test("worktree base: blocked when baseRef is not set and HEAD is ahead of origin's default; twice, then given up", () => {
  const s = setup();
  try {
    const r1 = launch(s, impl("a", "x.py"));
    assert.equal(r1.status, 2);
    assert.match(r1.stderr, /remote default branch/);
    assert.match(r1.stderr, /miss the checked-out work/);
    assert.match(r1.stderr, /worktree\.baseRef/);
    assert.match(r1.stderr, /"head"/);
    assert.match(r1.stderr, /user settings/);
    assert.match(r1.stderr, /folder the session was started in/);
    assert.match(r1.stderr, /one after another without isolation/);
    assert.doesNotMatch(r1.stderr, /ORCH_/);
    assert.equal(launch(s, impl("a", "x.py")).status, 2, "second block");
    const r3 = launch(s, impl("a", "x.py"));
    assert.equal(r3.status, 0, "gave up on the third try");
    assert.deepEqual(
      log(s.dir).map((e) => e.reason),
      ["worktree_base_not_head", "worktree_base_not_head", "worktree_base_not_head_gave_up"],
    );
    assert.deepEqual(log(s.dir)[2].gave_up, ["worktree_base_not_head_gave_up"]);
    // The count is per slice: another slice is blocked again.
    assert.equal(launch(s, impl("b", "y.py")).status, 2);
  } finally {
    rmSync(s.top, { recursive: true, force: true });
  }
});

test("worktree base: blocked when the settings set baseRef to something other than head", () => {
  const s = setup();
  try {
    writeJson(join(s.config, "settings.json"), { worktree: { baseRef: "head" } });
    writeJson(join(s.dir, ".claude", "settings.json"), { worktree: { baseRef: "origin" } });
    assert.equal(launch(s, impl("a", "x.py")).status, 2, "the project's value comes first");
  } finally {
    rmSync(s.top, { recursive: true, force: true });
  }
});

test("worktree base: a worktree value that is not an object with a string baseRef counts as not set", () => {
  // Each malformed value alone (in the project settings, and in the user settings) is denied when HEAD is ahead.
  for (const value of ["head", [], null, {}, { baseRef: 5 }]) {
    for (const where of ["project", "user"]) {
      const s = setup();
      try {
        writeJson(where === "user" ? join(s.config, "settings.json") : join(s.dir, ".claude", "settings.json"), { worktree: value });
        const r = launch(s, impl("a", "x.py"));
        assert.equal(r.status, 2, `${where} ${JSON.stringify(value)}`);
        assert.equal(log(s.dir).at(-1).reason, "worktree_base_not_head");
      } finally {
        rmSync(s.top, { recursive: true, force: true });
      }
    }
  }
  // A malformed project file passes the lookup on: user settings that say head allow the launch.
  for (const value of ["head", [], null, {}, { baseRef: 5 }]) {
    const s = setup();
    try {
      writeJson(join(s.dir, ".claude", "settings.json"), { worktree: value });
      writeJson(join(s.config, "settings.json"), { worktree: { baseRef: "head" } });
      assert.equal(launch(s, impl("a", "x.py")).status, 0, JSON.stringify(value));
    } finally {
      rmSync(s.top, { recursive: true, force: true });
    }
  }
});

test("worktree base: allowed when the user, project or local settings say head", () => {
  for (const where of ["user", "project", "local"]) {
    const s = setup();
    try {
      const file =
        where === "user" ? join(s.config, "settings.json") : join(s.dir, ".claude", where === "local" ? "settings.local.json" : "settings.json");
      writeJson(file, { worktree: { baseRef: "head" } });
      if (where === "local") writeJson(join(s.dir, ".claude", "settings.json"), { worktree: { baseRef: "origin" } });
      const r = launch(s, impl("a", "x.py"));
      assert.equal(r.status, 0, where);
      assert.equal(r.stdout, "", where);
      assert.deepEqual(log(s.dir).map((e) => e.reason), ["ok"], where);
    } finally {
      rmSync(s.top, { recursive: true, force: true });
    }
  }
  // A project file that sets other keys but not worktree.baseRef passes the lookup on to the user settings.
  const s = setup();
  try {
    writeJson(join(s.dir, ".claude", "settings.json"), { permissions: {}, worktree: {} });
    writeJson(join(s.config, "settings.json"), { worktree: { baseRef: "head" } });
    assert.equal(launch(s, impl("a", "x.py")).status, 0);
  } finally {
    rmSync(s.top, { recursive: true, force: true });
  }
});

test("worktree base: allowed when HEAD equals origin's default, the ref is missing, or there is no isolation", () => {
  const same = setup({ originAt: "head" });
  const none = setup({ origin: false });
  const plain = setup();
  try {
    assert.equal(launch(same, impl("a", "x.py")).status, 0, "HEAD is origin's default");
    assert.equal(launch(none, impl("a", "x.py")).status, 0, "no origin/HEAD ref");
    assert.equal(launch(plain, impl("a", "x.py", "")).status, 0, "no isolation");
    assert.equal(launch(plain, { subagent_type: "implementer", prompt: "SLICE: b\nFILES: y.py\nDEPENDS: none" }).status, 0, "isolation left out");
    for (const s of [same, none, plain]) assert.ok(log(s.dir).every((e) => e.decision === "allow" && e.reason === "ok"));
  } finally {
    for (const s of [same, none, plain]) rmSync(s.top, { recursive: true, force: true });
  }
});

test("worktree base: what cannot be established behaves as today", () => {
  const s = setup();
  try {
    // Not a repository: the launch runs in a folder outside git.
    const outside = join(s.top, "outside");
    mkdirSync(outside);
    assert.equal(launch(s, impl("a", "x.py"), { cwd: outside }).status, 0, "not a repository");
    // No cwd in the input.
    assert.equal(launch(s, impl("b", "y.py"), { cwd: null }).status, 0, "no cwd");
    // An unreadable (broken) settings file.
    writeJson(join(s.dir, ".claude", "settings.local.json"), "{ not json");
    assert.equal(launch(s, impl("c", "z.py")).status, 0, "broken settings");
    assert.ok(log(s.dir).every((e) => e.reason === "ok"));
  } finally {
    rmSync(s.top, { recursive: true, force: true });
  }
});

test("worktree base: researcher and reviewer launches are never checked; file_overlap still comes first", () => {
  const s = setup();
  try {
    for (const type of ["researcher", "orchestration:researcher", "reviewer", "orchestration:reviewer"]) {
      const r = launch(s, { subagent_type: type, isolation: "worktree", prompt: "SLICE: a\nFILES: x.py\nCheck it." });
      assert.equal(r.status, 0, type);
      assert.equal(r.stdout, "", type);
    }
    assert.deepEqual(log(s.dir), [], "researchers and reviewers write no plan-check record");
    writeJson(join(s.config, "settings.json"), { worktree: { baseRef: "head" } });
    assert.equal(launch(s, impl("a", "x.py")).status, 0);
    rmSync(join(s.config, "settings.json"));
    const clash = launch(s, impl("b", "x.py"));
    assert.equal(clash.status, 2);
    assert.equal(log(s.dir).at(-1).reason, "file_overlap");
  } finally {
    rmSync(s.top, { recursive: true, force: true });
  }
});
