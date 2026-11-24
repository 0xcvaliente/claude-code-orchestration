// One parser for the orchestrator's briefs, the plan reviewer's plan, the workers' replies and the run model.
// Spec: docs/brief-grammar.md. Imported by the hooks, by tests from a temp copy and possibly from a checkout, so it
// has no side effects at import, uses Node built-ins only, and no parser throws: malformed or empty input gives
// empty or null fields. Functions that read files (agentModel) catch every error and return null.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Retries after the first implementer launch of a slice in a run: 1 + MAX_RETRIES launches, then a failed review is final. */
export const MAX_RETRIES = 2;
/** Default for ORCH_RUN_STALE_MIN: minutes without a launch or stop after which a run is stale. */
export const RUN_STALE_MIN_DEFAULT = 30;
/** Default for ORCH_GAP_MIN: a failed review counts only with a gap at this confidence (0-100) or above. */
export const GAP_MIN_DEFAULT = 80;

// A header key may follow list, quote and emphasis characters ("- **SLICE:** A0", "> FILES: a"), like the hooks today.
const PRE = "[ \\t>*_`-]*";
// Reply fields (STATUS, OPEN, C<n>) are the reviewer's own lines: a blockquoted line is a quote, never a verdict.
const STATUS_RE = /^[\s*_#`]*STATUS[\s*_`]*:[\s*_`]*(pass|fail)(?![A-Za-z0-9])(?![\s*_`]*(?:or|\/|\|)[\s*_`]*(?:STATUS\b|pass|fail))/i;
const OPEN_RE = /^[\s*_#`-]*OPEN[\s*_`]*:[\s*_`]*(.*)$/i;
const ANSWER_RE = /^[\s*_#`-]*(C\d+)[\s*_`]*:[\s*_`]*(pass|fail)(?![A-Za-z0-9])(?![\s*_`]*(?:or|\/|\|)[\s*_`]*(?:pass|fail)\b)[\s*_`]*(.*)$/i;
const NOTHING = new Set(["", "none", "-", "n/a", "nothing"]);
// GAP and QUOTE are reply lines too: list and emphasis characters may come before the key, a blockquote never.
const GAP_RE = /^[\s*_#`-]*GAP[\s*_`]*:[\s*_`]*(.*)$/i;
const QUOTE_RE = /^[\s*_#`-]*QUOTE[\s*_`]*:[\s*_`]*(.*)$/i;
// DRAFT is a skill slice's reply line (`DRAFT: <name> <branch>`), read like GAP and QUOTE; DRAFTS: does not match it.
const DRAFT_RE = /^[\s*_#`-]*DRAFT[\s*_`]*:[\s*_`]*(.*)$/i;
// SKILLS-USED and SKILLS-SKIPPED are a worker's reply lines naming the skills it loaded or left out; SKILLS: does not match them.
const SKILLS_USED_RE = /^[\s*_#`-]*SKILLS-USED[\s*_`]*:[\s*_`]*(.*)$/i;
const SKILLS_SKIPPED_RE = /^[\s*_#`-]*SKILLS-SKIPPED[\s*_`]*:[\s*_`]*(.*)$/i;
const TARGETS = new Set(["private", "public"]);
const READ_MODES = new Set(["lookup", "extract", "judge"]);
/** At most this many URLs come back from briefUrls. */
const MAX_URLS = 50;

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

/** The first word of a SLICE value with quotes, backticks and asterisks removed; "" when none. @param {string | undefined} v */
const sliceWord = (v) => (v ?? "").replace(/[`'"*]/g, "").trim().split(/\s+/)[0] ?? "";

/**
 * Slice id, the one rule for a brief's header and a plan's SLICE lines: the first word of the value without quotes,
 * backticks and asterisks, trailing `:,;.` removed; null when nothing is left.
 * @param {string | undefined} v
 */
function sliceId(v) {
  return sliceWord(v).replace(/[:,;.]+$/, "") || null;
}

/** An OPEN item is empty when, without surrounding emphasis, backticks and a trailing `.;:`, it is in NOTHING. @param {string} v */
const nothingOpen = (v) => NOTHING.has(v.toLowerCase().replace(/^[\s*_`]+|[\s*_`.;:]+$/g, ""));

/** Constraint ids from a CHECKS line: C<n> tokens, upper-cased, deduplicated, in order; anything else dropped. @param {string | undefined} v */
function checkIds(v) {
  const ids = (v ?? "").match(/\bC\d+\b/gi) ?? [];
  return [...new Set(ids.map((s) => s.toUpperCase()))];
}

/** @param {string | undefined} v */
const yes = (v) => /^\**[ \t]*yes\b/i.test(v ?? "");

/**
 * The first word of a value, lower-cased, without quotes, backticks, asterisks, underscores or trailing punctuation
 * ("Bugfix: x" gives "bugfix"); "" when none.
 * @param {string | undefined} v
 */
const word = (v) => ((v ?? "").replace(/[`'"*_]/g, "").trim().split(/\s+/)[0] ?? "").replace(/[.,;:!?]+$/, "").toLowerCase();

/**
 * @typedef {{
 *   slice: string | null,
 *   files: string[],
 *   depends: string[],
 *   path: 'light' | null,
 *   risky: boolean,
 *   checks: string[],
 *   focus: string | null,
 *   workflow: boolean,
 *   sources: string[],
 *   read: 'lookup' | 'extract' | 'judge' | null,
 *   kind: string | null,
 *   validate: boolean,
 *   skills: string[],
 *   skill: string | null,
 *   target: 'private' | 'public' | null,
 *   update: boolean,
 *   drafts: string[]
 * }} Header
 */

/**
 * Header lines of an implementer or reviewer brief: SLICE, FILES, DEPENDS, PATH, RISKY, CHECKS, FOCUS, the scripted
 * workflow's ORCHESTRATION: workflow marker, and the optional SOURCES (a list, read like FILES), READ (lookup, extract
 * or judge, else null), KIND (its first word, lower-cased), VALIDATE (true only for "gaps") and SKILLS (skillNames),
 * and a skill slice's SKILL (a valid new skill name, else null), TARGET (private or public, else null), UPDATE (yes) and
 * DRAFTS (valid skill names, deduplicated, at most 8). Missing lines give null, [] or false.
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
    sources: list(field(t, "SOURCES")),
    read: readMode(field(t, "READ")),
    kind: word(field(t, "KIND")) || null,
    validate: word(field(t, "VALIDATE")) === "gaps",
    skills: skillNames(field(t, "SKILLS")),
    skill: newSkillName(field(t, "SKILL")),
    target: targetOf(field(t, "TARGET")),
    update: yes(field(t, "UPDATE")),
    drafts: draftNames(field(t, "DRAFTS")),
  };
}

// The name of a skill a skill slice creates: lower-case words of letters and digits joined by single hyphens, at most 64
// characters (the skills repositories' folder rule).
const NEW_SKILL_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** A valid name for a new skill (NEW_SKILL_RE, at most 64 characters). @param {unknown} name @returns {name is string} */
export const isSkillName = (name) => typeof name === "string" && name.length <= 64 && NEW_SKILL_RE.test(name);

/** SKILL value: its first word without quotes, backticks or asterisks when it is a valid skill name, else null. @param {string | undefined} v */
function newSkillName(v) {
  const w = (v ?? "").replace(/[`'"*]/g, "").trim().split(/\s+/)[0] ?? "";
  return isSkillName(w) ? w : null;
}

/** TARGET value: private or public (its first word, any case), else null. @param {string | undefined} v @returns {'private' | 'public' | null} */
function targetOf(v) {
  const w = word(v);
  return TARGETS.has(w) ? /** @type {'private' | 'public'} */ (w) : null;
}

/** DRAFTS value: comma-separated names read like FILES, only valid skill names, deduplicated, at most 8. @param {string | undefined} v */
function draftNames(v) {
  return [...new Set(list(v).filter(isSkillName))].slice(0, MAX_SKILLS);
}

/** At most this many skill names come back from a SKILLS line. */
const MAX_SKILLS = 8;
// A skill name: letters, digits, dot, underscore, slash and hyphen, with optional `ns:` parts ("anthropic-skills:docx"),
// at most 100 characters. Anything else (a phrase, a sentence) is dropped, so a record never carries brief text.
const SKILL_RE = /^[A-Za-z0-9][\w./-]*(?::[A-Za-z0-9][\w./-]*)*$/;

/**
 * SKILLS value: comma-separated skill names read like FILES (trimmed, quotes and backticks removed, empty and "none"
 * dropped), entries that are not a skill name dropped, deduplicated keeping the first, at most 8.
 * @param {string | undefined} v @returns {string[]}
 */
function skillNames(v) {
  const names = list(v).filter((s) => s.length <= 100 && SKILL_RE.test(s));
  return [...new Set(names)].slice(0, MAX_SKILLS);
}

/**
 * A SKILLS-USED or SKILLS-SKIPPED value: read like SKILLS (skillNames) after trailing emphasis is removed and each
 * entry loses a trailing reason after a space ("frontend-design (did not fit)", "docx - not needed", "x: no PDF").
 * @param {string} v @returns {string[]}
 */
function replySkillNames(v) {
  const entries = v
    .replace(/[*_`]+$/, "")
    .split(",")
    .map((e) => e.trim().replace(/(?:\s+[(\u2013\u2014]|\s+-\s|:\s).*$/, "").replace(/:$/, ""));
  return skillNames(entries.join(","));
}

/** READ value: lookup, extract or judge (its first word, any case), else null. @param {string | undefined} v @returns {'lookup' | 'extract' | 'judge' | null} */
function readMode(v) {
  const w = word(v);
  return READ_MODES.has(w) ? /** @type {'lookup' | 'extract' | 'judge'} */ (w) : null;
}

/**
 * The http(s) URLs in a text: unique, in order of first appearance, at most 50. Trailing punctuation that ends a
 * sentence or wraps a link (`).,;:'"]>`) is stripped, except a ) or ] that closes one opened inside the URL.
 * @param {unknown} text @returns {string[]}
 */
export function briefUrls(text) {
  /** @type {string[]} */
  const out = [];
  for (const m of str(text).matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    let u = m[0];
    for (;;) {
      const last = u.slice(-1);
      if (!last || !").,;:'\"]>".includes(last)) break;
      if (last === ")" && u.split("(").length >= u.split(")").length) break;
      if (last === "]" && u.split("[").length >= u.split("]").length) break;
      u = u.slice(0, -1);
    }
    if (!/^https?:\/\/[^/?#]/i.test(u) || out.includes(u)) continue;
    out.push(u);
    if (out.length >= MAX_URLS) break;
  }
  return out;
}

/** The brief starts with PLAN REVIEW (journal.mjs: leading whitespace allowed, case-sensitive). @param {unknown} text */
export const isPlanReview = (text) => /^\s*PLAN REVIEW\b/.test(str(text));

/**
 * The slice a brief is about, as journal.mjs keys it: "plan" for a PLAN REVIEW brief, else its SLICE id, else null.
 * @param {unknown} text @returns {string | null}
 */
export const sliceOfBrief = (text) => (isPlanReview(text) ? "plan" : parseHeader(text).slice);

/**
 * @typedef {{
 *   slice: string, files: string[], depends: string[], goal: string | null, risky: boolean, checks: string[],
 *   kind: string | null, skill: string | null, target: 'private' | 'public' | null
 * }} PlannedSlice
 * @typedef {{ isPlanReview: boolean, replan: number | null, constraints: Record<string, string>, slices: PlannedSlice[] }} Plan
 */

/**
 * A PLAN REVIEW brief: REPLAN number, the CONSTRAINTS block (C<n>: text lines right after a CONSTRAINTS: line) and the
 * planned slices (each SLICE: line starts one; FILES, DEPENDS, GOAL, RISKY, CHECKS, KIND, SKILL and TARGET lines up to
 * the next SLICE: fill it; KIND, SKILL and TARGET read as in parseHeader). Text that is not a PLAN REVIEW brief gives an empty plan. A repeated SLICE id continues its first entry; the
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
    // Same as planOf in dashboard/register.tsx: a heading may precede SLICE, the id is sliceId (as in a header), an id
    // "plan" is not a slice, and text after the id ("SLICE: s1 - parser") is the goal.
    const s = l.match(/^[ \t>*_`#-]*SLICE:\**[ \t]*(.*)$/i);
    if (s && sliceWord(s[1])) {
      const id = sliceId(s[1]);
      const own = !!id && id.toLowerCase() !== "plan";
      cur = own ? (plan.slices.find((x) => x.slice === id) ?? null) : null;
      if (own && id && !cur) plan.slices.push((cur = { slice: id, files: [], depends: [], goal: null, risky: false, checks: [], kind: null, skill: null, target: null }));
      const rest = (s[1] ?? "").replace(/^[\s`'"*]*\S+/, "").replace(/^[\s*`_:|—–-]+/, "").trim();
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
    const kind = lineValue(l, "KIND");
    if (kind !== undefined) cur.kind = word(kind) || null;
    const skill = lineValue(l, "SKILL");
    if (skill !== undefined) cur.skill = newSkillName(skill);
    const target = lineValue(l, "TARGET");
    if (target !== undefined) cur.target = targetOf(target);
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
 * @typedef {{ confidence: number | null, text: string }} Gap
 * @typedef {{ locator: string, text: string }} Quote
 * @typedef {{ name: string, branch: string }} Draft
 * @typedef {{ status: 'pass' | 'fail' | null, open: string[], answers: Record<string, Answer>, gaps: Gap[], quotes: Quote[], draft: Draft | null, skillsUsed: string[], skillsSkipped: string[] }} Reply
 */

/**
 * A worker's reply: STATUS (parseStatus), OPEN items and one answer per checked constraint id.
 * OPEN: the first OPEN: line; its inline value is one item, and the list lines right below it (up to a blank line after
 * an item, or the next KEY: line) are one item each; "none", "-", "n/a", "nothing" and empty mean nothing open.
 * Answers: `C<n>: pass (cmd) <command> -> <result>`, `C<n>: pass (read) <file:line or URL>`, `C<n>: fail <reason>`;
 * "→" is read as "->" (detail keeps "->"). The first line for an id decides unless a later line for it says fail.
 * Gaps: `GAP: <0-100> <text>` (a trailing % allowed); a missing or out-of-range number gives confidence null and the
 * whole rest as text; a gap without text and the template `GAP: <0-100> ...` are dropped. Quotes:
 * `QUOTE: <locator> | <verbatim text>`, one pair of surrounding quotes stripped from the text; a line without the `|`,
 * the locator or the text is dropped. Draft: the first `DRAFT: <name> <branch>` line whose name is a valid skill name and
 * whose branch is a plain git branch name (draftOf), else null. Skills used and skipped: the first `SKILLS-USED:` and the
 * first `SKILLS-SKIPPED:` line, read as skill names (replySkillNames: at most 8, a trailing reason per entry dropped,
 * anything that is not a skill name dropped). Blockquoted GAP, QUOTE, DRAFT and SKILLS-* lines do not count.
 * @param {unknown} text @returns {Reply}
 */
export function parseReply(text) {
  const all = lines(str(text));
  /** @type {Reply} */
  const reply = { status: parseStatus(text), open: [], answers: {}, gaps: [], quotes: [], draft: null, skillsUsed: [], skillsSkipped: [] };

  const at = all.findIndex((l) => OPEN_RE.test(l));
  if (at !== -1) {
    /** @param {string} item */
    const add = (item) => {
      const v = item.trim();
      if (!nothingOpen(v)) reply.open.push(v);
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

  for (const l of all) {
    const g = GAP_RE.exec(l);
    const gap = g ? gapOf((g[1] ?? "").replace(/[*_`]+$/, "").trim()) : null;
    if (gap) reply.gaps.push(gap);
    const q = QUOTE_RE.exec(l);
    const quote = q ? quoteOf(q[1] ?? "") : null;
    if (quote) reply.quotes.push(quote);
    const d = reply.draft ? null : DRAFT_RE.exec(l);
    if (d) reply.draft = draftOf(d[1] ?? "");
  }
  const used = all.map((l) => SKILLS_USED_RE.exec(l)).find((m) => m);
  if (used) reply.skillsUsed = replySkillNames(used[1] ?? "");
  const skipped = all.map((l) => SKILLS_SKIPPED_RE.exec(l)).find((m) => m);
  if (skipped) reply.skillsSkipped = replySkillNames(skipped[1] ?? "");
  return reply;
}

/**
 * The value of a DRAFT line: `<name> <branch>`, backticks and emphasis around either word removed; null unless the name
 * is a valid skill name and the branch a plain branch name (letters, digits, `.`, `_`, `/`, `-`; no `..`, at most 200
 * characters) and nothing else follows.
 * @param {string} v @returns {Draft | null}
 */
function draftOf(v) {
  const parts = v.replace(/[`*_]+(?=\s|$)|(?<=^|\s)[`*_]+/g, "").trim().split(/\s+/);
  if (parts.length !== 2) return null;
  const [name, branch] = /** @type {[string, string]} */ (parts);
  const okBranch = branch.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) && !branch.includes("..") && !branch.endsWith("/") && !branch.endsWith(".lock");
  return isSkillName(name) && okBranch ? { name, branch } : null;
}

/** The value of a GAP line as a gap; null when it has no text or is the template. @param {string} v @returns {Gap | null} */
function gapOf(v) {
  if (!v || /^<\s*0\s*-\s*100\s*>/.test(v)) return null;
  const m = v.match(/^(\d+)[ \t]*%?(?:\s+|$)(.*)$/);
  const n = m ? Number(m[1]) : NaN;
  if (!m || !(n >= 0 && n <= 100)) return { confidence: null, text: v };
  const t = (m[2] ?? "").trim();
  return t ? { confidence: n, text: t } : null;
}

/** Surrounding quote pairs a QUOTE text may carry; one pair is stripped. */
const QUOTE_PAIRS = ['""', "''", "“”", "‘’", "``"];

/** The value of a QUOTE line as a quote; null when it lacks the `|`, the locator or the text. @param {string} v @returns {Quote | null} */
function quoteOf(v) {
  const at = v.indexOf("|");
  if (at === -1) return null;
  const locator = v.slice(0, at).trim().replace(/^`+|`+$/g, "").trim();
  let t = v.slice(at + 1).trim();
  if (t.length >= 2 && QUOTE_PAIRS.includes(`${t[0]}${t.slice(-1)}`)) t = t.slice(1, -1).trim();
  return locator && t ? { locator, text: t } : null;
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

/**
 * A model counts as opus when it is opus or a stronger tier: its name contains "opus", "fable" or "mythos" (any case).
 * The escalation rule asks for an opus review; one on a stronger model meets it too (1.2.0, when the Agent tool began to
 * accept `model: "fable"`). The name and the gate reason `opus_review_required` stay as they are.
 * @param {unknown} model
 */
export const isOpusModel = (model) => typeof model === "string" && /opus|fable|mythos/i.test(model);

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

/**
 * ORCH_GAP_MIN as an integer from 0 to 100, else the default (80). 0 makes every failed review count (0.3.0).
 * @param {Record<string, string | undefined>} [env] @returns {number}
 */
export function gapMinimum(env = {}) {
  const v = String(env.ORCH_GAP_MIN ?? "").trim();
  const n = /^\d+$/.test(v) ? Number(v) : NaN;
  return n >= 0 && n <= 100 ? n : GAP_MIN_DEFAULT;
}

/** ORCH_STALL_GATE: the stall gate is on unless the value is "off" (any case). @param {Record<string, string | undefined>} [env] */
export const stallGateOn = (env = {}) => String(env.ORCH_STALL_GATE ?? "").trim().toLowerCase() !== "off";

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
 *   plan?: { constraints: Record<string, string>, slices: PlannedSlice[] },
 *   sources?: string[], read?: 'lookup' | 'extract' | 'judge' | null, kind?: string | null, validate?: boolean, urls?: string[],
 *   skills?: string[], skill?: string, target?: 'private' | 'public', update?: true, drafts?: string[], reviews_needed?: 1 | 2
 * }} LaunchRecord
 * journal-launches.jsonl, one per Agent launch of an implementer, reviewer, researcher or integrator (PostToolUse).
 * `slice` is sliceOfBrief: "plan" for a PLAN REVIEW brief. `urls` is the deduplicated hosts of briefUrls of the prompt
 * (invalid URLs skipped); in `sources` an http(s) entry becomes its host, a path stays as it is. Older records carry only
 * session_id, agent_id, slice, role; records before 0.4.0 lack sources, read, kind, validate and urls; older ones lack
 * skills (the names from SKILLS, never other brief text). skill, target, update and drafts are there only when the brief
 * has a valid SKILL, a TARGET, UPDATE: yes or DRAFTS names, so a brief without those lines gives the record it gave before.
 *
 * @typedef {{ confidence: number | null, key: string }} GapKey
 * @typedef {{
 *   ts: string, session_id: string, agent_id: string | null, role: string, agent_type?: string, slice: string | null,
 *   status: 'pass' | 'fail' | null, answers: Record<string, Answer>, open: string[], run?: number | null,
 *   model?: string | null, checks?: string[], risky?: boolean,
 *   gaps?: GapKey[], quotes?: number, files_touched?: string[], draft?: Draft, skills_used?: string[], skills_skipped?: string[]
 * }} StopRecord
 * journal.jsonl, one per SubagentStop of a worker. `slice` comes from the launch record with the same agent_id (or the
 * pending path when the stop arrives first). Older records lack answers, open and run; records before 0.4.0 lack gaps
 * and quotes. `gaps` holds each GAP's confidence and gapKey, `quotes` the number of QUOTE lines: never their text.
 * `files_touched` is there only when the caller passed `filesTouched` as an array of strings. `draft` (name and branch of
 * a DRAFT line) is there only when the reply has a valid one, so a reply without it gives the record it gave before.
 * `skills_used` and `skills_skipped` (the skill names of the SKILLS-USED and SKILLS-SKIPPED lines, at most 8 each) are
 * there only when non-empty, for the same reason.
 *
 * @typedef {{ ts: string, gate: string, decision: string, reason: string, agent_type?: string, agent_id?: string, session_id?: string }} GateRecord
 * gates.jsonl. A test-gate record (gate "test", from verify.sh) names no slice: it is joined by agent_id to a launch.
 */

/** @param {unknown} t */
const bare = (t) => String(t ?? "").split(":").pop() ?? "";

/**
 * The launch record for an Agent launch: the parsed brief, never its text.
 * @param {unknown} toolInput tool_input of the Agent call
 * @param {{ ts?: string, sessionId?: string, agentId?: string | null, projectDir?: string | null, pluginRoot?: string | null, env?: Record<string, string | undefined> }} [ctx]
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
  rec.sources = h.sources.map((s) => (/^https?:\/\//i.test(s) ? (hostOf(s) ?? "") : s)).filter(Boolean);
  rec.read = h.read;
  rec.kind = h.kind;
  rec.validate = h.validate;
  rec.urls = [...new Set(briefUrls(prompt).map(hostOf).filter((x) => x !== null))];
  rec.skills = h.skills;
  if (h.skill) rec.skill = h.skill;
  if (h.target) rec.target = h.target;
  if (h.update) rec.update = true;
  if (h.drafts.length) rec.drafts = h.drafts;
  // The second review rule (2.1.0, docs/limits.md J): a launch of this plugin's implementer records how many passing
  // reviews its slice needs, 2 for a RISKY brief and 1 otherwise. ORCH_SECOND_REVIEW=off (ctx.env) leaves the field
  // out, and so does every other role and a workflow brief: a record without it folds as before (1).
  if (OWN_IMPLEMENTER.test(str(ti.subagent_type)) && !h.workflow && secondReviewOn(ctx.env)) rec.reviews_needed = h.risky ? 2 : 1;
  return rec;
}

/** This plugin's implementer, bare or namespaced. */
const OWN_IMPLEMENTER = /^(?:orchestration:)?implementer$/;

/** ORCH_SECOND_REVIEW: the second review rule is on unless the value is "off" (any case). @param {Record<string, string | undefined>} [env] */
export const secondReviewOn = (env = {}) => String(env?.ORCH_SECOND_REVIEW ?? "").trim().toLowerCase() !== "off";

/** The host (with port) of a URL, or null when it does not parse; records keep hosts, never paths or queries. @param {string} u @returns {string | null} */
function hostOf(u) {
  try {
    return new URL(u).host || null;
  } catch {
    return null;
  }
}

/**
 * A short, stable key for a gap's text, so records can match the same gap across replies without storing it: the first
 * 8 hex characters of the sha1 of the text lower-cased, non-alphanumerics turned to spaces, collapsed, trimmed and cut
 * to 120 characters.
 * @param {unknown} text @returns {string}
 */
export function gapKey(text) {
  const norm = str(text).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().slice(0, 120);
  return createHash("sha1").update(norm).digest("hex").slice(0, 8);
}

/**
 * The stop record for a finished worker: STATUS, answers and OPEN from its final report, each GAP's confidence and key,
 * the QUOTE count, and files_touched when `filesTouched` is an array of strings.
 * @param {{ ts?: string, sessionId?: string, agentId?: string | null, role?: string, slice?: string | null, reply?: unknown, status?: 'pass' | 'fail' | null, run?: number | null, filesTouched?: unknown }} ctx
 * @returns {StopRecord}
 */
export function stopRecord(ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const r = parseReply(c.reply);
  /** @type {StopRecord} */
  const rec = {
    ts: c.ts ?? new Date().toISOString(),
    session_id: c.sessionId ?? "",
    agent_id: c.agentId ?? null,
    role: bare(c.role),
    slice: c.slice ?? null,
    status: c.status !== undefined ? c.status : r.status,
    answers: r.answers,
    open: r.open,
    run: c.run ?? null,
    gaps: r.gaps.map((g) => ({ confidence: g.confidence, key: gapKey(g.text) })),
    quotes: r.quotes.length,
  };
  const ft = c.filesTouched;
  if (Array.isArray(ft) && ft.every((f) => typeof f === "string")) rec.files_touched = [...ft];
  if (r.draft) rec.draft = { name: r.draft.name, branch: r.draft.branch };
  if (r.skillsUsed.length) rec.skills_used = [...r.skillsUsed];
  if (r.skillsSkipped.length) rec.skills_skipped = [...r.skillsSkipped];
  return rec;
}

/**
 * @typedef {{
 *   ts: number, status: 'pass' | 'fail' | null, answers: Record<string, Answer>, open: string[], model: string | null, checks: string[],
 *   counted: 'pass' | 'fail' | null, lowConfidence: boolean, superseded: boolean, validate: boolean, keys: string[],
 *   implAt: number | null, agent: string | null, began?: number, early?: boolean
 * }} Review
 * began: when the review began: the reviewer's latest SubagentStart (telemetry) at or before its stop, which is its resume
 * when the coordinator resumed it, else its launch record's time (no later than its stop). early: it began at or before
 * its attempt's boundary (the implementer's hand-back for that attempt when handbacks.jsonl holds one, else the
 * latest implementer launch or stop), so it looked at an older state; a slice that needs two reviews counts it neither
 * as a pass nor as a fail (countingReviews). A slice that needs one review never reads began or early.
 * agent: the reviewer's agent_id (null when the stop record has none). A stop record marked `continues` (journal.mjs: the
 * same turn going on after a stop hook, such as the stop after a forced hand-back) replaces the same agent's latest
 * review of the slice: one review. When an implementer launch or stop of the slice (or another review) came after that
 * review, it is replaced where it stands and keeps its ts and implAt (2.0.1): it stays a review of the attempt it read.
 * implAt: the slice's latest implementer launch or stop when the review arrived (its attempt): two reviews with
 * different implAt have an implementer attempt between them.
 * status: the reviewer's own STATUS. checks: the CHECKS ids of the reviewer's brief (its launch record), which its reply
 * must answer. counted: the status for slice finality and gating (docs/brief-grammar.md, "Review counting"): a fail whose
 * gaps are all below ORCH_GAP_MIN (and with no failed answer) counts as a pass and sets lowConfidence; a review
 * superseded by a later VALIDATE: gaps review of the same attempt counts as nothing (null, superseded). validate: its
 * launch record had VALIDATE: gaps. keys: for a counted fail, the gap keys at or above the cutoff (a null confidence is
 * 100); else [].
 * @typedef {{
 *   slice: string, planned: boolean, risky: boolean, checks: string[], files: string[],
 *   launches: number, attempts: number, lastImplAt: number | null, reviews: Review[],
 *   isolatedTestFailure: boolean, final: boolean, passed: boolean, gaveUp: boolean,
 *   attemptFrom: number, testGates: number[], reviewedSince: boolean,
 *   countedFails: number, stalled: boolean, stalledAt: number | null, stallKeys: string[], signals: string[],
 *   carriedFinal: boolean, testGaveUp: number[], testGateGaveUp: boolean, implementers: string[],
 *   secondField: boolean, reviewsNeeded: 1 | 2, handbackAt: number | null, secondReview: 'pass' | 'fail' | 'one' | null
 * }} SliceState
 * The second review rule (2.1.0; docs/limits.md, J). secondField: the slice's latest implementer launch record carries
 * reviews_needed. reviewsNeeded: 2 when it does and the slice is RISKY (that brief, or s.risky), else 1; with 1 the
 * slice folds exactly as before the rule. handbackAt: the time of the hand-back capture (handbacks.jsonl) of the
 * implementer's latest stop, null without one (then the boundary is lastImplAt). secondReview, for a slice that needs
 * 2, from countingReviews: 'fail' when any counts as a fail (in whatever order), 'pass' when none fails and two passes
 * come from two different reviewer agents, 'one' with passes from one agent only, null with none; passed, gaveUp,
 * final, the stall and the review gate all read it. null for a slice that needs 1.
 * implementers: agent ids of the slice's implementer launches and stops folded into this state, in order (a slice
 * carried whole into a new run keeps them; one that starts clean or is carried as final starts with none). The
 * plan check's reviewer hold reads it to look only at the implementers of the run a review lands in.
 * testGaveUp: times of the test gate's give-ups for the slice's implementers (max_blocks_reached of gate test,
 * bugfix_unverified_gave_up); testGateGaveUp: one belongs to the latest attempt (later than attemptFrom).
 * carriedFinal: the slice was final and passed in the run a plain PLAN REVIEW closed, and this plan names it again: it
 * counts as final (and passed) here until an implementer of it works in this run (a launch, or a stop: a resume) or a
 * review of it here counts as a fail.
 * launches: implementer launch records. attempts: implementer stops, a run of stops with no review between them
 * counting once (a test-gate block makes the agent stop again; a SendMessage resume adds a stop, not a launch).
 * lastImplAt: the latest implementer launch or stop. attemptFrom: the review time the latest attempt started after.
 * files: the slice's FILES in the plan (PLAN REVIEW and REPLAN entries, merged), [] when it was not planned.
 * countedFails: reviews whose counted status is fail. stalled: not final, its last two counted reviews are fails of
 * different implementer attempts that share a key (stallKeys) and no REPLAN plan review finished in the run after the second (stalledAt, its time); the
 * fold reports it whatever ORCH_STALL_GATE says, the gates read the switch. signals: doubtSignals with the fold's env.
 * @typedef {{
 *   id: number, kind: 'planned' | 'light', openedAt: number, lastAt: number, closed: boolean, stale: boolean,
 *   constraints: Record<string, string>, planned: string[], slices: Record<string, SliceState>,
 *   planReviewed: boolean, running: string[], replans: number[]
 * }} Run
 * planReviewed: a reviewer of this run's PLAN REVIEW (or REPLAN) brief has stopped. running: agent ids that started
 * (SubagentStart) in this run and have not stopped yet. replans: times the reviewers of this run's REPLAN plan reviews
 * stopped (a REPLAN still running is not in it).
 * @typedef {{ launches?: unknown[], stops?: unknown[], gates?: unknown[], starts?: unknown[], handbacks?: unknown[] | null }} Records
 * starts: telemetry.jsonl records; SubagentStart and SubagentStop entries (by agent_id) say which agents run.
 * handbacks: handbacks.jsonl captures (handback-check.mjs); they set an implementer attempt's boundary for the second
 * review rule. null: the log exists and could not be read, and then every slice needs one review (as before the rule),
 * so an unreadable log never makes a gate ask for more.
 */

// Test-gate records the fold reads (joined to a launch by agent_id): an isolated failure, and the test gate's give-ups
// (T-9, audit 2026-11-16), each a doubt signal for the slice's latest attempt.
const TEST_GATE_REASONS = new Set(["tests_failed_isolated", "max_blocks_reached", "bugfix_unverified_gave_up"]);
/** @param {unknown} ts */
const time = (ts) => (typeof ts === "number" ? ts : Date.parse(String(ts ?? "")) || 0);
/** @param {unknown} v @returns {any[]} */
const arr = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === "object") : []);
/** @param {unknown} v @returns {string[]} */
const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

/** @param {string} slice @param {boolean} planned @returns {SliceState} */
const newSlice = (slice, planned) => ({
  slice, planned, risky: false, checks: [], files: [], launches: 0, attempts: 0, lastImplAt: null, reviews: [],
  isolatedTestFailure: false, final: false, passed: false, gaveUp: false, attemptFrom: -Infinity, testGates: [], reviewedSince: false,
  countedFails: 0, stalled: false, stalledAt: null, stallKeys: [], signals: [], carriedFinal: false,
  testGaveUp: [], testGateGaveUp: false, implementers: [],
  secondField: false, reviewsNeeded: 1, handbackAt: null, secondReview: null,
});

/** Reviews after the slice's latest implementer launch or stop. @param {SliceState} s */
export const currentReviews = (s) => s.reviews.filter((r) => s.lastImplAt === null || r.ts > s.lastImplAt);

/** A review's counted status (its own status for a review object without `counted`). @param {Partial<Review>} r @returns {'pass' | 'fail' | null} */
export const countedStatus = (r) => (r.counted === undefined ? (r.status ?? null) : r.counted);

/**
 * The reviews that count for a slice that needs two (the second review rule): reviews of its latest attempt
 * (currentReviews) that are not superseded, have a counted status and began after the attempt's boundary (not early).
 * @param {SliceState} s
 */
export const countingReviews = (s) => currentReviews(s).filter((r) => !r.superseded && countedStatus(r) !== null && r.early !== true);

/**
 * The verdict of a slice that needs two reviews: 'fail' when any counting review is a fail, whatever the order; 'pass'
 * when none is and two passes come from two different reviewer agents (a resumed reviewer is one agent, a review with
 * no agent id counts as one unknown agent); 'one' with passes from one agent only; null with no counting review.
 * @param {SliceState} s @returns {'pass' | 'fail' | 'one' | null}
 */
export function secondReviewVerdict(s) {
  const counting = countingReviews(s);
  if (counting.some((r) => countedStatus(r) === "fail")) return "fail";
  const agents = new Set(counting.filter((r) => countedStatus(r) === "pass").map((r) => r.agent ?? ""));
  return agents.size >= 2 ? "pass" : agents.size === 1 ? "one" : null;
}

/** The reviews the opus rule and the doubt signals read: countingReviews for a slice that needs two, else currentReviews. @param {SliceState} s */
const reviewsRead = (s) => (s.reviewsNeeded === 2 ? countingReviews(s) : currentReviews(s));

/**
 * How a reviewer's stop counts (docs/brief-grammar.md, "Review counting"). A fail counts as a fail with a gap at or above
 * `gapMin` (a null confidence is 100), a failed answer, or no gap at all; otherwise it counts as a pass (lowConfidence).
 * @param {'pass' | 'fail' | null} status @param {unknown} gaps @param {Record<string, any>} answers @param {number} gapMin
 */
function countReview(status, gaps, answers, gapMin) {
  const all = arr(gaps);
  /** @param {any} g */
  const conf = (g) => (typeof g.confidence === "number" ? g.confidence : 100);
  const high = all.filter((g) => conf(g) >= gapMin);
  const failedAnswer = Object.values(answers).some((a) => a && a.verdict === "fail");
  const low = status === "fail" && all.length > 0 && high.length === 0 && !failedAnswer;
  /** @type {'pass' | 'fail' | null} */
  const counted = low ? "pass" : status;
  /** @type {string[]} */
  const keys = counted === "fail" ? [...new Set(high.map((g) => g.key).filter((k) => typeof k === "string" && k))] : [];
  return { counted, lowConfidence: low, keys };
}

/**
 * Slice finality during the fold (docs/brief-grammar.md, "Final slice"). Final: failed for good (the latest review
 * counts as a fail after 1 + MAX_RETRIES attempts), or the latest review counts as a pass and the escalation rule is
 * met: no doubt signal (doubtSignals with the fold's env: none when ORCH_ESCALATION is off, "always" when it is always)
 * or a passing opus review after the latest implementer launch or stop. So a counted pass that still needs its opus
 * review keeps the slice, and its run, open. passed stays the latest counted status alone (the gates read it), except
 * for a slice that needs two reviews (the second review rule), where secondReviewVerdict stands in for it: a lone pass
 * is no pass yet, and any counting fail is a fail.
 * @param {SliceState} s @param {Record<string, string | undefined>} env
 */
function settle(s, env) {
  // The second review rule: a RISKY slice whose latest implementer launch record carries reviews_needed needs two
  // passing reviews of its latest attempt; its counted status is secondReviewVerdict's (a lone pass is no pass yet).
  s.reviewsNeeded = s.secondField && s.risky ? 2 : 1;
  s.secondReview = s.reviewsNeeded === 2 ? secondReviewVerdict(s) : null;
  const latest = currentReviews(s).at(-1);
  const counted = s.reviewsNeeded === 2 ? (s.secondReview === "pass" || s.secondReview === "fail" ? s.secondReview : null) : latest ? countedStatus(latest) : null;
  s.isolatedTestFailure = s.testGates.some((t) => t > s.attemptFrom);
  s.testGateGaveUp = s.testGaveUp.some((t) => t > s.attemptFrom);
  s.passed = s.carriedFinal || counted === "pass";
  s.gaveUp = !s.carriedFinal && counted === "fail" && s.attempts >= 1 + MAX_RETRIES;
  s.final = s.carriedFinal || s.gaveUp || (s.passed && (hasOpusPass(s) || doubtSignals(s, env).length === 0));
}

/**
 * Folds one session's log records into runs (docs/brief-grammar.md, "Run model"). Records of other sessions are
 * dropped when `sessionId` is given. A gate record counts when its agent_id joins a launch and its session_id (when it
 * has one) is that launch's. A run opens at a PLAN REVIEW launch without REPLAN (closing any open run) or at a PATH: light implementer
 * launch with no run open; a PLAN REVIEW with REPLAN extends the open run (or opens one). A plain PLAN REVIEW that
 * closes an open run carries the slices its plan names again (spec, "Carried slices"). Launches outside any run are
 * not tracked. `now` decides staleness at the end; a launch or an agent start decides it on the way. With `starts`
 * (telemetry SubagentStart/SubagentStop records), an agent counts as running from its SubagentStart to its next
 * SubagentStop or journal stop with the same agent_id; a run with a running agent is never stale, and each start or
 * telemetry stop of its agents is activity. Without `starts` staleness depends on launches and stops alone.
 * A start or stop that never gets its pair keeps the run from going stale until a new PLAN REVIEW closes it or the
 * session ends: runs are per session. (A lost SubagentStop is the price of never letting a long foreground worker,
 * whose launch record is only written when it ends, make its run look idle.)
 * Reviews count by the gap cutoff (`gapMin`, else ORCH_GAP_MIN of `env`, else 80) and VALIDATE supersede; each slice
 * ends with countedFails, stalled and signals (doubtSignals with `env`).
 * @param {Records} records
 * @param {{ now?: number, staleMin?: number, sessionId?: string, gapMin?: number, env?: Record<string, string | undefined> }} [opts]
 * @returns {{ runs: Run[], open: Run | null }}
 */
export function foldRuns(records, opts = {}) {
  const rec = /** @type {Records} */ (records && typeof records === "object" ? records : {});
  const env = opts.env ?? {};
  const gapMin = typeof opts.gapMin === "number" && opts.gapMin >= 0 && opts.gapMin <= 100 ? opts.gapMin : gapMinimum(env);
  const staleMs = (opts.staleMin ?? RUN_STALE_MIN_DEFAULT) * 60000;
  const now = opts.now ?? Date.now();
  const sid = opts.sessionId;
  const mine = (/** @type {any} */ r) => sid === undefined || r.session_id === sid;
  const launches = arr(rec.launches).filter(mine);
  /** @type {Map<string, any>} */
  const byAgent = new Map();
  for (const l of launches) if (typeof l.agent_id === "string" && l.agent_id) byAgent.set(l.agent_id, l);
  const stops = arr(rec.stops).filter(mine);
  const starts = arr(rec.starts).filter(
    (r) => mine(r) && typeof r.agent_id === "string" && r.agent_id && (r.hook_event_name === "SubagentStart" || r.hook_event_name === "SubagentStop"),
  );
  // The second review rule's times: each agent's SubagentStart times (when a review began, a resume included) and each
  // agent's hand-back captures (an implementer attempt's boundary). An unreadable handbacks.jsonl (null) turns the rule
  // off for this fold: every slice then needs one review, as before.
  const handbacksRead = rec.handbacks !== null;
  /** @param {any[]} list @returns {Map<string, number[]>} */
  const timesByAgent = (list) => {
    /** @type {Map<string, number[]>} */
    const m = new Map();
    for (const r of list) {
      if (typeof r.agent_id !== "string" || !r.agent_id) continue;
      const t = time(r.ts);
      if (!t) continue;
      const l = m.get(r.agent_id) ?? [];
      l.push(t);
      m.set(r.agent_id, l);
    }
    return m;
  };
  const startTimes = timesByAgent(starts.filter((r) => r.hook_event_name === "SubagentStart"));
  const handbackTimes = timesByAgent(handbacksRead ? arr(rec.handbacks).filter(mine) : []);
  /** The latest time of `agent` in `m` at or before `at` and after `after`, or null. @param {Map<string, number[]>} m @param {unknown} agent @param {number} at @param {number} [after] */
  const latestOf = (m, agent, at, after = -Infinity) => {
    const l = typeof agent === "string" ? (m.get(agent) ?? []) : [];
    let best = null;
    for (const t of l) if (t <= at && t > after && (best === null || t > best)) best = t;
    return best;
  };
  const gates = arr(rec.gates).filter(
    (g) =>
      g.gate === "test" &&
      TEST_GATE_REASONS.has(g.reason) &&
      typeof g.agent_id === "string" &&
      byAgent.has(g.agent_id) &&
      (g.session_id === undefined || g.session_id === byAgent.get(g.agent_id)?.session_id),
  );
  // One timeline. A foreground agent's SubagentStop (and its test-gate record) is logged before its PostToolUse
  // launch record, so a stop or gate whose agent_id has a launch is placed at max(own ts, launch ts): never before its
  // launch. At equal times a launch comes first; stops and gates keep their own ts order (then stop before gate).
  /** @param {any} r */
  const effective = (r) => {
    const launch = typeof r.agent_id === "string" ? byAgent.get(r.agent_id) : undefined;
    return launch ? Math.max(time(r.ts), time(launch.ts)) : time(r.ts);
  };
  const events = [
    ...launches.map((r, i) => ({ kind: 0, i, r, own: time(r.ts), at: time(r.ts) })),
    ...stops.map((r, i) => ({ kind: 1, i, r, own: time(r.ts), at: effective(r) })),
    ...gates.map((r, i) => ({ kind: 2, i, r, own: time(r.ts), at: effective(r) })),
    // Telemetry starts and stops are logged when they happen (never ahead of time), so they keep their own ts.
    ...starts.map((r, i) => ({ kind: r.hook_event_name === "SubagentStart" ? 3 : 4, i, r, own: time(r.ts), at: time(r.ts) })),
  ].sort((a, b) => a.at - b.at || Number(a.kind !== 0) - Number(b.kind !== 0) || a.own - b.own || a.kind - b.kind || a.i - b.i);

  /** @type {Run[]} */
  const runs = [];
  /** @type {Run | null} the latest run; it is open while neither closed nor stale */
  let cur = null;
  /** @param {'planned' | 'light'} kind @param {number} ts @returns {Run} */
  const openRun = (kind, ts) => {
    /** @type {Run} */
    const run = { id: runs.length + 1, kind, openedAt: ts, lastAt: ts, closed: false, stale: false, constraints: {}, planned: [], slices: Object.create(null), planReviewed: false, running: [], replans: [] };
    runs.push(run);
    return run;
  };
  /** @param {Run} run */
  const closeIfDone = (run) => {
    const ids = run.kind === "planned" ? run.planned : Object.keys(run.slices);
    if (ids.length && ids.every((id) => run.slices[id]?.final)) run.closed = true;
  };
  /** @param {string} slice */
  const runWith = (slice) => (slice ? runs.findLast((r) => Object.hasOwn(r.slices, slice)) : undefined);
  /** Idle: nothing of the run is running and nothing happened in it for staleMs. @param {Run} run @param {number} ts */
  const idle = (run, ts) => run.running.length === 0 && ts - run.lastAt > staleMs;
  /** @type {Map<string, Run>} the run each PLAN REVIEW reviewer (by agent id) belongs to */
  const planRunOf = new Map();
  /** An agent stopped: it no longer keeps its run alive; the stop is activity in that run. @param {unknown} id @param {number} ts */
  const ended = (id, ts) => {
    if (typeof id !== "string" || !id) return;
    for (const run of runs) {
      if (!run.running.includes(id)) continue;
      run.running = run.running.filter((x) => x !== id);
      run.lastAt = Math.max(run.lastAt, ts);
    }
  };

  for (const { kind, r, at: ts } of events) {
    const role = bare(r.agent_type ?? r.role);
    if (kind === 3 || kind === 4) {
      if (kind === 4) {
        ended(r.agent_id, ts);
        continue;
      }
      // An agent started: it belongs to the open run (judged for staleness first, so a start after a long idle
      // spell does not revive a run). A resumed agent starts again under the same agent_id.
      if (cur && !cur.closed && !cur.stale && idle(cur, ts)) cur.stale = true;
      if (cur && !cur.closed && !cur.stale) {
        if (!cur.running.includes(r.agent_id)) cur.running.push(r.agent_id);
        cur.lastAt = Math.max(cur.lastAt, ts);
      }
      continue;
    }
    if (kind === 0) {
      // Staleness is judged at a launch: a stale run no longer counts as open, so a light launch opens a new run.
      if (cur && !cur.closed && idle(cur, ts)) cur.stale = true;
      /** @type {Run | null} */
      let open = cur && !cur.closed && !cur.stale ? cur : null;
      if (role === "reviewer" && (r.isPlanReview === true || r.slice === "plan")) {
        const replan = typeof r.replan === "number" ? r.replan : null;
        /** @type {Run | null} the open run this plain PLAN REVIEW closes */
        let closing = null;
        if (replan === null || !open) {
          if (open) open.closed = true;
          closing = open;
          open = cur = openRun("planned", ts);
        }
        open.kind = "planned";
        open.lastAt = ts;
        if (typeof r.agent_id === "string" && r.agent_id) planRunOf.set(r.agent_id, open);
        const plan = r.plan && typeof r.plan === "object" ? r.plan : {};
        if (plan.constraints && typeof plan.constraints === "object") Object.assign(open.constraints, plan.constraints);
        for (const p of arr(plan.slices)) {
          if (typeof p.slice !== "string" || !p.slice) continue;
          if (!open.planned.includes(p.slice)) open.planned.push(p.slice);
          // A slice of the closed run that this plan names again (docs/brief-grammar.md, "Run model"): an attempt with
          // no failed review after it moves here with its launches and reviews, so its later stops and reviews meet it;
          // one that was final and passed counts as final here until it is launched again; one whose latest review
          // failed (or that failed for good) starts clean.
          const old = closing && !Object.hasOwn(open.slices, p.slice) ? closing.slices[p.slice] : undefined;
          if (old && old.final && old.passed) {
            const kept = (open.slices[p.slice] = newSlice(p.slice, true));
            kept.carriedFinal = true;
            settle(kept, env);
          } else if (old && !old.final && old.lastImplAt !== null) {
            const latest = currentReviews(old).at(-1);
            const failed = old.reviewsNeeded === 2 ? old.secondReview === "fail" : latest !== undefined && countedStatus(latest) === "fail";
            if (!failed) {
              open.slices[p.slice] = old;
              delete closing?.slices[p.slice];
            }
          }
          const s = (open.slices[p.slice] ??= newSlice(p.slice, true));
          s.planned = true;
          s.risky = s.risky || p.risky === true;
          s.checks = [...new Set([...s.checks, ...strings(p.checks)])];
          s.files = [...new Set([...s.files, ...strings(p.files)])];
        }
        continue;
      }
      if (role === "implementer") {
        const slice = typeof r.slice === "string" && r.slice !== "plan" ? r.slice : null;
        if (r.workflow === true || !slice) continue;
        if (!open && r.path === "light") open = cur = openRun("light", ts);
        if (!open) continue;
        const s = (open.slices[slice] ??= newSlice(slice, false));
        s.carriedFinal = false;
        s.launches += 1;
        s.lastImplAt = ts;
        s.handbackAt = null;
        s.secondField = handbacksRead && (r.reviews_needed === 1 || r.reviews_needed === 2);
        if (typeof r.agent_id === "string" && r.agent_id && !s.implementers.includes(r.agent_id)) s.implementers.push(r.agent_id);
        s.risky = s.risky || r.risky === true;
        s.checks = [...new Set([...s.checks, ...strings(r.checks)])];
        open.lastAt = ts;
        settle(s, env);
        continue;
      }
      if (open) open.lastAt = Math.max(open.lastAt, ts);
      continue;
    }
    const launch = typeof r.agent_id === "string" ? byAgent.get(r.agent_id) : undefined;
    const slice = String((kind === 2 ? launch?.slice : (r.slice ?? launch?.slice)) ?? "");
    if (kind === 1) ended(r.agent_id, ts);
    const run = runWith(slice) ?? cur;
    if (!run) continue;
    if (kind === 1) run.lastAt = Math.max(run.lastAt, ts);
    if (kind === 1 && role === "reviewer" && slice === "plan") {
      const planRun = planRunOf.get(String(r.agent_id)) ?? run;
      planRun.planReviewed = true;
      // A REPLAN plan review finished: it clears stalls that began before this time (finish()).
      if (typeof launch?.replan === "number") planRun.replans.push(ts);
      continue;
    }
    const s = slice ? run.slices[slice] : undefined;
    if (!s) continue;
    if (kind === 2) {
      if (r.reason === "tests_failed_isolated") s.testGates.push(ts);
      else s.testGaveUp.push(ts);
    } else if (role === "implementer") {
      // Any implementer activity of the slice in this run (a stop: a SendMessage resume makes no launch) is new work:
      // a slice carried over as final is open again.
      s.carriedFinal = false;
      if (typeof r.agent_id === "string" && r.agent_id && !s.implementers.includes(r.agent_id)) s.implementers.push(r.agent_id);
      if (s.attempts === 0 || s.reviewedSince) {
        s.attempts += 1;
        s.attemptFrom = s.reviews.at(-1)?.ts ?? -Infinity;
        s.reviewedSince = false;
      }
      // The attempt's boundary for the second review rule: the hand-back this stop follows (the agent's latest capture
      // at or before the stop's own time, after its latest start and after the slice's previous implementer event),
      // since the report reaches the orchestrator at the hand-back, before this record is written.
      const own = time(r.ts);
      const started = latestOf(startTimes, r.agent_id, own) ?? -Infinity;
      const prevImpl = s.lastImplAt ?? -Infinity;
      const hb = latestOf(handbackTimes, r.agent_id, own, Math.max(prevImpl, started - 1));
      s.handbackAt = hb;
      s.lastImplAt = Math.max(s.lastImplAt ?? ts, ts);
    } else if (role === "reviewer") {
      const status = r.status === "pass" || r.status === "fail" ? r.status : null;
      const model = typeof r.model === "string" ? r.model : typeof launch?.model === "string" ? launch.model : null;
      const checks = strings(Array.isArray(r.checks) ? r.checks : launch?.checks);
      const answers = r.answers && typeof r.answers === "object" ? r.answers : {};
      const validate = launch?.validate === true;
      const agent = typeof r.agent_id === "string" && r.agent_id ? r.agent_id : null;
      // G-8: the stop after a forced hand-back is the same review as the stop before it: the later record replaces the
      // same agent's latest review. 2.0.1 (D4): also when an implementer of the slice launched or stopped between the two
      // stops, or another review came between; then the review is replaced where it stands, keeping its time and its
      // attempt (implAt), so it never becomes a review of the later attempt.
      const sameAt = r.continues === true && agent ? s.reviews.findLastIndex((v) => v.agent === agent) : -1;
      const same = sameAt >= 0 ? /** @type {Review} */ (s.reviews[sameAt]) : undefined;
      if (same && sameAt === s.reviews.length - 1 && (s.lastImplAt === null || same.ts > s.lastImplAt)) s.reviews.pop();
      else if (same) {
        const counting = countReview(status, r.gaps, answers, gapMin);
        /** @type {Review} */
        const kept = { ts: same.ts, status, answers, open: Array.isArray(r.open) ? r.open : [], model, checks, ...counting, superseded: same.superseded, validate, implAt: same.implAt, agent, began: same.began, early: same.early };
        if (kept.superseded) kept.counted = null;
        s.reviews[sameAt] = kept;
        if (validate && status !== null && !kept.superseded) {
          for (const other of s.reviews) {
            if (other === kept || other.implAt !== kept.implAt || other.ts > kept.ts) continue;
            other.superseded = true;
            other.counted = null;
          }
        }
        if (s.carriedFinal && countedStatus(kept) === "fail") s.carriedFinal = false;
        settle(s, env);
        closeIfDone(run);
        continue;
      }
      // VALIDATE: gaps: this review replaces the earlier reviews of the same attempt for pass/fail purposes, but only
      // with a verdict of its own: a validation reply with no STATUS supersedes nothing.
      if (validate && status !== null) {
        for (const prev of currentReviews(s)) {
          prev.superseded = true;
          prev.counted = null;
        }
      }
      // When the review began (the second review rule): the reviewer's latest SubagentStart at or before its stop (its
      // resume, when the coordinator resumed it), else its launch record's time, no later than the stop. Early: at or
      // before the attempt's boundary (its hand-back, else the latest implementer launch or stop).
      const own = time(r.ts);
      const launchedAt = launch ? Math.min(time(launch.ts), own) : own;
      const began = latestOf(startTimes, agent, own) ?? launchedAt;
      const boundary = s.handbackAt ?? s.lastImplAt;
      const early = boundary !== null && began <= boundary;
      s.reviews.push({ ts, status, answers, open: Array.isArray(r.open) ? r.open : [], model, checks, ...countReview(status, r.gaps, answers, gapMin), superseded: false, validate, implAt: s.lastImplAt, agent, began, early });
      s.reviewedSince = true;
      // A counted failing review of a slice carried over as final ends its carried state, as implementer work does
      // (spec, "Carried slices"); a pass, a fail that counts as a pass and a reply with no STATUS leave it final.
      if (s.carriedFinal && countedStatus(/** @type {Review} */ (s.reviews.at(-1))) === "fail") s.carriedFinal = false;
    }
    settle(s, env);
    closeIfDone(run);
  }
  if (cur && !cur.closed && idle(cur, now)) cur.stale = true;
  for (const run of runs) for (const s of Object.values(run.slices)) finish(run, s, env);
  return { runs, open: cur && !cur.closed && !cur.stale ? cur : null };
}

/**
 * The derived slice fields at the end of a fold: countedFails, the stall (docs/brief-grammar.md, "Stall") and the
 * doubt signals. @param {Run} run @param {SliceState} s @param {Record<string, string | undefined>} env
 */
function finish(run, s, env) {
  const counted = s.reviews.filter((r) => countedStatus(r) !== null);
  s.countedFails = counted.filter((r) => countedStatus(r) === "fail").length;
  s.stalled = false;
  s.stalledAt = null;
  s.stallKeys = [];
  // A retry that failed on the same gap again. b: the latest counted review; a: the latest counted review of an
  // earlier implementer attempt. Both fail and every counted review between them fails (no pass between); two reviews
  // of one attempt (a second opinion) never stall on their own.
  if (s.reviewsNeeded === 2) {
    // The second review rule: an attempt failed when any of its counted reviews that began after its boundary fails, in
    // whatever order. The latest attempt with such reviews and the one before it both failed and share a gap key (any
    // of their failing reviews): stalled. Two reviews of one attempt still never stall on their own.
    const late = counted.filter((r) => r.early !== true);
    /** @type {Map<number | null, Review[]>} */
    const byAttempt = new Map();
    for (const r of late) byAttempt.set(r.implAt, [...(byAttempt.get(r.implAt) ?? []), r]);
    const groups = [...byAttempt.values()];
    const fails = (/** @type {Review[] | undefined} */ g) => (g ?? []).filter((r) => countedStatus(r) === "fail");
    const fb = fails(groups.at(-1));
    const fa = fails(groups.at(-2));
    if (!s.final && fb.length && fa.length) {
      const keysA = new Set(fa.flatMap((r) => r.keys));
      const shared = [...new Set(fb.flatMap((r) => r.keys))].filter((k) => keysA.has(k));
      const at = Math.max(...fb.map((r) => r.ts));
      if (shared.length && !run.replans.some((t) => t > at)) {
        s.stalled = true;
        s.stalledAt = at;
        s.stallKeys = shared;
      }
    }
    s.signals = doubtSignals(s, env);
    return;
  }
  const b = counted.at(-1);
  const ai = b ? counted.findLastIndex((r) => r.implAt !== b.implAt) : -1;
  const a = ai >= 0 ? counted[ai] : undefined;
  const between = counted.slice(ai + 1);
  if (!s.final && a && b && countedStatus(a) === "fail" && between.every((r) => countedStatus(r) === "fail")) {
    const shared = b.keys.filter((k) => a.keys.includes(k));
    if (shared.length && !run.replans.some((t) => t > b.ts)) {
      s.stalled = true;
      s.stalledAt = b.ts;
      s.stallKeys = shared;
    }
  }
  s.signals = doubtSignals(s, env);
}

/**
 * Doubt signals for a slice: why it needs a passing opus review after its latest implementer. Empty when ORCH_ESCALATION
 * is off; ["always"] when it is always. Signals: risky, retry (an earlier counted failed review), read_answer and
 * open_items (in its latest counted passing review), tests_failed_isolated and test_gate_gave_up (for its latest
 * implementer attempt),
 * low_confidence_fail (a review after its latest implementer reported fail with every gap below the cutoff).
 * @param {SliceState} s @param {Record<string, string | undefined>} [env] @returns {string[]}
 */
export function doubtSignals(s, env = {}) {
  const mode = escalationMode(env);
  if (mode === "off") return [];
  if (mode === "always") return ["always"];
  const signals = [];
  if (s.risky) signals.push("risky");
  if (s.reviews.some((r) => countedStatus(r) === "fail")) signals.push("retry");
  // A slice that needs two reviews reads every pass that counts toward the two; any other its latest counted pass.
  const current = reviewsRead(s);
  const passes = current.filter((r) => countedStatus(r) === "pass");
  const read = s.reviewsNeeded === 2 ? passes : passes.slice(-1);
  if (read.some((p) => Object.values(p.answers).some((a) => a?.mode === "read"))) signals.push("read_answer");
  if (read.some((p) => p.open.length)) signals.push("open_items");
  if (s.isolatedTestFailure) signals.push("tests_failed_isolated");
  if (s.testGateGaveUp) signals.push("test_gate_gave_up");
  if (current.some((r) => r.lowConfidence === true && countedStatus(r) === "pass")) signals.push("low_confidence_fail");
  return signals;
}

/**
 * A review counted as a pass on an opus model after the slice's latest implementer (for a slice that needs two, among
 * the reviews that count toward the two). @param {SliceState} s
 */
export const hasOpusPass = (s) => reviewsRead(s).some((r) => countedStatus(r) === "pass" && isOpusModel(r.model));
