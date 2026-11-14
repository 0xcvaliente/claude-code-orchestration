#!/usr/bin/env node
// Run this after Claude Code updates (or any time): it checks that the installed Claude Code has not grown something
// that goes around this repo's agents and gates, and repairs what it can.
//
//   npm run claude-update                      check only; exit 1 when something needs attention
//   npm run claude-update -- --fix             also repair this machine: block newly found built-in agents at once
//                                              (a per-user file the plan check reads) and update a stale plugin install
//   npm run claude-update -- --enable          install and enable the plugin when it is off (the plugin is opt-in, so
//                                              --fix alone never turns it on)
//   npm run claude-update -- --write-source    for a maintainer: also add newly found built-in agents to
//                                              .claude/hooks/builtin-agents.mjs and permissions.deny, and rebuild dist/
//   npm run claude-update -- --json            print the result as JSON instead of text
//
// What it checks:
//   cli       the `claude` binary runs and reports a version
//   builtins  every subagent type the installed Claude Code ships is on the block list (builtin-agents.mjs). The list
//             is read from Claude Code's own start-up answer in safe mode, where only built-ins exist; no model runs
//   headless  CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1 and CLAUDE_CODE_FORK_SUBAGENT=0, which scripts/orchestrate.sh
//             exports, still leave a headless run with no built-in subagent
//   flags     the options scripts/orchestrate.sh and the native judge pass are still in `claude --help`
//   sdk       the Agent SDK the SDK pipeline uses carries the same Claude Code as the installed one
//   plugin    the orchestration plugin, when installed, is at this checkout's version; off is a note, not a failure
//   dist      dist/plugin and dist/dashboard match the sources
//
// The result is written to <claude config dir>/orchestration/claude-update.json. Node built-ins only.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILTIN_AGENTS, FORK, OWN_AGENTS, learnedBuiltins, learnedFile } from "../.claude/hooks/builtin-agents.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** Options scripts/orchestrate.sh and .claude/hooks/judge-hook.mjs pass that `claude --help` lists. */
export const HEADLESS_FLAGS = Object.freeze([
  "--agent", "--output-format", "--verbose", "--permission-mode", "--no-session-persistence", "--max-budget-usd", "--model",
  "--add-dir", "--disallowedTools", "--allowedTools", "--setting-sources", "--tools", "--strict-mcp-config",
]);
/** Options they pass that the help does not list (so the help cannot confirm them). */
export const HIDDEN_FLAGS = Object.freeze(["--max-turns", "--advisor"]);
/** The switches scripts/orchestrate.sh exports for a headless run. */
export const HEADLESS_ENV = Object.freeze({ CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS: "1", CLAUDE_CODE_FORK_SUBAGENT: "0" });
const INIT = `${JSON.stringify({ type: "control_request", request_id: "claude-update", request: { subtype: "initialize" } })}\n`;
const INIT_ARGS = ["-p", "--safe-mode", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence"];

/** @typedef {{ code: number, out: string }} RunResult */
/** @typedef {(cmd: string, args: string[], opts?: { input?: string, env?: Record<string, string>, cwd?: string }) => RunResult} Run */
/** @typedef {{ id: string, status: "ok" | "fixed" | "warn" | "fail", text: string }} Check */

/** @param {string} p @returns {any} */
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

/** "2.1.325 (Claude Code)" -> "2.1.325"; null when the text has no version. @param {unknown} text */
export function parseVersion(text) {
  return /\b(\d+\.\d+\.\d+)\b/.exec(String(text ?? ""))?.[1] ?? null;
}

/** The options in `flags` that `claude --help` does not list. @param {string} helpText @param {readonly string[]} [flags] */
export function missingFlags(helpText, flags = HEADLESS_FLAGS) {
  return flags.filter((f) => !new RegExp(`(^|[\\s,])${f.replace(/-/g, "\\-")}([\\s,=<\\[]|$)`, "m").test(helpText));
}

/**
 * The agent names in Claude Code's answer to the start-up request (stream-json lines); null when there is no answer.
 * @param {string} out
 * @returns {string[] | null}
 */
export function agentsOf(out) {
  for (const line of out.split("\n")) {
    if (!line.includes('"control_response"')) continue;
    try {
      const agents = JSON.parse(line)?.response?.response?.agents;
      if (Array.isArray(agents)) return agents.map((a) => a?.name).filter((n) => typeof n === "string");
    } catch {
      // not the answer line
    }
  }
  return null;
}

/**
 * Add `names` to the BUILTIN_AGENTS array literal of builtin-agents.mjs and to permissions.deny of settings.json.
 * @param {string} root @param {string[]} names @returns {boolean} whether both files were rewritten
 */
export function writeSource(root, names) {
  const listFile = join(root, ".claude", "hooks", "builtin-agents.mjs");
  const settingsFile = join(root, ".claude", "settings.json");
  const src = readFileSync(listFile, "utf8");
  const m = /(export const BUILTIN_AGENTS = Object\.freeze\(\[)([^\]]*)(\]\);)/.exec(src);
  const settings = readJson(settingsFile);
  if (!m || !Array.isArray(settings?.permissions?.deny)) return false;
  const have = [...(m[2] ?? "").matchAll(/"([^"]+)"/g)].map((x) => String(x[1]));
  const all = [...have, ...names.filter((n) => !have.includes(n))];
  writeFileSync(listFile, src.replace(m[0], `${m[1]}\n  ${all.map((n) => JSON.stringify(n)).join(", ")},\n${m[3]}`));
  // settings.json is hand-formatted: insert the new rules before Agent(fork) instead of re-serializing the file.
  let text = readFileSync(settingsFile, "utf8");
  for (const n of names) {
    const rule = `Agent(${n})`;
    if (settings.permissions.deny.includes(rule)) continue;
    const at = /^([ \t]*)"Agent\(fork\)"/m.exec(text);
    if (!at) return false;
    text = text.replace(at[0], `${at[1]}${JSON.stringify(rule)},\n${at[0]}`);
  }
  writeFileSync(settingsFile, text);
  return true;
}

/**
 * @param {{ fix?: boolean, source?: boolean, enable?: boolean, env?: NodeJS.ProcessEnv, root?: string, run?: Run }} [opts]
 * @returns {{ v: 1, checked_at: string, claude_code_version: string | null, orchestration_version: string | null, ok: boolean, checks: Check[] }}
 */
export function check({ fix = false, source = false, enable = false, env = process.env, root = ROOT, run } = {}) {
  /** @type {Run} */
  const exec = run ?? ((cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, {
      encoding: "utf8", timeout: 120000, input: opts.input, cwd: opts.cwd,
      // ORCH_NO_NUDGE and ORCH_JUDGE_INNER keep this repo's own hooks quiet if a call ever loads them.
      env: { ...env, ORCH_NO_NUDGE: "1", ORCH_JUDGE_INNER: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", ...opts.env },
      stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    return { code: r.error ? 127 : (r.status ?? 1), out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  });
  const bin = env.ORCH_CLAUDE_BIN || "claude";
  const manifest = readJson(join(root, "dist", "plugin", ".claude-plugin", "plugin.json")) ?? {};
  const market = readJson(join(root, ".claude-plugin", "marketplace.json")) ?? {};
  const id = `${manifest.name ?? "orchestration"}@${market.name ?? "claude-code-orchestration"}`;
  /** @type {Check[]} */
  const checks = [];
  /** @param {string} cid @param {Check["status"]} status @param {string} text */
  const add = (cid, status, text) => checks.push({ id: cid, status, text });

  const ver = exec(bin, ["--version"]);
  const version = ver.code === 0 ? parseVersion(ver.out) : null;
  if (!version) {
    add("cli", "fail", `\`${bin} --version\` did not run. Install Claude Code or set ORCH_CLAUDE_BIN.`);
  } else {
    add("cli", "ok", `Claude Code ${version}`);

    // builtins and headless: ask Claude Code itself, from an empty folder, in safe mode (no custom agents, no hooks).
    const dir = mkdtempSync(join(tmpdir(), "orch-update-"));
    let listed, headless;
    try {
      listed = agentsOf(exec(bin, INIT_ARGS, { input: INIT, cwd: dir }).out);
      headless = agentsOf(exec(bin, INIT_ARGS, { input: INIT, cwd: dir, env: { ...HEADLESS_ENV } }).out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    if (!listed) {
      add("builtins", "fail", `Claude Code ${version} did not answer the start-up request, so its built-in agent types could not be read.`);
    } else {
      const fresh = listed.filter((n) => n !== FORK && !BUILTIN_AGENTS.includes(n) && !OWN_AGENTS.includes(n));
      const learned = learnedBuiltins(env);
      const unblocked = fresh.filter((n) => !learned.includes(n));
      const file = learnedFile(env);
      if (!fresh.length) {
        add("builtins", "ok", `all ${listed.length} built-in agent types of Claude Code ${version} are on the block list`);
      } else if (source && writeSource(root, fresh)) {
        const built = exec(process.execPath, [join(root, "scripts", "build-plugin.mjs")], { cwd: root });
        add("builtins", built.code === 0 ? "fixed" : "fail", `added ${fresh.join(", ")} to .claude/hooks/builtin-agents.mjs and permissions.deny${built.code === 0 ? "; dist/ rebuilt. Run npm run check, then release." : ", but npm run build-plugin failed."}`);
      } else if (unblocked.length && fix && file) {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(`${file}.tmp`, `${JSON.stringify({ v: 1, claude_code_version: version, agents: [...new Set([...learned, ...fresh])] }, null, 2)}\n`);
        renameSync(`${file}.tmp`, file);
        add("builtins", "fixed", `Claude Code ${version} ships ${unblocked.join(", ")}, which the block list did not know. Blocked on this machine now (${file}). --write-source adds it to the repo.`);
      } else if (unblocked.length) {
        add("builtins", "fail", `Claude Code ${version} ships the built-in agent type ${unblocked.join(", ")}, which is not on the block list: a session with an open run can hand work to it and no gate sees that. Run with --fix to block it on this machine, or --write-source to add it to the repo.`);
      } else {
        add("builtins", "warn", `${fresh.join(", ")} is blocked on this machine only (${file}). --write-source adds it to the repo.`);
      }
    }
    if (!headless) add("headless", "fail", "Claude Code did not answer the start-up request with the headless switches set.");
    else if (headless.length) add("headless", "fail", `with ${Object.entries(HEADLESS_ENV).map(([k, v]) => `${k}=${v}`).join(" and ")} a headless run still has ${headless.join(", ")}. scripts/orchestrate.sh relies on those switches: its runs can now delegate to built-in agents.`);
    else add("headless", "ok", "the headless switches leave no built-in agent");

    const help = exec(bin, ["--help"]);
    const gone = help.code === 0 ? missingFlags(help.out) : [...HEADLESS_FLAGS];
    if (help.code !== 0) add("flags", "fail", `\`${bin} --help\` did not run, so the options could not be checked.`);
    else if (gone.length) add("flags", "fail", `Claude Code ${version} no longer lists ${gone.join(", ")}, which scripts/orchestrate.sh or the native judge passes.`);
    else add("flags", "ok", `all ${HEADLESS_FLAGS.length} documented options exist (${HIDDEN_FLAGS.join(", ")} are not in the help and cannot be checked)`);

    // sdk: 0.3.N of the Agent SDK carries Claude Code 2.1.N.
    const sdk = readJson(join(root, "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json"))?.version;
    const patch = (/** @type {unknown} */ v) => /^\d+\.\d+\.(\d+)/.exec(String(v ?? ""))?.[1];
    if (!sdk) add("sdk", "ok", "the Agent SDK is not installed here (only the SDK pipeline in src/ needs it)");
    else if (patch(sdk) === patch(version)) add("sdk", "ok", `Agent SDK ${sdk} carries Claude Code ${version}`);
    else add("sdk", "warn", `Agent SDK ${sdk} carries its own Claude Code 2.1.${patch(sdk)}, the installed one is ${version}: the SDK pipeline runs the older one. To match: npm install @anthropic-ai/claude-agent-sdk@0.3.${patch(version)} && npm run check`);

    /** @returns {any[] | null} */
    const plugins = () => {
      const r = exec(bin, ["plugin", "list", "--json"]);
      try {
        return r.code === 0 ? JSON.parse(r.out) : null;
      } catch {
        return null;
      }
    };
    /** @param {any[] | null} list */
    const find = (list) => (Array.isArray(list) ? list.find((p) => p?.id === id) : undefined);
    const list = plugins();
    if (!list) {
      add("plugin", "fail", `\`${bin} plugin list --json\` did not run.`);
    } else {
      /** @type {string[]} */
      const done = [];
      let p = find(list);
      if (!p && enable) {
        const ms = exec(bin, ["plugin", "marketplace", "list", "--json"]);
        let known = false;
        try {
          known = JSON.parse(ms.out).some((/** @type {any} */ m) => m?.name === market.name);
        } catch {
          known = false;
        }
        if (!known) exec(bin, ["plugin", "marketplace", "add", root]);
        if (exec(bin, ["plugin", "install", id]).code === 0) done.push("installed");
        p = find(plugins());
      }
      if (p && p.enabled !== true && enable) {
        if (exec(bin, ["plugin", "enable", id]).code === 0) done.push("enabled");
        p = find(plugins()) ?? p;
      }
      // A directory marketplace is read straight from the checkout (readFromFolder), so only a copied install can be stale.
      const versionOf = (/** @type {any} */ x) => (x?.readFromFolder && resolve(x.readFromFolder).startsWith(root) ? (x.folderVersion ?? x.version) : x?.version);
      if (p && versionOf(p) !== manifest.version && fix) {
        if (exec(bin, ["plugin", "update", id]).code === 0) done.push("updated");
        p = find(plugins()) ?? p;
      }
      const off = "Claude Code's built-in subagents and workflows do the work instead of this repo's agents and gates";
      if (!p) add("plugin", "warn", `${id} is not installed, so ${off}. --enable installs it, or: ${bin} plugin install ${id}`);
      else if (p.enabled !== true) add("plugin", "warn", `${id} is installed but disabled, so ${off}. --enable turns it on, or: ${bin} plugin enable ${id}`);
      else if (versionOf(p) !== manifest.version) add("plugin", "fail", `${id} is at ${versionOf(p)}, this checkout is ${manifest.version}. --fix updates it, or: ${bin} plugin update ${id}`);
      else add("plugin", done.length ? "fixed" : "ok", `${id} ${versionOf(p)} is enabled${done.length ? ` (${done.join(", ")}; restart Claude Code)` : ""}`);
    }
  }

  if (existsSync(join(root, "scripts", "build-plugin.mjs"))) {
    const built = exec(process.execPath, [join(root, "scripts", "build-plugin.mjs"), "--check"], { cwd: root });
    if (built.code === 0) add("dist", "ok", "dist/plugin and dist/dashboard are up to date");
    else add("dist", "fail", "dist/ does not match the sources. Run: npm run build-plugin");
  }

  /** @type {ReturnType<typeof check>} */
  const result = {
    v: 1, checked_at: new Date().toISOString(), claude_code_version: version, orchestration_version: manifest.version ?? null,
    ok: checks.every((c) => c.status !== "fail"), checks,
  };
  try {
    const out = join(env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), ".claude"), "orchestration");
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "claude-update.json.tmp"), `${JSON.stringify(result, null, 2)}\n`);
    renameSync(join(out, "claude-update.json.tmp"), join(out, "claude-update.json"));
  } catch {
    // the record is optional
  }
  return result;
}

const MARK = { ok: "ok   ", fixed: "fixed", warn: "note ", fail: "FAIL " };

/**
 * CLI entry.
 * @param {string[]} [argv]
 * @param {{ stdout?: (s: string) => void, env?: NodeJS.ProcessEnv, root?: string, run?: Run }} [deps]
 * @returns {number} 0 ok, 1 a check failed, 2 bad usage
 */
export function main(argv = process.argv.slice(2), { stdout = (s) => void process.stdout.write(`${s}\n`), ...deps } = {}) {
  const bad = argv.find((a) => !["--fix", "--write-source", "--enable", "--json", "--check"].includes(a));
  if (bad) {
    stdout(`usage: node scripts/claude-update.mjs [--fix] [--enable] [--write-source] [--json]   (unknown argument: ${bad})`);
    return 2;
  }
  const r = check({ fix: argv.includes("--fix"), source: argv.includes("--write-source"), enable: argv.includes("--enable"), ...deps });
  if (argv.includes("--json")) stdout(JSON.stringify(r, null, 2));
  else {
    stdout(`orchestration ${r.orchestration_version} and Claude Code ${r.claude_code_version ?? "(not found)"}`);
    for (const c of r.checks) stdout(`  ${MARK[c.status]}  ${c.id}: ${c.text}`);
    stdout(r.ok ? "All checks passed." : "Some checks failed. Lines marked FAIL say what to do.");
  }
  return r.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
