#!/usr/bin/env node
// Helper of the test gate (verify.sh calls it; it is not a hook of its own). Two jobs, both judged against the base of
// the agent's tree: HEAD for the shared tree, the fork point from the main worktree's HEAD for an isolated worktree.
//   baseline  (stdin: the failing test output; ORCH_BASELINE=off in verify.sh skips the call) -- when the tree has
//             changes against its base, run the same test command in a clean detached worktree of the base and allow
//             (warn, tests_failed_baseline) only when every failing test of the working-tree run, qualified by its
//             file or package, is also failing on the base. Never when a working-tree failure cannot be qualified or
//             is a suite-level crash (suite failed to run, collection or import error, build failure), never when
//             the base run timed out or failed without parsable names: those keep the block.
//   bugfix    (stdin: the SubagentStop event; ORCH_BUGFIX_CHECK=off skips it) -- for an implementer whose brief says
//             KIND: bugfix, after the tests passed: at least one test file must be changed or added against the base,
//             and the base run with those files copied in must show at least one new qualified failing test that
//             lives in a copied file, compared with the base run without them. Blocks say what is missing; after two
//             such blocks for the agent it allows with bugfix_unverified_gave_up.
// Base worktrees are created detached in the OS temp dir (prefix orch-base-) and always removed; each base run first
// prunes leftovers of killed runs (git worktree prune, and orch-base- dirs older than an hour). Nothing commits or moves
// a branch. A base run is limited to ORCH_BASE_TIMEOUT_S seconds (default 300); a timeout counts as "no baseline".
// The hook needs a timeout of at least 2 x ORCH_BASE_TIMEOUT_S plus the test run (bugfix may run the base twice).
// Base results are cached per base commit and command in <state>/baseline-cache.json, only when the run finished in
// time and either passed or failed with fully parsable names (an environment failure is never cached).
// Output protocol (stdout, empty means "no opinion", verify.sh then decides as before): line 1 the decision (allow,
// warn, block), line 2 the reason, line 3 extra JSON fields for the gate record (counts only, may be empty), then the
// message for the agent. Any error prints nothing and exits 0.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
//   pytest: "FAILED/ERROR path::name"; go: "--- FAIL: TestX" qualified by the "FAIL <pkg>" line that follows;
//   cargo: "test name ... FAILED" qualified by the preceding "Running <target>".
// A failure with no file or package goes to `unqualified`; a suite-level crash sets `crash`.
// Absolute paths under `root` (the run's tree) are made relative so two trees compare.
// ---------------------------------------------------------------------------------------------------------------
/** @typedef {{ names: string[], unqualified: string[], crash: boolean }} Failures */

const CRASH_RE = [
  /Test suite failed to run/,
  /errors? during collection/i,
  /ImportError while importing test module/,
  /^_+ ERROR collecting /,
  /error: could not compile/,
  /\[(build|setup) failed\]/,
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
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (CRASH_RE.some((re) => re.test(line))) res.crash = true;
    let m;
    if ((m = /^\s*not ok\s+\d+\s*(?:-\s*)?(.*)$/.exec(line))) {
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
    } else if ((m = /^(FAILED|ERROR)\s+(\S+)(?:\s+-\s.*)?$/.exec(line))) {
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
  res.names = [...names].sort();
  res.unqualified = [...unq].sort();
  return res;
}

/** Names to compare: at least one, all qualified, no crash. @param {Failures} f */
export const complete = (f) => f.names.length > 0 && f.unqualified.length === 0 && !f.crash;

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
 * @param {string} name @param {string[]} files
 */
export function inFiles(name, files) {
  const k = name.indexOf("::");
  if (k <= 0) return false;
  const q = name.slice(0, k).replace(/\\/g, "/");
  return files.some((t) => {
    if (q === t || q.endsWith(`/${t}`)) return true;
    const d = dirname(t);
    return d !== "." && /\.go$/.test(t) && (q === d || q.endsWith(`/${d}`));
  });
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

/**
 * Run `cmd` in a fresh detached worktree of `base` (OS temp dir), with node_modules symlinked in from the tree or the
 * main worktree when one exists; `prepare` may copy files in first. Limited to ORCH_BASE_TIMEOUT_S; the worktree is
 * always removed.
 * @param {{ top: string, main: string, base: string }} info @param {string} cwd @param {string} cmd
 * @param {(wt: string) => void} [prepare]
 * @returns {{ rc: number, timedOut: boolean, failures: Failures } | null}
 */
export function runInBase(info, cwd, cmd, prepare) {
  pruneStale(info.top);
  const dir = mkdtempSync(join(tmpdir(), BASE_PREFIX));
  const wt = join(dir, "wt");
  try {
    if (git(info.top, ["worktree", "add", "--detach", "--quiet", wt, info.base]) === null) return null;
    const nm = [join(info.top, "node_modules"), join(info.main, "node_modules")].find((p) => existsSync(p));
    if (nm && !existsSync(join(wt, "node_modules"))) symlinkSync(nm, join(wt, "node_modules"));
    if (prepare) prepare(wt);
    const sub = relative(real(info.top), real(cwd));
    const runDir = sub && !sub.startsWith("..") && existsSync(join(wt, sub)) ? join(wt, sub) : wt;
    const r = spawnSync("bash", ["-c", cmd], { cwd: runDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: baseTimeoutMs(), killSignal: "SIGKILL" });
    const timedOut = /** @type {NodeJS.ErrnoException | undefined} */ (r.error)?.code === "ETIMEDOUT" || (r.status === null && r.signal !== null);
    return { rc: r.status ?? 1, timedOut, failures: parseFailures(`${r.stdout ?? ""}${r.stderr ?? ""}`, wt) };
  } finally {
    git(info.top, ["worktree", "remove", "--force", wt]);
    rmSync(dir, { recursive: true, force: true });
    git(info.top, ["worktree", "prune"]);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Cache of base runs: <state>/baseline-cache.json, { "<base sha> <cmd hash>": { rc, names } }, newest 50 kept.
// ---------------------------------------------------------------------------------------------------------------
/** @param {string} base @param {string} cmd */
export const cacheKey = (base, cmd) => `${base} ${createHash("sha256").update(cmd).digest("hex").slice(0, 16)}`;

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
 * @param {{ top: string, main: string, base: string }} info @param {string} cwd @param {string} cmd @param {string} state
 * @returns {{ rc: number, names: string[] } | null}
 */
function plainBase(info, cwd, cmd, state) {
  const key = cacheKey(info.base, cmd);
  const hit = readCache(state)[key];
  if (hit && typeof hit.rc === "number" && Array.isArray(hit.names)) return hit;
  const run = runInBase(info, cwd, cmd);
  if (!run || run.timedOut) return null;
  if (run.rc !== 0 && !complete(run.failures)) return null;
  const res = { rc: run.rc, names: run.rc === 0 ? [] : run.failures.names };
  writeCache(state, key, res);
  return res;
}

/**
 * @param {{ cwd: string, cmd: string, isolated: boolean, state: string, output: string }} o
 * @returns {{ decision: string, reason: string, extra: string, message: string } | null}
 */
export function baseline({ cwd, cmd, isolated, state, output }) {
  if (!complete(parseFailures(output))) return null; // unqualified names, a crash or no names: keep the block
  const info = baseInfo(cwd, isolated);
  if (!info || !info.changed) return null; // a tree with no changes against its base has nothing to compare
  const cur = parseFailures(output, info.top);
  const base = plainBase(info, cwd, cmd, state);
  if (!base) return null;
  const onBase = new Set(base.names);
  if (!cur.names.every((n) => onBase.has(n))) return null;
  return { decision: "warn", reason: "tests_failed_baseline", extra: `"failing":${cur.names.length},"base_failing":${onBase.size}`, message: "" };
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
 * @returns {{ decision: string, reason: string, extra: string, message: string } | null}
 */
export function bugfix({ cwd, cmd, isolated, state, event }) {
  if (agentKind(state, event) !== "bugfix") return null;
  const id = typeof event?.agent_id === "string" ? event.agent_id : "";
  const blocks = id
    ? jsonl(state, "gates.jsonl").filter((r) => r.gate === "test" && r.decision === "block" && r.agent_id === id && String(r.reason).startsWith("bugfix_")).length
    : 0;
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
  const unusable = (/** @type {string} */ what) =>
    block("bugfix_base_unusable", `KIND: bugfix: unverified. The test run on ${short} ${what}, so the gate cannot tell whether the changed tests reproduce the bug. Make the test command run cleanly on the base, or report the bug as unverified.`);
  const plain = plainBase(info, cwd, cmd, state);
  if (!plain) return unusable("timed out or failed without parsable test names");
  const withTests = runInBase(info, cwd, cmd, (wt) => {
    for (const t of tests) {
      mkdirSync(dirname(join(wt, t)), { recursive: true });
      copyFileSync(join(info.top, t), join(wt, t));
    }
  });
  if (!withTests) return block("bugfix_no_base", `KIND: bugfix: the gate could not create a worktree of ${short} to run the reproduction test.`);
  if (withTests.timedOut) return unusable("with the changed test files timed out");
  const before = new Set(plain.names);
  const fresh = withTests.failures.names.filter((n) => !before.has(n) && inFiles(n, tests));
  const extra = `"test_files":${tests.length},"new_failing":${fresh.length}`;
  if (fresh.length > 0) return { decision: "allow", reason: "bugfix_verified", extra, message: "" };
  return block(
    "bugfix_test_passes_on_base",
    `KIND: bugfix: the changed test files (${tests.slice(0, 5).join(", ")}${tests.length > 5 ? ", ..." : ""}) add no failing test on ${short} without the fix: they pass there, fail the same way as the base does without them, or fail without a parsable test name. Add or change a test that fails before the fix.`,
    extra,
  );
}

// ---------------------------------------------------------------------------------------------------------------
// CLI: node bugfix-check.mjs <baseline|bugfix> --cmd <cmd> --state <dir> [--isolated 1]
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
  const common = { cwd: process.cwd(), cmd: f.cmd ?? "", isolated: f.isolated === "1", state: f.state ?? "" };
  if (!common.cmd || !common.state) return;
  let res = null;
  if (mode === "baseline") res = baseline({ ...common, output: input });
  else if (mode === "bugfix") {
    let event;
    try {
      event = JSON.parse(input || "{}");
    } catch {
      return;
    }
    if (!event || typeof event !== "object") return;
    res = bugfix({ ...common, event });
  }
  if (res) process.stdout.write(`${res.decision}\n${res.reason}\n${res.extra}\n${res.message}\n`);
}

if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
  main().then(
    () => process.exit(0),
    () => process.exit(0),
  );
}
