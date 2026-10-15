#!/usr/bin/env node
// Offline grading of a benchmark campaign.
//   node bench/grade.mjs <campaign dir> [--jobs N] [--only <substring>] [--final-only] [--tasks-dir <dir>]
// For every run in <campaign>/runs.jsonl, grades each snapshots/tNNNN/ dir and final/ with the task's
// score.mjs, in parallel child processes. Identical (task, content hash) pairs are graded once, via
// <campaign>/grades-cache.json. Rows are appended to <campaign>/grades.jsonl; (run_id, snap) pairs
// already there are skipped, so the command is idempotent and resumable.
// --variant lenient: grades final/ only, with the task's secondary variant (only tasks whose score.mjs
// exports it, k2 for now; others are skipped with a note), into <campaign>/grades-lenient.jsonl. The
// cache keys carry the variant, so strict and lenient grades never mix.
import { appendFileSync, existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DEFAULT_TASKS_DIR, metaTotal, scoreDir, supportsVariant } from "./lib/score.mjs";

const self = fileURLToPath(import.meta.url);
const HASH_SKIP = new Set([".git", "node_modules", "__pycache__", ".claude"]);

export function hashDir(dir) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      if (HASH_SKIP.has(name)) continue;
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) h.update(`${relative(dir, p)}\0${st.size}\0`).update(readFileSync(p)).update("\0");
    }
  };
  walk(dir);
  return h.digest("hex");
}

const readJsonl = (f) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

function listSnapshots(runDir) {
  const out = [];
  const sdir = join(runDir, "snapshots");
  if (existsSync(sdir)) {
    for (const n of readdirSync(sdir).filter((x) => /^t\d{4}$/.test(x)).sort()) out.push({ snap: n, secs: Number(n.slice(1)), dir: join(sdir, n) });
  }
  return out;
}

// Child process: print the score of one dir as JSON on stdout.
async function scoreOne(taskId, dir, tasksDir, variant) {
  const r = await scoreDir(taskId, dir, tasksDir, variant || null);
  process.stdout.write(`\n@@RESULT@@${JSON.stringify(r)}\n`);
}

function scoreInChild(taskId, dir, tasksDir, variant) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [self, "--score-one", taskId, dir, "--tasks-dir", tasksDir, ...(variant ? ["--variant", variant] : [])], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    const fallback = { pass: false, passed: 0, total: metaTotal(taskId, tasksDir) ?? 0, flags: ["grader-crash"], crashed: true };
    child.on("error", () => res(fallback));
    child.on("close", () => {
      const i = out.lastIndexOf("@@RESULT@@");
      try { res(JSON.parse(out.slice(i + "@@RESULT@@".length))); } catch { res(fallback); }
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, fb) => { const i = args.indexOf(`--${name}`); return i === -1 ? fb : args[i + 1]; };
  const tasksDir = resolve(opt("tasks-dir", DEFAULT_TASKS_DIR));
  const variant = opt("variant", null);
  if (args[0] === "--score-one") return scoreOne(args[1], args[2], tasksDir, variant);
  if (variant && variant !== "lenient") { console.error(`unknown --variant ${variant} (only: lenient)`); process.exit(2); }

  const flagWithValue = new Set(["--jobs", "--only", "--tasks-dir", "--variant"]);
  const positional = args.filter((a, i) => !a.startsWith("--") && !flagWithValue.has(args[i - 1]));
  if (!positional[0]) { console.error("usage: node bench/grade.mjs <campaign dir> [--jobs N] [--only <substring>] [--final-only] [--variant lenient]"); process.exit(2); }
  const campaign = resolve(positional[0]);
  const jobs = Math.max(1, Number(opt("jobs", 0)) || Math.max(1, Math.floor(cpus().length / 2)));
  const only = opt("only", null);
  const finalOnly = args.includes("--final-only") || !!variant;

  const runs = readJsonl(join(campaign, "runs.jsonl")).filter((r) => !only || r.run_id.includes(only));
  const gradesFile = join(campaign, variant ? `grades-${variant}.jsonl` : "grades.jsonl");
  const cacheFile = join(campaign, "grades-cache.json");
  const done = new Set(readJsonl(gradesFile).filter((g) => !g.crashed && !(g.flags ?? []).some((f) => f.startsWith("grader-crash"))).map((g) => `${g.run_id}\0${g.snap}`));
  let cache = {};
  try { cache = JSON.parse(readFileSync(cacheFile, "utf8")); } catch { /* none yet */ }

  const saveCache = () => { writeFileSync(`${cacheFile}.tmp`, JSON.stringify(cache)); renameSync(`${cacheFile}.tmp`, cacheFile); };
  let running = 0;
  const waiting = [];
  const slot = () => new Promise((r) => { if (running < jobs) { running++; r(); } else waiting.push(r); });
  const release = () => { const n = waiting.shift(); if (n) n(); else running--; };
  const inflight = new Map();
  const resultFor = (task, hash, dir) => {
    const key = variant ? `${variant}:${task}:${hash}` : `${task}:${hash}`;
    if (cache[key]) return Promise.resolve(cache[key]);
    if (!inflight.has(key)) {
      inflight.set(key, (async () => {
        await slot();
        try {
          const r = await scoreInChild(task, dir, tasksDir, variant);
          if (!r.crashed) { cache[key] = r; saveCache(); }
          return r;
        } finally { release(); }
      })());
    }
    return inflight.get(key);
  };

  let graded = 0;
  const supported = new Map();
  const skippedTasks = new Set();
  await Promise.all(runs.map(async (run) => {
    if (variant) {
      if (!supported.has(run.task)) supported.set(run.task, await supportsVariant(run.task, variant, tasksDir));
      if (!supported.get(run.task)) { skippedTasks.add(run.task); return; }
    }
    const runDir = join(campaign, run.run_id);
    const items = [];
    if (!finalOnly) items.push(...listSnapshots(runDir));
    const fin = join(runDir, "final");
    if (existsSync(fin)) items.push({ snap: "final", secs: Math.round((run.wall_ms ?? 0) / 1000), dir: fin });
    const todo = items.filter((it) => !done.has(`${run.run_id}\0${it.snap}`));
    if (!todo.length) return;
    const results = await Promise.all(todo.map((it) => {
      it.hash = hashDir(it.dir);
      return resultFor(run.task, it.hash, it.dir);
    }));
    todo.forEach((it, i) => {
      const r = results[i];
      const row = { run_id: run.run_id, snap: it.snap, secs: it.secs, pass: !!r.pass, passed: r.passed ?? 0, total: r.total ?? 0, by_cat: r.by_cat ?? null, suites: r.suites ?? null, flags: r.flags ?? [], hash: it.hash };
      appendFileSync(gradesFile, `${JSON.stringify(row)}\n`);
    });
    graded++;
    const last = results[results.length - 1];
    console.log(`graded ${run.run_id} (${run.task}): ${todo.length} dir(s), last ${last.passed ?? 0}/${last.total ?? 0}`);
  }));
  if (skippedTasks.size) console.log(`note: variant ${variant} not supported by task(s) ${[...skippedTasks].sort().join(", ")}: skipped`);
  console.log(`done: ${graded} run(s) graded, ${runs.length - graded} up to date or empty`);
}

if (process.argv[1] && resolve(process.argv[1]) === self) await main();
