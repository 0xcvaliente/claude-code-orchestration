#!/usr/bin/env node
// Assembles dist/plugin from .claude/ so the orchestrator can be installed as a Claude Code plugin.
// Usage: node scripts/build-plugin.mjs   then   claude --plugin-dir dist/plugin   or   claude plugin validate dist/plugin
// Plugin agents are namespaced, so the orchestrator's Agent(...) allowlist is rewritten to "orchestration:<name>".
// Project settings (the permissions.deny list) are not part of a plugin; add them to your own settings.
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const NAME = "orchestration";
const src = join(process.cwd(), ".claude");
const out = join(process.cwd(), "dist", "plugin");
const version = JSON.parse(readFileSync("package.json", "utf8")).version;

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, ".claude-plugin"), { recursive: true });
mkdirSync(join(out, "hooks"), { recursive: true });

cpSync(join(src, "agents"), join(out, "agents"), { recursive: true });
cpSync(join(src, "skills"), join(out, "skills"), { recursive: true });
for (const f of readdirSync(join(src, "hooks"))) cpSync(join(src, "hooks", f), join(out, "hooks", f));

const orch = join(out, "agents", "orchestrator.md");
writeFileSync(
  orch,
  readFileSync(orch, "utf8").replace(/^tools: Agent\(([^)]*)\)/m, (_, list) => {
    const names = list.split(",").map((n) => `${NAME}:${n.trim()}`).join(", ");
    return `tools: Agent(${names})`;
  }),
);

const run = (script) => (script.endsWith(".mjs") ? `node "\${CLAUDE_PLUGIN_ROOT}/hooks/${script}"` : `"\${CLAUDE_PLUGIN_ROOT}/hooks/${script}"`);
const hooks = {
  hooks: {
    SubagentStart: [{ hooks: [{ type: "command", command: run("telemetry.mjs") }] }],
    SubagentStop: [
      { hooks: [{ type: "command", command: run("telemetry.mjs") }] },
      { matcher: "implementer", hooks: [{ type: "command", command: run("verify.sh") }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: run("review-gate.mjs") }] }],
  },
};
writeFileSync(join(out, "hooks", "hooks.json"), `${JSON.stringify(hooks, null, 2)}\n`);

writeFileSync(
  join(out, ".claude-plugin", "plugin.json"),
  `${JSON.stringify({ name: NAME, version, description: "Orchestrator agent that delegates to researcher, implementer, integrator and reviewer agents with test and review gates." }, null, 2)}\n`,
);
console.log(`built ${out}`);
