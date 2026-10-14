#!/usr/bin/env node
// A/B benchmark: the same tasks under different setups, scored by hidden tests the agent never sees.
//   node scripts/compare/compare.mjs --validate                 hidden tests vs reference solutions (no model calls)
//   node scripts/compare/compare.mjs [--variants A,B,C] [--tasks t1-parallel,...] [--out dir]
//        [--repeat N] [--snapshot-every SEC] [--timeout SEC] [--budget USD]
// Variants: A orchestrator on opus | B orchestrator on sonnet + opus advisor | C plain Sonnet session | D orchestrator on sonnet
//           E auto: triage picks plain, reviewed or the orchestrator per task (scripts/auto.sh) | F plain Opus session.
// Each run gets a fresh repo under ~/orch-compare. Pass = the task's scorer passes after the run:
//   tasks/<id>/score.mjs (exports score(runDir) -> {pass, passed, failed}) if present, else `node --test hidden.test.js`.
// A task may also ship setup/ (copied into the run repo before the initial commit) and ref/ (used by --validate).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const tasksDir = join(here, "tasks");
const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const VARIANTS = {
  A: { label: "Opus orchestrator", agent: true, orchModel: "opus", advisor: "" },
  B: { label: "Sonnet orchestrator + Opus advisor", agent: true, orchModel: "sonnet", advisor: "opus" },
  C: { label: "Plain session (Sonnet)", agent: false, model: "sonnet" },
  D: { label: "Sonnet orchestrator, no advisor", agent: true, orchModel: "sonnet", advisor: "" },
  E: { label: "Auto (triage routes)", agent: true, orchModel: "opus", advisor: "", auto: true },
  F: { label: "Plain session (Opus)", agent: false, model: "opus" },
};
const taskIds = readdirSync(tasksDir).filter((d) => existsSync(join(tasksDir, d, "task.txt"))).sort();

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

// Scores dir for task id. Tasks with score.mjs use it; others get hidden.test.js copied in and run with node --test.
async function scoreDir(id, dir) {
  const custom = join(tasksDir, id, "score.mjs");
  if (existsSync(custom)) {
    const mod = await import(pathToFileURL(custom).href);
    return mod.score(dir);
  }
  cpSync(join(tasksDir, id, "hidden.test.js"), join(dir, "hidden.test.js"));
  const r = run("node", ["--test", "hidden.test.js"], { cwd: dir, timeout: 60_000 });
  const out = `${r.stdout}${r.stderr}`;
  const num = (k) => Number((new RegExp(`ℹ ${k} (\\d+)`).exec(out) || [])[1] ?? 0);
  return { pass: r.status === 0 && num("pass") > 0 && num("fail") === 0, passed: num("pass"), failed: num("fail") };
}

// Seeds a run directory: package.json (unless setup/ brings its own) then the task's setup/ files.
function seedTask(id, dir) {
  const setupDir = join(tasksDir, id, "setup");
  if (!existsSync(join(setupDir, "package.json"))) writeFileSync(join(dir, "package.json"), '{"name":"cmp","type":"module","scripts":{"test":"node --test"}}\n');
  if (existsSync(setupDir)) cpSync(setupDir, dir, { recursive: true });
}

if (process.argv.includes("--validate")) {
  let bad = 0;
  for (const id of taskIds) {
    const tmp = join(homedir(), "orch-compare", `_validate-${id}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    seedTask(id, tmp);
    const without = await scoreDir(id, tmp);
    cpSync(join(tasksDir, id, "ref"), tmp, { recursive: true });
    const withRef = await scoreDir(id, tmp);
    const ok = !without.pass && withRef.pass;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${id}: without solution pass=${without.pass}, with reference pass=${withRef.pass} (${withRef.passed} tests)`);
    rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(bad ? 1 : 0);
}

const variants = (arg("variants", "A,B,C")).split(",").map((v) => v.trim());
const tasks = (arg("tasks", taskIds.join(","))).split(",").map((t) => t.trim());
const repeat = Math.max(1, Number(arg("repeat", "1")) || 1);
const snapEvery = Number(arg("snapshot-every", "0")) || 0;
const timeoutSec = Number(arg("timeout", "3600")) || 3600;
const base = join(homedir(), "orch-compare");
const outDir = resolve(arg("out", join(root, "runs", "compare")));
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const resultsFile = join(outDir, `compare-${stamp}.jsonl`);

function setup(variant, id, rep) {
  const v = VARIANTS[variant];
  const dir = join(base, `${variant}-${id}${repeat > 1 ? `-${rep}` : ""}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  seedTask(id, dir);
  writeFileSync(join(dir, ".gitignore"), ".claude/state/\n.claude/worktrees/\n__pycache__/\n");
  if (v.agent) {
    cpSync(join(root, ".claude"), join(dir, ".claude"), { recursive: true, filter: (p) => !p.includes(`${join(".claude", "state")}`) && !p.includes(`${join(".claude", "worktrees")}`) });
    const orch = join(dir, ".claude", "agents", "orchestrator.md");
    writeFileSync(orch, readFileSync(orch, "utf8").replace(/^model:.*$/m, `model: ${v.orchModel}`));
  }
  const git = (...a) => run("git", a, { cwd: dir });
  git("init", "-q");
  git("config", "user.email", "bench@local");
  git("config", "user.name", "bench");
  git("add", "-A");
  git("commit", "-qm", "init");
  return dir;
}

const SKIP = new Set([".git", "node_modules", ".claude", "__pycache__"]);
function snapshot(dir, dest) {
  try {
    cpSync(dir, dest, { recursive: true, filter: (p) => !SKIP.has(p.split("/").pop()) });
    return true;
  } catch {
    return false; // files changing under us: skip this tick
  }
}

// Runs the agent script as a detached process group so a timeout kills the whole tree. Calls onTick every snapEvery seconds.
function runAgent(cmd, args, env, onTick) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let timedOut = false;
    let ticker = null;
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", () => {});
    const kill = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { timedOut = true; kill(); }, timeoutSec * 1000);
    const t0 = Date.now();
    if (snapEvery > 0) ticker = setInterval(() => onTick(Math.round((Date.now() - t0) / 1000)), snapEvery * 1000);
    const finish = () => {
      clearTimeout(timer);
      if (ticker) clearInterval(ticker);
      kill(); // reap stragglers in the group
      resolveRun({ stdout, timedOut });
    };
    child.on("close", finish);
    child.on("error", finish);
  });
}

console.log(`results: ${resultsFile}`);
for (const id of tasks) {
  for (const variant of variants) {
    for (let rep = 1; rep <= repeat; rep++) {
      const v = VARIANTS[variant];
      const dir = setup(variant, id, rep);
      const task = readFileSync(join(tasksDir, id, "task.txt"), "utf8").trim();
      const snaps = [];
      const snapRoot = join(outDir, "snapshots", stamp, `${id}-${variant}-${rep}`);
      const t0 = process.hrtime.bigint();
      const env = { ...process.env, ORCH_AGENT: v.agent ? "orchestrator" : "none", ORCH_ADVISOR: v.advisor || "", ORCH_BUDGET_USD: arg("budget", "") };
      if (v.model) env.ORCH_MODEL = v.model;
      const r = await runAgent("bash", [join(root, "scripts", v.auto ? "auto.sh" : "orchestrate.sh"), task, dir], env, (secs) => {
        const dest = join(snapRoot, `t${secs}`);
        if (snapshot(dir, dest)) snaps.push({ secs, dest });
      });
      const wall = Number((process.hrtime.bigint() - t0) / 1_000_000n);
      // auto.sh prints several JSON documents when it escalates; the last one is the run that finished the task.
      const text = `${r.stdout}`;
      const routes = existsSync(join(dir, ".claude", "state", "routes.jsonl"))
        ? readFileSync(join(dir, ".claude", "state", "routes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).mode)
        : [];
      let j = null;
      try {
        const docs = text.split("\n").filter((l) => l.startsWith("{"));
        j = JSON.parse(docs.length ? docs[docs.length - 1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
      } catch {
        // unparsed: recorded below
      }
      const s = await scoreDir(id, dir);
      const timeline = [];
      for (const sn of snaps) {
        const ss = await scoreDir(id, sn.dest);
        timeline.push([sn.secs, ss.pass ? 1 : 0]);
      }
      const firstPass = timeline.find((t) => t[1] === 1);
      const byModel = Object.fromEntries(Object.entries(j?.modelUsage ?? {}).map(([m, u]) => [m.replace("claude-", ""), Number(u.costUSD.toFixed(4))]));
      const row = {
        task: id, variant, rep, label: v.label, pass: s.pass, hidden_passed: s.passed, hidden_failed: s.failed,
        cost_usd: j ? Number(j.total_cost_usd.toFixed(4)) : null, by_model: byModel,
        wall_ms: wall, turns: j?.num_turns ?? null, subagents: j?.subagent_stats?.by_type ?? {},
        denials: j?.permission_denials?.length ?? null, error: j ? j.is_error : true, routes, timed_out: r.timedOut,
      };
      if (snapEvery > 0) {
        row.timeline = timeline;
        row.first_pass_s = firstPass ? firstPass[0] : null;
      }
      appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
      console.log(`${id} ${variant}#${rep} pass=${row.pass} (${s.passed}/${s.passed + s.failed}) cost=${row.cost_usd} wall=${(wall / 1000).toFixed(0)}s denials=${row.denials}${row.timed_out ? " TIMEOUT" : ""}`);
    }
  }
}

const rows = readFileSync(resultsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const money = (n) => `$${n.toFixed(2)}`;
const groups = new Map();
for (const r of rows) {
  const k = `${r.task}\t${r.variant}`;
  if (!groups.has(k)) groups.set(k, []);
  groups.get(k).push(r);
}
const summary = [
  "| Task | Setup | Pass rate | Mean cost | Cost range | Mean wall time |",
  "|---|---|---|---|---|---|",
  ...[...groups.values()].map((g) => {
    const costs = g.map((r) => r.cost_usd).filter((c) => c !== null);
    const mean = costs.length ? money(costs.reduce((a, b) => a + b, 0) / costs.length) : "n/a";
    const range = costs.length ? `${money(Math.min(...costs))}-${money(Math.max(...costs))}` : "n/a";
    const wall = (g.reduce((a, r) => a + r.wall_ms, 0) / g.length / 1000).toFixed(0);
    return `| ${g[0].task} | ${g[0].variant}: ${g[0].label} | ${g.filter((r) => r.pass).length}/${g.length} | ${mean} | ${range} | ${wall}s |`;
  }),
].join("\n");
const perRun = [
  "| Task | Setup | Rep | Hidden tests | List-price cost | Wall time | Turns | Agents | Denials | First pass |",
  "|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.task} | ${r.variant}: ${r.label} | ${r.rep ?? 1} | ${r.pass ? "pass" : "FAIL"} (${r.hidden_passed}/${r.hidden_passed + r.hidden_failed}) | $${r.cost_usd ?? "n/a"} | ${(r.wall_ms / 1000).toFixed(0)}s | ${r.turns ?? "n/a"} | ${(r.routes ?? []).length ? `route:${r.routes.join(">")} ` : ""}${Object.entries(r.subagents).map(([k, n]) => `${k}:${n}`).join(" ") || "none"} | ${r.denials ?? "n/a"} | ${r.first_pass_s === undefined ? "off" : r.first_pass_s === null ? "never" : `${r.first_pass_s}s`} |`),
].join("\n");
const md = `${summary}\n\n${perRun}`;
writeFileSync(resultsFile.replace(".jsonl", ".md"), `${md}\n`);
console.log(`\n${md}`);
