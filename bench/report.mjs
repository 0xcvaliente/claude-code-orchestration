#!/usr/bin/env node
// Renders bench/analyze.mjs's summary.json as a self-contained HTML report (inline CSS and SVG, light and dark) and
// as Markdown for docs/benchmarks.md (the same tables, no charts). Cost is reported in tokens only.
// Usage: node bench/report.mjs <summary.json> [--html <file>] [--md <file>]
//        (defaults: report.html and benchmarks.md beside summary.json)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { formatTokens } from "../scripts/tokens.mjs";
import { median } from "./lib/stats.mjs";

const ARMS = ["P-S", "P-O", "O-mix", "O-O", "AUTO"];
const TASKS = ["t1-parallel", "t2-single", "h1-query-engine", "h2-scheduler", "k1-stdlib-toolkit", "h3-sql-engine"];
const CELLS = ["main", "cap10", "cap60", "budget1M", "budget3M"];
const SETUPS = {
  "P-S": "Plain Sonnet session",
  "P-O": "Plain Opus session",
  "O-mix": "Orchestrator as shipped: Opus orchestrator, Sonnet implementers and reviewers, Haiku researchers",
  "O-O": "Orchestrator with every agent on Opus",
  AUTO: "scripts/auto.sh: a Sonnet triage call picks plain, reviewed or the orchestrator",
};
const CELL_TEXT = {
  main: "the task's own time limit (10 min small, 30 min otherwise)",
  cap10: "10 min time limit",
  cap60: "60 min time limit",
  budget1M: "1M token cap, 30 min",
  budget3M: "3M token cap, 30 min",
};

// ---------- formatting ----------

const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const tok = (x) => (typeof x === "number" ? formatTokens(x) : "n/a");
const pct = (x) => (typeof x === "number" ? `${Math.round(x * 10) / 10}%` : "n/a");
const pts = (x) => (typeof x === "number" ? `${x > 0 ? "+" : ""}${Math.round(x * 10) / 10}` : "n/a");
const secs = (s) => (typeof s !== "number" ? "n/a" : s < 120 ? `${Math.round(s)}s` : `${(s / 60).toFixed(1)} min`);
const sdiff = (s) => (typeof s !== "number" ? "n/a" : `${s > 0 ? "+" : s < 0 ? "-" : ""}${secs(Math.abs(s))}`);
const ratio = (x) => (typeof x === "number" ? `${x.toFixed(2)}x` : "n/a");
const rate = (x) => (typeof x === "number" ? `${Math.round(x * 100)}%` : "n/a");
const idx = (list, v) => (list.indexOf(v) < 0 ? list.length : list.indexOf(v));
const armsIn = (xs) => [...new Set(xs.map((x) => x.arm))].sort((a, b) => idx(ARMS, a) - idx(ARMS, b) || a.localeCompare(b));
const tasksIn = (xs) => [...new Set(xs.map((x) => x.task))].sort((a, b) => idx(TASKS, a) - idx(TASKS, b) || a.localeCompare(b));
const cellsIn = (xs) => [...new Set(xs.map((x) => x.cell))].sort((a, b) => idx(CELLS, a) - idx(CELLS, b) || a.localeCompare(b));
const armClass = (a) => `arm-${String(a).replace(/[^A-Za-z0-9]/g, "")}`;
const modelClass = (m) => (/opus/.test(m) ? "m-opus" : /sonnet/.test(m) ? "m-sonnet" : /haiku/.test(m) ? "m-haiku" : m === "triage" ? "m-triage" : "m-other");
const countStr = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(", ") || "none";

// ---------- tables (shared by HTML and Markdown) ----------

function resultsRows(s, task, cell) {
  return s.cells
    .filter((c) => c.task === task && c.cell === cell)
    .map((c) => [
      c.arm,
      `${c.n}${c.direction_only ? " (direction only)" : ""}`,
      c.pass_rate === null ? "n/a" : `${rate(c.pass_rate)} (${Math.round(c.pass_rate * c.graded)}/${c.graded})`,
      c.score_iqr ? `${pct(c.score_median)} (IQR ${pct(c.score_iqr[0])} to ${pct(c.score_iqr[1])})` : pct(c.score_median),
      tok(c.tokens_median),
      tok(c.output_tokens_median),
      secs(c.wall_median_s),
      c.reached_100 ? `${secs(c.t100_median_s)} (${c.reached_100}/${c.n})` : "never",
      String(c.false_success),
      String(c.retries ?? 0),
    ]);
}
const RESULT_HEADS = ["Setup", "n", "Pass rate", "Median score", "Median tokens", "Median output tokens", "Median wall time", "t100", "False successes", "Retries"];

const ci = (st, f) => (st?.ci ? `${f(st.estimate)} [${f(st.ci[0])}, ${f(st.ci[1])}]` : f(st?.estimate));
function comparisonRows(s) {
  return s.comparisons.map((c) => [
    c.task,
    c.cell,
    `${c.arm} vs ${c.baseline}`,
    `${c.n_a} / ${c.n_b}${c.paired ? " paired" : " unpaired"}`,
    ci(c.score_diff_pts, pts),
    ci(c.tokens_ratio, ratio),
    ci(c.wall_diff_s, sdiff),
    c.direction_only ? "direction only" : "",
  ]);
}
const COMPARISON_HEADS = ["Task", "Cell", "Comparison", "n", "Score diff, points [95% CI]", "Token ratio [95% CI]", "Wall diff [95% CI]", "Note"];

function processRows(s) {
  const rows = [];
  const inc = s.runs.filter((r) => !r.excluded);
  for (const task of tasksIn(inc)) {
    for (const cell of cellsIn(inc.filter((r) => r.task === task))) {
      for (const arm of armsIn(inc.filter((r) => r.task === task && r.cell === cell))) {
        const rs = inc.filter((r) => r.task === task && r.cell === cell && r.arm === arm);
        const types = {};
        const gates = {};
        const routes = {};
        for (const r of rs) {
          for (const [k, v] of Object.entries(r.subagents ?? {})) types[k] = (types[k] ?? 0) + v;
          for (const [k, v] of Object.entries(r.gates ?? {})) gates[k] = (gates[k] ?? 0) + v;
          for (const m of r.routes ?? []) routes[m] = (routes[m] ?? 0) + 1;
        }
        rows.push([
          task,
          cell,
          arm,
          String(median(rs.map((r) => r.subagent_count)) ?? 0),
          countStr(types),
          String(Math.max(0, ...rs.map((r) => r.max_concurrent_subagents ?? 0))),
          String(median(rs.map((r) => r.worktrees)) ?? 0),
          String(median(rs.map((r) => r.reviewer_rounds)) ?? 0),
          countStr(gates),
          Object.keys(routes).length ? countStr(routes) : "",
          String(rs.reduce((a, r) => a + (r.permission_denials ?? 0), 0)),
        ]);
      }
    }
  }
  return rows;
}
const PROCESS_HEADS = ["Task", "Cell", "Setup", "Median subagents", "Subagents by type (all runs)", "Max concurrency", "Median worktrees", "Median reviewer rounds", "Gate decisions (all runs)", "AUTO routes", "Permission denials"];

function honestyRows(s) {
  const inc = s.runs.filter((r) => !r.excluded);
  return armsIn(inc).map((arm) => {
    const rs = inc.filter((r) => r.arm === arm);
    const by = (claim) => {
      const xs = rs.filter((r) => r.claim === claim);
      return xs.length ? `${xs.length} (${xs.filter((r) => r.pass).length} passed)` : "0";
    };
    const outside = rs.filter((r) => Array.isArray(r.outside_graded) && r.outside_graded.length).length;
    return [arm, String(rs.length), by("success"), by("partial"), by("failure"), by("unclear"), by("none"), String(rs.filter((r) => r.false_success).length), String(outside)];
  });
}
const HONESTY_HEADS = ["Setup", "Runs", "Claimed success", "Claimed partial", "Claimed failure", "Unclear claim", "No result text", "False successes", "Runs touching files outside graded paths"];

function failureRows(s) {
  return s.runs
    .filter((r) => r.excluded || r.end_reason === "deadline" || r.pass === false)
    .map((r) => [r.run_id, r.end_reason, r.excluded ? "excluded" : r.pass === false ? `failed (${pct(r.score_pct)})` : "passed", r.claim, r.error ?? ""]);
}
const FAILURE_HEADS = ["Run", "End", "Result", "Claim", "Error"];

// Attempts superseded by a later row with the same run_id (a requeued retry); only the last row per run is analysed.
const retryRows = (s) => (s.retries ?? []).map((r) => [r.run_id, `${r.task} / ${r.arm} / ${r.cell}`, r.end_reason ?? "unknown", r.started_at ?? "n/a", r.error ?? ""]);
const RETRY_HEADS = ["Run", "Cell", "Superseded attempt ended", "Attempt started", "Error"];
const retryNote = (s) => {
  const by = Object.entries(s.counts?.retries_by_reason ?? {}).map(([k, v]) => `${v} ${k}`).join(", ");
  return `${s.counts?.retries ?? 0} superseded attempt(s) (retries)${by ? `: ${by}` : ""}. Only the last row per run is analysed; a rate-limited run that was never retried is listed above as excluded.`;
};

function methodRows(s) {
  return s.campaigns.map(({ manifest: m, runs, dir }) => [
    m.campaign ?? dir,
    m.matrix ?? "n/a",
    m.git_sha ?? m.sha ?? "n/a",
    m.claude_version ?? "n/a",
    m.plugin_version ?? "n/a",
    [m.node_version && `node ${m.node_version}`, m.python_version && `python ${m.python_version}`, m.sqlite_version && `sqlite ${m.sqlite_version}`].filter(Boolean).join(", ") || "n/a",
    m.started_at ?? "n/a",
    String(runs),
  ]);
}
const METHOD_HEADS = ["Campaign", "Matrix", "Git SHA", "Claude Code", "Plugin", "Runtimes", "Started", "Runs"];

function capRows(s) {
  const out = [];
  const inc = s.runs;
  for (const task of tasksIn(inc)) {
    for (const cell of cellsIn(inc.filter((r) => r.task === task))) {
      const rs = inc.filter((r) => r.task === task && r.cell === cell);
      const caps = [...new Set(rs.map((r) => r.cap_min).filter((x) => x !== null && x !== undefined))];
      const budgets = [...new Set(rs.map((r) => r.budget_tokens).filter((x) => typeof x === "number"))];
      const reps = Math.max(...armsIn(rs).map((a) => rs.filter((r) => r.arm === a).length));
      out.push([task, cell, caps.map((c) => `${c} min`).join(", ") || "n/a", budgets.map(tok).join(", ") || "none", armsIn(rs).join(", "), String(reps)]);
    }
  }
  return out;
}
const CAP_HEADS = ["Task", "Cell", "Time limit", "Token cap", "Setups", "Max runs per setup"];

// ---------- headline sentences ----------

function headline(h) {
  const e = h.evidence ?? {};
  const v = h.verdict;
  const tail = h.note ? ` (${h.note})` : "";
  switch (h.id) {
    case "H1": {
      const part = (k, label) => (e[k]?.score_diff_pts !== undefined ? `${label} ${pts(e[k].score_diff_pts)} points, ${secs(e[k].wall_median_s)} vs ${secs(e.P_O?.wall_median_s)}` : null);
      const p = [part("O_mix", "O-mix"), part("O_O", "O-O")].filter(Boolean).join("; ");
      return `k1 at the shipped limit: orchestrators close to a plain Opus session and faster: ${v}${p ? `. ${p}` : ""}${tail}.`;
    }
    case "H2": {
      const p = Object.entries(e)
        .filter(([, x]) => x.tokens_ratio !== undefined)
        .map(([k, x]) => `${k} ${ratio(x.tokens_ratio)} tokens, pass ${rate(x.pass_rate)} vs ${rate(x.baseline_pass_rate)}`)
        .join("; ");
      return `Small tasks: orchestration uses 1.5x or more tokens for no pass-rate gain: ${v}${p ? `. ${p}` : ""}${tail}.`;
    }
    case "H4":
      return `False successes, orchestrated vs plain (main cells): ${v}. ${e.orchestrated?.false_success ?? 0}/${e.orchestrated?.n ?? 0} vs ${e.plain?.false_success ?? 0}/${e.plain?.n ?? 0}${tail}.`;
    case "H5":
      return `AUTO within 10% of the best setup's score per million tokens on 4 of 6 tasks: ${v}. Within on ${e.tasks_within ?? 0} of ${e.tasks_evaluable ?? 0} tasks with data${tail}.`;
    case "H6": {
      const p = Object.entries(e)
        .filter(([, x]) => x.score_diff_pts !== undefined)
        .map(([k, x]) => `${k} ${pts(x.score_diff_pts)} points, ${ratio(x.tokens_ratio)} tokens`)
        .join("; ");
      return `Orchestration alone (O-O vs P-O) holds its score on large tasks: ${v}${p ? `. ${p}` : ""}${tail}.`;
    }
    case "H7": {
      const p = Object.entries(e)
        .map(([k, x]) => {
          const d = x.o_mix_minus_p_o ?? {};
          const ds = ["cap10", "main", "cap60"].filter((c) => d[c] !== undefined).map((c) => `${c} ${pts(d[c])}`);
          return ds.length ? `${k}: ${ds.join(", ")}` : null;
        })
        .filter(Boolean)
        .join("; ");
      return `The orchestrator's lead grows with time, and P-O wins under token caps: ${v}${p ? `. ${p}` : ""}${tail}.`;
    }
    default:
      return `${h.statement}: ${v}${tail}.`;
  }
}

// ---------- SVG charts ----------

const W = 340;
const H = 230;
const M = { l: 44, r: 12, t: 12, b: 36 };
const X0 = M.l;
const X1 = W - M.r;
const Y0 = H - M.b;
const Y1 = M.t;
const sy = (p) => Y0 - ((Y0 - Y1) * Math.max(0, Math.min(100, p))) / 100;
const svgOpen = (label) => `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`;
function yAxis(label = "score %") {
  let g = "";
  for (const p of [0, 25, 50, 75, 100]) g += `<line class="grid" x1="${X0}" x2="${X1}" y1="${sy(p)}" y2="${sy(p)}"/><text class="tick" x="${X0 - 4}" y="${sy(p) + 3}" text-anchor="end">${p}</text>`;
  return `${g}<text class="tick" x="10" y="${(Y0 + Y1) / 2}" transform="rotate(-90 10 ${(Y0 + Y1) / 2})" text-anchor="middle">${label}</text>`;
}
const fig = (title, svg) => `<figure><figcaption>${esc(title)}</figcaption>${svg}</figure>`;

function scatterChart(s, task) {
  const cs = s.cells.filter((c) => c.task === task && c.cell === "main" && typeof c.tokens_median === "number" && typeof c.score_median === "number");
  if (!cs.length) return "";
  const xmax = Math.max(...cs.map((c) => c.tokens_median)) * 1.15 || 1;
  const sx = (t) => X0 + ((X1 - X0) * t) / xmax;
  let g = yAxis();
  for (const f of [0, 0.25, 0.5, 0.75, 1]) g += `<text class="tick" x="${sx(xmax * f)}" y="${Y0 + 14}" text-anchor="middle">${tok(xmax * f)}</text>`;
  g += `<text class="tick" x="${(X0 + X1) / 2}" y="${H - 4}" text-anchor="middle">median tokens</text>`;
  for (const c of cs) {
    const x = sx(c.tokens_median);
    const y = sy(c.score_median);
    g += `<circle class="${armClass(c.arm)}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="5"><title>${esc(`${c.arm}: ${pct(c.score_median)}, ${tok(c.tokens_median)}`)}</title></circle>`;
    g += `<text class="lbl" x="${(x + 7).toFixed(1)}" y="${(y - 6).toFixed(1)}">${esc(c.arm)}</text>`;
  }
  return fig(`${task}: median score vs median tokens`, `${svgOpen(`${task} score vs tokens`)}${g}</svg>`);
}

// Median score over time per setup: each run's timeline read as a step function, the median taken at every snapshot time.
function curveChart(s, task) {
  const rs = s.runs.filter((r) => !r.excluded && r.task === task && r.cell === "main" && r.timeline?.length);
  if (!rs.length) return "";
  const cap = Math.max(...rs.map((r) => (r.cap_min ?? 0) * 60), ...rs.flatMap((r) => r.timeline.map((p) => p[0])));
  const sx = (t) => X0 + ((X1 - X0) * t) / cap;
  const at = (r, t) => {
    let v = 0;
    for (const [ts, p] of r.timeline) if (ts <= t) v = p;
    return v;
  };
  let g = yAxis();
  for (const f of [0, 0.25, 0.5, 0.75, 1]) g += `<text class="tick" x="${sx(cap * f)}" y="${Y0 + 14}" text-anchor="middle">${Math.round((cap * f) / 60)}</text>`;
  g += `<text class="tick" x="${(X0 + X1) / 2}" y="${H - 4}" text-anchor="middle">minutes</text>`;
  for (const arm of armsIn(rs)) {
    const ars = rs.filter((r) => r.arm === arm);
    const times = [...new Set([0, ...ars.flatMap((r) => r.timeline.map((p) => p[0])), cap])].filter((t) => t <= cap).sort((a, b) => a - b);
    let d = "";
    let prev = null;
    for (const t of times) {
      const v = median(ars.map((r) => at(r, t)));
      d += prev === null ? `M${sx(t).toFixed(1)},${sy(v).toFixed(1)}` : `H${sx(t).toFixed(1)}V${sy(v).toFixed(1)}`;
      prev = v;
    }
    g += `<path class="line ${armClass(arm)}" d="${d}"><title>${esc(arm)}</title></path>`;
  }
  return fig(`${task}: median score over time (main cell)`, `${svgOpen(`${task} time to quality`)}${g}</svg>`);
}

// Mean tokens per run by model, one bar per setup, main cell.
function stackChart(s, task) {
  const rs = s.runs.filter((r) => !r.excluded && r.task === task && r.cell === "main");
  if (!rs.length) return "";
  const arms = armsIn(rs);
  const rows = arms.map((arm) => {
    const ars = rs.filter((r) => r.arm === arm);
    const by = {};
    for (const r of ars) for (const [m, u] of Object.entries(r.tokens?.by_model ?? {})) by[m] = (by[m] ?? 0) + u.total / ars.length;
    return [arm, by];
  });
  const xmax = Math.max(...rows.map(([, by]) => Object.values(by).reduce((a, b) => a + b, 0))) * 1.1 || 1;
  const bh = 18;
  const h = M.t + arms.length * (bh + 10) + 30;
  const left = 50;
  const sx = (t) => ((X1 - left) * t) / xmax;
  let g = "";
  rows.forEach(([arm, by], i) => {
    const y = M.t + i * (bh + 10);
    g += `<text class="tick" x="${left - 4}" y="${y + bh / 2 + 4}" text-anchor="end">${esc(arm)}</text>`;
    let x = left;
    for (const [m, v] of Object.entries(by).sort()) {
      const w = sx(v);
      g += `<rect class="${modelClass(m)}" x="${x.toFixed(1)}" y="${y}" width="${Math.max(0, w).toFixed(1)}" height="${bh}"><title>${esc(`${arm} ${m}: ${tok(v)}`)}</title></rect>`;
      x += w;
    }
    g += `<text class="lbl" x="${(x + 4).toFixed(1)}" y="${y + bh / 2 + 4}">${tok(x === left ? 0 : Object.values(by).reduce((a, b) => a + b, 0))}</text>`;
  });
  return fig(`${task}: mean tokens per run by model (main cell)`, `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="${esc(task)} tokens by model">${g}</svg>`);
}

function sweepChart(s, task) {
  const cats = ["cap10", "main", "cap60"];
  const cs = s.cells.filter((c) => c.task === task && cats.includes(c.cell) && ["P-O", "O-mix"].includes(c.arm) && typeof c.score_median === "number");
  if (!cs.some((c) => c.cell !== "main")) return "";
  const sx = (i) => X0 + ((X1 - X0) * (i + 0.5)) / cats.length;
  let g = yAxis();
  cats.forEach((c, i) => (g += `<text class="tick" x="${sx(i)}" y="${Y0 + 14}" text-anchor="middle">${c}</text>`));
  for (const arm of armsIn(cs)) {
    const p = cats.map((c, i) => [i, cs.find((x) => x.arm === arm && x.cell === c)]).filter(([, c]) => c);
    g += `<path class="line ${armClass(arm)}" d="${p.map(([i, c], j) => `${j ? "L" : "M"}${sx(i).toFixed(1)},${sy(c.score_median).toFixed(1)}`).join("")}"/>`;
    for (const [i, c] of p) g += `<circle class="${armClass(arm)}" cx="${sx(i).toFixed(1)}" cy="${sy(c.score_median).toFixed(1)}" r="4"><title>${esc(`${arm} ${c.cell}: ${pct(c.score_median)}`)}</title></circle>`;
  }
  return fig(`${task}: median score by time limit`, `${svgOpen(`${task} time-limit sweep`)}${g}</svg>`);
}

function budgetChart(s, task) {
  const cats = ["budget1M", "budget3M"];
  const cs = s.cells.filter((c) => c.task === task && cats.includes(c.cell) && typeof c.score_median === "number");
  if (!cs.length) return "";
  const arms = armsIn(cs);
  const gw = (X1 - X0) / cats.length;
  const bw = Math.min(40, (gw - 20) / arms.length);
  let g = yAxis();
  cats.forEach((cat, i) => {
    g += `<text class="tick" x="${X0 + gw * (i + 0.5)}" y="${Y0 + 14}" text-anchor="middle">${cat}</text>`;
    arms.forEach((arm, j) => {
      const c = cs.find((x) => x.cell === cat && x.arm === arm);
      if (!c) return;
      const x = X0 + gw * i + (gw - bw * arms.length) / 2 + j * bw;
      g += `<rect class="${armClass(arm)}" x="${x.toFixed(1)}" y="${sy(c.score_median).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${(Y0 - sy(c.score_median)).toFixed(1)}"><title>${esc(`${arm} ${cat}: ${pct(c.score_median)}`)}</title></rect>`;
    });
  });
  return fig(`${task}: median score under token caps`, `${svgOpen(`${task} token caps`)}${g}</svg>`);
}

// ---------- page ----------

const htmlTable = (heads, rows) =>
  rows.length
    ? `<div class="scroll"><table><thead><tr>${heads.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
    : "<p>No data.</p>";
const mdCell = (c) => String(c ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const mdTable = (heads, rows) => (rows.length ? `| ${heads.map(mdCell).join(" | ")} |\n|${heads.map(() => "---").join("|")}|\n${rows.map((r) => `| ${r.map(mdCell).join(" | ")} |`).join("\n")}\n` : "No data.\n");

function caveats(s) {
  const inc = s.runs.filter((r) => !r.excluded);
  const ns = s.cells.map((c) => c.n);
  const dir = s.cells.filter((c) => c.direction_only).length;
  return [
    `Runs per cell range from ${ns.length ? Math.min(...ns) : 0} to ${ns.length ? Math.max(...ns) : 0}; ${dir} of ${s.cells.length} cells have fewer than 3 runs and show direction only.`,
    "Confidence intervals are 95% percentile bootstrap intervals (10,000 seeded resamples), paired by rep when both setups share at least two reps. With a handful of runs they are wide and only roughly calibrated.",
    `Hypotheses are evaluated mechanically on medians; a verdict needs at least 2 runs in every cell it reads, otherwise it is inconclusive.`,
    `${s.counts.excluded} run(s) were excluded (${s.counts.rate_limited} rate limited, ${s.counts.error} harness errors); ${inc.length} were analysed; ${s.counts.retries ?? 0} earlier attempt(s) were superseded by a retry.`,
    "Everything ran on a single machine against a subscription account, so rate limits and machine load can shift wall times between runs.",
    "Token counts are input, output, cache-read and cache-write tokens summed over every model; they do not weigh models, and an Opus token is worth more than a Sonnet token.",
  ];
}

function method(s) {
  return [
    "Each setup works on the task text alone; hidden tests the agent never sees grade a snapshot during the run and the final tree. Score is passed / total hidden tests; a run passes when every hidden test passes.",
    "t90 and t100 are the first graded snapshot at 90% and 100%. AUC is the time-weighted mean score over the time limit, the timeline read as a step function from 0.",
    "A false success is a run whose final message claims success (bench/lib/claims.mjs) while the hidden grade fails.",
  ];
}

export function renderHtml(s, { title = "Orchestration benchmark", mdPath } = {}) {
  const tasks = tasksIn(s.cells);
  const arms = armsIn(s.cells);
  const legend = `<p class="legend">${arms.map((a) => `<span><i class="sw ${armClass(a)}"></i>${esc(a)}</span>`).join("")}</p>`;
  const models = [...new Set(s.runs.flatMap((r) => Object.keys(r.tokens?.by_model ?? {})))].sort();
  const mlegend = `<p class="legend">${models.map((m) => `<span><i class="sw ${modelClass(m)}"></i>${esc(m)}</span>`).join("")}</p>`;
  const perTask = tasks
    .map((t) => `<h3>${esc(t)}</h3>${cellsIn(s.cells.filter((c) => c.task === t)).map((cell) => `<h4>${esc(cell)}: ${esc(CELL_TEXT[cell] ?? cell)}</h4>${htmlTable(RESULT_HEADS, resultsRows(s, t, cell))}`).join("")}`)
    .join("");
  const charts = (fn, ts) => ts.map((t) => fn(s, t)).filter(Boolean).join("") || "<p>No data.</p>";
  const big = ["k1-stdlib-toolkit", "h3-sql-engine"];
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Benchmark report</title>
<style>
:root{--bg:#fbfbfa;--fg:#1d1d1f;--muted:#6b6b70;--line:#d9d9de;--panel:#f1f1f3;--ok:#1f7a3a;--bad:#b42318;--mid:#8a6100;
--PS:#0f8b8d;--PO:#d1495b;--Omix:#2f6fde;--OO:#8e44ad;--AUTO:#b7791f;--opus:#8e44ad;--sonnet:#2f6fde;--haiku:#0f8b8d;--triage:#b7791f;--other:#8a8a90}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#151517;--fg:#ececef;--muted:#a0a0a8;--line:#3a3a40;--panel:#202024;--ok:#5ac77a;--bad:#ff7b6e;--mid:#e0b04a;
--PS:#3cc4c6;--PO:#ff7a8a;--Omix:#6d9cff;--OO:#c08ae0;--AUTO:#e6a94a;--opus:#c08ae0;--sonnet:#6d9cff;--haiku:#3cc4c6;--triage:#e6a94a;--other:#9a9aa2}}
:root[data-theme="dark"]{--bg:#151517;--fg:#ececef;--muted:#a0a0a8;--line:#3a3a40;--panel:#202024;--ok:#5ac77a;--bad:#ff7b6e;--mid:#e0b04a;
--PS:#3cc4c6;--PO:#ff7a8a;--Omix:#6d9cff;--OO:#c08ae0;--AUTO:#e6a94a;--opus:#c08ae0;--sonnet:#6d9cff;--haiku:#3cc4c6;--triage:#e6a94a;--other:#9a9aa2}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1000px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:1.6rem;margin:0 0 .25rem}h2{font-size:1.25rem;margin:2.2rem 0 .6rem;border-bottom:1px solid var(--line);padding-bottom:.3rem}h3{font-size:1.05rem;margin:1.4rem 0 .4rem}h4{font-size:.92rem;margin:1rem 0 .3rem;color:var(--muted);font-weight:600}
p,li{max-width:72ch}.muted{color:var(--muted)}code{font-size:.9em;overflow-wrap:anywhere}
.scroll{overflow-x:auto;max-width:100%;-webkit-overflow-scrolling:touch}
table{border-collapse:collapse;width:100%;margin:.3rem 0 1rem;font-size:13px;font-variant-numeric:tabular-nums}
th,td{border-bottom:1px solid var(--line);padding:.35rem .5rem;text-align:left;vertical-align:top}th{font-weight:600;background:var(--panel)}
.verdicts{list-style:none;padding:0}.verdicts li{margin:.5rem 0;padding:.6rem .8rem;background:var(--panel);border-radius:8px;border-left:4px solid var(--muted)}
.v-supported{border-left-color:var(--ok)!important}.v-not{border-left-color:var(--bad)!important}.v-inconclusive{border-left-color:var(--mid)!important}
.charts{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,300px),1fr));gap:16px}
figure{margin:0;background:var(--panel);border-radius:8px;padding:8px}figcaption{font-size:13px;font-weight:600;margin:0 0 4px}
svg{display:block;width:100%;height:auto;max-width:100%}
svg .grid{stroke:var(--line);stroke-width:1}svg .tick,svg .lbl{fill:var(--muted);font-size:10px}svg .lbl{fill:var(--fg)}
svg .line{fill:none;stroke-width:2}
${ARMS.map((a) => `.${armClass(a)}{fill:var(--${a.replace(/[^A-Za-z0-9]/g, "")});stroke:var(--${a.replace(/[^A-Za-z0-9]/g, "")})}path.${armClass(a)}{fill:none}`).join("")}
${["opus", "sonnet", "haiku", "triage", "other"].map((m) => `.m-${m}{fill:var(--${m})}`).join("")}
.legend{display:flex;flex-wrap:wrap;gap:.4rem 1rem;font-size:13px}.legend span{display:inline-flex;align-items:center;gap:.35rem}
.sw{display:inline-block;width:12px;height:12px;border-radius:3px}span>.sw{background:currentColor}
${ARMS.map((a) => `.legend .${armClass(a)}{background:var(--${a.replace(/[^A-Za-z0-9]/g, "")})}`).join("")}
${["opus", "sonnet", "haiku", "triage", "other"].map((m) => `.legend .m-${m}{background:var(--${m})}`).join("")}
</style></head><body><main>
<h1>${esc(title)}</h1>
<p class="muted">Generated by bench/report.mjs from ${esc(s.campaigns.map((c) => c.manifest.campaign ?? c.dir).join(", "))} on ${esc(String(s.generated_at).slice(0, 10))}. Model usage is counted in tokens only.${mdPath ? ` Markdown version: <code>${esc(mdPath)}</code>.` : ""}</p>

<h2>Headline findings</h2>
<ul class="verdicts">${s.hypotheses.map((h) => `<li class="${h.verdict === "supported" ? "v-supported" : h.verdict === "not supported" ? "v-not" : "v-inconclusive"}"><strong>${esc(h.id)}</strong> ${esc(headline(h))}<br><span class="muted">${esc(h.statement)}</span></li>`).join("")}</ul>

<h2>Method</h2>
<ul>${method(s).map((m) => `<li>${esc(m)}</li>`).join("")}</ul>
<h3>Campaigns</h3>${htmlTable(METHOD_HEADS, methodRows(s))}
<h3>Setups</h3>${htmlTable(["Setup", "What runs"], ARMS.filter((a) => arms.includes(a)).map((a) => [a, SETUPS[a]]))}
<h3>Cells, limits and runs</h3>${htmlTable(CAP_HEADS, capRows(s))}

<h2>Results per task</h2>${perTask}
<h3>Comparisons with the baselines</h3>${htmlTable(COMPARISON_HEADS, comparisonRows(s))}

<h2>Charts</h2>${legend}
<h3>Score vs tokens</h3><div class="charts">${charts(scatterChart, tasks)}</div>
<h3>Time to quality</h3><div class="charts">${charts(curveChart, big)}</div>
<h3>Tokens by model</h3>${mlegend}<div class="charts">${charts(stackChart, tasks)}</div>
<h3>Time-limit sweep</h3><div class="charts">${charts(sweepChart, big)}</div>
<h3>Token caps</h3><div class="charts">${charts(budgetChart, big)}</div>

<h2>Process</h2>${htmlTable(PROCESS_HEADS, processRows(s))}
<h2>Claims vs results</h2>${htmlTable(HONESTY_HEADS, honestyRows(s))}
<h2>Failures and exclusions</h2>${htmlTable(FAILURE_HEADS, failureRows(s))}
<h3>Retries</h3><p>${esc(retryNote(s))}</p>${retryRows(s).length ? htmlTable(RETRY_HEADS, retryRows(s)) : ""}
<h2>Caveats</h2><ul>${caveats(s).map((c) => `<li>${esc(c)}</li>`).join("")}</ul>
</main></body></html>
`;
}

export function renderMarkdown(s, { sources, htmlPath } = {}) {
  const tasks = tasksIn(s.cells);
  const arms = armsIn(s.cells);
  const date = String(s.generated_at).slice(0, 10);
  const from = sources ?? s.campaigns.map((c) => c.dir).join(", ");
  let md = `Generated by bench/report.mjs from ${from} on ${date}; do not edit by hand.\n\n# Benchmarks\n\n`;
  md += `Charts and the full report: ${htmlPath ? `\`${htmlPath}\`` : "run `node bench/report.mjs <summary.json> --html <file>`"}. Model usage is counted in tokens only (input, output, cache-read and cache-write over every model).\n\n`;
  md += `## Headline findings\n\n${s.hypotheses.map((h) => `- **${h.id}** ${headline(h)}`).join("\n")}\n\n`;
  md += `## Method\n\n${method(s).map((m) => `- ${m}`).join("\n")}\n\n### Campaigns\n\n${mdTable(METHOD_HEADS, methodRows(s))}\n### Setups\n\n${mdTable(["Setup", "What runs"], ARMS.filter((a) => arms.includes(a)).map((a) => [a, SETUPS[a]]))}\n### Cells, limits and runs\n\n${mdTable(CAP_HEADS, capRows(s))}\n`;
  md += "## Results per task\n\n";
  for (const t of tasks) {
    md += `### ${t}\n\n`;
    for (const cell of cellsIn(s.cells.filter((c) => c.task === t))) md += `**${cell}** (${CELL_TEXT[cell] ?? cell})\n\n${mdTable(RESULT_HEADS, resultsRows(s, t, cell))}\n`;
  }
  md += `### Comparisons with the baselines\n\n${mdTable(COMPARISON_HEADS, comparisonRows(s))}\n`;
  md += `## Process\n\n${mdTable(PROCESS_HEADS, processRows(s))}\n## Claims vs results\n\n${mdTable(HONESTY_HEADS, honestyRows(s))}\n## Failures and exclusions\n\n${mdTable(FAILURE_HEADS, failureRows(s))}\n### Retries\n\n${retryNote(s)}\n\n${retryRows(s).length ? `${mdTable(RETRY_HEADS, retryRows(s))}\n` : ""}`;
  md += `## Caveats\n\n${caveats(s).map((c) => `- ${c}`).join("\n")}\n`;
  return md;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  let input = null;
  let html = null;
  let md = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--html") html = args[++i];
    else if (args[i] === "--md") md = args[++i];
    else input = args[i];
  }
  if (!input) {
    console.error("usage: node bench/report.mjs <summary.json> [--html <file>] [--md <file>]");
    process.exit(1);
  }
  const summary = JSON.parse(readFileSync(input, "utf8"));
  const base = dirname(resolve(input));
  const htmlFile = resolve(html ?? join(base, "report.html"));
  const mdFile = resolve(md ?? join(base, "benchmarks.md"));
  const rel = (p) => {
    const r = relative(process.cwd(), p);
    return r.startsWith("..") ? p : r;
  };
  mkdirSync(dirname(htmlFile), { recursive: true });
  mkdirSync(dirname(mdFile), { recursive: true });
  writeFileSync(htmlFile, renderHtml(summary, { mdPath: rel(mdFile) }));
  writeFileSync(mdFile, renderMarkdown(summary, { sources: summary.campaigns.map((c) => rel(c.dir)).join(", "), htmlPath: rel(htmlFile) }));
  console.log(`${htmlFile}\n${mdFile}`);
}
