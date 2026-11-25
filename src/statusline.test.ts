import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

test("statusline: a backslash in the folder or model name is printed as it is", skipNoJq, () => {
  // echo -e read `\c` as "stop here": the folder's rest, the line counts and the newline were lost.
  const r = run({ ...base, model: { display_name: "Op\\tus" }, workspace: { current_dir: "/x/my\\cproj" }, cost: { total_lines_added: 3, total_lines_removed: 1 } });
  assert.equal(r.status, 0, r.stderr);
  const lines = plain(r.stdout).split("\n");
  assert.equal(lines[0], "[Op\\tus] 📁 my\\cproj | +3 -1");
  assert.match(lines[1] ?? "", /^\[ctx\] .* 12%$/);
  assert.equal(lines.length, 3, "two lines, each ending in a newline");
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
    // a git whose status records its arguments, then hangs for 60 seconds: the script ending well before that shows the
    // cut-off. (It hung 5 s and the bound was 3 s: on a loaded machine the 1 s watchdog itself started late and the
    // status ran out its 5 s, 2.1.0 probe.)
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do case "$a" in status) printf '%s\\n' "$*" >> "${log}"; sleep 60; exit 0;; esac; done\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const t0 = Date.now();
    const r = run(base, { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    const ms = Date.now() - t0;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.ok(ms < 30000, `took ${ms} ms: cut off, not the 60 s status (about 1 s on an idle machine)`);
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
    // 20 s, not 3 s: far under the 30 s the stalled status runs, so the cut-off still shows on a loaded machine.
    assert.ok(ms < 20000, `took ${ms} ms`);
    assert.match(plain(r.stdout), /🌿 main/);
    // polled for up to 10 s (was one look after 0.3 s): still well before the status's 30 s
    for (const end = Date.now() + 10000; alive().length && Date.now() < end; ) spawnSync("sleep", ["0.2"]);
    assert.deepEqual(alive(), []);
  } finally {
    spawnSync("pkill", ["-f", marker]);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("statusline: killed during a stalled git status, it leaves no process and no temp file behind", skipNoJq, async () => {
  const marker = `slterm${process.pid}x${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), `${marker}-`));
  const alive = () =>
    spawnSync("ps", ["-A", "-o", "args="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((l) => l.includes(marker));
  try {
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const bin = join(dir, "bin");
    const repo = join(dir, "repo");
    const tmp = join(dir, "tmp");
    spawnSync("mkdir", ["-p", bin, repo, tmp]);
    gitIn(repo, "init", "-q", "-b", "main");
    // The stalled status itself sends the script its SIGTERM (its parent: the script starts git as a job), so the kill
    // always lands while the status runs. Killed from the test after a fixed 500 ms, or after a ps poll, the kill could
    // come after the script's own 1 s cut-off on a loaded machine (2.1.0 probe: 5 of 5 side-by-side runs failed). It
    // waits until the script has started its watchdog (a second child; counted with ps, as macOS pgrep leaves out its
    // own ancestors), so the script has stored git's job id: a kill
    // right after the fork leaked the status's group (statusline.sh, reported to the owner; 2 of 8 runs).
    const started = join(dir, "started");
    const killParent = `n=0; while [ "$(ps -A -o ppid= | grep -c "^ *$PPID\$")" -lt 2 ] && [ $n -lt 250 ]; do sleep 0.02; n=$((n+1)); done; kill -TERM "$PPID"`;
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do case "$a" in status) : > '${started}'; (${killParent}) & sh -c 'sleep 30; : ${marker}'; exit 0;; esac; done\nexec "${realGit}" "$@"\n`);
    chmodSync(join(bin, "git"), 0o755);
    const child = spawn("bash", [script], { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.stdout.resume();
    child.stdin.end(JSON.stringify(base));
    const exited = new Promise((res) => child.on("exit", res));
    // Polled, not one look after 200 ms: on a loaded machine the children take longer to go after the kill. The bound
    // (10 s) stays far below the fake status's 30 s, so a child the script leaves behind is still caught.
    const until = async (ok: () => boolean, ms: number) => {
      for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await new Promise((res) => setTimeout(res, 100));
    };
    const code = await exited;
    assert.ok(existsSync(started), "the fake git status was running when the script was killed");
    assert.equal(code, 143, "the script ended on its SIGTERM");
    await until(() => alive().length === 0, 10000);
    assert.deepEqual(alive(), [], `stderr: ${stderr}`);
    assert.deepEqual(readdirSync(tmp), []);
    assert.equal(stderr, "");
  } finally {
    spawnSync("pkill", ["-f", marker]);
    rmSync(dir, { recursive: true, force: true });
  }
});

// A SIGTERM that lands right after the script forks git (or the watchdog) and before it stores the job id: the EXIT
// trap then ran with that id empty, so the job's process group kept running (2.1.0 probe: 2 of 8 side-by-side runs,
// docs/limits.md, J). A DEBUG trap read from BASH_ENV sends the TERM exactly when the id assignment is next, so the
// window is hit on every run, with no timing. A fake `sleep` (the watchdog's only command) hangs too, so a watchdog
// left behind is seen as well.
for (const at of ["STATUS_PID=$!", "WATCH_PID=$!"]) {
  test(`statusline: a SIGTERM just before ${at} leaves no process and no temp file behind`, skipNoJq, async () => {
    const marker = `slwin${process.pid}x${Date.now()}`;
    const dir = mkdtempSync(join(tmpdir(), `${marker}-`));
    const alive = () =>
      spawnSync("ps", ["-A", "-o", "args="], { encoding: "utf8" })
        .stdout.split("\n")
        .filter((l) => l.includes(marker));
    try {
      const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      const realSleep = spawnSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim();
      const bin = join(dir, "bin");
      const repo = join(dir, "repo");
      const tmp = join(dir, "tmp");
      spawnSync("mkdir", ["-p", bin, repo, tmp]);
      gitIn(repo, "init", "-q", "-b", "main");
      const started = join(dir, "started");
      writeFileSync(join(bin, "git"), `#!/bin/sh\nfor a in "$@"; do case "$a" in status) : > '${started}'; sh -c '${realSleep} 30; : ${marker}'; exit 0;; esac; done\nexec "${realGit}" "$@"\n`);
      writeFileSync(join(bin, "sleep"), `#!/bin/sh\nexec sh -c '${realSleep} 30; : ${marker}'\n`);
      chmodSync(join(bin, "git"), 0o755);
      chmodSync(join(bin, "sleep"), 0o755);
      const envFile = join(dir, "bash-env");
      writeFileSync(envFile, `trap '[ "$BASH_COMMAND" = "$SL_KILL_AT" ] && kill -TERM $$' DEBUG\n`);
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp, BASH_ENV: envFile, SL_KILL_AT: at };
      const child = spawn("bash", [script], { cwd: repo, env });
      let stderr = "";
      child.stderr.on("data", (d) => (stderr += d));
      child.stdout.resume();
      child.stdin.end(JSON.stringify(base));
      const code = await new Promise((res) => child.on("exit", res));
      assert.equal(code, 143, `the script ended on its SIGTERM; stderr: ${stderr}`);
      // Polled for up to 10 s, far below the fakes' 30 s, so a group the script leaves behind is still caught.
      for (const end = Date.now() + 10000; alive().length && Date.now() < end; ) await new Promise((res) => setTimeout(res, 100));
      assert.deepEqual(alive(), [], `stderr: ${stderr}`);
      assert.deepEqual(readdirSync(tmp), []);
      assert.equal(stderr, "");
    } finally {
      spawnSync("pkill", ["-f", marker]);
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// The same SIGTERM case, run many times: 200 rounds at STATUS_PID=$! (both CI sightings were there) and 50 at
// WATCH_PID=$!. In CI (Ubuntu, bash 5) bash itself printed "statusline.sh: line 61: wait_for: No record of process N"
// during the cleanup about once in 50 to 100 runs at STATUS_PID=$!; a redirection on `rm` alone did not stop it (round
// 50 of this test, at 50 rounds), so the EXIT trap now sends the shell's stderr to /dev/null before the cleanup. It was
// never seen on the development machine (0 of about 9,000 runs, docs/limits.md, J): a pass in CI, where it did show, is
// the evidence. Each round asserts only the exit status and an empty stderr, read once the child's streams have closed
// (not at `exit`, when stdio may still be open). It does not assert that no process is left: bash blocks TERM around
// each fork, so a group TERM landing in that window kills the forking shell but not the child it was creating, which
// then runs on outside the kill (about 1 run in 300 under load; docs/limits.md, J). The single-run tests above assert
// that; here the stand-ins carry the marker in their own name (`exec -a`, no fork of their own), and every stray one is
// ended after the rounds.
test("statusline: a SIGTERM in either id window, run repeatedly, never prints anything on stderr", { ...skipNoJq, timeout: 120000 }, async () => {
  const marker = `slrep${process.pid}x${Date.now()}`;
  const dir = mkdtempSync(join(tmpdir(), `${marker}-`));
  const alive = () =>
    spawnSync("ps", ["-A", "-o", "args="], { encoding: "utf8" })
      .stdout.split("\n")
      .filter((l) => l.includes(marker));
  try {
    const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const realSleep = spawnSync("sh", ["-c", "command -v sleep"], { encoding: "utf8" }).stdout.trim();
    const bin = join(dir, "bin");
    const repo = join(dir, "repo");
    const tmp = join(dir, "tmp");
    spawnSync("mkdir", ["-p", bin, repo, tmp]);
    gitIn(repo, "init", "-q", "-b", "main");
    writeFileSync(join(bin, "git"), `#!/bin/bash\nfor a in "$@"; do case "$a" in status) exec -a 'git-${marker}' "${realSleep}" 30;; esac; done\nexec "${realGit}" "$@"\n`);
    writeFileSync(join(bin, "sleep"), `#!/bin/bash\nexec -a 'sleep-${marker}' "${realSleep}" 30\n`);
    chmodSync(join(bin, "git"), 0o755);
    chmodSync(join(bin, "sleep"), 0o755);
    const envFile = join(dir, "bash-env");
    writeFileSync(envFile, `trap '[ "$BASH_COMMAND" = "$SL_KILL_AT" ] && kill -TERM $$' DEBUG\n`);
    for (const [at, rounds] of [["STATUS_PID=$!", 200], ["WATCH_PID=$!", 50]] as const) {
      const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: tmp, BASH_ENV: envFile, SL_KILL_AT: at };
      for (let i = 1; i <= rounds; i++) {
        const round = `${at} round ${i}`;
        const child = spawn("bash", [script], { cwd: repo, env });
        let stderr = "";
        child.stderr.on("data", (d) => (stderr += d));
        child.stdout.resume();
        child.stdin.end(JSON.stringify(base));
        const code = await new Promise((res) => child.on("close", res));
        assert.equal(code, 143, `${round}: the script ended on its SIGTERM; stderr: ${stderr}`);
        assert.equal(stderr, "", round);
      }
    }
  } finally {
    for (const end = Date.now() + 10000; alive().length && Date.now() < end; ) {
      spawnSync("pkill", ["-f", marker]);
      await new Promise((res) => setTimeout(res, 50));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
