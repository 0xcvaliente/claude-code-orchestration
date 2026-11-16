// Entry guards: a script decides "am I the entry script" by comparing process.argv[1] with import.meta.url. Node
// resolves symlinks for the main module's import.meta.url but leaves argv[1] as given, so a script started through a
// symlinked path (a checkout under macOS /tmp or /var) used to skip its CLI block and exit 0 with no output.
// Each script runs once through its real path and once through a symlink to the repository root, with cheap arguments
// that stop in the CLI block before any work (no `claude`, no network, nothing written into the repository).
// bench/tasks/*/score.mjs have the same pattern and are out of scope here.
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const link = join(mkdtempSync(join(tmpdir(), "entry-guard-")), "repo");
symlinkSync(root, link, "dir");
const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");

// [script, args, what the CLI block prints (proof it ran), run through tsx]
/** @type {[string, string[], RegExp, boolean?][]} */
const CASES = [
  ["scripts/run-result.mjs", [], /usage: run-result\.mjs/],
  ["scripts/tokens.mjs", ["budget-usd", "500k"], /^\d/],
  ["scripts/claude-update.mjs", ["--no-such-flag"], /unknown argument: --no-such-flag/],
  ["src/sync-agents.ts", ["--check"], /agents in sync with config\.ts/, true],
  [".claude/hooks/file-profile.mjs", [], /usage: node \.claude\/hooks\/file-profile\.mjs/],
  ["bench/charts.mjs", [], /usage: node bench\/charts\.mjs/],
  ["bench/analyze.mjs", [], /usage: node bench\/analyze\.mjs/],
  ["bench/report.mjs", [], /usage: node bench\/report\.mjs/],
  ["bench/validate.mjs", ["--task", "no-such-task-entry-guard"], /no tasks found matching no-such-task-entry-guard/],
];

/** @param {string} base @param {string} script @param {string[]} args @param {boolean} [tsx] */
const runAt = (base, script, args, tsx) => {
  const file = join(base, script);
  const r = spawnSync(process.execPath, tsx ? [tsxCli, file, ...args] : [file, ...args], { cwd: base, encoding: "utf8", timeout: 60000 });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.replaceAll(link, root) };
};

for (const [script, args, proof, tsx] of CASES) {
  test(`entry guard: ${script} runs its CLI block through a symlinked path too`, () => {
    const real = runAt(root, script, args, tsx);
    assert.match(real.out, proof, `the CLI block runs through the real path: ${real.out}`);
    const viaLink = runAt(link, script, args, tsx);
    assert.match(viaLink.out, proof, `the CLI block runs through the symlink (exit ${viaLink.status}): ${viaLink.out}`);
    assert.equal(viaLink.status, real.status);
    assert.equal(viaLink.out, real.out);
  });
}
