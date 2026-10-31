#!/usr/bin/env node
// Helper of the test gate (verify.sh calls it; it is not a hook of its own). Two jobs, both judged against the base of
// the agent's tree: HEAD for the shared tree, the fork point from the main worktree's HEAD for an isolated worktree.
//   baseline  (stdin: the failing test output; ORCH_BASELINE=off in verify.sh skips the call) -- when the tree has
//             changes against its base, run the same test command in a clean detached worktree of the base and allow
//             (warn, tests_failed_baseline) only when every named failing test of the working-tree run is also named
//             failing on the base. A run with no parsable failing test names never counts as already failing.
//   bugfix    (stdin: the SubagentStop event; ORCH_BUGFIX_CHECK=off skips it) -- for an implementer whose brief says
//             KIND: bugfix, after the tests passed: at least one test file must be changed or added against the base,
//             and those files copied into a base worktree must make the test command fail there. Blocks say what is
//             missing; after two such blocks for the agent it allows with bugfix_unverified_gave_up.
// Base worktrees are created detached outside the repo (OS temp dir) and always removed; nothing commits or moves a
// branch. Base results are cached per base commit and command in <state>/baseline-cache.json.
// Output protocol (stdout, empty means "no opinion", verify.sh then decides as before): line 1 the decision (allow,
// warn, block), line 2 the reason, line 3 extra JSON fields for the gate record (counts only, may be empty), then the
// message for the agent. Any error prints nothing and exits 0.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHeader } from "./brief.mjs";

export const MAX_BUGFIX_BLOCKS = 2;

// ---------------------------------------------------------------------------------------------------------------
// Failing test names from runner output. Supported: node --test (TAP "not ok" and the spec reporter's "✖"), jest
// ("●" and "✕"), vitest ("FAIL  file > name" and "×"), pytest ("FAILED"/"ERROR" summary lines), go ("--- FAIL:") and
// cargo ("test name ... FAILED"). Sorted and unique; empty when nothing is recognised.
// ---------------------------------------------------------------------------------------------------------------
/** @param {unknown} text @returns {string[]} */
export function parseFailures(text) {
  if (typeof text !== "string") return [];
  // eslint-disable-next-line no-control-regex
  const clean = text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
  /** @type {Set<string>} */
  const names = new Set();
  const add = (/** @type {string | undefined} */ n) => {
    const v = (n ?? "").trim();
    if (v) names.add(v);
  };
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    let m;
    if ((m = /^\s*not ok\s+\d+\s*(?:-\s*)?(.*)$/.exec(line))) {
      if (/#\s*(?:SKIP|TODO)\b/i.test(m[1] ?? "")) continue;
      add(m[1]);
    } else if ((m = /^\s*✖\s+(.+?)(?:\s+\(\d[\d.]*\s*m?s\))?$/.exec(line))) {
      if (/^failing tests:?$/.test(m[1] ?? "")) continue;
      add(m[1]);
    } else if ((m = /^\s*[✕×]\s+(.+?)(?:\s+\d[\d.]*\s*m?s|\s+\(\d[\d.]*\s*m?s\))?$/.exec(line))) {
      add(m[1]);
    } else if ((m = /^\s*●\s+(.+)$/.exec(line))) {
      add(m[1]);
    } else if ((m = /^\s*FAIL\s+(\S.*\s>\s.*)$/.exec(line))) {
      add(m[1]);
    } else if ((m = /^(?:FAILED|ERROR)\s+(\S+::\S+?)(?:\s+-\s.*)?$/.exec(line))) {
      add(m[1]);
    } else if ((m = /^\s*--- FAIL:\s+(\S+)/.exec(line))) {
      add(m[1]);
    } else if ((m = /^test\s+(\S+)\s+\.\.\.\s+FAILED$/.exec(line))) {
      add(m[1]);
    }
  }
  return [...names].sort();
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

// ---------------------------------------------------------------------------------------------------------------
// git helpers. GIT_OPTIONAL_LOCKS=0 keeps status from taking index.lock while another slice runs git.
// ---------------------------------------------------------------------------------------------------------------
/** @param {string} cwd @param {string[]} args @returns {string | null} */
function git(cwd, args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** @param {string} p */
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
};

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

/**
 * Run `cmd` in a fresh detached worktree of `base` (OS temp dir), with node_modules symlinked in from the tree or the
 * main worktree when one exists; `prepare` may copy files in first. The worktree is always removed.
 * @param {{ top: string, main: string, base: string }} info @param {string} cwd @param {string} cmd
 * @param {(wt: string) => void} [prepare]
 * @returns {{ rc: number, out: string } | null}
 */
export function runInBase(info, cwd, cmd, prepare) {
  const dir = mkdtempSync(join(tmpdir(), "orch-base-"));
  const wt = join(dir, "wt");
  try {
    if (git(info.top, ["worktree", "add", "--detach", "--quiet", wt, info.base]) === null) return null;
    const nm = [join(info.top, "node_modules"), join(info.main, "node_modules")].find((p) => existsSync(p));
    if (nm && !existsSync(join(wt, "node_modules"))) symlinkSync(nm, join(wt, "node_modules"));
    if (prepare) prepare(wt);
    const sub = relative(real(info.top), real(cwd));
    const runDir = sub && !sub.startsWith("..") && existsSync(join(wt, sub)) ? join(wt, sub) : wt;
    const r = spawnSync("bash", ["-c", cmd], { cwd: runDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    return { rc: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
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
 * @param {{ cwd: string, cmd: string, isolated: boolean, state: string, output: string }} o
 * @returns {{ decision: string, reason: string, extra: string, message: string } | null}
 */
export function baseline({ cwd, cmd, isolated, state, output }) {
  const cur = parseFailures(output);
  if (cur.length === 0) return null; // no names: never counts as already failing on the base
  const info = baseInfo(cwd, isolated);
  if (!info || !info.changed) return null; // a tree with no changes against its base has nothing to compare
  const key = cacheKey(info.base, cmd);
  let res = readCache(state)[key];
  if (!res || !Array.isArray(res.names)) {
    const run = runInBase(info, cwd, cmd);
    if (!run) return null;
    res = { rc: run.rc, names: run.rc === 0 ? [] : parseFailures(run.out) };
    writeCache(state, key, res);
  }
  const onBase = new Set(res.names);
  if (!cur.every((n) => onBase.has(n))) return null;
  return { decision: "warn", reason: "tests_failed_baseline", extra: `"failing":${cur.length},"base_failing":${onBase.size}`, message: "" };
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
  const run = runInBase(info, cwd, cmd, (wt) => {
    for (const t of tests) {
      mkdirSync(dirname(join(wt, t)), { recursive: true });
      copyFileSync(join(info.top, t), join(wt, t));
    }
  });
  if (!run) return block("bugfix_no_base", `KIND: bugfix: the gate could not create a worktree of ${short} to run the reproduction test.`);
  const extra = `"test_files":${tests.length}`;
  if (run.rc !== 0) return { decision: "allow", reason: "bugfix_verified", extra, message: "" };
  return block(
    "bugfix_test_passes_on_base",
    `KIND: bugfix: the changed test files (${tests.slice(0, 5).join(", ")}${tests.length > 5 ? ", ..." : ""}) also pass on ${short} without the fix, so they do not reproduce the bug. Add or change a test that fails before the fix.`,
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
