// The subagent types Claude Code ships itself, in one place. The run's gates track only this plugin's researcher,
// implementer, reviewer and integrator, so everything named here is blocked while a run is open (plan-check.mjs) and
// denied in this repo's own sessions (DENIED_AGENTS in src/config.ts, permissions.deny in .claude/settings.json).
//
// A Claude Code update can add a built-in type: 2.1.325 added web-fetch. Until this list names it, the plan check treats
// it as somebody's own agent and lets it through. Two things close that gap:
//   - scripts/claude-update.mjs asks the installed Claude Code for its built-in types (no model call). With --fix it
//     writes the ones missing here to the per-user file below, which this module adds to the list at once, on that
//     machine, without a new release. With --write-source it adds them to BUILTIN_AGENTS and to permissions.deny.
//   - src/policy.test.ts keeps this list, DENIED_AGENTS and permissions.deny in step.
// No side effects at import, Node built-ins only, and nothing here throws.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Built-in types as of Claude Code 2.1.325. claude-code-guide exists in interactive sessions only. */
export const BUILTIN_AGENTS = Object.freeze([
  "general-purpose", "claude", "Explore", "Plan", "claude-code-guide", "statusline-setup", "web-fetch",
]);
/** A fork subagent inherits the whole conversation and every tool; it is blocked with the built-ins. */
export const FORK = "fork";
/** This plugin's own agent names: never treated as built-in, whatever a learned file says. */
export const OWN_AGENTS = Object.freeze(["orchestrator", "researcher", "implementer", "reviewer", "integrator"]);
const NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * The per-user file scripts/claude-update.mjs writes: {v: 1, claude_code_version, agents: [name, ...]}.
 * ORCH_BUILTINS_FILE names another file; an empty value means no file.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function learnedFile(env = process.env) {
  if (env.ORCH_BUILTINS_FILE !== undefined) return env.ORCH_BUILTINS_FILE || null;
  return join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "orchestration", "builtin-agents.json");
}

/**
 * Built-in names learned on this machine: plain names only, never one of this plugin's own, at most 64. A missing or
 * malformed file gives [].
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function learnedBuiltins(env = process.env) {
  const file = learnedFile(env);
  if (!file) return [];
  try {
    const agents = JSON.parse(readFileSync(file, "utf8"))?.agents;
    if (!Array.isArray(agents)) return [];
    return agents.filter((a) => typeof a === "string" && NAME_RE.test(a) && !OWN_AGENTS.includes(a)).slice(0, 64);
  } catch {
    return [];
  }
}

/**
 * Every agent type the gates treat as built-in: the list above, the names learned on this machine, and fork.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Set<string>}
 */
export function builtinAgents(env = process.env) {
  return new Set([FORK, ...BUILTIN_AGENTS, ...learnedBuiltins(env)]);
}
