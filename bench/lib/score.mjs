// Shared scoring helpers for bench tasks.
//   loadTask(id, tasksDir?)          -> {id, dir, meta, taskText}
//   scoreDir(id, dir, tasksDir?)     -> the task's score.mjs result for dir (a snapshot dir or a full repo)
//   applyMutant(refCopyDir, mutant)  -> writes the mutated file into refCopyDir
//   scoreNodeHidden(taskDir, dir)    -> shared scorer for node tasks that ship hidden.test.js
//   runProc(cmd, args, opts)         -> async spawn with a process-group kill on timeout
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_TASKS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "tasks");

export function loadTask(id, tasksDir = DEFAULT_TASKS_DIR) {
  const dir = join(tasksDir, id);
  const meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
  const taskText = readFileSync(join(dir, "task.md"), "utf8");
  return { id, dir, meta, taskText };
}

const lastTotal = new Map(); // task id -> total seen on a successful score, for the crash fallback

// The task's declared total (meta.json "total"), or null.
export function metaTotal(id, tasksDir = DEFAULT_TASKS_DIR) {
  try {
    const t = JSON.parse(readFileSync(join(tasksDir, id, "meta.json"), "utf8")).total;
    return Number.isFinite(t) ? t : null;
  } catch { return null; }
}

export async function scoreDir(id, dir, tasksDir = DEFAULT_TASKS_DIR) {
  const mod = await import(pathToFileURL(join(tasksDir, id, "score.mjs")).href);
  try {
    const r = await mod.score(dir);
    if (r && Number.isFinite(r.total)) lastTotal.set(id, r.total);
    return r;
  } catch {
    return { pass: false, passed: 0, total: metaTotal(id, tasksDir) ?? lastTotal.get(id) ?? 0, flags: ["grader-crash"], crashed: true };
  }
}

export function applyMutant(refCopyDir, mutant) {
  const file = join(refCopyDir, mutant.file);
  const src = readFileSync(file, "utf8");
  const n = src.split(mutant.from).length - 1;
  if (n !== 1) throw new Error(`mutant "${mutant.name}": pattern occurs ${n} times in ${mutant.file}, expected 1`);
  writeFileSync(file, src.replace(mutant.from, () => mutant.to));
}

// A nested `node --test` must not inherit the outer test runner's context, or it prints no summary.
const cleanEnv = (e) => { const c = { ...e }; delete c.NODE_TEST_CONTEXT; return c; };

// Runs a command in its own process group; kills the group on timeout. Never rejects.
export function runProc(cmd, args, { cwd, timeoutMs = 120_000, env } = {}) {
  return new Promise((res) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: cleanEnv(env ?? process.env), detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      res({ status: null, stdout, stderr: String(e), timedOut });
      return;
    }
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutMs);
    child.stdout.on("data", (d) => { if (stdout.length < 8e6) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 8e6) stderr += d; });
    const done = (status) => { clearTimeout(timer); kill(); res({ status, stdout, stderr, timedOut }); };
    child.on("close", done);
    child.on("error", (e) => { stderr += String(e); done(null); });
  });
}

const SKIP = new Set([".git", "node_modules", ".claude", "__pycache__", "hidden.test.js"]);

function nodeTestCounts(out) {
  const num = (k) => Number((new RegExp(`ℹ ${k} (\\d+)`).exec(out) || [])[1] ?? 0);
  return { tests: num("tests"), pass: num("pass"), fail: num("fail") };
}

async function runHidden(taskDir, srcDir) {
  const tmp = mkdtempSync(join(tmpdir(), "bench-node-"));
  try {
    cpSync(srcDir, tmp, { recursive: true, filter: (p) => !SKIP.has(basename(p)) });
    writeFileSync(join(tmp, "package.json"), '{"type":"module"}\n');
    cpSync(join(taskDir, "hidden.test.js"), join(tmp, "hidden.test.js"));
    const r = await runProc("node", ["--test", "--test-reporter=spec", "hidden.test.js"], { cwd: tmp, timeoutMs: 90_000 });
    return { ...nodeTestCounts(`${r.stdout}${r.stderr}`), status: r.status, timedOut: r.timedOut };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const refTotals = new Map();
async function refTotal(taskDir) {
  if (!refTotals.has(taskDir)) {
    refTotals.set(taskDir, runHidden(taskDir, join(taskDir, "ref")).then((c) => c.tests));
  }
  return refTotals.get(taskDir);
}

// Scores a node task: hidden.test.js (in taskDir) runs against a temp copy of dir. Agent-written
// hidden.test.js files are dropped, and the copy skips .git, node_modules and .claude.
export async function scoreNodeHidden(taskDir, dir) {
  const total = await refTotal(taskDir);
  const c = await runHidden(taskDir, dir);
  const passed = Math.min(c.pass, total);
  return { pass: c.status === 0 && !c.timedOut && c.fail === 0 && passed === total && total > 0, passed, total };
}
