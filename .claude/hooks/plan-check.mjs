#!/usr/bin/env node
// PreToolUse gate on Agent: checks each launch against the current run (brief.mjs foldRuns via run.mjs; spec:
// docs/brief-grammar.md), in code, before the agent starts. Implementer briefs carry three lines (parsed by brief.mjs):
//   SLICE: <id>    FILES: <owned files, comma-separated>    DEPENDS: <slice ids, or none>
// Every check is scoped to a run, not to the session: the open run (not closed, not stale), or, with no run open,
// the launches since the last run (a PATH: light launch with no run open opens the next run and sees both). Checks,
// in order; the first four block (exit 2, reason on stderr) at most twice and then let the launch through with a logged
// <reason>_gave_up, so a slip never stalls a run; the last two block every time, as they always have:
//   builtin_agent_in_run  while a run is open, an Agent launch whose subagent_type is fork or a Claude Code built-in
//                         (general-purpose, which a missing subagent_type also means, claude, Explore, Plan,
//                         claude-code-guide, statusline-setup). Plugin-namespaced and project agents are never
//                         blocked; ORCH_ALLOW_BUILTINS=1 turns this off. Counted per subagent_type and run.
//   missing_lines         a brief without SLICE or FILES (counted per run).
//   no_plan_review        until a reviewer of this run's PLAN REVIEW brief has stopped (journal.mjs records it).
//                         PATH: light skips the wait, but only for the run's single slice; a light brief once another
//                         slice ran in scope is light_path_multi. Counted per slice; giving up opens the gate for the
//                         run (no_plan_review_gave_up). A session whose log has a plan reviewer stop but no launch
//                         records (older journal.mjs) counts as reviewed, as before.
//   not_in_plan           in a planned run whose plan has parseable slice lines: the SLICE must be planned (or added
//                         by a REPLAN) and its FILES a subset of the planned FILES (normalizeFiles against the project
//                         dir; a planned folder or glob covers what is under it). Without plan slice lines, or for a
//                         planned slice without FILES, this skips with a logged reason. Counted per slice.
//   file_overlap          a FILES entry overlaps a file another slice of the run owns and that slice is not in DEPENDS.
//   dependency_cycle      DEPENDS closes a cycle.
// Same slice id again (a retry) keeps its own files. Every decision goes to plan-check.jsonl in the state dir with
// the run it was scoped to (`run`); entries of older versions carry no `run` and count in every scope.
// A wave's launches arrive at the same time, so read-decide-append runs under a lock (an exclusive mkdir); a lock
// older than STALE_MS is taken over, and after WAIT_MS without it the hook decides unlocked rather than stall.
// A brief with an ORCHESTRATION: workflow line (the scripted workflow) is not checked. Exits 0 on malformed input.
import { appendFileSync, mkdirSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { normalizeFiles, parseHeader } from "./brief.mjs";
import { readJsonl, sessionRuns } from "./run.mjs";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

const MAX_BLOCKS = 2; // loop guard: two blocks per reason and scope, then the launch goes through as <reason>_gave_up
const LOG = "plan-check.jsonl";
const WAIT_MS = 5000;
const STALE_MS = 10000;
// Claude Code's built-in agent types (DENIED_AGENTS in src/config.ts) and fork, which no gate here tracks.
const BUILTINS = new Set(["fork", "general-purpose", "claude", "Explore", "Plan", "claude-code-guide", "statusline-setup"]);

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
// The scripted workflow fixes the order in code and plans its own slices, so its briefs say so and skip this check.
if (h.workflow) process.exit(0);
const builtin = !type.includes(":") && BUILTINS.has(type || "general-purpose");
if (role === "implementer") {
  if (typeof tool.prompt !== "string") process.exit(0);
} else if (!builtin || process.env.ORCH_ALLOW_BUILTINS === "1") {
  process.exit(0);
}
const sessionId = typeof input.session_id === "string" ? input.session_id : "";
const { slice, files, depends } = h;

const lock = join(stateDir, "plan-check.lock");
let locked = false;
try {
  ensureStateDir();
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  for (const start = Date.now(); !locked && Date.now() - start < WAIT_MS; ) {
    try {
      mkdirSync(lock);
      locked = true;
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

/** @type {{ runs: import("./brief.mjs").Run[], open: import("./brief.mjs").Run | null, records: { stops: any[] } }} */
let state = { runs: [], open: null, records: { stops: [] } };
try {
  state = sessionRuns(sessionId, { env: process.env });
} catch {
  // unreadable logs: decide as if nothing ran
}
const { runs, open, records } = state;
const prior = readJsonl(stateDir, LOG).filter((e) => e.session_id === sessionId); // unreadable: as if nothing was launched

// The run this launch is scoped to. With no run open, launches since the last run share the key none-<last run id>;
// a light launch then opens run <last id + 1> (foldRuns opens it at this launch's record) and sees both keys.
const k = runs.length;
const lightBrief = h.path === "light";
const runKey = open ? String(open.id) : lightBrief && role === "implementer" ? String(k + 1) : `none-${k}`;
const scope = open ? [runKey] : lightBrief ? [`none-${k}`, runKey] : [runKey];
const scoped = prior.filter((e) => e.run === undefined || scope.includes(String(e.run)));
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
  if (locked) rmSync(lock, { recursive: true, force: true });
  if (decision === "block") {
    try {
      writeSync(2, `${message}\n`);
    } catch {
      // a closed stream must not change the decision
    }
    process.exit(2);
  }
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
    `Plan check: run ${open.id} is open, and subagent_type "${type || "general-purpose"}" is a Claude Code built-in or a fork, which the run's gates do not track. Use orchestration:researcher to read or research, orchestration:implementer to change files and orchestration:reviewer to review. ORCH_ALLOW_BUILTINS=1 allows built-ins.`,
  );
}

if (!slice || files.length === 0) {
  if (blocks("missing_lines") >= MAX_BLOCKS) decide("allow", "missing_lines_gave_up");
  decide("block", "missing_lines", "Plan check: every implementer brief starts with SLICE: <id>, FILES: <owned files, comma-separated> and DEPENDS: <slice ids or none>. Add them and launch again.");
}

const launched = scoped.filter((e) => e.decision === "allow" && e.slice);
const others = [...new Set(launched.map((e) => e.slice).filter((id) => id !== slice))];
const light = lightBrief && others.length === 0;
const legacyReviewed = k === 0 && records.stops.some((e) => e.slice === "plan" && String(e.role ?? e.agent_type ?? "").split(":").pop() === "reviewer");
const reviewed =
  (open?.kind === "planned" && open.planReviewed) ||
  legacyReviewed ||
  scoped.some((e) => e.decision === "allow" && (e.reason === "no_plan_review_gave_up" || (Array.isArray(e.gave_up) && e.gave_up.includes("no_plan_review_gave_up"))));
if (!reviewed && !light) {
  if (blocks("no_plan_review", (e) => e.slice === slice) + blocks("light_path_multi", (e) => e.slice === slice) < MAX_BLOCKS) {
    if (lightBrief) {
      decide("block", "light_path_multi", `Plan check: PATH: light is only for a task with a single slice, and this run already has ${others.join(", ")}. A plan with several slices needs a plan review first: send the plan to a reviewer in a brief that starts with PLAN REVIEW, wait for its report, then launch the implementers.`);
    }
    decide("block", "no_plan_review", "Plan check: no plan review has finished in this run. Send the plan to a reviewer in a brief that starts with PLAN REVIEW, wait for its report, fix the plan, then launch the implementers. Only the light path (a single slice) skips this, with the line PATH: light in the brief.");
  }
  gaveUp.push("no_plan_review_gave_up");
}

// A glob counts as its literal prefix; two paths overlap when equal or when one is a folder of the other.
/** @param {string} p */
const base = (p) => p.replace(/\*.*$/, "").replace(/\/+$/, "");
/** @param {string} a @param {string} b */
const overlaps = (a, b) => {
  const [x, y] = [base(a), base(b)];
  if (!x || !y) return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
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
    const dir = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd();
    const allowed = normalizeFiles(planned.files, dir);
    /** A planned path covers itself, what is under it as a folder, and what its glob prefix starts. @param {string} p @param {string} f */
    const covers = (p, f) => {
      const [x, y] = [base(p), base(f)];
      return !!x && (x === y || y.startsWith(`${x}/`) || (p.includes("*") && y.startsWith(x)));
    };
    const extra = files.filter((f) => {
      const n = normalizeFiles([f], dir)[0];
      return !n || !allowed.some((p) => covers(p, n));
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

const clashes = [];
for (const e of launched) {
  if (e.slice === slice || depends.includes(e.slice)) continue;
  for (const f of files) for (const g of e.files ?? []) if (overlaps(f, g)) clashes.push(`${f} (owned by ${e.slice})`);
}
// file_overlap and dependency_cycle block every time, as before this hook was scoped to runs: two owners of one file,
// or a cycle, is a broken plan that letting the launch through would not fix (C2: no existing block is weakened).
if (clashes.length) {
  decide("block", "file_overlap", `Plan check: slice ${slice} would change files another slice owns: ${[...new Set(clashes)].join(", ")}. Give each file one owner, or list the owning slice in DEPENDS if this slice runs after it.`);
}

// Cycle: following DEPENDS from this slice's dependencies leads back to this slice.
const deps = new Map(launched.map((e) => [e.slice, e.depends ?? []]));
deps.set(slice, depends);
const seen = new Set();
const stack = [...depends];
while (stack.length) {
  const s = stack.pop();
  if (s === slice) decide("block", "dependency_cycle", `Plan check: DEPENDS of slice ${slice} forms a cycle. Fix the order in the plan.`);
  if (seen.has(s)) continue;
  seen.add(s);
  stack.push(...(deps.get(s) ?? []));
}
decide("allow", gaveUp[0] ?? (light && !reviewed ? "light_path" : "ok"));
