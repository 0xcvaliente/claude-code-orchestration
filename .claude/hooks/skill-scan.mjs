// The secret and personal-detail scan shared by the skill gate (skill-gate.mjs) and the publish script
// (scripts/skill-publish.mjs). A library, not a hook: it prints nothing, writes nothing and never throws.
//
// scanText(text)  the findings in one text: line number and kind, never the matched text.
// mask(text)      the text with every match replaced by [masked] (for validator output the gate shows).
// scanBranch(dir, { base, branch, name })  what a push of refs/heads/<branch> would carry beyond its merge base with
//                 `base`: every line that any commit of the branch adds, on every path (merge commits against each
//                 parent; binary files read as text; external diff and textconv off; replace refs ignored), and every
//                 path those commits touch (renames as a deletion and an addition, so both paths count). A finding still
//                 in the branch's last version gives file and line; one that a later commit removed gives file and the
//                 commit that added it. Paths other than skills/<name>/... and README.md (the catalog file a skill slice
//                 may change) are `outside`. A branch, base or merge base git cannot find, or a history git cannot list
//                 within the limits, is a `problem`: callers block on it, never pass.
// Git runs read commands only, with optional locks off and repository hooks and fsmonitor off.
import { spawnSync } from "node:child_process";

export const MAX_SCAN_BYTES = 5 * 1024 * 1024;
/** The most git output a branch scan reads; a larger history is a problem, never skipped. */
export const MAX_HISTORY_BYTES = 64 * 1024 * 1024;

// A user folder name: the account a home path names. `Shared` (macOS) and the Windows profiles Public, Default and
// All Users name no person and are excused.
const USER = String.raw`(?!Shared(?:[\/]|[^A-Za-z0-9._-]|$))[A-Za-z0-9._-]+`;
const WIN_USER = String.raw`(?!(?:Public|Default|All Users)(?:\\|[^A-Za-z0-9._-]|$))[A-Za-z0-9._-]+`;
// A home path: /root, /home/<user> or /Users/<user>, followed by a slash or the end of the word (`/home/bob.`).
const HOME = String.raw`(?:\/root|\/home\/[A-Za-z0-9._-]+|\/Users\/${USER})(?:\/|\b)`;

/**
 * Secret and personal-detail patterns: [kind, global regex, excuse]. The kind is what the message says; the match is
 * never shown. `excuse` (when given) lets a match through: only for e-mail addresses on the reserved example domains.
 * @type {[string, RegExp, ((m: RegExpMatchArray) => boolean)?][]}
 */
export const SECRET_PATTERNS = [
  ["private key block", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/g],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["OpenAI API key", /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["e-mail address", /(?<![\w.%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g, (m) => reservedAddress(String(m[1]), String(m[2]))],
  // After start, a character that cannot be part of a path, or a URL scheme's "://" (file:///home/alice/...).
  ["home-directory path", new RegExp(String.raw`(?:^|[^\w.~/-]|:\/\/)${HOME}`, "g")],
  // The same path behind a host, for the schemes that name a file on a machine (file://localhost/home/alice/...).
  ["home-directory path", new RegExp(String.raw`\b(?:file|sftp|ssh|scp|rsync|ftp):\/\/[^\s/]+${HOME}`, "g")],
  // A Windows profile folder, C:\Users\<user>, with single or doubled (escaped) backslashes.
  ["home-directory path", new RegExp(String.raw`(?<![A-Za-z0-9])[A-Za-z]:\\{1,2}Users\\{1,2}${WIN_USER}`, "gi")],
];

/**
 * An address that names nobody: git@<host> (an SSH remote), or a domain that is example.com, example.org, example.net
 * or a subdomain of one, or whose final label is test, example, invalid or localhost.
 * @param {string} local @param {string} domain
 */
function reservedAddress(local, domain) {
  const d = domain.toLowerCase();
  if (local === "git") return true;
  if (/(?:^|\.)example\.(?:com|org|net)$/.test(d)) return true;
  return /\.(?:test|example|invalid|localhost)$/.test(d);
}

/** The kinds found in one line. @param {string} line @returns {string[]} */
function kindsIn(line) {
  /** @type {string[]} */
  const kinds = [];
  for (const [kind, re, excuse] of SECRET_PATTERNS) {
    if (kinds.includes(kind)) continue;
    for (const m of line.matchAll(re)) {
      if (excuse && excuse(m)) continue;
      kinds.push(kind);
      break;
    }
  }
  return kinds;
}

/**
 * The secret findings in one text: line number and kind, never the match.
 * @param {string} text @returns {{ line: number, kind: string }[]}
 */
export function scanText(text) {
  /** @type {{ line: number, kind: string }[]} */
  const out = [];
  text.split("\n").forEach((l, i) => {
    for (const kind of kindsIn(l)) out.push({ line: i + 1, kind });
  });
  return out;
}

/** The kinds in one line, read as it is and once more with NUL bytes removed (text stored as UTF-16). @param {string} line */
function lineKinds(line) {
  if (!line.includes("\0")) return kindsIn(line);
  return [...new Set([...kindsIn(line), ...kindsIn(line.replace(/\0/g, ""))])];
}

/** Text with every secret match (excused addresses aside) replaced by [masked]. @param {string} text */
export const mask = (text) =>
  SECRET_PATTERNS.reduce((t, [, re, excuse]) => t.replace(re, (...a) => {
    const m = /** @type {RegExpMatchArray} */ (/** @type {unknown} */ (a.slice(0, -2).filter((x) => typeof x === "string" || x === undefined)));
    return excuse && excuse(m) ? String(a[0]) : "[masked]";
  }), text);

/** Whether a repository path is one a skill branch may change. @param {string} path @param {string} name */
export const allowedPath = (path, name) => path === "README.md" || path.startsWith(`skills/${name}/`);

/**
 * git -C dir for reading: optional locks, replace refs, hooks and fsmonitor off; quoting and diff prefixes fixed so
 * repository config cannot change what is parsed. { status, out, big }: status null on a spawn error or timeout, big
 * when the output passed `MAX_HISTORY_BYTES`.
 * @param {string} dir @param {string[]} args
 */
function git(dir, args) {
  const r = spawnSync(
    "git",
    ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=true", "-C", dir, ...args],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_EXTERNAL_DIFF: "" },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: MAX_HISTORY_BYTES,
    },
  );
  const err = /** @type {NodeJS.ErrnoException | undefined} */ (r.error);
  return { status: err ? null : r.status, out: typeof r.stdout === "string" ? r.stdout : "", big: err?.code === "ENOBUFS" };
}

const DIFF_OPTS = ["--no-color", "--no-ext-diff", "--no-textconv", "--text", "--no-renames", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/", "-U0"];

/** A path as git prints it in a diff header, C-quoted or plain. @param {string} s */
function unquote(s) {
  if (!s.startsWith('"')) return s;
  /** @type {number[]} */
  const bytes = [];
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (c === '"') break;
    if (c !== "\\") {
      bytes.push(...Buffer.from(String(c), "utf8"));
      continue;
    }
    const n = s[++i] ?? "";
    if (/[0-7]/.test(n)) {
      bytes.push(parseInt(s.slice(i, i + 3), 8));
      i += 2;
    } else bytes.push(({ n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 })[/** @type {"n"} */ (n)] ?? n.charCodeAt(0));
  }
  return Buffer.from(bytes).toString("utf8");
}

/** The path of a `diff --git a/<p> b/<p>` line (renames are off, so both sides are the same path). @param {string} line */
function diffPath(line) {
  const rest = line.slice("diff --git ".length);
  if (rest.startsWith('"')) {
    const end = rest.indexOf('" ');
    return unquote(rest.slice(0, end + 1)).replace(/^a\//, "");
  }
  const p = (rest.length - 5) / 2;
  if (Number.isInteger(p) && p > 0 && rest.slice(2 + p) === ` b/${rest.slice(2, 2 + p)}`) return rest.slice(2, 2 + p);
  return rest.replace(/^a\//, "");
}

/**
 * The added lines of a `git diff`/`git log -p` output (with -U0), with the commit, path and new line number of each.
 * @param {string} out @param {(a: { commit: string | null, file: string, line: number, text: string }) => void} each
 */
function eachAdded(out, each) {
  /** @type {string | null} */
  let commit = null;
  let file = "";
  let n = 0;
  let inHunk = false;
  for (const l of out.split("\n")) {
    if (!inHunk || !(l.startsWith("+") || l.startsWith("-") || l.startsWith("\\"))) {
      // Headers: a content line inside a hunk always starts with +, - or \ (no context lines with -U0).
      if (l.startsWith("commit ")) {
        commit = l.slice(7).trim().split(/\s/)[0] ?? null;
        inHunk = false;
        continue;
      }
      if (l.startsWith("diff --git ")) {
        file = diffPath(l);
        inHunk = false;
        continue;
      }
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
      if (h) {
        n = Number(h[1]);
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
    }
    // Inside a hunk an added line that itself starts with `++` is printed as `+++ ...` and is still an added line.
    if (l.startsWith("+")) each({ commit, file, line: n++, text: l.slice(1) });
  }
}

/**
 * @typedef {{ file: string, line: number | null, kind: string, commit?: string }} Finding
 * A finding: `line` in the branch's last version, or `commit` (and no line) when only an earlier commit holds it.
 */

/**
 * What a push of the branch would carry beyond its merge base with `base`.
 * @param {string} dir a work tree of the repository
 * @param {{ base: string | null, branch: string, name: string }} o
 * @returns {{ mergeBase: string | null, findings: Finding[], outside: string[], problems: string[] }}
 */
export function scanBranch(dir, { base, branch, name }) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const problems = [];
  const none = () => ({ mergeBase: null, findings, outside: [], problems });
  try {
    const tip = git(dir, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`]);
    if (tip.status !== 0 || !tip.out.trim()) {
      problems.push(`branch ${branch} cannot be found`);
      return none();
    }
    const head = tip.out.trim();
    if (!base || git(dir, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).status !== 0) {
      problems.push(`its base branch${base ? ` ${base}` : ""} cannot be found`);
      return none();
    }
    const mb = git(dir, ["merge-base", base, head]);
    const mergeBase = mb.status === 0 ? mb.out.trim() : "";
    if (!/^[0-9a-f]{40,64}$/.test(mergeBase)) {
      problems.push(`it shares no commit with ${base}, so there is no merge base to compare it with`);
      return none();
    }
    const range = `${mergeBase}..${head}`;
    const tooBig = `its history is too large to scan (over ${MAX_HISTORY_BYTES / 1024 / 1024} MB of changes)`;

    // Paths: every path any commit of the branch touches (merges against each parent), and the net change.
    const names = git(dir, ["log", "--no-color", "--no-renames", "--no-relative", "--diff-merges=separate", "--format=", "--name-only", "-z", range]);
    const net = git(dir, ["diff", "--name-only", "-z", "--no-renames", "--no-relative", mergeBase, head]);
    if (names.status !== 0 || net.status !== 0) {
      problems.push(names.big ? tooBig : "git cannot list the paths its commits change");
      return { mergeBase, findings, outside: [], problems };
    }
    const outside = [...new Set(`${names.out}\0${net.out}`.split("\0").map((p) => p.replace(/^\n+/, "")).filter(Boolean))]
      .filter((p) => !allowedPath(p, name))
      .sort();

    // The branch's last version against the merge base: the lines it adds, by path.
    const netDiff = git(dir, ["diff", ...DIFF_OPTS, mergeBase, head]);
    const hist = git(dir, ["log", ...DIFF_OPTS, "-p", "--diff-merges=separate", "--format=commit %H", range]);
    if (netDiff.status !== 0 || hist.status !== 0) {
      problems.push(netDiff.big || hist.big ? tooBig : "git cannot show the lines its commits add");
      return { mergeBase, findings, outside, problems };
    }
    /** @type {Map<string, Set<string>>} */
    const last = new Map();
    const seen = new Set();
    eachAdded(netDiff.out, ({ file, line, text }) => {
      if (!last.has(file)) last.set(file, new Set());
      last.get(file)?.add(text);
      for (const kind of lineKinds(text)) {
        const key = `${file}\n${line}\n${kind}`;
        if (!seen.has(key)) findings.push({ file, line, kind });
        seen.add(key);
      }
    });
    // Every commit: a line the last version no longer adds is only in the history (log order is newest first, so the
    // commit kept is the oldest that added it).
    /** @type {Map<string, Finding>} */
    const older = new Map();
    eachAdded(hist.out, ({ commit, file, text }) => {
      if (last.get(file)?.has(text)) return;
      for (const kind of lineKinds(text)) older.set(`${file}\n${kind}\n${text}`, { file, line: null, kind, commit: commit ?? "unknown" });
    });
    const hseen = new Set();
    for (const f of older.values()) {
      const key = `${f.file}\n${f.kind}\n${f.commit}`;
      if (!hseen.has(key)) findings.push(f);
      hseen.add(key);
    }
    return { mergeBase, findings, outside, problems };
  } catch {
    problems.push("the scan failed");
    return none();
  }
}

/** One finding as the gate and the publish script print it (never the matched text). @param {Finding} f */
export const findingLine = (f) => `${f.file}${f.commit ? `, only in earlier commit ${f.commit.slice(0, 12)}` : f.line === null ? "" : ` line ${f.line}`}: ${f.kind}`;

/** What to do about a finding that only an earlier commit holds. @param {string | null} mergeBase */
export const historyAdvice = (mergeBase) =>
  `A finding marked "only in earlier commit" is gone from the branch's last version but stays in its history, which the publish step pushes whole: removing the line in a new commit leaves it in the history. Recreate the branch's commits without it: in the draft worktree run git reset --soft ${mergeBase ? mergeBase.slice(0, 12) : "<merge base>"} (the merge base with the base branch), check the files, seal again and commit once.`;

/** The text for paths outside the skill folder and README.md. @param {string[]} outside @param {string} name @param {string | null} mergeBase */
export const outsideText = (outside, name, mergeBase) => {
  const shown = outside.slice(0, 20).join(", ");
  const more = outside.length > 20 ? ` and ${outside.length - 20} more` : "";
  return `The branch changes paths outside skills/${name}/ and README.md: ${shown}${more}. A skill branch changes only its skill folder and README.md, and every commit of it is pushed, so a later commit that undoes the change does not help. Recreate the branch's commits without these paths: in the draft worktree run git reset --soft ${mergeBase ? mergeBase.slice(0, 12) : "<merge base>"}, restore or delete them, seal again and commit once.`;
};
