#!/usr/bin/env node
// Assembles dist/plugin from .claude/ so the orchestrator can be installed as a Claude Code plugin.
// Usage: node scripts/build-plugin.mjs   then   claude --plugin-dir dist/plugin   or   claude plugin validate dist/plugin
// Plugin agents are namespaced, so the orchestrator's Agent(...) allowlist is rewritten to "orchestration:<name>".
// Project settings (the permissions.deny list) are not part of a plugin; add them to your own settings.
// dashboard/ (the live orchestration pane, a function-hooks module) ships twice: inside the plugin, so an installed
// orchestrator shows it, and alone as dist/dashboard for `claude --agent orchestrator --plugin-dir dist/dashboard`.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAME = "orchestration";
const src = join(process.cwd(), ".claude");
// --check builds into a temp dir and fails when the committed dist/plugin differs, like `npm run check-agents`.
const check = process.argv.includes("--check");
const committedRoot = join(process.cwd(), "dist");
const outRoot = check ? mkdtempSync(join(tmpdir(), "orch-plugin-")) : committedRoot;
const out = join(outRoot, "plugin");
const dash = join(outRoot, "dashboard");
const dashSrc = join(process.cwd(), "dashboard");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

rmSync(out, { recursive: true, force: true });
rmSync(dash, { recursive: true, force: true });
mkdirSync(join(out, ".claude-plugin"), { recursive: true });
mkdirSync(join(out, "hooks"), { recursive: true });
mkdirSync(join(out, "types"), { recursive: true });
for (const d of [join(dash, ".claude-plugin"), join(dash, "hooks"), join(dash, "types")]) mkdirSync(d, { recursive: true });

cpSync(join(src, "agents"), join(out, "agents"), { recursive: true });
cpSync(join(src, "skills"), join(out, "skills"), { recursive: true });
for (const f of readdirSync(join(src, "hooks"))) cpSync(join(src, "hooks", f), join(out, "hooks", f));

const orch = join(out, "agents", "orchestrator.md");
writeFileSync(
  orch,
  readFileSync(orch, "utf8").replace(/^tools: Agent\(([^)]*)\)/m, (_, /** @type {string} */ list) => {
    const names = list.split(",").map((n) => `${NAME}:${n.trim()}`).join(", ");
    return `tools: Agent(${names})`;
  }),
);

// --plugin: keep state outside the user's repo, and step aside where the project registers its own copy (state.mjs).
/** @param {string} script */
const run = (script) => `${script.endsWith(".mjs") ? `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${script}"` : `"\${CLAUDE_PLUGIN_ROOT}/hooks/${script}"`} --plugin`;
const hooks = {
  hooks: {
    SessionStart: [{ hooks: [{ type: "command", command: run("nudge.mjs") }] }],
    PreToolUse: [{ matcher: "Agent|Task", hooks: [{ type: "command", command: run("plan-check.mjs") }] }],
    PostToolUse: [{ matcher: "Agent|Task", hooks: [{ type: "command", command: run("journal.mjs") }] }],
    SubagentStart: [{ hooks: [{ type: "command", command: run("telemetry.mjs") }] }],
    SubagentStop: [
      { hooks: [{ type: "command", command: run("telemetry.mjs") }] },
      { hooks: [{ type: "command", command: run("journal.mjs") }] },
      { matcher: `${NAME}:implementer`, hooks: [{ type: "command", command: run("verify.sh") }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: run("review-gate.mjs") }] }],
  },
};
// The module sits beside the command hooks in the plugin; it imports its state types from ../types.
// State keys belong to the plugin that holds the module, so inside this plugin the mod's own name becomes ours.
/** @param {string} file */
const asPlugin = (file) => readFileSync(join(dashSrc, file), "utf8").replaceAll("orchestration-dashboard", NAME);
writeFileSync(join(out, "hooks", "dashboard.tsx"), asPlugin("register.tsx"));
writeFileSync(join(out, "types", "index.d.ts"), asPlugin(join("types", "index.d.ts")));
writeFileSync(join(out, "hooks", "hooks.json"), `${JSON.stringify({ ...hooks, modules: ["./dashboard.tsx"] }, null, 2)}\n`);

writeFileSync(
  join(out, ".claude-plugin", "plugin.json"),
  `${JSON.stringify({ name: NAME, version, description: "Orchestrator agent that delegates to researcher, implementer, integrator and reviewer agents with test and review gates, plus a /route skill that sizes a task first.", author: { name: "0xcvaliente" }, types: "./types/index.d.ts" }, null, 2)}\n`,
);

cpSync(join(dashSrc, "register.tsx"), join(dash, "hooks", "register.tsx"));
cpSync(join(dashSrc, "types", "index.d.ts"), join(dash, "types", "index.d.ts"));
writeFileSync(join(dash, "hooks", "hooks.json"), `${JSON.stringify({ modules: ["./register.tsx"] }, null, 2)}\n`);
writeFileSync(
  join(dash, ".claude-plugin", "plugin.json"),
  `${JSON.stringify({ name: "orchestration-dashboard", version, description: "Live pane of the orchestration agents: a flow diagram of the slices, tokens per task, what each reported, and a session log.", author: { name: "0xcvaliente" }, types: "./types/index.d.ts" }, null, 2)}\n`,
);
if (check) {
  const stale = ["plugin", "dashboard"].flatMap((name) => {
    const d = spawnSync("diff", ["-r", join(outRoot, name), join(committedRoot, name)], { encoding: "utf8" });
    return d.status === 0 ? [] : [`dist/${name} is out of date; run npm run build-plugin\n${d.stdout}${d.stderr}`];
  });
  rmSync(outRoot, { recursive: true, force: true });
  if (stale.length) {
    console.error(stale.join("\n"));
    process.exit(1);
  }
  console.log("dist/plugin and dist/dashboard are up to date");
} else {
  console.log(`built ${out} and ${dash}`);
}
