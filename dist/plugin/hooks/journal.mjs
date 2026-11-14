#!/usr/bin/env node
// Run journal (records spec: docs/brief-grammar.md, "Log records"). Two logs in the state dir, parsed fields only, never
// the brief or reply text:
//   PostToolUse on Agent|Task -> journal-launches.jsonl: a launch record (brief.mjs launchRecord) for every launch of an
//     implementer, reviewer, researcher or integrator: agent_id (from the tool response, else null), bare agent_type,
//     slice (a brief starting with PLAN REVIEW is slice "plan"), the parsed header, the reviewer model, isPlanReview,
//     replan and, for PLAN REVIEW briefs, the parsed plan.
//   SubagentStop of an implementer or reviewer -> journal.jsonl: a stop record (brief.mjs stopRecord): slice, status
//     (parseStatus: any STATUS: fail line fails, else the first STATUS line decides, blockquotes ignored), answers,
//     open and run (the run foldRuns gives the slice at write time), and draft ({ name, branch } of a skill slice's
//     DRAFT: <name> <branch> line; left out when the reply has none), skills_used and skills_skipped (the skill names
//     of the SKILLS-USED and SKILLS-SKIPPED lines, at most 8 each; each left out when empty, so a reply without them
//     gives the record it gave before); for implementers also files_touched and
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
// Exits 0 on malformed input.
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { launchRecord, parseStatus, sliceOfBrief, stopRecord } from "./brief.mjs";
import { readJsonl, sessionRuns } from "./run.mjs";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

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
  const rec = launchRecord(p.tool_input, { sessionId, agentId, projectDir: process.env.CLAUDE_PROJECT_DIR || p.cwd || null, pluginRoot: process.env.CLAUDE_PLUGIN_ROOT || null });
  append("journal-launches.jsonl", rec);
  if (agentId && rec.slice && STOP_ROLES.includes(role)) {
    const waiting = readJsonl(stateDir, "journal-pending.jsonl").filter((e) => e.agent_id === agentId).pop();
    if (waiting) append("journal.jsonl", { ...waiting, session_id: sessionId, role, slice: rec.slice, run: runOf(rec.slice) });
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

if (p.hook_event_name !== "SubagentStop" || !STOP_ROLES.includes(bare(p.agent_type))) process.exit(0);
const role = bare(p.agent_type);
const agentId = typeof p.agent_id === "string" && p.agent_id ? p.agent_id : null;

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

// The report: the last message when it has a STATUS line, else the latest transcript message that has one, else the
// last message (no status; its answers and OPEN still count).
const last = typeof p.last_assistant_message === "string" ? p.last_assistant_message : "";
let report = parseStatus(last) !== null ? last : undefined;
for (let i = entries.length - 1; report === undefined && i >= 0; i--) {
  if (entries[i].type !== "assistant") continue;
  const text = textOf(entries[i].message?.content);
  if (parseStatus(text) !== null) report = text;
}

const touched = role === "implementer" ? filesTouched(transcriptRead ? entries : null, p.cwd) : null;
const rec = stopRecord({ sessionId, agentId, role, slice, reply: report ?? last, run: slice ? runOf(slice) : null, filesTouched: touched?.files });
append(slice ? "journal.jsonl" : "journal-pending.jsonl", touched && rec.files_touched ? { ...rec, files_source: touched.source } : rec);
process.exit(0);
