// File-system and process side of bench/run.mjs: task loading, run repos, isolation checks, launching one run
// with snapshots and a hard deadline, and collecting its outputs into runs/bench/<campaign>/<run_id>/.
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, cpSync, renameSync } from "node:fs";
import { cp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { command, prepareClaudeDir, runEnv } from "../arms.mjs";
import { buildPrompt, diffFiles, enabledPluginIds, isRateLimited, parseResults, snapName } from "./run-core.mjs";
import { totalTokens } from "../../scripts/tokens.mjs";

export const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function loadTask(tasksDir, id) {
  const dir = join(tasksDir, id);
  const metaFile = join(dir, "meta.json");
  if (!existsSync(metaFile)) throw new Error(`task ${id}: no ${metaFile}`);
  const meta = JSON.parse(readFileSync(metaFile, "utf8"));
  const mdFile = join(dir, "task.md");
  return { id, dir, meta, taskMd: existsSync(mdFile) ? readFileSync(mdFile, "utf8") : "" };
}

// Ids of plugins enabled for `claude` run in cwd (no model call).
export function pluginListIn(cwd) {
  const r = sh("claude", ["plugin", "list", "--json"], { cwd, timeout: 60_000 });
  return { raw: r.stdout ?? "", status: r.status, stderr: r.stderr ?? "" };
}

// Builds the run repo: task setup/, .gitignore, the arm's .claude/, then one initial commit. Returns the initial sha.
export function createRunRepo(task, armId, repo, root, disabledIds) {
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  const setup = join(task.dir, "setup");
  if (existsSync(setup)) cpSync(setup, repo, { recursive: true });
  writeFileSync(join(repo, ".gitignore"), ".claude/state/\n.claude/worktrees/\n__pycache__/\nnode_modules/\n");
  prepareClaudeDir(armId, repo, root, disabledIds);
  const git = (...a) => {
    const r = sh("git", a, { cwd: repo });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.email", "bench@local");
  git("config", "user.name", "bench");
  git("add", "-A");
  git("commit", "-qm", "init");
  return git("rev-parse", "HEAD");
}

// Checks a run repo: writes isolation.json (when outDir is given) and returns the plugins still enabled there.
export function checkIsolation(repo, outDir) {
  const r = pluginListIn(repo);
  if (outDir) writeFileSync(join(outDir, "isolation.json"), r.raw || JSON.stringify({ error: r.stderr.trim(), status: r.status }));
  try {
    return { enabled: enabledPluginIds(r.raw), error: null };
  } catch (e) {
    return { enabled: [], error: `could not read claude plugin list --json: ${e.message}` };
  }
}

const SKIP = new Set([".git", "node_modules", "__pycache__", ".claude"]);
const skipFilter = (p) => !SKIP.has(basename(p));

// Copies graded_paths of repo into dest (dest/<path>); all-or-nothing, so a file changing mid-copy skips the tick.
export async function copyGraded(repo, gradedPaths, dest) {
  const tmp = `${dest}.partial`;
  try {
    await rm(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const p of gradedPaths) {
      const src = join(repo, p);
      if (!existsSync(src)) continue;
      await cp(src, p === "." ? tmp : join(tmp, p), { recursive: true, filter: skipFilter, force: true });
    }
    await rm(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
    return true;
  } catch {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    return false;
  }
}

const killGroup = (pid, sig) => {
  try {
    process.kill(-pid, sig);
    return true;
  } catch {
    return false;
  }
};

// Launches one process in its own process group with a deadline: SIGTERM at capMs, SIGKILL 8 s later.
// onTick(index) every snapMs. Resolves {exitCode, endReason, spawnError}. Leftovers in the group are always killed.
export function launch({ cmd, args, cwd, env, stdoutFile, stderrFile, capMs, snapMs, onTick, graceMs = 8000 }) {
  return new Promise((resolve) => {
    const out = createWriteStream(stdoutFile);
    const err = createWriteStream(stderrFile);
    let child;
    try {
      child = spawn(cmd, args, { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      out.end();
      err.end();
      resolve({ exitCode: null, endReason: "error", spawnError: e.message });
      return;
    }
    child.stdout.pipe(out);
    child.stderr.pipe(err);
    let deadlineHit = false;
    let spawnError = null;
    let tick = 0;
    let busy = false;
    const ticker = snapMs > 0
      ? setInterval(async () => {
        tick++;
        if (busy) return; // previous copy still running: skip this tick
        busy = true;
        try {
          await onTick(tick);
        } finally {
          busy = false;
        }
      }, snapMs)
      : null;
    let killTimer = null;
    const deadline = setTimeout(() => {
      deadlineHit = true;
      killGroup(child.pid, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child.pid, "SIGKILL"), graceMs);
    }, capMs);
    child.on("error", (e) => { spawnError = e.message; });
    child.on("close", async (code) => {
      clearTimeout(deadline);
      if (killTimer) clearTimeout(killTimer);
      if (ticker) clearInterval(ticker);
      killGroup(child.pid, "SIGKILL");
      while (busy) await sleep(50);
      await Promise.all([new Promise((r) => out.end(r)), new Promise((r) => err.end(r))]);
      resolve({ exitCode: code, endReason: spawnError ? "error" : deadlineHit ? "deadline" : "exited", spawnError });
    });
  });
}

// One run, start to row. ctx: {root, campaignDir, reposDir, tasks (id -> loaded task), disabledIds,
//   log(line), commandFor? (test hook: (run, prompt, repo) -> {cmd,args,cwd}), skipIsolation?, graceMs?}
export async function executeRun(run, ctx) {
  const task = ctx.tasks[run.task];
  const outDir = join(ctx.campaignDir, run.run_id);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(join(outDir, "snapshots"), { recursive: true });
  const repo = join(ctx.reposDir, run.run_id);
  const row = {
    run_id: run.run_id, task: run.task, arm: run.arm, cell: run.cell, rep: run.rep, cap_min: run.cap_min,
    budget_tokens: run.budget_tokens ?? null, started_at: new Date().toISOString(), ended_at: null, wall_ms: 0,
    exit_code: null, end_reason: "error", results: [], routes: [], dir: run.run_id,
  };
  const fail = (msg) => {
    row.ended_at = new Date().toISOString();
    row.error = msg;
    return row;
  };
  let initSha;
  try {
    initSha = createRunRepo(task, run.arm, repo, ctx.root, ctx.disabledIds);
  } catch (e) {
    return fail(`setup: ${e.message}`);
  }
  if (!ctx.skipIsolation) {
    const iso = checkIsolation(repo, outDir);
    if (iso.error || iso.enabled.length) {
      if (iso.enabled.length) ctx.log?.(`isolation: ${run.run_id} still has ${iso.enabled.join(", ")} enabled`);
      return fail("isolation");
    }
  }
  const meta = task.meta;
  const capMs = Math.round(run.cap_min * 60_000);
  const start = new Date();
  const prompt = buildPrompt(task.taskMd, run.cap_min, start, new Date(start.getTime() + capMs));
  writeFileSync(join(outDir, "prompt.txt"), prompt);
  const c = ctx.commandFor ? ctx.commandFor(run, prompt, repo) : command(run.arm, prompt, repo, ctx.root);
  const graded = Array.isArray(meta.graded_paths) && meta.graded_paths.length ? meta.graded_paths : ["."];
  const every = Number(meta.snapshot_every_s) || 0;
  row.started_at = start.toISOString();
  const t0 = Date.now();
  const r = await launch({
    ...c, env: runEnv(run.arm, meta, run), stdoutFile: join(outDir, "stdout.txt"), stderrFile: join(outDir, "stderr.txt"),
    capMs, snapMs: every * 1000, graceMs: ctx.graceMs,
    onTick: (i) => copyGraded(repo, graded, join(outDir, "snapshots", snapName(i * every))),
  });
  row.wall_ms = Date.now() - t0;
  row.ended_at = new Date().toISOString();
  row.exit_code = r.exitCode;
  row.end_reason = r.endReason;
  if (r.spawnError) row.error = r.spawnError;
  await collect(repo, outDir, graded, initSha, row);
  if (isRateLimited(row.results)) row.end_reason = "rate_limited";
  return row;
}

async function collect(repo, outDir, graded, initSha, row) {
  await copyGraded(repo, graded, join(outDir, "final"));
  const state = join(repo, ".claude", "state");
  if (existsSync(state)) cpSync(state, join(outDir, "state"), { recursive: true });
  const git = (...a) => sh("git", ["-c", "core.quotepath=off", ...a], { cwd: repo }).stdout ?? "";
  writeFileSync(join(outDir, "git-log.txt"), git("log", "--oneline", "--all"));
  const files = diffFiles([git("diff", "--name-only", initSha), git("ls-files", "--others", "--exclude-standard")]);
  writeFileSync(join(outDir, "diff-files.txt"), files.length ? `${files.join("\n")}\n` : "");
  row.results = parseResults(readFileSync(join(outDir, "stdout.txt"), "utf8"));
  const routes = join(outDir, "state", "routes.jsonl");
  if (existsSync(routes)) {
    for (const line of readFileSync(routes, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        row.routes.push(JSON.parse(line));
      } catch {
        // a torn line: skip
      }
    }
  }
}

export const tokensOf = (row) => (row.results ?? []).reduce((s, r) => s + totalTokens(r), 0);
