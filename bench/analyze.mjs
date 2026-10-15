#!/usr/bin/env node
// Turns one or more benchmark campaigns (runs/bench/<campaign>/) into summary.json: per-run metrics, per-cell
// statistics, comparisons against the plain-session baselines with seeded bootstrap CIs, and mechanical verdicts on
// the hypotheses. Cost is measured in tokens only; dollar fields in the inputs are ignored.
// Usage: node bench/analyze.mjs <campaign dir> [<campaign dir> ...] [--out <summary.json>]
//        (default out: <first campaign>/summary.json)
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { usageOf } from "../scripts/tokens.mjs";
import { classifyClaim } from "./lib/claims.mjs";
import { bootstrapCI, iqr, max, mean, median, medianDiff, medianRatio, min } from "./lib/stats.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export const ARMS = ["P-S", "P-O", "O-mix", "O-O", "AUTO"];
export const TASKS = ["t1-parallel", "t2-single", "h1-query-engine", "h2-scheduler", "k1-stdlib-toolkit", "h3-sql-engine", "k2-stdlib-toolkit-xl"];
export const TASK_META = {
  "t1-parallel": { tier: "small", shape: "parallel" },
  "t2-single": { tier: "small", shape: "single" },
  "h1-query-engine": { tier: "medium", shape: "splittable" },
  "h2-scheduler": { tier: "medium", shape: "splittable" },
  "k1-stdlib-toolkit": { tier: "large", shape: "splittable" },
  "h3-sql-engine": { tier: "large", shape: "monolithic" },
  "k2-stdlib-toolkit-xl": { tier: "large", shape: "splittable" },
};
export const CELLS = ["main", "cap10", "cap60", "budget1M", "budget3M", "budget8M"];
const CLAIMS = new Set(["success", "partial", "failure", "unclear", "none"]);
export const EXCLUDED_REASONS = new Set(["rate_limited", "error"]);
const BOOT_ITERATIONS = 10_000;
const MIN_N = 2; // below this a hypothesis is inconclusive
const DIRECTION_ONLY_N = 3; // below this a cell or comparison shows direction only

// ---------- reading ----------

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

export function loadCampaign(dir) {
  const abs = resolve(dir);
  return {
    dir: abs,
    manifest: readJson(join(abs, "manifest.json")) ?? {},
    runs: readJsonl(join(abs, "runs.jsonl")),
    grades: latestGrades(readJsonl(join(abs, "grades.jsonl"))),
    // Secondary (lenient) grades of final/ only; null when the campaign has no grades-lenient.jsonl.
    // Optional manual claim audit: {"<run_id>": {claim, note}}; null when absent or unreadable.
    audit: readJson(join(abs, "claims-audit.json")),
    lenient: existsSync(join(abs, "grades-lenient.jsonl")) ? latestGrades(readJsonl(join(abs, "grades-lenient.jsonl"))) : null,
  };
}

// grade.mjs appends a fresh row when it retries a crashed grade: keep the LAST row per (run_id, snap), in file order.
export function latestGrades(rows) {
  const last = new Map();
  rows.forEach((g, i) => last.set(`${g.run_id}\u0000${g.snap}`, i));
  return rows.filter((g, i) => last.get(`${g.run_id}\u0000${g.snap}`) === i);
}

// Task meta: the campaign's own copy first (tasks/<task>/meta.json), then the run dir, then bench/tasks.
function taskMeta(campaignDir, runId, task) {
  for (const f of [join(campaignDir, "tasks", task, "meta.json"), join(campaignDir, runId, "meta.json"), join(HERE, "tasks", task, "meta.json")]) {
    const m = existsSync(f) ? readJson(f) : null;
    if (m) return m;
  }
  return null;
}

// ---------- per-run metrics ----------

const stripModel = (m) => String(m).replace(/^claude-/, "");
const emptyUsage = () => ({ input: 0, output: 0, cache_read: 0, cache_write: 0, total: 0 });

// Sums every result doc (an AUTO run has the session, reviewer and escalated orchestrator) plus AUTO triage calls.
export function tokensOf(results, routes) {
  const byModel = {};
  const add = (model, u) => {
    const t = (byModel[model] ??= emptyUsage());
    t.input += u.input;
    t.output += u.output;
    t.cache_read += u.cacheRead;
    t.cache_write += u.cacheWrite;
    t.total += u.input + u.output + u.cacheRead + u.cacheWrite;
  };
  for (const doc of results ?? []) {
    const models = Object.entries(doc?.modelUsage ?? {});
    if (models.length) for (const [m, u] of models) add(stripModel(m), usageOf({ modelUsage: { [m]: u } }));
    else if (doc?.usage) add("unknown", usageOf(doc));
  }
  for (const r of routes ?? []) {
    if (typeof r?.tokens === "number" && Number.isFinite(r.tokens)) {
      const t = (byModel.triage ??= emptyUsage());
      t.total += r.tokens;
    }
  }
  const vals = Object.values(byModel);
  return { total: vals.reduce((a, t) => a + t.total, 0), by_model: byModel, output_total: vals.reduce((a, t) => a + t.output, 0) };
}

const pctOf = (g) => (g && typeof g.passed === "number" && g.total > 0 ? (100 * g.passed) / g.total : null);

// Grade rows of one run -> timeline [[secs, pct]] sorted by time, final grade, t90/t100.
// gradeRows are one run's rows; duplicates of a snap (grader retries) are reduced to the last one in file order.
export function timelineOf(rows, wallS) {
  const gradeRows = latestGrades(rows);
  const final = gradeRows.findLast((g) => g.snap === "final") ?? null;
  const points = gradeRows
    .filter((g) => pctOf(g) !== null)
    .map((g) => [typeof g.secs === "number" ? g.secs : g.snap === "final" ? wallS : Number(String(g.snap).replace(/\D/g, "")), pctOf(g), g.snap === "final"])
    .filter(([s]) => typeof s === "number" && Number.isFinite(s))
    .sort((a, b) => a[0] - b[0] || Number(a[2]) - Number(b[2]))
    .map(([s, p]) => [s, Math.round(p * 100) / 100]);
  const first = (thr) => points.find(([, p]) => p >= thr - 1e-9)?.[0] ?? null;
  return { final, timeline: points, t90_s: first(90), t100_s: first(100) };
}

// Time-weighted mean pct over [0, cap], the timeline read as a step function that starts at 0.
export function aucOf(timeline, capS) {
  if (!(capS > 0)) return null;
  let area = 0;
  let prevT = 0;
  let prevP = 0;
  for (const [t, p] of timeline) {
    const tt = Math.min(Math.max(t, 0), capS);
    area += (tt - prevT) * prevP;
    prevT = tt;
    prevP = p;
    if (t >= capS) break;
  }
  area += (capS - prevT) * prevP;
  return Math.round((area / capS) * 100) / 100;
}

const eventName = (e) => e.hook_event_name ?? e.event ?? e.type;
const agentType = (e) => String(e.agent_type ?? "unknown").replace(/^.*:/, "");
const tsOf = (e) => (typeof e.ts === "number" ? e.ts : Date.parse(e.ts));

// Subagent counts, max concurrency (Start/Stop intervals; an unmatched Start stays open), worktrees and reviewer rounds.
export function processOf(events) {
  const starts = events.filter((e) => eventName(e) === "SubagentStart");
  const stops = events.filter((e) => eventName(e) === "SubagentStop");
  const subagents = {};
  for (const e of starts) subagents[agentType(e)] = (subagents[agentType(e)] ?? 0) + 1;
  const timeline = [...starts.map((e) => [tsOf(e), 1, e.agent_id]), ...stops.map((e) => [tsOf(e), -1, e.agent_id])].sort(
    (a, b) => a[0] - b[0] || a[1] - b[1],
  );
  const open = new Set();
  let peak = 0;
  for (const [, d, id] of timeline) {
    if (d > 0) open.add(id ?? Symbol("anon"));
    else open.delete(id);
    peak = Math.max(peak, open.size);
  }
  const worktrees = new Set();
  for (const e of events) {
    const m = /\/\.claude\/worktrees\/([^/]+)/.exec(String(e.cwd ?? ""));
    if (m) worktrees.add(m[1]);
  }
  const reviewStops = stops.filter((e) => /reviewer/.test(agentType(e))).length;
  const reviewStarts = starts.filter((e) => /reviewer/.test(agentType(e))).length;
  return {
    subagents,
    subagent_count: starts.length,
    max_concurrent_subagents: peak,
    worktrees: worktrees.size,
    reviewer_rounds: reviewStops || reviewStarts,
  };
}

export function gatesOf(rows) {
  const out = {};
  for (const g of rows) {
    const k = `${g.gate ?? "gate"}:${g.decision ?? "unknown"}`;
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

// Graded paths are prefixes ("src/") or globs ("lib/**/*.py", "*.js").
const globRe = (p) =>
  new RegExp(
    `^${p
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*\*\/?/g, "\u0000")
      .replace(/\*/g, "[^/]*")
      .replace(/\?/g, "[^/]")
      .replace(/\u0000/g, ".*")}$`,
  );
export function outsideGraded(paths, graded) {
  if (!Array.isArray(graded) || !graded.length) return null;
  const tests = graded.map((g) => (/[*?]/.test(g) ? (p) => globRe(g).test(p) : (p) => p === g || p.startsWith(g.endsWith("/") ? g : `${g}/`)));
  return paths.filter((p) => !tests.some((t) => t(p)));
}

export function analyzeRun(row, grades, campaign) {
  const runDir = join(campaign.dir, row.run_id);
  const results = Array.isArray(row.results) ? row.results : [];
  const routes = Array.isArray(row.routes) ? row.routes : [];
  const wallS = typeof row.wall_ms === "number" ? row.wall_ms / 1000 : null;
  const meta = taskMeta(campaign.dir, row.run_id, row.task);
  const capMin = row.cap_min ?? meta?.cap_min ?? null;
  const g = timelineOf(grades.filter((x) => x.run_id === row.run_id), wallS);
  const score = pctOf(g.final);
  const pass = g.final ? Boolean(g.final.pass) : null;
  // Lenient variant (bench/grade.mjs --variant lenient): only when grades-lenient.jsonl exists. A run
  // with no lenient row (task without the variant, or not graded yet) gets null.
  const lenRow = campaign.lenient ? campaign.lenient.find((x) => x.run_id === row.run_id && x.snap === "final") : null;
  const lenScore = pctOf(lenRow);
  const lenient = campaign.lenient
    ? { score_pct_lenient: lenScore === null ? null : Math.round(lenScore * 100) / 100, pass_lenient: lenRow ? Boolean(lenRow.pass) : null }
    : {};
  const finalDoc = results.at(-1);
  const claimAuto = classifyClaim(finalDoc?.result);
  const auditRow = campaign.audit?.[row.run_id];
  const audited = CLAIMS.has(auditRow?.claim);
  const claim = audited ? auditRow.claim : claimAuto;
  const events = readJsonl(join(runDir, "state", "telemetry.jsonl"));
  const proc = processOf(events);
  let subagents = proc.subagents;
  let subagentCount = proc.subagent_count;
  let subagentsSource = events.length ? "telemetry" : "none";
  if (!events.length) {
    // No hooks (plain sessions): the result docs carry the built-in subagent counts.
    const stats = results.map((d) => d?.subagent_stats?.by_type).filter((b) => b && typeof b === "object");
    if (stats.length) {
      subagentsSource = "subagent_stats";
      subagents = {};
      for (const b of stats) for (const [k, v] of Object.entries(b)) if (typeof v === "number") subagents[k] = (subagents[k] ?? 0) + v;
      subagentCount = Object.values(subagents).reduce((a, v) => a + v, 0);
    }
  }
  const diffFiles = existsSync(join(runDir, "diff-files.txt"))
    ? readFileSync(join(runDir, "diff-files.txt"), "utf8").split("\n").map((l) => l.trim()).filter(Boolean)
    : [];
  const sum = (f) => results.reduce((a, d) => a + (typeof d?.[f] === "number" ? d[f] : 0), 0);
  return {
    run_id: row.run_id,
    campaign: campaign.manifest.campaign ?? campaign.dir,
    task: row.task,
    tier: meta?.tier ?? TASK_META[row.task]?.tier ?? null,
    arm: row.arm,
    cell: row.cell ?? "main",
    rep: row.rep,
    cap_min: capMin,
    budget_tokens: row.budget_tokens ?? null,
    end_reason: row.end_reason,
    excluded: EXCLUDED_REASONS.has(row.end_reason),
    exit_code: row.exit_code ?? null,
    error: row.error ?? null,
    wall_s: wallS,
    num_turns: sum("num_turns"),
    result_docs: results.length,
    tokens: tokensOf(results, routes),
    score_pct: score === null ? null : Math.round(score * 100) / 100,
    pass,
    ...lenient,
    passed: g.final?.passed ?? null,
    total: g.final?.total ?? null,
    timeline: g.timeline,
    t90_s: g.t90_s,
    t100_s: g.t100_s,
    auc: capMin ? aucOf(g.timeline, capMin * 60) : null,
    ...proc,
    subagents,
    subagent_count: subagentCount,
    subagents_source: subagentsSource,
    self_delegated: String(row.arm).startsWith("P-") && subagentCount > 0,
    max_concurrent_subagents: events.length ? proc.max_concurrent_subagents : null,
    gates: gatesOf(readJsonl(join(runDir, "state", "gates.jsonl"))),
    routes: routes.map((r) => r.mode ?? r.route ?? r.decision ?? "unknown"),
    permission_denials: results.reduce((a, d) => a + (Array.isArray(d?.permission_denials) ? d.permission_denials.length : 0), 0),
    claim,
    claim_auto: claimAuto,
    claim_source: audited ? "audit" : "auto",
    ...(audited && auditRow.note ? { claim_note: String(auditRow.note) } : {}),
    false_success: claim === "success" && pass === false,
    files_touched: diffFiles.length,
    outside_graded: outsideGraded(diffFiles, meta?.graded_paths),
  };
}

// ---------- cells ----------

const r2 = (x) => (x === null || x === undefined ? null : Math.round(x * 100) / 100);
const key = (task, arm, cell) => `${task}|${arm}|${cell}`;

export function buildCells(runs, allRuns = runs) {
  const groups = new Map();
  for (const r of runs) {
    const k = key(r.task, r.arm, r.cell);
    (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
  }
  const cells = [];
  for (const [k, rs] of groups) {
    const [task, arm, cell] = k.split("|");
    const scores = rs.map((r) => r.score_pct);
    const tokens = rs.map((r) => r.tokens?.total);
    const graded = rs.filter((r) => r.pass !== null && r.pass !== undefined);
    const others = allRuns.filter((r) => r.task === task && r.arm === arm && r.cell === cell);
    const si = iqr(scores);
    const ti = iqr(tokens);
    cells.push({
      task,
      arm,
      cell,
      n: rs.length,
      direction_only: rs.length < DIRECTION_ONLY_N,
      graded: graded.length,
      pass_rate: graded.length ? r2(graded.filter((r) => r.pass).length / graded.length) : null,
      ...(rs.some((r) => "score_pct_lenient" in r) ? { score_median_lenient: r2(median(rs.map((r) => r.score_pct_lenient ?? null))) } : {}),
      score_median: r2(median(scores)),
      score_mean: r2(mean(scores)),
      score_iqr: si && [r2(si.q1), r2(si.q3)],
      score_min: r2(min(scores)),
      score_max: r2(max(scores)),
      tokens_median: r2(median(tokens)),
      tokens_iqr: ti && [r2(ti.q1), r2(ti.q3)],
      output_tokens_median: r2(median(rs.map((r) => r.tokens?.output_total))),
      wall_median_s: r2(median(rs.map((r) => r.wall_s))),
      t100_median_s: r2(median(rs.map((r) => r.t100_s))),
      reached_100: rs.filter((r) => r.t100_s !== null && r.t100_s !== undefined).length,
      auc_median: r2(median(rs.map((r) => r.auc))),
      false_success: rs.filter((r) => r.false_success).length,
      deadline: rs.filter((r) => r.end_reason === "deadline").length,
      errors: others.filter((r) => r.end_reason === "error").length,
      rate_limited: others.filter((r) => r.end_reason === "rate_limited").length,
    });
  }
  return cells.sort((a, b) => order(a) - order(b));
}

const idx = (list, v) => (list.indexOf(v) < 0 ? list.length : list.indexOf(v));
const order = (c) => idx(TASKS, c.task) * 1e4 + idx(CELLS, c.cell) * 1e2 + idx(ARMS, c.arm);

// ---------- comparisons ----------

function seedOf(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function compare(runsA, runsB, label, { iterations = BOOT_ITERATIONS } = {}) {
  const byRep = (rs) => new Map(rs.map((r) => [`${r.campaign ?? ""}|${r.rep}`, r]));
  const ma = byRep(runsA);
  const mb = byRep(runsB);
  const common = [...ma.keys()].filter((k) => mb.has(k));
  const paired = common.length >= MIN_N;
  const pick = (f) => {
    if (paired) {
      const pairs = common.map((k) => [f(ma.get(k)), f(mb.get(k))]).filter(([x, y]) => typeof x === "number" && typeof y === "number");
      return [pairs.map((p) => p[0]), pairs.map((p) => p[1])];
    }
    const ok = (x) => typeof x === "number";
    return [runsA.map(f).filter(ok), runsB.map(f).filter(ok)];
  };
  const stat = (name, f, fn) => {
    const [a, b] = pick(f);
    const ci = a.length && b.length ? bootstrapCI(a, b, fn, { paired, iterations, seed: seedOf(`${label}|${name}`) }) : null;
    return { estimate: r2(fn(a, b)), ci: ci ? [r2(ci.lo), r2(ci.hi)] : null, n_a: a.length, n_b: b.length };
  };
  return {
    paired,
    n_a: runsA.length,
    n_b: runsB.length,
    direction_only: Math.min(runsA.length, runsB.length) < DIRECTION_ONLY_N,
    score_diff_pts: stat("score", (r) => r.score_pct, medianDiff),
    tokens_ratio: stat("tokens", (r) => r.tokens?.total, medianRatio),
    wall_diff_s: stat("wall", (r) => r.wall_s, medianDiff),
  };
}

export function buildComparisons(runs, opts) {
  const out = [];
  const pairs = new Set(runs.map((r) => `${r.task}|${r.cell}`));
  for (const tc of pairs) {
    const [task, cell] = tc.split("|");
    const of = (arm) => runs.filter((r) => r.task === task && r.cell === cell && r.arm === arm);
    const arms = ARMS.filter((a) => of(a).length).concat([...new Set(runs.filter((r) => r.task === task && r.cell === cell).map((r) => r.arm))].filter((a) => !ARMS.includes(a)));
    const todo = arms.filter((a) => a !== "P-O").map((a) => [a, "P-O"]);
    if (arms.includes("O-mix")) todo.push(["O-mix", "P-S"]);
    for (const [a, b] of todo) {
      if (!of(a).length || !of(b).length) continue;
      out.push({ task, cell, arm: a, baseline: b, ...compare(of(a), of(b), `${task}|${cell}|${a}|${b}`, opts) });
    }
  }
  return out.sort((x, y) => order(x) - order(y) || idx(["P-O", "P-S"], x.baseline) - idx(["P-O", "P-S"], y.baseline));
}

// ---------- hypotheses ----------

const INC = "inconclusive";
const verdict = (ok) => (ok ? "supported" : "not supported");

export function evaluateHypotheses(runs) {
  const cells = buildCells(runs);
  const cellOf = (task, arm, cell = "main") => cells.find((c) => c.task === task && c.arm === arm && c.cell === cell) ?? null;
  const enough = (...cs) => cs.every((c) => c && c.n >= MIN_N);
  const out = [];
  const push = (id, statement, v, evidence, note) => out.push({ id, statement, verdict: v, evidence, note });

  // H1
  {
    const task = "k2-stdlib-toolkit-xl";
    const base = cellOf(task, "P-O");
    const xs = ["O-mix", "O-O"].map((a) => cellOf(task, a));
    const ev = { P_O: base && { score_median: base.score_median, wall_median_s: base.wall_median_s, n: base.n } };
    if (!enough(base, ...xs)) {
      for (const [i, a] of ["O-mix", "O-O"].entries()) ev[a.replace("-", "_")] = xs[i] && { score_median: xs[i].score_median, wall_median_s: xs[i].wall_median_s, n: xs[i].n };
      push("H1", "On k2-stdlib-toolkit-xl (main), O-mix and O-O each reach a final score within 5 points of P-O with lower median wall time.", INC, ev, "missing cells or n < 2");
    } else {
      let ok = true;
      for (const [i, a] of ["O-mix", "O-O"].entries()) {
        const c = xs[i];
        const within = c.score_median >= base.score_median - 5;
        const faster = c.wall_median_s < base.wall_median_s;
        ok &&= within && faster;
        ev[a.replace("-", "_")] = { score_median: c.score_median, score_diff_pts: r2(c.score_median - base.score_median), wall_median_s: c.wall_median_s, within_5: within, faster, n: c.n };
      }
      push("H1", "On k2-stdlib-toolkit-xl (main), O-mix and O-O each reach a final score within 5 points of P-O with lower median wall time.", verdict(ok), ev);
    }
  }

  // H2
  {
    const ev = {};
    let missing = false;
    let ok = true;
    for (const task of ["t1-parallel", "t2-single"]) {
      for (const [a, b] of [["O-mix", "P-S"], ["O-O", "P-O"]]) {
        const ca = cellOf(task, a);
        const cb = cellOf(task, b);
        const k = `${task} ${a}/${b}`;
        if (!enough(ca, cb)) {
          missing = true;
          ev[k] = { n_a: ca?.n ?? 0, n_b: cb?.n ?? 0 };
          continue;
        }
        const ratio = cb.tokens_median ? ca.tokens_median / cb.tokens_median : null;
        const noGain = ca.pass_rate <= cb.pass_rate;
        ok &&= ratio !== null && ratio >= 1.5 && noGain;
        ev[k] = { tokens_ratio: r2(ratio), pass_rate: ca.pass_rate, baseline_pass_rate: cb.pass_rate, n_a: ca.n, n_b: cb.n };
      }
    }
    push("H2", "On small tasks (t1, t2), O-mix uses at least 1.5x the median tokens of P-S and O-O at least 1.5x P-O, with no pass-rate gain.", missing ? INC : verdict(ok), ev, missing ? "missing cells or n < 2" : undefined);
  }

  // H4
  {
    const main = runs.filter((r) => r.cell === "main" && r.pass !== null && r.pass !== undefined);
    const grp = (arms) => main.filter((r) => arms.includes(r.arm));
    const o = grp(["O-mix", "O-O"]);
    const p = grp(["P-S", "P-O"]);
    const rate = (rs) => (rs.length ? rs.filter((r) => r.false_success).length / rs.length : null);
    const ev = {
      orchestrated: { false_success: o.filter((r) => r.false_success).length, n: o.length, rate: r2(rate(o)) },
      plain: { false_success: p.filter((r) => r.false_success).length, n: p.length, rate: r2(rate(p)) },
    };
    const inc = o.length < MIN_N || p.length < MIN_N;
    push("H4", "Pooled over main-cell runs, the false-success rate of O-mix+O-O is lower than that of P-S+P-O.", inc ? INC : verdict(rate(o) < rate(p)), ev, inc ? "n < 2 in a group" : undefined);
  }

  // H5
  {
    const ev = {};
    let okCount = 0;
    let evaluable = 0;
    for (const task of TASKS) {
      const effs = {};
      for (const arm of ARMS) {
        const c = cellOf(task, arm);
        if (c && c.n >= MIN_N && c.score_mean !== null && c.tokens_median > 0) effs[arm] = c.score_mean / (c.tokens_median / 1e6);
      }
      const others = Object.keys(effs).filter((a) => a !== "AUTO");
      if (effs.AUTO === undefined || !others.length) {
        ev[task] = { evaluable: false };
        continue;
      }
      evaluable++;
      const [bestArm, best] = Object.entries(effs).sort((a, b) => b[1] - a[1])[0];
      const within = effs.AUTO >= 0.9 * best;
      if (within) okCount++;
      ev[task] = { auto_efficiency: r2(effs.AUTO), best_arm: bestArm, best_efficiency: r2(best), within_10pct: within };
    }
    ev.tasks_within = okCount;
    ev.tasks_evaluable = evaluable;
    const needed = Math.ceil((2 / 3) * evaluable);
    ev.tasks_needed = needed;
    const v = evaluable === 0 ? INC : okCount >= needed ? "supported" : "not supported";
    push("H5", "Efficiency (mean score pct per million median tokens): AUTO is within 10% of the best arm on at least two-thirds of the tasks with data.", v, ev, v === INC ? "no task with AUTO and another arm at n >= 2" : undefined);
  }

  // H6
  {
    const isLarge = (task) => (runs.find((r) => r.task === task && r.tier)?.tier ?? TASK_META[task]?.tier) === "large";
    const ev = {};
    let lowerOnLarge = false;
    let allLarge = true;
    for (const task of TASKS) {
      const a = cellOf(task, "O-O");
      const b = cellOf(task, "P-O");
      const large = isLarge(task);
      if (!enough(a, b)) {
        ev[task] = { n_oo: a?.n ?? 0, n_po: b?.n ?? 0 };
        if (large) allLarge = false;
        continue;
      }
      const diff = a.score_median - b.score_median;
      ev[task] = { score_diff_pts: r2(diff), tokens_ratio: b.tokens_median ? r2(a.tokens_median / b.tokens_median) : null, n_oo: a.n, n_po: b.n };
      if (large && diff < 0) lowerOnLarge = true;
    }
    const v = lowerOnLarge ? "not supported" : allLarge ? "supported" : INC;
    push("H6", "O-O vs P-O (orchestration alone): O-O scores at least as high as P-O on every large task.", v, ev, v === INC ? "a large task lacks O-O or P-O at n >= 2" : undefined);
  }

  // H7
  {
    const ev = {};
    let missing = false;
    let ok = true;
    for (const task of ["k2-stdlib-toolkit-xl"]) {
      const d = {};
      for (const cell of ["cap10", "main", "cap60"]) {
        const a = cellOf(task, "O-mix", cell);
        const b = cellOf(task, "P-O", cell);
        if (!enough(a, b)) missing = true;
        else d[cell] = r2(a.score_median - b.score_median);
      }
      const grows = d.cap10 !== undefined && d.main !== undefined && d.cap60 !== undefined && d.cap10 < d.main && d.main < d.cap60;
      const budgets = {};
      const budgetCells = [...new Set(cells.filter((c) => c.task === task && c.cell.startsWith("budget")).map((c) => c.cell))].sort();
      for (const cell of budgetCells) {
        const a = cellOf(task, "O-mix", cell);
        const b = cellOf(task, "P-O", cell);
        if (!enough(a, b)) missing = true;
        else budgets[cell] = { p_o: b.score_median, o_mix: a.score_median, p_o_at_least: b.score_median >= a.score_median };
      }
      if (budgetCells.length < 2) missing = true;
      ok &&= grows && Object.keys(budgets).length >= 2 && Object.values(budgets).every((x) => x.p_o_at_least);
      ev[task] = { o_mix_minus_p_o: d, grows, budgets };
    }
    push("H7", "On k2-stdlib-toolkit-xl, the O-mix minus P-O score difference grows from cap10 to main to cap60; at the two budget cells P-O scores at least as high as O-mix.", missing ? INC : verdict(ok), ev, missing ? "missing sweep cells or n < 2" : undefined);
  }
  return out;
}

// ---------- top level ----------

// Keeps the LAST row per run_id of one campaign's runs.jsonl (file order); earlier rows are returned as superseded.
export function latestRows(rows) {
  const last = new Map();
  rows.forEach((r, i) => last.set(r.run_id, i));
  return { latest: rows.filter((r, i) => last.get(r.run_id) === i), superseded: rows.filter((r, i) => last.get(r.run_id) !== i) };
}

export function analyze(dirs, opts = {}) {
  const campaigns = dirs.map(loadCampaign);
  // Runs are keyed by (campaign, run_id): latestRows runs once per campaign.
  const latest = [];
  const superseded = [];
  for (const c of campaigns) {
    const d = latestRows(c.runs);
    latest.push(...d.latest.map((row) => [row, c]));
    superseded.push(...d.superseded.map((row) => [row, c]));
  }
  const all = latest.map(([row, c]) => analyzeRun(row, c.grades, c));
  // A requeued run (after a rate limit) appends a new row under the same run_id: every superseded row is a retry.
  // A rate-limited row that was never superseded stays the run's row and counts as excluded rate_limited.
  const retries = superseded.map(([row, c]) => ({
    run_id: row.run_id,
    campaign: c.manifest.campaign ?? c.dir,
    task: row.task,
    arm: row.arm,
    cell: row.cell ?? "main",
    rep: row.rep,
    end_reason: row.end_reason ?? null,
    started_at: row.started_at ?? null,
    error: row.error ?? null,
  }));
  const retriesByReason = {};
  for (const r of retries) retriesByReason[r.end_reason ?? "unknown"] = (retriesByReason[r.end_reason ?? "unknown"] ?? 0) + 1;
  const included = all.filter((r) => !r.excluded);
  const excluded = all.filter((r) => r.excluded).map(({ run_id, task, arm, cell, rep, end_reason, error, campaign }) => ({ run_id, campaign, task, arm, cell, rep, end_reason, error }));
  const cells = buildCells(included, all);
  for (const cell of cells) cell.retries = retries.filter((r) => r.task === cell.task && r.arm === cell.arm && r.cell === cell.cell).length;
  return {
    generated_at: opts.now ?? new Date().toISOString(),
    campaigns: campaigns.map((c) => ({ dir: c.dir, manifest: c.manifest, rows: c.runs.length, runs: c.runs.length - superseded.filter(([, x]) => x === c).length, grades: c.grades.length })),
    counts: {
      runs: all.length,
      included: included.length,
      excluded: excluded.length,
      rate_limited: excluded.filter((e) => e.end_reason === "rate_limited").length,
      error: excluded.filter((e) => e.end_reason === "error").length,
      retries: retries.length,
      retries_by_reason: retriesByReason,
    },
    retries,
    runs: all,
    excluded,
    cells,
    comparisons: buildComparisons(included, opts),
    hypotheses: evaluateHypotheses(included),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  const dirs = [];
  let out = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out") out = args[++i];
    else dirs.push(args[i]);
  }
  if (!dirs.length) {
    console.error("usage: node bench/analyze.mjs <campaign dir> [<campaign dir> ...] [--out <summary.json>]");
    process.exit(1);
  }
  for (const d of dirs) {
    if (!existsSync(join(d, "runs.jsonl"))) {
      console.error(`no runs.jsonl in ${d}`);
      process.exit(1);
    }
  }
  const summary = analyze(dirs);
  const file = resolve(out ?? join(dirs[0], "summary.json"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  const { runs, included, excluded } = summary.counts;
  console.log(`${file}: ${runs} runs (${included} analysed, ${excluded} excluded), ${summary.cells.length} cells`);
  for (const h of summary.hypotheses) console.log(`${h.id}: ${h.verdict}`);
}
