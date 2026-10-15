#!/usr/bin/env node
// Charts for a benchmark campaign, as light and dark SVG pairs for the README's <picture> tags.
// Usage: node bench/charts.mjs <summary.json> [--out docs/diagrams] [--prefix bench-k2-cap10]
// Reads only summary.json (from `npm run bench:analyze`), so a committed copy rebuilds every chart.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// GitHub's own page colours (as in docs/diagrams/build.py); arm hues are the first four slots of the validated
// categorical palette (blue, orange, aqua, yellow), stepped for each surface.
const THEMES = {
  light: { paper: "#ffffff", ink: "#1f2328", muted: "#59636e", grid: "#d1d9e0", axis: "#818b98", arms: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"] },
  dark: { paper: "#0d1117", ink: "#f0f6fc", muted: "#9198a1", grid: "#30363d", axis: "#656c76", arms: ["#3987e5", "#d95926", "#199e70", "#c98500"] },
};
const ARMS = [
  { arm: "P-S", note: "plain Sonnet" },
  { arm: "P-O", note: "plain Opus" },
  { arm: "O-mix", note: "orchestrator" },
  { arm: "O-O", note: "orchestrator, all Opus" },
];
const FONT = 'font-family="system-ui,-apple-system,Segoe UI,sans-serif"';
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const r1 = (n) => Math.round(n * 10) / 10;
const median = (a) => { const s = [...a].sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

function frame(c, W, H, title, desc, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d" ${FONT}>
<title id="t">${esc(title)}</title><desc id="d">${esc(desc)}</desc>
<rect width="${W}" height="${H}" fill="${c.paper}"/>
${body}
</svg>`;
}
const text = (c, x, y, s, o = {}) => `<text x="${x}" y="${y}" fill="${o.fill ?? c.muted}" font-size="${o.size ?? 12}" text-anchor="${o.anchor ?? "start"}"${o.weight ? ` font-weight="${o.weight}"` : ""}>${esc(s)}</text>`;
const dot = (c, x, y, fill) => `<circle cx="${x}" cy="${y}" r="5" fill="${fill}" stroke="${c.paper}" stroke-width="2"/>`;
// A bar whose data end (top or right) is rounded 4px and whose base is square.
const barV = (x, y, w, h, fill) => `<path d="M${x},${y + h}V${y + 4}Q${x},${y} ${x + 4},${y}H${x + w - 4}Q${x + w},${y} ${x + w},${y + 4}V${y + h}Z" fill="${fill}"/>`;
const barH = (x, y, w, h, fill) => `<path d="M${x},${y}H${x + w - 4}Q${x + w},${y} ${x + w},${y + 4}V${y + h - 4}Q${x + w},${y + h} ${x + w - 4},${y + h}H${x}Z" fill="${fill}"/>`;

function runsOf(summary) {
  return ARMS.map(({ arm, note }, i) => ({ arm, note, i, runs: summary.runs.filter((r) => r.arm === arm && !r.excluded).sort((a, b) => a.rep - b.rep) })).filter((g) => g.runs.length);
}
const caption = (summary) => {
  const m = summary.campaigns?.[0]?.manifest;
  return `${summary.runs[0]?.task ?? "task"}, ${summary.runs[0]?.cap_min ?? "?"}-minute cap, ${m?.matrix?.groups?.[0]?.reps ?? "?"} runs per arm`;
};

// 1. Final hidden-test score per arm.
function scoreChart(c, summary) {
  const W = 720, H = 400, L = 56, R = 24, T = 52, B = 70, pw = W - L - R, ph = H - T - B;
  const y = (v) => T + ph - (v / 100) * ph;
  const groups = runsOf(summary);
  let b = text(c, L, 24, "Final hidden-test score (strict)", { fill: c.ink, size: 15, weight: 600 }) + text(c, L, 42, `${caption(summary)}; bar = median, dots = each run`);
  for (const v of [0, 25, 50, 75, 100]) b += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? c.axis : c.grid}"/>` + text(c, L - 8, y(v) + 4, `${v}%`, { anchor: "end" });
  const slot = pw / groups.length, bw = 64;
  groups.forEach((g, k) => {
    const scores = g.runs.map((r) => r.score_pct), med = median(scores), cx = L + slot * k + slot / 2;
    b += barV(cx - bw / 2, y(med), bw, y(0) - y(med), c.arms[g.i]);
    scores.forEach((s) => { b += dot(c, cx, y(s), c.ink); });
    b += text(c, cx, y(Math.max(med, ...scores)) - 12, `${r1(med)}%`, { anchor: "middle", fill: c.ink, size: 13, weight: 600 });
    b += text(c, cx, H - 40, g.arm, { anchor: "middle", fill: c.ink, size: 13, weight: 600 }) + text(c, cx, H - 24, g.note, { anchor: "middle" });
  });
  return frame(c, W, H, "Final hidden-test score per arm", groups.map((g) => `${g.arm} ${r1(median(g.runs.map((r) => r.score_pct)))}%`).join(", "), b);
}

// 2. Mean score over time; a run that has finished holds its final score.
function timelineChart(c, summary) {
  const W = 720, H = 400, L = 56, R = 96, T = 52, B = 56, pw = W - L - R, ph = H - T - B, cap = (summary.runs[0]?.cap_min ?? 10) * 60;
  const x = (t) => L + (t / cap) * pw, y = (v) => T + ph - (v / 100) * ph;
  const at = (run, t) => { let v = null; for (const [s, p] of run.timeline ?? []) if (s <= t) v = p; return v; };
  let b = text(c, L, 24, "Hidden-test score over time", { fill: c.ink, size: 15, weight: 600 }) + text(c, L, 42, `${caption(summary)}; mean of the runs, graded on each 2-minute snapshot`);
  for (const v of [0, 25, 50, 75, 100]) b += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? c.axis : c.grid}"/>` + text(c, L - 8, y(v) + 4, `${v}%`, { anchor: "end" });
  for (let t = 0; t <= cap; t += 120) b += `<line x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${T + ph}" stroke="${c.grid}"/>` + text(c, x(t), H - 30, `${t / 60} min`, { anchor: "middle" });
  const labels = [];
  runsOf(summary).forEach((g) => {
    const pts = [];
    for (let t = 120; t <= cap; t += 120) { const vals = g.runs.map((r) => at(r, t)).filter((v) => v != null); if (vals.length === g.runs.length) pts.push([t, mean(vals)]); }
    if (!pts.length) return;
    b += `<path d="${pts.map(([t, v], i) => `${i ? "L" : "M"}${x(t)},${y(v)}`).join("")}" fill="none" stroke="${c.arms[g.i]}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    pts.forEach(([t, v]) => { b += dot(c, x(t), y(v), c.arms[g.i]); });
    const [lt, lv] = pts[pts.length - 1];
    labels.push({ y: y(lv), x: x(lt) + 10, text: g.arm, v: lv });
  });
  labels.sort((p, q) => p.y - q.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 15) labels[i].y = labels[i - 1].y + 15;
  b += labels.map((l) => text(c, l.x, l.y + 4, `${l.text} ${r1(l.v)}%`, { fill: c.ink, weight: 600 })).join("");
  return frame(c, W, H, "Hidden-test score over time", "Mean strict score of each arm at 2, 4, 6, 8 and 10 minutes; finished runs hold their final score.", b);
}

// 3. Cost: tokens and wall time per arm.
function costChart(c, summary) {
  const W = 720, H = 350, L = 118, R = 70, T = 80, gap = 76, pw = (W - L - R - gap) / 2;
  const groups = runsOf(summary);
  const tok = groups.map((g) => median(g.runs.map((r) => r.tokens.total)) / 1e6), wall = groups.map((g) => median(g.runs.map((r) => r.wall_s)) / 60);
  let b = text(c, 24, 24, "Cost: tokens and wall time", { fill: c.ink, size: 15, weight: 600 }) + text(c, 24, 42, `${caption(summary)}; median per arm, tokens = input + output + cache`);
  const panel = (x0, title, vals, max, fmt) => {
    b += text(c, x0, T - 6, title, { fill: c.ink, weight: 600 });
    groups.forEach((g, k) => {
      const yy = T + 8 + k * 56, w = (vals[k] / max) * pw;
      b += barH(x0, yy, Math.max(w, 2), 28, c.arms[g.i]) + text(c, x0 + w + 8, yy + 19, fmt(vals[k]), { fill: c.ink, weight: 600 });
    });
    b += `<line x1="${x0}" x2="${x0}" y1="${T}" y2="${T + 4 * 56}" stroke="${c.axis}"/>`;
  };
  groups.forEach((g, k) => { b += text(c, L - 12, T + 8 + k * 56 + 15, g.arm, { anchor: "end", fill: c.ink, weight: 600 }) + text(c, L - 12, T + 8 + k * 56 + 29, g.note, { anchor: "end", size: 10 }); });
  panel(L, "Tokens (millions)", tok, Math.max(...tok) * 1.15, (v) => `${r1(v)}M`);
  panel(L + pw + gap, "Wall time (minutes)", wall, Math.max(...wall) * 1.15, (v) => `${r1(v)} min`);
  return frame(c, W, H, "Tokens and wall time per arm", groups.map((g, k) => `${g.arm}: ${r1(tok[k])}M tokens, ${r1(wall[k])} min`).join("; "), b);
}

// 4. Every run: tokens against score.
function scatterChart(c, summary) {
  const W = 720, H = 400, L = 56, R = 110, T = 52, B = 56, pw = W - L - R, ph = H - T - B;
  const groups = runsOf(summary), maxTok = Math.ceil(Math.max(...groups.flatMap((g) => g.runs.map((r) => r.tokens.total / 1e6)))) + 1;
  const x = (v) => L + (v / maxTok) * pw, y = (v) => T + ph - (v / 100) * ph;
  let b = text(c, L, 24, "Score against tokens, every run", { fill: c.ink, size: 15, weight: 600 }) + text(c, L, 42, `${caption(summary)}; up and to the left is better`);
  for (const v of [0, 25, 50, 75, 100]) b += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="${v === 0 ? c.axis : c.grid}"/>` + text(c, L - 8, y(v) + 4, `${v}%`, { anchor: "end" });
  for (let v = 0; v <= maxTok; v++) b += text(c, x(v), H - 32, `${v}M`, { anchor: "middle" });
  b += text(c, L + pw / 2, H - 12, "tokens per run", { anchor: "middle" });
  const labels = [];
  groups.forEach((g) => {
    g.runs.forEach((r) => { b += dot(c, x(r.tokens.total / 1e6), y(r.score_pct), c.arms[g.i]); });
    const far = g.runs.reduce((p, r) => (r.tokens.total > p.tokens.total ? r : p));
    labels.push({ x: x(far.tokens.total / 1e6) + 12, y: y(far.score_pct), text: g.arm });
  });
  labels.sort((p, q) => p.y - q.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 15) labels[i].y = labels[i - 1].y + 15;
  b += labels.map((l) => text(c, l.x, l.y + 4, l.text, { fill: c.ink, weight: 600 })).join("");
  return frame(c, W, H, "Score against tokens for every run", "Each dot is one run; orchestrated runs score higher and use about twice the tokens of plain runs.", b);
}

export function renderAll(summary, prefix = "bench-k2-cap10") {
  const out = {};
  for (const [theme, c] of Object.entries(THEMES)) {
    out[`${prefix}-score-${theme}.svg`] = scoreChart(c, summary);
    out[`${prefix}-timeline-${theme}.svg`] = timelineChart(c, summary);
    out[`${prefix}-cost-${theme}.svg`] = costChart(c, summary);
    out[`${prefix}-tokens-score-${theme}.svg`] = scatterChart(c, summary);
  }
  return out;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), flag = (n, d) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
  const file = args.find((a) => !a.startsWith("--") && a !== flag("--out") && a !== flag("--prefix"));
  if (!file) { console.error("usage: node bench/charts.mjs <summary.json> [--out dir] [--prefix name]"); process.exit(1); }
  const outDir = resolve(flag("--out", join(dirname(fileURLToPath(import.meta.url)), "..", "docs", "diagrams")));
  mkdirSync(outDir, { recursive: true });
  for (const [name, svg] of Object.entries(renderAll(JSON.parse(readFileSync(file, "utf8")), flag("--prefix", "bench-k2-cap10")))) {
    writeFileSync(join(outDir, name), svg);
    console.log(join(outDir, name));
  }
}
