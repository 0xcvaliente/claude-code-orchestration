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

/** East Asian Wide and Fullwidth ranges, and the emoji blocks, that a terminal draws two columns wide. */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1F300}-\u{1F64F}\u{1F900}-\u{1F9FF}\u{20000}-\u{3FFFD}]|\p{Extended_Pictographic}️/u;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Terminal columns of one grapheme: 0 for a control or a lone mark, 2 when wide, else 1. @param {string} g */
function graphemeWidth(g) {
  if (WIDE.test(g)) return 2;
  return /^[\p{M}\p{Cc}\p{Cf}]+$/u.test(g) ? 0 : 1;
}

/**
 * The row cut to `columns` terminal columns by display width, whole graphemes only (a surrogate pair, an accent or an
 * emoji sequence is never split), ending in "…" when cut. @param {string} row @param {number} columns
 */
function fitColumns(row, columns) {
  const parts = [...graphemes.segment(row)].map((s) => s.segment);
  let width = 0;
  for (const g of parts) width += graphemeWidth(g);
  if (width <= columns) return row;
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
