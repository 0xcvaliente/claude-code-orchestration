// One parser for the orchestrator's briefs, the plan reviewer's plan, the workers' replies and the run model.
// Spec: docs/brief-grammar.md. Imported by the hooks, by tests from a temp copy and possibly from a checkout, so it
// has no side effects at import, uses Node built-ins only, and no parser throws: malformed or empty input gives
// empty or null fields. Functions that read files (agentModel) catch every error and return null.
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Retries after the first implementer launch of a slice in a run: 1 + MAX_RETRIES launches, then a failed review is final. */
export const MAX_RETRIES = 2;
/** Default for ORCH_RUN_STALE_MIN: minutes without a launch or stop after which a run is stale. */
export const RUN_STALE_MIN_DEFAULT = 30;

// A header key may follow list, quote and emphasis characters ("- **SLICE:** A0", "> FILES: a"), like the hooks today.
const PRE = "[ \\t>*_`-]*";
// Reply fields (STATUS, OPEN, C<n>) are the reviewer's own lines: a blockquoted line is a quote, never a verdict.
const STATUS_RE = /^[\s*_#`]*STATUS[\s*_`]*:[\s*_`]*(pass|fail)(?![A-Za-z0-9])(?![\s*_`]*(?:or|\/|\|)[\s*_`]*(?:STATUS\b|pass|fail))/i;
const OPEN_RE = /^[\s*_#`-]*OPEN[\s*_`]*:[\s*_`]*(.*)$/i;
const ANSWER_RE = /^[\s*_#`-]*(C\d+)[\s*_`]*:[\s*_`]*(pass|fail)(?![A-Za-z0-9])(?![\s*_`]*(?:or|\/|\|)[\s*_`]*(?:pass|fail)\b)[\s*_`]*(.*)$/i;
const NOTHING = new Set(["", "none", "-", "n/a", "nothing"]);

/** @param {unknown} text @returns {string} */
const str = (text) => (typeof text === "string" ? text : "");
/** @param {string} text @returns {string[]} */
const lines = (text) => text.split(/\r?\n/);
/** @param {string} s */
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The first line anywhere in `text` that is `KEY: value` (after list, quote or emphasis characters), trimmed value.
 * Same rule as plan-check.mjs: keys are case-insensitive, the first match wins, so header lines belong at the start.
 * @param {string} text @param {string} key @returns {string | undefined}
 */
function field(text, key) {
  return text.match(new RegExp(`^${PRE}${esc(key)}:\\**[ \\t]*(.+)$`, "im"))?.[1]?.trim();
}

/** A one-line value of a field that sits on its own line ("GOAL: ..."), for the plan's per-slice lines. @param {string} l @param {string} key */
function lineValue(l, key) {
  const m = l.match(new RegExp(`^${PRE}${esc(key)}:\\**[ \\t]*(.*)$`, "i"));
  return m ? (m[1] ?? "").trim() : undefined;
}

/**
 * Comma-separated list, as plan-check.mjs reads FILES and DEPENDS: trimmed, outer quotes and backticks and a
 * leading ./ removed, empty entries and "none" dropped.
 * @param {string | undefined} v @returns {string[]}
 */
function list(v) {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^[`'"]+|[`'"]+$/g, "").replace(/^\.\//, ""))
    .filter((s) => s && s.toLowerCase() !== "none");
}

/** Slice id: the first word, quotes, backticks and asterisks removed (plan-check.mjs). @param {string | undefined} v */
function sliceId(v) {
  const id = (v ?? "").replace(/[`'"*]/g, "").trim().split(/\s+/)[0];
  return id ? id : null;
}

/** Constraint ids from a CHECKS line: C<n> tokens, upper-cased, deduplicated, in order; anything else dropped. @param {string | undefined} v */
function checkIds(v) {
  const ids = (v ?? "").match(/\bC\d+\b/gi) ?? [];
  return [...new Set(ids.map((s) => s.toUpperCase()))];
}

/** @param {string | undefined} v */
const yes = (v) => /^\**[ \t]*yes\b/i.test(v ?? "");

/**
 * @typedef {{
 *   slice: string | null,
 *   files: string[],
 *   depends: string[],
 *   path: 'light' | null,
 *   risky: boolean,
 *   checks: string[],
 *   focus: string | null,
 *   workflow: boolean
 * }} Header
 */

/**
 * Header lines of an implementer or reviewer brief: SLICE, FILES, DEPENDS, PATH, RISKY, CHECKS, FOCUS and the
 * scripted workflow's ORCHESTRATION: workflow marker. Missing lines give null, [] or false.
 * @param {unknown} text @returns {Header}
 */
export function parseHeader(text) {
  const t = str(text);
  return {
    slice: sliceId(field(t, "SLICE")),
    files: list(field(t, "FILES")),
    depends: list(field(t, "DEPENDS")),
    path: /^light\b/i.test(field(t, "PATH") ?? "") ? "light" : null,
    risky: yes(field(t, "RISKY")),
    checks: checkIds(field(t, "CHECKS")),
    focus: field(t, "FOCUS") || null,
    workflow: new RegExp(`^${PRE}ORCHESTRATION:\\**[ \\t]*workflow\\b`, "im").test(t),
  };
}

/** The brief starts with PLAN REVIEW (journal.mjs: leading whitespace allowed, case-sensitive). @param {unknown} text */
export const isPlanReview = (text) => /^\s*PLAN REVIEW\b/.test(str(text));

/**
 * The slice a brief is about, as journal.mjs keys it: "plan" for a PLAN REVIEW brief, else its SLICE id, else null.
 * @param {unknown} text @returns {string | null}
 */
export const sliceOfBrief = (text) => (isPlanReview(text) ? "plan" : parseHeader(text).slice);

/**
 * @typedef {{ slice: string, files: string[], depends: string[], goal: string | null, risky: boolean, checks: string[] }} PlannedSlice
 * @typedef {{ isPlanReview: boolean, replan: number | null, constraints: Record<string, string>, slices: PlannedSlice[] }} Plan
 */

/**
 * A PLAN REVIEW brief: REPLAN number, the CONSTRAINTS block (C<n>: text lines right after a CONSTRAINTS: line) and the
 * planned slices (each SLICE: line starts one; FILES, DEPENDS, GOAL, RISKY and CHECKS lines up to the next SLICE: fill
 * it). Text that is not a PLAN REVIEW brief gives an empty plan. A repeated SLICE id continues its first entry; the
 * first goal (inline after the id, else the GOAL line) is kept.
 * @param {unknown} text @returns {Plan}
 */
export function parsePlan(text) {
  const t = str(text);
  /** @type {Plan} */
  const plan = { isPlanReview: isPlanReview(t), replan: null, constraints: {}, slices: [] };
  if (!plan.isPlanReview) return plan;
  const n = field(t, "REPLAN")?.match(/^\**[ \t]*(\d+)/)?.[1];
  plan.replan = n === undefined ? null : Number(n);

  /** @type {PlannedSlice | null} */
  let cur = null;
  let inConstraints = false;
  for (const l of lines(t)) {
    if (inConstraints) {
      const c = l.match(new RegExp(`^${PRE}(C\\d+)\\**:\\**[ \\t]*(.*)$`, "i"));
      if (c) {
        const id = (c[1] ?? "").toUpperCase();
        const body = (c[2] ?? "").trim();
        if (body && !(id in plan.constraints)) plan.constraints[id] = body;
        continue;
      }
      if (!l.trim()) continue; // blank lines inside the block are fine
      inConstraints = false;
    }
    if (lineValue(l, "CONSTRAINTS") !== undefined) {
      inConstraints = true;
      continue;
    }
    // Same as planOf in dashboard/register.tsx: a heading may precede SLICE, the id loses quotes and trailing
    // punctuation, an id "plan" is not a slice, and text after the id ("SLICE: s1 - parser") is the goal.
    const s = l.match(/^[ \t>*_`#-]*SLICE:\**[ \t]*[`*]*([^\s`'"*]+)[`*]*(.*)$/i);
    if (s) {
      const id = (s[1] ?? "").replace(/[:,;.]+$/, "");
      const own = !!id && id.toLowerCase() !== "plan";
      cur = own ? (plan.slices.find((x) => x.slice === id) ?? null) : null;
      if (own && !cur) plan.slices.push((cur = { slice: id, files: [], depends: [], goal: null, risky: false, checks: [] }));
      const rest = (s[2] ?? "").replace(/^[\s*`_:|—–-]+/, "").trim();
      if (cur && rest && !cur.goal) cur.goal = rest;
      continue;
    }
    if (!cur) continue;
    const files = lineValue(l, "FILES");
    if (files !== undefined) cur.files = list(files);
    const depends = lineValue(l, "DEPENDS");
    if (depends !== undefined) cur.depends = list(depends);
    const goal = lineValue(l, "GOAL");
    if (goal && !cur.goal) cur.goal = goal;
    const risky = lineValue(l, "RISKY");
    if (risky !== undefined) cur.risky = yes(risky);
    const checks = lineValue(l, "CHECKS");
    if (checks !== undefined) cur.checks = checkIds(checks);
  }
  return plan;
}

/**
 * STATUS of a reply: lines that start with STATUS: pass|fail after whitespace, emphasis or heading characters (not a
 * blockquote, not mid-line, not the template "pass or fail"). Any fail line fails; otherwise the first line decides;
 * no such line is null. Same rule as scripts/auto.sh's reviewed route.
 * @param {unknown} text @returns {'pass' | 'fail' | null}
 */
export function parseStatus(text) {
  const found = lines(str(text))
    .map((l) => STATUS_RE.exec(l)?.[1]?.toLowerCase())
    .filter((v) => v === "pass" || v === "fail");
  if (found.includes("fail")) return "fail";
  return found[0] === "pass" ? "pass" : null;
}

/**
 * @typedef {{ verdict: 'pass' | 'fail', mode: 'cmd' | 'read' | null, detail: string }} Answer
 * @typedef {{ status: 'pass' | 'fail' | null, open: string[], answers: Record<string, Answer> }} Reply
 */

/**
 * A worker's reply: STATUS (parseStatus), OPEN items and one answer per checked constraint id.
 * OPEN: the first OPEN: line; its inline value is one item, and the list lines right below it (up to a blank line after
 * an item, or the next KEY: line) are one item each; "none", "-", "n/a", "nothing" and empty mean nothing open.
 * Answers: `C<n>: pass (cmd) <command> -> <result>`, `C<n>: pass (read) <file:line or URL>`, `C<n>: fail <reason>`;
 * "→" is read as "->" (detail keeps "->"). The first line for an id decides unless a later line for it says fail.
 * @param {unknown} text @returns {Reply}
 */
export function parseReply(text) {
  const all = lines(str(text));
  /** @type {Reply} */
  const reply = { status: parseStatus(text), open: [], answers: {} };

  const at = all.findIndex((l) => OPEN_RE.test(l));
  if (at !== -1) {
    /** @param {string} item */
    const add = (item) => {
      const v = item.trim();
      if (!NOTHING.has(v.toLowerCase().replace(/[.;:]+$/, "").trim())) reply.open.push(v);
    };
    add(OPEN_RE.exec(/** @type {string} */ (all[at]))?.[1] ?? "");
    let started = false;
    for (const l of all.slice(at + 1)) {
      if (!l.trim()) {
        if (started) break;
        continue;
      }
      const item = l.match(/^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/);
      if (!item) break; // a new field or a paragraph ends the list
      started = true;
      add(item[1] ?? "");
    }
  }

  for (const l of all) {
    const m = ANSWER_RE.exec(l);
    if (!m) continue;
    const id = (m[1] ?? "").toUpperCase();
    const verdict = /** @type {'pass' | 'fail'} */ ((m[2] ?? "").toLowerCase());
    const rest = (m[3] ?? "").replace(/[*_`]+$/, "").trim();
    const mode = rest.match(/^\((cmd|read)\)\s*/i);
    /** @type {Answer} */
    const answer = {
      verdict,
      mode: mode ? /** @type {'cmd' | 'read'} */ ((mode[1] ?? "").toLowerCase()) : null,
      detail: rest.slice(mode ? mode[0].length : 0).replace(/\s*→\s*/g, " -> ").trim(),
    };
    const prev = reply.answers[id];
    if (!prev || (verdict === "fail" && prev.verdict === "pass")) reply.answers[id] = answer;
  }
  return reply;
}

/**
 * FILES entries as absolute paths: relative ones resolved against baseDir, absolute ones kept (normalized), trailing
 * slashes stripped, empty and duplicate entries dropped. Without a baseDir, relative entries stay relative.
 * @param {unknown} files @param {string | undefined | null} baseDir @returns {string[]}
 */
export function normalizeFiles(files, baseDir) {
  if (!Array.isArray(files)) return [];
  const base = typeof baseDir === "string" && baseDir ? baseDir : null;
  /** @type {string[]} */
  const out = [];
  for (const f of files) {
    if (typeof f !== "string" || !f.trim()) continue;
    const p = f.trim();
    const abs = base || p.startsWith("/") ? resolve(base ?? "/", p) : p;
    const clean = abs.length > 1 ? abs.replace(/\/+$/, "") : abs;
    if (clean && !out.includes(clean)) out.push(clean);
  }
  return out;
}

/** A model counts as opus when its name contains "opus" (any case). @param {unknown} model */
export const isOpusModel = (model) => typeof model === "string" && model.toLowerCase().includes("opus");

/** The `model:` line of an agent file's frontmatter, or null. @param {unknown} text @returns {string | null} */
export function modelFromAgentFile(text) {
  const fm = str(text).match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const m = fm?.[1]?.match(/^model:[ \t]*["']?([^"'\s#]+)/m);
  return m?.[1] ?? null;
}

/**
 * The model an Agent launch runs on: tool_input.model when given; else the agent definition's model: line
 * (<projectDir>/.claude/agents/<bare name>.md, else <pluginRoot>/agents/<bare name>.md); else null (unknown, not opus).
 * @param {unknown} toolInput @param {{ projectDir?: string | null, pluginRoot?: string | null }} [dirs]
 * @returns {string | null}
 */
export function agentModel(toolInput, dirs = {}) {
  const ti = /** @type {Record<string, unknown>} */ (toolInput && typeof toolInput === "object" ? toolInput : {});
  if (typeof ti.model === "string" && ti.model.trim()) return ti.model.trim();
  const name = String(ti.subagent_type ?? "").split(":").pop() ?? "";
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return null;
  const candidates = [];
  if (dirs.projectDir) candidates.push(join(dirs.projectDir, ".claude", "agents", `${name}.md`));
  if (dirs.pluginRoot) candidates.push(join(dirs.pluginRoot, "agents", `${name}.md`));
  for (const file of candidates) {
    try {
      return modelFromAgentFile(readFileSync(file, "utf8"));
    } catch {
      // no such file: try the next
    }
  }
  return null;
}

/** ORCH_RUN_STALE_MIN as minutes (positive number), else the default. @param {Record<string, string | undefined>} [env] */
export function staleMinutes(env = {}) {
  const n = Number(env.ORCH_RUN_STALE_MIN);
  return Number.isFinite(n) && n > 0 ? n : RUN_STALE_MIN_DEFAULT;
}

/** ORCH_ESCALATION: "off", "always" or "auto" (anything else). @param {Record<string, string | undefined>} [env] @returns {'off' | 'always' | 'auto'} */
export function escalationMode(env = {}) {
  const v = String(env.ORCH_ESCALATION ?? "").trim().toLowerCase();
  return v === "off" || v === "always" ? v : "auto";
}

// ---- Log records. The run model is computed from what the hooks log, never from raw prompts. ----

/**
 * @typedef {{
 *   ts: string, session_id: string, agent_id: string | null, agent_type: string,
 *   slice: string | null, files: string[], depends: string[], path: 'light' | null, risky: boolean, checks: string[],
 *   focus: string | null, workflow: boolean, model: string | null, isPlanReview: boolean, replan: number | null,
 *   plan?: { constraints: Record<string, string>, slices: PlannedSlice[] }
 * }} LaunchRecord
 * journal-launches.jsonl, one per Agent launch of an implementer, reviewer, researcher or integrator (PostToolUse).
 * `slice` is sliceOfBrief: "plan" for a PLAN REVIEW brief. Older records carry only session_id, agent_id, slice, role.
 *
 * @typedef {{
 *   ts: string, session_id: string, agent_id: string | null, role: string, agent_type?: string, slice: string | null,
 *   status: 'pass' | 'fail' | null, answers: Record<string, Answer>, open: string[], run?: number | null,
 *   model?: string | null, checks?: string[], risky?: boolean
 * }} StopRecord
 * journal.jsonl, one per SubagentStop of a worker. `slice` comes from the launch record with the same agent_id (or the
 * pending path when the stop arrives first). Older records lack answers, open and run.
 *
 * @typedef {{ ts: string, gate: string, decision: string, reason: string, agent_type?: string, agent_id?: string, session_id?: string }} GateRecord
 * gates.jsonl. A test-gate record (gate "test", from verify.sh) names no slice: it is joined by agent_id to a launch.
 */

/** @param {unknown} t */
const bare = (t) => String(t ?? "").split(":").pop() ?? "";

/**
 * The launch record for an Agent launch: the parsed brief, never its text.
 * @param {unknown} toolInput tool_input of the Agent call
 * @param {{ ts?: string, sessionId?: string, agentId?: string | null, projectDir?: string | null, pluginRoot?: string | null }} [ctx]
 * @returns {LaunchRecord}
 */
export function launchRecord(toolInput, ctx = {}) {
  const ti = /** @type {Record<string, unknown>} */ (toolInput && typeof toolInput === "object" ? toolInput : {});
  const prompt = str(ti.prompt);
  const h = parseHeader(prompt);
  const p = parsePlan(prompt);
  /** @type {LaunchRecord} */
  const rec = {
    ts: ctx.ts ?? new Date().toISOString(),
    session_id: ctx.sessionId ?? "",
    agent_id: ctx.agentId ?? null,
    agent_type: bare(ti.subagent_type),
    slice: sliceOfBrief(prompt),
    files: h.files,
    depends: h.depends,
    path: h.path,
    risky: h.risky,
    checks: h.checks,
    focus: h.focus,
    workflow: h.workflow,
    model: agentModel(ti, { projectDir: ctx.projectDir, pluginRoot: ctx.pluginRoot }),
    isPlanReview: p.isPlanReview,
    replan: p.replan,
  };
  if (p.isPlanReview) rec.plan = { constraints: p.constraints, slices: p.slices };
  return rec;
}

/**
 * The stop record for a finished worker: STATUS, answers and OPEN from its final report.
 * @param {{ ts?: string, sessionId?: string, agentId?: string | null, role?: string, slice?: string | null, reply?: unknown, status?: 'pass' | 'fail' | null, run?: number | null }} ctx
 * @returns {StopRecord}
 */
export function stopRecord(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const r = parseReply(c.reply);
  return {
    ts: c.ts ?? new Date().toISOString(),
    session_id: c.sessionId ?? "",
    agent_id: c.agentId ?? null,
    role: bare(c.role),
    slice: c.slice ?? null,
    status: c.status !== undefined ? c.status : r.status,
    answers: r.answers,
    open: r.open,
    run: c.run ?? null,
  };
}

/**
 * @typedef {{ ts: number, status: 'pass' | 'fail' | null, answers: Record<string, Answer>, open: string[], model: string | null }} Review
 * @typedef {{
 *   slice: string, planned: boolean, risky: boolean, checks: string[],
 *   launches: number, attempts: number, lastImplAt: number | null, reviews: Review[],
 *   isolatedTestFailure: boolean, final: boolean, passed: boolean, gaveUp: boolean,
 *   attemptFrom: number, testGates: number[], reviewedSince: boolean
 * }} SliceState
 * launches: implementer launch records. attempts: implementer stops, a run of stops with no review between them
 * counting once (a test-gate block makes the agent stop again; a SendMessage resume adds a stop, not a launch).
 * lastImplAt: the latest implementer launch or stop. attemptFrom: the review time the latest attempt started after.
 * @typedef {{
 *   id: number, kind: 'planned' | 'light', openedAt: number, lastAt: number, closed: boolean, stale: boolean,
 *   constraints: Record<string, string>, planned: string[], slices: Record<string, SliceState>
 * }} Run
 * @typedef {{ launches?: unknown[], stops?: unknown[], gates?: unknown[] }} Records
 */

/** @param {unknown} ts */
const time = (ts) => (typeof ts === "number" ? ts : Date.parse(String(ts ?? "")) || 0);
/** @param {unknown} v @returns {any[]} */
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
/** @param {unknown} v @returns {string[]} */
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** @param {string} slice @param {boolean} planned @returns {SliceState} */
const newSlice = (slice, planned) => ({
  slice, planned, risky: false, checks: [], launches: 0, attempts: 0, lastImplAt: null, reviews: [],
  isolatedTestFailure: false, final: false, passed: false, gaveUp: false, attemptFrom: -Infinity, testGates: [], reviewedSince: false,
});

/** Reviews after the slice's latest implementer launch or stop. @param {SliceState} s */
export const currentReviews = (s) => s.reviews.filter((r) => s.lastImplAt === null || r.ts > s.lastImplAt);

/** @param {SliceState} s */
function settle(s) {
  const latest = currentReviews(s).at(-1);
  s.passed = latest?.status === "pass";
  s.gaveUp = latest?.status === "fail" && s.attempts >= 1 + MAX_RETRIES;
  s.final = s.passed || s.gaveUp;
  s.isolatedTestFailure = s.testGates.some((t) => t > s.attemptFrom);
}

/**
 * Folds one session's log records into runs (docs/brief-grammar.md, "Run model"). Records of other sessions are
 * dropped when `sessionId` is given. A gate record counts when its agent_id joins a launch and its session_id (when it
 * has one) is that launch's. A run opens at a PLAN REVIEW launch without REPLAN (closing any open run) or at a PATH: light implementer
 * launch with no run open; a PLAN REVIEW with REPLAN extends the open run (or opens one). Launches outside any run are
 * not tracked. `now` decides staleness at the end; a launch decides it on the way.
 * @param {Records} records @param {{ now?: number, staleMin?: number, sessionId?: string }} [opts]
 * @returns {{ runs: Run[], open: Run | null }}
 */
export function foldRuns(records, opts = {}) {
  const rec = /** @type {Records} */ (records && typeof records === "object" ? records : {});
  const staleMs = (opts.staleMin ?? RUN_STALE_MIN_DEFAULT) * 60000;
  const now = opts.now ?? Date.now();
  const sid = opts.sessionId;
  const mine = (/** @type {any} */ r) => sid === undefined || r.session_id === sid;
  const launches = arr(rec.launches).filter(mine);
  /** @type {Map<string, any>} */
  const byAgent = new Map();
  for (const l of launches) if (typeof l.agent_id === "string" && l.agent_id) byAgent.set(l.agent_id, l);
  const stops = arr(rec.stops).filter(mine);
  const gates = arr(rec.gates).filter(
    (g) =>
      g.gate === "test" &&
      g.reason === "tests_failed_isolated" &&
      typeof g.agent_id === "string" &&
      byAgent.has(g.agent_id) &&
      (g.session_id === undefined || g.session_id === byAgent.get(g.agent_id)?.session_id),
  );
  // One timeline; at equal times a launch comes before a stop, a stop before a gate.
  const events = [
    ...launches.map((r, i) => ({ kind: 0, i, r })),
    ...stops.map((r, i) => ({ kind: 1, i, r })),
    ...gates.map((r, i) => ({ kind: 2, i, r })),
  ].sort((a, b) => time(a.r.ts) - time(b.r.ts) || a.kind - b.kind || a.i - b.i);

  /** @type {Run[]} */
  const runs = [];
  /** @type {Run | null} the latest run; it is open while neither closed nor stale */
  let cur = null;
  /** @param {'planned' | 'light'} kind @param {number} ts @returns {Run} */
  const openRun = (kind, ts) => {
    /** @type {Run} */
    const run = { id: runs.length + 1, kind, openedAt: ts, lastAt: ts, closed: false, stale: false, constraints: {}, planned: [], slices: {} };
    runs.push(run);
    return run;
  };
  /** @param {Run} run */
  const closeIfDone = (run) => {
    const ids = run.kind === "planned" ? run.planned : Object.keys(run.slices);
    if (ids.length && ids.every((id) => run.slices[id]?.final)) run.closed = true;
  };
  /** @param {string} slice */
  const runWith = (slice) => (slice ? runs.findLast((r) => slice in r.slices) : undefined);

  for (const { kind, r } of events) {
    const ts = time(r.ts);
    const role = bare(r.agent_type ?? r.role);
    if (kind === 0) {
      // Staleness is judged at a launch: a stale run no longer counts as open, so a light launch opens a new run.
      if (cur && !cur.closed && ts - cur.lastAt > staleMs) cur.stale = true;
      /** @type {Run | null} */
      let open = cur && !cur.closed && !cur.stale ? cur : null;
      if (role === "reviewer" && (r.isPlanReview === true || r.slice === "plan")) {
        const replan = typeof r.replan === "number" ? r.replan : null;
        if (replan === null || !open) {
          if (open) open.closed = true;
          open = cur = openRun("planned", ts);
        }
        open.kind = "planned";
        open.lastAt = ts;
        const plan = r.plan && typeof r.plan === "object" ? r.plan : {};
        if (plan.constraints && typeof plan.constraints === "object") Object.assign(open.constraints, plan.constraints);
        for (const p of arr(plan.slices)) {
          if (typeof p.slice !== "string" || !p.slice) continue;
          if (!open.planned.includes(p.slice)) open.planned.push(p.slice);
          const s = (open.slices[p.slice] ??= newSlice(p.slice, true));
          s.planned = true;
          s.risky = s.risky || p.risky === true;
          s.checks = [...new Set([...s.checks, ...strings(p.checks)])];
        }
        continue;
      }
      if (role === "implementer") {
        const slice = typeof r.slice === "string" && r.slice !== "plan" ? r.slice : null;
        if (r.workflow === true || !slice) continue;
        if (!open && r.path === "light") open = cur = openRun("light", ts);
        if (!open) continue;
        const s = (open.slices[slice] ??= newSlice(slice, false));
        s.launches += 1;
        s.lastImplAt = ts;
        s.risky = s.risky || r.risky === true;
        s.checks = [...new Set([...s.checks, ...strings(r.checks)])];
        open.lastAt = ts;
        settle(s);
        continue;
      }
      if (open) open.lastAt = Math.max(open.lastAt, ts);
      continue;
    }
    const launch = typeof r.agent_id === "string" ? byAgent.get(r.agent_id) : undefined;
    const slice = String((kind === 2 ? launch?.slice : (r.slice ?? launch?.slice)) ?? "");
    const run = runWith(slice) ?? cur;
    if (!run) continue;
    if (kind === 1) run.lastAt = Math.max(run.lastAt, ts);
    const s = slice ? run.slices[slice] : undefined;
    if (!s) continue;
    if (kind === 2) {
      s.testGates.push(ts);
    } else if (role === "implementer") {
      if (s.attempts === 0 || s.reviewedSince) {
        s.attempts += 1;
        s.attemptFrom = s.reviews.at(-1)?.ts ?? -Infinity;
        s.reviewedSince = false;
      }
      s.lastImplAt = Math.max(s.lastImplAt ?? ts, ts);
    } else if (role === "reviewer") {
      const status = r.status === "pass" || r.status === "fail" ? r.status : null;
      const model = typeof r.model === "string" ? r.model : typeof launch?.model === "string" ? launch.model : null;
      s.reviews.push({ ts, status, answers: r.answers && typeof r.answers === "object" ? r.answers : {}, open: Array.isArray(r.open) ? r.open : [], model });
      s.reviewedSince = true;
    }
    settle(s);
    closeIfDone(run);
  }
  if (cur && !cur.closed && now - cur.lastAt > staleMs) cur.stale = true;
  return { runs, open: cur && !cur.closed && !cur.stale ? cur : null };
}

/**
 * Doubt signals for a slice: why it needs a passing opus review after its latest implementer. Empty when ORCH_ESCALATION
 * is off; ["always"] when it is always. Signals: risky, retry (an earlier failed review), read_answer and open_items
 * (in its latest passing review), tests_failed_isolated (for its latest implementer attempt).
 * @param {SliceState} s @param {Record<string, string | undefined>} [env] @returns {string[]}
 */
export function doubtSignals(s, env = {}) {
  const mode = escalationMode(env);
  if (mode === "off") return [];
  if (mode === "always") return ["always"];
  const signals = [];
  if (s.risky) signals.push("risky");
  if (s.reviews.some((r) => r.status === "fail")) signals.push("retry");
  const pass = currentReviews(s).filter((r) => r.status === "pass").at(-1);
  if (pass && Object.values(pass.answers).some((a) => a?.mode === "read")) signals.push("read_answer");
  if (pass && pass.open.length) signals.push("open_items");
  if (s.isolatedTestFailure) signals.push("tests_failed_isolated");
  return signals;
}

/** A passing review on an opus model after the slice's latest implementer. @param {SliceState} s */
export const hasOpusPass = (s) => currentReviews(s).some((r) => r.status === "pass" && isOpusModel(r.model));
