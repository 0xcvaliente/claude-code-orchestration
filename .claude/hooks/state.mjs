// Where the hooks keep their logs, shared by telemetry.mjs and review-gate.mjs (verify.sh mirrors it in bash).
// Project copy (registered in .claude/settings.json): <project>/.claude/state, plus a .gitignore on first write.
// Plugin copy (hooks.json passes --plugin): a per-user dir outside the repo, keyed by the project path, so the
// logs (which hold subagent payloads) never land in a user's working tree.
// When the project registers its own copy of a hook (this repo, or a repo with .claude/ copied in), both copies
// fire on every event. The plugin copy then exits at once (duplicate) and the project copy does the work; the
// plugin hooks the project does not register use the project's state, so every gate reads one log.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const project = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const plugin = process.argv.includes("--plugin");

// The project's own settings register .claude/hooks/<script>, and the script is there.
function projectRegisters(script) {
  if (!existsSync(join(project, ".claude", "hooks", script))) return false;
  return ["settings.json", "settings.local.json"].some((f) => {
    try {
      return readFileSync(join(project, ".claude", f), "utf8").includes(`.claude/hooks/${script}`);
    } catch {
      return false;
    }
  });
}

// This is the plugin copy of a hook the project also registers: exit 0 and leave the event to the project copy.
export const duplicate = (script) => plugin && projectRegisters(script);

const inProject = !plugin || projectRegisters("telemetry.mjs");
// Bytes, not UTF-16 units, so verify.sh's `LC_ALL=C tr` gives the same key for a non-ASCII path.
const key = Buffer.from(project).toString("latin1").replace(/[^A-Za-z0-9]/g, "-").slice(-200);
export const stateDir = inProject
  ? join(project, ".claude", "state")
  : join(process.env.CLAUDE_PLUGIN_DATA || join(homedir(), ".claude", "orchestration"), "state", key);

export function ensureStateDir() {
  mkdirSync(stateDir, { recursive: true });
  if (inProject && !existsSync(join(stateDir, ".gitignore"))) writeFileSync(join(stateDir, ".gitignore"), "*\n");
}
