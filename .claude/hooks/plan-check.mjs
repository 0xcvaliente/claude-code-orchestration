#!/usr/bin/env node
// PreToolUse gate on Agent: checks each launch against the current run (brief.mjs foldRuns via run.mjs; spec:
// docs/brief-grammar.md), in code, before the agent starts. Implementer briefs carry three lines (parsed by brief.mjs):
//   SLICE: <id>    FILES: <owned files, comma-separated>    DEPENDS: <slice ids, or none>
// Every check is scoped to a run, not to the session: the open run (not closed, not stale), or, with no run open,
// the launches since the last run (a PATH: light launch with no run open opens the next run and sees both). Checks,
// in order; the first five block (exit 2, reason on stderr) at most twice and then let the launch through with a logged
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
//   replan_required       the open run's slice is stalled: its last two counted failed reviews share a gap key at or
//                         above ORCH_GAP_MIN and no REPLAN plan review finished since (docs/brief-grammar.md,
//                         "Stall"). Counted per slice since the stall began. ORCH_STALL_GATE=off turns it off.
//   not_in_plan           in a planned run whose plan has parseable slice lines: the SLICE must be planned (or added
//                         by a REPLAN) and its FILES a subset of the planned FILES (normalizeFiles against the project
//                         dir; a planned folder or glob covers what is under it). Without plan slice lines, or for a
//                         planned slice without FILES, this skips with a logged reason. Counted per slice.
//   file_overlap          a FILES entry overlaps a file another slice of the run owns and that slice is not in DEPENDS.
//   dependency_cycle      DEPENDS closes a cycle.
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
// agent file's model: line (brief.mjs agentModel), else CLAUDE_CODE_SUBAGENT_MODEL, else unknown (counted as haiku).
// When the tier (haiku < sonnet < opus) ranks above it, the launch gets the tier's alias; a model is never lowered and
// fable is never chosen or changed. When conversions exist, a short note listing them (and each PDF's hard pages) is
// appended to the prompt. In those two cases only, the hook prints {permissionDecision: "allow", updatedInput}: the
// only allow any hook returns (a permissions.deny rule still wins). Every router decision goes to reads-route.jsonl
// in the state dir with parsed fields only (tier, models, short reason codes, counts, paths; never brief or file text).
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, statSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentModel, normalizeFiles, parseHeader, stallGateOn } from "./brief.mjs";
import { readJsonl, sessionRuns } from "./run.mjs";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

const MAX_BLOCKS = 2; // loop guard: two blocks per reason and scope, then the launch goes through as <reason>_gave_up
const LOG = "plan-check.jsonl";
const WAIT_MS = 5000;
const STALE_MS = 10000;
// Claude Code's built-in agent types (DENIED_AGENTS in src/config.ts) and fork, which no gate here tracks.
const BUILTINS = new Set(["fork", "general-purpose", "claude", "Explore", "Plan", "claude-code-guide", "statusline-setup"]);
// The read router rewrites only this plugin's researcher: the project's own copy or the plugin's namespaced one.
const ROUTED_TYPES = new Set(["researcher", "orchestration:researcher"]);
const ROUTE_LOG = "reads-route.jsonl";
const ROUTER_BUDGET_MS = 15_000; // under the hook timeout the wiring slice sets; profiling past it skips routing
/** @type {Record<string, number>} */
const TIER_RANK = { haiku: 0, sonnet: 1, opus: 2 };

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
  // No check above blocks this launch. The read router may rewrite it, but only for our own researcher.
  if (!builtin && ROUTED_TYPES.has(type) && routerOn(process.env) && typeof tool.prompt === "string") routeRead();
  process.exit(0);
}

/** ORCH_READ_ROUTER: the router runs only on "on" (any case). @param {Record<string, string | undefined>} env */
function routerOn(env) {
  return String(env.ORCH_READ_ROUTER ?? "").trim().toLowerCase() === "on";
}

/** Model rank: haiku 0 (also unknown), sonnet 1, opus 2, fable 3 (above every tier, so never changed). @param {unknown} m */
function modelRank(m) {
  const s = String(m ?? "").toLowerCase();
  if (s.includes("fable")) return 3;
  if (s.includes("opus")) return 2;
  if (s.includes("sonnet")) return 1;
  return 0;
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
 * conversions. Prints the allow with updatedInput only when it changes something; always exits 0.
 * @returns {never}
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
    process.exit(0);
  }
  const dir = env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd();
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
  const budget = Number.isFinite(budgetEnv) && budgetEnv > 0 ? Math.min(budgetEnv, 50_000) : ROUTER_BUDGET_MS;

  /** @type {any} */
  let r = null;
  let failure = "";
  try {
    ensureStateDir();
    const profiler = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "file-profile.mjs")).href;
    const script = `import { profileSources } from ${JSON.stringify(profiler)};
let s = ""; process.stdin.setEncoding("utf8"); for await (const c of process.stdin) s += c;
const a = JSON.parse(s); process.stdout.write(JSON.stringify(profileSources(a.list, a.opts)));`;
    const opts = { read: h.read ?? undefined, risky: h.risky, cacheDir: join(stateDir, "read-cache") };
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
    process.exit(0);
  }

  const explicit = typeof tool.model === "string" && tool.model.trim() ? tool.model.trim() : null;
  const pluginRoot = env.CLAUDE_PLUGIN_ROOT || null;
  const fromFile = explicit
    ? null
    : type.includes(":")
      ? agentModel({ subagent_type: type }, { pluginRoot }) ?? agentModel({ subagent_type: type }, { projectDir: dir })
      : agentModel({ subagent_type: type }, { projectDir: dir });
  const fromEnv = (env.CLAUDE_CODE_SUBAGENT_MODEL ?? "").trim() || null;
  const effective = explicit ?? fromFile ?? fromEnv;
  const source = explicit ? "call" : fromFile ? "agent_file" : fromEnv ? "env" : "unknown";
  const tier = /** @type {'haiku'|'sonnet'|'opus'} */ (r.tier);
  const raised = (TIER_RANK[tier] ?? 0) > modelRank(effective);

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
  if (!changed) process.exit(0);
  const updatedInput = { ...tool, ...(raised ? { model: tier } : {}), prompt: `${prompt}${note}` };
  try {
    writeSync(1, JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput } }));
  } catch {
    // a closed stdout leaves the launch as it was
  }
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

// Stall gate: the slice's last two counted failed reviews share a gap at or above ORCH_GAP_MIN and no REPLAN plan
// review finished since (brief.mjs foldRuns sets `stalled`). Blocks counted since the stall began.
const st = open?.slices[slice];
if (open && st?.stalled && stallGateOn(process.env)) {
  const since = st.stalledAt ?? -Infinity;
  if (blocks("replan_required", (e) => e.slice === slice && tsMs(e.ts) > since) < MAX_BLOCKS) {
    decide(
      "block",
      "replan_required",
      `Plan check: slice ${slice} is stalled in run ${open.id}: its last two failed reviews report the same gap. Send the plan to the plan reviewer first in a brief that starts with PLAN REVIEW and REPLAN: <n>, with a changed approach for the slice, then launch it again; or report the slice as failed. ORCH_STALL_GATE=off turns this check off.`,
    );
  }
  gaveUp.push("replan_required_gave_up");
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
