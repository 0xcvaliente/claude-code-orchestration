// mergeAll after a conflict: a `git merge --abort` that fails must not leave the tree mid-merge, and no further branch
// may be merged into a half-merged tree. Observed live: the abort failed with "Entry '<file>' not uptodate. Cannot
// merge." because a file the merge had written changed its timestamps (content unchanged) before the abort ran.
// A `git` shim first on PATH reproduces that: before the real abort (or `reset --merge`) it touches such a file.
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeAll } from "./git.js";

const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();

const SHIM = `#!/bin/sh
# Before an abort or a reset --merge, change the timestamps of a file the merge wrote, as an outside process did live.
# SHIM_EVERY=1: every time, with a new timestamp each time; otherwise only the first time (the marker file counts).
case "$1 $2" in
  "merge --abort"|"reset --merge")
    if [ "$SHIM_EVERY" = 1 ] || [ ! -e "$SHIM_MARK" ]; then
      n=$(cat "$SHIM_MARK" 2>/dev/null | wc -c | tr -d ' ')
      printf x >> "$SHIM_MARK"
      touch -t "2020010100$(printf %02d "$n")" "$SHIM_TOUCH"
    fi
    ;;
esac
exec "$REAL_GIT" "$@"
`;

function sh(dir: string, ...args: string[]) {
  return execFileSync(REAL_GIT, args, { cwd: dir, encoding: "utf8" }).trim();
}

/** main and two branches: `conflict` conflicts on a.txt and changes b.txt cleanly; `clean` adds c.txt. */
function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "git-abort-"));
  const g = (...a: string[]) => sh(dir, "-c", "user.name=t", "-c", "user.email=t@localhost", ...a);
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "base\n");
  writeFileSync(join(dir, "b.txt"), "one\n");
  g("add", ".");
  g("commit", "-qm", "base");
  g("checkout", "-qb", "conflict");
  writeFileSync(join(dir, "a.txt"), "conflict\n");
  writeFileSync(join(dir, "b.txt"), "two\n");
  g("commit", "-qam", "conflict");
  g("checkout", "-q", "main");
  g("checkout", "-qb", "clean");
  writeFileSync(join(dir, "c.txt"), "new\n");
  g("add", "c.txt");
  g("commit", "-qm", "clean");
  g("checkout", "-q", "main");
  writeFileSync(join(dir, "a.txt"), "main\n");
  g("commit", "-qam", "main");
  return dir;
}

const mergeInProgress = (dir: string) =>
  spawnSync(REAL_GIT, ["rev-parse", "-q", "--verify", "MERGE_HEAD"], { cwd: dir }).status === 0;
const isAncestor = (dir: string, branch: string) =>
  spawnSync(REAL_GIT, ["merge-base", "--is-ancestor", branch, "HEAD"], { cwd: dir }).status === 0;

/** Run fn with the shim first on PATH (mergeAll's execFile resolves `git` through process.env.PATH). */
async function withShim<T>(dir: string, every: boolean, fn: () => Promise<T>): Promise<T> {
  const bin = mkdtempSync(join(tmpdir(), "git-shim-"));
  writeFileSync(join(bin, "git"), SHIM);
  chmodSync(join(bin, "git"), 0o755);
  const saved = { ...process.env };
  Object.assign(process.env, {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    REAL_GIT,
    SHIM_MARK: join(bin, "touched"),
    SHIM_TOUCH: join(dir, "b.txt"),
    SHIM_EVERY: every ? "1" : "0",
  });
  try {
    return await fn();
  } finally {
    for (const k of ["PATH", "REAL_GIT", "SHIM_MARK", "SHIM_TOUCH", "SHIM_EVERY"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(bin, { recursive: true, force: true });
  }
}

test("the shim reproduces the live failure: the plain abort fails with 'not uptodate' and the merge stays", async () => {
  const dir = makeRepo();
  try {
    assert.notEqual(spawnSync(REAL_GIT, ["-c", "user.name=t", "-c", "user.email=t@localhost", "merge", "--no-ff", "-m", "m", "conflict"], { cwd: dir }).status, 0);
    const r = await withShim(dir, false, async () => spawnSync("git", ["merge", "--abort"], { cwd: dir, encoding: "utf8", env: process.env }));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /not uptodate/);
    assert.ok(mergeInProgress(dir), "the failed abort leaves the merge in progress");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeAll: a failed abort is retried after an index refresh; no merge is left in progress and the next branch merges", async () => {
  const dir = makeRepo();
  try {
    const res = await withShim(dir, false, () => mergeAll(dir, ["conflict", "clean"]));
    assert.ok(!mergeInProgress(dir), "no merge left in progress");
    assert.deepEqual(res, { merged: ["clean"], conflicted: ["conflict"] });
    assert.ok(isAncestor(dir, "clean"));
    assert.ok(!isAncestor(dir, "conflict"));
    assert.equal(sh(dir, "status", "--porcelain"), "", "the tree is clean");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("mergeAll: when every abort and the reset --merge fail, it throws and merges no further branch", async () => {
  const dir = makeRepo();
  try {
    const head = sh(dir, "rev-parse", "HEAD");
    await assert.rejects(withShim(dir, true, () => mergeAll(dir, ["conflict", "clean"])), /merge.*in progress/i);
    assert.ok(!isAncestor(dir, "clean"), "the second branch is not merged into a half-merged tree");
    assert.equal(sh(dir, "rev-parse", "HEAD"), head);
    assert.ok(!existsSync(join(dir, "c.txt")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
