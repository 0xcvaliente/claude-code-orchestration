// scripts/claude-update.mjs: the check to run after Claude Code updates. Every command goes through the `run` seam, so
// no real `claude` starts; files are written only under a temp folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsOf, check, HEADLESS_ENV, HEADLESS_FLAGS, HIDDEN_FLAGS, main, missingFlags, parseVersion, writeSource } from "../scripts/claude-update.mjs";
import { BUILTIN_AGENTS } from "../.claude/hooks/builtin-agents.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(root, "dist", "plugin", ".claude-plugin", "plugin.json"), "utf8")).version;
const SDK = JSON.parse(readFileSync(join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"), "utf8")).version;
const CC = `2.1.${SDK.split(".")[2]}`; // the Claude Code this SDK carries
const ID = "orchestration@claude-code-orchestration";
const HELP = `${HEADLESS_FLAGS.map((f) => `  ${f} <value>   text`).join("\n")}\n`;
/** @param {string[]} names */
const answer = (names) => `{"type":"system","subtype":"hook_started"}\n${JSON.stringify({ type: "control_response", response: { subtype: "success", response: { agents: names.map((name) => ({ name })), claude_code_version: CC } } })}\n`;

/**
 * A fake machine. `agents` is what Claude Code lists in safe mode, `headless` what it lists with the headless switches.
 * @param {{ agents?: string[] | null, headless?: string[] | null, plugin?: any, help?: string, version?: string | null, dist?: number, markets?: any[], build?: number }} [o]
 */
function machine({ agents = ["claude", "Explore", "general-purpose", "Plan", "web-fetch"], headless = [], plugin = { id: ID, version: VERSION, enabled: true }, help = HELP, version = `${CC} (Claude Code)`, dist = 0, markets = [{ name: "claude-code-orchestration" }], build = 0 } = {}) {
  const home = mkdtempSync(join(tmpdir(), "claude-update-"));
  const state = { plugin, markets: [...markets] };
  /** @type {string[][]} */
  const calls = [];
  /** @type {import("../scripts/claude-update.mjs").Run} */
  const run = (cmd, args, opts = {}) => {
    calls.push([cmd, ...args]);
    const a = args.join(" ");
    if (cmd === process.execPath) return { code: a.endsWith("--check") ? dist : build, out: "" };
    if (a === "--version") return { code: version ? 0 : 127, out: version ?? "" };
    if (a === "--help") return { code: 0, out: help };
    if (args.includes("--safe-mode")) {
      assert.match(opts.input ?? "", /"subtype":"initialize"/, "the start-up request goes on stdin");
      assert.ok(args.includes("-p") && args.includes("stream-json"));
      const list = opts.env?.CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS === "1" ? headless : agents;
      return { code: 0, out: list ? answer(list) : "error: no answer\n" };
    }
    if (a === "plugin list --json") return { code: 0, out: JSON.stringify(state.plugin ? [state.plugin] : []) };
    if (a === "plugin marketplace list --json") return { code: 0, out: JSON.stringify(state.markets) };
    if (a.startsWith("plugin marketplace add ")) return { code: 0, out: "" };
    if (a === `plugin install ${ID}`) {
      state.plugin = { id: ID, version: VERSION, enabled: true };
      return { code: 0, out: "" };
    }
    if (a === `plugin enable ${ID}`) {
      state.plugin = { ...state.plugin, enabled: true };
      return { code: 0, out: "" };
    }
    if (a === `plugin update ${ID}`) {
      state.plugin = { ...state.plugin, version: VERSION };
      return { code: 0, out: "" };
    }
    return { code: 1, out: `unexpected: ${a}` };
  };
  const learned = join(home, "orchestration", "builtin-agents.json");
  const env = { PATH: process.env.PATH, HOME: home, CLAUDE_CONFIG_DIR: home, ORCH_BUILTINS_FILE: learned, ORCH_CLAUDE_BIN: "fake-claude" };
  return { run, env, calls, state, home, learned, done: () => rmSync(home, { recursive: true, force: true }) };
}
/** @param {{ checks: { id: string, status: string, text: string }[] }} r @param {string} id */
const of = (r, id) => r.checks.find((c) => c.id === id);

test("helpers: parseVersion, missingFlags, agentsOf", () => {
  assert.equal(parseVersion("2.1.325 (Claude Code)"), "2.1.325");
  assert.equal(parseVersion("not found"), null);
  assert.deepEqual(missingFlags(HELP), []);
  assert.deepEqual(missingFlags(HELP.replace("--agent ", "--agents ")), ["--agent"]);
  assert.deepEqual(missingFlags("  --disallowedTools, --disallowed-tools <tools...>\n", ["--tools", "--disallowedTools"]), ["--tools"]);
  assert.deepEqual(agentsOf(answer(["Explore", "web-fetch"])), ["Explore", "web-fetch"]);
  assert.deepEqual(agentsOf(answer([])), []);
  assert.equal(agentsOf("error: unknown option '--safe-mode'\n"), null);
  assert.equal(agentsOf('{"type":"control_response","response":{"subtype":"error"}}\n'), null);
});

test("the checked options are the ones orchestrate.sh and the native judge pass", () => {
  const known = new Set([...HEADLESS_FLAGS, ...HIDDEN_FLAGS, "--version", "--help"]);
  const sh = readFileSync(join(root, "scripts", "orchestrate.sh"), "utf8").split("\n").filter((l) => /^\s*(args|\[)/.test(l) && l.includes("args+=") || /^args=/.test(l)).join("\n");
  const judge = /const args = \[[^\]]*\]/.exec(readFileSync(join(root, ".claude", "hooks", "judge-hook.mjs"), "utf8"))?.[0] ?? "";
  const passed = [...`${sh}\n${judge}`.matchAll(/["(\s](--[A-Za-z][A-Za-z-]+)/g)].map((m) => String(m[1]));
  assert.ok(passed.length >= 12, `found ${passed.length} options`);
  for (const f of passed) assert.ok(known.has(f), `${f} is passed to claude but is in neither HEADLESS_FLAGS nor HIDDEN_FLAGS`);
  for (const f of HEADLESS_FLAGS) assert.ok(passed.includes(f), `${f} is checked but nothing passes it`);
  const exported = readFileSync(join(root, "scripts", "orchestrate.sh"), "utf8");
  for (const [k, v] of Object.entries(HEADLESS_ENV)) assert.match(exported, new RegExp(`^export ${k}=${v}$`, "m"));
});

test("check: a healthy machine passes, writes its record and never runs a model", () => {
  const m = machine();
  try {
    const r = check({ env: m.env, run: m.run, root });
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    assert.deepEqual(r.checks.map((c) => [c.id, c.status]), [["cli", "ok"], ["builtins", "ok"], ["headless", "ok"], ["flags", "ok"], ["sdk", "ok"], ["plugin", "ok"], ["dist", "ok"]]);
    assert.equal(r.claude_code_version, CC);
    assert.equal(r.orchestration_version, VERSION);
    assert.equal(JSON.parse(readFileSync(join(m.home, "orchestration", "claude-update.json"), "utf8")).claude_code_version, CC);
    assert.equal(existsSync(m.learned), false, "nothing to learn");
    // the two start-up requests are the only -p calls, and each carries no prompt: safe mode, stream-json in, nothing else
    const p = m.calls.filter((c) => c.includes("-p"));
    assert.equal(p.length, 2);
    for (const c of p) assert.deepEqual(c.slice(1), ["-p", "--safe-mode", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"]);
    assert.ok(!m.calls.some((c) => /install|enable|update|marketplace add/.test(c.slice(1).join(" "))), "a check changes nothing");
  } finally {
    m.done();
  }
});

test("check: a built-in agent type the list does not know fails; --fix blocks it on this machine at once", () => {
  const m = machine({ agents: ["claude", "Explore", "general-purpose", "Plan", "web-fetch", "deep-search", "researcher"] });
  try {
    let r = check({ env: m.env, run: m.run, root });
    assert.equal(r.ok, false);
    assert.equal(of(r, "builtins")?.status, "fail");
    assert.match(of(r, "builtins")?.text ?? "", /built-in agent type deep-search, which is not on the block list/);
    assert.doesNotMatch(of(r, "builtins")?.text ?? "", /researcher/, "this repo's own agent names are never reported");
    assert.equal(existsSync(m.learned), false, "a check writes no block list");

    r = check({ env: m.env, run: m.run, root, fix: true });
    assert.deepEqual([r.ok, of(r, "builtins")?.status], [true, "fixed"]);
    assert.deepEqual(JSON.parse(readFileSync(m.learned, "utf8")), { v: 1, claude_code_version: CC, agents: ["deep-search"] });

    // the plan check reads that file through builtin-agents.mjs; the next check sees it as blocked here, not in the repo
    r = check({ env: m.env, run: m.run, root });
    assert.deepEqual([r.ok, of(r, "builtins")?.status], [true, "warn"]);
    assert.match(of(r, "builtins")?.text ?? "", /deep-search is blocked on this machine only/);
  } finally {
    m.done();
  }
});

test("check: headless switches that stop working, a missing option, no answer and a stale dist each fail", () => {
  let m = machine({ headless: ["web-fetch"] });
  let r = check({ env: m.env, run: m.run, root });
  assert.deepEqual([r.ok, of(r, "headless")?.status], [false, "fail"]);
  assert.match(of(r, "headless")?.text ?? "", /still has web-fetch/);
  m.done();
  m = machine({ help: HELP.replace("--permission-mode", "--perm-mode") });
  r = check({ env: m.env, run: m.run, root });
  assert.deepEqual([r.ok, of(r, "flags")?.status], [false, "fail"]);
  assert.match(of(r, "flags")?.text ?? "", /--permission-mode/);
  m.done();
  m = machine({ agents: null, headless: null });
  r = check({ env: m.env, run: m.run, root });
  assert.deepEqual([of(r, "builtins")?.status, of(r, "headless")?.status], ["fail", "fail"]);
  m.done();
  m = machine({ dist: 1 });
  assert.equal(of(check({ env: m.env, run: m.run, root }), "dist")?.status, "fail");
  m.done();
  m = machine({ version: null });
  r = check({ env: m.env, run: m.run, root });
  assert.deepEqual([r.ok, r.claude_code_version, of(r, "cli")?.status, of(r, "builtins")], [false, null, "fail", undefined]);
  m.done();
});

test("check: an Agent SDK that carries another Claude Code is a note with the command to match it", () => {
  const m = machine({ version: "2.1.999 (Claude Code)" });
  try {
    const r = check({ env: m.env, run: m.run, root });
    assert.deepEqual([r.ok, of(r, "sdk")?.status], [true, "warn"]);
    assert.match(of(r, "sdk")?.text ?? "", /npm install @anthropic-ai\/claude-agent-sdk@0\.3\.999/);
  } finally {
    m.done();
  }
});

test("check: the plugin off is a note that only --enable changes; a stale install fails and --fix updates it", () => {
  /** @type {[any, string, { fix?: boolean, enable?: boolean }, string[]][]} */
  const cases = [
    [{ plugin: null, markets: [] }, "warn", { enable: true }, ["plugin marketplace add", `plugin install ${ID}`]],
    [{ plugin: { id: ID, version: VERSION, enabled: false } }, "warn", { enable: true }, [`plugin enable ${ID}`]],
    [{ plugin: { id: ID, version: "0.0.1", enabled: true } }, "fail", { fix: true }, [`plugin update ${ID}`]],
  ];
  for (const [setup, before, how, want] of cases) {
    let m = machine(setup);
    assert.equal(of(check({ env: m.env, run: m.run, root }), "plugin")?.status, before, JSON.stringify(setup));
    if (how.enable) {
      // the plugin is opt-in: --fix alone leaves it off
      assert.equal(of(check({ env: m.env, run: m.run, root, fix: true }), "plugin")?.status, "warn", JSON.stringify(setup));
      assert.ok(!m.calls.some((c) => /plugin (install|enable|marketplace add)/.test(c.slice(1).join(" "))));
    }
    m.done();
    m = machine(setup);
    const r = check({ env: m.env, run: m.run, root, ...how });
    assert.deepEqual([r.ok, of(r, "plugin")?.status], [true, "fixed"], JSON.stringify(setup));
    const ran = m.calls.map((c) => c.slice(1).join(" "));
    for (const w of want) assert.ok(ran.some((x) => x.startsWith(w)), `${w} in ${ran.join(" | ")}`);
    m.done();
  }
});

test("--write-source adds a new built-in to builtin-agents.mjs and permissions.deny, keeping both files' format", () => {
  const copy = mkdtempSync(join(tmpdir(), "claude-update-src-"));
  try {
    mkdirSync(join(copy, ".claude", "hooks"), { recursive: true });
    cpSync(join(root, ".claude", "hooks", "builtin-agents.mjs"), join(copy, ".claude", "hooks", "builtin-agents.mjs"));
    cpSync(join(root, ".claude", "settings.json"), join(copy, ".claude", "settings.json"));
    assert.equal(writeSource(copy, ["deep-search", "web-fetch"]), true);
    const list = readFileSync(join(copy, ".claude", "hooks", "builtin-agents.mjs"), "utf8");
    const names = [.../BUILTIN_AGENTS = Object\.freeze\(\[([^\]]*)\]\);/.exec(list)?.[1]?.matchAll(/"([^"]+)"/g) ?? []].map((x) => x[1]);
    assert.deepEqual(names, [...BUILTIN_AGENTS, "deep-search"], "appended once, nothing dropped");
    const settings = JSON.parse(readFileSync(join(copy, ".claude", "settings.json"), "utf8"));
    const original = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
    assert.deepEqual(settings.permissions.deny, [...original.permissions.deny.slice(0, -1), "Agent(deep-search)", "Agent(fork)"]);
    assert.deepEqual(settings.hooks, original.hooks);
    assert.equal(writeSource(copy, ["deep-search"]), true, "running it again changes nothing");
    assert.equal(readFileSync(join(copy, ".claude", "hooks", "builtin-agents.mjs"), "utf8").match(/deep-search/g)?.length, 1);
    writeFileSync(join(copy, ".claude", "settings.json"), "{}");
    assert.equal(writeSource(copy, ["x"]), false, "no deny list: nothing is written");
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
});

test("main: exit codes and output forms", () => {
  /** @type {string[]} */
  const out = [];
  let m = machine();
  assert.equal(main([], { env: m.env, run: m.run, root, stdout: (s) => out.push(s) }), 0);
  assert.match(out.join("\n"), /^orchestration \S+ and Claude Code \d+\.\d+\.\d+\n {2}ok {5}cli: /);
  assert.match(out.at(-1) ?? "", /All checks passed/);
  m.done();
  out.length = 0;
  m = machine({ headless: ["Explore"] });
  assert.equal(main(["--json"], { env: m.env, run: m.run, root, stdout: (s) => out.push(s) }), 1);
  assert.equal(JSON.parse(out.join("\n")).ok, false);
  out.length = 0;
  assert.equal(main(["--nope"], { env: m.env, run: m.run, root, stdout: (s) => out.push(s) }), 2);
  assert.match(out[0] ?? "", /^usage: /);
  m.done();
});
