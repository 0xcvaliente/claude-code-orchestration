import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { BUILTIN_AGENTS, DENIED_AGENTS, NATIVE_TOOLS, PUSH_BASH, SDK_DENIED_BASH, UNSAFE_BASH } from "./config.js";
import { builtinAgents, learnedBuiltins, learnedFile, OWN_AGENTS } from "../.claude/hooks/builtin-agents.mjs";

test("SDK worker deny list plus the blocked built-in agents match permissions.deny in .claude/settings.json, except push", () => {
  const settings = JSON.parse(readFileSync(new URL("../.claude/settings.json", import.meta.url), "utf8"));
  const shared = UNSAFE_BASH.filter((rule) => !PUSH_BASH.includes(rule));
  assert.deepEqual([...settings.permissions.deny].sort(), [...shared, ...DENIED_AGENTS].sort());
});

test("SDK workers can never push, while interactive sessions follow their permission mode", () => {
  const settings = JSON.parse(readFileSync(new URL("../.claude/settings.json", import.meta.url), "utf8"));
  for (const rule of PUSH_BASH) {
    assert.ok(UNSAFE_BASH.includes(rule), `${rule} must stay in UNSAFE_BASH`);
    assert.ok(!settings.permissions.deny.includes(rule), `${rule} must not be in permissions.deny`);
  }
});

test("headless native runs disable Claude Code's built-in subagents and fork subagents", () => {
  const script = readFileSync(new URL("../scripts/orchestrate.sh", import.meta.url), "utf8");
  assert.match(script, /^export CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1$/m);
  assert.match(script, /^export CLAUDE_CODE_FORK_SUBAGENT=0$/m);
});

test("fork subagents are denied in permissions.deny", () => {
  const settings = JSON.parse(readFileSync(new URL("../.claude/settings.json", import.meta.url), "utf8"));
  assert.ok(DENIED_AGENTS.includes("Agent(fork)"));
  assert.ok(settings.permissions.deny.includes("Agent(fork)"));
});

test("one built-in list: DENIED_AGENTS and the plan check's set both come from builtin-agents.mjs", () => {
  assert.deepEqual(DENIED_AGENTS, [...BUILTIN_AGENTS.map((a) => `Agent(${a})`), "Agent(fork)"]);
  assert.ok(BUILTIN_AGENTS.includes("web-fetch"), "web-fetch is a built-in since Claude Code 2.1.325");
  for (const own of OWN_AGENTS) assert.ok(!BUILTIN_AGENTS.includes(own), `${own} is this plugin's own agent`);
  const none = { ORCH_BUILTINS_FILE: "" };
  assert.deepEqual([...builtinAgents(none)].sort(), ["fork", ...BUILTIN_AGENTS].sort());
  assert.equal(learnedFile(none), null);
  assert.deepEqual(learnedBuiltins(none), []);
  assert.match(learnedFile({ CLAUDE_CONFIG_DIR: "/cfg" }) ?? "", /^\/cfg[\\/]orchestration[\\/]builtin-agents\.json$/);
});

test("native tool policy: the implementer cannot spawn agents, the orchestrator only names this repo's workers", () => {
  assert.deepEqual(NATIVE_TOOLS.implementer.disallowedTools, ["Agent"]);
  assert.equal(NATIVE_TOOLS.implementer.tools, undefined);
  const orchestrator = NATIVE_TOOLS.orchestrator.tools ?? [];
  assert.ok(orchestrator.includes("Agent(researcher, implementer, integrator, reviewer)"));
  assert.deepEqual(orchestrator, ["Agent(researcher, implementer, integrator, reviewer)", "SendMessage", "Read", "Grep", "Glob", "Skill"], "the orchestrator's tools: workers, SendMessage, read-only tools and Skill");
  assert.ok(!(NATIVE_TOOLS.integrator.tools ?? []).includes("Skill"), "the integrator gets no Skill");
  for (const agent of ["orchestrator", "researcher", "reviewer", "integrator"] as const) {
    const tools = NATIVE_TOOLS[agent].tools ?? [];
    assert.ok(tools.length > 0, `${agent} must keep an explicit tools list`);
    assert.ok(!tools.includes("Edit") && !tools.includes("Write"), `${agent} must not get Edit or Write`);
    if (agent !== "orchestrator") assert.ok(!tools.some((t) => t.startsWith("Agent")), `${agent} must not get Agent`);
  }
});

test("SDK_DENIED_BASH keeps sudo denied by rule and is a subset of UNSAFE_BASH (the native lists do not change)", () => {
  assert.deepEqual(SDK_DENIED_BASH, ["Bash(sudo*)"]);
  for (const rule of SDK_DENIED_BASH) assert.ok(UNSAFE_BASH.includes(rule));
});

test("this repo runs as the orchestrator: the project settings name it, the plugin does not, and plain launchers opt out", () => {
  const settings = JSON.parse(readFileSync(new URL("../.claude/settings.json", import.meta.url), "utf8"));
  assert.equal(settings.agent, "orchestrator");
  assert.match(readFileSync(new URL("../.claude/agents/orchestrator.md", import.meta.url), "utf8"), /^name: orchestrator$/m, "the named agent exists");
  // The plugin must not ship the default: it would turn every session of every project with the plugin on into an
  // orchestrator. Since 1.6.1 it ships no settings.json at all (the worker rows moved to the mod's AgentRow hook); if one
  // comes back, it must not name `agent`.
  const pluginSettings = new URL("../dist/plugin/settings.json", import.meta.url);
  assert.ok(!existsSync(pluginSettings), "dist/plugin/settings.json is not shipped");
  for (const f of ["../dist/plugin/hooks/hooks.json", "../dist/plugin/.claude-plugin/plugin.json"]) {
    assert.equal(JSON.parse(readFileSync(new URL(f, import.meta.url), "utf8")).agent, undefined, f);
  }
  // Everything that must stay a plain session says so itself.
  assert.match(readFileSync(new URL("../scripts/orchestrate.sh", import.meta.url), "utf8"), /args\+=\(--settings '\{"agent":""\}'\)/);
  // SDK workers: the flag settings start with an empty agent (src/agent.test.ts checks every role's options).
  assert.match(readFileSync(new URL("./agent.ts", import.meta.url), "utf8"), /settings: \{ agent: ""[,\s}]/);
  // npm run plain clears the agent and names the Concise output style, as orchestrate.sh does for a plain session.
  const plain = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).scripts.plain;
  assert.match(plain, /^claude --settings '\{"agent":"","outputStyle":"Concise"\}'$/);
  assert.deepEqual(JSON.parse(plain.match(/^claude --settings '(.*)'$/)[1]), { agent: "", outputStyle: "Concise" });
});

test("npm start launches the native orchestrator; the SDK pipeline runs only under npm run sdk", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const { start, sdk, orchestrate } = pkg.scripts;
  assert.doesNotMatch(start, /src\/cli\.ts/, "npm start must not run the SDK pipeline");
  assert.match(start, /^claude --agent orchestrator(\s|$)/);
  assert.equal(start, orchestrate, "npm start and npm run orchestrate run the same native command");
  assert.match(sdk, /^tsx src\/cli\.ts$/);
  assert.match(pkg.description, /native orchestrator/i);
  // Native scripts come before the SDK pipeline in the list.
  const names = Object.keys(pkg.scripts);
  for (const name of ["start", "orchestrate", "native", "auto"]) assert.ok(names.indexOf(name) < names.indexOf("sdk"), `${name} before sdk`);
});
