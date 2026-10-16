// Benchmark arms: how each run is launched through the product scripts (unmodified) and what .claude/ its repo gets.
//   P-S    plain Sonnet session     scripts/orchestrate.sh, ORCH_AGENT=none, ORCH_MODEL=sonnet, no .claude/ copied
//   P-O    plain Opus session       same with ORCH_MODEL=opus
//   O-mix  orchestrator, agents as shipped (this repo's .claude/ copied in)
//   O-O    orchestrator, every agent's model: line rewritten to opus
//   O-next orchestrator as O-mix plus the bench/variants/o-next.mjs overlay (plan check and review, per-slice review,
//          editor slice, run journal)
//   AUTO   scripts/auto.sh (triage picks plain, reviewed or the orchestrator); .claude/ copied, settings model sonnet
// Every run repo gets .claude/settings.json with "enabledPlugins": {<each user-enabled plugin>: false}.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { mergeSettings } from "./lib/run-core.mjs";
import { applyONext } from "./variants/o-next.mjs";

const VARIANTS = { "o-next": applyONext };

export const ARMS = {
  "P-S": { label: "Plain session (Sonnet)", script: "orchestrate.sh", env: { ORCH_AGENT: "none", ORCH_MODEL: "sonnet" }, copyClaude: false },
  "P-O": { label: "Plain session (Opus)", script: "orchestrate.sh", env: { ORCH_AGENT: "none", ORCH_MODEL: "opus" }, copyClaude: false },
  "O-mix": { label: "Orchestrator, shipped models", script: "orchestrate.sh", env: { ORCH_AGENT: "orchestrator" }, copyClaude: true },
  "O-O": { label: "Orchestrator, all agents Opus", script: "orchestrate.sh", env: { ORCH_AGENT: "orchestrator" }, copyClaude: true, agentModel: "opus" },
  "O-next": { label: "Orchestrator, revised proposals", script: "orchestrate.sh", env: { ORCH_AGENT: "orchestrator" }, copyClaude: true, variant: "o-next" },
  AUTO: { label: "Auto (triage routes)", script: "auto.sh", env: { ORCH_AGENT: "orchestrator" }, copyClaude: true, settings: { model: "sonnet" } },
};

export function armOf(id) {
  const arm = ARMS[id];
  if (!arm) throw new Error(`unknown arm ${id} (known: ${Object.keys(ARMS).join(", ")})`);
  return arm;
}

// The variables a run adds to the environment (printed by --dry-run).
export function envAdditions(armId, meta, run) {
  const add = { ...armOf(armId).env };
  if (meta.test_cmd) add.ORCH_TEST_CMD = meta.test_cmd;
  if (run.budget_tokens != null) add.ORCH_BUDGET_TOKENS = String(run.budget_tokens);
  add.ORCH_EXTRA_ALLOWED_TOOLS = "Bash(date*)";
  add.ORCH_NO_NUDGE = "1";
  return add;
}

// process.env without any inherited ORCH_* (a stray ORCH_MODEL or ORCH_BUDGET_TOKENS must not leak into an arm), plus the arm's.
export function runEnv(armId, meta, run, base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith("ORCH_")));
  return { ...env, ...envAdditions(armId, meta, run) };
}

export function command(armId, prompt, runRepo, root) {
  return { cmd: "bash", args: [join(root, "scripts", armOf(armId).script), prompt, runRepo], cwd: root };
}

// Writes the run repo's .claude/: a copy of root/.claude (without state/ and worktrees/) for orchestrator arms,
// agent models rewritten for O-O, a variant overlay applied for O-next, then settings.json merged with the disabled plugins.
export function prepareClaudeDir(armId, runRepo, root, disabledIds) {
  const arm = armOf(armId);
  const dest = join(runRepo, ".claude");
  const src = join(root, ".claude");
  if (arm.copyClaude) {
    cpSync(src, dest, {
      recursive: true,
      filter: (p) => {
        const rel = relative(src, p).split(sep);
        return rel[0] !== "state" && rel[0] !== "worktrees";
      },
    });
    if (arm.agentModel) {
      const agents = join(dest, "agents");
      for (const f of readdirSync(agents).filter((n) => n.endsWith(".md"))) {
        const file = join(agents, f);
        writeFileSync(file, readFileSync(file, "utf8").replace(/^model:.*$/m, `model: ${arm.agentModel}`));
      }
    }
    if (arm.variant) VARIANTS[arm.variant](dest);
  }
  mkdirSync(dest, { recursive: true });
  const file = join(dest, "settings.json");
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, `${JSON.stringify(mergeSettings(existing, disabledIds, arm.settings ?? {}), null, 2)}\n`);
}
