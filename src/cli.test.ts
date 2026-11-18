// The SDK pipeline's command lines (src/cli.ts, src/route.ts): bad arguments end in the usage message with exit 2, never
// a stack trace. Only paths that exit before any model call or git command are run here.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tsx = (script: string, args: string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", join(root, "src", script), ...args], { cwd: root, encoding: "utf8" });

const noStack = (stderr: string) => assert.doesNotMatch(stderr, /\n\s+at .+:\d+:\d+/, "no stack trace");

test("route.ts: a task that starts with a dash reaches triage when passed as --task=<task>", () => {
  const repo = mkdtempSync(join(tmpdir(), "route-dash-"));
  const r = tsx("route.ts", ["--repo", repo, "--task=- add tests", "--mode", "plain", "--project-state"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).mode, "plain");
});

// Item 1 of 2.0.0: --task-file=<path> (the /route skill's way to hand over a task without the shell reading it).
test("route.ts: --task-file reads the task from the file byte for byte; missing, empty or both flags is a usage error", () => {
  const repo = mkdtempSync(join(tmpdir(), "route-file-"));
  const task = "a\nORCH_ROUTE_TASK_END\ntouch X\n\"q\" 'q' `b` $(c) $HOME\n-dash \\\n\n";
  const file = join(repo, "route-task.txt");
  writeFileSync(file, task);
  const r = tsx("route.ts", ["--repo", repo, `--task-file=${file}`, "--mode", "plain", "--project-state"]);
  assert.equal(r.status, 0, r.stderr);
  const routes = readFileSync(join(repo, ".claude", "state", "routes.jsonl"), "utf8").trim().split("\n");
  assert.equal(JSON.parse(routes.at(-1) ?? "{}").task, task, "the logged task is the file's text, trailing newlines kept");
  writeFileSync(join(repo, "empty.txt"), "");
  for (const args of [
    ["--repo", repo, `--task-file=${join(repo, "missing.txt")}`],
    ["--repo", repo, `--task-file=${join(repo, "empty.txt")}`],
    ["--repo", repo, `--task-file=${file}`, "--task", "t"],
  ]) {
    const b = tsx("route.ts", args);
    assert.equal(b.status, 2, `${args.join(" ")}: ${b.stderr}`);
    assert.match(b.stderr, /usage: route\.ts/);
    noStack(b.stderr);
  }
});

test("route.ts: an unknown flag or a flag with no value prints the usage message and exits 2", () => {
  const repo = mkdtempSync(join(tmpdir(), "route-bad-"));
  for (const args of [["--repo", repo, "--task", "t", "--bogus"], ["--repo", repo, "--task"], ["--repo", repo, "--task", "- add tests"]]) {
    const r = tsx("route.ts", args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /usage: route\.ts/);
    noStack(r.stderr);
  }
});

test("cli.ts: --retries, --replans and --concurrency take only a plain decimal count, else usage error and exit 2", () => {
  // A folder that is not a git repository: without the count check, the run would stop at the repository check instead.
  const repo = mkdtempSync(join(tmpdir(), "cli-count-"));
  const cases: [string, string][] = [
    ["--retries", ""], ["--retries", " "], ["--replans", ""], ["--replans", " "], ["--retries", "0x2"], ["--retries", "1e1"],
    ["--replans", "1.0"], ["--retries", "-1"], ["--retries", "+1"], ["--concurrency", "0"], ["--concurrency", ""], ["--retries", "99999999999999999999"],
  ];
  for (const [flag, value] of cases) {
    const r = tsx("cli.ts", ["--repo", repo, "--task", "t", `${flag}=${value}`]);
    assert.equal(r.status, 2, `${flag}=${JSON.stringify(value)}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`^${flag} must be`, "m"), `${flag}=${JSON.stringify(value)}: ${r.stderr}`);
    noStack(r.stderr);
  }
});

test("cli.ts: an unknown flag, a flag with no value or a dash-led value prints the usage message and exits 2", () => {
  for (const args of [["--repo", ".", "--task", "t", "--bogus"], ["--repo", ".", "--task"], ["--repo", ".", "--task", "- add tests"]]) {
    const r = tsx("cli.ts", args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /usage: npm run sdk/);
    noStack(r.stderr);
  }
});
