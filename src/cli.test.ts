// The SDK pipeline's command lines (src/cli.ts, src/route.ts): bad arguments end in the usage message with exit 2, never
// a stack trace. Only paths that exit before any model call or git command are run here.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
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

test("route.ts: an unknown flag or a flag with no value prints the usage message and exits 2", () => {
  const repo = mkdtempSync(join(tmpdir(), "route-bad-"));
  for (const args of [["--repo", repo, "--task", "t", "--bogus"], ["--repo", repo, "--task"], ["--repo", repo, "--task", "- add tests"]]) {
    const r = tsx("route.ts", args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /usage: route\.ts/);
    noStack(r.stderr);
  }
});

test("cli.ts: an unknown flag, a flag with no value or a dash-led value prints the usage message and exits 2", () => {
  for (const args of [["--repo", ".", "--task", "t", "--bogus"], ["--repo", ".", "--task"], ["--repo", ".", "--task", "- add tests"]]) {
    const r = tsx("cli.ts", args);
    assert.equal(r.status, 2, `${args.join(" ")}: ${r.stderr}`);
    assert.match(r.stderr, /usage: npm start/);
    noStack(r.stderr);
  }
});
