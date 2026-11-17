#!/usr/bin/env node
// The test gate's result cache and its record keys (2.0.0). Not a hook: verify.sh calls its CLI, and telemetry.mjs and
// journal.mjs use stopKey from state.mjs. Node built-ins and state.mjs only; no side effects at import beyond state.mjs.
//
// Result cache. verify.sh runs the suite at an implementer's hand-back (PreToolUse on SubagentHandback, --handback) and
// again at its SubagentStop. When the tree has not changed in between, the second gate reuses the first one's result
// instead of running the suite again. A result is stored under a key (treeKey) that proves the same tree and the same
// facts the gate's decision depends on:
//   - the folder (real path) and its git top level, HEAD, and the main worktree's HEAD (the base an isolated slice is
//     compared with; for the shared tree it is HEAD);
//   - the staged changes (git diff --cached HEAD) and the unstaged ones (git diff), both --binary, hashed;
//   - every untracked file that is not ignored (git ls-files -o --exclude-standard): its path, type and content;
//   - git status --porcelain (so a change git diff cannot show, a mode or a type, still changes the key);
//   - the test command, whether the tree is isolated, every ORCH_ variable and PATH, NODE_OPTIONS, NODE_ENV and CI.
// Any doubt gives no key, and then the suite runs: not a git work tree, a failing git command, a repository with
// submodules (their content is not in the diff), more than MAX_UNTRACKED files or MAX_UNTRACKED_BYTES bytes untracked,
// an untracked file that cannot be read. Ignored files (node_modules, build output) are not part of the key.
// verify.sh writes a result only when the key computed after the run equals the key before it (nothing changed the
// tree while the suite ran), never for a timed-out run, and only "pass" (exit 0) or "fail" (a test failure); a pass is
// reused as a pass and a fail as a fail, never one as the other. The file is test-gate-cache.json in the state dir,
// at most MAX_ENTRIES results, each message cut to MAX_MESSAGE characters, written whole to a temporary file and
// renamed into place. Two gates writing at once may lose one entry: a lost entry only means the suite runs again.
//
// Record keys. A test-gate record names the hand-back or the stop it belongs to: handback_id, the SubagentHandback
// call's tool_use_id, or stop_key (stopKey), which every SubagentStop hook of one event computes alike from the agent's
// transcript (state.mjs stopKey): the uuid of its last entry (else its size). Two stops of one agent differ in it, since a block or a
// resume adds entries in between. telemetry.mjs and journal.mjs store the same stop_key in their stop records, and
// run.mjs pairs records with stops by it.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stopKey } from "./state.mjs";

export const CACHE_FILE = "test-gate-cache.json";
export const MAX_ENTRIES = 32;
export const MAX_MESSAGE = 8000;
export const MAX_UNTRACKED = 5000;
export const MAX_UNTRACKED_BYTES = 64 * 1024 * 1024;
const ENV_FACTS = ["PATH", "NODE_OPTIONS", "NODE_ENV", "CI"];

// The stop key lives in state.mjs (every hook copy has it); re-exported for verify.sh's CLI and the tests.
export { stopKey };

/** @param {string} cwd @param {string[]} args @returns {Buffer | null} */
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 512 * 1024 * 1024 });
  return r.status === 0 && !r.error ? r.stdout : null;
}

/**
 * The cache key of the tree at `cwd` for the test command `cmd`, or null when one cannot be proven (see the header).
 * @param {string} cwd @param {string} cmd @param {{ isolated?: string, env?: Record<string, string | undefined> }} [facts]
 * @returns {string | null}
 */
export function treeKey(cwd, cmd, facts = {}) {
  try {
    const env = facts.env ?? process.env;
    const h = createHash("sha256");
    /** @param {string} name @param {string | Buffer} value */
    const part = (name, value) => {
      h.update(`${name}\0${Buffer.byteLength(value)}\0`);
      h.update(value);
    };
    part("v", "1");
    part("cwd", realpathSync(cwd));
    const top = git(cwd, ["rev-parse", "--show-toplevel"]);
    if (!top) return null;
    const topDir = top.toString("utf8").trim();
    if (existsSync(join(topDir, ".gitmodules"))) return null;
    part("top", topDir);
    const head = git(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
    if (!head) return null;
    part("head", head);
    const list = git(cwd, ["worktree", "list", "--porcelain"]);
    if (!list) return null;
    const mainWt = /^worktree (.*)$/m.exec(list.toString("utf8"))?.[1];
    const base = mainWt ? git(mainWt, ["rev-parse", "--verify", "-q", "HEAD"]) : null;
    if (!base) return null;
    part("base", base);
    for (const [name, args] of /** @type {[string, string[]][]} */ ([
      ["staged", ["diff", "--cached", "--binary", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD"]],
      ["unstaged", ["diff", "--binary", "--no-ext-diff", "--no-textconv", "--no-color"]],
      ["status", ["status", "--porcelain", "-z", "--untracked-files=all", "--ignore-submodules=none"]],
    ])) {
      const out = git(cwd, args);
      if (out === null) return null;
      part(name, createHash("sha256").update(out).digest("hex"));
    }
    const untracked = git(topDir, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (untracked === null) return null;
    const paths = untracked.toString("utf8").split("\0").filter(Boolean).sort();
    if (paths.length > MAX_UNTRACKED) return null;
    let bytes = 0;
    for (const p of paths) {
      const full = join(topDir, p);
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        part(`link:${p}`, readlinkSync(full));
      } else if (st.isFile()) {
        bytes += st.size;
        if (bytes > MAX_UNTRACKED_BYTES) return null;
        part(`file:${p}:${st.mode & 0o111 ? "x" : "-"}`, createHash("sha256").update(readFileSync(full)).digest("hex"));
      } else {
        return null;
      }
    }
    part("cmd", cmd);
    part("isolated", String(facts.isolated ?? ""));
    const names = Object.keys(env).filter((k) => k.startsWith("ORCH_") || ENV_FACTS.includes(k)).sort();
    for (const k of names) part(`env:${k}`, String(env[k] ?? ""));
    return h.digest("hex");
  } catch {
    return null;
  }
}

/**
 * @typedef {{ key: string, result: "pass" | "fail", ts: string, session_id?: string, agent_id?: string, by?: string, extra?: string, message?: string }} CacheEntry
 */

/** @param {string} state @returns {CacheEntry[]} */
export function readCache(state) {
  try {
    const data = JSON.parse(readFileSync(join(state, CACHE_FILE), "utf8"));
    return Array.isArray(data?.entries) ? data.entries.filter((/** @type {any} */ e) => e && typeof e.key === "string" && (e.result === "pass" || e.result === "fail")) : [];
  } catch {
    return [];
  }
}

/** The stored result for `key`, or null. @param {string} state @param {string} key @returns {CacheEntry | null} */
export function cacheGet(state, key) {
  if (!/^[0-9a-f]{64}$/.test(key)) return null;
  return readCache(state).findLast((e) => e.key === key) ?? null;
}

/**
 * Store a result: replaces an entry with the same key, keeps the newest MAX_ENTRIES, written atomically.
 * @param {string} state @param {CacheEntry} entry @returns {boolean}
 */
export function cachePut(state, entry) {
  if (!/^[0-9a-f]{64}$/.test(entry.key) || (entry.result !== "pass" && entry.result !== "fail")) return false;
  try {
    const rest = readCache(state).filter((e) => e.key !== entry.key);
    const clean = { ...entry, ...(typeof entry.message === "string" ? { message: entry.message.slice(-MAX_MESSAGE) } : {}) };
    const entries = [...rest, clean].slice(-MAX_ENTRIES);
    const tmp = join(state, `.${CACHE_FILE}.${process.pid}.${Date.now()}`);
    writeFileSync(tmp, `${JSON.stringify({ entries })}\n`);
    renameSync(tmp, join(state, CACHE_FILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * Hand-back calls of an agent refused by any gate since its latest SubagentStart (handback-refusals.jsonl, distinct
 * tool_use_ids; a refusal with no id counts once each), leaving out the call `exclude`.
 * @param {string} state @param {string} sessionId @param {string} agentId @param {string} [exclude] @returns {number}
 */
export function refusedHandbacks(state, sessionId, agentId, exclude = "") {
  /** @param {string} name @returns {any[]} */
  const read = (name) => {
    try {
      return readFileSync(join(state, name), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter((e) => e && e.agent_id === agentId && (e.session_id === undefined || e.session_id === sessionId));
    } catch {
      return [];
    }
  };
  let start = -Infinity;
  for (const e of read("telemetry.jsonl")) if (e.hook_event_name === "SubagentStart") start = Math.max(start, Date.parse(e.ts) || -Infinity);
  const ids = new Set();
  let anonymous = 0;
  for (const r of read("handback-refusals.jsonl")) {
    if (Date.parse(r.ts) < start) continue;
    if (typeof r.tool_use_id === "string" && r.tool_use_id) {
      if (r.tool_use_id !== exclude) ids.add(r.tool_use_id);
    } else anonymous += 1;
  }
  return ids.size + anonymous;
}

// CLI for verify.sh. Every command prints nothing and exits 0 on any error, so the gate then runs as it would without
// a cache.
//   key <cwd> <cmd> <isolated>                prints the tree key, or nothing
//   get <state> <key>                          prints result, by, extra, then the message; nothing on a miss
//   put <state> <key> <result> <by> <extra> <session> <agent>   message on stdin
//   stopkey <transcript>                       prints the stop key, or nothing
//   refused <state> <session> <agent> <exclude-id>              prints a count
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const [cmd, ...a] = process.argv.slice(2);
  try {
    if (cmd === "key") process.stdout.write(treeKey(a[0] ?? ".", a[1] ?? "", { isolated: a[2] ?? "" }) ?? "");
    else if (cmd === "get") {
      const e = cacheGet(a[0] ?? "", a[1] ?? "");
      if (e) process.stdout.write(`${e.result}\n${String(e.by ?? "").replace(/[^A-Za-z0-9_.:-]/g, "")}\n${String(e.extra ?? "").replace(/\n/g, "")}\n${e.message ?? ""}`);
    } else if (cmd === "put") {
      const message = readFileSync(0, "utf8");
      cachePut(a[0] ?? "", { key: a[1] ?? "", result: /** @type {any} */ (a[2]), ts: new Date().toISOString(), by: a[3] ?? "", extra: a[4] ?? "", session_id: a[5] ?? "", agent_id: a[6] ?? "", message });
    } else if (cmd === "stopkey") process.stdout.write(stopKey(a[0]) ?? "");
    else if (cmd === "refused") process.stdout.write(String(refusedHandbacks(a[0] ?? "", a[1] ?? "", a[2] ?? "", a[3] ?? "")));
  } catch {
    // nothing printed: no cache
  }
  process.exit(0);
}
