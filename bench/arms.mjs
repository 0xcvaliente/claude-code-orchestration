// Benchmark arms: how each run is launched through the product scripts (unmodified) and what .claude/ its repo gets.
//   P-S    plain Sonnet session     scripts/orchestrate.sh, ORCH_AGENT=none, ORCH_MODEL=sonnet, no .claude/ copied
//   P-O    plain Opus session       same with ORCH_MODEL=opus
//   O-mix  orchestrator, agents as shipped (this repo's .claude/ copied in)
//   O-O    orchestrator, every agent's model: line rewritten to opus
//   AUTO   scripts/auto.sh (triage picks plain, reviewed or the orchestrator); .claude/ copied, settings model sonnet
//   N-UC   native ultracode: Claude Code as shipped (built-in and fork subagents allowed; launcher "native", bench/lib/native-launch.sh),
//          no .claude/ copied (user plugins disabled, so the orchestration plugin is not loaded), ORCH_MODEL=opus, prompt prefixed
//          NUC_PREFIX ("ultracode" plus a plain request for a workflow), Workflow allowed; rows record workflow_runs (N-UC, W-mix)
//   W-mix  the shipped gated workflow: this repo's .claude/ copied in (agents, hooks, .claude/workflows/orchestrate.js), plain main
//          thread through scripts/orchestrate.sh, prompt "/orchestrate {task, code, baseRefHead}", Workflow allowed
//   SDK    the SDK pipeline (npx tsx src/cli.ts --mode orchestrate), no .claude/ copied, no mid-run snapshots (launcher "sdk", bench/lib/sdk.mjs)
//   O-mix-plugin  orchestrator from this checkout's plugin build dist/plugin, loaded with --plugin-dir (launcher "plugin",
//          bench/lib/plugin-launch.sh), ORCH_AGENT_PREFIX=orchestration:, no .claude/ copied, shipped models
//   O-mix-030     the same from the 0.3.0 plugin: dist/plugin at ref BASELINE_030_REF (ef62288), extracted with git archive
//   all-haiku     O-mix as shipped (researcher on haiku, today's default); the d2-docs researcher comparison (H14)
//   all-sonnet    O-mix with CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 and CLAUDE_CODE_SUBAGENT_MODEL=sonnet: forces EVERY subagent
//          (researcher, implementer, reviewer, integrator) to sonnet, not the researcher alone
//   routed        O-mix with ORCH_READ_ROUTER=on (the read router lands in a later 0.4.0 slice; the arm only sets the variable)
//   reader-haiku  d3-reader router arms (H14 amendment for d3-reader). A PLAIN sonnet main session (ORCH_AGENT=none, ORCH_MODEL=sonnet,
//          no orchestrator) with this checkout's .claude/ copied in, so the project researcher (haiku as shipped) and the hooks (plan
//          check with the router, telemetry, quote check) are present; the task's driver prompt makes it launch one researcher per
//          question. ORCH_SESSION_PERSISTENCE=1 asks scripts/orchestrate.sh to keep subagent transcripts, so telemetry's SubagentStop
//          records carry per-agent tokens (without it those fields are empty). The existing plain-session path needs no runner change.
//   reader-sonnet the same with CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1 and CLAUDE_CODE_SUBAGENT_MODEL=sonnet (every subagent here is a researcher)
//   reader-routed the same as reader-haiku with ORCH_READ_ROUTER=on (raises hard files to sonnet and appends converted-text notes)
// Every run repo gets .claude/settings.json with "enabledPlugins": {<each user-enabled plugin>: false}.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { mergeSettings } from "./lib/run-core.mjs";
import { sdkCommand } from "./lib/sdk.mjs";

// "ultracode" alone does not opt in under -p (workflows doc); a plain request does (haiku probe on 2.1.314, bench/README.md).
export const NUC_PREFIX = "ultracode Use a workflow (the Workflow tool) to orchestrate this task.\n\n";

// The 0.3.0 release commit: its committed dist/plugin is the O-mix-030 baseline.
export const BASELINE_030_REF = "ef62288";
const PLUGIN_ENV = { ORCH_AGENT: "orchestrator", ORCH_AGENT_PREFIX: "orchestration:" };
// d3-reader arms: a plain sonnet main session (no orchestrator) that keeps subagent transcripts (per-agent telemetry tokens).
export const READER_ENV = Object.freeze({ ORCH_AGENT: "none", ORCH_MODEL: "sonnet", ORCH_SESSION_PERSISTENCE: "1" });

export const ARMS = {
  "P-S": { label: "Plain session (Sonnet)", script: "orchestrate.sh", env: { ORCH_AGENT: "none", ORCH_MODEL: "sonnet" }, copyClaude: false },
  "P-O": { label: "Plain session (Opus)", script: "orchestrate.sh", env: { ORCH_AGENT: "none", ORCH_MODEL: "opus" }, copyClaude: false },
  "O-mix": { label: "Orchestrator, shipped models", script: "orchestrate.sh", env: { ORCH_AGENT: "orchestrator" }, copyClaude: true },
  "O-O": { label: "Orchestrator, all agents Opus", script: "orchestrate.sh", env: { ORCH_AGENT: "orchestrator" }, copyClaude: true, agentModel: "opus" },
  AUTO: { label: "Auto (triage routes)", script: "auto.sh", env: { ORCH_AGENT: "orchestrator" }, copyClaude: true, settings: { model: "sonnet" } },
  "N-UC": { label: "Native ultracode (plugin off, built-ins allowed, Opus)", launcher: "native", env: { ORCH_AGENT: "none", ORCH_MODEL: "opus" }, copyClaude: false, extraAllowed: ["Workflow"], recordWorkflow: true, prompt: (p) => `${NUC_PREFIX}${p}` },
  "W-mix": { label: "Gated workflow (/orchestrate), shipped models", script: "orchestrate.sh", env: { ORCH_AGENT: "none" }, copyClaude: true, extraAllowed: ["Workflow"], recordWorkflow: true, prompt: (p) => `/orchestrate ${JSON.stringify({ task: p, code: true, baseRefHead: true })}` },
  SDK: { label: "SDK pipeline (orchestrate mode)", launcher: "sdk", env: {}, copyClaude: false, snapshots: false },
  "O-mix-plugin": { label: "Orchestrator, current plugin build (--plugin-dir dist/plugin)", launcher: "plugin", pluginRef: null, env: PLUGIN_ENV, copyClaude: false },
  "O-mix-030": { label: "Orchestrator, 0.3.0 plugin (dist/plugin at ef62288, --plugin-dir)", launcher: "plugin", pluginRef: BASELINE_030_REF, env: PLUGIN_ENV, copyClaude: false },
  "all-haiku": { label: "Orchestrator, researcher on haiku (shipped default)", script: "orchestrate.sh", env: { ORCH_AGENT: "orchestrator" }, copyClaude: true },
  "all-sonnet": { label: "Orchestrator, every subagent forced to sonnet (CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1)", script: "orchestrate.sh", env: { ORCH_AGENT: "orchestrator", CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" }, copyClaude: true },
  routed: { label: "Orchestrator, read router on (ORCH_READ_ROUTER=on)", script: "orchestrate.sh", env: { ORCH_AGENT: "orchestrator", ORCH_READ_ROUTER: "on" }, copyClaude: true },
  "reader-haiku": { label: "Plain sonnet session launching researchers, researcher on haiku (shipped)", script: "orchestrate.sh", env: { ...READER_ENV }, copyClaude: true },
  "reader-sonnet": { label: "Plain sonnet session launching researchers, every subagent forced to sonnet (CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1)", script: "orchestrate.sh", env: { ...READER_ENV, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: "1", CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" }, copyClaude: true },
  "reader-routed": { label: "Plain sonnet session launching researchers, read router on (ORCH_READ_ROUTER=on)", script: "orchestrate.sh", env: { ...READER_ENV, ORCH_READ_ROUTER: "on" }, copyClaude: true },
};

export function armOf(id) {
  const arm = ARMS[id];
  if (!arm) throw new Error(`unknown arm ${id} (known: ${Object.keys(ARMS).join(", ")})`);
  return arm;
}

// The variables a run adds to the environment (printed by --dry-run).
export function envAdditions(armId, meta, run) {
  const arm = armOf(armId);
  const add = { ...arm.env };
  if (arm.launcher === "sdk") return add; // flags, not ORCH_* variables (see sdkCommand); ANTHROPIC_* passes through runEnv
  if (meta.test_cmd) add.ORCH_TEST_CMD = meta.test_cmd;
  if (run.budget_tokens != null) add.ORCH_BUDGET_TOKENS = String(run.budget_tokens);
  add.ORCH_EXTRA_ALLOWED_TOOLS = ["Bash(date*)", ...(arm.extraAllowed ?? [])].join("\n");
  add.ORCH_NO_NUDGE = "1";
  return add;
}

// process.env without any inherited ORCH_* (a stray ORCH_MODEL or ORCH_BUDGET_TOKENS must not leak into an arm), plus the arm's.
export function runEnv(armId, meta, run, base = process.env) {
  const env = Object.fromEntries(Object.entries(base).filter(([k]) => !k.startsWith("ORCH_")));
  return { ...env, ...envAdditions(armId, meta, run) };
}

// The plugin folder a "plugin" arm loads: this checkout's dist/plugin, or, for a pinned ref, a cache folder under base
// (default <tmpdir>/orch-bench-plugin) that ensurePluginDir fills. null for other arms.
export function pluginDirFor(armId, root, base = join(tmpdir(), "orch-bench-plugin")) {
  const arm = armOf(armId);
  if (arm.launcher !== "plugin") return null;
  return arm.pluginRef ? join(base, arm.pluginRef, "dist", "plugin") : join(root, "dist", "plugin");
}

// Extracts dist/plugin at the arm's ref (`git archive <ref> dist/plugin`) once, reused while its plugin.json exists.
// Returns the folder; throws when the ref or its dist/plugin is missing.
export function ensurePluginDir(armId, root, base) {
  const dir = pluginDirFor(armId, root, base);
  if (!dir || existsSync(join(dir, ".claude-plugin", "plugin.json"))) return dir;
  const arm = armOf(armId);
  const top = join(dir, "..", "..");
  const tmp = `${top}.partial-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  try {
    const archive = spawnSync("git", ["-C", root, "archive", arm.pluginRef, "dist/plugin"], { maxBuffer: 256 * 1024 * 1024 });
    if (archive.status !== 0) throw new Error(`git archive ${arm.pluginRef} dist/plugin: ${String(archive.stderr).trim()}`);
    const tar = spawnSync("tar", ["-x", "-C", tmp], { input: archive.stdout });
    if (tar.status !== 0) throw new Error(`tar -x: ${String(tar.stderr).trim()}`);
    if (!existsSync(join(tmp, "dist", "plugin", ".claude-plugin", "plugin.json"))) throw new Error(`no dist/plugin/.claude-plugin/plugin.json at ${arm.pluginRef}`);
    rmSync(top, { recursive: true, force: true });
    renameSync(tmp, top);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return dir;
}

// opts (SDK arm only): {outDir, testCmd, budgetTokens}.
export function command(armId, prompt, runRepo, root, opts = {}) {
  const arm = armOf(armId);
  if (arm.launcher === "sdk") return sdkCommand({ prompt, runRepo, root, ...opts });
  const p = arm.prompt ? arm.prompt(prompt) : prompt; // N-UC and W-mix wrap the task prompt
  if (arm.launcher === "plugin") return { cmd: "bash", args: [join(root, "bench", "lib", "plugin-launch.sh"), root, p, runRepo, pluginDirFor(armId, root)], cwd: root };
  if (arm.launcher === "native") return { cmd: "bash", args: [join(root, "bench", "lib", "native-launch.sh"), root, p, runRepo], cwd: root };
  return { cmd: "bash", args: [join(root, "scripts", arm.script), p, runRepo], cwd: root };
}

// Writes the run repo's .claude/: a copy of root/.claude (without state/ and worktrees/) for orchestrator arms,
// agent models rewritten for O-O, then settings.json merged with the disabled plugins.
export function prepareClaudeDir(armId, runRepo, root, disabledIds) {
  const arm = armOf(armId);
  if (arm.launcher === "plugin") ensurePluginDir(armId, root); // the plugin folder must exist before the launch
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
  }
  mkdirSync(dest, { recursive: true });
  const file = join(dest, "settings.json");
  const existing = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, `${JSON.stringify(mergeSettings(existing, disabledIds, arm.settings ?? {}), null, 2)}\n`);
}
