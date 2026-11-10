#!/usr/bin/env node
// Assembles dist/plugin from .claude/ so the orchestrator can be installed as a Claude Code plugin.
// Usage: node scripts/build-plugin.mjs   then   claude --plugin-dir dist/plugin   or   claude plugin validate dist/plugin
// Plugin agents are namespaced, so the orchestrator's Agent(...) allowlist is rewritten to "orchestration:<name>".
// Project settings (the permissions.deny list) are not part of a plugin; add them to your own settings.
// dashboard/ (the live orchestration pane, a function-hooks module) ships twice: inside the plugin, so an installed
// orchestrator shows it, and alone as dist/dashboard for `claude --agent orchestrator --plugin-dir dist/dashboard`.
// .claude/workflows/*.js ship as plugin workflows. A plugin workflow's agent() must name the namespaced agent type
// ("orchestration:implementer"; a bare "implementer" is not found), and that agent then reports the namespaced
// agent_type to SubagentStart/SubagentStop hooks (probed on Claude Code 2.1.314), which the plugin verify.sh matcher
// below already matches. A repo-root evals/ directory ships as evals/ when it exists. The judge hooks are registered
// only when their files exist in .claude/hooks. Plugin settings are declared as userConfig (see OPTIONS).
// --out <dir>: build into <dir>/plugin and <dir>/dashboard instead of dist/ (ignored with --check).
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const NAME = "orchestration";
const src = join(process.cwd(), ".claude");
// --check builds into a temp dir and fails when the committed dist/plugin differs, like `npm run check-agents`.
const check = process.argv.includes("--check");
const committedRoot = join(process.cwd(), "dist");
const outAt = process.argv.indexOf("--out");
const outArg = outAt >= 0 ? process.argv[outAt + 1] : undefined;
if (outAt >= 0 && !outArg) {
  console.error("--out needs a directory");
  process.exit(1);
}
const outRoot = check ? mkdtempSync(join(tmpdir(), "orch-plugin-")) : outArg ? resolve(outArg) : committedRoot;
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
const workflows = join(src, "workflows");
if (existsSync(workflows)) {
  mkdirSync(join(out, "workflows"), { recursive: true });
  for (const f of readdirSync(workflows).filter((n) => n.endsWith(".js"))) {
    const text = readFileSync(join(workflows, f), "utf8").replace(/agentType: '([\w-]+)'/g, `agentType: '${NAME}:$1'`);
    writeFileSync(join(out, "workflows", f), text);
  }
}
const evals = join(process.cwd(), "evals");
if (existsSync(evals)) cpSync(evals, join(out, "evals"), { recursive: true });

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
// The judge refuses on a crash or timeout (onFailure "block"); a missing node exits 0, so it never blocks every command.
/** @param {string} script */
const failClosed = (script) => `sh -c 'command -v node >/dev/null 2>&1 || exit 0; exec node "$0" "$@"' "\${CLAUDE_PLUGIN_ROOT}/hooks/${script}" --plugin`;
// Matchers mirror .claude/settings.json. verify.sh takes the namespaced implementer, disjoint from the project's
// ^implementer$ (no duplicate() check). quote-check's project matcher (^|:)researcher$ covers both researcher types,
// so the plugin copy exits on duplicate() where the project registers it, and checks plugin researchers elsewhere.
const hooks = {
  hooks: {
    SessionStart: [
      { hooks: [{ type: "command", command: run("nudge.mjs") }] },
      { matcher: "compact", hooks: [{ type: "command", command: run("compact-context.mjs") }] },
    ],
    PreToolUse: [
      { matcher: "Agent|Task", hooks: [{ type: "command", command: run("plan-check.mjs"), timeout: 60 }] },
      { matcher: "Bash", hooks: [{ type: "command", command: run("researcher-guard.mjs") }] },
      { matcher: "WebFetch", hooks: [{ type: "command", command: run("egress-guard.mjs") }] },
      // Before a worker's report is delivered (auto mode): its format, and a researcher's quotes. Both filter by agent type.
      { matcher: "SubagentHandback", hooks: [{ type: "command", command: run("handback-check.mjs") }, { type: "command", command: run("quote-check.mjs") }] },
    ],
    PostToolUse: [
      { matcher: "Agent|Task", hooks: [{ type: "command", command: run("journal.mjs") }] },
      { matcher: "Read|WebFetch", hooks: [{ type: "command", command: run("read-log.mjs") }] },
    ],
    SubagentStart: [{ hooks: [{ type: "command", command: run("telemetry.mjs") }] }],
    SubagentStop: [
      { hooks: [{ type: "command", command: run("telemetry.mjs") }] },
      { hooks: [{ type: "command", command: run("journal.mjs") }] },
      { matcher: `${NAME}:implementer`, hooks: [{ type: "command", command: run("verify.sh"), timeout: 900 }] },
      { matcher: `${NAME}:researcher`, hooks: [{ type: "command", command: run("quote-check.mjs") }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: run("review-gate.mjs") }] }],
  },
};
// The judge hooks ship only when their files exist.
/** @type {Record<string, unknown[]>} */
const events = hooks.hooks;
/** @param {string} script */
const has = (script) => existsSync(join(src, "hooks", script));
if (has("judge-hook.mjs")) {
  events.PreToolUse?.push({ matcher: "Bash", hooks: [{ type: "command", command: failClosed("judge-hook.mjs"), timeout: 120, onFailure: "block" }] });
}
if (has("prompt-capture.mjs")) events.UserPromptSubmit = [{ hooks: [{ type: "command", command: run("prompt-capture.mjs") }] }];
// The module sits beside the command hooks in the plugin; it imports its state types from ../types.
// State keys belong to the plugin that holds the module, so inside this plugin the mod's own name becomes ours.
/** @param {string} file */
const asPlugin = (file) => readFileSync(join(dashSrc, file), "utf8").replaceAll("orchestration-dashboard", NAME);
writeFileSync(join(out, "hooks", "dashboard.tsx"), asPlugin("register.tsx"));
writeFileSync(join(out, "types", "index.d.ts"), asPlugin(join("types", "index.d.ts")));
writeFileSync(join(out, "hooks", "hooks.json"), `${JSON.stringify({ ...hooks, modules: ["./dashboard.tsx"] }, null, 2)}\n`);

// Plugin settings (shown in /config). Claude Code passes each to hooks as CLAUDE_PLUGIN_OPTION_<KEY>; state.mjs and
// verify.sh copy it to ORCH_<KEY> when that is unset (OPTION_KEYS), so an environment variable still wins.
/** @type {[string, "string" | "number", string, string, (string | number)?][]} */
const OPTIONS = [
  ["test_cmd", "string", "Test command", "Command the test gate runs instead of the detected one (ORCH_TEST_CMD)."],
  ["escalation", "string", "Opus review escalation", "Empty: opus review for slices with a doubt signal; off or always (ORCH_ESCALATION)."],
  ["judge", "string", "Bash judge", "Empty: off; native turns on the deny-only Bash judge hook (ORCH_JUDGE)."],
  ["judge_timeout_ms", "number", "Bash judge timeout (ms)", "How long the Bash judge may take, capped at 45000 (ORCH_JUDGE_TIMEOUT_MS)."],
  ["read_router", "string", "Read router", "Empty: off; on picks the reading model for researchers by file type (ORCH_READ_ROUTER)."],
  ["gap_min", "number", "Gap cutoff", "Reviewer gap confidence at or above which a review fails, default 80 (ORCH_GAP_MIN).", 80],
  ["stall_gate", "string", "Stall gate", "Empty: on; off stops requiring a replan for a stalled slice (ORCH_STALL_GATE)."],
  ["guards", "string", "Researcher and egress guards", "Empty: on; off disables the researcher Bash and reviewer WebFetch guards (ORCH_GUARDS)."],
  ["allow_builtins", "string", "Allow built-in subagents", "Empty: blocked during a run; 1 allows built-in and fork subagents (ORCH_ALLOW_BUILTINS)."],
  ["run_stale_min", "number", "Run stale after (minutes)", "Minutes without activity before an open run counts as stale, default 30 (ORCH_RUN_STALE_MIN).", 30],
  ["baseline", "string", "Test baseline", "inform (default), allow or off: compare failing tests with the base (ORCH_BASELINE).", "inform"],
  ["bugfix_check", "string", "Bugfix check", "Empty: on; off skips the KIND: bugfix reproduction test check (ORCH_BUGFIX_CHECK)."],
  ["quote_check", "string", "Quote check", "Empty: on; off skips checking researcher QUOTE lines against their sources (ORCH_QUOTE_CHECK)."],
  ["gate_isolated", "string", "Test gate in worktrees", "Test gate in isolated worktrees: warn (default), block or skip (ORCH_GATE_ISOLATED)."],
  ["skill_hints", "string", "Skill hints", "Empty: on; off drops the plan check's suggested-skills block for worker launches (ORCH_SKILL_HINTS)."],
  ["handback_check", "string", "Report check", "Empty: on; off skips sending a worker's report back once when it has no STATUS line or leaves a checked id unanswered (ORCH_HANDBACK_CHECK)."],
];
/** @type {Record<string, { type: string, title: string, description: string, default?: string | number }>} */
const userConfig = Object.fromEntries(
  OPTIONS.map(([key, type, title, description, def]) => [key, { type, title, description, ...(def === undefined ? {} : { default: def }) }]),
);

writeFileSync(
  join(out, ".claude-plugin", "plugin.json"),
  `${JSON.stringify({ name: NAME, version, description: "Orchestrator agent that delegates to researcher, implementer, integrator and reviewer agents with test and review gates, plus a /route skill that sizes a task first.", author: { name: "0xcvaliente" }, types: "./types/index.d.ts", userConfig }, null, 2)}\n`,
);

// Plugin settings.json: a plugin may set two keys, `agent` and `subagentStatusLine` (every other key is dropped at
// load). This one rewrites the row of each of this plugin's workers under the prompt (subagent-statusline.mjs); a
// `subagentStatusLine` in the user's or the project's own settings takes its place.
if (has("subagent-statusline.mjs")) {
  writeFileSync(join(out, "settings.json"), `${JSON.stringify({ subagentStatusLine: { type: "command", command: run("subagent-statusline.mjs") } }, null, 2)}\n`);
}

cpSync(join(dashSrc, "register.tsx"), join(dash, "hooks", "register.tsx"));
cpSync(join(dashSrc, "types", "index.d.ts"), join(dash, "types", "index.d.ts"));
writeFileSync(join(dash, "hooks", "hooks.json"), `${JSON.stringify({ modules: ["./register.tsx"] }, null, 2)}\n`);
writeFileSync(
  join(dash, ".claude-plugin", "plugin.json"),
  `${JSON.stringify({ name: "orchestration-dashboard", version, description: "Live pane of the orchestration agents: progress through the plan, a flow diagram of the slices, tokens per task, what each reported, a session log and what the session used.", author: { name: "0xcvaliente" }, types: "./types/index.d.ts" }, null, 2)}\n`,
);
if (check) {
  const stale = ["plugin", "dashboard"].flatMap((name) => {
    // `claude plugin eval` writes its reports to dist/plugin/evals/results (ignored by git): not part of the build.
    const d = spawnSync("diff", ["-r", "-x", "results", join(outRoot, name), join(committedRoot, name)], { encoding: "utf8" });
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
