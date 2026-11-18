#!/usr/bin/env node
// PreToolUse gate on Agent: checks each launch against the current run (brief.mjs foldRuns via run.mjs; spec:
// docs/brief-grammar.md), in code, before the agent starts. Implementer briefs carry three lines (parsed by brief.mjs):
//   SLICE: <id>    FILES: <owned files, comma-separated>    DEPENDS: <slice ids, or none>
// Every check is scoped to a run, not to the session: the open run (not closed, not stale), or, with no run open,
// the launches since the last run (a PATH: light launch with no run open opens the next run and sees both). Checks,
// in order; the first five block (exit 2, reason on stderr) at most twice and then let the launch through with a logged
// <reason>_gave_up, so a slip never stalls a run; the last two block every time, as they always have:
//   builtin_agent_in_run  while a run is open, an Agent launch whose subagent_type is fork or a Claude Code built-in
//                         (general-purpose, which a missing subagent_type also means, and the others listed in
//                         builtin-agents.mjs or learned on this machine). Plugin-namespaced and project agents are never
//                         blocked; ORCH_ALLOW_BUILTINS=1 turns this off. Counted per subagent_type and run.
//   missing_lines         a brief without SLICE or FILES (counted per run).
//   no_plan_review        until a reviewer of this run's PLAN REVIEW brief has stopped (journal.mjs records it).
//                         PATH: light skips the wait, but only for the run's single slice; a light brief once another
//                         slice ran in scope, or while the open run's plan names several slices, is light_path_multi.
//                         Counted per slice; giving up opens the gate for the
//                         run (no_plan_review_gave_up). A session whose log has a plan reviewer stop but no launch
//                         records (older journal.mjs) counts as reviewed, as before.
//   replan_required       the open run's slice is stalled: its last two counted failed reviews share a gap key at or
//                         above ORCH_GAP_MIN and no REPLAN plan review finished since (docs/brief-grammar.md,
//                         "Stall"). Counted per slice since the stall began. ORCH_STALL_GATE=off turns it off.
//   not_in_plan           in a planned run whose plan has parseable slice lines: the SLICE must be planned (or added
//                         by a REPLAN) and its FILES a subset of the planned FILES (normalizeFiles against the project
//                         dir; a planned folder covers what is under it, a planned glob only what it matches: `*` in
//                         one segment, `**` across segments, `?` one character). Without plan slice lines, or for a
//                         planned slice without FILES, this skips with a logged reason. Counted per slice.
//   file_overlap          a FILES entry overlaps a file another slice of the run owns and the two are in no order in
//                         the run's order graph (planOrder: each slice's latest launch's DEPENDS, this launch's line
//                         replacing a retry's earlier one, followed through other slices, either way); or a retry's new
//                         line drops the only order between two other slices that share a file. Both normalized,
//                         entries overlap when some path could match both.
//   dependency_cycle      DEPENDS closes a cycle in that graph. A retry's DEPENDS on a slice already ordered after it
//                         is not an edge.
//   worktree_base_not_head  (after the two above, with the usual two-block guard per slice) tool_input.isolation is
//                         "worktree", the effective worktree.baseRef (first of <project>/.claude/settings.local.json,
//                         <project>/.claude/settings.json, <CLAUDE_CONFIG_DIR or ~/.claude>/settings.json that sets it)
//                         is not "head", and HEAD in input.cwd differs from refs/remotes/origin/HEAD: the worktree would
//                         start from the remote default branch. Anything it cannot establish lets the launch through.
// Coverage note: a launch of our researcher whose SOURCES name two or more local regular files gets a coverage note
// appended through the allow with updatedInput below (ORCH_SOURCES_NOTE=off turns it off).
// Reviewer hold (1.6.1). On unless ORCH_REVIEW_HOLD=off (or the plugin option REVIEW_HOLD=off). The test gate runs at an
// implementer's SubagentStop after the journal has recorded its report, so its block lands after the worker ended and
// the orchestrator holds a report that says pass. For a launch of this plugin's reviewer (bare or orchestration:; never
// a built-in, fork or another plugin's agent) whose brief names SLICE and is not a PLAN REVIEW, the slice's latest
// implementer is read the way the review gate reads it (run.mjs implementerTestStates): a test-gate block for failed
// tests (tests_failed, or no reason; never a bugfix_ reason) later than its latest stop, with no start since, refuses
// the launch with tests_failed_after_report, at most twice per slice, agent and block, then lets it through as
// tests_failed_after_report_gave_up; a stop with no test-gate record after it yet appends one line to the brief (the
// gate has not reported; the reviewer must not rest a pass on the tests) through the allow with updatedInput below.
// Only the implementers of the run the review lands in count (run.mjs implementersOfRun: the latest run holding the
// slice, as foldRuns places a review; a slice carried whole keeps its implementers). The latest stop's test-gate record
// is paired with it by the hand-back it follows and by count since the agent's latest start (stopGate), not by time: a
// fast gate record can be stamped before telemetry stamps its stop, and an earlier stop's gate can still be running
// after a resume. The hand-back gate's records are never a stop's record. A gate killed before it logged leaves the stop pending, so the note stays.
// Every hold decision goes to review-hold.jsonl in the state dir (never brief text); a refusal needs its record written
// and read back (appendJsonl), else the launch goes through. Reviewer launches still write no plan-check.jsonl record.
// The review gate decides as before.
// Same slice id again (a retry) keeps its own files. Every decision goes to plan-check.jsonl in the state dir with
// the run it was scoped to (`run`); entries of older versions carry no `run` and count in a scope only when newer than
// the latest run's opening (in every scope when the session has no runs).
// A wave's launches arrive at the same time, so read-decide-append runs under a lock (an exclusive mkdir); a lock
// older than STALE_MS is taken over, and after WAIT_MS without it the hook decides unlocked rather than stall.
// A brief with an ORCHESTRATION: workflow line (the scripted workflow) is not checked. Exits 0 on malformed input.
//
// Read router (0.4.0; design: docs/research-2026-10-31.md section 2). Off unless ORCH_READ_ROUTER=on. It acts only on
// a launch of this plugin's own researcher (subagent_type `researcher` or `orchestration:researcher`; never a built-in,
// fork or another plugin's agent), which no check above ever blocks, and only when the brief names SOURCES. It profiles
// the sources with file-profile.mjs's profileSources (paths resolved against the project dir; READ and RISKY from the
// brief; conversions cached in <state dir>/read-cache) in a child process with a time budget (ROUTER_BUDGET_MS, or
// ORCH_READ_ROUTER_BUDGET_MS); any error or timeout skips routing. The effective model is tool_input.model, else the
// agent file's model: line (brief.mjs agentModel), else CLAUDE_CODE_SUBAGENT_MODEL. It is ranked by family (alias or a
// full claude-<family>-... id); when it is inherit, missing or cannot be ranked the router does not route (the agent may
// run on the parent's model, which a tier could lower). When the tier (haiku < sonnet < opus) ranks above it, the
// launch gets the tier's alias; a model is never lowered and fable is never chosen or changed. When conversions exist, a short note listing them (and each PDF's hard pages) is
// appended to the prompt. In those two cases only, the hook prints {permissionDecision: "allow", updatedInput}: the
// only allow any hook returns (a permissions.deny rule still wins). Every router decision goes to reads-route.jsonl
// in the state dir with parsed fields only (tier, models, short reason codes, counts, paths; never brief or file text).
//
// No Haiku unless the user says so. For a launch of one of this plugin's own agents (the project's copy or the plugin's
// namespaced one; never a built-in, fork or another plugin's agent) whose model is in the haiku family, the launch is
// raised to sonnet through the same updatedInput. The model looked at is tool_input.model, else the agent file's model:
// line (an agent file copied from a version before this rule may still say haiku). CLAUDE_CODE_SUBAGENT_MODEL is the
// user's own setting and is left alone. ORCH_ALLOW_HAIKU=1 (or the plugin option) turns the rule off. A raise goes to
// model-floor.jsonl in the state dir (agent type, where the model came from; never brief text). The read router ranks
// the raised model, so it can still raise it further and never lowers it.
//
// Skill hints. On unless ORCH_SKILL_HINTS=off (or the plugin option SKILL_HINTS=off). For a launch of this plugin's own
// implementer (only when this check allows it with reason ok or light_path, never a *_gave_up or other allow),
// researcher or reviewer (bare or orchestration:-prefixed; never the integrator, a built-in, fork or another plugin's
// agent), it appends one block to the prompt: the intro line, then one bullet per pick (skill name and a reason code;
// no descriptions or URLs) from skill-hint.mjs's skillHints over skill-catalog.mjs's installed skills (cached in the
// state dir). Both modules load with a dynamic import; a failure means no hints. A block in which any line would parse
// as a brief or reply line is dropped. The appended text goes out in the same allow with updatedInput as the read
// router's (one updatedInput carries both); the model is never changed by a hint. Researcher and reviewer launches still
// write no plan-check.jsonl record. Each hint decision goes to skills.jsonl in the state dir (role, slice, names, reason
// codes, counts; never brief or skill text). A reviewer gets at most 1 pick, or 2 when the launch's effective model (the
// call's model, else the agent file's) ranks opus or above; a model it cannot rank keeps the limit of 1. In a PLAN REVIEW
// brief the SKILLS lines inside the planned slices are those slices' choices, for the reviewer to check, not skills for
// the reviewer: only a SKILLS line before the first SLICE line counts as explicit there.
//
// Skill slices (an implementer brief with KIND: skill; design: Part 2 of the skills design). Switches, maintainer-facing
// only (never in a block message): ORCH_SKILL_CREATE (empty: on; off), ORCH_SKILLS_REPO_PRIVATE and
// ORCH_SKILLS_REPO_PUBLIC (absolute paths of the two skills repositories), each also read from the plugin option
// (state.mjs bridges them). The target is private unless the brief says TARGET: public. After missing_lines, in order,
// each with the usual loop guard (two blocks per reason and slice, then <reason>_gave_up):
//   skill_create_off    skill creation is off.
//   skill_name_invalid  no SKILL line, or a name that is not lower-case words joined by hyphens (at most 64 characters).
//   skill_repo_missing  the target's repo path is not configured (or not absolute), is not a git work tree, or has no
//                       scripts/validate.py.
//   skill_exists        skills/<name> exists in either configured repo, or an installed skill has that name (the part
//                       after the last ":"), unless the brief says UPDATE: yes.
//   skill_limit         this run already allowed another new (not UPDATE) skill slice with a different name.
// A skill slice's FILES are relative to the skills repo root and resolve against its draft worktree,
// <CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/skill-drafts/<target>/<name>; the resolved paths are what
// plan-check.jsonl records and what file_overlap compares, and not_in_plan resolves the planned FILES of a slice the
// plan marks KIND: skill with SKILL: against the same draft, so a skill slice's README.md never meets the project's.
// When the first three pass (given up or not), every allow of the slice appends one facts block (repo, draft worktree,
// branch skill/<name>, base branch, the worktree command or how to reuse the worktree, the validator, the catalog file,
// the seal command and the authoring skill's name), all values from this hook, in the same allow with updatedInput as
// the hints and the haiku rule's raise; a block in which a line would parse as a brief or reply line is dropped. A
// brief of our implementer, researcher or reviewer with DRAFTS: gets one line per draft of this run this hook allowed
// (its SKILL.md path); an unknown name is dropped. Every decision on a skill slice and every DRAFTS lookup goes to
// skill-create.jsonl in the state dir (decision, reason, skill name, target, paths, slice, run, session; never brief
// text). A brief without KIND: skill and DRAFTS: is decided exactly as before.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentModel, isPlanReview, isSkillName, normalizeFiles, parseHeader, parseReply, stallGateOn } from "./brief.mjs";
import { builtinAgents, OWN_AGENTS } from "./builtin-agents.mjs";
import { appendJsonl, implementerTestStates, implementersOfRun, latestImplementerOf, notTestFailure, readJsonl, sessionRuns } from "./run.mjs";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

const MAX_BLOCKS = 2; // loop guard: two blocks per reason and scope, then the launch goes through as <reason>_gave_up
const LOG = "plan-check.jsonl";
const WAIT_MS = 5000;
const STALE_MS = 10000;
// Claude Code's built-in agent types and fork, which no gate here tracks: the list in builtin-agents.mjs plus the names
// scripts/claude-update.mjs learned from the Claude Code installed on this machine.
const BUILTINS = builtinAgents();
// The read router rewrites only this plugin's researcher: the project's own copy or the plugin's namespaced one.
const ROUTED_TYPES = new Set(["researcher", "orchestration:researcher"]);
const ROUTE_LOG = "reads-route.jsonl";
const ROUTER_BUDGET_MS = 15_000; // under the hook timeout the wiring slice sets; profiling past it skips routing
// The most ORCH_READ_ROUTER_BUDGET_MS may give the profiler. A researcher launch takes no lock and runs no git, so its
// worst case is this child plus node startup, the skill catalog scan of the hints and the log reads: 40 s leaves 20 s
// of the 60 s hook timeout for those (file-system work with no timeout of its own), as the implementer path's fixed
// waits (lock 5 s, at most seven 5 s git calls) leave 20 s for its scans.
const ROUTER_BUDGET_MAX_MS = 40_000;
/** @type {Record<string, number>} */
const TIER_RANK = { haiku: 0, sonnet: 1, opus: 2 };
// Skill hints go only to this plugin's own workers: the project's copy or the plugin's namespaced one.
const HINTED_TYPES = new Set(["implementer", "orchestration:implementer", "researcher", "orchestration:researcher", "reviewer", "orchestration:reviewer"]);
const SKILL_LOG = "skills.jsonl";
// Appended to our own researcher's brief when its SOURCES name two or more local files (ORCH_SOURCES_NOTE=off: none).
const COVERAGE_NOTE =
  "\n\nCoverage: read every SOURCES file in full before you judge, with several Read calls in one turn. End your report with a line `FILES-READ:` naming each file and the lines you read; a file you did not read goes under OPEN.";
// The haiku rule covers every agent of this plugin: the project's copy or the plugin's namespaced one.
const OWN_TYPES = new Set(OWN_AGENTS.flatMap((a) => [a, `orchestration:${a}`]));
const FLOOR_MODEL = "sonnet";
const FLOOR_LOG = "model-floor.jsonl";
const CREATE_LOG = "skill-create.jsonl";
const OWN_IMPLEMENTER = new Set(["implementer", "orchestration:implementer"]);
// The reviewer hold acts only on this plugin's reviewer: the project's copy or the plugin's namespaced one.
const REVIEWER_TYPES = new Set(["reviewer", "orchestration:reviewer"]);
const HOLD_LOG = "review-hold.jsonl";
const HOLD_REASON = "tests_failed_after_report";
// Appended to our reviewer's brief while the slice's implementer has stopped and the test gate has not reported yet.
const PENDING_NOTE =
  "\n\nTest gate (added by the plan check): the test gate has not reported yet on this slice's latest implementer stop, so its tests may still fail. Do not rest a pass on the tests having passed; say in your report that the test gate had not reported.";
const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
// The authoring skill a skill slice loads: the plugin's namespaced copy for the plugin's hook, else the project's.
const AUTHORING = process.argv.includes("--plugin") ? "orchestration:skill-authoring" : "skill-authoring";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
if (duplicate("plan-check.mjs")) process.exit(0); // the project's own copy decides this launch
/** @type {any} */
let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  process.exit(0);
}
if (!input || typeof input !== "object") process.exit(0);
const tool = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
const type = typeof tool.subagent_type === "string" ? tool.subagent_type.trim() : "";
const role = type.split(":").pop();
const prompt = typeof tool.prompt === "string" ? tool.prompt : "";
const h = parseHeader(prompt);
const builtin = !type.includes(":") && BUILTINS.has(type || "general-purpose");
// From here on `tool.model` is the raised model, so every allow below that prints updatedInput carries it.
const floored = !builtin && OWN_TYPES.has(type) && raiseHaiku();
// The scripted workflow fixes the order in code and plans its own slices, so its briefs say so and skip this check.
if (h.workflow) {
  if (floored) allowWith({ ...tool });
  process.exit(0);
}
// The hint modules, loaded only for a launch that may get hints; any failure (a missing file, a syntax error) is none.
/** @type {{ skillCatalog: Function, skillHints: Function, hintBlock: Function } | null} */
let hintMods = null;
if (HINTED_TYPES.has(type) && hintsOn(process.env) && typeof tool.prompt === "string") {
  try {
    const [cat, hint] = await Promise.all([import("./skill-catalog.mjs"), import("./skill-hint.mjs")]);
    if (typeof cat.skillCatalog === "function" && typeof hint.skillHints === "function" && typeof hint.hintBlock === "function") {
      hintMods = { skillCatalog: cat.skillCatalog, skillHints: hint.skillHints, hintBlock: hint.hintBlock };
    }
  } catch {
    hintMods = null;
  }
}
if (role === "implementer") {
  if (typeof tool.prompt !== "string") process.exit(0);
} else if (!builtin || process.env.ORCH_ALLOW_BUILTINS === "1") {
  // No check above blocks this launch. The read router may rewrite it, but only for our own researcher; skill hints
  // only for our own researcher and reviewer. Both changes go out in one updatedInput.
  let routed = null;
  if (!builtin && ROUTED_TYPES.has(type) && routerOn(process.env) && typeof tool.prompt === "string") {
    try {
      routed = routeRead();
    } catch {
      routed = null; // an unexpected error leaves the launch as it was
    }
  }
  // Review hold: our reviewer of a slice (not a PLAN REVIEW) may be refused (exit 2 inside) or get the pending note.
  const pending = !builtin && REVIEWER_TYPES.has(type) && holdOn(process.env) && typeof tool.prompt === "string" && h.slice && !isPlanReview(prompt) ? reviewHold(h.slice) : "";
  const block = !builtin && HINTED_TYPES.has(type) ? skillHintText() : "";
  const drafts = !builtin && HINTED_TYPES.has(type) ? draftsText(null) : "";
  const coverage = !builtin && ROUTED_TYPES.has(type) && sourcesNoteOn(process.env) && typeof tool.prompt === "string" && localSources() >= 2 ? COVERAGE_NOTE : "";
  if (routed || block || drafts || coverage || pending || floored) {
    const raised = !!routed?.raised;
    allowWith({ ...tool, ...(raised && routed ? { model: routed.tier } : {}), prompt: `${prompt}${routed?.note ?? ""}${pending}${block}${drafts}${coverage}` });
  }
  process.exit(0);
}

/** ORCH_REVIEW_HOLD (else the plugin option): the reviewer hold is on unless "off" (any case). @param {Record<string, string | undefined>} env */
function holdOn(env) {
  return String(env.ORCH_REVIEW_HOLD ?? env.CLAUDE_PLUGIN_OPTION_REVIEW_HOLD ?? "").trim().toLowerCase() !== "off";
}

/** One record in review-hold.jsonl (parsed fields only, never brief text); true when it was written and reads back. @param {Record<string, unknown>} rec */
function holdLog(rec) {
  try {
    ensureStateDir();
    return appendJsonl(stateDir, HOLD_LOG, { ts: new Date().toISOString(), session_id: typeof input.session_id === "string" ? input.session_id : "", agent_type: type, ...rec });
  } catch {
    return false; // logging must never change the decision, except that a refusal needs its record (reviewHold)
  }
}

/**
 * The reviewer hold for a launch of our reviewer whose brief names `slice`. The slice's latest implementer (run.mjs
 * latestImplementerOf, over implementerTestStates, the review gate's own reading of the logs):
 *   - has a test-gate block for failed tests (tests_failed, or a record with no reason; never a bugfix_ reason) later
 *     than its latest stop, and no start since the block: refused with tests_failed_after_report (exit 2), twice per
 *     slice, agent and block, then let through and logged as tests_failed_after_report_gave_up;
 *   - stopped, and the test gate has logged nothing for that stop yet: the returned note (test_gate_pending) is appended;
 *   - anything else (gate passed or warned, an environment or other bugfix_ block, still running, no implementer, an
 *     unreadable log): "" and no record.
 * @param {string} slice @returns {string}
 */
function reviewHold(slice) {
  const sid = typeof input.session_id === "string" ? input.session_id : "";
  /** @type {import("./run.mjs").ImplementerTestState | null} */
  let a = null;
  try {
    const { runs, records } = sessionRuns(sid, { env: process.env });
    const agents = implementerTestStates(records.starts, records.gates, sid);
    a = latestImplementerOf(agents, records, slice, implementersOfRun(runs, agents, records, slice));
  } catch {
    return ""; // unreadable logs: decide as if nothing ran
  }
  // Still running (a resume is a start), or never stopped: nothing to hold or note.
  if (!a || a.stop === -Infinity || a.start > a.stop) return "";
  const g = a.stopGate; // the test-gate record of the latest stop, paired by count (run.mjs), or null while pending
  const reason = g && typeof g.reason === "string" ? g.reason : "";
  if (g && g.decision === "block" && !notTestFailure({ testReason: reason })) {
    const blockAt = new Date(Date.parse(String(g.ts ?? "")) || 0).toISOString();
    const same = (/** @type {any} */ e) => e.session_id === sid && e.slice === slice && e.agent_id === a?.id && e.block_at === blockAt;
    const prior = readJsonl(stateDir, HOLD_LOG, sid).filter((e) => same(e) && e.decision === "block").length;
    const fields = { slice, agent_id: a.id, block_at: blockAt, gate_reason: reason || null };
    if (prior >= MAX_BLOCKS) {
      holdLog({ decision: "allow", reason: `${HOLD_REASON}_gave_up`, ...fields });
      return "";
    }
    // Refuse only when the block's record was written and reads back (run.mjs appendJsonl, as the report check does):
    // with an unwritable log the count would stay 0 and the refusal would never give up, so the launch goes through.
    if (!holdLog({ decision: "block", reason: HOLD_REASON, ...fields })) return "";
    try {
      writeSync(2, `${holdMessage(slice, a.id, g)}\n`);
    } catch {
      // a closed stream must not change the decision
    }
    process.exit(2);
  }
  if (!g) {
    holdLog({ decision: "note", reason: "test_gate_pending", slice, agent_id: a.id });
    return PENDING_NOTE;
  }
  return "";
}

/**
 * The refusal: what the test gate recorded (its reason, bounded, and the counts its record has: failing tests, how many
 * also fail on the base, a timeout), and what to do. Names no switch.
 * @param {string} slice @param {string} id the implementer's agent id @param {any} g its test-gate record
 */
function holdMessage(slice, id, g) {
  const num = (/** @type {unknown} */ v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
  const reason = (typeof g.reason === "string" && g.reason ? g.reason : "tests_failed").replace(/[^\w.-]/g, "").slice(0, 64) || "tests_failed";
  const failing = num(g.failing);
  const onBase = num(g.on_base);
  const limit = num(g.limit_s);
  const details = [
    failing !== null ? `${failing} failing test${failing === 1 ? "" : "s"}` : "",
    onBase !== null && onBase > 0 ? `${onBase} of them also failing on the base commit` : "",
    g.timed_out === 1 || g.timed_out === true ? `the suite was stopped after ${limit !== null ? `${limit} seconds` : "its time limit"}` : "",
  ].filter(Boolean);
  return `Plan check: slice ${slice}: the tests failed after the worker had reported. The test gate ran when its implementer (agent ${id}) stopped and recorded ${reason}${details.length ? ` (${details.join("; ")})` : ""}, after the report reached you, so the worker never saw it and its report does not cover the tests. Resume that implementer first with SendMessage (to: ${id}) so it fixes the failing tests and reports again, then launch the review.`;
}

/** ORCH_SOURCES_NOTE: the researcher coverage note is on unless "off" (any case). @param {Record<string, string | undefined>} env */
function sourcesNoteOn(env) {
  return String(env.ORCH_SOURCES_NOTE ?? "").trim().toLowerCase() !== "off";
}

/** How many distinct local regular files (not http(s) URLs) SOURCES names, resolved as the read router resolves them. Never throws. */
function localSources() {
  try {
    const dir = projectDir();
    const paths = h.sources.filter((s) => !/^https?:\/\//i.test(s)).map((s) => resolve(dir, s));
    return [...new Set(paths)].filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

/**
 * The effective worktree.baseRef: the value from the first of the project's settings.local.json, its settings.json and
 * the user settings that sets it; undefined when none sets it. A file sets it only when `worktree` is an object with a
 * string `baseRef`; any other value counts as not set there and the next file is consulted. An unreadable file or
 * invalid JSON means the setting cannot be established (null) and the launch is treated as before. Never throws.
 * @returns {string | null | undefined}
 */
function worktreeBaseRef() {
  try {
    const dir = projectDir();
    const files = [join(dir, ".claude", "settings.local.json"), join(dir, ".claude", "settings.json"), join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "settings.json")];
    for (const f of files) {
      if (!existsSync(f)) continue;
      const s = JSON.parse(readFileSync(f, "utf8"));
      const wt = s && typeof s === "object" ? s.worktree : undefined;
      if (wt && typeof wt === "object" && !Array.isArray(wt) && typeof wt.baseRef === "string") return wt.baseRef;
    }
    return undefined;
  } catch {
    return null;
  }
}

/** ORCH_READ_ROUTER: the router runs only on "on" (any case). @param {Record<string, string | undefined>} env */
function routerOn(env) {
  return String(env.ORCH_READ_ROUTER ?? "").trim().toLowerCase() === "on";
}

/** The project dir a launch belongs to. */
function projectDir() {
  return process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd();
}

/** The model: line of the agent file this launch names: the plugin's for a namespaced type, else the project's. @returns {string | null} */
function agentFileModel() {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || null;
  const dir = projectDir();
  return type.includes(":")
    ? agentModel({ subagent_type: type }, { pluginRoot }) ?? agentModel({ subagent_type: type }, { projectDir: dir })
    : agentModel({ subagent_type: type }, { projectDir: dir });
}

/**
 * The haiku rule: when this launch would run on a haiku model and the user has not allowed that, set tool.model to
 * sonnet and log the raise. Returns whether it raised; any error leaves the launch as it was.
 */
function raiseHaiku() {
  try {
    if (String(process.env.ORCH_ALLOW_HAIKU ?? "").trim() === "1") return false;
    const explicit = typeof tool.model === "string" && tool.model.trim() ? tool.model.trim() : null;
    const model = explicit ?? agentFileModel();
    if (modelRank(model) !== 0 && !haikuFamily(model)) return false;
    tool.model = FLOOR_MODEL;
    try {
      ensureStateDir();
      const sessionId = typeof input.session_id === "string" ? input.session_id : "";
      appendFileSync(join(stateDir, FLOOR_LOG), `${JSON.stringify({ ts: new Date().toISOString(), session_id: sessionId, agent_type: type, decision: "raise", from: "haiku", to: FLOOR_MODEL, model_source: explicit ? "call" : "agent_file" })}\n`);
    } catch {
      // logging must never change the decision
    }
    return true;
  } catch {
    return false;
  }
}

/** ORCH_SKILL_HINTS (else the plugin option): hints run unless "off" (any case). @param {Record<string, string | undefined>} env */
function hintsOn(env) {
  return String(env.ORCH_SKILL_HINTS ?? env.CLAUDE_PLUGIN_OPTION_SKILL_HINTS ?? "").trim().toLowerCase() !== "off";
}

/** Print the allow with updatedInput (the only allow any hook returns). @param {Record<string, unknown>} updatedInput */
function allowWith(updatedInput) {
  try {
    writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput } }));
  } catch {
    // a closed stdout leaves the launch as it was
  }
}

/**
 * True when any line of `text` parses as a brief or reply line. `all` adds the skill slice lines (SKILL, TARGET, UPDATE,
 * DRAFTS, DRAFT) for the blocks this hook writes for them; the hint block is checked without them, as before they existed.
 * @param {string} text @param {boolean} [all]
 */
function briefShaped(text, all = false) {
  const hd = parseHeader(text);
  const rp = parseReply(text);
  // SKILL, TARGET and DRAFT lines are tested by their key as well: an invalid value parses to null but is still a line.
  const keyed = all && text.split("\n").some((l) => /^[ \t>*_`#-]*(SKILL|TARGET|UPDATE|DRAFTS?)[\s*_`]*:/i.test(l));
  const skillLines = all && (!!hd.skill || !!hd.target || hd.update || hd.drafts.length > 0 || keyed || rp.draft !== null);
  return (
    !!hd.slice || hd.files.length > 0 || hd.depends.length > 0 || !!hd.path || hd.risky || hd.checks.length > 0 || !!hd.focus || hd.workflow ||
    hd.sources.length > 0 || !!hd.read || !!hd.kind || hd.validate || hd.skills.length > 0 ||
    skillLines ||
    rp.status !== null || rp.open.length > 0 || Object.keys(rp.answers).length > 0 || rp.gaps.length > 0 || rp.quotes.length > 0 ||
    text.split("\n").some((l) => /^\s*PLAN REVIEW\b/.test(l))
  );
}

/** ORCH_SKILL_CREATE: skill slices may run unless it is "off" (any case). @param {Record<string, string | undefined>} env */
function createOn(env) {
  return String(env.ORCH_SKILL_CREATE ?? "").trim().toLowerCase() !== "off";
}

/** Where draft worktrees live: <CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/skill-drafts. */
function draftHome() {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "orchestration", "skill-drafts");
}

/** The draft worktree of a skill. @param {'private' | 'public'} target @param {string} name */
const draftOf = (target, name) => join(draftHome(), target, name);

/** The configured repo path of a target when it is absolute, else null. @param {'private' | 'public'} target @returns {string | null} */
function repoPath(target) {
  const v = String(process.env[`ORCH_SKILLS_REPO_${target.toUpperCase()}`] ?? "").trim();
  return v && isAbsolute(v) ? resolve(v) : null;
}

/** git -C dir args: trimmed stdout, or null on any failure. @param {string} dir @param {string[]} args @returns {string | null} */
function git(dir, args) {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

/** The repo is usable for drafts: a git work tree with scripts/validate.py. @param {string | null} repo */
function usableRepo(repo) {
  try {
    return !!repo && git(repo, ["rev-parse", "--is-inside-work-tree"]) === "true" && existsSync(join(repo, "scripts", "validate.py"));
  } catch {
    return false;
  }
}

/** An installed skill has this name (the part after the last ":"). Any failure counts as not installed. @param {string} name */
async function installedSkill(name) {
  try {
    const cat = await import("./skill-catalog.mjs");
    let cacheDir = null;
    try {
      ensureStateDir();
      cacheDir = stateDir;
    } catch {
      // no state dir: scan without a cache
    }
    const list = cat.skillCatalog({ env: process.env, projectDir: projectDir(), cacheDir });
    return Array.isArray(list) && list.some((s) => s && typeof s.name === "string" && s.name.split(":").pop() === name);
  } catch {
    return false;
  }
}

/** A word for a shell command line, single-quoted unless it is plain. @param {string} s */
const sh = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** Append one record to skill-create.jsonl; never throws. @param {Record<string, unknown>} rec */
function createLog(rec) {
  try {
    ensureStateDir();
    const sid = typeof input.session_id === "string" ? input.session_id : "";
    appendFileSync(join(stateDir, CREATE_LOG), `${JSON.stringify({ ts: new Date().toISOString(), session_id: sid, ...rec })}\n`);
  } catch {
    // logging must never change the decision
  }
}

/**
 * The facts block appended to an allowed skill slice ("" when it would parse as a brief or reply line). Every value
 * comes from this hook. Never throws.
 * @param {{ name: string, target: 'private' | 'public', repo: string, draft: string, branch: string }} s
 * @returns {{ text: string, base: string | null, baseSha: string | null, reuse: string }}
 */
function skillFactsText(s) {
  try {
    const base = git(s.repo, ["branch", "--show-current"]) || git(s.repo, ["rev-parse", "HEAD"]) || "HEAD";
    // The base commit, pinned for the skill gate: it compares the draft with this commit, not with a branch name.
    const baseSha = git(s.repo, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    const hasBranch = git(s.repo, ["rev-parse", "--verify", "--quiet", `refs/heads/${s.branch}`]) !== null;
    const reuse = existsSync(s.draft) ? "exists" : hasBranch ? "branch" : "new";
    const make =
      reuse === "exists"
        ? `- The draft worktree exists already (an earlier attempt): work in it and do not create it again.`
        : reuse === "branch"
          ? `- Create the draft worktree on the existing branch: git -C ${sh(s.repo)} worktree add ${sh(s.draft)} ${s.branch}`
          : `- Create the draft worktree first: git -C ${sh(s.repo)} worktree add -b ${s.branch} ${sh(s.draft)} ${sh(base)}`;
    const skillDir = join(s.draft, "skills", s.name);
    const text = [
      "",
      "",
      "Skill draft (added by the plan check; every value below comes from the hook, use it as given):",
      `- Repository: the ${s.target} skills repository at ${s.repo}`,
      `- Draft worktree: ${s.draft}`,
      `- Branch ${s.branch}, based on ${base}`,
      make,
      "- The paths on this brief's FILES line are relative to the draft worktree, not to the project.",
      `- Validator, run in the draft worktree: python3 scripts/validate.py skills/${s.name}`,
      `- Catalog file: README.md in the draft worktree (one row for the skill)`,
      `- Seal, after the last change: node ${sh(join(HOOKS_DIR, "skill-seal.mjs"))} ${sh(skillDir)}`,
      `- Authoring skill: load ${AUTHORING} with the Skill tool before starting`,
    ].join("\n");
    return { text: briefShaped(text, true) ? "" : text, base, baseSha, reuse };
  } catch {
    return { text: "", base: null, baseSha: null, reuse: "" };
  }
}

/**
 * The DRAFTS lines for this launch ("" for none): one line per named draft this hook allowed in this run (its SKILL.md
 * path), unknown names dropped; logged to skill-create.jsonl. `scope`: the run keys to match, or null to work them out
 * from the session's runs. Never throws.
 * @param {string[] | null} scope @returns {string}
 */
function draftsText(scope) {
  if (!h.drafts.length) return "";
  const sid = typeof input.session_id === "string" ? input.session_id : "";
  try {
    let keys = scope;
    if (!keys) {
      let runs = [];
      /** @type {any} */
      let openRun = null;
      try {
        ({ runs, open: openRun } = sessionRuns(sid, { env: process.env }));
      } catch {
        // unreadable logs: no run
      }
      keys = openRun ? [String(openRun.id)] : [String(runs.length), `none-${runs.length}`];
    }
    const made = readJsonl(stateDir, CREATE_LOG, sid).filter(
      (e) => e.session_id === sid && e.decision === "allow" && typeof e.skill === "string" && typeof e.draft === "string" && keys.includes(String(e.run)),
    );
    /** @type {{ name: string, path: string }[]} */
    const known = [];
    /** @type {string[]} */
    const unknown = [];
    for (const name of h.drafts) {
      const e = made.findLast((x) => x.skill === name);
      if (e) known.push({ name, path: join(e.draft, "skills", name, "SKILL.md") });
      else unknown.push(name);
    }
    const text = known.length
      ? ["", "", "Draft skills of this run (added by the plan check): read each SKILL.md below before starting.", ...known.map((k) => `- ${k.path} (draft skill ${k.name})`)].join("\n")
      : "";
    const shaped = !!text && briefShaped(text, true);
    createLog({ decision: "drafts", reason: shaped ? "brief_line" : known.length ? "ok" : "none_known", agent_type: type, role, slice: h.slice, names: known.map((k) => k.name), paths: known.map((k) => k.path), unknown, run: keys[0] ?? null });
    return shaped ? "" : text;
  } catch {
    return "";
  }
}

/**
 * The skill hint block for this launch ("" for none), logged to skills.jsonl with parsed fields only. Never throws.
 * @returns {string}
 */
function skillHintText() {
  if (!hintMods) return "";
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  /** @param {Record<string, unknown>} rec */
  const log = (rec) => {
    try {
      ensureStateDir();
      appendFileSync(join(stateDir, SKILL_LOG), `${JSON.stringify({ ts: new Date().toISOString(), session_id: sessionId, agent_type: type, role, slice: h.slice, ...rec })}\n`);
    } catch {
      // logging must never change the decision
    }
  };
  try {
    const dir = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd();
    let cacheDir = null;
    try {
      ensureStateDir();
      cacheDir = stateDir;
    } catch {
      // no state dir: scan without a cache
    }
    const catalog = hintMods.skillCatalog({ env: process.env, projectDir: dir, cacheDir });
    const list = Array.isArray(catalog) ? catalog : [];
    const header = isPlanReview(prompt) ? { ...h, skills: planReviewSkills(prompt) } : h;
    const rank = hintModelRank();
    const picks = hintMods.skillHints({ role, modelRank: rank, header, brief: prompt, catalog: list });
    const safe = Array.isArray(picks) ? picks.filter((p) => p && typeof p.name === "string" && typeof p.reason === "string") : [];
    const names = safe.map((p) => p.name);
    const reasons = safe.map((p) => p.reason);
    const counts = { picks: safe.length, catalog: list.length, explicit: header.skills.length, not_found: reasons.filter((r) => r === "explicit_not_found").length };
    const block = safe.length ? String(hintMods.hintBlock(safe) ?? "") : "";
    if (!block) {
      log({ decision: "none", names: [], reasons: [], ...counts });
      return "";
    }
    if (briefShaped(block)) {
      log({ decision: "dropped", reason: "brief_line", names, reasons, ...counts });
      return "";
    }
    log({ decision: "hint", names, reasons, ...counts });
    return block;
  } catch {
    log({ decision: "skip", reason: "hint_error" });
    return "";
  }
}

/**
 * The SKILLS names of a PLAN REVIEW brief that are meant for its reviewer: those of a SKILLS line before the first SLICE
 * line (the lines after it describe the planned slices). Read with parseHeader, line by line. Never throws.
 * @param {string} text @returns {string[]}
 */
function planReviewSkills(text) {
  try {
    const all = text.split("\n");
    const first = all.findIndex((l) => parseHeader(l).slice !== null);
    return parseHeader(first < 0 ? text : all.slice(0, first).join("\n")).skills;
  } catch {
    return [];
  }
}

/**
 * The rank of the model a hinted launch runs on: the call's model, else the agent file's; null when neither can be
 * ranked. Never throws.
 * @returns {number | null}
 */
function hintModelRank() {
  try {
    const explicit = typeof tool.model === "string" && tool.model.trim() ? tool.model.trim() : null;
    return modelRank(explicit ?? agentFileModel());
  } catch {
    return null;
  }
}

/**
 * Model rank by family: the alias or a full id `claude-<family>-...` gives haiku 0, sonnet 1, opus 2, fable 3 (above every
 * tier, so never changed). Anything else (inherit, no model at all, an id of another shape) is null: the subagent may run
 * on the parent's model, so the router cannot know whether a tier would raise or lower it, and it does not route.
 * @param {unknown} m @returns {number | null}
 */
function modelRank(m) {
  const s = String(m ?? "").trim().toLowerCase();
  const family = s.match(/^(?:claude-)?(haiku|sonnet|opus|fable)(?:$|-)/)?.[1];
  return family === undefined ? null : ({ haiku: 0, sonnet: 1, opus: 2, fable: 3 })[family] ?? null;
}

/**
 * The haiku rule's own test, wider than modelRank (which stays strict for the read router): the word haiku anywhere in
 * the id, between non-letters, so dated and provider-prefixed ids (claude-3-5-haiku-20241022,
 * us.anthropic.claude-haiku-4-5-20251001-v1:0) count. @param {unknown} m
 */
function haikuFamily(m) {
  return /(?:^|[^a-z])haiku(?:$|[^a-z])/.test(String(m ?? "").trim().toLowerCase());
}

/** Short reason codes from a profile (never file text). @param {any} r @param {import("./brief.mjs").Header} hd */
function reasonCodes(r, hd) {
  const codes = new Set();
  if (hd.read) codes.add(`read_${hd.read}`);
  if (hd.risky) codes.add("risky");
  for (const f of r.files) {
    const kind = String(f.kind ?? "unknown");
    codes.add(`${kind}_${f.tier}`);
    if (kind === "pdf") {
      if (typeof f.charsPerPage === "number" && f.charsPerPage < 100) codes.add("pdf_scanned");
      if (f.tables) codes.add("pdf_tables");
      if (f.columns > 1) codes.add("pdf_columns");
      if (Array.isArray(f.hardPages) && f.hardPages.length) codes.add("pdf_hard_pages");
      if (f.wholeDocument) codes.add("long_judge");
    }
    if (f.formulas) codes.add("xlsx_formulas");
    if (kind === "docx" && f.tables) codes.add("docx_tables");
    if ((kind === "docx" || kind === "pptx") && f.images >= 3) codes.add("media_heavy");
    if (f.textPath) codes.add("converted");
  }
  return [...codes];
}

/**
 * The read router: profile the brief's SOURCES, then raise the model and/or point the researcher at cached text
 * conversions. Returns what to change (the caller prints the one allow with updatedInput), or null when it changes
 * nothing; never exits and never throws past its own catch.
 * @returns {{ raised: boolean, tier: 'haiku' | 'sonnet' | 'opus', note: string } | null}
 */
function routeRead() {
  const env = process.env;
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  /** @param {Record<string, unknown>} rec */
  const log = (rec) => {
    try {
      ensureStateDir();
      appendFileSync(join(stateDir, ROUTE_LOG), `${JSON.stringify({ ts: new Date().toISOString(), session_id: sessionId, agent_type: type, ...rec })}\n`);
    } catch {
      // logging must never change the decision
    }
  };
  if (!h.sources.length) {
    log({ decision: "skip", reason: "no_sources" });
    return null;
  }
  const dir = projectDir();
  const isUrl = (/** @type {string} */ s) => /^https?:\/\//i.test(s);
  const sources = h.sources.map((s) => (isUrl(s) ? s : resolve(dir, s)));
  const paths = sources.map((s) => {
    if (!isUrl(s)) return s;
    try {
      return new URL(s).host;
    } catch {
      return "url";
    }
  });
  const budgetEnv = Number(env.ORCH_READ_ROUTER_BUDGET_MS);
  // Clamped at ROUTER_BUDGET_MAX_MS so the hook decides before its 60 s timeout (a hook killed there does not decide).
  const budget = Number.isFinite(budgetEnv) && budgetEnv > 0 ? Math.min(budgetEnv, ROUTER_BUDGET_MAX_MS) : ROUTER_BUDGET_MS;

  /** @type {any} */
  let r = null;
  let failure = "";
  try {
    ensureStateDir();
    const profiler = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "file-profile.mjs")).href;
    const script = `import { profileSources } from ${JSON.stringify(profiler)};
let s = ""; process.stdin.setEncoding("utf8"); for await (const c of process.stdin) s += c;
const a = JSON.parse(s); process.stdout.write(JSON.stringify(profileSources(a.list, a.opts)));`;
    const opts = { read: h.read ?? undefined, risky: h.risky, cacheDir: join(stateDir, "read-cache"), projectDir: dir };
    const out = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      input: JSON.stringify({ list: sources, opts }),
      encoding: "utf8",
      timeout: budget,
      killSignal: "SIGKILL",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const errCode = /** @type {NodeJS.ErrnoException | undefined} */ (out.error)?.code;
    if (errCode === "ETIMEDOUT" || (out.signal && !out.error)) failure = "profiler_timeout";
    else if (out.error || out.status !== 0) failure = "profiler_error";
    else {
      r = JSON.parse(out.stdout);
      if (!r || !(r.tier in TIER_RANK) || !Array.isArray(r.files) || r.files.length !== sources.length) {
        r = null;
        failure = "profiler_error";
      }
    }
  } catch {
    r = null;
    failure = failure || "profiler_error";
  }
  if (!r) {
    log({ decision: "skip", reason: failure, files: sources.length, paths });
    return null;
  }

  const explicit = typeof tool.model === "string" && tool.model.trim() ? tool.model.trim() : null;
  const fromFile = explicit ? null : agentFileModel();
  const fromEnv = (env.CLAUDE_CODE_SUBAGENT_MODEL ?? "").trim() || null;
  const effective = explicit ?? fromFile ?? fromEnv;
  const source = explicit ? "call" : fromFile ? "agent_file" : fromEnv ? "env" : "unknown";
  const tier = /** @type {'haiku'|'sonnet'|'opus'} */ (r.tier);
  const rank = modelRank(effective);
  if (rank === null) {
    // inherit, no model anywhere, or an id it cannot rank: routing could lower the model, so the launch stays as it is
    log({ decision: "skip", reason: "model_unranked", tier, model: effective ?? null, model_source: source, files: sources.length, paths });
    return null;
  }
  const raised = (TIER_RANK[tier] ?? 0) > rank;

  const converted = r.files.filter((/** @type {any} */ f) => typeof f.textPath === "string" && f.textPath);
  let note = "";
  if (converted.length) {
    const rows = converted.map((/** @type {any} */ f) => {
      const hard = Array.isArray(f.hardPages) && f.hardPages.length ? `; hard pages (read these from the original with Read's pages parameter): ${f.hardPages.join(", ")}` : "; no hard pages";
      const whole = f.wholeDocument ? "; the question spans this long document: read all of it, do not split it by page" : "";
      return `- ${f.path} -> ${f.textPath}${f.wholeDocument ? "" : hard}${whole}`;
    });
    note = [
      "",
      "",
      "Converted sources (added by the plan check): these files were converted to text in advance. Read the converted text instead of the original, and open the original only for the hard pages listed. In QUOTE lines, keep the original path as the locator.",
      ...rows,
    ].join("\n");
  }
  const hardPages = converted.reduce((/** @type {number} */ n, /** @type {any} */ f) => n + (Array.isArray(f.hardPages) ? f.hardPages.length : 0), 0);
  const changed = raised || !!note;
  log({
    decision: changed ? "route" : "keep",
    tier,
    model: effective ?? null,
    model_source: source,
    raised,
    to: raised ? tier : null,
    reasons: reasonCodes(r, h),
    files: sources.length,
    paths,
    conversions: converted.length,
    hard_pages: hardPages,
  });
  if (!changed) return null;
  return { raised, tier, note };
}
const sessionId = typeof input.session_id === "string" ? input.session_id : "";
const { slice, depends } = h;
// A skill slice's FILES become paths in its draft worktree once its repo checks pass; every other brief keeps its own.
let files = h.files;
// Only this plugin's or project's own implementer (bare or orchestration:) is a skill slice; built-ins, fork and other
// plugins' agents get nothing from the skill feature.
const skillSlice = OWN_IMPLEMENTER.has(type) && h.kind === "skill";
/** @type {{ name: string | null, target: 'private' | 'public', update: boolean, repo?: string, draft?: string, branch?: string, base?: string, worktree?: string, facts?: string } | null} */
let skillInfo = skillSlice ? { name: h.skill, target: h.target ?? "private", update: h.update } : null;
/** True once create, name and repo checks passed (given up or not): only then are there facts to append. */
let skillReady = false;

const lock = join(stateDir, "plan-check.lock");
// The owner token written into the lock at creation. The lock is removed only while it still holds this token: a lock
// older than STALE_MS may have been taken over by another launch, whose lock is not ours to remove.
const lockOwner = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
let locked = false;
try {
  ensureStateDir();
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  for (const start = Date.now(); !locked && Date.now() - start < WAIT_MS; ) {
    try {
      mkdirSync(lock);
      locked = true;
      try {
        writeFileSync(join(lock, "owner"), lockOwner);
      } catch {
        // no token: the lock is left to go stale rather than removed unchecked
      }
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        // the holder just released it
      }
      Atomics.wait(sleep, 0, 0, 25);
    }
  }
} catch {
  // no state dir: decide unlocked
}

/** @type {{ runs: import("./brief.mjs").Run[], open: import("./brief.mjs").Run | null, records: { stops: any[], launches?: any[] } }} */
let state = { runs: [], open: null, records: { stops: [], launches: [] } };
try {
  state = sessionRuns(sessionId, { env: process.env });
} catch {
  // unreadable logs: decide as if nothing ran
}
const { runs, open, records } = state;
const prior = readJsonl(stateDir, LOG, sessionId).filter((e) => e.session_id === sessionId); // unreadable: as if nothing was launched

// The run this launch is scoped to. With no run open, launches since the last run share the key none-<last run id>;
// a light launch then opens run <last id + 1> (foldRuns opens it at this launch's record) and sees both keys.
const k = runs.length;
const lightBrief = h.path === "light";
const runKey = open ? String(open.id) : lightBrief && role === "implementer" ? String(k + 1) : `none-${k}`;
const scope = open ? [runKey] : lightBrief ? [`none-${k}`, runKey] : [runKey];
// A record without a run id (logged by an older plan check) counts only when it is newer than the latest run's opening;
// otherwise it would own files in every later run. With no runs at all there is no cutoff.
const cutoff = runs.at(-1)?.openedAt ?? null;
/** @param {unknown} ts */
const tsMs = (ts) => (typeof ts === "number" ? ts : Date.parse(String(ts ?? "")) || 0);
const scoped = prior.filter((e) => (e.run === undefined ? cutoff === null || tsMs(e.ts) > cutoff : scope.includes(String(e.run))));
/** @type {string[]} */
const gaveUp = [];
/** @type {string[]} */
const skips = [];

/** @param {string} decision @param {string} reason @param {string} [message] @returns {never} */
function decide(decision, reason, message) {
  try {
    ensureStateDir();
    const extra = { ...(gaveUp.length ? { gave_up: gaveUp } : {}), ...(skips.length ? { skips } : {}) };
    appendFileSync(join(stateDir, LOG), `${JSON.stringify({ ts: new Date().toISOString(), session_id: sessionId, decision, reason, slice, files, depends, agent_type: type, run: runKey, ...extra })}\n`);
  } catch {
    // logging must never change the decision
  }
  // Skill hints: only this plugin's own implementer, and only on a plain allow (ok or light_path), never a give-up.
  // A ready skill slice gets its facts on every allow; DRAFTS lines go to every allow. The haiku rule's raised model
  // goes out on every allow.
  let extra = "";
  if (decision === "allow") {
    const hinted = (reason === "ok" || reason === "light_path") && HINTED_TYPES.has(type) && role === "implementer";
    const block = hinted ? skillHintText() : "";
    let facts = "";
    if (skillInfo && skillReady && skillInfo.name && skillInfo.repo && skillInfo.draft && skillInfo.branch) {
      const f = skillFactsText({ name: skillInfo.name, target: skillInfo.target, repo: skillInfo.repo, draft: skillInfo.draft, branch: skillInfo.branch });
      facts = f.text;
      skillInfo = { ...skillInfo, ...(f.base ? { base: f.base } : {}), ...(f.baseSha ? { base_sha: f.baseSha } : {}), worktree: f.reuse, facts: facts ? "appended" : "dropped" };
    }
    // DRAFTS lines only for our own implementer (this path's own researcher and reviewer exit earlier): never for a
    // built-in, fork or another plugin's agent, which keep their old output.
    extra = `${block}${facts}${HINTED_TYPES.has(type) && role === "implementer" ? draftsText(scope) : ""}`;
  }
  if (skillInfo) {
    const { name, ...rest } = skillInfo;
    createLog({ decision, reason, skill: name, ...rest, slice, files, agent_type: type, run: runKey, ...(gaveUp.length ? { gave_up: gaveUp } : {}) });
  }
  if (locked) {
    try {
      if (readFileSync(join(lock, "owner"), "utf8") === lockOwner) rmSync(lock, { recursive: true, force: true });
    } catch {
      // taken over, already gone or not removable: the decision stands
    }
  }
  if (decision === "block") {
    try {
      writeSync(2, `${message}\n`);
    } catch {
      // a closed stream must not change the decision
    }
    process.exit(2);
  }
  if (decision === "allow" && (extra || floored)) allowWith({ ...tool, prompt: `${prompt}${extra}` });
  process.exit(0);
}
/** Blocks so far in this scope for a reason (and, when given, the same slice or agent type). @param {string} reason @param {(e: any) => boolean} [same] */
const blocks = (reason, same = () => true) => scoped.filter((e) => e.decision === "block" && e.reason === reason && same(e)).length;

if (role !== "implementer") {
  // A built-in or fork launch. Outside an open run it is none of this hook's business.
  if (!open) decide("allow", "builtin_outside_run");
  if (blocks("builtin_agent_in_run", (e) => e.agent_type === type) >= MAX_BLOCKS) {
    gaveUp.push("builtin_agent_in_run_gave_up");
    decide("allow", "builtin_agent_in_run_gave_up");
  }
  decide(
    "block",
    "builtin_agent_in_run",
    `Plan check: run ${open.id} is open, and subagent_type "${type || "general-purpose"}" is a Claude Code built-in or a fork, which the run's gates do not track. Use orchestration:researcher to read or research, orchestration:implementer to change files and orchestration:reviewer to review.`,
  );
}

if (!slice || files.length === 0) {
  if (blocks("missing_lines") >= MAX_BLOCKS) decide("allow", "missing_lines_gave_up");
  decide("block", "missing_lines", "Plan check: every implementer brief starts with SLICE: <id>, FILES: <owned files, comma-separated> and DEPENDS: <slice ids or none>. Add them and launch again.");
}

// Skill slices: the five skill checks, each blocking twice per slice and then giving up.
if (skillInfo) {
  /** @param {string} reason @param {string} message */
  const gate = (reason, message) => {
    if (blocks(reason, (e) => e.slice === slice) < MAX_BLOCKS) decide("block", reason, message);
    gaveUp.push(`${reason}_gave_up`);
  };
  const { name, target } = skillInfo;
  const repo = repoPath(target);
  if (!createOn(process.env)) {
    gate("skill_create_off", "Plan check: creating skills is turned off on this machine, so a KIND: skill slice cannot run. Drop the skill slice and do the task without it, and say in the final report that the skill was not created.");
  } else if (!name) {
    gate("skill_name_invalid", "Plan check: a KIND: skill brief needs a line SKILL: <name>, where the name is lower-case letters and digits in words joined by single hyphens, at most 64 characters (for example release-notes). Add or fix the line and launch again.");
  } else if (!usableRepo(repo)) {
    gate("skill_repo_missing", `Plan check: the ${target} skills repository is not set up on this machine (no path for it, not a git work tree, or no scripts/validate.py), so the skill cannot be drafted there. Do the task without the skill and say so in the final report, or ask the person to set up the ${target} skills repository.`);
  } else if (repo) {
    const draft = draftOf(target, name);
    skillInfo = { ...skillInfo, repo, draft, branch: `skill/${name}` };
    skillReady = true;
    files = normalizeFiles(h.files, draft);
    if (!skillInfo.update) {
      const repos = /** @type {string[]} */ ([repoPath("private"), repoPath("public")].filter(Boolean));
      if (repos.some((r) => existsSync(join(r, "skills", name))) || (await installedSkill(name))) {
        gate("skill_exists", `Plan check: a skill named ${name} already exists (in a skills repository or installed). Pick another name, name the existing skill on a SKILLS line instead, or, to change that skill, add the line UPDATE: yes.`);
      }
      const made = readJsonl(stateDir, CREATE_LOG, sessionId).filter(
        (e) => e.session_id === sessionId && e.decision === "allow" && e.update !== true && typeof e.skill === "string" && e.skill !== name && scope.includes(String(e.run)),
      );
      const other = made.at(-1)?.skill;
      if (other) {
        gate("skill_limit", `Plan check: this run already creates the skill ${other}, and a run creates at most one new skill. Drop this skill slice, or name the draft with DRAFTS: ${other} in the briefs that need it.`);
      }
    }
  }
}

const launched = scoped.filter((e) => e.decision === "allow" && e.slice);
const others = [...new Set(launched.map((e) => e.slice).filter((id) => id !== slice))];
// The light path is for a task with a single slice: none other launched, and no open plan naming several slices.
const plannedMany = open?.kind === "planned" && Array.isArray(open.planned) && open.planned.length > 1;
const light = lightBrief && others.length === 0 && !plannedMany;
const legacyReviewed = k === 0 && records.stops.some((e) => e.slice === "plan" && String(e.role ?? e.agent_type ?? "").split(":").pop() === "reviewer");
const reviewed =
  (open?.kind === "planned" && open.planReviewed) ||
  legacyReviewed ||
  scoped.some((e) => e.decision === "allow" && (e.reason === "no_plan_review_gave_up" || (Array.isArray(e.gave_up) && e.gave_up.includes("no_plan_review_gave_up"))));
if (!reviewed && !light) {
  if (blocks("no_plan_review", (e) => e.slice === slice) + blocks("light_path_multi", (e) => e.slice === slice) < MAX_BLOCKS) {
    if (lightBrief) {
      decide("block", "light_path_multi", `Plan check: PATH: light is only for a task with a single slice, and this run ${others.length ? `already has ${others.join(", ")}` : `plans ${open?.planned.join(", ")}`}. A plan with several slices needs a plan review first: send the plan to a reviewer in a brief that starts with PLAN REVIEW, wait for its report, then launch the implementers.`);
    }
    decide("block", "no_plan_review", "Plan check: no plan review has finished in this run. Send the plan to a reviewer in a brief that starts with PLAN REVIEW, wait for its report, fix the plan, then launch the implementers. Only the light path (a single slice) skips this, with the line PATH: light in the brief.");
  }
  gaveUp.push("no_plan_review_gave_up");
}

// Stall gate: the slice's last two counted failed reviews share a gap at or above ORCH_GAP_MIN and no REPLAN plan
// review finished since (brief.mjs foldRuns sets `stalled`). Blocks counted since the stall began.
const st = open?.slices[slice];
if (open && st?.stalled && stallGateOn(process.env)) {
  const since = st.stalledAt ?? -Infinity;
  if (blocks("replan_required", (e) => e.slice === slice && tsMs(e.ts) > since) < MAX_BLOCKS) {
    decide(
      "block",
      "replan_required",
      `Plan check: slice ${slice} is stalled in run ${open.id}: its last two failed reviews report the same gap. Send the plan to the plan reviewer first in a brief that starts with PLAN REVIEW and REPLAN: <n>, with a changed approach for the slice, then launch it again; or report the slice as failed.`,
    );
  }
  gaveUp.push("replan_required_gave_up");
}

// FILES globs: `*` matches within one path segment, `**` (a whole segment) across segments, `?` one character. An entry
// without glob characters stands for itself and everything under it, unless it exists on disk as a regular file (then
// only itself): a name that does not exist yet may become a folder, whatever it looks like (`docs/v1.2`, `conf.d`).
// The cost, accepted: a `**` glob beside a file that does not exist yet overlaps, since that name could be a folder.
// Entries are compared after normalizeFiles against the project folder (a skill slice's are already resolved against
// its draft), so `./x`, `src/../x` and `/abs/proj/x` are one path.
const dir = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd();
/** @param {string} p */
const isGlob = (p) => /[*?]/.test(p);
/** A regular file on disk; anything else (a folder, or nothing yet) may hold paths under it. @param {string} p */
const onDiskFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};
/** What canon() found on disk for each canonical entry, since a case-folded name may not exist as written. */
/** @type {Map<string, boolean>} */
const fileKind = new Map();
/** @param {string} p */
const fileLike = (p) => fileKind.get(p) ?? onDiskFile(p);
/**
 * Is the project folder on a case-insensitive file system (the macOS default)? Probed once per launch: the folder
 * reached under a name with swapped case is the same inode. A folder name without letters cannot tell: case-sensitive.
 * ORCH_TEST_CASE_INSENSITIVE ("1" or "0") is a test seam that replaces the probe so the rule is tested on Linux; it is
 * not a user switch. Never throws.
 */
const caseInsensitive = (() => {
  const seam = process.env.ORCH_TEST_CASE_INSENSITIVE;
  if (seam === "1" || seam === "0") return seam === "1";
  try {
    const real = realpathSync(dir);
    const swapped = real.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    if (swapped === real) return false;
    const [a, b] = [statSync(real), statSync(swapped)];
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
})();
/**
 * One name for a normalized entry: the fixed leading folders (all of it, for a plain entry) resolved through the file
 * system as far as they exist (the deepest existing ancestor's real path plus the remaining segments, so a symlink and
 * its target are one name; a dangling link or a path not on disk yet stays as written), then case-folded on a
 * case-insensitive file system. A glob's pattern part is never resolved here; names() adds the symlinks its first
 * wildcard segment matches. Never throws: on any error, the entry.
 * Out of reach (other names for one file this check does not see), with link -> src beside src/a.ts: a symlink
 * reached only through a `**` segment (the entry `**` then link/a.ts) or through a wildcard segment after the first
 * (t*, then l*, then a.ts); a hard link (h.ts); two Unicode normal forms of one name on a file system that folds them.
 * @param {string} p
 */
const canon = (p) => {
  /** @type {Map<string, string>} */
  const memo = canon.memo;
  const hit = memo.get(p);
  if (hit !== undefined) return hit;
  let out = p;
  try {
    if (p.startsWith("/")) {
      const segs = p.split("/").filter(Boolean);
      const g = segs.findIndex(isGlob);
      const fixed = g === -1 ? segs : segs.slice(0, g);
      const rest = g === -1 ? [] : segs.slice(g);
      let real = null;
      let k = fixed.length;
      for (; k >= 0; k--) {
        try {
          real = realpathSync(`/${fixed.slice(0, k).join("/")}`);
          break;
        } catch {
          // not on disk (or a dangling link): try its parent
        }
      }
      if (real !== null) {
        const tail = [...fixed.slice(k), ...rest];
        out = tail.length ? `${real === "/" ? "" : real}/${tail.join("/")}` : real;
      }
    }
  } catch {
    out = p;
  }
  const isFile = !isGlob(out) && onDiskFile(out);
  canon.onDisk.set(p, out);
  if (caseInsensitive) out = out.toLowerCase();
  if (isFile) fileKind.set(out, true);
  memo.set(p, out);
  return out;
};
canon.memo = new Map();
/** canon() before case folding, keyed by the same entry: the path to hand the file system. @type {Map<string, string>} */
canon.onDisk = new Map();
const ALIAS_CAP = 32;
/**
 * Every name of a normalized entry: its canon(), and for a glob whose first wildcard segment is not the last (and not
 * `**`) one alias per symlink to a folder that segment matches in its fixed leading folder (one readdir, no recursion):
 * the link's real path followed by the rest of the pattern. null when it cannot be decided (more than ALIAS_CAP links,
 * or an error): the caller treats that as an overlap. Never throws.
 * @param {string} p @returns {string[] | null}
 */
const names = (p) => {
  /** @type {Map<string, string[] | null>} */
  const memo = names.memo;
  if (memo.has(p)) return memo.get(p) ?? null;
  /** @type {string[] | null} */
  let out;
  try {
    const c = canon(p);
    out = [c];
    // List the folder under its on-disk name, not the case-folded key: a folded path is an identity, not a path, and
    // fails to name the folder when it lies on a case-sensitive volume reached from a case-insensitive project.
    const segs = (canon.onDisk.get(p) ?? c).split("/").filter(Boolean);
    const g = segs.findIndex(isGlob);
    if (c.startsWith("/") && g !== -1 && g < segs.length - 1 && segs[g] !== "**") {
      const folder = `/${segs.slice(0, g).join("/")}`;
      /** @type {import("node:fs").Dirent[] | null} */
      let ents = null;
      try {
        ents = readdirSync(folder, { withFileTypes: true });
      } catch (err) {
        const code = /** @type {NodeJS.ErrnoException} */ (err).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") out = null;
      }
      const re = segRe(caseInsensitive ? (segs[g] ?? "").toLowerCase() : (segs[g] ?? ""));
      const rest = segs.slice(g + 1).join("/");
      for (const e of ents ?? []) {
        if (!out) break;
        if (!e.isSymbolicLink() || !re.test(caseInsensitive ? e.name.toLowerCase() : e.name)) continue;
        let real;
        try {
          const at = join(folder, e.name);
          if (!statSync(at).isDirectory()) continue;
          real = realpathSync(at);
        } catch {
          continue; // a dangling link names nothing
        }
        if (out.length > ALIAS_CAP) out = null;
        else out.push(canon(`${real === "/" ? "" : real}/${rest}`));
      }
    }
  } catch {
    out = null;
  }
  memo.set(p, out);
  return out;
};
names.memo = new Map();
/** Path segments; a plain entry that may be a folder gets a trailing `**` (what is under it). @param {string} p */
const segsOf = (p, under = !isGlob(p) && !fileLike(p)) => [...p.split("/").filter(Boolean), ...(under ? ["**"] : [])];
/** One segment pattern as a regular expression. @param {string} g */
const segRe = (g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*+/g, "[^/]*").replace(/\?/g, "[^/]")}$`);
/** Could one segment match both segment patterns? A walk over the product of the two patterns. @param {string} x @param {string} y */
const segMeet = (x, y) => {
  if (!isGlob(x)) return segRe(y).test(x);
  if (!isGlob(y)) return segRe(x).test(y);
  const seen = new Set();
  /** @type {[number, number][]} */
  const todo = [[0, 0]];
  while (todo.length) {
    const [i, j] = /** @type {[number, number]} */ (todo.pop());
    const key = `${i},${j}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (i === x.length && j === y.length) return true;
    if (x[i] === "*") todo.push([i + 1, j]);
    if (y[j] === "*") todo.push([i, j + 1]);
    if (i < x.length && j < y.length) {
      const [a, b] = [x[i], y[j]];
      if (a === "*" || b === "*" || a === "?" || b === "?" || a === b) todo.push([a === "*" ? i : i + 1, b === "*" ? j : j + 1]);
    }
  }
  return false;
};
/** Could one path match both segment lists? @param {string[]} a @param {string[]} b @returns {boolean} */
const meet = (a, b, memo = new Map(), i = 0, j = 0) => {
  const key = `${i},${j}`;
  if (memo.has(key)) return memo.get(key);
  let r;
  if (i === a.length && j === b.length) r = true;
  else if (a[i] === "**") r = meet(a, b, memo, i + 1, j) || (j < b.length && meet(a, b, memo, i, j + 1));
  else if (b[j] === "**") r = meet(a, b, memo, i, j + 1) || (i < a.length && meet(a, b, memo, i + 1, j));
  else r = i < a.length && j < b.length && segMeet(a[i] ?? "", b[j] ?? "") && meet(a, b, memo, i + 1, j + 1);
  memo.set(key, r);
  return r;
};
/**
 * Does every path matching segment list `l` match `p`? Sound but not complete: a case it cannot show is false.
 * @param {string[]} p @param {string[]} l @returns {boolean}
 */
const within = (p, l, memo = new Map(), i = 0, j = 0) => {
  const key = `${i},${j}`;
  if (memo.has(key)) return memo.get(key);
  let r;
  if (i === p.length) r = j === l.length;
  else if (p[i] === "**") r = within(p, l, memo, i + 1, j) || (j < l.length && within(p, l, memo, i, j + 1));
  else if (j === l.length || l[j] === "**") r = false;
  else {
    const [ps, ls] = [p[i] ?? "", l[j] ?? ""];
    r = (isGlob(ls) ? ps === ls || /^\*+$/.test(ps) : segRe(ps).test(ls)) && within(p, l, memo, i + 1, j + 1);
  }
  memo.set(key, r);
  return r;
};
/** Two normalized entries overlap when some path could match both; what cannot be decided overlaps. @param {string} a @param {string} b */
const overlaps = (a, b) => {
  try {
    return a === b || meet(segsOf(a), segsOf(b));
  } catch {
    return true;
  }
};
/**
 * A normalized planned entry covers a normalized launched one: a planned glob only what matches it, a planned folder
 * what is under it. @param {string} p @param {string} f
 */
const covers = (p, f) => {
  try {
    return p === f || within(segsOf(p), segsOf(f, false));
  } catch {
    return false;
  }
};

// Plan conformance: the slice and its files must be in the plan of an open planned run.
if (open?.kind !== "planned") skips.push("not_in_plan:no_planned_run");
else if (!open.planned.length) skips.push("not_in_plan:no_plan_slices");
else {
  const planned = open.slices[slice];
  let problem = "";
  if (!planned?.planned) problem = `slice ${slice} is not in the plan of run ${open.id} (planned: ${open.planned.join(", ")})`;
  else if (!planned.files.length) skips.push("not_in_plan:no_planned_files");
  else {
    // A slice the plan marks KIND: skill with a SKILL name has its planned FILES in that skill's draft worktree.
    const allowed = normalizeFiles(planned.files, plannedDraft(slice) ?? dir).flatMap((p) => names(p) ?? [canon(p)]);
    const extra = files.filter((f) => {
      const n = normalizeFiles([f], dir)[0];
      return !n || !allowed.some((p) => covers(p, canon(n)));
    });
    if (extra.length) problem = `slice ${slice} lists FILES outside its planned FILES: ${extra.join(", ")} (planned: ${planned.files.join(", ")})`;
  }
  if (problem) {
    if (blocks("not_in_plan", (e) => e.slice === slice) < MAX_BLOCKS) {
      decide("block", "not_in_plan", `Plan check: ${problem}. Launch the slice as planned, or send the change to the plan reviewer first in a brief that starts with PLAN REVIEW and REPLAN: <n>, with the new or changed SLICE, FILES, DEPENDS and GOAL lines.`);
    }
    gaveUp.push("not_in_plan_gave_up");
  }
}

/**
 * The draft worktree of a slice the open run's plan marks KIND: skill with a valid SKILL (TARGET public, else private):
 * the latest planned entry for the slice in a plan review of this run; null for any other slice. Never throws.
 * @param {string} id @returns {string | null}
 */
function plannedDraft(id) {
  try {
    const since = open?.openedAt ?? -Infinity;
    /** @type {any} */
    let p = null;
    for (const l of records.launches ?? []) {
      if (!l || typeof l !== "object" || !l.plan || !Array.isArray(l.plan.slices) || tsMs(l.ts) < since) continue;
      for (const x of l.plan.slices) if (x && x.slice === id) p = x;
    }
    return p && p.kind === "skill" && isSkillName(p.skill) ? draftOf(p.target === "public" ? "public" : "private", p.skill) : null;
  } catch {
    return null;
  }
}

/**
 * The run's order graph (G-7), the one both file_overlap and dependency_cycle read. Pure: no I/O and no free variables
 * (src/plan-check-overlap.test.mjs lifts it out of this file and calls it in-process). Edges point from a slice to the
 * slices its DEPENDS names. Each slice's edges are the DEPENDS of its latest allowed launch in log order: a retry replaces
 * its earlier line, so an edge of a superseded launch orders nothing. A retry's entry naming a slice that already leads
 * back to it, directly or through other slices (a slice ordered after it), is dropped: the retry does not reverse that
 * order. A first launch's line is kept whole, and so is a slice naming itself, so a real cycle is still a cycle.
 * `prior` is the graph of `launches`, `graph` the same with this launch applied; `cycle`: this launch's edges lead back
 * to it; `unordered`: the launched slices this launch is in no order with; `lost`: two other launched slices that `prior`
 * orders and `graph` no longer does (a retry dropped the only path between them).
 * @param {{ slice?: unknown, depends?: unknown }[]} launches @param {string} slice @param {string[]} depends
 * @returns {{ prior: Map<string, string[]>, graph: Map<string, string[]>, cycle: boolean, unordered: string[], lost: [string, string][] }}
 */
function planOrder(launches, slice, depends) {
  /** Following edges from `from` leads to `to`. @param {Map<string, string[]>} g @param {string} from @param {string} to */
  const leads = (g, from, to) => {
    const seen = new Set();
    const todo = [...(g.get(from) ?? [])];
    while (todo.length) {
      const s = /** @type {string} */ (todo.pop());
      if (s === to) return true;
      if (seen.has(s)) continue;
      seen.add(s);
      todo.push(...(g.get(s) ?? []));
    }
    return false;
  };
  /** @param {Map<string, string[]>} g @param {string} x @param {string} y */
  const ordered = (g, x, y) => leads(g, x, y) || leads(g, y, x);
  /** The graph with one launch applied (a new Map). @param {Map<string, string[]>} g @param {string} s @param {unknown} line */
  const apply = (g, s, line) => {
    const retry = g.has(s);
    const named = [...new Set((Array.isArray(line) ? line : []).filter((d) => typeof d === "string" && d !== ""))];
    const next = new Map(g);
    next.set(s, named.filter((d) => !(retry && d !== s && leads(g, d, s))));
    return next;
  };
  /** @type {Map<string, string[]>} */
  let prior = new Map();
  for (const e of launches) if (e && typeof e.slice === "string" && e.slice) prior = apply(prior, e.slice, e.depends);
  const graph = apply(prior, slice, depends);
  const others = [...prior.keys()].filter((s) => s !== slice);
  /** @type {[string, string][]} */
  const lost = [];
  for (const x of others) for (const y of others) if (x < y && ordered(prior, x, y) && !ordered(graph, x, y)) lost.push([x, y]);
  return { prior, graph, cycle: leads(graph, slice, slice), unordered: others.filter((s) => !ordered(graph, slice, s)), lost };
}

// This launch against the run's order graph: each launched slice's latest DEPENDS line, this launch's line applied.
const order = planOrder(launched, slice, depends);
/** FILES of one launch record, as written. @param {any} e @returns {string[]} */
const ownedBy = (e) => (Array.isArray(e.files) ? e.files : []).filter((/** @type {unknown} */ g) => typeof g === "string");
/** Some path could match both entries; an entry whose names cannot be decided overlaps. @param {string} a @param {string} b */
const clash = (a, b) => {
  const x = names(normalizeFiles([a], dir)[0] ?? a);
  const y = names(normalizeFiles([b], dir)[0] ?? b);
  return !x || !y || x.some((n) => y.some((g) => overlaps(n, g)));
};

const clashes = [];
for (const e of launched) {
  if (e.slice === slice || !order.unordered.includes(e.slice)) continue;
  // FILES are logged as written and compared normalized; an entry that does not normalize is compared as written.
  const owned = ownedBy(e);
  for (const f of files) if (owned.some((g) => clash(f, g))) clashes.push(`${f} (owned by ${e.slice})`);
}
// file_overlap and dependency_cycle block every time, as before this hook was scoped to runs: two owners of one file,
// or a cycle, is a broken plan that letting the launch through would not fix (C2: no existing block is weakened).
if (clashes.length) {
  decide("block", "file_overlap", `Plan check: slice ${slice} would change files another slice owns: ${[...new Set(clashes)].join(", ")}. Give each file one owner, or list the owning slice in DEPENDS if this slice runs after it.`);
}
// A retry whose new DEPENDS line removes the only order between two other slices that share a file.
const loose = [];
for (const [x, y] of order.lost) {
  const xs = launched.filter((e) => e.slice === x).flatMap(ownedBy);
  const ys = launched.filter((e) => e.slice === y).flatMap(ownedBy);
  const shared = xs.find((f) => ys.some((g) => clash(f, g)));
  if (shared !== undefined) loose.push(`${x} and ${y} (${shared})`);
}
if (loose.length) {
  decide("block", "file_overlap", `Plan check: this DEPENDS line of slice ${slice} drops the only order between slices that share files: ${loose.join(", ")}. Keep the slices ${slice} depended on in its DEPENDS line, or give each file one owner.`);
}

// Cycle: following DEPENDS from this slice through the order graph leads back to this slice.
if (order.cycle) decide("block", "dependency_cycle", `Plan check: DEPENDS of slice ${slice} forms a cycle. Fix the order in the plan.`);

// Worktree base: an isolated launch whose worktree would start from origin's default branch while the checked-out HEAD
// differs (the session did not load a settings file with worktree.baseRef "head"). Anything it cannot establish allows.
if (tool.isolation === "worktree" && typeof input.cwd === "string" && input.cwd) {
  const baseRef = worktreeBaseRef();
  if (baseRef !== null && baseRef !== "head") {
    const headSha = git(input.cwd, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    const originSha = headSha ? git(input.cwd, ["rev-parse", "--verify", "--quiet", "refs/remotes/origin/HEAD^{commit}"]) : null;
    if (headSha && originSha && headSha !== originSha) {
      if (blocks("worktree_base_not_head", (e) => e.slice === slice) < MAX_BLOCKS) {
        decide(
          "block",
          "worktree_base_not_head",
          `Plan check: slice ${slice} is launched with isolation "worktree", but worktree.baseRef is not "head" in the settings this session loaded, so the worktree would start from the remote default branch (${originSha.slice(0, 7)}) and miss the checked-out work (HEAD ${headSha.slice(0, 7)}). Set worktree.baseRef to "head" in the user settings or in the settings of the folder the session was started in, or run the slices one after another without isolation.`,
        );
      }
      gaveUp.push("worktree_base_not_head_gave_up");
    }
  }
}
decide("allow", gaveUp[0] ?? (light && !reviewed ? "light_path" : "ok"));
