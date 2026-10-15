#!/usr/bin/env node
// Benchmark runner: orchestrated runs vs plain Claude Code sessions on the same tasks, under a hard wall-clock cap.
//   node bench/run.mjs --matrix <file> [--campaign <name>] [--resume <campaign dir>] [--dry-run] [--only <substring of run_id>]
//        [--parallel-blocks N] [--seed N] [--tasks-dir <dir>] [--check-isolation]
// A block is every run sharing (task, cell, rep): its arms start together so they share rate-limit conditions. Block order
// is shuffled with a seeded PRNG. Output: runs/bench/<campaign>/ (manifest.json, runs.jsonl, one folder per run); run repos
// live in ~/orch-bench/<campaign>/<run_id>. Cost is measured in tokens only. Arms: bench/arms.mjs.
// Isolation: every user-enabled plugin is disabled in each run repo's .claude/settings.json; a run whose repo still shows an
// enabled plugin is not launched (end_reason "error", error "isolation").
// Touch <campaign dir>/PAUSE to hold before the next block; a rate-limited run creates it and is requeued.
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ARMS, command, envAdditions } from "./arms.mjs";
import { expandMatrix, filterResume, finishedRunIds, groupBlocks, hms, shuffle, stamp, enabledPluginIds, resolveSeed } from "./lib/run-core.mjs";
import { checkIsolation, createRunRepo, executeRun, installInterruptHandlers, interrupted, loadTask, pluginListIn, sh, tokensOf } from "./lib/run-exec.mjs";
import { formatTokens } from "../scripts/tokens.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 || i + 1 >= argv.length ? fallback : argv[i + 1];
};
const log = (line) => console.log(line);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = Number(process.env.BENCH_PAUSE_POLL_MS) || 30_000;

function die(msg) {
  console.error(msg);
  process.exit(2);
}

const tasksDir = resolve(opt("tasks-dir", join(here, "tasks")));
const resumeDir = opt("resume", null) && resolve(opt("resume"));
let matrix;
let campaignDir;
let resumeManifest = null;
if (resumeDir) {
  const mf = join(resumeDir, "manifest.json");
  if (!existsSync(mf)) die(`no manifest.json in ${resumeDir}`);
  resumeManifest = JSON.parse(readFileSync(mf, "utf8"));
  matrix = resumeManifest.matrix;
  campaignDir = resumeDir;
} else {
  const file = opt("matrix", null);
  if (!file) die("usage: node bench/run.mjs --matrix <file> [--campaign name] [--resume dir] [--dry-run] [--only s] [--parallel-blocks N] [--seed N] [--tasks-dir dir] [--check-isolation]");
  matrix = JSON.parse(readFileSync(resolve(file), "utf8"));
}
// A resumed campaign keeps the seed in its manifest (and so its block order); an older manifest without one gets it saved.
let seed;
try {
  const s = resolveSeed({ resumeManifest, cliSeed: opt("seed", null), matrixSeed: matrix.seed });
  seed = s.seed;
  if (s.save && !flag("dry-run")) writeFileSync(join(resumeDir, "manifest.json"), `${JSON.stringify({ ...resumeManifest, seed }, null, 2)}\n`);
} catch (e) {
  die(e.message);
}
const campaign = resumeDir ? resumeManifest.campaign : opt("campaign", `${matrix.name ?? "bench"}-${stamp()}`);
campaignDir ??= join(root, "runs", "bench", campaign);
const reposDir = process.env.BENCH_REPOS_DIR ? resolve(process.env.BENCH_REPOS_DIR, campaign) : join(homedir(), "orch-bench", campaign);

const tasks = {};
const taskOf = (id) => (tasks[id] ??= loadTask(tasksDir, id));
for (const g of matrix.groups ?? []) for (const a of g.arms ?? []) if (!ARMS[a]) die(`unknown arm ${a}`);
let runs;
try {
  runs = expandMatrix(matrix, (id) => taskOf(id).meta);
} catch (e) {
  die(e.message);
}

// User-enabled plugin ids, the ones every run repo disables.
function userEnabledPlugins() {
  const r = pluginListIn(root);
  try {
    return enabledPluginIds(r.raw);
  } catch (e) {
    die(`claude plugin list --json failed: ${e.message} ${r.stderr}`);
  }
}

if (flag("check-isolation")) {
  const disabled = userEnabledPlugins();
  const task = taskOf(matrix.groups[0].tasks[0]);
  const tmp = mkdtempSync(join(tmpdir(), "orch-bench-iso-"));
  let leaks = 0;
  try {
    for (const arm of ["P-O", "O-mix"]) {
      const repo = join(tmp, arm);
      createRunRepo(task, arm, repo, root, disabled);
      const iso = checkIsolation(repo, null);
      if (iso.error) {
        leaks++;
        console.log(`${arm}: ${iso.error}`);
      } else {
        leaks += iso.enabled.length;
        console.log(`${arm} (${task.id}): enabled plugins: ${iso.enabled.length ? iso.enabled.join(", ") : "none"}`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`user-enabled plugins disabled per repo: ${disabled.length ? disabled.join(", ") : "none"}`);
  console.log(leaks ? "ISOLATION FAILED" : "isolation ok");
  process.exit(leaks ? 1 : 0);
}

const only = opt("only", null);
if (only) runs = runs.filter((r) => r.run_id.includes(only));
if (resumeDir) {
  const rowsFile = join(campaignDir, "runs.jsonl");
  runs = filterResume(runs, finishedRunIds(existsSync(rowsFile) ? readFileSync(rowsFile, "utf8") : ""));
}
const blocks = shuffle(groupBlocks(runs), seed);

if (flag("dry-run")) {
  log(`campaign ${campaign} (seed ${seed}): ${runs.length} runs in ${blocks.length} blocks`);
  log(`campaign dir ${campaignDir}; run repos in ${reposDir}`);
  for (const [bi, b] of blocks.entries()) {
    log(`\nblock ${bi + 1}/${blocks.length}: ${b.key} (${b.runs.length} arms concurrently)`);
    for (const r of b.runs) {
      const t = taskOf(r.task);
      const add = envAdditions(r.arm, t.meta, r);
      const c = command(r.arm, "<prompt>", join(reposDir, r.run_id), root);
      log(`  ${r.run_id}  arm=${r.arm} cap=${r.cap_min}min budget=${r.budget_tokens ?? "none"}`);
      log(`    env: ${Object.entries(add).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(" ")}`);
      log(`    cmd: (cd ${c.cwd} && ${c.cmd} ${c.args.map((a) => JSON.stringify(a)).join(" ")})`);
    }
  }
  process.exit(0);
}

// Manifest: written once per campaign, reused on --resume.
const disabledIds = userEnabledPlugins();
mkdirSync(campaignDir, { recursive: true });
const manifestFile = join(campaignDir, "manifest.json");
if (!existsSync(manifestFile)) {
  const ver = (cmd, args) => {
    const r = sh(cmd, args, { timeout: 30_000 });
    return r.status === 0 ? `${r.stdout}${r.stderr}`.trim() : null;
  };
  let pluginVersion = null;
  try {
    pluginVersion = JSON.parse(readFileSync(join(root, "dist", "plugin", ".claude-plugin", "plugin.json"), "utf8")).version ?? null;
  } catch {
    // no built plugin
  }
  const manifest = {
    campaign, matrix, seed, repo_sha: ver("git", ["-C", root, "rev-parse", "HEAD"]), claude_version: ver("claude", ["--version"]),
    plugin_version: pluginVersion, node_version: process.version, python3_version: ver("python3", ["--version"]),
    sqlite3_version: ver("sqlite3", ["--version"]), started_at: new Date().toISOString(), disabled_plugins: disabledIds,
    tasks_dir: tasksDir, repos_dir: reposDir,
  };
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}
const rowsFile = join(campaignDir, "runs.jsonl");
const pauseFile = join(campaignDir, "PAUSE");

async function waitWhilePaused() {
  if (!existsSync(pauseFile)) return;
  log(`[${hms()}] paused`);
  while (existsSync(pauseFile)) await sleep(POLL_MS);
}

const ctx = { root, campaignDir, reposDir, tasks, disabledIds, log };
const queue = [...blocks];

async function runOne(run) {
  log(`[${hms()}] start ${run.run_id}`);
  let row;
  try {
    row = await executeRun(run, ctx);
  } catch (e) {
    row = { run_id: run.run_id, task: run.task, arm: run.arm, cell: run.cell, rep: run.rep, cap_min: run.cap_min, budget_tokens: run.budget_tokens ?? null, started_at: new Date().toISOString(), ended_at: new Date().toISOString(), wall_ms: 0, exit_code: null, end_reason: "error", results: [], routes: [], dir: run.run_id, error: e.message };
  }
  if (interrupted()) return; // no row for a run the interrupt cut short: --resume reruns it
  appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
  if (row.error) log(`RUN ERROR ${run.run_id}: ${row.error}`);
  log(`[${hms()}] done ${run.run_id} ${row.end_reason} ${Math.round(row.wall_ms / 1000)}s tokens=${formatTokens(tokensOf(row))}`);
  if (row.end_reason === "rate_limited") {
    writeFileSync(pauseFile, `rate limited: ${run.run_id} at ${new Date().toISOString()}\nRemove this file to resume.\n`);
    queue.push({ key: `${run.block} (requeued ${run.run_id})`, runs: [run] });
  }
}

async function worker() {
  while (queue.length && !interrupted()) {
    await waitWhilePaused();
    if (interrupted()) break;
    const block = queue.shift();
    if (!block) break;
    await Promise.all(block.runs.map(runOne));
  }
}

// SIGINT, SIGTERM or a crash: TERM every live run's process group, KILL what is left after 8 s, exit non-zero.
installInterruptHandlers({ log });
log(`campaign ${campaign}: ${runs.length} runs in ${blocks.length} blocks, seed ${seed}`);
const parallel = Math.max(1, Number(opt("parallel-blocks", "1")) || 1);
// A worker that finds the queue empty stops; a requeued run is picked up by any worker still looping, so keep
// starting workers until the queue stays empty.
while (queue.length && !interrupted()) await Promise.all(Array.from({ length: Math.min(parallel, queue.length) }, worker));
if (!interrupted()) log(`CAMPAIGN DONE ${campaignDir}`);
