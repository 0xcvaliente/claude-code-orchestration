#!/usr/bin/env node
// The test gate's result cache (2.0.0). Not a hook: verify.sh calls its CLI. Node built-ins and state.mjs only; no side
// effects at import beyond state.mjs reading settings.
//
// One use only. verify.sh runs the suite at an implementer's hand-back (PreToolUse on SubagentHandback, --handback), and
// the SubagentStop gate follows seconds after a delivered hand-back. That stop gate may take the hand-back gate's outcome
// as its own instead of running the suite again; nothing else ever reuses one. The rule rests on one function,
// listTrees: a listing of EVERY entry (file, folder, symlink, other) of the work tree and, when the work tree is a linked
// worktree, of the main checkout too (node_modules resolves through it), git-ignored entries included, each with its
// path, type, size, mtime and ctime in nanoseconds, inode, device and, for a symlink, its target text (never atime),
// reduced to one sha256 over the entries in a fixed order. Left out, in both trees: each tree's own .git, its whole
// .claude/state folder (the gate's log and lock, the journal, telemetry, the read log and the hand-back captures are
// written there all the time; the plugin's state folder too, wherever it is) and its .claude/worktrees (other agents'
// worktrees; a linked worktree under it is listed as its own root). A listing gives no hash when it cannot finish
// before its deadline (cut from the hook's time left), when an entry cannot be read (one vanished while it was listed)
// or when an entry lies on another device than its tree's root (a mount point inside the tree).
// Store, at the hand-back (cachePut, storeVerdict): the clock is read, listing L0 is taken immediately before the suite
// starts, listing L1 immediately after it ends. An outcome is stored only when L1 equals L0 exactly: the suite wrote
// nothing into the trees and nobody else changed anything during the run. Nothing is stored (each with its reason code,
// logged by verify.sh as "store") when: a listing has no hash (l0_<reason>, l1_<reason>); a symlink points outside
// both trees or into a left-out folder (symlink_outside: its target's content is not watched); no entry carries a
// sub-second time (coarse_times: the file system keeps whole seconds or cannot say); an entry's mtime or ctime lies in
// the future (future_time) or later than RECENT_MS before the clock read for L0 (recent_change: a change that close
// could hide behind equal timestamps); the clock after L1 is earlier than the clock before L0 (clock_backwards); L1
// differs from L0 (tree_changed: also every suite that writes into the trees, which so gets no reuse); the tree key
// changed during the run (key_changed). Nothing stored only means the suite runs again at the stop.
// Reuse, at the stop (cacheTake): listing L2 is taken and the outcome is reused only when L2 equals the stored L0
// exactly, and the outcome was written by the hand-back gate of the same session and agent for the agent's latest
// hand-back since its latest start (state.mjs latestHandbackId), was not taken before (marked used before it is
// returned), has the same tree key (treeKey: tracked, staged, unstaged and untracked content, the command and the
// environment facts) and is at most REUSE_MAX_S seconds old. Otherwise the suite runs (reason codes in take's output,
// logged by verify.sh as "reuse"). Why equal listings mean nothing changed since before the run began: every write,
// truncate, rename, link, unlink, chmod or chown sets the ctime of the entry or of its folder to the kernel's clock,
// and ctime cannot be set back (touch -d sets back mtime only, and the ctime moves on); a replacement by rename brings
// another inode; a deletion or an addition changes the folder's listing and ctime. With every time at least RECENT_MS
// before L0, a change made later gets a time that differs from the one listed, also on a file system whose timestamps
// are as coarse as RECENT_MS.
// Outcomes stored: "pass" (exit 0), "fail" (a test failure, with the block message), "timeout" (the suite was stopped
// at its limit: reused as the same timed-out block, never a pass) and "lock_wait" (the hand-back gate gave up waiting
// for the suite lock: L0 before the wait, L1 after the give-up; the stop then does not wait again). A cache never turns
// a fail, a timeout or an unknown result into a pass. The file is test-gate-cache.json in the state dir, at most
// MAX_ENTRIES entries, each message cut to MAX_MESSAGE characters, written whole to a temporary file and renamed into
// place. Two gates writing at once may lose one entry: a lost entry only means the suite runs again.
// Any doubt gives no key (and so no record and no reuse): not a git work tree, a failing git command, a repository with
// submodules, more than MAX_UNTRACKED files or MAX_UNTRACKED_BYTES bytes untracked, an untracked file that cannot be read.
// Limits, beyond what a listing can prove: a file outside both trees that a test reads directly (not through a symlink
// in them); a write through a shared memory mapping, or through a descriptor opened before the run, that the file
// system has not stamped yet; a remote file system whose server stamps times from a clock behind the gate's by more
// than RECENT_MS together with timestamps coarser than a second (the listing only sees what the server reports); a
// file system whose times are coarser than RECENT_MS but still carry sub-second parts on some entries.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { latestHandbackId } from "./state.mjs";

export const CACHE_FILE = "test-gate-cache.json";
export const MAX_ENTRIES = 16;
export const MAX_MESSAGE = 8000;
export const MAX_UNTRACKED = 5000;
export const MAX_UNTRACKED_BYTES = 64 * 1024 * 1024;
/** How old a hand-back gate's outcome may be when its stop takes it, in seconds. */
export const REUSE_MAX_S = 30;
/** No entry's mtime or ctime may be later than this many ms before the clock read for L0. */
export const RECENT_MS = 2000;
/** Folders left out of each tree's listing, relative to its root. */
export const LEFT_OUT = [".git", join(".claude", "state"), join(".claude", "worktrees")];
const LIST_VERSION = "1";
const RESULTS = new Set(["pass", "fail", "timeout", "lock_wait"]);
const ENV_FACTS = ["PATH", "NODE_OPTIONS", "NODE_ENV", "CI"];

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
 * The trees a scan covers for the work tree at `cwd`: its top level and, for a linked worktree, the main checkout (real
 * paths); null when git cannot say.
 * @param {string} cwd @returns {string[] | null}
 */
export function scanRoots(cwd) {
  try {
    const top = git(cwd, ["rev-parse", "--show-toplevel"])?.toString("utf8").trim();
    const list = git(cwd, ["worktree", "list", "--porcelain"])?.toString("utf8");
    const main = list ? /^worktree (.*)$/m.exec(list)?.[1] : undefined;
    if (!top || !main) return null;
    return [...new Set([realpathSync(top), realpathSync(main)])];
  } catch {
    return null;
  }
}

/**
 * A listing of the trees (see the header). hash is null when the listing is incomplete (reason: deadline, mount,
 * read_error, no_roots). clock0 and clock1: Date.now() before and after; maxMs: the latest mtime or ctime of any entry
 * (ms); outside: a symlink points outside every tree or into a left-out folder; coarse: no entry has a sub-second time;
 * future: an entry's time is later than clock1.
 * @typedef {{ v: string, hash: string | null, reason: string, clock0: number, clock1: number, maxMs: number, outside: boolean, coarse: boolean, future: boolean, entries: number }} Listing
 */

/**
 * List every entry under `roots` (real paths), symlinks not followed, leaving out LEFT_OUT under each root and the
 * paths in `exclude` (see the header). Gives up (no hash) past `deadline` (ms since the epoch).
 * @param {string[]} roots @param {{ exclude?: string[], deadline?: number }} [o] @returns {Listing}
 */
export function listTrees(roots, o = {}) {
  const clock0 = Date.now();
  const deadline = o.deadline ?? Infinity;
  let maxNs = 0n;
  let sub = false;
  let outside = false;
  let n = 0;
  /** @param {string | null} hash @param {string} reason @returns {Listing} */
  const done = (hash, reason) => {
    const clock1 = Date.now();
    const maxMs = Number(maxNs / 1000n) / 1000;
    return { v: LIST_VERSION, hash, reason, clock0, clock1, maxMs, outside, coarse: n > 0 && !sub, future: maxMs > clock1, entries: n };
  };
  if (!roots.length) return done(null, "no_roots");
  /** @type {string[]} */
  const skip = [];
  for (const r of roots) for (const x of LEFT_OUT) skip.push(join(r, x));
  for (const e of o.exclude ?? []) {
    try {
      skip.push(realpathSync(e));
    } catch {
      skip.push(resolve(e));
    }
  }
  /** @param {string} t @param {string} r */
  const under = (t, r) => t === r || t.startsWith(r + sep);
  // A path is watched when some root holds it and no left-out folder below that root holds it.
  /** @param {string} t */
  const watched = (t) => roots.some((r) => under(t, r) && !skip.some((x) => x !== r && x.startsWith(r + sep) && under(t, x)));
  const skipSet = new Set(skip.filter((x) => !roots.includes(x)));
  const h = createHash("sha256");
  h.update(`v${LIST_VERSION}\0${roots.join("\0")}\n`);
  /** @param {string} p @param {bigint} dev @returns {import("node:fs").BigIntStats | "mount"} */
  const entry = (p, dev) => {
    const st = lstatSync(p, { bigint: true });
    if (st.dev !== dev) return "mount";
    n += 1;
    for (const t of [st.mtimeNs, st.ctimeNs]) {
      if (t > maxNs) maxNs = t;
      if (t % 1000000000n !== 0n) sub = true;
    }
    let type = "o";
    let target = "";
    if (st.isSymbolicLink()) {
      type = "l";
      target = readlinkSync(p);
      const abs = resolve(dirname(p), target);
      /** @type {string | null} */
      let real = null;
      try {
        real = realpathSync(abs);
      } catch {
        try {
          real = join(realpathSync(dirname(abs)), basename(abs));
        } catch {
          real = null;
        }
      }
      if (!real || !watched(real)) outside = true;
    } else if (st.isDirectory()) type = "d";
    else if (st.isFile()) type = "f";
    h.update(`${p}\0${type}\0${st.size}\0${st.mtimeNs}\0${st.ctimeNs}\0${st.ino}\0${st.dev}\0${target}\n`);
    return st;
  };
  try {
    for (const r of roots) {
      const rootDev = lstatSync(r, { bigint: true }).dev;
      if (entry(r, rootDev) === "mount") return done(null, "mount");
      /** @type {string[]} */
      const stack = [r];
      while (stack.length) {
        const dir = /** @type {string} */ (stack.pop());
        const names = readdirSync(dir).sort();
        /** @type {string[]} */
        const dirs = [];
        for (const name of names) {
          if ((n & 255) === 0 && Date.now() > deadline) return done(null, "deadline");
          const p = join(dir, name);
          if (skipSet.has(p)) continue;
          const st = entry(p, rootDev);
          if (st === "mount") return done(null, "mount");
          if (st.isDirectory()) dirs.push(p);
        }
        for (let i = dirs.length - 1; i >= 0; i -= 1) stack.push(/** @type {string} */ (dirs[i]));
      }
    }
    if (Date.now() > deadline) return done(null, "deadline");
    return done(h.digest("hex"), "");
  } catch {
    return done(null, "read_error");
  }
}

/** @param {unknown} l @returns {l is Listing} */
const isListing = (l) => !!l && typeof l === "object" && /** @type {any} */ (l).v === LIST_VERSION && typeof (/** @type {any} */ (l).clock0) === "number";

/**
 * Why an outcome of a run between listings `l0` and `l1` may not be stored, or "" when it may (see the header).
 * @param {Listing | null | undefined} l0 @param {Listing | null | undefined} l1 @returns {string}
 */
export function storeVerdict(l0, l1) {
  if (!isListing(l0)) return "l0_missing";
  if (!isListing(l1)) return "l1_missing";
  if (!l0.hash) return `l0_${l0.reason || "incomplete"}`;
  if (!l1.hash) return `l1_${l1.reason || "incomplete"}`;
  if (l0.outside || l1.outside) return "symlink_outside";
  if (l0.coarse || l1.coarse) return "coarse_times";
  if (l0.future || l1.future) return "future_time";
  if (l1.clock0 < l0.clock1 || l1.clock1 < l0.clock0) return "clock_backwards";
  if (l0.maxMs > l0.clock0 - RECENT_MS) return "recent_change";
  if (l1.hash !== l0.hash) return "tree_changed";
  return "";
}

/**
 * by: the tool_use_id of the hand-back whose gate wrote it; tree: the hash of its L0; clock0: the clock read for L0;
 * used: true once a stop has taken it.
 * @typedef {{ key: string, result: string, ts: string, session_id?: string, agent_id?: string, by?: string, extra?: string, message?: string, tree?: string, clock0?: number, used?: boolean }} CacheEntry
 */

/** @param {string} state @returns {CacheEntry[]} */
export function readCache(state) {
  try {
    const data = JSON.parse(readFileSync(join(state, CACHE_FILE), "utf8"));
    return Array.isArray(data?.entries) ? data.entries.filter((/** @type {any} */ e) => e && typeof e.key === "string" && RESULTS.has(e.result)) : [];
  } catch {
    return [];
  }
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
 * The outcome a stop may take as its own (see the header), marked used, with "" as reason; or no entry and the reason
 * code. `handback` is the hand-back the stop follows. L2 is `l2` when given, else listed here from `roots` (scanRoots)
 * leaving out `exclude` (the state folder), ending at `deadline`.
 * @param {string} state
 * @param {{ key: string, session: string, agent: string, handback: string, roots?: string[] | null, exclude?: string[], deadline?: number, now?: number, maxAgeS?: number, l2?: Listing }} q
 * @returns {{ entry: CacheEntry | null, reason: string }}
 */
export function cacheTakeWhy(state, q) {
  /** @param {string} reason */
  const no = (reason) => ({ entry: null, reason });
  if (!/^[0-9a-f]{64}$/.test(q.key) || !q.session || !q.agent || !q.handback) return no("bad_query");
  const entries = readCache(state);
  const i = entries.findLastIndex((e) => e.by === q.handback && e.agent_id === q.agent && e.session_id === q.session);
  const e = entries[i];
  if (!e) return no("no_entry");
  if (e.used) return no("used");
  if (e.key !== q.key) return no("key_changed");
  if (typeof e.tree !== "string" || !/^[0-9a-f]{64}$/.test(e.tree) || typeof e.clock0 !== "number") return no("no_tree");
  const age = (q.now ?? Date.now()) - Date.parse(e.ts);
  if (!(age >= 0 && age <= (q.maxAgeS ?? REUSE_MAX_S) * 1000)) return no("too_old");
  const l2 = q.l2 ?? (q.roots?.length ? listTrees(q.roots, { exclude: q.exclude, deadline: q.deadline }) : null);
  if (!isListing(l2)) return no("l2_missing");
  if (!l2.hash) return no(`l2_${l2.reason || "incomplete"}`);
  if (l2.outside) return no("symlink_outside");
  if (l2.future) return no("future_time");
  if (l2.clock0 < e.clock0) return no("clock_backwards");
  if (l2.hash !== e.tree) return no("tree_changed");
  // Marked before it is returned: when the mark cannot be written, nothing is reused.
  if (!writeEntries(state, entries.map((x, j) => (j === i ? { ...x, used: true } : x)))) return no("mark_failed");
  return { entry: e, reason: "" };
}

/** cacheTakeWhy's entry alone. @param {string} state @param {Parameters<typeof cacheTakeWhy>[1]} q @returns {CacheEntry | null} */
export const cacheTake = (state, q) => cacheTakeWhy(state, q).entry;

/**
 * Store an outcome of a hand-back's run taken between listings `l0` and `l1`: only when storeVerdict allows it, with
 * L0's hash and clock. Replaces an entry of the same hand-back, keeps the newest MAX_ENTRIES, written atomically.
 * Returns "stored", or the reason code why nothing was stored.
 * @param {string} state @param {CacheEntry} entry @param {Listing | null | undefined} l0 @param {Listing | null | undefined} l1
 * @returns {string}
 */
export function cachePut(state, entry, l0, l1) {
  if (!/^[0-9a-f]{64}$/.test(entry.key) || !RESULTS.has(entry.result)) return "bad_entry";
  const why = storeVerdict(l0, l1);
  if (why || !l0?.hash) return why || "l0_missing";
  try {
    const rest = readCache(state).filter((e) => !(e.by && e.by === entry.by && e.agent_id === entry.agent_id && e.session_id === entry.session_id));
    const clean = { ...entry, tree: l0.hash, clock0: l0.clock0, ...(typeof entry.message === "string" ? { message: entry.message.slice(-MAX_MESSAGE) } : {}) };
    return writeEntries(state, [...rest, clean]) ? "stored" : "write_failed";
  } catch {
    return "write_failed";
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

// CLI for verify.sh. Every command exits 0 on any error, so the gate then runs as it would without a cache. <secs> is
// the time the command may take (its listing stops there; verify.sh also limits the process).
//   key <cwd> <cmd> <isolated>                   prints the tree key, or nothing
//   list <state> <cwd> <secs>                    prints a listing of the trees (one JSON line; hash null if incomplete)
//   put <state> <key> <result> <handback-id> <extra> <session> <agent> <l0-file> <l1-file>   message on stdin; prints
//                                                "stored" or the reason code why nothing was stored
//   take <state> <key> <session> <agent> <handback-id> <cwd> <secs>   prints result, by, extra, then the message; or
//                                                "none" and the reason code when no outcome may be taken (cacheTakeWhy)
//   link <state> <session> <agent>               prints the hand-back the agent's stop follows, or nothing
//   refused <state> <session> <agent> <exclude-id>   prints a count
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  const t0 = Date.now();
  const [cmd, ...a] = process.argv.slice(2);
  /** @param {string | undefined} s */
  const deadlineOf = (s) => t0 + Math.max(0, Number(s) || 0) * 1000;
  /** @param {string} p @returns {Listing | null} */
  const readListing = (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf8"));
    } catch {
      return null;
    }
  };
  try {
    if (cmd === "key") {
      const key = treeKey(a[0] ?? ".", a[1] ?? "", { isolated: a[2] ?? "" });
      if (key) process.stdout.write(`${key}\n`);
    } else if (cmd === "list") {
      const roots = scanRoots(a[1] ?? ".");
      const l = roots ? listTrees(roots, { exclude: [a[0] ?? ""].filter(Boolean), deadline: deadlineOf(a[2]) }) : null;
      if (l) process.stdout.write(`${JSON.stringify(l)}\n`);
    } else if (cmd === "take") {
      const state = a[0] ?? "";
      const r = cacheTakeWhy(state, { key: a[1] ?? "", session: a[2] ?? "", agent: a[3] ?? "", handback: a[4] ?? "", roots: scanRoots(a[5] ?? "."), exclude: [state], deadline: deadlineOf(a[6]) });
      const e = r.entry;
      if (e) process.stdout.write(`${e.result}\n${String(e.by ?? "").replace(/[^A-Za-z0-9_.:-]/g, "")}\n${String(e.extra ?? "").replace(/\n/g, "")}\n${e.message ?? ""}`);
      else process.stdout.write(`none\n${r.reason}\n`);
    } else if (cmd === "put") {
      const state = a[0] ?? "";
      const message = readFileSync(0, "utf8");
      const entry = { key: a[1] ?? "", result: a[2] ?? "", ts: new Date().toISOString(), by: a[3] ?? "", extra: a[4] ?? "", session_id: a[5] ?? "", agent_id: a[6] ?? "", message };
      process.stdout.write(`${cachePut(state, entry, readListing(a[7] ?? ""), readListing(a[8] ?? ""))}\n`);
    } else if (cmd === "link") process.stdout.write(latestHandbackId(a[1] ?? "", a[2] ?? "", a[0] ?? "") ?? "");
    else if (cmd === "refused") process.stdout.write(String(refusedHandbacks(a[0] ?? "", a[1] ?? "", a[2] ?? "", a[3] ?? "")));
  } catch {
    // nothing printed: no cache
  }
  process.exit(0);
}
