#!/usr/bin/env node
// PreToolUse hook (matcher Workflow): refuses every Workflow launch except this repo's saved workflow. Claude Code's
// keyword `ultracode` in a typed prompt, or a plain request for a workflow, makes the model write a workflow script on the
// spot and start it with Claude Code's own agents, outside the plan check, the run journal and the review rules. Claude
// Code's own off switches (the `disableWorkflows` setting, CLAUDE_CODE_DISABLE_WORKFLOWS=1) would also remove saved
// workflows, and so the gated workflow `.claude/workflows/orchestrate.js` (`/orchestrate`, plugin copy
// `/orchestration:orchestrate`), so this hook narrows the tool instead of removing it. A plugin cannot ship
// permissions.deny, so a hook is the only refusal the plugin can carry.
//
// Identity by content (1.6.1): a saved name passes only when the file Claude Code loads for it hashes to the value in
// workflow-hash.mjs (SHA-256, CRLF read as LF), so a file a model writes at the saved path, or another project's own
// `orchestrate` workflow where the plugin is on, is refused (`workflow_content_mismatch`).
//
// Silent (exit 0, no output) only for one of these two shapes; everything else is refused (fail closed):
// 1. A launch or a resume by name: keys `name` and optionally `args` and `resumeFromRunId` (a run id of Claude Code's
//    own form, `wf_` then at least six of [a-z0-9-]), nothing else, with
//    - `name` exactly `orchestrate`: every one of <CLAUDE_PROJECT_DIR>/.claude/workflows/orchestrate.js and
//      <the input's cwd>/.claude/workflows/orchestrate.js that exists hashes to PROJECT_WORKFLOW_SHA256, and at least one
//      exists (`workflow_file_missing` otherwise). "Exists" means anything at the path, a dangling link included: only a
//      path where nothing exists is skipped, and a candidate that exists but cannot be hashed (unreadable, not a regular
//      file, over 4 MB) refuses with `workflow_unreadable`. The same holds for every file hashed below (the plugin's
//      file, both files of the layout rule; a resume's scriptPath refuses with `script_path`);
//    - `name` exactly `orchestration:orchestrate`, plugin copy of this hook: the plugin's own workflows/orchestrate.js
//      (the folder above this file, where Claude Code loads the plugin's workflows from) hashes to PLUGIN_WORKFLOW_SHA256;
//    - `name` exactly `orchestration:orchestrate`, project copy: it cannot see where the plugin is installed, so it
//      refuses the name (`plugin_not_located`) except in this repository's own layout: some project root holds both
//      .claude/workflows/orchestrate.js with PROJECT_WORKFLOW_SHA256 and dist/plugin/workflows/orchestrate.js with
//      PLUGIN_WORKFLOW_SHA256 (the plugin is built from this checkout), and no root holds either file with other content. That exception is the both-copies case here:
//      with the plugin on, the plugin copy steps aside (duplicate(), the project registers this hook), so the project
//      copy alone decides and must not refuse the plugin's real workflow. It checks the built copy, not the installed
//      one: an installed plugin of another version is trusted as installed. In another project that carries a copy of
//      .claude/ and has the plugin on, the plugin name is refused and `/orchestrate` (the project copy) works.
// 2. A resume by script file: keys `scriptPath` and `resumeFromRunId` and optionally `args`, nothing else, where
//    `scriptPath` is an absolute path to `.../workflows/scripts/<anything>-<resumeFromRunId>.js` (the copy Claude Code
//    persists for every launch, and the form its resume notices give) and that file hashes to either stored value.
// Shapes observed live (Claude Code 2.1.326; docs/data/live-checks-2026-11-17.md, Check 5, and
// docs/data/live-checks-2026-11-17-b.md, K9): an ad-hoc launch reaches PreToolUse as {"script": "<the whole script>"}; a saved launch
// as {"name": "orchestrate", "args": {...}}; a resume by name as {"name", "args", "resumeFromRunId"}, and it runs the
// saved file as it is now; a resume by file as {"args", "scriptPath", "resumeFromRunId"}, where scriptPath is the
// persisted copy, byte for byte the saved file. `scriptPath` without `resumeFromRunId`, or with `name` or `script`, was
// not seen and is refused (`script_path`), as is a `remote` key or any other (`unknown_shape`).
// Out of reach: a file changed between this check and Claude Code's read of it; the installed plugin's own file when
// the project copy decides (above).
//
// Deny-only: exit 2 with the reason on stderr, or exit 0 with no output; never an allow or ask decision (plan-check.mjs
// stays the only hook that returns an allow). Input that is not JSON, and an event for another tool or another hook
// event, exit 0 (hooks exit 0 on malformed input). The plugin copy exits on duplicate() where the project registers its
// own. ORCH_WORKFLOW_GUARD=off (plugin setting workflow_guard, read as CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD; the
// environment wins) turns it off. One record per decision in workflow-guard.jsonl in the state dir: the reason code, the
// workflow name (at most 80 characters) and the input's key names; never the script or the arguments.
// The block message is model-facing: it names no switch and no Claude Code agent type.
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";
import { fileHash, MISSING, PLUGIN_WORKFLOW_SHA256, PROJECT_WORKFLOW_SHA256, UNHASHABLE } from "./workflow-hash.mjs";

/** The only names this hook lets through. */
export const SAVED_NAMES = Object.freeze(["orchestrate", "orchestration:orchestrate"]);
export const LOG = "workflow-guard.jsonl";
const KNOWN_KEYS = new Set(["name", "args", "resumeFromRunId"]);
const RESUME_FILE_KEYS = new Set(["scriptPath", "resumeFromRunId", "args"]);
/** Claude Code's own run id form (the tool's schema, 2.1.326). */
export const RUN_ID = /^wf_[a-z0-9-]{6,}$/;
const WORKFLOW = ["workflows", "orchestrate.js"];

export const BLOCK_MESSAGE =
  "Workflows started by a keyword or written on the spot are off in this project. Use this project's orchestrator instead: the orchestrator agent, or the saved orchestrate workflow (/orchestrate, or /orchestration:orchestrate with the plugin), which only the person starts. Do the task without the Workflow tool, or ask the person to start the saved workflow.";

/** True when the guard is switched off: ORCH_WORKFLOW_GUARD, else the plugin option; the environment wins. @param {NodeJS.ProcessEnv} env */
export function guardOff(env) {
  const v = env.ORCH_WORKFLOW_GUARD ?? env.CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD ?? "";
  return String(v).trim().toLowerCase() === "off";
}

/**
 * The decision for one hook input. "skip": not a Workflow PreToolUse event; "allow": this repo's saved workflow (the
 * hook stays silent); "deny" with a reason code otherwise. `hashes` replaces the stored values (tests only).
 * @param {any} input
 * @param {{ env?: NodeJS.ProcessEnv, plugin?: boolean, pluginRoot?: string, hashes?: { project: string, plugin: string } }} [opts]
 * @returns {{ decision: "skip" | "allow" | "deny", reason?: string, name?: string | null, keys?: string[] }}
 */
export function workflowDecision(input, opts = {}) {
  const env = opts.env ?? process.env;
  const want = opts.hashes ?? { project: PROJECT_WORKFLOW_SHA256, plugin: PLUGIN_WORKFLOW_SHA256 };
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { decision: "skip" };
  if (input.hook_event_name !== undefined && input.hook_event_name !== "PreToolUse") return { decision: "skip" };
  if (input.tool_name !== undefined && input.tool_name !== "Workflow") return { decision: "skip" };
  const ti = input.tool_input;
  if (typeof ti !== "object" || ti === null || Array.isArray(ti)) return { decision: "deny", reason: "unknown_shape", name: null, keys: [] };
  const keys = Object.keys(ti);
  const name = typeof ti.name === "string" ? ti.name.slice(0, 80) : null;
  const out = (/** @type {string} */ reason) => ({ decision: /** @type {const} */ ("deny"), reason, name, keys });
  const allow = (/** @type {string} */ reason) => ({ decision: /** @type {const} */ ("allow"), reason, name, keys });
  if (Object.hasOwn(ti, "script")) return out("inline_script");
  if (Object.hasOwn(ti, "scriptPath")) {
    // A resume by script file: only the persisted copy of this repo's saved workflow, with the run it resumes.
    const { scriptPath: p, resumeFromRunId: id } = ti;
    if (keys.some((k) => !RESUME_FILE_KEYS.has(k)) || typeof p !== "string" || typeof id !== "string" || !RUN_ID.test(id)) return out("script_path");
    if (!isAbsolute(p) || !basename(p).endsWith(`-${id}.js`) || basename(dirname(p)) !== "scripts" || basename(dirname(dirname(p))) !== "workflows") return out("script_path");
    const sha = fileHash(p);
    return sha === want.project || sha === want.plugin ? allow("saved_workflow_resume") : out("script_path");
  }
  if (keys.some((k) => !KNOWN_KEYS.has(k))) return out("unknown_shape");
  if (Object.hasOwn(ti, "resumeFromRunId") && (typeof ti.resumeFromRunId !== "string" || !RUN_ID.test(ti.resumeFromRunId))) return out("unknown_shape");
  if (typeof ti.name !== "string") return out("unknown_shape");
  if (!SAVED_NAMES.includes(ti.name)) return out("name_not_allowed");
  const roots = [...new Set([env.CLAUDE_PROJECT_DIR, typeof input.cwd === "string" ? input.cwd : undefined].filter((r) => typeof r === "string" && r !== ""))].map(String);
  /** Hash state of `<root>/.claude/workflows/orchestrate.js` (fileHash: a hash, MISSING or UNHASHABLE). @param {string} r */
  const projectHash = (r) => fileHash(join(r, ".claude", ...WORKFLOW));
  if (ti.name === "orchestrate") {
    // Every candidate that exists must hash to the stored value; only a path where nothing exists is skipped.
    const found = roots.map(projectHash).filter((h) => h !== MISSING);
    if (found.length === 0) return out("workflow_file_missing");
    if (found.includes(UNHASHABLE)) return out("workflow_unreadable");
    return found.every((h) => h === want.project) ? allow("saved_workflow") : out("workflow_content_mismatch");
  }
  if (opts.plugin && opts.pluginRoot) {
    const h = fileHash(join(opts.pluginRoot, ...WORKFLOW));
    if (h === MISSING) return out("workflow_file_missing");
    if (h === UNHASHABLE) return out("workflow_unreadable");
    return h === want.plugin ? allow("saved_workflow") : out("workflow_content_mismatch");
  }
  // The project copy: only in this repository's layout, where the plugin is built (see the header). Same rule for
  // every candidate of every root: one that exists and cannot be hashed refuses, one of other content refuses, and
  // some root must hold both files.
  const pairs = roots.map((r) => [projectHash(r), fileHash(join(r, "dist", "plugin", ...WORKFLOW))]);
  if (pairs.some((pair) => pair.includes(UNHASHABLE))) return out("workflow_unreadable");
  const consistent = pairs.every(([p, d]) => (p === MISSING || p === want.project) && (d === MISSING || d === want.plugin));
  const builtHere = consistent && pairs.some(([p, d]) => p === want.project && d === want.plugin);
  return builtHere ? allow("plugin_built_here") : out("plugin_not_located");
}

// Entry script? Real paths on both sides (a symlinked path would otherwise skip the block).
const isEntry = () => {
  try {
    return typeof process.argv[1] === "string" && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isEntry()) {
  if (guardOff(process.env)) process.exit(0);
  if (duplicate("workflow-guard.mjs")) process.exit(0);
  /** @type {any} */
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const plugin = process.argv.includes("--plugin");
  /** @type {ReturnType<typeof workflowDecision>} */
  let d;
  try {
    // The plugin copy lives in <plugin root>/hooks, so its workflows folder is one level up.
    d = workflowDecision(input, { plugin, pluginRoot: dirname(dirname(fileURLToPath(import.meta.url))) });
  } catch {
    d = { decision: "deny", reason: "unknown_shape", name: null, keys: [] };
  }
  if (d.decision === "skip") process.exit(0);
  try {
    ensureStateDir();
    const rec = { ts: new Date().toISOString(), gate: "workflow", decision: d.decision, reason: d.reason, name: d.name ?? null, keys: d.keys ?? [], session_id: input.session_id, agent_id: input.agent_id };
    appendFileSync(join(stateDir, LOG), `${JSON.stringify(rec)}\n`);
  } catch {
    // A failed log write never changes the decision.
  }
  if (d.decision === "deny") {
    process.stderr.write(`orchestration workflow guard refused this Workflow launch (${d.reason}). ${BLOCK_MESSAGE}\n`);
    process.exit(2);
  }
  process.exit(0);
}
