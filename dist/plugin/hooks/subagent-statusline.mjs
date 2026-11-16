#!/usr/bin/env node
// Subagent status line (1.2.0): the row Claude Code shows under the prompt for each running subagent, rewritten for
// this plugin's workers as `<role> <slice> #<attempt> · <model> · <tokens> (<context %>) · <progress>`.
// Not a hook: Claude Code runs the `subagentStatusLine` command once per refresh tick with one JSON object on stdin
// (`columns`, and `tasks`: id, agentType, status, label, description, model, tokenCount, contextWindowSize, ...) and
// replaces the row of each `{"id", "content"}` line written to stdout (docs: statusline, "Subagent status lines").
// A plugin may set exactly two settings keys, `agent` and `subagentStatusLine`, so scripts/build-plugin.mjs ships this
// as the plugin's settings.json; a `subagentStatusLine` in the user's or project's settings takes its place.
// Rows of other agents (built-ins, other plugins) are left as Claude Code draws them: no line is written for them.
// The slice, the attempt and the flags come from the launch records (journal-launches.jsonl, parsed fields only);
// a row whose launch is not logged yet shows the role without them. It never fails a row: any error prints nothing,
// which keeps the default rows. Reads the state dir only; writes nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDirFor } from "./state.mjs";

const WORKERS = new Set(["researcher", "implementer", "reviewer", "integrator"]);

/** @param {unknown} t */
const bare = (t) => String(t ?? "").split(":").pop() ?? "";
/**
 * "941", "12.3k", "128k", "1.2M". Each tier is chosen by the value as it would print, so 99,950 prints "100k" (not
 * "100.0k") and 999,500 prints "1.0M" (not "1000k").
 * @param {number} n
 */
export function shortTokens(n) {
  if (!(n >= 0)) return "0";
  if (Math.round(n) < 1000) return String(Math.round(n));
  const tenthsK = Math.round(n / 100);
  if (tenthsK < 1000) return `${(tenthsK / 10).toFixed(1)}k`;
  const k = Math.round(n / 1000);
  if (k < 1000) return `${k}k`;
  return `${(Math.round(n / 100_000) / 10).toFixed(1)}M`;
}
/** @param {unknown} model */
const family = (model) => String(model ?? "").toLowerCase().match(/fable|mythos|opus|sonnet|haiku/)?.[0] ?? "";

/**
 * The launch records of one session from the text of journal-launches.jsonl, oldest first. The file holds every session
 * of the project, so a line that does not contain the session id is skipped before it is parsed. No session id: all.
 * @param {string} text @param {unknown} sessionId
 * @returns {any[]}
 */
export function sessionLaunches(text, sessionId) {
  const sid = typeof sessionId === "string" ? sessionId : "";
  // the id as it appears inside a JSON string
  const needle = sid ? JSON.stringify(sid).slice(1, -1) : "";
  /** @type {any[]} */
  const out = [];
  for (const l of text.split("\n")) {
    if (!l || (needle && !l.includes(needle))) continue;
    try {
      const r = JSON.parse(l);
      if (r && typeof r === "object" && (!sid || r.session_id === sid)) out.push(r);
    } catch {
      // a torn or foreign line: skip it
    }
  }
  return out;
}

/**
 * One pass over the launches for all rows of a refresh: the latest launch of each agent id, and the attempt number of
 * each implementer launch (fresh launches of its slice in the same run up to and including its time; a SendMessage
 * resume makes no launch, so it keeps its number). A run starts at a PLAN REVIEW launch without REPLAN, so a slice id
 * an earlier run of the session also used starts again at 1; a REPLAN plan review extends the run and keeps counting.
 * @param {any[]} launches oldest first
 * @returns {{ byAgent: Map<unknown, any>, nth: Map<any, number> }}
 */
export function indexLaunches(launches) {
  const byAgent = new Map();
  /** @type {Map<string, any[]>} */
  let bySlice = new Map();
  /** @type {Map<string, any[]>[]} */
  const runs = [bySlice];
  for (const l of launches) {
    byAgent.set(l?.agent_id, l);
    if (l?.isPlanReview === true && (l.replan === null || l.replan === undefined)) runs.push((bySlice = new Map()));
    if (bare(l?.agent_type) === "implementer" && typeof l.slice === "string") {
      const group = bySlice.get(l.slice) ?? [];
      group.push(l);
      bySlice.set(l.slice, group);
    }
  }
  /** @type {Map<any, number>} */
  const nth = new Map();
  for (const run of runs) for (const group of run.values()) for (const l of group) nth.set(l, group.filter((o) => o.ts <= l.ts).length);
  return { byAgent, nth };
}

/**
 * The row body of one task, or null to keep Claude Code's own row.
 * @param {any} task one entry of the `tasks` array @param {any[]} launches this session's launch records, oldest first
 * @param {number} [columns] usable row width
 * @param {{ byAgent: Map<unknown, any>, nth: Map<any, number> }} [index] indexLaunches(launches), built once per refresh
 * @returns {string | null}
 */
export function rowFor(task, launches, columns = 0, index) {
  const role = bare(task?.agentType);
  if (!task || typeof task.id !== "string" || !WORKERS.has(role)) return null;
  const idx = index ?? indexLaunches(launches);
  const launch = idx.byAgent.get(task.id);
  const head = [role];
  if (launch?.isPlanReview) head.push(launch.replan === null || launch.replan === undefined ? "plan" : "replan");
  else if (typeof launch?.slice === "string" && launch.slice) {
    head.push(launch.slice);
    if (role === "implementer") {
      const nth = idx.nth.get(launch) ?? 0;
      if (nth > 1) head.push(`#${nth}`);
    }
    if (launch.validate) head.push("validate");
  }
  if (launch?.risky) head.push("risky");
  const parts = [head.join(" ")];
  const fam = family(task.model);
  if (fam) parts.push(fam);
  if (typeof task.tokenCount === "number") {
    const pct = typeof task.contextWindowSize === "number" && task.contextWindowSize > 0 ? ` (${Math.round((100 * task.tokenCount) / task.contextWindowSize)}%)` : "";
    parts.push(`${shortTokens(task.tokenCount)}${pct}`);
  }
  if (typeof task.status === "string" && task.status && task.status !== "running") parts.push(task.status);
  const label = typeof task.label === "string" && task.label.trim() ? task.label.trim() : typeof task.description === "string" ? task.description.trim() : "";
  if (label) parts.push(label.replace(/\s+/g, " "));
  const row = parts.join(" · ");
  return columns > 8 ? fitColumns(row, columns) : row;
}

// Two columns: emoji presentation (by default, or forced by U+FE0F, which covers keycaps), and East Asian Wide or
// Fullwidth text. Text presentation (U+FE0E) is one column.
const EMOJI = /\p{Emoji_Presentation}|\p{Emoji}\uFE0F/u;
// JavaScript has no East_Asian_Width property, so the ranges of code points whose East_Asian_Width is W or F are
// generated from Unicode 17.0.0 (Python's unicodedata), as start, end pairs. Regenerate after a Unicode update with:
//   python3 -I -c "import unicodedata as u; w=[u.east_asian_width(chr(c)) in 'WF' for c in range(0x110000)]+[0];
//   print(', '.join('0x%x, 0x%x' % (s, e-1) for s in range(0x110000) if w[s] and (s == 0 or not w[s-1])
//   for e in [next(i for i in range(s, 0x110001) if not w[i])]))"
// src/subagent-statusline.test.mjs compares the widths with Python's unicodedata when python3 is installed.
const WIDE = [
  0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec, 0x23f0, 0x23f0, 0x23f3, 0x23f3, 0x25fd, 0x25fe,
  0x2614, 0x2615, 0x2630, 0x2637, 0x2648, 0x2653, 0x267f, 0x267f, 0x268a, 0x268f, 0x2693, 0x2693, 0x26a1, 0x26a1,
  0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26ce, 0x26d4, 0x26d4, 0x26ea, 0x26ea, 0x26f2, 0x26f3,
  0x26f5, 0x26f5, 0x26fa, 0x26fa, 0x26fd, 0x26fd, 0x2705, 0x2705, 0x270a, 0x270b, 0x2728, 0x2728, 0x274c, 0x274c,
  0x274e, 0x274e, 0x2753, 0x2755, 0x2757, 0x2757, 0x2795, 0x2797, 0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b, 0x2b1c,
  0x2b50, 0x2b50, 0x2b55, 0x2b55, 0x2e80, 0x2e99, 0x2e9b, 0x2ef3, 0x2f00, 0x2fd5, 0x2ff0, 0x303e, 0x3041, 0x3096,
  0x3099, 0x30ff, 0x3105, 0x312f, 0x3131, 0x318e, 0x3190, 0x31e5, 0x31ef, 0x321e, 0x3220, 0x3247, 0x3250, 0xa48c,
  0xa490, 0xa4c6, 0xa960, 0xa97c, 0xac00, 0xd7a3, 0xf900, 0xfaff, 0xfe10, 0xfe19, 0xfe30, 0xfe52, 0xfe54, 0xfe66,
  0xfe68, 0xfe6b, 0xff01, 0xff60, 0xffe0, 0xffe6, 0x16fe0, 0x16fe4, 0x16ff0, 0x16ff6, 0x17000, 0x18cd5,
  0x18cff, 0x18d1e, 0x18d80, 0x18df2, 0x1aff0, 0x1aff3, 0x1aff5, 0x1affb, 0x1affd, 0x1affe, 0x1b000, 0x1b122,
  0x1b132, 0x1b132, 0x1b150, 0x1b152, 0x1b155, 0x1b155, 0x1b164, 0x1b167, 0x1b170, 0x1b2fb, 0x1d300, 0x1d356,
  0x1d360, 0x1d376, 0x1f004, 0x1f004, 0x1f0cf, 0x1f0cf, 0x1f18e, 0x1f18e, 0x1f191, 0x1f19a, 0x1f200, 0x1f202,
  0x1f210, 0x1f23b, 0x1f240, 0x1f248, 0x1f250, 0x1f251, 0x1f260, 0x1f265, 0x1f300, 0x1f320, 0x1f32d, 0x1f335,
  0x1f337, 0x1f37c, 0x1f37e, 0x1f393, 0x1f3a0, 0x1f3ca, 0x1f3cf, 0x1f3d3, 0x1f3e0, 0x1f3f0, 0x1f3f4, 0x1f3f4,
  0x1f3f8, 0x1f43e, 0x1f440, 0x1f440, 0x1f442, 0x1f4fc, 0x1f4ff, 0x1f53d, 0x1f54b, 0x1f54e, 0x1f550, 0x1f567,
  0x1f57a, 0x1f57a, 0x1f595, 0x1f596, 0x1f5a4, 0x1f5a4, 0x1f5fb, 0x1f64f, 0x1f680, 0x1f6c5, 0x1f6cc, 0x1f6cc,
  0x1f6d0, 0x1f6d2, 0x1f6d5, 0x1f6d8, 0x1f6dc, 0x1f6df, 0x1f6eb, 0x1f6ec, 0x1f6f4, 0x1f6fc, 0x1f7e0, 0x1f7eb,
  0x1f7f0, 0x1f7f0, 0x1f90c, 0x1f93a, 0x1f93c, 0x1f945, 0x1f947, 0x1f9ff, 0x1fa70, 0x1fa7c, 0x1fa80, 0x1fa8a,
  0x1fa8e, 0x1fac6, 0x1fac8, 0x1fac8, 0x1facd, 0x1fadc, 0x1fadf, 0x1faea, 0x1faef, 0x1faf8, 0x20000, 0x2fffd,
  0x30000, 0x3fffd,
];

/** East Asian Wide or Fullwidth: a binary search over WIDE. @param {number} cp */
function wideCodePoint(cp) {
  let lo = 0, hi = WIDE.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < (WIDE[2 * mid] ?? 0)) hi = mid - 1;
    else if (cp > (WIDE[2 * mid + 1] ?? 0)) lo = mid + 1;
    else return true;
  }
  return false;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Terminal columns of one grapheme: 0 when it is only marks, joiners, variation selectors or controls; 2 for emoji
 * presentation or wide text; else 1. @param {string} g
 */
function graphemeWidth(g) {
  if (/^[\p{M}\p{Cc}\p{Cf}]+$/u.test(g)) return 0;
  if (g.includes("︎")) return 1;
  if (EMOJI.test(g)) return 2;
  return wideCodePoint(g.codePointAt(0) ?? 0) ? 2 : 1;
}

/** Terminal columns of a string, grapheme by grapheme. @param {string} s */
export function displayWidth(s) {
  let width = 0;
  for (const { segment } of graphemes.segment(s)) width += graphemeWidth(segment);
  return width;
}

/**
 * The row cut to `columns` terminal columns by display width, whole graphemes only (a surrogate pair, an accent or an
 * emoji sequence is never split), ending in "…" when cut. @param {string} row @param {number} columns
 */
function fitColumns(row, columns) {
  const parts = [...graphemes.segment(row)].map((s) => s.segment);
  if (displayWidth(row) <= columns) return row;
  let out = "", used = 0;
  for (const g of parts) {
    const w = graphemeWidth(g);
    if (used + w > columns - 1) break;
    out += g;
    used += w;
  }
  return `${out}…`;
}

// Run as the status line command only when executed directly (the tests import rowFor).
if (process.argv[1]?.endsWith("subagent-statusline.mjs")) {
  try {
    /** @type {any} */
    const input = JSON.parse(readFileSync(0, "utf8"));
    const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
    if (tasks.some((/** @type {any} */ t) => WORKERS.has(bare(t?.agentType)))) {
      const project = process.env.CLAUDE_PROJECT_DIR || (typeof input.workspace?.project_dir === "string" && input.workspace.project_dir) || (typeof input.cwd === "string" && input.cwd) || process.cwd();
      const { dir } = stateDirFor(project, { plugin: process.argv.includes("--plugin") });
      /** @type {any[]} */
      let launches = [];
      try {
        launches = sessionLaunches(readFileSync(join(dir, "journal-launches.jsonl"), "utf8"), input.session_id);
      } catch {
        // no launch records yet: rows show the role, model and tokens only
      }
      const columns = typeof input.columns === "number" ? input.columns : 0;
      const index = indexLaunches(launches);
      const out = [];
      for (const t of tasks) {
        const content = rowFor(t, launches, columns, index);
        if (content !== null) out.push(JSON.stringify({ id: t.id, content }));
      }
      if (out.length) process.stdout.write(`${out.join("\n")}\n`);
    }
  } catch {
    // malformed input: print nothing, so every row keeps its default
  }
  process.exit(0);
}
