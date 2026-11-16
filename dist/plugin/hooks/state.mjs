// Where orchestration state lives, shared by telemetry.mjs and review-gate.mjs (verify.sh mirrors it in bash),
// and by src/route.ts (routes.jsonl) and scripts/report.mjs from a checkout.
// Project copy (registered in .claude/settings.json): <project>/.claude/state, plus a .gitignore on first write.
// Plugin copy (hooks.json passes --plugin): a per-user dir outside the repo, keyed by the project path, so the
// logs (which hold subagent payloads) never land in a user's working tree.
// When the project registers its own copy of a hook (this repo, or a repo with .claude/ copied in), both copies
// fire on every event. The plugin copy then exits at once (duplicate) and the project copy does the work; the
// plugin hooks the project does not register use the project's state, so every gate reads one log.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN = "orchestration"; // the plugin name in scripts/build-plugin.mjs

// Plugin userConfig reaches hooks as CLAUDE_PLUGIN_OPTION_<KEY>; the hooks read ORCH_<KEY>. verify.sh has the same list.
export const OPTION_KEYS = Object.freeze([
  "TEST_CMD", "ESCALATION", "JUDGE", "JUDGE_TIMEOUT_MS", "READ_ROUTER", "GAP_MIN", "STALL_GATE", "GUARDS",
  "ALLOW_BUILTINS", "RUN_STALE_MIN", "BASELINE", "BUGFIX_CHECK", "QUOTE_CHECK", "GATE_ISOLATED", "SKILL_HINTS",
  "HANDBACK_CHECK", "ALLOW_HAIKU", "SKILL_CREATE", "SKILLS_REPO_PRIVATE", "SKILLS_REPO_PUBLIC",
]);

/**
 * Set ORCH_<KEY> from a non-empty CLAUDE_PLUGIN_OPTION_<KEY> when ORCH_<KEY> is unset; an explicit ORCH_ value wins.
 * Runs once at import on process.env (the only side effect of importing this module besides reading settings).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function bridgeOptions(env = process.env) {
  for (const k of OPTION_KEYS) {
    const opt = env[`CLAUDE_PLUGIN_OPTION_${k}`];
    if (env[`ORCH_${k}`] === undefined && opt) env[`ORCH_${k}`] = opt;
  }
  return env;
}
bridgeOptions();

// The project's own settings register .claude/hooks/<script>, and the script is there.
/** @param {string} project @param {string} script */
export function projectRegisters(project, script) {
  if (!existsSync(join(project, ".claude", "hooks", script))) return false;
  return ["settings.json", "settings.local.json"].some((f) => {
    try {
      return readFileSync(join(project, ".claude", f), "utf8").includes(`.claude/hooks/${script}`);
    } catch {
      return false;
    }
  });
}

// Bytes, not UTF-16 units, so verify.sh's `LC_ALL=C tr` gives the same key for a non-ASCII path.
/** @param {string} project */
export const stateKey = (project) => Buffer.from(project).toString("latin1").replace(/[^A-Za-z0-9]/g, "-").slice(-200);

/**
 * State dir for a writer in `project`. The project copy of the hooks (plugin: false) always uses .claude/state;
 * any other writer (a plugin hook, the /route triager) uses it only where the project registers its own telemetry
 * hook, and otherwise the per-user dir.
 * @param {string} project
 * @param {{ plugin?: boolean, env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ dir: string, inProject: boolean }}
 */
export function stateDirFor(project, { plugin = true, env = process.env } = {}) {
  const inProject = !plugin || projectRegisters(project, "telemetry.mjs");
  const dir = inProject
    ? join(project, ".claude", "state")
    : join(env.CLAUDE_PLUGIN_DATA || join(homedir(), ".claude", "orchestration"), "state", stateKey(project));
  return { dir, inProject };
}

/**
 * Every per-user dir that may hold a project's plugin state, most likely first: $CLAUDE_PLUGIN_DATA, each installed
 * copy's plugin data dir (Claude Code sets CLAUDE_PLUGIN_DATA for hooks, not in a terminal), then the fallback.
 * @param {string} project
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string[]}
 */
export function userStateDirs(project, env = process.env) {
  const data = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "plugins", "data");
  /** @type {string[]} */
  let installed = [];
  try {
    installed = readdirSync(data)
      .filter((d) => d === PLUGIN || d.startsWith(`${PLUGIN}-`))
      .map((d) => join(data, d));
  } catch {
    // no plugin data dir yet
  }
  const roots = /** @type {string[]} */ ([env.CLAUDE_PLUGIN_DATA, ...installed, join(homedir(), ".claude", "orchestration")].filter(Boolean));
  return [...new Set(roots.map((r) => join(r, "state", stateKey(project))))];
}

const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const plugin = process.argv.includes("--plugin");

// This is the plugin copy of a hook the project also registers: exit 0 and leave the event to the project copy.
/** @param {string} script */
export const duplicate = (script) => plugin && projectRegisters(project, script);

const own = stateDirFor(project, { plugin });
export const stateDir = own.dir;

/** @param {{ dir: string, inProject: boolean }} [state] */
export function ensureStateDir(state = own) {
  mkdirSync(state.dir, { recursive: true });
  if (state.inProject && !existsSync(join(state.dir, ".gitignore"))) writeFileSync(join(state.dir, ".gitignore"), "*\n");
}

// Hand-back captures (handbacks.jsonl). In auto mode a worker delivers its report through the SubagentHandback tool;
// the SubagentStop that follows carries no last_assistant_message, and the subagent transcript does not yet hold the
// report just handed back. So handback-check.mjs (PreToolUse on SubagentHandback, already registered there) appends the
// report's parsed fields here, keyed by session and agent id, and journal.mjs and telemetry.mjs read the latest one at
// SubagentStop. Parsed fields only, never report text. A capture is never cleared (journal and telemetry run at the same
// stop and may run at the same time): it belongs to a stop when it is newer than that hook's own previous stop record
// of the agent, so a resumed agent whose next run ends without a hand-back falls back to today's sources.
export const HANDBACK_LOG = "handbacks.jsonl";

/** Records of a JSON-lines log in `dir` for one session and agent; [] when unreadable. @param {string} dir @param {string} name @param {string} sessionId @param {string} agentId */
function agentRecords(dir, name, sessionId, agentId) {
  const needle = JSON.stringify(agentId);
  try {
    return readFileSync(join(dir, name), "utf8")
      .split("\n")
      .filter((l) => l.includes(needle))
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e && typeof e === "object" && e.agent_id === agentId && (e.session_id ?? "") === sessionId);
  } catch {
    return [];
  }
}

/**
 * Append a hand-back capture. Never throws; false when it was not written.
 * @param {Record<string, unknown>} capture parsed fields of the report, with session_id and agent_id
 */
export function recordHandback(capture) {
  try {
    ensureStateDir();
    appendFileSync(join(stateDir, HANDBACK_LOG), `${JSON.stringify({ ts: new Date().toISOString(), ...capture })}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The latest hand-back capture of an agent that is newer than the agent's latest record in the caller's own stop logs
 * (`stopLogs`, filtered by `isStop`), or null: none, no agent id, or only captures an earlier stop already used.
 * @param {string} sessionId @param {string | null} agentId @param {string[]} stopLogs
 * @param {(r: any) => boolean} [isStop] @param {string} [dir]
 * @returns {Record<string, any> | null}
 */
export function handbackFor(sessionId, agentId, stopLogs, isStop = () => true, dir = stateDir) {
  if (typeof agentId !== "string" || !agentId) return null;
  const capture = agentRecords(dir, HANDBACK_LOG, sessionId, agentId).at(-1);
  const at = Date.parse(capture?.ts);
  if (!capture || !Number.isFinite(at)) return null;
  for (const name of stopLogs) {
    for (const r of agentRecords(dir, name, sessionId, agentId)) {
      if (isStop(r) && Date.parse(r.ts) >= at) return null;
    }
  }
  return capture;
}
