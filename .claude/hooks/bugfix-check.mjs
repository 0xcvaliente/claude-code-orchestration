#!/usr/bin/env node
// Helper of the test gate (verify.sh calls it; it is not a hook of its own). Two jobs, both judged against the base of
// the agent's tree: HEAD for the shared tree, the fork point from the main worktree's HEAD for an isolated worktree.
//   baseline  (stdin: the failing test output; --mode from ORCH_BASELINE; off in verify.sh skips the call) -- when the
//             tree has changes against its base, run the same test command in a clean detached worktree of the base.
//             inform (default): never allows; the gate still blocks with tests_failed, and the block message lists
//             the qualified failing tests that also fail on the base as probably pre-existing (counts are logged).
//             allow (opt-in, HEURISTIC): warn with tests_failed_baseline when every failing test of the working-tree
//             run, qualified by its file or package, also fails on the base. Runner output cannot be parsed
//             completely, so a failure that never shows as a named test can slip through; the guards are: never
//             when a failure is unqualified or a runner-level crash marker is present (suite failed to run,
//             collection or import error, build failure, go FAIL <pkg> without a named test, panics, vitest
//             unhandled errors, cargo binary crash or signal, jest coverage threshold), never when cargo stopped at a
//             failing target (its rerun hint ends the run without the --no-fail-fast summary) or the command is a
//             unittest run with failfast (-f, --failfast), never when the base run
//             timed out, could not use the main worktree's dependencies, or failed without parsable names.
//   bugfix    (stdin: the SubagentStop event; ORCH_BUGFIX_CHECK=off skips it) -- for an implementer whose brief says
//             KIND: bugfix, after the tests passed: at least one test file must be changed or added against the base,
//             and the base run with those files copied in must show at least one new qualified failing test that
//             lives in a copied file, compared with the base run without them (a failure of the whole file, such as
//             an import error, does not count: the test body has to run and fail). Blocks say what is missing; after two
//             such blocks for the agent since its latest SubagentStart it allows with bugfix_unverified_gave_up. A base
//             run that cannot start because a lock file differs from the base's (cause lock_mismatch) is outside the
//             worker's reach: it allows with bugfix_unverified_gave_up at once, with the cause, and never blocks.
// Base worktrees are created detached in the OS temp dir (prefix orch-base-) and always removed, also when SIGTERM,
// SIGINT or SIGHUP stops the helper (verify.sh terminates it at its time budget); each base run first
// prunes leftovers of killed runs (git worktree prune, and orch-base- dirs older than an hour). Nothing commits or moves
// a branch. node_modules is symlinked from the main worktree only, and only when the base's lock files match the main
// worktree's; otherwise there is no base run. A base run runs in its own process group, limited to
// ORCH_BASE_TIMEOUT_S seconds (default 300); on timeout the group is killed and it counts as "no baseline".
// The hook needs a timeout of at least 2 x ORCH_BASE_TIMEOUT_S plus the test run (bugfix may run the base twice).
// Base results are cached per base commit, command and run subdirectory in <state>/baseline-cache.json, only when the
// run finished in time and either passed or failed with fully parsable names (an environment failure is never cached).
// Output protocol (stdout, empty means "no opinion", verify.sh then decides as before): line 1 the decision (allow,
// warn, block, or inform: keep the block and add the message), line 2 the reason, line 3 extra JSON fields for the
// gate record (counts only, may be empty), then the message for the agent. Any error prints nothing and exits 0.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHeader } from "./brief.mjs";

export const MAX_BUGFIX_BLOCKS = 2;
const BASE_PREFIX = "orch-base-";
const STALE_MS = 60 * 60 * 1000;

/** @param {string} p */
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

// ---------------------------------------------------------------------------------------------------------------
// Failing tests from runner output, each qualified as "<file or package>::<name>":
//   node --test TAP: "not ok" with the YAML "location:" file; spec reporter: the "✖ failing tests:" summary, where
//     each "✖ name" follows a "test at <file>" line;
//   jest: "FAIL <file>" header, then "●"/"✕" names; vitest: "FAIL  <file> > name", or "❯ <file>" then "×" names;
//   pytest: "FAILED/ERROR path::name"; unittest: "FAIL:/ERROR: name (module.Class.name)", the module as its .py path;
//   go: "--- FAIL: TestX" qualified by the "FAIL <pkg>" line that follows;
//   cargo: "test name ... FAILED" qualified by the preceding "Running <target>"; under --quiet (the detected command)
//     "name --- FAILED" qualified by the "error: test failed, to rerun pass `--lib`" (src/lib.rs) or
//     "`--test x`" (tests/x.rs) hint that follows.
// A failure with no file or package goes to `unqualified`; a suite-level crash sets `crash`.
// Absolute paths under `root` (the run's tree) are made relative so two trees compare.
// ---------------------------------------------------------------------------------------------------------------
/** @typedef {{ names: string[], unqualified: string[], crash: boolean }} Failures */

// Runner-level failures that no test name stands for: their presence makes a run incomplete.
const CRASH_RE = [
  /Test suite failed to run/,
  /errors? during collection/i,
  /ImportError while importing test module/,
  /^_+ ERROR collecting /,
  /error: could not compile/,
  /\[(build|setup) failed\]/,
  /Unhandled (?:Errors?|Rejections?)\b/, // vitest
  /process didn't exit successfully/, // cargo: a test binary crashed
  /\bsignal: \d+, SIG[A-Z]+/, // cargo: killed by a signal
  /coverage threshold/i, // jest
  /^error: test failed\b/, // cargo
  /^panic: /, // go
];

/** @param {unknown} text @param {string} [root] @returns {Failures} */
export function parseFailures(text, root = "") {
  /** @type {Failures} */
  const res = { names: [], unqualified: [], crash: false };
  if (typeof text !== "string") return res;
  // eslint-disable-next-line no-control-regex
  const lines = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  const roots = root ? [...new Set([root, real(root)])] : [];
  /** @param {string} q */
  const norm = (q) => {
    let p = q.trim().replace(/^['"]|['"]$/g, "").replace(/^file:\/\//, "").replace(/:\d+(?::\d+)?$/, "");
    for (const r of roots) if (p.startsWith(`${r}/`)) p = p.slice(r.length + 1);
    return p.replace(/^\.\//, "");
  };
  /** @type {Set<string>} */
  const names = new Set();
  /** @type {Set<string>} */
  const unq = new Set();
  /** @param {string | null | undefined} file @param {string | undefined} name */
  const add = (file, name) => {
    const n = (name ?? "").trim();
    if (!n) return;
    if (file) names.add(`${norm(file)}::${n}`);
    else unq.add(n);
  };
  const specSummary = lines.findIndex((l) => /^\s*✖ failing tests:?$/.test(l));
  /** @type {string | null} */
  let specFile = null;
  /** @type {string | null} */
  let jsFile = null;
  /** @type {string[]} */
  let goPending = [];
  /** @type {string | null} */
  let cargoTarget = null;
  /** @type {string[]} */
  let cargoPending = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    // cargo --quiet: the rerun hint qualifies the names listed before it, so with names pending it is no crash.
    const hint = /^error: test failed, to rerun pass `([^`]*)`/.exec(line);
    if (CRASH_RE.some((re) => re.test(line)) && !(hint && cargoPending.length)) res.crash = true;
    let m;
    if (hint) {
      // "--lib" is src/lib.rs, "--test x" tests/x.rs (cargo's default layout); any other target keeps the hint's words.
      // A workspace's "-p <package>" becomes a leading folder ("<package>/tests/x.rs"), which inFiles matches as the
      // tail of the member's path (crates/<package>/tests/x.rs), so another member's file of the same name never matches.
      const all = (hint[1] ?? "").split(/\s+/).filter(Boolean);
      const pk = all.findIndex((w) => /^(-p|--package)$/.test(w));
      const pkg = pk >= 0 ? all[pk + 1] : undefined;
      const t = pk >= 0 ? all.filter((w, k) => k !== pk && k !== pk + 1) : all;
      const test = t.indexOf("--test") >= 0 ? t[t.indexOf("--test") + 1] : undefined;
      const file = t.includes("--lib") ? "src/lib.rs" : test ? `tests/${test}.rs` : "";
      const target = file ? (pkg ? `${pkg}/${file}` : file) : t.join(" ").replace(/^--/, "");
      for (const n of cargoPending) add(target || null, n);
      cargoPending = [];
    } else if ((m = /^(\S+) --- FAILED$/.exec(line))) {
      cargoPending.push(m[1] ?? "");
    } else if ((m = /^\s*not ok\s+\d+\s*(?:-\s*)?(.*)$/.exec(line))) {
      if (/#\s*(?:SKIP|TODO)\b/i.test(m[1] ?? "")) continue;
      /** @type {string | null} */
      let loc = null;
      for (let j = i + 1; j < lines.length; j++) {
        const y = lines[j] ?? "";
        if (/^\s*\.\.\.$/.test(y) || /^\s*(?:not )?ok\s+\d+/.test(y) || /^\S/.test(y)) break;
        const l = /^\s+location:\s*(.+)$/.exec(y);
        if (l) {
          loc = l[1] ?? null;
          break;
        }
      }
      add(loc, m[1]);
    } else if ((m = /^\s*test at (.+)$/.exec(line)) && specSummary >= 0 && i > specSummary) {
      specFile = m[1] ?? null;
    } else if ((m = /^\s*✖\s+(.+?)(?:\s+\(\d[\d.]*\s*m?s\))?$/.exec(line))) {
      if (/^failing tests:?$/.test(m[1] ?? "")) continue;
      if (specSummary >= 0 && i < specSummary) continue; // listed again, with its file, in the summary
      add(specFile, m[1]);
      specFile = null;
    } else if ((m = /^FAIL\t(\S+)/.exec(line) ?? /^FAIL\s+(\S+)\s+[\d.]+s$/.exec(line))) {
      // go's package line ("FAIL\t<pkg>\t0.01s"): it qualifies the pending "--- FAIL" names; with none pending the
      // package failed without a named test (init panic, build or setup failure, TestMain exit).
      if (goPending.length === 0) res.crash = true;
      for (const n of goPending) add(m[1], n);
      goPending = [];
    } else if ((m = /^\s*FAIL\s+(\S.*)$/.exec(line))) {
      const rest = m[1] ?? "";
      if (goPending.length) {
        const pkg = rest.split(/\s+/)[0] ?? "";
        for (const n of goPending) add(pkg, n);
        goPending = [];
      } else if (rest.includes(" > ")) {
        const k = rest.indexOf(" > ");
        add(rest.slice(0, k), rest.slice(k + 3));
      } else {
        if (/\[\s*\S+\s*\]$/.test(rest)) res.crash = true; // vitest: the file failed as a whole
        jsFile = rest.replace(/\s+\[.*\]$/, "").replace(/\s+\([\d.]+\s*m?s\)$/, "").trim();
      }
    } else if ((m = /^\s*❯\s+(\S+)/.exec(line))) {
      jsFile = m[1] ?? null;
    } else if ((m = /^\s*●\s+(.+)$/.exec(line))) {
      const n = m[1] ?? "";
      if (/^Console$/.test(n)) continue;
      if (/^Test suite failed to run/.test(n)) res.crash = true;
      else add(jsFile, n);
    } else if ((m = /^\s*[✕×]\s+(.+?)(?:\s+\d[\d.]*\s*m?s|\s+\(\d[\d.]*\s*m?s\))?$/.exec(line))) {
      add(jsFile, m[1]);
    } else if ((m = /^(?:FAIL|ERROR): (\S+) \(([\w.]+)\)/.exec(line))) {
      // unittest: "FAIL: test_x (pkg.mod.Class.test_x)" (Python 3.11+) or "(pkg.mod.Class)" before; a module that
      // fails to import shows as unittest.loader._FailedTest, a crash with no test of its own.
      const test = m[1] ?? "";
      const parts = (m[2] ?? "").split(".");
      if (/^unittest\.loader\._Failed/.test(m[2] ?? "")) {
        res.crash = true;
        continue;
      }
      if (parts.length > 2 && parts[parts.length - 1] === test) parts.pop();
      const cls = parts.length > 1 ? parts.pop() : undefined;
      if (cls) add(`${parts.join("/")}.py`, `${cls}.${test}`);
      else add(null, test);
    } else if ((m = /^(FAILED|ERROR)\s+(\S+?\[.*?\]|\S+)(?:\s+-\s.*)?$/.exec(line))) { // a parametrized id may hold spaces
      const id = m[2] ?? "";
      if (id.startsWith("(")) continue; // unittest's "FAILED (failures=1)"
      const k = id.indexOf("::");
      if (k > 0) add(id.slice(0, k), id.slice(k + 2));
      else if (m[1] === "ERROR") res.crash = true; // collection error of a whole module
      else add(null, id);
    } else if ((m = /^\s*--- FAIL:\s+(\S+)/.exec(line))) {
      goPending.push(m[1] ?? "");
    } else if ((m = /^\s*Running\s+(?:unittests\s+)?(\S+)/.exec(line))) {
      cargoTarget = m[1] ?? null;
    } else if ((m = /^test\s+(\S+)\s+\.\.\.\s+FAILED$/.exec(line))) {
      add(cargoTarget, m[1]);
    }
  }
  for (const n of goPending) add(null, n);
  for (const n of cargoPending) add(null, n);
  res.names = [...names].sort();
  res.unqualified = [...unq].sort();
  return res;
}

/** Names to compare: at least one, all qualified, no crash. @param {Failures} f */
export const complete = (f) => f.names.length > 0 && f.unqualified.length === 0 && !f.crash;

/**
 * A cargo run that stopped at a failing test target: cargo (without --no-fail-fast) stops after the first target that
 * fails, so its last line is that target's rerun hint and the targets after it never ran. Under --no-fail-fast every
 * target runs and cargo ends with an "error: N target(s) failed:" summary, which closes the hints before it. The names
 * such a run printed stay usable (bugfix check, the inform note); only the allow decision treats it as incomplete.
 * @param {unknown} text
 */
export function stoppedEarly(text) {
  if (typeof text !== "string") return false;
  let stopped = false;
  // eslint-disable-next-line no-control-regex
  for (const l of text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/)) {
    if (/^error: test failed, to rerun pass `/.test(l)) stopped = true;
    else if (/^error: \d+ targets? failed:\s*$/.test(l)) stopped = false;
  }
  return stopped;
}

/**
 * A unittest command that stops at its first failure (-f, --failfast, or -f among combined short flags): unittest
 * prints its FAIL:/ERROR: blocks only after the run, but that output carries no mark of a failfast stop, so the
 * command is the only sign. Without failfast a run cut short (a crash, os._exit, a kill) prints no names at all.
 * @param {string} cmd
 */
export const failFastCmd = (cmd) => /\bunittest\b/.test(cmd) && /(?:^|\s)(?:--failfast|-[A-Za-z]*f[A-Za-z]*)(?=\s|;|&|\||$)/.test(cmd);

/**
 * A unittest run whose failfast is set inside a script the command runs (unittest.main(failfast=True),
 * TextTestRunner(failfast=True), a config file): the command does not show it and the output carries no mark of it, so
 * for output in unittest's form (its "Ran N tests in" line) the tree is searched: any Python, cfg, toml or ini file,
 * tracked or untracked, that holds the word failfast counts as a failfast run. A search that cannot run counts too
 * (fail closed). Not seen: a "-f" put into argv by a script.
 * @param {string} cwd @param {unknown} output
 */
export function failFastInTree(cwd, output) {
  if (typeof output !== "string" || !/^Ran \d+ tests? in /m.test(output)) return false;
  const r = spawnSync("git", ["grep", "-I", "-l", "-w", "--untracked", "-e", "failfast", "--", "*.py", "*.cfg", "*.toml", "*.ini"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    timeout: 30000,
  });
  return r.status !== 1; // 0: found; 1: none; anything else: the search failed
}

// Test files by path: under a test folder, or named like a test in the common runners.
/** @param {string} path */
export function isTestFile(path) {
  const p = path.replace(/\\/g, "/");
  if (/(^|\/)(test|tests|__tests__|spec|specs)\//i.test(p)) return true;
  const base = p.split("/").pop() ?? "";
  return (
    /\.(test|spec)\.[A-Za-z0-9]+$/i.test(base) ||
    /^test_.*\.py$/i.test(base) ||
    /_test\.(py|go|sh|rb|exs?)$/i.test(base) ||
    /_spec\.rb$/i.test(base) ||
    /Tests?\.(java|kt|cs|swift|scala)$/.test(base)
  );
}

/**
 * The failure's file or package is one of the copied test files (or, for a go package, a copied file's folder).
 * @param {string} name @param {string[]} files @param {Record<string, string>} [pkgDirs] cargo package name to its folder
 */
export function inFiles(name, files, pkgDirs = {}) {
  const k = name.indexOf("::");
  if (k <= 0) return false;
  const q = name.slice(0, k).replace(/\\/g, "/");
  // cargo: "<package>/tests/x.rs" of a workspace member whose folder is not named after its package (cargoPackageDirs).
  const first = q.split("/")[0] ?? "";
  if (/\.rs$/.test(q) && q.includes("/") && Object.hasOwn(pkgDirs, first)) {
    const dir = pkgDirs[first] ?? "";
    const mapped = dir ? `${dir}/${q.slice(first.length + 1)}` : q.slice(first.length + 1);
    if (files.includes(mapped)) return true;
  }
  return files.some((t) => {
    if (q === t || q.endsWith(`/${t}`)) return true;
    // unittest: a module path relative to discover's start folder; cargo: a workspace member's "<package>/tests/x.rs".
    if (/\.(py|rs)$/.test(q) && t.endsWith(`/${q}`)) return true;
    const d = dirname(t);
    return d !== "." && /\.go$/.test(t) && (q === d || q.endsWith(`/${d}`));
  });
}

/**
 * For the copied cargo test files (`.rs`), each one's package name (the [package] name of the nearest Cargo.toml in
 * its folder or above it, within `top`) mapped to that Cargo.toml's folder, root-relative ("" for the root). cargo's
 * quiet rerun hint names a workspace member by its package (`-p <package>`), which need not be its folder's name.
 * A Cargo.toml that cannot be read or names no package adds nothing.
 * @param {string} top @param {string[]} files @returns {Record<string, string>}
 */
export function cargoPackageDirs(top, files) {
  /** @type {Record<string, string>} */
  const map = Object.create(null); // a package named __proto__ is a key like any other
  /** @type {Map<string, string>} folder -> its Cargo.toml's text ("" for none) */
  const tomls = new Map();
  /** @param {string} rel */
  const toml = (rel) => {
    if (!tomls.has(rel)) {
      try {
        tomls.set(rel, readFileSync(join(top, rel, "Cargo.toml"), "utf8"));
      } catch {
        tomls.set(rel, "");
      }
    }
    return tomls.get(rel) ?? "";
  };
  for (const f of files) {
    if (!/\.rs$/.test(f)) continue;
    let d = dirname(f.replace(/\\/g, "/"));
    for (let depth = 0; depth < 64; depth += 1) {
      const rel = d === "." ? "" : d;
      const text = toml(rel);
      if (text) {
        // The nearest Cargo.toml decides, whether it names a package or not.
        const pkg = /^[ \t]*\[package\][ \t]*\r?$([\s\S]*?)(?=^[ \t]*\[|(?![\s\S]))/m.exec(text)?.[1] ?? "";
        const name = /^[ \t]*name[ \t]*=[ \t]*["']([^"'\r\n]+)["']/m.exec(pkg)?.[1];
        if (name && !Object.hasOwn(map, name)) map[name] = rel;
        break;
      }
      if (!rel) break;
      d = dirname(d);
    }
  }
  return map;
}

/**
 * A failure of a whole test file, not of a test in it: node's runner names a file that fails to load (an import or
 * syntax error) after the file itself. Such a failure never shows that a test body ran.
 * @param {string} name
 */
export function fileLevel(name) {
  const k = name.indexOf("::");
  if (k <= 0) return false;
  const file = name.slice(0, k).replace(/\\/g, "/");
  const n = name.slice(k + 2).trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return n === file || file.endsWith(`/${n}`) || n.endsWith(`/${file}`);
}

// ---------------------------------------------------------------------------------------------------------------
// git helpers. GIT_OPTIONAL_LOCKS=0 keeps status from taking index.lock while another slice runs git.
// ---------------------------------------------------------------------------------------------------------------
/** @param {string} cwd @param {string[]} args @returns {string | null} */
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/**
 * The base of the tree at cwd and whether the tree has changes against it.
 * @param {string} cwd @param {boolean} isolated
 * @returns {{ top: string, main: string, base: string, changed: boolean } | null}
 */
export function baseInfo(cwd, isolated) {
  const top = git(cwd, ["rev-parse", "--show-toplevel"])?.trim();
  const head = git(cwd, ["rev-parse", "--verify", "-q", "HEAD"])?.trim();
  if (!top || !head) return null;
  const status = git(top, ["status", "--porcelain", "--untracked-files=normal"]);
  if (status === null) return null;
  const dirty = status.trim() !== "";
  const list = git(top, ["worktree", "list", "--porcelain"]) ?? "";
  const main = /^worktree (.+)$/m.exec(list)?.[1] ?? top;
  if (!isolated || real(main) === real(top)) return { top, main, base: head, changed: dirty };
  const mainHead = git(main, ["rev-parse", "--verify", "-q", "HEAD"])?.trim();
  const fork = mainHead ? git(top, ["merge-base", "HEAD", mainHead])?.trim() : undefined;
  if (!fork) return null;
  const ahead = Number(git(top, ["rev-list", "--count", `${fork}..HEAD`])?.trim() ?? "0");
  return { top, main, base: fork, changed: dirty || ahead > 0 };
}

/** Leftovers of killed runs: orch-base- dirs older than an hour, then stale worktree records. @param {string} top */
function pruneStale(top) {
  try {
    const root = tmpdir();
    for (const d of readdirSync(root)) {
      if (!d.startsWith(BASE_PREFIX)) continue;
      const p = join(root, d);
      try {
        if (Date.now() - statSync(p).mtimeMs > STALE_MS) rmSync(p, { recursive: true, force: true });
      } catch {
        // gone or not ours
      }
    }
  } catch {
    // no temp dir listing
  }
  git(top, ["worktree", "prune"]);
}

/** @returns {number} */
export const baseTimeoutMs = () => {
  const s = Number(process.env.ORCH_BASE_TIMEOUT_S);
  return (Number.isFinite(s) && s > 0 ? s : 300) * 1000;
};

/** The run folder relative to the tree's top ("" for the top or anything outside it). @param {string} top @param {string} cwd */
export function subdirOf(top, cwd) {
  const sub = relative(real(top), real(cwd));
  return sub && !sub.startsWith("..") ? sub : "";
}

const LOCKS = ["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb"];

/**
 * Run `cmd` with bash in its own process group; on timeout the whole group is killed. Output is capped at 16 MB.
 * @param {string} cmd @param {string} cwd @param {number} ms
 * @returns {Promise<{ rc: number, timedOut: boolean, out: string }>}
 */
export function runGroup(cmd, cwd, ms) {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let done = false;
    /** @type {NodeJS.Timeout | undefined} */
    let grace;
    const child = spawn("bash", ["-c", cmd], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    const pid = child.pid;
    if (pid) liveGroups.add(pid);
    const take = (/** @type {Buffer} */ b) => {
      if (out.length < 16 * 1024 * 1024) out += b.toString("utf8");
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    /** @param {number} rc */
    const finish = (rc) => {
      if (done) return;
      done = true;
      if (pid) liveGroups.delete(pid);
      clearTimeout(timer);
      if (grace) clearTimeout(grace);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({ rc, timedOut, out });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
      grace = setTimeout(() => finish(1), 2000); // a process that left the group may hold the pipes
    }, ms);
    child.on("error", () => finish(1));
    child.on("close", (code) => finish(code ?? 1));
  });
}

/**
 * Run `cmd` in a fresh detached worktree of `base` (OS temp dir). node_modules comes from the main worktree only, and
 * only when the base's lock files match the main worktree's (otherwise the base would run against other dependencies,
 * so there is no base run: cause "lock_mismatch", with the lock file). A failed `git worktree add` is cause
 * "worktree_add_failed". `prepare` may copy files in first. Limited to ORCH_BASE_TIMEOUT_S, run in its own process
 * group; the worktree is always removed.
 * @param {{ top: string, main: string, base: string }} info @param {string} cwd @param {string} cmd
 * @param {(wt: string) => void} [prepare]
 * @returns {Promise<{ rc: number, timedOut: boolean, failures: Failures } | { cause: string, file?: string }>}
 */
export async function runInBase(info, cwd, cmd, prepare) {
  const sub = subdirOf(info.top, cwd);
  const nmDirs = [...new Set(["", sub])].filter((d) => existsSync(join(info.main, d, "node_modules")));
  for (const d of nmDirs) {
    for (const lock of LOCKS) {
      const rel = d ? `${d}/${lock}` : lock;
      // Compare blob ids: the base's lock file against the main worktree's file on disk (missing on one side differs).
      const onBase = git(info.top, ["rev-parse", "--verify", "-q", `${info.base}:${rel}`])?.trim() ?? null;
      const inMain = existsSync(join(info.main, rel)) ? (git(info.main, ["hash-object", "--no-filters", "--", rel])?.trim() ?? "?") : null;
      if (onBase !== inMain) return { cause: "lock_mismatch", file: rel };
    }
  }
  pruneStale(info.top);
  const dir = mkdtempSync(join(tmpdir(), BASE_PREFIX));
  const wt = join(dir, "wt");
  const entry = { top: info.top, dir, wt };
  liveBases.add(entry); // before `worktree add`, so a signal during or after it still removes the worktree
  try {
    if (git(info.top, ["worktree", "add", "--detach", "--quiet", wt, info.base]) === null) return { cause: "worktree_add_failed" };
    for (const d of nmDirs) {
      const target = join(wt, d, "node_modules");
      if (existsSync(join(wt, d)) && !existsSync(target)) symlinkSync(join(info.main, d, "node_modules"), target, "junction"); // a folder link on Windows; ignored elsewhere
    }
    if (prepare) prepare(wt);
    const runDir = sub && existsSync(join(wt, sub)) ? join(wt, sub) : wt;
    const r = await runGroup(cmd, runDir, baseTimeoutMs());
    return { rc: r.rc, timedOut: r.timedOut, failures: parseFailures(r.out, wt) };
  } finally {
    liveBases.delete(entry);
    removeBase(entry);
  }
}

// What a signal must clean up: the process groups of running base runs and the base worktrees that exist now.
/** @type {Set<number>} */
const liveGroups = new Set();
/** @type {Set<{ top: string, dir: string, wt: string }>} */
const liveBases = new Set();

/** @param {{ top: string, dir: string, wt: string }} b */
function removeBase(b) {
  git(b.top, ["worktree", "remove", "--force", b.wt]);
  try {
    rmSync(b.dir, { recursive: true, force: true });
  } catch {
    // a file still held open: the stale sweep of a later run removes it
  }
  git(b.top, ["worktree", "prune"]);
}

/**
 * verify.sh stops the helper with SIGTERM when its time budget runs out (SIGKILL only 5 s later); a `finally` does not
 * run when a signal ends the process, so the base worktree stayed registered (pinning the base commit) and its folder
 * stayed in TMPDIR. On SIGTERM, SIGINT or SIGHUP: kill the base runs' groups, remove every base worktree, its record
 * and its folder, and exit with no answer (verify.sh then treats the check as not done in time).
 */
export function installSignalCleanup() {
  for (const [sig, code] of /** @type {const} */ ([["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]])) {
    process.on(sig, () => {
      for (const pid of liveGroups) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      for (const b of liveBases) removeBase(b);
      process.exit(code);
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cache of base runs: <state>/baseline-cache.json, { "<base sha> <cmd hash>": { rc, names } }, newest 50 kept. The
// hash covers the command and the run subdirectory.
// ---------------------------------------------------------------------------------------------------------------
/** @param {string} base @param {string} cmd @param {string} [sub] */
export const cacheKey = (base, cmd, sub = "") => `${base} ${createHash("sha256").update(`${sub}\0${cmd}`).digest("hex").slice(0, 16)}`;

/** @param {string} state @returns {Record<string, { rc: number, names: string[] }>} */
function readCache(state) {
  try {
    const c = JSON.parse(readFileSync(join(state, "baseline-cache.json"), "utf8"));
    return c && typeof c === "object" && !Array.isArray(c) ? c : {};
  } catch {
    return {};
  }
}

/** @param {string} state @param {string} key @param {{ rc: number, names: string[] }} value */
function writeCache(state, key, value) {
  try {
    const c = readCache(state);
    delete c[key];
    c[key] = value;
    const keys = Object.keys(c);
    for (const k of keys.slice(0, Math.max(0, keys.length - 50))) delete c[k];
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "baseline-cache.json"), JSON.stringify(c));
  } catch {
    // no cache this time
  }
}

/**
 * The plain base run (cached): usable only when it finished in time and passed, or failed with complete names.
 * Otherwise why not: runInBase's cause, "base_timeout" or "no_test_names".
 * @param {{ top: string, main: string, base: string }} info @param {string} cwd @param {string} cmd @param {string} state
 * @returns {Promise<{ rc: number, names: string[] } | { cause: string, file?: string }>}
 */
async function plainBase(info, cwd, cmd, state) {
  const key = cacheKey(info.base, cmd, subdirOf(info.top, cwd));
  const hit = readCache(state)[key];
  if (hit && typeof hit.rc === "number" && Array.isArray(hit.names)) return { rc: hit.rc, names: hit.names };
  const run = await runInBase(info, cwd, cmd);
  if ("cause" in run) return run;
  if (run.timedOut) return { cause: "base_timeout" };
  if (run.rc !== 0 && !complete(run.failures)) return { cause: "no_test_names" };
  const res = { rc: run.rc, names: run.rc === 0 ? [] : run.failures.names };
  writeCache(state, key, res);
  return res;
}

/**
 * Baseline after a failing test run. mode "allow" (opt-in, heuristic): warn with tests_failed_baseline when the run is
 * complete and every failing test also fails on the base. Any other mode ("inform", the default): never allow; return
 * decision "inform" with counts and, when some failing tests also fail on the base, a note for the block message.
 * @param {{ cwd: string, cmd: string, isolated: boolean, state: string, output: string, mode?: string }} o
 * @returns {Promise<{ decision: string, reason: string, extra: string, message: string } | null>}
 */
export async function baseline({ cwd, cmd, isolated, state, output, mode = "inform" }) {
  const quick = parseFailures(output);
  if (quick.names.length === 0) return null; // nothing qualified to compare
  const allow = mode === "allow";
  // unqualified names, a crash, a cargo stop at a failing target or a unittest failfast command: keep the block
  if (allow && (!complete(quick) || stoppedEarly(output) || failFastCmd(cmd) || failFastInTree(cwd, output))) return null;
  const info = baseInfo(cwd, isolated);
  if (!info || !info.changed) return null; // a tree with no changes against its base has nothing to compare
  const cur = parseFailures(output, info.top);
  const base = await plainBase(info, cwd, cmd, state);
  if ("cause" in base) return null;
  const onBase = new Set(base.names);
  const shared = cur.names.filter((n) => onBase.has(n));
  if (allow && shared.length === cur.names.length) {
    return { decision: "warn", reason: "tests_failed_baseline", extra: `"failing":${cur.names.length},"base_failing":${onBase.size}`, message: "" };
  }
  const listed = shared.slice(0, 20).map((n) => `  - ${n}`);
  if (shared.length > 20) listed.push(`  - ... and ${shared.length - 20} more`);
  const message = shared.length
    ? `These failing tests also fail on the base ${info.base.slice(0, 8)} (probably pre-existing; do not fix them unless your slice touches them; say so in your report):\n${listed.join("\n")}`
    : "";
  return { decision: "inform", reason: "tests_failed", extra: `"failing":${cur.names.length},"on_base":${shared.length}`, message };
}

// ---------------------------------------------------------------------------------------------------------------
// KIND: bugfix
// ---------------------------------------------------------------------------------------------------------------
/** The agent's own brief: the first user message of its transcript. @param {unknown} path @returns {string | null} */
export function briefFromTranscript(path) {
  if (typeof path !== "string" || !path) return null;
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || e.type !== "user" || !e.message) continue;
    const c = e.message.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) return c.filter((b) => b && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
    return null;
  }
  return null;
}

/** @param {string} state @param {string} file @returns {any[]} */
function jsonl(state, file) {
  try {
    return readFileSync(join(state, file), "utf8")
      .split("\n")
      .flatMap((l) => {
        try {
          const v = JSON.parse(l);
          return v && typeof v === "object" ? [v] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/**
 * The test gate's blocks of agent `id` whose reason is `reason` (or starts with it, when it ends in "_"), counted since
 * the agent's latest SubagentStart in telemetry.jsonl: a SendMessage resume starts the agent again under its id, so
 * each attempt gets its own cap. With no start record, every block of the agent counts.
 * @param {string} state @param {string} id @param {string} reason
 */
export function countBlocks(state, id, reason) {
  if (!id) return 0;
  let start = -Infinity;
  for (const e of jsonl(state, "telemetry.jsonl")) {
    if (e.hook_event_name !== "SubagentStart" || e.agent_id !== id) continue;
    const t = Date.parse(e.ts);
    if (t > start) start = t;
  }
  const match = (/** @type {unknown} */ r) => (reason.endsWith("_") ? String(r).startsWith(reason) : r === reason);
  return jsonl(state, "gates.jsonl").filter((r) => r.gate === "test" && r.decision === "block" && r.agent_id === id && match(r.reason) && !(Date.parse(r.ts) < start)).length;
}

/** KIND from the transcript brief, else from the launch record. @param {string} state @param {any} event @returns {string | null} */
export function agentKind(state, event) {
  const brief = briefFromTranscript(event?.agent_transcript_path);
  if (brief !== null) return parseHeader(brief).kind;
  const id = typeof event?.agent_id === "string" ? event.agent_id : "";
  if (!id) return null;
  const rec = jsonl(state, "journal-launches.jsonl").filter((r) => r.agent_id === id).pop();
  return typeof rec?.kind === "string" ? rec.kind : null;
}

/** Changed or added test files against the base, root-relative, that exist in the tree. @param {string} top @param {string} base */
export function changedTestFiles(top, base) {
  const diff = git(top, ["diff", "--name-only", "--diff-filter=ACMR", "-z", base]) ?? "";
  const untracked = git(top, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "";
  const paths = [...diff.split("\0"), ...untracked.split("\0")].filter(Boolean);
  return [...new Set(paths)].filter((p) => isTestFile(p) && existsSync(join(top, p))).sort();
}

/**
 * @param {{ cwd: string, cmd: string, isolated: boolean, state: string, event: any }} o
 * @returns {Promise<{ decision: string, reason: string, extra: string, message: string } | null>}
 */
export async function bugfix({ cwd, cmd, isolated, state, event }) {
  if (agentKind(state, event) !== "bugfix") return null;
  const id = typeof event?.agent_id === "string" ? event.agent_id : "";
  const blocks = countBlocks(state, id, "bugfix_");
  const block = (/** @type {string} */ reason, /** @type {string} */ message, extra = "") =>
    blocks >= MAX_BUGFIX_BLOCKS
      ? { decision: "allow", reason: "bugfix_unverified_gave_up", extra, message: "" }
      : { decision: "block", reason, extra, message };
  const info = baseInfo(cwd, isolated);
  if (!info) return block("bugfix_no_base", "KIND: bugfix: the gate could not find a git base commit to check the reproduction test against.");
  const tests = changedTestFiles(info.top, info.base);
  const short = info.base.slice(0, 8);
  if (tests.length === 0) {
    return block(
      "bugfix_no_test",
      `KIND: bugfix needs a test that reproduces the bug: no test file is changed or added against ${short}. Add a test that fails without the fix and passes with it.`,
    );
  }
  // Each cause has its own text for the agent and a snake_case "cause" for the gate record (verify.sh keeps only
  // [a-z_0-9,:"] of the extra line).
  const why = (/** @type {{ cause: string, file?: string }} */ c, how = "") => {
    switch (c.cause) {
      case "worktree_add_failed":
        return `could not run: \`git worktree add\` of ${short} failed, so there was no base worktree to run it in`;
      case "base_timeout":
        return `${how}timed out`;
      default:
        return `${how}failed without parsable test names`;
    }
  };
  // A lock file that differs from the base's is outside the worker's reach: the base worktree can only borrow the main
  // checkout's node_modules, and a block would only come back after every resume (run of 2026-11-17). Give up at once:
  // the give-up record carries the cause and is a doubt signal (test_gate_gave_up), so the slice needs an opus review.
  const outOfReach = (/** @type {{ cause: string }} */ c) =>
    c.cause === "lock_mismatch" ? { decision: "allow", reason: "bugfix_unverified_gave_up", extra: `"cause":"${c.cause}"`, message: "" } : null;
  const unusable = (/** @type {{ cause: string, file?: string }} */ c, how = "") =>
    outOfReach(c) ??
    block(
      "bugfix_base_unusable",
      `KIND: bugfix: unverified. The test run on ${short} ${why(c, how)}, so the gate cannot tell whether the changed tests reproduce the bug. Make the test command run cleanly on the base, or report the bug as unverified.`,
      `"cause":"${c.cause}"`,
    );
  const plain = await plainBase(info, cwd, cmd, state);
  if ("cause" in plain) return unusable(plain);
  const withTests = await runInBase(info, cwd, cmd, (wt) => {
    for (const t of tests) {
      mkdirSync(dirname(join(wt, t)), { recursive: true });
      copyFileSync(join(info.top, t), join(wt, t));
    }
  });
  if ("cause" in withTests) {
    return outOfReach(withTests) ?? block("bugfix_no_base", `KIND: bugfix: the gate could not run the reproduction test on ${short}: the test run there ${why(withTests)}.`, `"cause":"${withTests.cause}"`);
  }
  if (withTests.timedOut) return unusable({ cause: "base_timeout" }, "with the changed test files ");
  const before = new Set(plain.names);
  const pkgDirs = cargoPackageDirs(info.top, tests);
  const fresh = withTests.failures.names.filter((n) => !before.has(n) && inFiles(n, tests, pkgDirs) && !fileLevel(n));
  const extra = `"test_files":${tests.length},"new_failing":${fresh.length}`;
  if (fresh.length > 0) return { decision: "allow", reason: "bugfix_verified", extra, message: "" };
  return block(
    "bugfix_test_passes_on_base",
    `KIND: bugfix: the changed test files (${tests.slice(0, 5).join(", ")}${tests.length > 5 ? ", ..." : ""}) add no failing test on ${short} without the fix: they pass there, fail the same way as the base does without them, or fail without a parsable test name or only as a whole file that does not load. Add or change a test that fails before the fix.`,
    extra,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// What failed (2.0.0): the fields a failed test run's gate records carry, and the tail of its output kept in the
// state folder, so that a block can be explained after verify.sh has removed its temp folder.
// ---------------------------------------------------------------------------------------------------------------
/** Output files kept in <state>/test-output (the newest by name, which starts with the time). */
export const KEEP_OUTPUTS = 10;
/** Each kept file holds at most the last this many bytes of the run's output, from a line start. */
export const MAX_OUTPUT_BYTES = 64 * 1024;
/** Failing test names in a record, each cut to MAX_NAME_CHARS characters. */
export const MAX_NAMES = 10;
export const MAX_NAME_CHARS = 200;
export const OUTPUT_DIR = "test-output";
const OUTPUT_RE = /^\d{8}T\d{9}Z-[A-Za-z0-9_.-]*\.txt$/;

/**
 * The record fields for a failed run's output: failed_count (the failing tests the runner's output names, qualified
 * or not: parseFailures, so node:test, tsx, jest, vitest, pytest, unittest, go and cargo; 0 when none could be read),
 * failed_tests (at most MAX_NAMES of them, qualified ones first, each at most MAX_NAME_CHARS characters; left out when
 * none), failed_crash 1 when a runner-level failure shows (a crash marker: parseFailures `crash`). Names are only what
 * the output prints; a line no pattern reads gives no name, never a guessed one.
 * @param {unknown} output @returns {{ failed_count: number, failed_tests?: string[], failed_crash?: 1 }}
 */
export function failureFields(output) {
  const f = parseFailures(output);
  const all = [...f.names, ...f.unqualified];
  /** @type {{ failed_count: number, failed_tests?: string[], failed_crash?: 1 }} */
  const res = { failed_count: all.length };
  // eslint-disable-next-line no-control-regex
  const cut = (/** @type {string} */ n) => (n.length > MAX_NAME_CHARS ? `${n.slice(0, MAX_NAME_CHARS - 3)}...` : n).replace(/[\u0000-\u001f\u007f]/g, " ");
  if (all.length) res.failed_tests = all.slice(0, MAX_NAMES).map(cut);
  if (f.crash) res.failed_crash = 1;
  return res;
}

/** The last `max` bytes of `text`, from the first line start inside them (the whole text when it fits). @param {string} text @param {number} [max] */
export function outputTail(text, max = MAX_OUTPUT_BYTES) {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= max) return text;
  const tail = buf.subarray(buf.length - max);
  const nl = tail.indexOf(10);
  return (nl >= 0 && nl < tail.length - 1 ? tail.subarray(nl + 1) : tail).toString("utf8");
}

/**
 * Keep the tail of a run's output as <state>/test-output/<time>-<tag>.txt, written whole to a hidden temporary file
 * in the same folder and renamed into place (a crash leaves no half file under the kept name), then remove all but
 * the newest KEEP_OUTPUTS files and temporary files older than 10 minutes. Returns the path relative to the state
 * folder, or "" when nothing could be written.
 * @param {string} state @param {string} tag @param {string} output @param {number} [now]
 */
export function keepOutput(state, tag, output, now = Date.now()) {
  if (!state) return "";
  const dir = join(state, OUTPUT_DIR);
  const stamp = new Date(now).toISOString().replace(/[-:.]/g, "");
  const name = `${stamp}-${String(tag).replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 80)}.txt`;
  if (!OUTPUT_RE.test(name)) return "";
  const tmp = join(dir, `.${name}.${process.pid}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(tmp, outputTail(output));
    renameSync(tmp, join(dir, name));
  } catch {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // nothing to remove
    }
    return "";
  }
  try {
    const entries = readdirSync(dir);
    const kept = entries.filter((e) => OUTPUT_RE.test(e)).sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - KEEP_OUTPUTS))) rmSync(join(dir, old), { force: true });
    for (const t of entries.filter((e) => e.startsWith(".") && e.endsWith(".tmp"))) {
      const p = join(dir, t);
      if (now - statSync(p).mtimeMs > 10 * 60 * 1000) rmSync(p, { force: true });
    }
  } catch {
    // pruning is best effort; the file is written
  }
  return `${OUTPUT_DIR}/${name}`;
}

/**
 * The extra JSON fields verify.sh adds to a failed run's records: failureFields plus "output", the kept file
 * (keepOutput; left out when it could not be written). One line, a JSON object's members without the braces.
 * @param {string} state @param {string} tag @param {string} output
 */
export function failureExtra(state, tag, output) {
  const file = keepOutput(state, tag, output);
  const obj = { ...failureFields(output), ...(file ? { output: file } : {}) };
  return JSON.stringify(obj).slice(1, -1);
}

/**
 * The same fields read back from a stored line (the result cache keeps them with a fail or a timeout): only the known
 * members, re-checked and written again, so a damaged or foreign line gives "" (no fields), never other JSON.
 * @param {unknown} line @returns {string}
 */
export function cleanFailureExtra(line) {
  if (typeof line !== "string" || !line) return "";
  try {
    const o = JSON.parse(`{${line}}`);
    /** @type {Record<string, unknown>} */
    const res = {};
    if (!(Number.isInteger(o.failed_count) && o.failed_count >= 0)) return "";
    res.failed_count = o.failed_count;
    if (Array.isArray(o.failed_tests)) {
      const names = o.failed_tests.filter((/** @type {unknown} */ n) => typeof n === "string").slice(0, MAX_NAMES).map((/** @type {string} */ n) => n.slice(0, MAX_NAME_CHARS));
      if (names.length) res.failed_tests = names;
    }
    if (o.failed_crash === 1) res.failed_crash = 1;
    if (typeof o.output === "string" && /^test-output\/[A-Za-z0-9_.-]+\.txt$/.test(o.output)) res.output = o.output;
    return JSON.stringify(res).slice(1, -1);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------------------------------------------
// CLI: node bugfix-check.mjs <baseline|bugfix> --cmd <cmd> --state <dir> [--isolated 1]
//      node bugfix-check.mjs failures --state <dir> --tag <tag>   (stdin: the run's output) prints failureExtra
// ---------------------------------------------------------------------------------------------------------------
/** @param {string[]} argv */
function flags(argv) {
  /** @type {Record<string, string>} */
  const f = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--")) f[a.slice(2)] = argv[++i] ?? "";
  }
  return f;
}

async function main() {
  const [mode = "", ...rest] = process.argv.slice(2);
  const f = flags(rest);
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const input = Buffer.concat(chunks).toString("utf8");
  if (mode === "failures") {
    process.stdout.write(`${failureExtra(f.state ?? "", f.tag ?? "", input)}\n`);
    return;
  }
  const common = { cwd: process.cwd(), cmd: f.cmd ?? "", isolated: f.isolated === "1", state: f.state ?? "" };
  if (!common.cmd || !common.state) return;
  let res = null;
  if (mode === "baseline") res = await baseline({ ...common, output: input, mode: f.mode ?? "inform" });
  else if (mode === "bugfix") {
    let event;
    try {
      event = JSON.parse(input || "{}");
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    res = await bugfix({ ...common, event });
  }
  if (res) process.stdout.write(`${res.decision}\n${res.reason}\n${res.extra}\n${res.message}\n`);
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  installSignalCleanup();
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
