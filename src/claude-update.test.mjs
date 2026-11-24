// scripts/claude-update.mjs: the check to run after Claude Code updates. Every command goes through the `run` seam, so
// no real `claude` starts; files are written only under a temp folder.
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { agentsOf, check, HEADLESS_ENV, HEADLESS_FLAGS, HIDDEN_FLAGS, main, missingFlags, parseVersion, sandboxCheck, writeSource } from "../scripts/claude-update.mjs";
import { BUILTIN_AGENTS } from "../.claude/hooks/builtin-agents.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = JSON.parse(readFileSync(join(root, "dist", "plugin", ".claude-plugin", "plugin.json"), "utf8")).version;
// Resolved as Node resolves it, so a worktree that uses a parent folder's node_modules works too.
const SDK = JSON.parse(readFileSync(join(dirname(createRequire(join(root, "package.json")).resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8")).version;
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
    assert.deepEqual(r.checks.map((c) => [c.id, c.status]), [["cli", "ok"], ["builtins", "ok"], ["headless", "ok"], ["flags", "ok"], ["payload", "warn"], ["memory", "warn"], ["bgwait", "warn"], ["sdk", "ok"], ["plugin", "ok"], ["workflow", "warn"], ["sandbox", "ok"], ["dist", "ok"]]);
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

test("check: the Agent SDK is found in a parent folder's node_modules, as Node resolves it (a worktree)", () => {
  const top = mkdtempSync(join(tmpdir(), "claude-update-sdk-"));
  const m = machine({ version: "2.1.999 (Claude Code)" });
  try {
    const pkg = join(top, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    mkdirSync(pkg, { recursive: true });
    // Like the real package: an exports map with no ./package.json entry.
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-agent-sdk", version: "0.3.5", type: "module", exports: { ".": { default: "./sdk.mjs" } } }));
    writeFileSync(join(pkg, "sdk.mjs"), "export {};\n");
    const repo = join(top, "repo");
    mkdirSync(repo);
    const r = check({ env: m.env, run: m.run, root: repo });
    assert.equal(of(r, "sdk")?.status, "warn", of(r, "sdk")?.text ?? "no sdk check");
    assert.match(of(r, "sdk")?.text ?? "", /Agent SDK 0\.3\.5 carries its own Claude Code 2\.1\.5/);
    const none = mkdtempSync(join(tmpdir(), "claude-update-nosdk-"));
    try {
      const r2 = check({ env: m.env, run: m.run, root: none });
      assert.deepEqual([of(r2, "sdk")?.status, /not installed here/.test(of(r2, "sdk")?.text ?? "")], ["ok", true]);
    } finally {
      rmSync(none, { recursive: true, force: true });
    }
  } finally {
    m.done();
    rmSync(top, { recursive: true, force: true });
  }
});

test("check: a plugin read from a sibling folder whose name starts with the checkout's is not this checkout", () => {
  for (const [folder, want] of /** @type {[string, string][]} */ ([[`${root}-old`, "fail"], [root, "ok"], [join(root, "sub"), "ok"]])) {
    const m = machine({ plugin: { id: ID, version: "0.0.1", folderVersion: VERSION, readFromFolder: folder, enabled: true } });
    try {
      assert.equal(of(check({ env: m.env, run: m.run, root }), "plugin")?.status, want, folder);
    } finally {
      m.done();
    }
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
    // A deny list without the Agent(fork) line: neither file is touched.
    const noFork = `{\n  "permissions": {\n    "deny": [\n      "Agent(Explore)"\n    ]\n  }\n}\n`;
    writeFileSync(join(copy, ".claude", "settings.json"), noFork);
    const listBefore = readFileSync(join(copy, ".claude", "hooks", "builtin-agents.mjs"), "utf8");
    assert.equal(writeSource(copy, ["brand-new"]), false, "no Agent(fork) line: nothing is written");
    assert.equal(readFileSync(join(copy, ".claude", "hooks", "builtin-agents.mjs"), "utf8"), listBefore, "the block list is unchanged");
    assert.equal(readFileSync(join(copy, ".claude", "settings.json"), "utf8"), noFork, "settings.json is unchanged");
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

// sandbox: Claude Code 2.1.326 lets sandboxed commands write to fewer home folders; the per-user orchestration folder
// (state, skill drafts, the judge's record) is writable again only through sandbox.filesystem.allowWrite in user settings.
test("check sandbox: off, missing file or a covering entry is ok; on without the entry is a note naming the exact entry", () => {
  const m = machine();
  const file = join(m.home, "settings.json");
  const dir = join(m.home, "orchestration");
  const sandbox = (/** @type {any} */ settings) => {
    if (settings === undefined) rmSync(file, { force: true });
    else writeFileSync(file, typeof settings === "string" ? settings : `${JSON.stringify(settings, null, 2)}\n`);
    return of(check({ env: m.env, run: m.run, root }), "sandbox");
  };
  try {
    assert.equal(sandbox(undefined)?.status, "ok", "no user settings: the sandbox is off");
    assert.equal(sandbox({ model: "opus" })?.status, "ok");
    assert.equal(sandbox({ sandbox: { enabled: false } })?.status, "ok");
    for (const entry of [dir, `${dir}/`, `${dir}/**`, m.home, "orchestration", `/${dir}`]) {
      const c = sandbox({ sandbox: { enabled: true, filesystem: { allowWrite: ["/other", entry] } } });
      assert.equal(c?.status, "ok", `${entry}: ${c?.text}`);
    }
    for (const settings of [{ sandbox: { enabled: true } }, { sandbox: { enabled: true, filesystem: { allowWrite: [`${dir}-old`, join(dir, "skill-drafts")] } } }]) {
      const before = `${JSON.stringify(settings, null, 2)}\n`;
      const c = sandbox(settings);
      assert.equal(c?.status, "warn", JSON.stringify(settings));
      assert.ok(c?.text.includes(`add ${JSON.stringify(dir)} to sandbox.filesystem.allowWrite`), c?.text);
      assert.equal(readFileSync(file, "utf8"), before, "a check changes nothing");
    }
    const r = check({ env: m.env, run: m.run, root });
    assert.equal(r.ok, true, "a note, not a failure");
    assert.deepEqual(r.checks.map((c) => c.id), ["cli", "builtins", "headless", "flags", "payload", "memory", "bgwait", "sdk", "plugin", "workflow", "sandbox", "dist"], "placed after plugin");
  } finally {
    m.done();
  }
});

test("check sandbox --fix: adds the entry, keeps every other key and the indent; an unreadable file is a note and never rewritten", () => {
  const m = machine();
  const file = join(m.home, "settings.json");
  const dir = join(m.home, "orchestration");
  try {
    const settings = { model: "opus", permissions: { allow: ["Bash(ls)"] }, sandbox: { enabled: true, excludedCommands: ["docker"], filesystem: { allowWrite: ["/srv/cache"], denyRead: ["~/.ssh"] } }, theme: "dark" };
    writeFileSync(file, `${JSON.stringify(settings, null, 4)}\n`);
    let c = of(check({ env: m.env, run: m.run, root, fix: true }), "sandbox");
    assert.equal(c?.status, "fixed", c?.text ?? "no sandbox check");
    const want = { ...settings, sandbox: { ...settings.sandbox, filesystem: { ...settings.sandbox.filesystem, allowWrite: ["/srv/cache", dir] } } };
    assert.equal(readFileSync(file, "utf8"), `${JSON.stringify(want, null, 4)}\n`, "same keys, same order, same indent");
    assert.equal(of(check({ env: m.env, run: m.run, root }), "sandbox")?.status, "ok", "covered now");
    // No filesystem block yet: one is made.
    writeFileSync(file, `{\n\t"sandbox": { "enabled": true }\n}\n`);
    assert.equal(of(check({ env: m.env, run: m.run, root, fix: true }), "sandbox")?.status, "fixed");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { sandbox: { enabled: true, filesystem: { allowWrite: [dir] } } });
    assert.match(readFileSync(file, "utf8"), /^\t"sandbox"/m, "tab indent kept");
    // A file that does not parse, or cannot be read, is a note; --fix leaves it as it is and nothing throws.
    for (const bad of ['{ "sandbox": { "enabled": true, } ', "[1, 2]"]) {
      writeFileSync(file, bad);
      c = of(check({ env: m.env, run: m.run, root, fix: true }), "sandbox");
      assert.equal(c?.status, "warn", bad);
      assert.match(c?.text ?? "", /could not be (read|parsed)|is not a JSON object/);
      assert.equal(readFileSync(file, "utf8"), bad, "never rewritten");
    }
    rmSync(file);
    mkdirSync(file);
    c = of(check({ env: m.env, run: m.run, root, fix: true }), "sandbox");
    assert.equal(c?.status, "warn");
    assert.match(c?.text ?? "", /could not be read/);
  } finally {
    m.done();
  }
});

test("check sandbox: symlinks are resolved; --fix writes through a symlinked settings.json and adds no second entry for one folder", () => {
  const top = mkdtempSync(join(tmpdir(), "claude-update-link-"));
  try {
    // A dotfiles link: settings.json points at a file in another folder. --fix changes that file and keeps the link.
    const real = join(top, "real");
    mkdirSync(real);
    const dots = join(top, "dotfiles");
    mkdirSync(dots);
    const target = join(dots, "settings.json");
    writeFileSync(target, `${JSON.stringify({ sandbox: { enabled: true } }, null, 2)}\n`);
    symlinkSync(target, join(real, "settings.json"));
    const env = { CLAUDE_CONFIG_DIR: real, HOME: top };
    assert.equal(sandboxCheck({ fix: true, env }).status, "fixed");
    assert.ok(lstatSync(join(real, "settings.json")).isSymbolicLink(), "the link stays a link");
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")).sandbox.filesystem.allowWrite, [join(real, "orchestration")], "the linked file changed");
    assert.equal(sandboxCheck({ env }).status, "ok");
    // The config folder is a symlink and allowWrite names its real path: covered, and --fix adds nothing.
    const link = join(top, "link");
    symlinkSync(real, link);
    writeFileSync(target, `${JSON.stringify({ sandbox: { enabled: true, filesystem: { allowWrite: [join(real, "orchestration")] } } }, null, 2)}\n`);
    const before = readFileSync(target, "utf8");
    const viaLink = { CLAUDE_CONFIG_DIR: link, HOME: top };
    assert.equal(sandboxCheck({ env: viaLink }).status, "ok", "the real path covers the linked folder");
    assert.equal(sandboxCheck({ fix: true, env: viaLink }).status, "ok");
    assert.equal(readFileSync(target, "utf8"), before, "no second entry");
    // The other way round: the entry names the link, the config folder is the real path.
    writeFileSync(target, `${JSON.stringify({ sandbox: { enabled: true, filesystem: { allowWrite: [join(link, "orchestration")] } } }, null, 2)}\n`);
    assert.equal(sandboxCheck({ env }).status, "ok", "the linked path covers the real folder");
  } finally {
    rmSync(top, { recursive: true, force: true });
  }
});

// Items 4 and 5 of 2.0.0: the payload, memory and workflow checks (docs/claude-code-updates.md, Limits; docs/gates.md,
// Workflow guard: "an installed plugin of another version is trusted as installed").
test("items 4 and 5: payload and memory are looked up in the program file; a file that cannot tell is a note, never ok", async () => {
  const { programChecks, HOOK_FIELDS, MEMORY_SWITCH } = await import("../scripts/claude-update.mjs");
  const dir = mkdtempSync(join(tmpdir(), "claude-update-prog-"));
  try {
    const prog = (/** @type {string} */ name, /** @type {string[]} */ words) => { const f = join(dir, name); writeFileSync(f, `\x7fELF ${words.join(" x ")} end`); return f; };
    const all = programChecks(prog("all", [...HOOK_FIELDS, MEMORY_SWITCH]));
    assert.deepEqual([all.payload.status, all.memory.status], ["ok", "ok"]);
    const noField = programChecks(prog("nofield", [...HOOK_FIELDS.filter((f) => f !== "background_tasks"), MEMORY_SWITCH]));
    assert.equal(noField.payload.status, "fail");
    assert.match(noField.payload.text, /background_tasks/);
    assert.equal(noField.memory.status, "ok");
    assert.equal(programChecks(prog("nomem", [...HOOK_FIELDS])).memory.status, "fail");
    for (const unknown of [programChecks(prog("wrapper", ["exec node cli.js"])), programChecks(null), programChecks(join(dir, "absent"))]) {
      assert.deepEqual([unknown.payload.status, unknown.memory.status, unknown.bgwait.status], ["warn", "warn", "warn"]);
    }
    // Through check(): ORCH_CLAUDE_BIN names the program; a name not on PATH is a note.
    const m = machine();
    try {
      const r = check({ env: { ...m.env, ORCH_CLAUDE_BIN: join(dir, "all") }, run: m.run, root });
      assert.equal(of(r, "payload")?.status, "ok");
      assert.equal(of(r, "memory")?.status, "ok");
      const n = check({ env: m.env, run: m.run, root });
      assert.equal(of(n, "payload")?.status, "warn");
    } finally {
      m.done();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 2.1.0 (Claude Code 2.1.328): scripts/orchestrate.sh sets the wait of claude -p for background agents, so the check
// looks for that setting's name in the program file like the memory switch, and fails when it is gone.
test("2.1.0: bgwait looks for the wait setting orchestrate.sh exports; gone is a failure", async () => {
  const { programChecks, HOOK_FIELDS, MEMORY_SWITCH, WAIT_SWITCH } = await import("../scripts/claude-update.mjs");
  assert.equal(WAIT_SWITCH, "CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS");
  assert.match(readFileSync(join(root, "scripts", "orchestrate.sh"), "utf8"), new RegExp(`^export ${WAIT_SWITCH}=`, "m"));
  const dir = mkdtempSync(join(tmpdir(), "claude-update-wait-"));
  try {
    const prog = (/** @type {string} */ name, /** @type {string[]} */ words) => { const f = join(dir, name); writeFileSync(f, `\x7fELF ${words.join(" x ")} end`); return f; };
    const all = programChecks(prog("all", [...HOOK_FIELDS, MEMORY_SWITCH, WAIT_SWITCH]));
    assert.deepEqual([all.payload.status, all.memory.status, all.bgwait.status], ["ok", "ok", "ok"]);
    const gone = programChecks(prog("gone", [...HOOK_FIELDS, MEMORY_SWITCH]));
    assert.deepEqual([gone.payload.status, gone.memory.status, gone.bgwait.status], ["ok", "ok", "fail"]);
    assert.match(gone.bgwait.text, /CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS/);
    const m = machine();
    try {
      const r = check({ env: { ...m.env, ORCH_CLAUDE_BIN: join(dir, "gone") }, run: m.run, root });
      assert.deepEqual([r.ok, of(r, "bgwait")?.status], [false, "fail"]);
      assert.equal(of(check({ env: { ...m.env, ORCH_CLAUDE_BIN: join(dir, "all") }, run: m.run, root }), "bgwait")?.status, "ok");
    } finally {
      m.done();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("item 5: workflow: the loaded plugin's workflow must have the content the guard expects", () => {
  const dir = mkdtempSync(join(tmpdir(), "claude-update-wf-"));
  try {
    mkdirSync(join(dir, "good", "workflows"), { recursive: true });
    mkdirSync(join(dir, "bad", "workflows"), { recursive: true });
    cpSync(join(root, "dist", "plugin", "workflows", "orchestrate.js"), join(dir, "good", "workflows", "orchestrate.js"));
    writeFileSync(join(dir, "bad", "workflows", "orchestrate.js"), "export const meta = {};\n");
    for (const [folder, want] of /** @type {const} */ ([["good", "ok"], ["bad", "fail"], ["none", "warn"]])) {
      const m = machine({ plugin: { id: ID, version: VERSION, enabled: true, installPath: join(dir, folder) } });
      try {
        const r = check({ env: m.env, run: m.run, root });
        assert.equal(of(r, "workflow")?.status, want, folder);
        if (want === "fail") assert.equal(r.ok, false);
      } finally {
        m.done();
      }
    }
    // A disabled or missing plugin gets no workflow line.
    const off = machine({ plugin: null });
    try {
      assert.equal(of(check({ env: off.env, run: off.run, root }), "workflow"), undefined);
    } finally {
      off.done();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
