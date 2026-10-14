// Where orchestration state lives, shared by telemetry.mjs and review-gate.mjs (verify.sh mirrors it in bash),
// and by src/route.ts (routes.jsonl) and scripts/report.mjs from a checkout.
// Project copy (registered in .claude/settings.json): <project>/.claude/state, plus a .gitignore on first write.
// Plugin copy (hooks.json passes --plugin): a per-user dir outside the repo, keyed by the project path, so the
// logs (which hold subagent payloads) never land in a user's working tree.
// When the project registers its own copy of a hook (this repo, or a repo with .claude/ copied in), both copies
// fire on every event. The plugin copy then exits at once (duplicate) and the project copy does the work; the
// plugin hooks the project does not register use the project's state, so every gate reads one log.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const PLUGIN = "orchestration"; // the plugin name in scripts/build-plugin.mjs

// The project's own settings register .claude/hooks/<script>, and the script is there.
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
  let installed = [];
  try {
    installed = readdirSync(data)
      .filter((d) => d === PLUGIN || d.startsWith(`${PLUGIN}-`))
      .map((d) => join(data, d));
  } catch {
    // no plugin data dir yet
  }
  const roots = [env.CLAUDE_PLUGIN_DATA, ...installed, join(homedir(), ".claude", "orchestration")].filter(Boolean);
  return [...new Set(roots.map((r) => join(r, "state", stateKey(project))))];
}

const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const plugin = process.argv.includes("--plugin");

// This is the plugin copy of a hook the project also registers: exit 0 and leave the event to the project copy.
export const duplicate = (script) => plugin && projectRegisters(project, script);

const own = stateDirFor(project, { plugin });
export const stateDir = own.dir;

/** @param {{ dir: string, inProject: boolean }} [state] */
export function ensureStateDir(state = own) {
  mkdirSync(state.dir, { recursive: true });
  if (state.inProject && !existsSync(join(state.dir, ".gitignore"))) writeFileSync(join(state.dir, ".gitignore"), "*\n");
}
