#!/usr/bin/env node
// The test gate's result cache (2.0.0). Not a hook: verify.sh calls its CLI. Node built-ins and state.mjs only; no side
// effects at import beyond state.mjs reading settings.
//
// One use only. verify.sh runs the suite at an implementer's hand-back (PreToolUse on SubagentHandback, --handback), and
// the SubagentStop gate follows seconds after a delivered hand-back. That stop gate may reuse the hand-back gate's result
// instead of running the suite again, and nothing else ever reuses one (cacheTake):
//   - the result was written by the hand-back gate of the same session and agent, for the agent's latest hand-back since
//     its latest start (state.mjs latestHandbackId: the tool_use_id the stop follows), so never across agents, sessions,
//     runs or a later start;
//   - it is at most REUSE_MAX_S seconds old (live, the stop's record came 1 to 2 s after the hand-back's);
//   - it was not reused before (an entry is marked used when taken: one reuse per hand-back);
//   - the tree key (treeKey) still matches.
// Anything else runs the suite. The hand-back gate itself never reuses a result.
// The tree key proves the tree and the facts the gate's decision depends on:
//   - the folder (real path) and its git top level, HEAD, and the main worktree's HEAD (the base an isolated slice is
//     compared with; for the shared tree it is HEAD);
//   - the staged changes (git diff --cached HEAD) and the unstaged ones (git diff), both --binary, hashed;
//   - every untracked file that is not ignored (git ls-files -o --exclude-standard): its path, type and content (a
//     symlink by its target's name, not the content it points to);
//   - git status --porcelain (so a change git diff cannot show, a mode or a type, still changes the key);
//   - the test command, whether the tree is isolated, every ORCH_ variable and PATH, NODE_OPTIONS, NODE_ENV and CI.
// Not in the key: git-ignored files (node_modules, build output, an ignored input the tests read) and what an untracked
// symlink points to. A change to them between the hand-back gate's run and its stop, a window of seconds that the limit
// above bounds, is not seen: the stop reuses the hand-back's result.
// Any doubt gives no key, and then the suite runs: not a git work tree, a failing git command, a repository with
// submodules (their content is not in the diff), more than MAX_UNTRACKED files or MAX_UNTRACKED_BYTES bytes untracked,
// an untracked file that cannot be read.
// verify.sh writes a result only at a hand-back, only when the key computed after the run (within the time the gate has
// left) equals the key before it, never for a timed-out run, and only "pass" (exit 0) or "fail" (a test failure); a
// pass is reused as a pass and a fail as a fail, never one as the other. The file is test-gate-cache.json in the state
// dir, at most MAX_ENTRIES results, each message cut to MAX_MESSAGE characters, written whole to a temporary file and
// renamed into place. Two gates writing at once may lose one entry: a lost entry only means the suite runs again.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { latestHandbackId } from "./state.mjs";

export const CACHE_FILE = "test-gate-cache.json";
export const MAX_ENTRIES = 32;
export const MAX_MESSAGE = 8000;
export const MAX_UNTRACKED = 5000;
export const MAX_UNTRACKED_BYTES = 64 * 1024 * 1024;
const ENV_FACTS = ["PATH", "NODE_OPTIONS", "NODE_ENV", "CI"];

/** How old a hand-back gate's result may be when its stop reuses it, in seconds. */
export const REUSE_MAX_S = 120;

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
 * by: the tool_use_id of the hand-back whose gate wrote it; used: true once a stop has reused it.
 * @typedef {{ key: string, result: "pass" | "fail", ts: string, session_id?: string, agent_id?: string, by?: string, extra?: string, message?: string, used?: boolean }} CacheEntry
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

/**
 * The result a stop may reuse (see the header), marked used, or null. `handback` is the hand-back the stop follows.
 * @param {string} state
 * @param {{ key: string, session: string, agent: string, handback: string, now?: number, maxAgeS?: number }} q
 * @returns {CacheEntry | null}
 */
export function cacheTake(state, q) {
  if (!/^[0-9a-f]{64}$/.test(q.key) || !q.session || !q.agent || !q.handback) return null;
  const entries = readCache(state);
  const i = entries.findLastIndex((e) => e.by === q.handback && e.agent_id === q.agent && e.session_id === q.session);
  const e = entries[i];
  if (!e || e.used || e.key !== q.key) return null;
  const age = (q.now ?? Date.now()) - Date.parse(e.ts);
  if (!(age >= 0 && age <= (q.maxAgeS ?? REUSE_MAX_S) * 1000)) return null;
  // Marked before it is returned: when the mark cannot be written, nothing is reused.
  if (!writeEntries(state, entries.map((x, j) => (j === i ? { ...x, used: true } : x)))) return null;
  return e;
}

/** @param {string} state @param {CacheEntry[]} entries @returns {boolean} */
function writeEntries(state, entries) {
  try {
    const tmp = join(state, `.${CACHE_FILE}.${process.pid}.${Date.now()}`);
    writeFileSync(tmp, `${JSON.stringify({ entries: entries.slice(-MAX_ENTRIES) })}\n`);
    renameSync(tmp, join(state, CACHE_FILE));
    return true;
  } catch {
    return false;
  }
}

/**
 * Store a result: replaces an entry of the same hand-back, keeps the newest MAX_ENTRIES, written atomically.
 * @param {string} state @param {CacheEntry} entry @returns {boolean}
 */
export function cachePut(state, entry) {
  if (!/^[0-9a-f]{64}$/.test(entry.key) || (entry.result !== "pass" && entry.result !== "fail")) return false;
  try {
    const rest = readCache(state).filter((e) => !(e.by && e.by === entry.by && e.agent_id === entry.agent_id && e.session_id === entry.session_id));
    const clean = { ...entry, ...(typeof entry.message === "string" ? { message: entry.message.slice(-MAX_MESSAGE) } : {}) };
    return writeEntries(state, [...rest, clean]);
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
//   take <state> <key> <session> <agent> <handback-id>          prints result, by, extra, then the message; nothing
//                                                                when no result may be reused (cacheTake)
//   put <state> <key> <result> <handback-id> <extra> <session> <agent>   message on stdin
//   link <state> <session> <agent>             prints the hand-back the agent's stop follows, or nothing
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
    else if (cmd === "take") {
      const e = cacheTake(a[0] ?? "", { key: a[1] ?? "", session: a[2] ?? "", agent: a[3] ?? "", handback: a[4] ?? "" });
      if (e) process.stdout.write(`${e.result}\n${String(e.by ?? "").replace(/[^A-Za-z0-9_.:-]/g, "")}\n${String(e.extra ?? "").replace(/\n/g, "")}\n${e.message ?? ""}`);
    } else if (cmd === "put") {
      const message = readFileSync(0, "utf8");
      cachePut(a[0] ?? "", { key: a[1] ?? "", result: /** @type {any} */ (a[2]), ts: new Date().toISOString(), by: a[3] ?? "", extra: a[4] ?? "", session_id: a[5] ?? "", agent_id: a[6] ?? "", message });
    } else if (cmd === "link") process.stdout.write(latestHandbackId(a[1] ?? "", a[2] ?? "", a[0] ?? "") ?? "");
    else if (cmd === "refused") process.stdout.write(String(refusedHandbacks(a[0] ?? "", a[1] ?? "", a[2] ?? "", a[3] ?? "")));
  } catch {
    // nothing printed: no cache
  }
  process.exit(0);
}
