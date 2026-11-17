#!/usr/bin/env node
// PreToolUse hook (matcher Workflow): refuses every Workflow launch except this repo's saved workflow. Claude Code's
// keyword `ultracode` in a typed prompt, or a plain request for a workflow, makes the model write a workflow script on the
// spot and start it with Claude Code's own agents, outside the plan check, the run journal and the review rules. Claude
// Code's own off switches (the `disableWorkflows` setting, CLAUDE_CODE_DISABLE_WORKFLOWS=1) would also remove saved
// workflows, and so the gated workflow `.claude/workflows/orchestrate.js` (`/orchestrate`, plugin copy
// `/orchestration:orchestrate`), so this hook narrows the tool instead of removing it. A plugin cannot ship
// permissions.deny, so a hook is the only refusal the plugin can carry.
//
// Silent (exit 0, no output) only when every one of these holds:
// - tool_input is an object whose keys are `name` and optionally `args` and `resumeFromRunId` (a string), and nothing
//   else: no `script` (a script written on the spot), no `scriptPath` (a script file on disk), no key this hook does not
//   know (fail closed);
// - `name` is exactly `orchestrate` or `orchestration:orchestrate`;
// - the saved file exists where Claude Code loads it from, where this hook can tell: `orchestrate` from
//   <CLAUDE_PROJECT_DIR or the input's cwd>/.claude/workflows/orchestrate.js; `orchestration:orchestrate`, for the plugin
//   copy of this hook, from the plugin's own workflows/orchestrate.js (the folder above this file). The project copy
//   cannot see where the plugin is installed and lets that name through.
// Shapes observed live (Claude Code 2.1.326, docs/data/live-checks-2026-11-17.md, Check 5): an ad-hoc launch reaches
// PreToolUse as {"script": "<the whole script>"}; a saved launch as {"name": "orchestrate", "args": {...}}.
// `scriptPath` and `resumeFromRunId` come from the tool's schema text in the binary, not from a probe.
//
// Deny-only: exit 2 with the reason on stderr, or exit 0 with no output; never an allow or ask decision (plan-check.mjs
// stays the only hook that returns an allow). Input that is not JSON, and an event for another tool or another hook
// event, exit 0 (hooks exit 0 on malformed input). The plugin copy exits on duplicate() where the project registers its
// own. ORCH_WORKFLOW_GUARD=off (plugin setting workflow_guard, read as CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD; the
// environment wins) turns it off. One record per decision in workflow-guard.jsonl in the state dir: the reason code, the
// workflow name (at most 80 characters) and the input's key names; never the script or the arguments.
// The block message is model-facing: it names no switch and no Claude Code agent type.
import { appendFileSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

/** The only names this hook lets through. */
export const SAVED_NAMES = Object.freeze(["orchestrate", "orchestration:orchestrate"]);
export const LOG = "workflow-guard.jsonl";
const KNOWN_KEYS = new Set(["name", "args", "resumeFromRunId"]);

export const BLOCK_MESSAGE =
  "Workflows started by a keyword or written on the spot are off in this project. Use this project's orchestrator instead: the orchestrator agent, or the saved orchestrate workflow (/orchestrate, or /orchestration:orchestrate with the plugin), which only the person starts. Do the task without the Workflow tool, or ask the person to start the saved workflow.";

/** True when the guard is switched off: ORCH_WORKFLOW_GUARD, else the plugin option; the environment wins. @param {NodeJS.ProcessEnv} env */
export function guardOff(env) {
  const v = env.ORCH_WORKFLOW_GUARD ?? env.CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD ?? "";
  return String(v).trim().toLowerCase() === "off";
}

/** @param {string} p */
const isFile = (p) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * The decision for one hook input. "skip": not a Workflow PreToolUse event; "allow": this repo's saved workflow (the
 * hook stays silent); "deny" with a reason code otherwise.
 * @param {any} input
 * @param {{ env?: NodeJS.ProcessEnv, plugin?: boolean, pluginRoot?: string }} [opts]
 * @returns {{ decision: "skip" | "allow" | "deny", reason?: string, name?: string | null, keys?: string[] }}
 */
export function workflowDecision(input, opts = {}) {
  const env = opts.env ?? process.env;
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { decision: "skip" };
  if (input.hook_event_name !== undefined && input.hook_event_name !== "PreToolUse") return { decision: "skip" };
  if (input.tool_name !== undefined && input.tool_name !== "Workflow") return { decision: "skip" };
  const ti = input.tool_input;
  if (typeof ti !== "object" || ti === null || Array.isArray(ti)) return { decision: "deny", reason: "unknown_shape", name: null, keys: [] };
  const keys = Object.keys(ti);
  const name = typeof ti.name === "string" ? ti.name.slice(0, 80) : null;
  const out = (/** @type {string} */ reason) => ({ decision: /** @type {const} */ ("deny"), reason, name, keys });
  if (Object.hasOwn(ti, "script")) return out("inline_script");
  if (Object.hasOwn(ti, "scriptPath")) return out("script_path");
  if (keys.some((k) => !KNOWN_KEYS.has(k))) return out("unknown_shape");
  if (Object.hasOwn(ti, "resumeFromRunId") && typeof ti.resumeFromRunId !== "string") return out("unknown_shape");
  if (typeof ti.name !== "string") return out("unknown_shape");
  if (!SAVED_NAMES.includes(ti.name)) return out("name_not_allowed");
  if (ti.name === "orchestrate") {
    const roots = [env.CLAUDE_PROJECT_DIR, typeof input.cwd === "string" ? input.cwd : undefined].filter((r) => typeof r === "string" && r);
    if (!roots.some((r) => isFile(join(String(r), ".claude", "workflows", "orchestrate.js")))) return out("workflow_file_missing");
  } else if (opts.plugin && opts.pluginRoot && !isFile(join(opts.pluginRoot, "workflows", "orchestrate.js"))) {
    return out("workflow_file_missing");
  }
  return { decision: "allow", reason: "saved_workflow", name, keys };
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
