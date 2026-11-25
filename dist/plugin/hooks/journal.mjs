#!/usr/bin/env node
// Run journal (records spec: docs/brief-grammar.md, "Log records"). Two logs in the state dir, parsed fields only, never
// the brief or reply text:
//   PostToolUse on Agent|Task -> journal-launches.jsonl: a launch record (brief.mjs launchRecord) for every launch of an
//     implementer, reviewer, researcher or integrator: agent_id (from the tool response, else null), bare agent_type,
//     slice (a brief starting with PLAN REVIEW is slice "plan"), the parsed header, the reviewer model, isPlanReview,
//     replan and, for PLAN REVIEW briefs, the parsed plan; for this plugin's implementer also reviews_needed (2 for a
//     RISKY brief, else 1; left out with the maintainer switch ORCH_SECOND_REVIEW=off, read from this hook's environment).
//   SubagentStop of an implementer or reviewer -> journal.jsonl: a stop record (brief.mjs stopRecord): slice, status
//     (parseStatus: any STATUS: fail line fails, else the first STATUS line decides, blockquotes ignored), answers,
//     open and run (the run foldRuns gives the slice at write time), and draft ({ name, branch } of a skill slice's
//     DRAFT: <name> <branch> line; left out when the reply has none), skills_used and skills_skipped (the skill names
//     of the SKILLS-USED and SKILLS-SKIPPED lines, at most 8 each; each left out when empty, so a reply without them
//     gives the record it gave before); for reviewers also kind ("plan", "validate" or "review") and model (brief.mjs
//     reviewFields, from the launch record; each left out when unknown); for implementers also files_touched and
//     files_source (filesTouched below: "tools" in the shared tree, "tools+git" in an isolated worktree, "git" there
//     without a transcript), left out when unknown or on
//     any error.
// An orchestrator asked to resume reads journal.jsonl and skips slices whose last review passed; plan-check.mjs and
// review-gate.mjs fold both logs into runs (run.mjs).
// Headless runs pass --no-session-persistence, so there is no subagent transcript to read the brief from: the slice is
// taken from the launch record with the same agent_id. A background agent's PostToolUse comes first; a foreground
// agent stops before its PostToolUse (verified on Claude Code 2.1.314: its SubagentStop is logged before its
// PostToolUse), so an unmatched stop waits in journal-pending.jsonl, with its status, answers and open, and is written
// when its launch arrives. With a transcript (interactive sessions) the brief is read from it as before.
// The reply: in auto mode a worker hands its report back through SubagentHandback, and the stop then carries no
// last_assistant_message while the transcript does not hold that report yet; the stop record then takes the report's
// parsed fields from the capture handback-check.mjs wrote at the hand-back (state.mjs handbackFor), else, with no
// capture newer than this agent's previous stop record, from last_assistant_message and the transcript as before.
// Exits 0 on malformed input.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { launchRecord, parseStatus, reviewFields, sliceOfBrief, stopRecord } from "./brief.mjs";
import { readJsonl, sessionRuns } from "./run.mjs";
import { duplicate, ensureStateDir, HANDBACK_LOG, HANDBACK_REFUSALS, latestHandbackId, stateDir } from "./state.mjs";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
if (duplicate("journal.mjs")) process.exit(0); // the project's own copy records this event
let p;
try {
  p = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  process.exit(0);
}
if (!p || typeof p !== "object") process.exit(0);

const LAUNCH_ROLES = ["implementer", "reviewer", "researcher", "integrator"];
const STOP_ROLES = ["implementer", "reviewer"];
const sessionId = typeof p.session_id === "string" ? p.session_id : "";
/** @param {unknown} t */
const bare = (t) => /** @type {string} */ (String(t ?? "").split(":").pop()); // split always yields one element
/** @param {string} name @param {Record<string, unknown>} record */
const append = (name, record) => {
  try {
    ensureStateDir();
    appendFileSync(join(stateDir, name), `${JSON.stringify(record)}\n`);
  } catch {
    // the journal must never fail the agent
  }
};
/** Text of a transcript message: its text blocks and a SubagentHandback message. @param {any} content */
const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((b) => (b?.type === "text" && typeof b.text === "string" ? b.text : b?.type === "tool_use" && b.name === "SubagentHandback" && typeof b.input?.message === "string" ? b.input.message : ""))
          .filter(Boolean)
          .join("\n")
      : "";
// A foreground result may carry the agent id only in its text ("agentId: a1b2...").
/** @param {any} r @returns {string | null} */
const agentIdOf = (r) =>
  (r && typeof r === "object" && typeof r.agentId === "string" && r.agentId) || JSON.stringify(r ?? "").match(/agentId["\\: ]+([A-Za-z0-9_-]{6,})/)?.[1] || null;
/** The run foldRuns gives a slice now: the latest run with the slice, else the open run. @param {string} slice */
const runOf = (slice) => {
  try {
    const { runs, open } = sessionRuns(sessionId);
    return runs.findLast((r) => slice in r.slices)?.id ?? open?.id ?? null;
  } catch {
    return null;
  }
};

if (p.hook_event_name === "PostToolUse") {
  const role = bare(p.tool_input?.subagent_type);
  if (!LAUNCH_ROLES.includes(role)) process.exit(0);
  const agentId = agentIdOf(p.tool_response);
  const rec = launchRecord(p.tool_input, { sessionId, agentId, projectDir: process.env.CLAUDE_PROJECT_DIR || p.cwd || null, pluginRoot: process.env.CLAUDE_PLUGIN_ROOT || null, env: process.env });
  append("journal-launches.jsonl", rec);
  if (agentId && rec.slice && STOP_ROLES.includes(role)) {
    const waiting = readJsonl(stateDir, "journal-pending.jsonl").filter((e) => e.agent_id === agentId).pop();
    if (waiting) append("journal.jsonl", { ...waiting, session_id: sessionId, role, slice: rec.slice, run: runOf(rec.slice), ...(role === "reviewer" ? reviewFields(rec) : {}) });
  }
  process.exit(0);
}

/**
 * Files an implementer touched, relative to the project root: the paths of Edit, Write and NotebookEdit calls whose
 * tool_result is not an error, plus, in an isolated worktree (cwd under .claude/worktrees/<name>), what git shows
 * changed there since the fork point from the main worktree's HEAD (committed, uncommitted and untracked). In the
 * shared tree only the tool calls count: git status there mixes slices. With no readable transcript the tool paths are
 * unknown: a worktree reports git alone (source "git"), the shared tree returns null. Any error returns null (fields
 * left out), so an empty list always means "touched nothing", never "could not tell".
 * @param {any[] | null} entries transcript entries, null when the transcript could not be read
 * @param {unknown} hookCwd the payload's cwd, used when no transcript entry carries one
 * @returns {{ files: string[], source: "tools" | "tools+git" | "git" } | null}
 */
function filesTouched(entries, hookCwd) {
  try {
    /** @type {Map<string, string>} */
    const calls = new Map(); // tool_use id -> file path
    /** @type {Set<string>} */
    const ok = new Set();
    let cwd = typeof hookCwd === "string" ? hookCwd : "";
    for (const e of entries ?? []) {
      if (typeof e?.cwd === "string" && e.cwd) cwd = e.cwd;
      const content = e?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (e.type === "assistant" && b?.type === "tool_use" && ["Edit", "Write", "NotebookEdit"].includes(b.name)) {
          const f = b.input?.file_path ?? b.input?.notebook_path;
          if (typeof f === "string" && f && typeof b.id === "string") calls.set(b.id, f);
        }
        if (e.type === "user" && b?.type === "tool_result" && b.is_error !== true && typeof b.tool_use_id === "string") ok.add(b.tool_use_id);
      }
    }
    const wt = cwd.match(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+/);
    const projectRoot = wt ? /** @type {string} */ (wt[1]) : process.env.CLAUDE_PROJECT_DIR || cwd;
    /** @param {string} f */
    const rel = (f) => {
      const abs = isAbsolute(f) ? f : resolve(cwd || projectRoot, f);
      for (const base of [wt?.[0], projectRoot]) {
        if (!base) continue;
        const r = relative(base, abs);
        if (r && !r.startsWith("..") && !isAbsolute(r)) return r.split(sep).join("/");
      }
      return f;
    };
    /** @type {Set<string>} */
    const files = new Set();
    for (const [id, f] of calls) if (ok.has(id)) files.add(rel(f));
    if (!wt) return entries ? { files: [...files], source: "tools" } : null;
    /** @param {string} dir @param {string[]} args */
    const git = (dir, args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const tree = /** @type {string} */ (wt[0]);
    const base = git(tree, ["merge-base", "HEAD", git(projectRoot, ["rev-parse", "HEAD"])]);
    const changed = [...git(tree, ["diff", "--name-only", base]).split("\n"), ...git(tree, ["ls-files", "--others", "--exclude-standard"]).split("\n")];
    for (const f of changed) if (f) files.add(f);
    return { files: [...files].sort(), source: entries ? "tools+git" : "git" };
  } catch {
    return null;
  }
}

/**
 * The agent's hand-backs since its previous stop record here (journal.jsonl or journal-pending.jsonl): the latest
 * capture (handbacks.jsonl), unless a refusal (handback-refusals.jsonl) marks it, and then the refusing gate.
 * A refusal marks: the capture with its tool_use_id; without one, the capture with its report_key nearest in time
 * (written before or after the refusal: the quote check and handback-check.mjs run side by side, w6 item 3); a record
 * with neither marks the latest capture written before it (state.mjs handbackFor's rule).
 * @param {string} sid @param {string | null} id
 * @returns {{ capture: Record<string, any> | null, refusedBy: string | null }}
 */
function handbackState(sid, id) {
  if (!id) return { capture: null, refusedBy: null };
  /** @param {string} name */
  const mine = (name) => readJsonl(stateDir, name, sid).filter((r) => r && r.agent_id === id && (r.session_id ?? "") === sid);
  const t = (/** @type {any} */ r) => Date.parse(r?.ts);
  const captures = mine(HANDBACK_LOG).filter((c) => Number.isFinite(t(c)));
  const refusals = mine(HANDBACK_REFUSALS).filter((r) => Number.isFinite(t(r)));
  /** @type {Map<any, string>} */
  const refused = new Map();
  for (const r of refusals) {
    const gate = typeof r.gate === "string" && r.gate ? r.gate : "check";
    /** @type {any} */
    let hit;
    if (typeof r.tool_use_id === "string" && r.tool_use_id) {
      for (const c of captures) if (c.tool_use_id === r.tool_use_id) refused.set(c, gate);
      continue;
    }
    if (typeof r.report_key === "string" && r.report_key) {
      hit = captures.filter((c) => c.report_key === r.report_key).sort((a, b) => Math.abs(t(a) - t(r)) - Math.abs(t(b) - t(r)) || t(b) - t(a))[0];
    } else hit = captures.filter((c) => t(c) <= t(r)).at(-1);
    if (hit) refused.set(hit, gate);
  }
  const stops = [...mine("journal.jsonl"), ...mine("journal-pending.jsonl")].map(t).filter(Number.isFinite);
  const since = stops.length ? Math.max(...stops) : -Infinity;
  const latest = captures.filter((c) => t(c) > since).at(-1);
  if (!latest) return { capture: null, refusedBy: null };
  const by = refused.get(latest);
  return by ? { capture: null, refusedBy: by } : { capture: latest, refusedBy: null };
}

if (p.hook_event_name !== "SubagentStop" || !STOP_ROLES.includes(bare(p.agent_type))) process.exit(0);
const role = bare(p.agent_type);
const agentId = typeof p.agent_id === "string" && p.agent_id ? p.agent_id : null;
// The hand-back this stop follows (state.mjs latestHandbackId), as verify.sh and telemetry.mjs read it at this stop.
const afterHandback = latestHandbackId(p.session_id, agentId);

/** @type {any[]} */
let entries = [];
let transcriptRead = false;
try {
  entries = readFileSync(p.agent_transcript_path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  transcriptRead = true;
} catch {
  // no transcript (headless): the slice comes from the launch record
}
const launch = agentId ? readJsonl(stateDir, "journal-launches.jsonl").filter((e) => e.agent_id === agentId).pop() : undefined;
const slice = (typeof launch?.slice === "string" && launch.slice) || sliceOfBrief(textOf(entries.find((e) => e.type === "user")?.message?.content)) || null;

// This agent's earlier stop records (journal.jsonl and journal-pending.jsonl) and its latest SubagentStart (telemetry):
// a woken or resumed agent stops again under the same id (2.0.1, soak findings S2 to S4).
/** @type {number[]} */
let earlierStops = [];
let latestStart = -Infinity;
if (agentId) {
  try {
    earlierStops = [...readJsonl(stateDir, "journal.jsonl", sessionId), ...readJsonl(stateDir, "journal-pending.jsonl", sessionId)]
      .filter((r) => r.agent_id === agentId && (r.session_id ?? "") === sessionId)
      .map((r) => Date.parse(r.ts))
      .filter(Number.isFinite);
  } catch {
    // none readable: a stop of its own
  }
  try {
    for (const e of readJsonl(stateDir, "telemetry.jsonl", sessionId)) {
      if (e.agent_id === agentId && e.hook_event_name === "SubagentStart" && (e.session_id ?? "") === sessionId) latestStart = Math.max(latestStart, Date.parse(e.ts) || -Infinity);
    }
  } catch {
    // no start known
  }
}
const prevStop = earlierStops.length ? Math.max(...earlierStops) : null;
/** A transcript entry's own time (Claude Code writes `timestamp` on each), or NaN. @param {any} e */
const entryTime = (e) => Date.parse(typeof e?.timestamp === "string" ? e.timestamp : "");
// The coordinator's SendMessage as a resumed subagent's transcript holds it (egress-guard.mjs laterUserTexts reads the
// same shape): a user record with isMeta true and origin.kind "coordinator", not a compaction summary. The latest one
// written after the agent's previous stop record marks a resume: what follows it is the new turn's report.
const resumeAt =
  prevStop === null
    ? -1
    : entries.findLastIndex((e) => e?.type === "user" && e.isMeta === true && e.origin?.kind === "coordinator" && e.isCompactSummary !== true && entryTime(e) > prevStop);
/** The turn this stop ends: after the resume message when there is one, else the whole transcript. */
const turn = resumeAt >= 0 ? entries.slice(resumeAt + 1) : entries;

// The report: the last message when it has a STATUS line, else the latest transcript message of this turn that has one,
// else the last message (no status; its answers and OPEN still count). After a resume an older report in the transcript
// is not this turn's.
const last = typeof p.last_assistant_message === "string" ? p.last_assistant_message : "";
let report = parseStatus(last) !== null ? last : undefined;
for (let i = turn.length - 1; report === undefined && i >= 0; i--) {
  if (turn[i].type !== "assistant") continue;
  const text = textOf(turn[i].message?.content);
  if (parseStatus(text) !== null) report = text;
}

// A report delivered through SubagentHandback is in neither: the stop payload has no last_assistant_message and the
// transcript does not hold it yet. handback-check.mjs captured its parsed fields at the hand-back (state.mjs
// handbackFor: the latest capture of this agent newer than its previous stop record here), and that capture wins.
/** @type {Record<string, any> | null} */
let handback = null;
/** @type {string | null} */
let refusedBy = null;
try {
  ({ capture: handback, refusedBy } = handbackState(sessionId, agentId));
} catch {
  // no capture: today's sources
}
// The latest hand-back since the agent's previous stop was refused and nothing was handed back after it (2.0.0, w6
// item 2). Unless the stop's own last message carries a STATUS line (a text report after the refusal), no report was
// delivered: the record says so (status null, report "handback_refused", refused_by the check) and takes nothing from
// the refused report, the transcript (which holds that refused hand-back) or an older report.
const undelivered = !handback && refusedBy !== null && parseStatus(last) === null;
// A worker woken after its report was delivered (2.0.1, H6: a shell task Claude Code moved to the background ends, or a
// prompt reaches the finished agent) writes a text turn and stops again: stop_hook_active false, no hand-back since its
// previous stop record and no STATUS line in its last message. That stop holds no new report, so it gets no stop record:
// from the transcript it would copy the delivered report as a second review (of a later attempt, when the slice's
// implementer stopped meanwhile), and without one it would be a review with no status. For an implementer (soak S2) it
// would count as a new attempt and leave the delivered review behind. A stop of the same shape is a new report, and is
// recorded as before, when the agent was resumed: the transcript holds the coordinator's message after its previous
// stop (soak S3: the new report's STATUS line may be only in the transcript, or missing). An implementer's stop is
// recorded too when it did anything but write text since its previous stop (a tool call: it may have changed files), or
// when its transcript cannot be read (headless runs: whether it worked is unknown, so it counts, as before).
if (agentId && prevStop !== null && p.stop_hook_active !== true && !handback && refusedBy === null && parseStatus(last) === null && resumeAt < 0) {
  const worked = () =>
    !transcriptRead ||
    entries.some((e) => {
      const t = entryTime(e);
      return e?.type === "assistant" && (!Number.isFinite(t) || t > prevStop) && Array.isArray(e.message?.content) && e.message.content.some((/** @type {any} */ b) => b?.type === "tool_use");
    });
  if (role === "reviewer" || (role === "implementer" && !worked())) process.exit(0);
}
const touched = role === "implementer" ? filesTouched(transcriptRead ? entries : null, p.cwd) : null;
let rec = stopRecord({ sessionId, agentId, role, slice, reply: handback || undelivered ? "" : (report ?? last), run: slice ? runOf(slice) : null, filesTouched: touched?.files });
if (undelivered) rec = /** @type {typeof rec} */ ({ ...rec, status: null, report: "handback_refused", refused_by: refusedBy });
if (handback) {
  /** @type {Record<string, any>} */
  const fields = { status: handback.status === "pass" || handback.status === "fail" ? handback.status : null };
  for (const k of ["answers", "open", "gaps", "quotes", "draft", "skills_used", "skills_skipped"]) if (k in handback) fields[k] = handback[k];
  rec = /** @type {typeof rec} */ ({ ...rec, ...fields });
}
// A reviewer's kind (plan, validate or review) and model (2.1.x, added fields; no gate reads them): from its launch
// record in this session (the one the fold reads, so the fold's model is the same), else kind from the brief in the
// transcript; each left out when unknown.
if (role === "reviewer") {
  try {
    const own = launch && (launch.session_id ?? "") === sessionId ? launch : undefined;
    rec = /** @type {typeof rec} */ ({ ...rec, ...reviewFields(own, own ? undefined : textOf(entries.find((e) => e.type === "user")?.message?.content)) });
  } catch {
    // fields left out
  }
}
// The same turn going on after a stop hook (stop_hook_active true: the stop after a forced hand-back, or after a test-gate
// block) with an earlier stop record of this agent: `continues: true` (G-8, audit 2026-11-16). The fold lets a reviewer's
// continued stop replace its previous review instead of adding one; a SendMessage resume (stop_hook_active false) is a
// new review. Only set when it applies, so other stops keep the record they had.
// The earlier record must be one of this run of the agent (since its latest SubagentStart, 2.0.1 soak S4): after a
// SendMessage resume the agent starts again, and a resumed reviewer whose text turn was held back (its stop got no
// record above, or no transcript showed the resume) hands back and stops with stop_hook_active true: that is its new
// review, not the earlier one going on.
if (p.stop_hook_active === true && agentId) {
  try {
    const log = slice ? "journal.jsonl" : "journal-pending.jsonl";
    if (readJsonl(stateDir, log, sessionId).some((r) => r.session_id === sessionId && r.agent_id === agentId && !(Date.parse(r.ts) < latestStart))) rec = /** @type {typeof rec} */ ({ ...rec, continues: true });
  } catch {
    // no earlier record readable: a stop of its own
  }
}
if (afterHandback) rec = /** @type {typeof rec} */ ({ ...rec, after_handback: afterHandback });
append(slice ? "journal.jsonl" : "journal-pending.jsonl", touched && rec.files_touched ? { ...rec, files_source: touched.source } : rec);
process.exit(0);
