#!/usr/bin/env node
// Assembles dist/plugin from .claude/ so the orchestrator can be installed as a Claude Code plugin.
// Usage: node scripts/build-plugin.mjs   then   claude --plugin-dir dist/plugin   or   claude plugin validate dist/plugin
// Plugin agents are namespaced, so the orchestrator's Agent(...) allowlist is rewritten to "orchestration:<name>".
// Project settings (the permissions.deny list) are not part of a plugin; add them to your own settings.
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAME = "orchestration";
const src = join(process.cwd(), ".claude");
// --check builds into a temp dir and fails when the committed dist/plugin differs, like `npm run check-agents`.
const check = process.argv.includes("--check");
const committed = join(process.cwd(), "dist", "plugin");
const out = check ? join(mkdtempSync(join(tmpdir(), "orch-plugin-")), "plugin") : committed;
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
      { matcher: `${NAME}:implementer`, hooks: [{ type: "command", command: run("verify.sh") }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: run("review-gate.mjs") }] }],
  },
};
writeFileSync(join(out, "hooks", "hooks.json"), `${JSON.stringify(hooks, null, 2)}\n`);

writeFileSync(
  join(out, ".claude-plugin", "plugin.json"),
  `${JSON.stringify({ name: NAME, version, description: "Orchestrator agent that delegates to researcher, implementer, integrator and reviewer agents with test and review gates, plus a /route skill that sizes a task first.", author: { name: "0xcvaliente" } }, null, 2)}\n`,
);
if (check) {
  const d = spawnSync("diff", ["-r", out, committed], { encoding: "utf8" });
  rmSync(join(out, ".."), { recursive: true, force: true });
  if (d.status !== 0) {
    console.error(`dist/plugin is out of date; run npm run build-plugin\n${d.stdout}`);
    process.exit(1);
  }
  console.log("dist/plugin is up to date");
} else {
  console.log(`built ${out}`);
}
