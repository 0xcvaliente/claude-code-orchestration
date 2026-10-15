// Tests for the benchmark runner: node --test bench/run.test.mjs (no model calls; one test spawns a fake agent script).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  blockKeyOf, buildPrompt, diffFiles, enabledPluginIds, expandMatrix, filterResume, finishedRunIds, footer, groupBlocks,
  hms, isRateLimited, mergeSettings, parseResults, resolveSeed, runIdOf, shuffle, snapName,
} from "./lib/run-core.mjs";
import { ARMS, envAdditions, prepareClaudeDir, runEnv } from "./arms.mjs";
import { executeRun, loadTask } from "./lib/run-exec.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const fixtures = join(here, "test-fixtures", "tasks");
const matrixOf = (name) => JSON.parse(readFileSync(join(here, "matrix", `${name}.json`), "utf8"));
const metaOf = (id) => loadTask(fixtures, id).meta;

test("matrix expansion: run counts and block counts of the shipped matrices", () => {
  const counts = { pilot: [8, 3], lite: [60, 12], sweeps: [16, 8], "lite-k2": [10, 2], "pilot-k2": [2, 1] };
  for (const [name, [nRuns, nBlocks]] of Object.entries(counts)) {
    const runs = expandMatrix(matrixOf(name), metaOf);
    assert.equal(runs.length, nRuns, name);
    assert.equal(groupBlocks(runs).length, nBlocks, name);
    assert.equal(new Set(runs.map((r) => r.run_id)).size, nRuns, `${name}: unique run ids`);
    for (const r of runs) assert.ok(ARMS[r.arm], r.arm);
  }
});

test("matrix expansion: cell cap_min overrides meta, budget cells carry budget_tokens", () => {
  const runs = expandMatrix(matrixOf("sweeps"), metaOf);
  const one = (cell) => runs.find((r) => r.task === "k2-stdlib-toolkit-xl" && r.cell === cell);
  assert.equal(one("cap10").cap_min, 10);
  assert.equal(one("cap60").cap_min, 60);
  assert.equal(one("budget3M").cap_min, metaOf("k2-stdlib-toolkit-xl").cap_min);
  assert.equal(one("budget3M").budget_tokens, 3_000_000);
  assert.equal(one("budget8M").budget_tokens, 8_000_000);
  assert.equal(one("cap10").budget_tokens, null);
});

test("blocks group all arms of one (task, cell, rep)", () => {
  const blocks = groupBlocks(expandMatrix(matrixOf("lite"), metaOf));
  for (const b of blocks) {
    assert.equal(b.runs.length, 5);
    assert.deepEqual(b.runs.map((r) => r.arm), ["P-S", "P-O", "O-mix", "O-O", "AUTO"]);
    assert.ok(b.runs.every((r) => blockKeyOf(r.task, r.cell, r.rep) === b.key));
  }
});

test("seeded shuffle is deterministic and a permutation", () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  assert.deepEqual(shuffle(items, 42), shuffle(items, 42));
  assert.notDeepEqual(shuffle(items, 42), shuffle(items, 43));
  assert.notDeepEqual(shuffle(items, 42), items);
  assert.deepEqual([...shuffle(items, 42)].sort((a, b) => a - b), items);
});

test("run_id format", () => {
  assert.equal(runIdOf("t2-single", "O-mix", "main", 1), "t2-single__O-mix__main__r1");
  const runs = expandMatrix(matrixOf("pilot"), metaOf);
  assert.ok(runs.some((r) => r.run_id === "k1-stdlib-toolkit__P-O__cap10__r1"));
  assert.ok(runs.every((r) => /^[a-z0-9-]+__[A-Za-z-]+__[A-Za-z0-9]+__r\d+$/.test(r.run_id)));
});

test("footer text and prompt", () => {
  const start = new Date(2026, 0, 2, 9, 5, 7);
  const deadline = new Date(2026, 0, 2, 9, 15, 7);
  const f = footer(10, start, deadline);
  assert.equal(
    f,
    "HARD TIME LIMIT: 10 minutes of wall-clock time. Started at 09:05:07 local time; at 09:15:07 this process is killed without warning, and whatever is then in this directory's working tree is graded. Work in other git worktrees or branches that has not been merged into this working tree by then does not count. Check the time with `date` and keep the working tree gradable at all times.\nNo human is available: do not ask questions; make reasonable decisions.",
  );
  assert.equal(buildPrompt("  Do it.\n\n", 10, start, deadline), `Do it.\n\n${f}`);
  assert.doesNotMatch(buildPrompt("x", 10, start, deadline), /token|budget/i);
  assert.equal(hms(start), "09:05:07");
});

test("settings merge disables every user plugin and keeps copied settings", () => {
  const merged = mergeSettings({ hooks: { a: 1 }, enabledPlugins: { "x@y": true, "keep@m": true } }, ["x@y", "orchestration@m"], { model: "sonnet" });
  assert.deepEqual(merged, { hooks: { a: 1 }, model: "sonnet", enabledPlugins: { "x@y": false, "keep@m": true, "orchestration@m": false } });
  assert.deepEqual(mergeSettings(undefined, ["a@b"]), { enabledPlugins: { "a@b": false } });
  assert.deepEqual(enabledPluginIds('[{"id":"a@b","enabled":true},{"id":"c@d","enabled":false}]'), ["a@b"]);
});

test("prepareClaudeDir: plain arms get only settings, O-O rewrites models, AUTO sets model sonnet", () => {
  const tmp = mkdtempSync(join(tmpdir(), "bench-arms-"));
  try {
    for (const arm of ["P-O", "O-mix", "O-O", "AUTO"]) {
      const repo = join(tmp, arm);
      mkdirSync(repo);
      prepareClaudeDir(arm, repo, root, ["orchestration@m"]);
      const settings = JSON.parse(readFileSync(join(repo, ".claude", "settings.json"), "utf8"));
      assert.equal(settings.enabledPlugins["orchestration@m"], false, arm);
      assert.equal(existsSync(join(repo, ".claude", "agents")), arm !== "P-O", arm);
      assert.equal(existsSync(join(repo, ".claude", "state")), false, arm);
      if (arm !== "P-O") assert.ok(settings.hooks, `${arm}: copied hooks kept`);
      assert.equal(settings.model, arm === "AUTO" ? "sonnet" : undefined, arm);
    }
    const models = (arm) => ["implementer", "orchestrator", "reviewer"].map((a) => /^model:\s*(.*)$/m.exec(readFileSync(join(tmp, arm, ".claude", "agents", `${a}.md`), "utf8"))[1]);
    assert.ok(models("O-O").every((m) => m === "opus"));
    assert.deepEqual(models("O-mix"), ["implementer", "orchestrator", "reviewer"].map((a) => /^model:\s*(.*)$/m.exec(readFileSync(join(root, ".claude", "agents", `${a}.md`), "utf8"))[1]));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("arm env: inherited ORCH_* dropped, budget and test command added", () => {
  const meta = { test_cmd: "npm test" };
  const env = runEnv("P-S", meta, { budget_tokens: 1_000_000 }, { PATH: "/bin", ORCH_MODEL: "opus", ORCH_BUDGET_TOKENS: "9M" });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.ORCH_MODEL, "sonnet");
  assert.equal(env.ORCH_AGENT, "none");
  assert.equal(env.ORCH_BUDGET_TOKENS, "1000000");
  assert.equal(env.ORCH_TEST_CMD, "npm test");
  assert.equal(env.ORCH_EXTRA_ALLOWED_TOOLS, "Bash(date*)");
  assert.equal(env.ORCH_NO_NUDGE, "1");
  const add = envAdditions("O-mix", { test_cmd: null }, { budget_tokens: null });
  assert.deepEqual(add, { ORCH_AGENT: "orchestrator", ORCH_EXTRA_ALLOWED_TOOLS: "Bash(date*)", ORCH_NO_NUDGE: "1" });
});

test("parseResults: several documents mixed with non-JSON lines", () => {
  const a = { type: "result", result: "first {brace} \"q\"", is_error: false, modelUsage: { "claude-opus": { inputTokens: 1 } } };
  const b = { type: "result", result: "second", is_error: false };
  const c = { type: "result", result: "third", is_error: true };
  const stdout = [
    "route: plain - small task",
    JSON.stringify(a),
    "review: pass",
    "{ not json at all",
    JSON.stringify({ unrelated: true }),
    JSON.stringify(b, null, 2),
    `  ${JSON.stringify(c)}`,
    "trailing text {\"x\":1}",
  ].join("\n");
  assert.deepEqual(parseResults(stdout), [a, b, c]);
  assert.deepEqual(parseResults(""), []);
  assert.deepEqual(parseResults("garbage\n{"), []);
});

test("rate-limit detection", () => {
  assert.equal(isRateLimited([{ is_error: true, result: "Claude AI usage limit reached|1700000000" }]), true);
  assert.equal(isRateLimited([{ is_error: false, result: "x" }, { is_error: true, result: "API Error: 429 Too Many Requests" }]), true);
  assert.equal(isRateLimited([{ is_error: true, result: "Overloaded" }]), true);
  assert.equal(isRateLimited([{ is_error: false, result: "fixed the rate limit bug" }]), false);
  assert.equal(isRateLimited([{ is_error: true, result: "tests failed" }]), false);
  assert.equal(isRateLimited([]), false);
});

test("resume skips exited and deadline rows only", () => {
  const rows = [
    { run_id: "a", end_reason: "exited" },
    { run_id: "b", end_reason: "deadline" },
    { run_id: "c", end_reason: "error" },
    { run_id: "d", end_reason: "rate_limited" },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n{torn";
  const done = finishedRunIds(rows);
  assert.deepEqual([...done].sort(), ["a", "b"]);
  const runs = ["a", "b", "c", "d", "e"].map((run_id) => ({ run_id }));
  assert.deepEqual(filterResume(runs, done).map((r) => r.run_id), ["c", "d", "e"]);
});

test("snapshot names and diff file lists", () => {
  assert.equal(snapName(60), "t0060");
  assert.equal(snapName(1200), "t1200");
  assert.deepEqual(diffFiles(["b.js\n.claude/x\na.js\n", "c.txt\na.js\n"]), ["a.js", "b.js", "c.txt"]);
});

// executeRun end to end with a fake agent (no claude): early exit, then a deadline kill.
test("executeRun: outputs, results, snapshots, deadline", { timeout: 60_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "bench-exec-"));
  try {
    const taskDir = join(tmp, "tasks", "fx");
    mkdirSync(join(taskDir, "setup"), { recursive: true });
    writeFileSync(join(taskDir, "setup", "a.txt"), "a\n");
    writeFileSync(join(taskDir, "task.md"), "Fake task.\n");
    writeFileSync(join(taskDir, "meta.json"), JSON.stringify({ id: "fx", cap_min: 0.05, test_cmd: null, graded_paths: ["."], snapshot_every_s: 1 }));
    const task = loadTask(join(tmp, "tasks"), "fx");
    const ctx = { root, campaignDir: join(tmp, "campaign"), reposDir: join(tmp, "repos"), tasks: { fx: task }, disabledIds: ["x@y"], skipIsolation: true, graceMs: 500 };
    const doc = (r, err = false) => JSON.stringify({ type: "result", result: r, is_error: err, modelUsage: { "claude-x": { inputTokens: 100, outputTokens: 50 } } });
    const script = (body) => ({ cmd: "bash", args: ["-c", body], cwd: tmp });
    ctx.commandFor = (run, prompt, repo) => script(`cd "${repo}" && echo hello && echo '${doc("one")}' && echo b > b.txt && mkdir -p .claude/state && echo '{"mode":"plain"}' > .claude/state/routes.jsonl && sleep 1.5 && echo '${doc("two")}'`);
    const run = { run_id: "fx__P-S__main__r1", task: "fx", arm: "P-S", cell: "main", rep: 1, cap_min: 0.05, budget_tokens: null };
    const row = await executeRun(run, ctx);
    assert.equal(row.end_reason, "exited");
    assert.equal(row.exit_code, 0);
    assert.deepEqual(row.results.map((r) => r.result), ["one", "two"]);
    assert.deepEqual(row.routes, [{ mode: "plain" }]);
    const out = join(ctx.campaignDir, run.run_id);
    assert.equal(readFileSync(join(out, "final", "b.txt"), "utf8"), "b\n");
    assert.equal(existsSync(join(out, "final", ".git")), false);
    assert.equal(existsSync(join(out, "snapshots", "t0001", "a.txt")), true);
    assert.equal(readFileSync(join(out, "diff-files.txt"), "utf8"), "b.txt\n");
    assert.match(readFileSync(join(out, "git-log.txt"), "utf8"), /init/);
    assert.match(readFileSync(join(out, "prompt.txt"), "utf8"), /^Fake task\.\n\nHARD TIME LIMIT: 0\.05 minutes/);
    assert.ok(existsSync(join(out, "state", "routes.jsonl")));

    ctx.commandFor = () => script(`echo '${doc("You have hit your usage limit", true)}'; sleep 30`);
    const t0 = Date.now();
    const late = await executeRun({ ...run, run_id: "fx__P-O__main__r1", arm: "P-O" }, ctx);
    assert.equal(late.end_reason, "rate_limited");
    assert.ok(Date.now() - t0 < 15_000, "killed at the deadline");

    ctx.commandFor = () => script("sleep 30");
    const dl = await executeRun({ ...run, run_id: "fx__O-mix__main__r1", arm: "O-mix" }, ctx);
    assert.equal(dl.end_reason, "deadline");
    assert.deepEqual(dl.results, []);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("resume keeps the manifest seed; --seed on resume is an error", () => {
  assert.deepEqual(resolveSeed({ resumeManifest: { seed: 7 }, cliSeed: null, matrixSeed: 1 }), { seed: 7, save: false });
  assert.deepEqual(resolveSeed({ resumeManifest: { campaign: "old" }, cliSeed: null, matrixSeed: 3 }), { seed: 3, save: true });
  assert.throws(() => resolveSeed({ resumeManifest: { seed: 7 }, cliSeed: "9", matrixSeed: 1 }), /--seed cannot be used with --resume/);
  assert.deepEqual(resolveSeed({ resumeManifest: null, cliSeed: "9", matrixSeed: 1 }), { seed: 9, save: false });
  assert.deepEqual(resolveSeed({ resumeManifest: null, cliSeed: null, matrixSeed: 4 }), { seed: 4, save: false });
  assert.deepEqual(resolveSeed({ resumeManifest: null, cliSeed: null, matrixSeed: undefined }), { seed: 1, save: false });
  // same seed, same block order: a resumed campaign replays the original order
  const blocks = groupBlocks(expandMatrix(matrixOf("lite"), metaOf)).map((b) => b.key);
  assert.deepEqual(shuffle(blocks, resolveSeed({ resumeManifest: { seed: 5 }, cliSeed: null }).seed), shuffle(blocks, 5));
});

// A runner that gets SIGTERM stops its detached runs: the fake agent ignores TERM, so the KILL after the grace period is needed.
test("interrupt: SIGTERM to the runner kills the run's process group and appends no row", { timeout: 60_000 }, async () => {
  const tmp = mkdtempSync(join(tmpdir(), "bench-int-"));
  try {
    const taskDir = join(tmp, "tasks", "fx");
    mkdirSync(join(taskDir, "setup"), { recursive: true });
    writeFileSync(join(taskDir, "setup", "a.txt"), "a\n");
    writeFileSync(join(taskDir, "task.md"), "Fake task.\n");
    writeFileSync(join(taskDir, "meta.json"), JSON.stringify({ id: "fx", cap_min: 5, test_cmd: null, graded_paths: ["."], snapshot_every_s: 0 }));
    const pidFile = join(tmp, "agent.pid");
    const rowsFile = join(tmp, "runs.jsonl");
    const runner = join(tmp, "runner.mjs");
    const execUrl = pathToFileURL(join(here, "lib", "run-exec.mjs")).href;
    writeFileSync(runner, `
import { appendFileSync } from "node:fs";
import { executeRun, installInterruptHandlers, interrupted, loadTask } from ${JSON.stringify(execUrl)};
installInterruptHandlers({ graceMs: 500 });
const task = loadTask(${JSON.stringify(join(tmp, "tasks"))}, "fx");
const ctx = { root: ${JSON.stringify(root)}, campaignDir: ${JSON.stringify(join(tmp, "campaign"))}, reposDir: ${JSON.stringify(join(tmp, "repos"))},
  tasks: { fx: task }, disabledIds: [], skipIsolation: true,
  commandFor: () => ({ cmd: "bash", args: ["-c", ${JSON.stringify(`trap '' TERM; echo $$ > "${pidFile}"; sleep 60; true`)}], cwd: ${JSON.stringify(tmp)} }) };
const row = await executeRun({ run_id: "fx__P-S__main__r1", task: "fx", arm: "P-S", cell: "main", rep: 1, cap_min: 5, budget_tokens: null }, ctx);
if (!interrupted()) appendFileSync(${JSON.stringify(rowsFile)}, JSON.stringify(row) + "\\n");
`);
    const child = spawn(process.execPath, [runner], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    const t0 = Date.now();
    while (!existsSync(pidFile) || !readFileSync(pidFile, "utf8").trim()) {
      assert.ok(Date.now() - t0 < 20_000, `agent never started: ${out}`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const pgid = Number(readFileSync(pidFile, "utf8").trim());
    assert.doesNotThrow(() => process.kill(-pgid, 0), "agent group alive before the interrupt");
    child.kill("SIGTERM");
    const code = await new Promise((r) => child.on("close", (c) => r(c)));
    assert.notEqual(code, 0);
    assert.match(out, /RUNNER INTERRUPTED/);
    assert.throws(() => process.kill(-pgid, 0), /ESRCH/, "agent group gone after the interrupt");
    assert.equal(existsSync(rowsFile), false, "no row for the interrupted run");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
