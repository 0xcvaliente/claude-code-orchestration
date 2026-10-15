#!/usr/bin/env node
// Offline validation of benchmark tasks (no model calls).
//   node bench/validate.mjs [--task <id>] [--tasks-dir <dir>]
// Per task: meta.json is complete and well typed; setup/ alone scores pass:false; ref/ over setup/
// scores pass:true; every mutant applied to the reference scores pass:false. Exits 1 on any failure.
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_TASKS_DIR, applyMutant, loadTask, scoreDir } from "./lib/score.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const META_TYPES = {
  id: (v) => typeof v === "string" && v.length > 0,
  title: (v) => typeof v === "string" && v.length > 0,
  tier: (v) => ["small", "medium", "large"].includes(v),
  shape: (v) => ["parallel", "single", "dependent", "monolithic", "splittable"].includes(v),
  lang: (v) => ["node", "python"].includes(v),
  cap_min: (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
  total: (v) => v === undefined || (Number.isInteger(v) && v > 0),
  test_cmd: (v) => v === null || typeof v === "string",
  graded_paths: (v) => Array.isArray(v) && v.length > 0 && v.every((p) => typeof p === "string"),
  snapshot_every_s: (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
};

export function metaProblems(meta, id) {
  const bad = [];
  for (const [k, ok] of Object.entries(META_TYPES)) {
    if (!(k in meta)) bad.push(`meta.${k} missing`);
    else if (!ok(meta[k])) bad.push(`meta.${k} has a bad value: ${JSON.stringify(meta[k])}`);
  }
  if (meta.id !== id) bad.push(`meta.id "${meta.id}" does not match directory "${id}"`);
  return bad;
}

function fresh(task, withRef) {
  const dir = mkdtempSync(join(tmpdir(), "bench-validate-"));
  const setup = join(task.dir, "setup");
  if (existsSync(setup)) cpSync(setup, dir, { recursive: true });
  if (withRef) cpSync(join(task.dir, "ref"), dir, { recursive: true });
  return dir;
}

async function withDir(task, withRef, fn) {
  const dir = fresh(task, withRef);
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function loadMutants(task) {
  const list = [];
  const single = join(task.dir, "mutants.json");
  if (existsSync(single)) list.push(...JSON.parse(readFileSync(single, "utf8")));
  const sub = join(task.dir, "mutants");
  if (existsSync(sub)) {
    for (const f of readdirSync(sub).filter((n) => n.endsWith(".json")).sort()) list.push(...JSON.parse(readFileSync(join(sub, f), "utf8")));
  }
  return list;
}

async function pool(items, n, fn) {
  let next = 0;
  const out = new Array(items.length);
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

async function validateTask(id, tasksDir, jobs) {
  let failures = 0;
  const fail = (msg) => { failures++; console.log(`FAIL ${id}: ${msg}`); };
  let task;
  try { task = loadTask(id, tasksDir); } catch (e) { fail(`cannot load task: ${e.message}`); return failures; }
  const probs = metaProblems(task.meta, id);
  for (const p of probs) fail(p);
  if (!task.taskText.trim()) fail("task.md is empty");
  for (const need of ["score.mjs", "ref"]) if (!existsSync(join(task.dir, need))) fail(`${need} missing`);
  if (failures) return failures;

  const bare = await withDir(task, false, (d) => scoreDir(id, d, tasksDir));
  if (bare.pass) fail("setup/ alone scores pass:true");
  else console.log(`ok   ${id}: setup alone fails (${bare.passed}/${bare.total})`);

  const ref = await withDir(task, true, (d) => scoreDir(id, d, tasksDir));
  if (!ref.pass) fail(`reference does not pass (${ref.passed}/${ref.total}) ${JSON.stringify(ref.flags ?? [])}`);
  else console.log(`ok   ${id}: reference passes (${ref.passed}/${ref.total})`);
  if (ref.pass && "total" in task.meta && task.meta.total !== ref.total) fail(`meta.total ${task.meta.total} != reference total ${ref.total}`);

  const mutants = loadMutants(task);
  const results = await pool(mutants, jobs, (m) => withDir(task, true, async (d) => {
    try { applyMutant(d, m); } catch (e) { return { m, error: e.message }; }
    return { m, score: await scoreDir(id, d, tasksDir) };
  }));
  for (const { m, score, error } of results) {
    if (error) fail(`mutant cannot be applied: ${error}`);
    else if (score.pass) fail(`mutant "${m.name}" SURVIVED`);
    else console.log(`ok   ${id}: mutant "${m.name}" caught (${score.passed}/${score.total})`);
  }
  return failures;
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("validate.mjs")) {
  const tasksDir = resolve(arg("tasks-dir", DEFAULT_TASKS_DIR));
  const only = arg("task", null);
  const jobs = Math.max(1, Math.floor(cpus().length / 2));
  const ids = readdirSync(tasksDir).filter((d) => existsSync(join(tasksDir, d, "meta.json"))).sort().filter((d) => !only || d === only);
  if (!ids.length) { console.log(`no tasks found${only ? ` matching ${only}` : ""} in ${tasksDir}`); process.exit(1); }
  let failures = 0;
  for (const id of ids) failures += await validateTask(id, tasksDir, jobs);
  console.log(failures ? `\n${failures} problem(s)` : `\nall ${ids.length} task(s) valid`);
  process.exit(failures ? 1 : 0);
}
