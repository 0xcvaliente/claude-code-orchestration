#!/usr/bin/env node
// The test gate's result cache (2.0.0). Not a hook: verify.sh calls its CLI. Node built-ins and state.mjs only; no side
// effects at import beyond state.mjs reading settings.
//
// One use only. verify.sh runs the suite at an implementer's hand-back (PreToolUse on SubagentHandback, --handback), and
// the SubagentStop gate follows seconds after a delivered hand-back. That stop gate may take the hand-back gate's outcome
// as its own instead of running the suite again, and nothing else ever reuses one (cacheTake). All of these must hold,
// else the suite runs:
//   1. the outcome was written by the hand-back gate of the same session and agent, for the agent's latest hand-back
//      since its latest start (state.mjs latestHandbackId: the tool_use_id the stop follows): never across agents,
//      sessions, runs or a later start;
//   2. it was not taken before (an entry is marked used when taken: one reuse per hand-back);
//   3. the tree key (treeKey) is the same: tracked, staged, unstaged and untracked content, the command and the facts;
//   4. nothing the suite could read changed since the hand-back's run began (scanTree): the work tree and, for a linked
//      worktree, the main checkout (node_modules resolves through it), git-ignored files included, hold no file, folder
//      or symlink whose mtime or ctime is at or after the run's start, other than exactly the entries the run itself
//      created, recorded when it ended with their size, mtime, ctime and birth time, and still identical. A change made
//      after the run ended gives a newer ctime (the kernel sets it on every write, rename or chmod, and it cannot be set
//      back without changing the clock), so it is either a new entry or a listed entry whose times differ: no reuse;
//   5. no symlink anywhere in those trees points outside them (its target's content is not watched);
//   6. the scans finished within their time limit, the file system keeps sub-second times, and the run created its
//      entries rather than rewrote existing ones (an entry with a birth time before the run's start, or no birth time,
//      in the run's list means no record is written at all: an existing git-ignored file the run changed may be an
//      input changed by another process while the suite ran);
//   7. it is at most REUSE_MAX_S seconds old (live, the stop came 1 to 2 s after the hand-back): a second line of defence.
// The scans leave out every folder named .git, the gate's state folder and .claude/worktrees (other slices' worktrees;
// a linked worktree under it is scanned as its own root). What they do not see: files outside the two trees that a test
// reads directly (not through a symlink in them), and a change by another process during the run itself to a file the
// run then lists as its own creation (a file replaced by rename).
// Outcomes stored: "pass" (exit 0), "fail" (a test failure, with the block message), "timeout" (the suite was stopped
// at its limit: reused as a timed-out block, never a pass) and "lock_wait" (the hand-back gate gave up waiting for the
// suite lock: the stop gate does not wait again). The file is test-gate-cache.json in the state dir, at most MAX_ENTRIES
// entries, each message cut to MAX_MESSAGE characters, written whole to a temporary file and renamed into place. Two
// gates writing at once may lose one entry: a lost entry only means the suite runs again.
// Any doubt gives no key (and so no record and no reuse): not a git work tree, a failing git command, a repository with
// submodules, more than MAX_UNTRACKED files or MAX_UNTRACKED_BYTES bytes untracked, an untracked file that cannot be read.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { latestHandbackId } from "./state.mjs";

export const CACHE_FILE = "test-gate-cache.json";
export const MAX_ENTRIES = 16;
export const MAX_MESSAGE = 8000;
export const MAX_UNTRACKED = 5000;
export const MAX_UNTRACKED_BYTES = 64 * 1024 * 1024;
/** At most this many entries newer than the run's start; more means no record. */
export const MAX_DURING = 2000;
/** How old a hand-back gate's outcome may be when its stop takes it, in seconds. */
export const REUSE_MAX_S = 30;
/** The run's start is taken this many ms early: the kernel stamps files from a coarse clock that may lag Date.now(). */
export const CLOCK_SLACK_MS = 100;
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
 * @typedef {{ p: string, d: number, s: number, m: number, c: number, b: number }} ScanEntry
 * @typedef {{ complete: boolean, newer: ScanEntry[], outside: boolean }} ScanResult
 */

/**
 * Every file, folder and symlink under `roots` whose mtime or ctime is at or after `since` (ms), symlinks not followed,
 * leaving out folders named .git, `.claude/worktrees` under each root, and the paths in `exclude`. `outside` is true when
 * a symlink's target lies outside every root. Incomplete (nothing else to trust) past `deadline` (ms since the epoch),
 * past MAX_DURING newer entries, or on any read error.
 * @param {string[]} roots real paths @param {number} since
 * @param {{ exclude?: string[], deadline?: number }} [o] @returns {ScanResult}
 */
export function scanTree(roots, since, o = {}) {
  const fail = { complete: false, newer: [], outside: false };
  const deadline = o.deadline ?? Infinity;
  const skip = new Set(roots.map((r) => join(r, ".claude", "worktrees")));
  for (const e of o.exclude ?? []) {
    try {
      skip.add(realpathSync(e));
    } catch {
      skip.add(resolve(e));
    }
  }
  for (const r of roots) skip.delete(r);
  /** @param {string} t */
  const inside = (t) => roots.some((r) => t === r || t.startsWith(r + sep));
  /** @type {ScanEntry[]} */
  const newer = [];
  let outside = false;
  let n = 0;
  /** @param {string} p @returns {import("node:fs").Stats | null} */
  const look = (p) => {
    const st = lstatSync(p);
    if (st.isSymbolicLink()) {
      let t;
      try {
        t = realpathSync(p);
      } catch {
        t = resolve(dirname(p), readlinkSync(p));
      }
      if (!inside(t)) outside = true;
    }
    if (Math.max(st.mtimeMs, st.ctimeMs) >= since) newer.push({ p, d: st.isDirectory() ? 1 : 0, s: st.size, m: st.mtimeMs, c: st.ctimeMs, b: st.birthtimeMs });
    return st;
  };
  try {
    const stack = [];
    for (const r of roots) {
      look(r);
      stack.push(r);
    }
    while (stack.length) {
      const dir = /** @type {string} */ (stack.pop());
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if ((++n & 255) === 0 && Date.now() > deadline) return fail;
        if (d.name === ".git") continue;
        const p = join(dir, d.name);
        if (skip.has(p)) continue;
        const st = look(p);
        if (newer.length > MAX_DURING) return fail;
        if (st?.isDirectory()) stack.push(p);
      }
    }
    if (Date.now() > deadline) return fail;
    return { complete: true, newer, outside };
  } catch {
    return fail;
  }
}

/** A time that is a whole second (a file system that keeps no sub-second times). @param {number} t */
const wholeSecond = (t) => t % 1000 === 0;

/**
 * What the run itself created, from the scan taken when it ended, or null when no record may be written (see the header,
 * points 4 to 6). `since` is the run's start (ms).
 * @param {ScanResult} scan @param {number} since @returns {ScanEntry[] | null}
 */
export function runCreated(scan, since) {
  if (!scan.complete || scan.outside) return null;
  for (const e of scan.newer) {
    if (wholeSecond(e.m) && wholeSecond(e.c)) return null;
    if (!e.d && !(e.b >= since)) return null;
  }
  return scan.newer;
}

/**
 * True when the scan at the stop shows nothing new since the run's start but exactly the run's own entries, unchanged.
 * @param {ScanResult} scan @param {ScanEntry[]} during @returns {boolean}
 */
export function unchangedSince(scan, during) {
  if (!scan.complete || scan.outside) return false;
  const known = new Map(during.map((e) => [e.p, e]));
  for (const e of scan.newer) {
    const k = known.get(e.p);
    if (!k || k.d !== e.d || k.s !== e.s || k.m !== e.m || k.c !== e.c || k.b !== e.b) return false;
    if (wholeSecond(e.m) && wholeSecond(e.c)) return false;
  }
  return true;
}

/**
 * by: the tool_use_id of the hand-back whose gate wrote it; since: the run's start (ms); during: the entries the run
 * created; used: true once a stop has taken it.
 * @typedef {{ key: string, result: string, ts: string, session_id?: string, agent_id?: string, by?: string, extra?: string, message?: string, since?: number, during?: ScanEntry[], used?: boolean }} CacheEntry
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
 * The outcome a stop may take as its own (see the header), marked used, or null. `handback` is the hand-back the stop
 * follows; `roots` and `exclude` are the scan's (scanRoots, the state folder); `deadline` ends the scan.
 * @param {string} state
 * @param {{ key: string, session: string, agent: string, handback: string, roots?: string[] | null, exclude?: string[], deadline?: number, now?: number, maxAgeS?: number }} q
 * @returns {CacheEntry | null}
 */
export function cacheTake(state, q) {
  if (!/^[0-9a-f]{64}$/.test(q.key) || !q.session || !q.agent || !q.handback) return null;
  const entries = readCache(state);
  const i = entries.findLastIndex((e) => e.by === q.handback && e.agent_id === q.agent && e.session_id === q.session);
  const e = entries[i];
  if (!e || e.used || e.key !== q.key || typeof e.since !== "number" || !Array.isArray(e.during)) return null;
  const age = (q.now ?? Date.now()) - Date.parse(e.ts);
  if (!(age >= 0 && age <= (q.maxAgeS ?? REUSE_MAX_S) * 1000)) return null;
  if (!q.roots?.length) return null;
  if (!unchangedSince(scanTree(q.roots, e.since, { exclude: q.exclude, deadline: q.deadline }), e.during)) return null;
  // Marked before it is returned: when the mark cannot be written, nothing is reused.
  if (!writeEntries(state, entries.map((x, j) => (j === i ? { ...x, used: true } : x)))) return null;
  return e;
}

/**
 * Store an outcome of a hand-back's run: replaces an entry of the same hand-back, keeps the newest MAX_ENTRIES, written
 * atomically. With `roots`, the scan of what the run created is taken here, and nothing is stored when it may not be.
 * @param {string} state @param {CacheEntry} entry @param {{ roots?: string[] | null, exclude?: string[], deadline?: number }} [scan]
 * @returns {boolean}
 */
export function cachePut(state, entry, scan) {
  if (!/^[0-9a-f]{64}$/.test(entry.key) || !RESULTS.has(entry.result)) return false;
  try {
    let during = entry.during;
    if (scan) {
      if (!scan.roots?.length || typeof entry.since !== "number") return false;
      during = runCreated(scanTree(scan.roots, entry.since, { exclude: scan.exclude, deadline: scan.deadline }), entry.since) ?? undefined;
      if (!during) return false;
    }
    const rest = readCache(state).filter((e) => !(e.by && e.by === entry.by && e.agent_id === entry.agent_id && e.session_id === entry.session_id));
    const clean = { ...entry, ...(during ? { during } : {}), ...(typeof entry.message === "string" ? { message: entry.message.slice(-MAX_MESSAGE) } : {}) };
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
// a cache. <secs> is the time the command may take (its scan stops there; verify.sh also limits the process).
//   key <cwd> <cmd> <isolated>                prints the tree key, then the run's start (ms, CLOCK_SLACK_MS early)
//   take <state> <key> <session> <agent> <handback-id> <cwd> <secs>   prints result, by, extra, then the message;
//                                              nothing when no outcome may be taken (cacheTake)
//   put <state> <key> <result> <handback-id> <extra> <session> <agent> <since> <cwd> <secs>   message on stdin
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
  const t0 = Date.now();
  const [cmd, ...a] = process.argv.slice(2);
  /** @param {string | undefined} s */
  const deadlineOf = (s) => t0 + Math.max(0, Number(s) || 0) * 1000;
  try {
    if (cmd === "key") {
      const key = treeKey(a[0] ?? ".", a[1] ?? "", { isolated: a[2] ?? "" });
      if (key) process.stdout.write(`${key}\n${t0 - CLOCK_SLACK_MS}\n`);
    } else if (cmd === "take") {
      const state = a[0] ?? "";
      const e = cacheTake(state, { key: a[1] ?? "", session: a[2] ?? "", agent: a[3] ?? "", handback: a[4] ?? "", roots: scanRoots(a[5] ?? "."), exclude: [state], deadline: deadlineOf(a[6]) });
      if (e) process.stdout.write(`${e.result}\n${String(e.by ?? "").replace(/[^A-Za-z0-9_.:-]/g, "")}\n${String(e.extra ?? "").replace(/\n/g, "")}\n${e.message ?? ""}`);
    } else if (cmd === "put") {
      const state = a[0] ?? "";
      const message = readFileSync(0, "utf8");
      const since = Number(a[7]);
      if (Number.isFinite(since) && since > 0) {
        cachePut(
          state,
          { key: a[1] ?? "", result: a[2] ?? "", ts: new Date().toISOString(), by: a[3] ?? "", extra: a[4] ?? "", session_id: a[5] ?? "", agent_id: a[6] ?? "", since, message },
          { roots: scanRoots(a[8] ?? "."), exclude: [state], deadline: deadlineOf(a[9]) },
        );
      }
    } else if (cmd === "link") process.stdout.write(latestHandbackId(a[1] ?? "", a[2] ?? "", a[0] ?? "") ?? "");
    else if (cmd === "refused") process.stdout.write(String(refusedHandbacks(a[0] ?? "", a[1] ?? "", a[2] ?? "", a[3] ?? "")));
  } catch {
    // nothing printed: no cache
  }
  process.exit(0);
}
