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
//                 within the limits, is a `problem`: callers block on it, never pass. Since 2.0.0 also every byte of
//                 each raw commit object the push carries, read as latin1 whatever its encoding header says, with every
//                 pattern. Tags: every ref under refs/tags is followed through its chain of tag objects (a tag of a tag
//                 of ...) to the object it finally names, at most MAX_TAG_CHAIN (16) tag objects deep. When that object
//                 is a commit the push carries, or a blob or tree the push carries (an object `git rev-list --objects`
//                 lists for the draft's range or for the unpushed base commits), the tag's name and every byte of
//                 every tag object of the chain are scanned. A tag whose chain ends at any other commit, blob or tree
//                 is outside the draft and ignored: the publish push sends the branch only (--no-follow-tags), so it
//                 cannot carry it. A chain deeper than the bound, a loop, a missing or unreadable object, a tag object
//                 that does not start with `object <id>` and `type <type>` or whose type line is not the named
//                 object's type is a `problem`, whichever tag it is. Only a commit's `tree <id>`/`parent <id>` and a
//                 tag object's `object <id>`/`type <type>` lines in exactly that form are skipped. Addresses: the
//                 object's own (first <...> of its first author and committer, or tagger, line) and no-reply
//                 addresses pass; any other is a finding. With `identity` it lists in `foreign` every author or
//                 committer address the person's git does not use (the publish step blocks on them, as on outside
//                 paths).
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

/**
 * The kinds found in one line. `allowAddress` (commit metadata only) lets more e-mail addresses through: an identity's
 * own address field, and in a commit or tag message a no-reply address or the commit's own author or committer address.
 * @param {string} line @param {(local: string, domain: string) => boolean} [allowAddress] @returns {string[]}
 */
function kindsIn(line, allowAddress) {
  /** @type {string[]} */
  const kinds = [];
  for (const [kind, re, excuse] of SECRET_PATTERNS) {
    if (kinds.includes(kind)) continue;
    for (const m of line.matchAll(re)) {
      if (excuse && excuse(m)) continue;
      if (allowAddress && kind === "e-mail address" && allowAddress(String(m[1]), String(m[2]))) continue;
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

/**
 * The kinds in one line, read as it is and once more with NUL bytes removed (text stored as UTF-16).
 * @param {string} line @param {(local: string, domain: string) => boolean} [allowAddress]
 */
function lineKinds(line, allowAddress) {
  if (!line.includes("\0")) return kindsIn(line, allowAddress);
  return [...new Set([...kindsIn(line, allowAddress), ...kindsIn(line.replace(/\0/g, ""), allowAddress)])];
}

/** Text with every secret match (excused addresses aside) replaced by [masked]. @param {string} text */
export const mask = (text) =>
  SECRET_PATTERNS.reduce((t, [, re, excuse]) => t.replace(re, (...a) => {
    const m = /** @type {RegExpMatchArray} */ (/** @type {unknown} */ (a.slice(0, -2).filter((x) => typeof x === "string" || x === undefined)));
    return excuse && excuse(m) ? String(a[0]) : "[masked]";
  }), text);

// A control character (C0, DEL, C1) in a name: such a name is never an allowed path and is shown escaped.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Whether a repository path, exactly as git names it, is one a skill branch may change: README.md, or a file under
 * skills/<name>/ whose name has no control character.
 * @param {string} path @param {string} name
 */
export const allowedPath = (path, name) => !CONTROL.test(path) && (path === "README.md" || path.startsWith(`skills/${name}/`));

/** A repository path for a message: as it is, or JSON-quoted when it holds a control character or a quote. @param {string} p */
export const shownPath = (p) => (CONTROL.test(p) || p.includes('"') ? JSON.stringify(p) : p);

/**
 * git -C dir for reading: optional locks, replace refs, hooks and fsmonitor off; quoting and diff prefixes fixed so
 * repository config cannot change what is parsed. { status, out, big }: status null on a spawn error or timeout, big
 * when the output passed `MAX_HISTORY_BYTES`. `input` goes to git's stdin (for --stdin).
 * @param {string} dir @param {string[]} args @param {string} [input]
 */
function git(dir, args, input) {
  const r = spawnSync(
    "git",
    ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "core.quotePath=true", "-C", dir, ...args],
    {
      encoding: "utf8",
      timeout: 60_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_EXTERNAL_DIFF: "" },
      input: input ?? "",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: MAX_HISTORY_BYTES,
    },
  );
  const err = /** @type {NodeJS.ErrnoException | undefined} */ (r.error);
  return { status: err ? null : r.status, out: typeof r.stdout === "string" ? r.stdout : "", big: err?.code === "ENOBUFS" };
}

/**
 * The raw objects (commits, tags) of `ids`, by id, through one `git cat-file --batch`; null when git fails, an object
 * is missing or the output cannot be split by the sizes git gives.
 * @param {string} dir @param {string[]} ids @returns {Map<string, string> | null}
 */
function catFile(dir, ids) {
  const typed = catFileTyped(dir, ids);
  return typed && new Map([...typed].map(([id, o]) => [id, o.raw]));
}

/**
 * The type of each of `ids` (`git cat-file --batch-check`): null when git fails, an object is missing or a line is
 * not `<id> <type> <size>` for the id asked.
 * @param {string} dir @param {string[]} ids @returns {Map<string, string> | null}
 */
function objectTypes(dir, ids) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const want = [...new Set(ids)];
  if (!want.length) return out;
  const r = git(dir, ["cat-file", "--batch-check"], `${want.join("\n")}\n`);
  if (r.status !== 0) return null;
  const lines = r.out.split("\n");
  for (const [i, id] of want.entries()) {
    const f = (lines[i] ?? "").split(" ");
    if (f.length !== 3 || f[0] !== id || !/^(?:commit|tree|blob|tag)$/.test(f[1] ?? "")) return null;
    out.set(id, String(f[1]));
  }
  return out;
}

/**
 * The raw objects of `ids` with the type git reports for each; null as for catFile.
 * @param {string} dir @param {string[]} ids @returns {Map<string, { type: string, raw: string }> | null}
 */
function catFileTyped(dir, ids) {
  /** @type {Map<string, { type: string, raw: string }>} */
  const out = new Map();
  const want = [...new Set(ids)];
  if (!want.length) return out;
  const r = spawnSync(
    "git",
    ["--no-optional-locks", "--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", dir, "cat-file", "--batch"],
    {
      timeout: 60_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1" },
      input: `${want.join("\n")}\n`,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: MAX_HISTORY_BYTES,
    },
  );
  if (r.error || r.status !== 0 || !Buffer.isBuffer(r.stdout)) return null;
  const b = r.stdout;
  let i = 0;
  for (const id of want) {
    const nl = b.indexOf(10, i);
    if (nl < 0) return null;
    const head = b.subarray(i, nl).toString("latin1").split(" ");
    const size = Number(head[2]);
    if (head.length !== 3 || head[0] !== id || head[1] === "missing" || !Number.isInteger(size) || nl + 1 + size > b.length) return null;
    // latin1: one character per byte, whatever the object's `encoding` header says, so no byte is lost to decoding.
    out.set(id, { type: String(head[1]), raw: b.subarray(nl + 1, nl + 1 + size).toString("latin1") });
    i = nl + 1 + size + 1;
  }
  return out;
}

const HEX_ID = String.raw`[0-9a-f]{40}(?:[0-9a-f]{24})?`;
// The only lines of a raw object the scan does not read, each in its exact, checked form; a line of any other form,
// such a key included, is scanned as text.
const EXEMPT = {
  commit: new RegExp(String.raw`^(?:tree|parent) ${HEX_ID}$`),
  tag: new RegExp(String.raw`^(?:object ${HEX_ID}|type (?:commit|tree|blob|tag))$`),
};
const IDENT_KEYS = { commit: ["author", "committer"], tag: ["tagger"] };

/** The most tag objects one chain (a tag of a tag of ...) may hold; a longer chain is a problem, never cut short. */
export const MAX_TAG_CHAIN = 16;
const TAG_OBJECT_LINE = new RegExp(String.raw`^object (${HEX_ID})$`);
const TAG_TYPE_LINE = /^type (commit|tree|blob|tag)$/;

/**
 * @typedef {{ name: string, tags: string[], target: string, type: string }} TagChain
 * A tag ref followed to its final target: `tags` the tag objects from the ref inwards (empty for a lightweight tag),
 * `target` and `type` the object the innermost one names (as git reports its type).
 */

/**
 * Every tag ref followed through its chain of tag objects to the final target, at most MAX_TAG_CHAIN tag objects
 * deep. Each tag object must start with `object <id>` and `type <type>` in exactly that form, the type being the one
 * git reports for that object. A deeper chain, a loop, a missing or unreadable object, or a malformed or mistyped tag
 * object is a problem (one text), never a stop that passes.
 * @param {string} dir @param {{ obj: string, type: string, name: string }[]} refs
 * @returns {{ chains: TagChain[], raws: Map<string, string>, problem: string | null }}
 */
function tagChains(dir, refs) {
  /** @type {TagChain[]} */
  const chains = refs.map((r) => ({ name: r.name, tags: [], target: r.obj, type: r.type }));
  /** @type {Map<string, string>} */
  const raws = new Map();
  /** @param {string} problem */
  const fail = (problem) => ({ chains: [], raws, problem });
  for (let depth = 0; ; depth++) {
    const open = chains.filter((c) => c.type === "tag");
    if (!open.length) return { chains, raws, problem: null };
    if (depth >= MAX_TAG_CHAIN) return fail(`a tag of the repository is a chain of more than ${MAX_TAG_CHAIN} tag objects (a tag of a tag of ...), deeper than the scan follows`);
    const objs = catFileTyped(dir, open.map((c) => c.target).filter((id) => !raws.has(id)));
    if (!objs) return fail("git cannot read a tag object of a tag of the repository (missing or unreadable)");
    for (const [id, o] of objs) {
      if (o.type !== "tag") return fail("a tag of the repository names, as a tag, an object git does not read as a tag object");
      raws.set(id, o.raw);
    }
    /** @type {Map<TagChain, string>} */
    const declared = new Map();
    for (const c of open) {
      if (c.tags.includes(c.target)) return fail("a tag of the repository is a chain of tag objects that loops");
      c.tags.push(c.target);
      const [first = "", second = ""] = (raws.get(c.target) ?? "").split("\n", 2);
      const obj = TAG_OBJECT_LINE.exec(first);
      const type = TAG_TYPE_LINE.exec(second);
      if (!obj || !type) return fail("a tag of the repository holds a malformed tag object (it does not start with `object <id>` and `type <type>` lines)");
      c.target = String(obj[1]);
      declared.set(c, String(type[1]));
    }
    const types = objectTypes(dir, open.map((c) => c.target));
    if (!types) return fail("git cannot read the object a tag object of the repository names (missing or unreadable)");
    for (const c of open) {
      c.type = types.get(c.target) ?? "";
      if (c.type !== declared.get(c)) return fail("a tag of the repository holds a tag object whose `type` line is not the type of the object it names");
    }
  }
}

/**
 * The ids of the blobs and trees (and commits) a push of the draft carries: every object `rev-list --objects` lists for
 * the draft's range (`draft`) and for its merge base against each address's known commits (`base`, the unpushed base
 * commits' objects). null when git cannot list them.
 * @param {string} dir @param {string} range @param {string} mergeBase @param {string[][]} sets
 */
function pushedObjects(dir, range, mergeBase, sets) {
  const ids = (/** @type {string} */ out) => out.split("\n").filter((l) => /^[0-9a-f]{40,64}$/.test(l));
  const d = git(dir, ["rev-list", "--objects", "--no-object-names", range]);
  if (d.status !== 0) return null;
  /** @type {Set<string>} */
  const base = new Set();
  for (const has of sets) {
    const b = git(dir, ["rev-list", "--objects", "--no-object-names", "--ignore-missing", mergeBase, "--not", ...has]);
    if (b.status !== 0) return null;
    for (const id of ids(b.out)) base.add(id);
  }
  return { draft: new Set(ids(d.out)), base };
}
// An address in a line as the e-mail pattern finds it.
const ADDRESS = /(?<![\w.%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g;

/** An address that names no one who would mind: a no-reply address (noreply@..., ...@users.noreply.github.com). @param {string} local @param {string} domain */
const noReply = (local, domain) => /^no-?reply$/i.test(local) || /^users\.noreply\.github\.com$/i.test(domain);

/** The header lines of a raw object (up to its first empty line), with their line numbers. @param {string} raw */
const headerLines = (raw) => {
  const lines = raw.split("\n");
  const end = lines.indexOf("");
  return { lines, end: end < 0 ? lines.length : end };
};

/**
 * The object's own addresses: the first `<...>` of its first author and first committer line (a tag: tagger line).
 * @param {string} raw @param {"commit" | "tag"} type
 */
function ownAddresses(raw, type) {
  const { lines, end } = headerLines(raw);
  /** @type {string[]} */
  const own = [];
  for (const key of IDENT_KEYS[type]) {
    const l = lines.slice(0, end).find((x) => x.startsWith(`${key} `));
    const m = l ? /<([^<>\n]*)>/.exec(l) : null;
    if (m) own.push(String(m[1]).toLowerCase());
  }
  return own;
}

/**
 * The findings in one raw commit or tag object as a push carries it (2.0.0): every line is scanned as text with every
 * pattern (UTF-16 and NUL handling included), except a commit's `tree <id>` and `parent <id>` header lines and a tag's
 * `object <id>` and `type <commit|tree|blob|tag>` header lines, each only in exactly that form. One rule lets
 * addresses through: the object's own addresses (the first `<...>` of its first author and committer, or tagger, line)
 * and no-reply addresses; any other address, in an identity line, a header, a signature or the message, is a finding.
 * @param {string} raw the object's bytes as latin1 @param {"commit" | "tag"} type
 * @param {{ commit: string, tagName?: string, base?: boolean, on?: string }} at `on`: a tag's final target is a blob
 *   or tree (its id in `commit`), not a commit
 * @returns {Finding[]}
 */
export function objectFindings(raw, type, at) {
  /** @type {Finding[]} */
  const out = [];
  const own = new Set(ownAddresses(raw, type));
  /** @param {string} l @param {string} d */
  const allowed = (l, d) => noReply(l, d) || own.has(`${l}@${d}`.toLowerCase());
  const { lines, end } = headerLines(raw);
  const seen = new Set();
  /** @param {string} w @param {number | null} line @param {string} kind */
  const add = (w, line, kind) => {
    const key = `${w}\n${line}\n${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ file: "", line, kind, commit: at.commit, where: w, ...(at.base ? { base: true } : {}), ...(at.on ? { on: at.on } : {}) });
  };
  if (at.tagName !== undefined) for (const kind of lineKinds(at.tagName, allowed)) add("tag", null, kind);
  lines.forEach((l, i) => {
    const inHeader = i < end;
    if (inHeader && EXEMPT[type].test(l)) return;
    const key = inHeader ? l.slice(0, l.indexOf(" ") < 0 ? l.length : l.indexOf(" ")) : "";
    const where = type === "tag" ? "tag" : !inHeader ? "message" : IDENT_KEYS.commit.includes(key) ? key : "header";
    for (const kind of lineKinds(l, allowed)) add(where, where === "message" ? i - end : null, kind);
  });
  return out;
}

/**
 * The authors and committers of a raw commit whose addresses are not in `mine`: every address on an author or
 * committer line, the first `<...>` and any other one alike. Names and addresses decoded as UTF-8 for display.
 * @param {string} raw @param {Set<string>} mine @param {string} commit @returns {Identity[]}
 */
function identities(raw, mine, commit) {
  const { lines, end } = headerLines(raw);
  /** @type {Identity[]} */
  const out = [];
  const utf8 = (/** @type {string} */ s) => Buffer.from(s, "latin1").toString("utf8");
  for (const l of lines.slice(0, end)) {
    const key = IDENT_KEYS.commit.find((k) => l.startsWith(`${k} `));
    if (!key) continue;
    const name = l.slice(key.length + 1).split("<")[0]?.trim() ?? "";
    const first = /<([^<>\n]*)>/.exec(l)?.[1] ?? "";
    const addresses = new Set([first, ...[...l.matchAll(ADDRESS)].map((m) => m[0])].map((a) => a.toLowerCase()));
    for (const a of addresses) if (!mine.has(a)) out.push({ name: utf8(name), email: utf8(a), commit });
  }
  return out;
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
 * @typedef {{ file: string, line: number | null, kind: string, commit?: string, base?: boolean, where?: string, on?: string }} Finding
 * A finding: `line` in the branch's last version, or `commit` (and no line) when only an earlier commit holds it;
 * `base` when that commit is one of the base's that the remote lacks (not part of the draft, but pushed with it).
 * `where` (no file) for a finding in a commit's metadata: "message" (with the message line), "author", "committer", or
 * "tag" (a tag that points at the commit: its name, tagger or message). `on` ("blob" or "tree") when the tag's final
 * target is that object, whose id is then in `commit`.
 */

/** @typedef {{ name: string, email: string, commit: string }} Identity */

/**
 * What a push of the branch would carry: the draft's own commits (merge base with `base` to the tip) and, when
 * `remote` is given, the commits below the merge base that the remote lacks (`unpushed`): a push sends those too.
 * @param {string} dir a work tree of the repository
 * @param {{ base: string | null, branch: string, name: string, remote?: string[] | null, remotes?: string[][] | null, identity?: string[] | null }} o
 *   `remote`: revision arguments naming what the target remote has (commit ids from git ls-remote, or
 *   --remotes=origin); ids this repository lacks are ignored. `remotes`, instead of `remote`: one such list per address
 *   a push goes to; a commit counts as present only when every address has it (the union of what each lacks).
 *   `identity`: the e-mail addresses the person's git uses (the publish step); each author or committer of the
 *   draft's own commits with another address is listed in `foreign`. Without it `foreign` stays empty.
 * Besides the lines and paths, every commit's metadata is scanned (objectFindings: every line of each raw object but its fixed-form id lines): message, author, committer and the
 * tags whose chain of tag objects ends at it (name, and every tag object of the chain), for the draft's commits and the
 * unpushed base commits alike, and the tags whose chain ends at a blob or tree the push carries (see the file header).
 * @returns {{ mergeBase: string | null, findings: Finding[], outside: string[], unpushed: string[], problems: string[], foreign: Identity[] }}
 */
export function scanBranch(dir, { base, branch, name, remote = null, remotes = null, identity = null }) {
  /** @type {Finding[]} */
  const findings = [];
  /** @type {string[]} */
  const problems = [];
  /** @type {string[]} */
  let unpushed = [];
  /** @type {Identity[]} */
  const foreign = [];
  const none = () => ({ mergeBase: null, findings, outside: [], unpushed, problems, foreign });
  try {
    // The branch ref must name a commit itself: `^{commit}` below would peel a tag object (an annotated tag stored
    // under refs/heads) to its commit, and a push of the branch would then carry the tag object, which is never scanned.
    const kind = git(dir, ["cat-file", "-t", `refs/heads/${branch}`]);
    if (kind.status === 0 && kind.out.trim() !== "commit") {
      problems.push(`branch ${branch} names a ${kind.out.trim() === "tag" ? "tag object" : kind.out.trim() || "non-commit object"}, not a commit: point the branch at the draft's commit`);
      return none();
    }
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
      return { mergeBase, findings, outside: [], unpushed, problems, foreign };
    }
    // Names exactly as git gives them (NUL-separated, never trimmed or rewritten): a name with a control character is
    // never allowed.
    const outside = [...new Set(`${names.out}\0${net.out}`.split("\0").filter((p) => p !== ""))]
      .filter((p) => !allowedPath(p, name))
      .sort();

    // The commits below the merge base that the remote lacks: a push of the branch sends them too.
    const sets = remotes ?? (remote ? [remote] : []);
    if (remotes && !remotes.length) {
      problems.push("there is no remote address to compare its base with");
      return { mergeBase, findings, outside, unpushed, problems, foreign };
    }
    /** @type {Set<string>} */
    const lacking = new Set();
    for (const has of sets) {
      const rl = git(dir, ["rev-list", "--ignore-missing", mergeBase, "--not", ...has]);
      if (rl.status !== 0) {
        problems.push("git cannot tell which commits of its base the remote lacks");
        return { mergeBase, findings, outside, unpushed, problems, foreign };
      }
      for (const l of rl.out.split("\n")) if (/^[0-9a-f]{40,64}$/.test(l)) lacking.add(l);
    }
    unpushed = [...lacking];

    // The branch's last version against the merge base: the lines it adds, by path.
    const netDiff = git(dir, ["diff", ...DIFF_OPTS, mergeBase, head]);
    const hist = git(dir, ["log", ...DIFF_OPTS, "-p", "--diff-merges=separate", "--format=commit %H", range]);
    const baseHist = unpushed.length ? git(dir, ["log", ...DIFF_OPTS, "-p", "--diff-merges=separate", "--format=commit %H", "--no-walk=unsorted", ...unpushed]) : { status: 0, out: "", big: false };
    if (netDiff.status !== 0 || hist.status !== 0 || baseHist.status !== 0) {
      problems.push(netDiff.big || hist.big || baseHist.big ? tooBig : "git cannot show the lines its commits add");
      return { mergeBase, findings, outside, unpushed, problems, foreign };
    }
    // Every line an unpushed base commit adds (whether or not the draft still has it): pushed with the branch.
    const bseen = new Set();
    eachAdded(baseHist.out, ({ commit, file, text }) => {
      for (const kind of lineKinds(text)) {
        const key = `${file}\n${kind}\n${commit}`;
        if (!bseen.has(key)) findings.push({ file, line: null, kind, commit: commit ?? "unknown", base: true });
        bseen.add(key);
      }
    });
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

    // Metadata: what the push carries besides the lines and paths. Every commit's message, author and committer (the
    // draft's own and the unpushed base commits), and every tag that points at one of them: its name, tagger and
    // message. The publish push sends no tag (--no-follow-tags), but a tag the scan let through could still leave by
    // another push; a draft with one is refused like a line. A commit or tag git cannot read is a problem.
    const own = git(dir, ["rev-list", range]);
    if (own.status !== 0) {
      problems.push(own.big ? tooBig : "git cannot list its commits");
      return { mergeBase, findings, outside, unpushed, problems, foreign };
    }
    const ownIds = own.out.split("\n").filter((l) => /^[0-9a-f]{40,64}$/.test(l));
    const baseIds = new Set(unpushed);
    const tagRefs = git(dir, ["for-each-ref", "--format=%(objectname)%00%(objecttype)%00%(refname)", "refs/tags"]);
    if (tagRefs.status !== 0) {
      problems.push("git cannot list its tags");
      return { mergeBase, findings, outside, unpushed, problems, foreign };
    }
    /** @type {{ obj: string, type: string, name: string }[]} */
    const refs = [];
    for (const l of tagRefs.out.split("\n")) {
      if (!l) continue;
      const [obj = "", type = "", ref = ""] = l.split("\0");
      if (!/^[0-9a-f]{40,64}$/.test(obj) || !/^(?:commit|tree|blob|tag)$/.test(type)) {
        problems.push("git cannot list its tags");
        return { mergeBase, findings, outside, unpushed, problems, foreign };
      }
      refs.push({ obj, type, name: ref.replace(/^refs\/tags\//, "") });
    }
    // Every tag followed through its chain of tag objects (a tag of a tag of ...) to the object it finally names.
    const walked = tagChains(dir, refs);
    if (walked.problem) {
      problems.push(walked.problem);
      return { mergeBase, findings, outside, unpushed, problems, foreign };
    }
    // A chain whose final target is a blob or a tree counts only when the push of the draft carries that object.
    const needObjects = walked.chains.some((c) => c.type === "blob" || c.type === "tree");
    const pushedObjs = needObjects ? pushedObjects(dir, range, mergeBase, sets) : { draft: new Set(), base: new Set() };
    if (!pushedObjs) {
      problems.push("git cannot list the objects its commits carry");
      return { mergeBase, findings, outside, unpushed, problems, foreign };
    }
    const inPush = new Set([...ownIds, ...unpushed]);
    const objects = catFile(dir, [...ownIds, ...unpushed]);
    if (!objects) {
      problems.push("git cannot show its commits' messages and authors");
      return { mergeBase, findings, outside, unpushed, problems, foreign };
    }
    for (const id of [...ownIds, ...unpushed]) findings.push(...objectFindings(objects.get(id) ?? "", "commit", { commit: id, base: baseIds.has(id) && !ownIds.includes(id) }));
    // Each tag whose chain reaches what the push carries: its name, and every tag object of the chain, each as a tag
    // object with its own exempt lines (each object scanned once, whichever tags share it).
    const tagSeen = new Set();
    const scannedTags = new Set();
    for (const c of walked.chains) {
      const t = c.target;
      const blobOrTree = c.type === "blob" || c.type === "tree";
      const carried = c.type === "commit" ? inPush.has(t) : blobOrTree && (pushedObjs.draft.has(t) || pushedObjs.base.has(t));
      if (!carried) continue;
      const at = { commit: t, base: c.type === "commit" ? baseIds.has(t) && !ownIds.includes(t) : !pushedObjs.draft.has(t), ...(blobOrTree ? { on: c.type } : {}) };
      const found = objectFindings("", "tag", { ...at, tagName: c.name });
      for (const id of c.tags) {
        if (scannedTags.has(id)) continue;
        scannedTags.add(id);
        found.push(...objectFindings(walked.raws.get(id) ?? "", "tag", at));
      }
      for (const f of found) {
        const key = `${f.commit}\n${f.kind}\n${f.base ? 1 : 0}`;
        if (tagSeen.has(key)) continue;
        tagSeen.add(key);
        findings.push(f);
      }
    }
    // Whose names go out: every address on the author and committer lines of the draft's own commits that the
    // person's git does not use.
    if (identity) {
      const mine = new Set(identity.map((/** @type {string} */ e) => e.toLowerCase()).filter(Boolean));
      const listed = new Set();
      for (const id of ownIds) {
        for (const who of identities(objects.get(id) ?? "", mine, id)) {
          const key = `${who.name}\n${who.email}`;
          if (listed.has(key)) continue;
          listed.add(key);
          foreign.push(who);
        }
      }
    }
    return { mergeBase, findings, outside, unpushed, problems, foreign };
  } catch {
    problems.push("the scan failed");
    return none();
  }
}

/** One finding as the gate and the publish script print it (never the matched text). @param {Finding} f */
export const findingLine = (f) => {
  if (f.where) {
    const c = (f.commit ?? "unknown").slice(0, 12);
    // A tag's name is never shown: it may be what the scan found.
    const what = f.where === "message" ? `the message of commit ${c}${f.line === null ? "" : ` line ${f.line}`}` : f.where === "tag" ? `a tag on ${f.on ?? "commit"} ${c} (its name or its tag object)` : f.where === "header" ? `a header line of commit ${c}` : `the ${f.where} line of commit ${c}`;
    return `${what}${f.base ? ", which is not part of the draft" : ""}: ${f.kind}`;
  }
  const at = f.base && f.commit ? `, in commit ${f.commit.slice(0, 12)}, which is not part of the draft` : f.commit ? `, only in earlier commit ${f.commit.slice(0, 12)}` : f.line === null ? "" : ` line ${f.line}`;
  return `${shownPath(f.file)}${at}: ${f.kind}`;
};

/**
 * The text for base commits a push of the branch would send although the remote lacks them.
 * @param {string[]} unpushed @param {string} remoteName @param {string} advice what to do, for the reader
 */
export const unpushedText = (unpushed, remoteName, advice) => {
  const n = unpushed.length;
  const shown = unpushed.slice(0, 10).map((c) => c.slice(0, 12)).join(", ");
  return `The branch sits on ${n} commit${n === 1 ? "" : "s"} of the base that ${remoteName} lacks (${shown}${n > 10 ? ` and ${n - 10} more` : ""}): a push of the branch sends ${n === 1 ? "it" : "them"} and its pull request would carry ${n === 1 ? "it" : "them"}, though ${n === 1 ? "it is" : "they are"} not part of the draft and the seal never covered ${n === 1 ? "it" : "them"}. ${advice}`;
};

/** What to do about a finding that only an earlier commit holds. @param {string | null} mergeBase */
export const historyAdvice = (mergeBase) =>
  `A finding marked "only in earlier commit" is gone from the branch's last version but stays in its history, which the publish step pushes whole: removing the line in a new commit leaves it in the history. Recreate the branch's commits without it: in the draft worktree run git reset --soft ${mergeBase ? mergeBase.slice(0, 12) : "<merge base>"} (the merge base with the base branch), check the files, seal again and commit once.`;

/** What to do about a finding in a commit message, an author or committer, or a tag. @param {string | null} mergeBase */
export const metaAdvice = (mergeBase) =>
  `A finding in a commit message, author or committer is pushed with the commit, and a later commit does not change it. Recreate the branch's commits: in the draft worktree run git reset --soft ${mergeBase ? mergeBase.slice(0, 12) : "<merge base>"}, seal again and commit once with a clean message and your own identity. A finding in a tag: delete that tag (git tag -d <tag>) or give it a clean name and message.`;

/**
 * The text for authors and committers whose address the person's git does not use (publish step only). Names and
 * addresses are shown masked by the secret patterns, so a name the scan flags is not printed.
 * @param {Identity[]} foreign @param {string[]} mine @param {string | null} mergeBase
 */
export const foreignText = (foreign, mine, mergeBase) => {
  // The address is shown as it is (it is what the person must see), unless it holds a secret or home path.
  /** @param {string} e */
  const addr = (e) => (kindsIn(e, () => true).length ? "[masked]" : e);
  const shown = foreign.slice(0, 10).map((f) => `${mask(f.name)} <${addr(f.email)}> (commit ${f.commit.slice(0, 12)})`).join(", ");
  const more = foreign.length > 10 ? ` and ${foreign.length - 10} more` : "";
  const yours = mine.length ? `the address your git uses (${mine.map(addr).join(", ")})` : "an address your git uses (none is set: git config user.email)";
  return `The branch's commits name authors or committers other than ${yours}: ${shown}${more}. The push publishes these names and addresses with the commits. If they are right, set user.email to that address and rerun; otherwise recreate the commits under your own identity: in the draft worktree run git reset --soft ${mergeBase ? mergeBase.slice(0, 12) : "<merge base>"}, seal again and commit once.`;
};

/** The text for paths outside the skill folder and README.md. @param {string[]} outside @param {string} name @param {string | null} mergeBase */
export const outsideText = (outside, name, mergeBase) => {
  const shown = outside.slice(0, 20).map(shownPath).join(", ");
  const more = outside.length > 20 ? ` and ${outside.length - 20} more` : "";
  return `The branch changes paths outside skills/${name}/ and README.md: ${shown}${more}. A skill branch changes only its skill folder and README.md, and every commit of it is pushed, so a later commit that undoes the change does not help. Recreate the branch's commits without these paths: in the draft worktree run git reset --soft ${mergeBase ? mergeBase.slice(0, 12) : "<merge base>"}, restore or delete them, seal again and commit once.`;
};
