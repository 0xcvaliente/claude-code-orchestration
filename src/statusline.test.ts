import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../statusline/statusline.sh", import.meta.url));
const hasJq = spawnSync("jq", ["--version"]).status === 0;
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

test("statusline shows model, folder, changed lines, rate limit and context fill", { skip: !hasJq && "jq not installed" }, () => {
  const input = JSON.stringify({
    model: { display_name: "Sonnet 5.5" },
    workspace: { current_dir: "/work/demo-project" },
    context_window: { used_percentage: 34.2 },
    cost: { total_lines_added: 3, total_lines_removed: 1 },
    rate_limits: { five_hour: { used_percentage: 4, resets_at: Math.floor(Date.now() / 1000) + 7300 } },
  });
  const r = spawnSync("bash", [script], { input, encoding: "utf8", cwd: "/" });
  assert.equal(r.status, 0, r.stderr);
  const out = plain(r.stdout);
  assert.match(out, /\[Sonnet 5\.5\] .* demo-project/);
  assert.match(out, /\+3 -1/);
  assert.match(out, /\[5h\] \(2h left\) .* 4%/);
  assert.match(out, /\[ctx\] .* 34%/);
});

test("statusline prints only the model line before any rate limit is reported", { skip: !hasJq && "jq not installed" }, () => {
  const input = JSON.stringify({ model: { display_name: "Opus" }, workspace: { current_dir: "/a/b" }, context_window: {}, cost: {} });
  const r = spawnSync("bash", [script], { input, encoding: "utf8", cwd: "/" });
  assert.equal(r.status, 0, r.stderr);
  const lines = plain(r.stdout).trimEnd().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[1] ?? "", /^\[ctx\] .* 0%$/);
});

test("statusline without jq prints a fallback line and exits 0", () => {
  // a PATH holding the basics but no jq
  const dir = mkdtempSync(join(tmpdir(), "nojq-"));
  try {
    for (const t of ["bash", "cat", "git", "date", "cut", "wc", "tr", "dirname"]) {
      const p = spawnSync("sh", ["-c", `command -v ${t}`], { encoding: "utf8" }).stdout.trim();
      if (p) symlinkSync(p, join(dir, t));
    }
    const input = JSON.stringify({ model: { display_name: "Opus" }, workspace: { current_dir: "/a/b" }, context_window: { used_percentage: 40 } });
    const r = spawnSync(join(dir, "bash"), [script], { input, encoding: "utf8", cwd: "/", env: { PATH: dir } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(plain(r.stdout), /jq/);
    assert.equal(r.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const skipNoJq = { skip: !hasJq && "jq not installed" };
const base = { model: { display_name: "Opus" }, workspace: { current_dir: "/a/b" }, context_window: { used_percentage: 12 }, cost: {} };
const run = (input: unknown, opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) =>
  spawnSync("bash", [script], { input: JSON.stringify(input), encoding: "utf8", cwd: opts.cwd ?? "/", env: opts.env ?? process.env, timeout: 10000 });
const gitIn = (dir: string, ...args: string[]) => spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });

test("statusline: a non-numeric line count or reset time prints no shell error", skipNoJq, () => {
  const r = run({ ...base, cost: { total_lines_added: "many", total_lines_removed: "x" }, rate_limits: { five_hour: { used_percentage: 4, resets_at: "soon" }, seven_day: { used_percentage: 9, resets_at: "2026-12-01T00:00:00Z" } } });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
  const out = plain(r.stdout);
  assert.doesNotMatch(out, /\+many/);
  assert.match(out, /\[5h\] ○ .* 4%/);
  assert.match(out, /\[7d\] .* 9%/);
  // a fractional epoch still counts down
  const f = run({ ...base, rate_limits: { five_hour: { used_percentage: 4, resets_at: Math.floor(Date.now() / 1000) + 7300.5 } } });
  assert.equal(f.stderr, "");
  assert.match(plain(f.stdout), /\[5h\] \(2h left\) .* 4%/);
});

test("statusline: the 7-day window is labelled with its reset date", skipNoJq, () => {
  const reset = Date.UTC(2027, 2, 5, 12) / 1000; // 5 March 2027, noon UTC
  const r = run({ ...base, rate_limits: { seven_day: { used_percentage: 20, resets_at: reset } } }, { env: { ...process.env, TZ: "UTC" } });
  assert.equal(r.stderr, "");
  assert.match(plain(r.stdout), /\[Mar 5\] \(\d+d left\) .* 20%/);
});

test("statusline: the dirty count leaves out untracked files", skipNoJq, () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-git-"));
  try {
    gitIn(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    gitIn(dir, "add", "a.txt");
    gitIn(dir, "commit", "-q", "-m", "a");
    writeFileSync(join(dir, "a.txt"), "changed\n");
    writeFileSync(join(dir, "new1.txt"), "n\n");
    writeFileSync(join(dir, "new2.txt"), "n\n");
    const r = run(base, { cwd: dir });
    assert.equal(r.stderr, "");
    assert.match(plain(r.stdout), /🌿 main \*1\b/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("statusline: a git status that stalls is cut off after about a second, without the dirty count", skipNoJq, () => {
  const dir = mkdtempSync(join(tmpdir(), "sl-slowgit-"));
  try {
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const bin = join(dir, "bin");
    const repo = join(dir, "repo");
    spawnSync("mkdir", ["-p", bin, repo]);
    gitIn(repo, "init", "-q", "-b", "main");
    writeFileSync(join(repo, "a.txt"), "a\n");
    gitIn(repo, "add", "a.txt");
    gitIn(repo, "commit", "-q", "-m", "a");
    writeFileSync(join(repo, "a.txt"), "changed\n");
    const log = join(dir, "status-args");
    // a git whose status records its arguments, then hangs for 5 seconds
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do case "$a" in status) printf '%s\\n' "$*" >> "${log}"; sleep 5; exit 0;; esac; done\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const t0 = Date.now();
    const r = run(base, { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const ms = Date.now() - t0;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.ok(ms < 3000, `took ${ms} ms`);
    const out = plain(r.stdout);
    assert.match(out, /🌿 main(?! \*)/);
    assert.match(out, /\[ctx\] .* 12%/);
    const args = readFileSync(log, "utf8");
    assert.match(args, /--no-optional-locks/);
    assert.match(args, /--untracked-files=no/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("statusline: a git status cut off at the limit is killed, with everything it started", skipNoJq, () => {
  const marker = `slmark${process.pid}x${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), `${marker}-`));
  const alive = () =>
    spawnSync("ps", ["-A", "-o", "args="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((l) => l.includes(marker));
  try {
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const bin = join(dir, "bin");
    const repo = join(dir, "repo");
    spawnSync("mkdir", ["-p", bin, repo]);
    gitIn(repo, "init", "-q", "-b", "main");
    // a git whose status starts a child (carrying the marker too) and waits on it for 30 seconds
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do case "$a" in status) sh -c 'sleep 30; : ${marker}'; exit 0;; esac; done\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const t0 = Date.now();
    const r = run(base, { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const ms = Date.now() - t0;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.ok(ms < 3000, `took ${ms} ms`);
    assert.match(plain(r.stdout), /🌿 main/);
    spawnSync("sleep", ["0.3"]);
    assert.deepEqual(alive(), []);
  } finally {
    spawnSync("pkill", ["-f", marker]);
    rmSync(dir, { recursive: true, force: true });
  }
});
