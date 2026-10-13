#!/usr/bin/env node
// A/B benchmark: the same tasks under different setups, scored by hidden tests the agent never sees.
//   node scripts/compare/compare.mjs --validate                 hidden tests vs reference solutions (no model calls)
//   node scripts/compare/compare.mjs [--variants A,B,C] [--tasks t1-parallel,...] [--out dir]
// Variants: A orchestrator on opus | B orchestrator on sonnet + opus advisor | C plain session | D orchestrator on sonnet.
// Each run gets a fresh git repo under ~/orch-compare. Pass = the hidden test file passes after the run.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

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
  C: { label: "Plain session", agent: false },
  D: { label: "Sonnet orchestrator, no advisor", agent: true, orchModel: "sonnet", advisor: "" },
};
const taskIds = readdirSync(tasksDir).filter((d) => existsSync(join(tasksDir, d, "task.txt"))).sort();

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });

function score(dir) {
  const r = run("node", ["--test", "hidden.test.js"], { cwd: dir, timeout: 60_000 });
  const out = `${r.stdout}${r.stderr}`;
  const num = (k) => Number((new RegExp(`ℹ ${k} (\\d+)`).exec(out) || [])[1] ?? 0);
  return { pass: r.status === 0 && num("pass") > 0 && num("fail") === 0, passed: num("pass"), failed: num("fail") };
}

if (process.argv.includes("--validate")) {
  let bad = 0;
  for (const id of taskIds) {
    const tmp = join(homedir(), "orch-compare", `_validate-${id}`);
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    writeFileSync(join(tmp, "package.json"), '{"type":"module"}\n');
    cpSync(join(tasksDir, id, "hidden.test.js"), join(tmp, "hidden.test.js"));
    const without = score(tmp);
    cpSync(join(tasksDir, id, "ref"), tmp, { recursive: true });
    const withRef = score(tmp);
    const ok = !without.pass && withRef.pass;
    if (!ok) bad++;
    console.log(`${ok ? "ok  " : "FAIL"} ${id}: without solution pass=${without.pass}, with reference pass=${withRef.pass} (${withRef.passed} tests)`);
    rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(bad ? 1 : 0);
}

const variants = (arg("variants", "A,B,C")).split(",").map((v) => v.trim());
const tasks = (arg("tasks", taskIds.join(","))).split(",").map((t) => t.trim());
const base = join(homedir(), "orch-compare");
const outDir = resolve(arg("out", join(root, "runs", "compare")));
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
const resultsFile = join(outDir, `compare-${stamp}.jsonl`);

function setup(variant, id) {
  const v = VARIANTS[variant];
  const dir = join(base, `${variant}-${id}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), '{"name":"cmp","type":"module","scripts":{"test":"node --test"}}\n');
  writeFileSync(join(dir, ".gitignore"), ".claude/state/\n.claude/worktrees/\n");
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

console.log(`results: ${resultsFile}`);
for (const id of tasks) {
  for (const variant of variants) {
    const v = VARIANTS[variant];
    const dir = setup(variant, id);
    const task = readFileSync(join(tasksDir, id, "task.txt"), "utf8").trim();
    const t0 = process.hrtime.bigint();
    const r = run("bash", [join(root, "scripts", "orchestrate.sh"), task, dir], {
      env: { ...process.env, ORCH_AGENT: v.agent ? "orchestrator" : "none", ORCH_ADVISOR: v.advisor || "", ORCH_BUDGET_USD: arg("budget", "12") },
      timeout: 3_600_000,
    });
    const wall = Number((process.hrtime.bigint() - t0) / 1_000_000n);
    const text = `${r.stdout}`;
    let j = null;
    try {
      j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch {
      // unparsed: recorded below
    }
    cpSync(join(tasksDir, id, "hidden.test.js"), join(dir, "hidden.test.js"));
    const s = score(dir);
    const byModel = Object.fromEntries(Object.entries(j?.modelUsage ?? {}).map(([m, u]) => [m.replace("claude-", ""), Number(u.costUSD.toFixed(4))]));
    const row = {
      task: id, variant, label: v.label, pass: s.pass, hidden_passed: s.passed, hidden_failed: s.failed,
      cost_usd: j ? Number(j.total_cost_usd.toFixed(4)) : null, by_model: byModel,
      wall_ms: wall, turns: j?.num_turns ?? null, subagents: j?.subagent_stats?.by_type ?? {},
      denials: j?.permission_denials?.length ?? null, error: j ? j.is_error : true,
    };
    appendFileSync(resultsFile, `${JSON.stringify(row)}\n`);
    console.log(`${id} ${variant} pass=${row.pass} (${s.passed}/${s.passed + s.failed}) cost=${row.cost_usd} wall=${(wall / 1000).toFixed(0)}s denials=${row.denials}`);
  }
}

const rows = readFileSync(resultsFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const md = [
  "| Task | Setup | Hidden tests | List-price cost | Wall time | Turns | Agents | Denials |",
  "|---|---|---|---|---|---|---|---|",
  ...rows.map((r) => `| ${r.task} | ${r.variant}: ${r.label} | ${r.pass ? "pass" : "FAIL"} (${r.hidden_passed}/${r.hidden_passed + r.hidden_failed}) | $${r.cost_usd ?? "n/a"} | ${(r.wall_ms / 1000).toFixed(0)}s | ${r.turns ?? "n/a"} | ${Object.entries(r.subagents).map(([k, n]) => `${k}:${n}`).join(" ") || "none"} | ${r.denials ?? "n/a"} |`),
].join("\n");
writeFileSync(resultsFile.replace(".jsonl", ".md"), `${md}\n`);
console.log(`\n${md}`);
