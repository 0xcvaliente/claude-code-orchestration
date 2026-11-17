#!/usr/bin/env node
// PreToolUse hook (matcher Bash): holds the researcher to its read-only Bash allowlist. The researcher's tools line
// allows only git log/ls-files/rev-list/rev-parse/status/show, git branch --show-current (each also as git -C <dir> ...),
// wc, ls and du, (1.2.0) read-only search and paging: grep, rg, find, head, tail and cat, and (audit 2026-11-16 T-11)
// `sed -n '<N>p'`/`'<N>,<M>p'`, cut, stat and echo in narrow forms, and (fix-researcher-cd) `cd` with one literal path
// whose real location is the project folder or a folder inside it (CD_FORM, cdReach). A researcher once wrote a
// file with a heredoc and ran python3 regardless (docs/research-2026-10-31.md, section 6.5). This hook enforces the same
// list on every segment of the command.
// Why search runs through Bash: on macOS and Linux Claude Code leaves the Grep and Glob tools out of an agent whose
// tools list also names Bash, and `grep` and `find` in its shell are embedded ugrep and bfs (docs: tools reference,
// "Glob tool behavior"). Without them the researcher could only Read whole files (docs/research-2026-11-10.md). Each is
// held to forms that cannot write a file or start a program: `find` without its exec, ok, delete and fprint actions,
// `grep` and `rg` with long options from SEARCH_LONG only (so no --filter, --pager, --pre or config file) and
// without rg -z or grep -Q, `tail` without follow in any spelling, and none of them (nor wc) on a /dev/ device other
// than /dev/null (also as an option's value; judged on the text-normalised path and on the path the system resolves
// the written string to, not on its text); no command may hold a glob in an option's name (`tail -?`,
// `find . -delet[e]`). Since w3 (release 2.0.0): /proc and /sys are judged like /dev; a FIFO, socket or device
// operand is refused; a word with a glob is judged on every path it may expand to (`cat /de?/zero`, a symlinked folder
// behind a wildcard), over-inclusively and within bounds, past which the command is refused (TOO_MANY: the way around it
// is naming the files or quoting the glob for the command); and du's --files0-from and find's -files0-from values are
// judged. Not judged: a FIFO a command opens on its own (an ignore file rg or ugrep reads while searching, git's own
// files), a file created or swapped between the check and the run, and zsh extendedglob operators (`^`, `#`, `~`),
// which are off in a non-interactive shell. A lone `--`
// never ends the check (review of 2026-11-10: `rg -e -- --pre=sh x` used it to hide an option).
// Deny-only: exit 2 with the reason on stderr, or exit 0 with no output (the session's own permission rules then
// decide). It never prints an allow or ask decision. Acts only when the bare agent_type is `researcher`; any other
// agent, the main thread and malformed input exit 0 at once. ORCH_GUARDS=off disables it.
// Allowed only when every simple command (split on ;, &&, ||, |, & and newlines by judge-core.mjs's tokenizer) starts
// with an allowed prefix and the command has no redirection, heredoc, command or process substitution, backticks,
// variable expansion, assignment or function definition. Anything the tokenizer cannot read is denied. The one
// exception: a stderr redirection written exactly `2>/dev/null` or `2>&1`, as a word of its own, writes no file and is
// allowed (withoutStderrNull); every other redirection, `2> /dev/null` with a space included, is still refused.
// Decisions go to gates.jsonl in the state dir (gate "researcher", the first word of the offending segment only).
import { appendFileSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { tokenize } from "./judge-core.mjs";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

export const ALLOWED_PREFIXES = [
  "git log", "git ls-files", "git rev-list", "git rev-parse", "git status", "git show", "git branch --show-current",
  "git -C <dir> <one of those>", "wc", "ls", "du", "grep", "rg", "find (no -exec, -ok, -delete or -fprint)", "head", "tail (no -f)", "cat",
  "sed -n '<N>p' or '<N>,<M>p'", "cut (-b, -c, -f, -d, -s, --complement, --output-delimiter)", "stat", "echo",
  "cd <one literal path to the project folder or a folder inside it>",
];
const GIT_SUBS = new Set(["log", "ls-files", "rev-list", "rev-parse", "status", "show"]);
// Audit 2026-11-16 T-11 (approved by the owner): five more read-only forms, each held to what cannot write a file or
// start a program. stat reads metadata only (its long options from STAT_LONG); echo only prints (redirection stays
// refused); cut has no write or exec option, and only -b, -c, -f, -d, -s, --complement and --output-delimiter pass;
// sed only as `sed -n '<N>p'` or `sed -n '<N>,<M>p'` (no -i, no w, e or s///w script, no glob operand that could expand
// into an option).
const PLAIN = new Set(["wc", "ls", "du", "stat", "echo", "cut", "sed"]);
const STAT_LONG = new Set(["dereference", "file-system", "format", "printf", "terse", "cached", "help", "version"]);
const SED_FORM = "`sed` is allowed only as `sed -n '10p' <file>` or `sed -n '10,40p' <file>` (one line or one line range, no other option or script)";
const CUT_FORM = "use only -b, -c, -f, -d, -s, --complement and --output-delimiter";
const SEARCH = new Set(["grep", "egrep", "fgrep", "rg"]);
// find and bfs actions that run a program or write a file.
// `-rm` is bfs's own name for -delete.
const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|rm|fprint|fprint0|fprintf|fls)$/;
// The long options of head and tail that only choose what is printed. Anything else is refused by name, which covers
// tail's --follow and --retry and every shortened spelling GNU tail accepts for them (--fol, --f).
const PAGE_LONG = new Set(["lines", "bytes", "quiet", "silent", "verbose", "zero-terminated", "help", "version"]);
const PAGERS = new Set(["head", "tail", "cat"]);
// Audit 2026-11-16 T-5: a device path is judged after normalising it, never by its text: `/./dev/zero`, `//dev/zero`,
// `/private/../dev/zero` and a relative `../../dev/zero` (resolved against the command's folder) all name /dev/zero,
// and so does a path whose real path the system resolves to a device: a symlink to it, or a symlink to `/` followed by
// `..` (`<link>/../dev/zero`, whose text-normalised form does not exist). The commands that read their operands are
// under the rule: the search and paging commands, wc, and the narrow sed and cut forms.
const READERS = new Set(["wc", "sed", "cut"]);
// fix-researcher-cd (approved by the owner; researchers were refused `cd` more than any other command): `cd` passes only
// as a segment of its own with exactly one literal path argument (no option, `-`, `+N`, `~`, `=`, expansion, glob or
// control character), absolute or starting with `./` or `../` (bash and zsh skip CDPATH, and zsh its cdable_vars, for
// those), whose physical location from every folder the shell may be in at that point is the project folder
// (CLAUDE_PROJECT_DIR, compared by device and inode) or a folder inside it, and exists from at least one of them. Both
// the shell's logical reading (`..` removed as text) and the physical one (symlinks first) are judged, so no symlink
// and no `..` leads out. The folders a cd may leave the shell in are kept, and every later segment's relative
// operands, the device rule included, are judged from each of them (a cd in a pipe or a subshell changes nothing, so
// the folders before it stay too). Not judged: a shell function or alias named `cd`.
const CD_FORM = "`cd` is allowed only as `cd <path>` with one literal path that starts with `./`, `../` or `/` (`cd ./src`) and leads to the project folder or a folder inside it; elsewhere put absolute paths in the command itself (`grep -n foo /repo/a.txt`)";
const MAX_FOLDERS = 32;
const MAX_WORD = 4096;
// Round 2 (item A): `realpathSync.native` on a long path that reaches /dev itself through a symlink ends the process with
// SIGTRAP or SIGSEGV, or reports a false ENOENT, after a few dozen calls (Node 24.22.2, Darwin 27.2; the cause of the
// exit 133). The guard never makes that call: `resolve` walks a path with lstat and readlink, and the identity of /dev
// and /dev/null (device and inode, from stat, which showed no fault) decides what reaches a device.
const DEV_ID = statId("/dev");
const NULL_ID = statId("/dev/null");
// w3 item 1: /proc and /sys are judged like /dev. Their files can wait for ever (/proc/kmsg, a tracing pipe), and
// /proc/self is the guard's own process, not the shell's, so no answer about /proc/self/fd/N holds for the command. A
// path whose text is under one of them, or whose walk passes through the file system of one of them, is refused.
const SPECIAL_ROOTS = ["/dev", "/proc", "/sys"];
const SPECIAL_DEVS = SPECIAL_ROOTS.map(statId).flatMap((s) => (s ? [s.dev] : []));
// w3 item 1: a word with a glob is judged on what the shell can expand it to, in two readings (expand). The shell
// reading lists what bash 4.3+ and zsh expand by default (no dot names unless the segment starts with a dot, `**` not
// through a symlinked folder) and judges every match like an operand, within GLOB_ENTRIES names listed per command
// segment. The wide reading asks only whether the pattern could reach a device, FIFO, socket, /dev, /proc or /sys under
// any setting (dotglob, globstar off, zsh `***`), within WIDE_ENTRIES names; it judges each symlink, special file and
// `.`/`..` it meets. Past either bound the command is refused, with the way around it.
const GLOB_ENTRIES = 20000;
const WIDE_ENTRIES = 200000;
const TOO_MANY = "a glob that lists more names than the guard can judge (it may expand to a device or a FIFO); quote the glob so the command expands it itself (`rg x -g '*.md'`, `grep -rn x . --include='*.md'`), or name a folder";
// The lstat calls one decision may make; past it the command is refused as too complex to judge.
const WALK_BUDGET = 20000;
let walkBudget = WALK_BUDGET;
// Long options of grep, ugrep and ripgrep that only change what is searched or how matches print. Anything else is
// denied by name, which covers the ones that run a program or write a file (ugrep --filter, --pager, --view,
// --save-config, --config and ---FILE; ripgrep --pre, --hostname-bin) without listing them.
const SEARCH_LONG = new Set([
  "after-context", "before-context", "context", "count", "count-matches", "color", "colour", "colors",
  "extended-regexp", "fixed-strings", "perl-regexp", "basic-regexp", "pcre2", "regexp", "file", "engine",
  "ignore-case", "no-ignore-case", "smart-case", "case-sensitive", "invert-match", "word-regexp", "line-regexp",
  "line-number", "no-line-number", "column", "no-column", "byte-offset", "with-filename", "no-filename",
  "heading", "no-heading", "files-with-matches", "files-without-match", "only-matching", "quiet", "silent",
  "no-messages", "recursive", "dereference-recursive", "include", "exclude", "include-dir", "exclude-dir",
  "include-from", "exclude-from", "glob", "iglob", "type", "type-not", "files", "hidden", "no-hidden", "no-ignore",
  "no-ignore-vcs", "ignore-files", "follow", "no-follow", "max-count", "max-depth", "depth", "max-columns",
  "max-filesize", "binary-files", "ignore-binary", "text", "null", "null-data", "initial-tab", "label",
  "line-buffered", "multiline", "multiline-dotall", "unicode", "no-unicode", "encoding", "crlf", "trim", "passthru",
  "sort", "sortr", "stats", "json", "vimgrep", "help", "version",
]);

// What a refused researcher should do instead (gate records showed refusals with no way forward). Appended after the
// reason's first words, which stay the same so the records still group by them.
const USE_ALLOWED = "use only grep, rg, find, head, tail, cat, ls, wc, du, cut, stat, echo, `sed -n` line ranges and read-only git, and work the result out in the report";

/** @param {string} word @returns {string} */
function insteadOf(word) {
  if (word === "sed" || word === "awk") return "to print a line range use the Read tool with offset and limit, `head` and `tail`, or `sed -n '10,40p' <file>`";
  return USE_ALLOWED;
}

/**
 * Why `command` is outside the researcher's allowlist, or null when it is inside.
 * @param {string} command @param {string} [cwd] the folder the command runs in (relative paths resolve against it)
 * @param {string} [project] the project folder; without an absolute one every `cd` is refused
 * @returns {{ reason: string, word?: string } | null}
 */
export function researcherViolation(command, cwd = process.cwd(), project) {
  // fix-researcher-cd item 3: a decision for any input; whatever cannot be judged is refused, never thrown.
  walkBudget = WALK_BUDGET;
  try {
    return violation(withoutStderrNull(String(command)), String(cwd), project);
  } catch (err) {
    return { reason: `the command cannot be judged (${err instanceof Error ? err.message.slice(0, 80) : "error"})` };
  }
}

// The two stderr forms a researcher may write, each a word of its own: `2>/dev/null` and `2>&1`.
const STDERR_OK = ["2>/dev/null", "2>&1"];

/**
 * The command with each allowed stderr form blanked out, so the checks below never see it. A form counts only outside
 * quotes and comments, after an unescaped space, tab or newline and before one or the end: `2>/dev/nullx`,
 * `x;2>&1`, `a\ 2>/dev/null` and `2> /dev/null` stay and are refused. The tokenizer drops a redirection's fd number,
 * so this works on the raw text. A command with ANSI-C quoting (`$'`), whose quotes this scan does not follow, is
 * returned unchanged. Inside `$(...)` or backticks a form is blanked too, but the substitution is refused anyway.
 * @param {string} command @returns {string}
 */
function withoutStderrNull(command) {
  if (command.includes("$'")) return command;
  let out = "";
  /** @type {"" | "'" | '"' | "#"} */
  let state = "";
  let sep = false; // the previous character was an unquoted, unescaped space, tab or newline
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    const afterSep = sep;
    sep = state === "" && /[ \t\n]/.test(c);
    if (state === "'") {
      if (c === "'") state = "";
    } else if (state === '"') {
      if (c === "\\") {
        out += c + (command[i + 1] ?? "");
        i++;
        continue;
      }
      if (c === '"') state = "";
    } else if (state === "#") {
      if (c === "\n") state = "";
    } else if (c === "\\") {
      out += c + (command[i + 1] ?? "");
      i++;
      continue;
    } else if (c === "'" || c === '"') {
      state = c;
    } else if (c === "#" && (i === 0 || afterSep)) {
      state = "#";
    } else if (afterSep) {
      const form = STDERR_OK.find((f) => command.startsWith(f, i) && (i + f.length === command.length || /[ \t\n]/.test(command[i + f.length] ?? "")));
      if (form) {
        out += " ".repeat(form.length);
        i += form.length - 1;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** @param {string} command @param {string} cwd @param {string | undefined} project @returns {{ reason: string, word?: string } | null} */
function violation(command, cwd, project) {
  /** @type {any} */
  let t;
  try {
    t = tokenize(command);
  } catch (err) {
    return { reason: `the command cannot be read with confidence (${err instanceof Error ? err.message : String(err)})` };
  }
  if (t.substitutions.length) return { reason: "command or process substitution (or backticks)" };
  if (t.defines) return { reason: "a function definition" };
  // The tokenizer records no word for a heredoc or here-string, so `<<` anywhere in the raw text denies, quoted or not:
  // an escaped quote (`ls \'<<X ...`) would hide it from any quote-stripping regex.
  if (command.includes("<<")) return { reason: "a heredoc or here-string" };
  // Quoted text removed, any < or > left is a redirection.
  const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "");
  if (/[<>]/.test(unquoted)) return { reason: "output redirection or a heredoc" };
  // stdin from anything but a pipe (heredoc, here-string, `<`) denies. A pipe also sets stdin on the command after it,
  // so stdin is only proof of an input redirection on the first command or in a command with no `|` at all.
  if (t.commands.some((/** @type {any} */ c, /** @type {number} */ i) => c.stdin && (i === 0 || !command.includes("|")))) {
    return { reason: "input redirection, a heredoc or here-string" };
  }
  // The folders the shell may be in when a segment runs: where the command starts, plus each folder an allowed cd reached.
  const folders = [cwd];
  for (const c of t.commands) {
    const words = /** @type {any[]} */ (c.words);
    if (words[0]?.text === "cd") {
      const reached = cdReach(words, folders, project);
      if (!reached) return { reason: CD_FORM, word: "cd" };
      for (const f of reached) if (!folders.includes(f)) folders.push(f);
      if (folders.length > MAX_FOLDERS) return { reason: CD_FORM, word: "cd" };
      continue;
    }
    if (words.some((w) => w.redirect)) return { reason: "output redirection or a heredoc" };
    if (words.some((w) => w.assign)) return { reason: `a variable assignment; ${USE_ALLOWED}`, word: words[0]?.text };
    if (words.some((w) => w.pieces.some((/** @type {any} */ p) => p.dyn))) return { reason: "a variable or other expansion", word: words[0]?.text };
    if (words.some(globInOptionName)) {
      return {
        reason: "a glob in an option name (the shell may expand it into another option, such as -f or -delete); quote the glob (`rg -g '*.md' x`) or use the long form (`--glob=*.md`)",
        word: words[0]?.text,
      };
    }
    const w = words.map((x) => String(x.text));
    if (!allowedWords(w)) return { reason: `\`${w[0] ?? ""}\` is not an allowed command; ${insteadOf(w[0] ?? "")}`, word: w[0] };
    if (w[0] === "sed" && !sedForm(words)) return { reason: SED_FORM, word: "sed" };
    const option = optionViolation(w, folders, words);
    if (option) return { reason: option, word: w[0] };
    if (w[0] === "git" && w.some((x) => /^--output(=|$)/.test(x))) return { reason: "git --output writes a file", word: "git" };
  }
  return null;
}

/**
 * Does a glob stand in the name of an option (`-?`, `-delet[e]`, `--fil*`)? The tokenizer leaves glob characters out
 * of a word's text, so the checks on the text would see `-` and `-delet`, while the shell expands the word into any
 * option a file of that name spells. A glob in a long option's value (`--include=*.ts`) keeps the name and passes.
 * @param {any} w
 */
function globInOptionName(w) {
  let head = ""; // the literal text before the current piece
  for (const p of w.pieces) {
    if ("lit" in p) head += p.lit;
    else if ("glob" in p && head.startsWith("-") && !(head.startsWith("--") && head.includes("="))) return true;
  }
  return false;
}

/** A word with literal text only: no expansion and no glob. @param {any} w */
const literal = (w) => Array.isArray(w?.pieces) && w.pieces.every((/** @type {any} */ p) => "lit" in p);

/** Does the word hold an unquoted glob character? @param {any} w */
const hasGlob = (w) => Array.isArray(w?.pieces) && w.pieces.some((/** @type {any} */ p) => "glob" in p);

/** Names the glob expansions of this decision may still read (reset per command segment). */
let globEntries = GLOB_ENTRIES;

/**
 * The strings to judge for one word run from `folder`: its text and, for a word with a glob, every path the shell may
 * expand it to there, plus (for `--name=<glob>`) every path the value alone may name, since an unmatched word reaches
 * the command as written and the command opens the value. null past the bounds. Never throws (a failed listing names
 * nothing, as for the shell).
 * @param {any} word @param {string} text @param {string} folder @returns {string[] | null}
 */
function pathsOf(word, text, folder) {
  if (!hasGlob(word)) return [text];
  /** @type {string[]} */
  const out = [text];
  /** @type {any[][]} */
  const patterns = [word.pieces];
  const first = word.pieces[0];
  if (first && "lit" in first && first.lit.startsWith("--") && first.lit.includes("=")) {
    patterns.push([{ lit: first.lit.slice(first.lit.indexOf("=") + 1) }, ...word.pieces.slice(1)]);
  }
  for (const pat of patterns) {
    for (const wide of [false, true]) {
      const r = expand(pat, folder, wide);
      if (!r) return null;
      // A pattern that lists /dev, /proc or /sys itself is refused, /dev/null among its matches or not.
      if (r.special) return [...out, "/dev"];
      out.push(...r.paths);
    }
  }
  return out;
}

/**
 * What a glob word may expand to from `folder` (relative stays relative), null past the bound of its reading.
 * Shell reading (`wide` false): the paths bash 4.3+ and zsh list by default, all of them to be judged: no name that
 * starts with a dot unless the segment does, a segment of two or more stars alone matching across folders but never
 * through a symlinked folder (three or more: zsh `***`, through them too), and also read as `*` (globstar off).
 * Wide reading: only what must be judged under any setting (dotglob or GLOB_DOTS, globstar off, `***`): every literal
 * prefix, symlink, FIFO, socket, device, `.` and `..` met, dot names included. Both: `special` when the walk would list
 * /dev, /proc or /sys; a bracket expression matches any one or more characters (the tokenizer keeps no class text, and
 * an unmatched `[...]` names itself); names match without regard to case; `.` and `..` match only a segment that starts
 * with a literal dot, as in every shell.
 * @param {any[]} pieces @param {string} folder @param {boolean} wide the wide reading
 * @returns {{ paths: string[], special: boolean } | null}
 */
function expand(pieces, folder, wide) {
  /** @type {{ re: RegExp | null, text: string, stars: boolean, follow: boolean, dot: boolean }[]} */
  const segs = [];
  let src = "", text = "", glob = false, dot = false, fresh = true;
  const close = () => {
    // A segment of two or more stars alone (`**`) also matches across folders.
    const stars = glob && text === "" && /^(?:\.\*){2,}$/.test(src);
    const follow = glob && text === "" && /^(?:\.\*){3,}$/.test(src); // zsh `***/` follows symlinks
    segs.push({ re: glob ? new RegExp(`^${src}$`, "is") : null, text, stars, follow, dot });
    src = "";
    text = "";
    glob = false;
    dot = false;
    fresh = true;
  };
  for (const p of pieces) {
    if ("lit" in p) {
      String(p.lit).split("/").forEach((part, k) => {
        if (k > 0) close();
        if (!part) return;
        if (fresh) dot = part.startsWith(".");
        fresh = false;
        src += part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        text += part;
      });
    } else if ("glob" in p) {
      glob = true;
      fresh = false;
      src += p.glob === "*" ? ".*" : p.glob === "?" ? "." : ".+";
    } else return null; // an expansion: refused elsewhere, never judged here
  }
  close();
  const absolute = segs.length > 1 && segs[0]?.re === null && segs[0].text === "";
  const start = absolute ? "/" : folder;
  /** @type {string[]} */
  const found = [];
  const seen = new Set();
  /** @type {Map<string, { name: string, dir: boolean, link: boolean, odd: boolean }[]>} */
  const listed = new Map();
  let over = false;
  let special = false;
  let left = wide ? WIDE_ENTRIES : 0;
  /** @param {number} n */
  const spend = (n) => {
    if (wide) left -= n;
    else globEntries -= n;
    if ((wide ? left : globEntries) < 0) over = true;
    return !over;
  };
  /** @param {string} dir the folder reached @param {string} shown the text so far @param {number} i */
  const walk = (dir, shown, i) => {
    if (over || special) return;
    const key = `${dir}\0${i}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (i === segs.length) {
      if (!wide) found.push(shown); // the wide reading keeps only what it must judge (below)
      return;
    }
    const s = /** @type {(typeof segs)[number]} */ (segs[i]);
    const last = i === segs.length - 1;
    const sep = last ? "" : "/";
    const join2 = (/** @type {string} */ name) => (dir === "/" ? `/${name}` : `${dir}/${name}`);
    if (!s.re) {
      if (absolute && i === 0) return walk("/", "/", 1);
      // A literal name may be a symlink (to /dev, to /) or `..`: the wide reading judges the path so far.
      if (wide) found.push(`${shown}${s.text}`);
      return walk(join2(s.text), `${shown}${s.text}${sep}`, i + 1);
    }
    // Listing /dev, /proc or /sys (by their text) is refused outright.
    if (isDevice(posix.resolve(folder, dir)) || posix.resolve(folder, dir).toLowerCase() === "/dev") {
      special = true;
      return;
    }
    // Each folder is listed and counted once per reading, whatever segment asks for it.
    let cached = listed.get(dir);
    if (!cached) {
      cached = [];
      try {
        cached = readdirSync(dir, { withFileTypes: true }).map((e) => ({
          name: e.name,
          dir: e.isDirectory(),
          link: e.isSymbolicLink(),
          odd: e.isFIFO() || e.isSocket() || e.isCharacterDevice() || e.isBlockDevice(),
        }));
      } catch {
        cached = [];
      }
      listed.set(dir, cached);
      if (!spend(cached.length + 1)) return;
    }
    /** @type {{ name: string, dir: boolean, link: boolean, odd: boolean }[]} */
    const list = [...cached];
    if (s.dot) list.push({ name: ".", dir: true, link: false, odd: true }, { name: "..", dir: true, link: false, odd: true });
    for (const e of list) {
      if (over || special) return;
      // Shells match a leading dot only with a segment that starts with one; dotglob and GLOB_DOTS lift that, so the
      // wide reading takes every name.
      if (!wide && !s.dot && e.name.startsWith(".")) continue;
      const path = join2(e.name);
      const matched = s.stars || s.re.test(e.name);
      if (!matched) continue;
      // The wide reading judges every symlink, FIFO, socket, device, `.` and `..` it meets on the way.
      if (wide && (e.link || e.odd)) found.push(`${shown}${e.name}`);
      if (s.stars) {
        // `**`: one more folder with the same `**` still to match; never through a symlinked folder (bash 4.3+, zsh),
        // except zsh's `***`. A link is still entered one level by the `*` reading below.
        if (e.dir && e.name !== "." && e.name !== "..") walk(path, `${shown}${e.name}/`, i);
        else if (e.link && s.follow) walk(path, `${shown}${e.name}/`, i);
      }
      // A plain wildcard, and `**` read as `*` (globstar off): this name matches the segment itself. Only a folder, a
      // link or a `.`/`..` can hold what a later segment names; a file is a match only at the end.
      if (last || e.dir || e.link || e.odd) walk(path, `${shown}${e.name}${sep}`, i + 1);
    }
    if (s.stars) walk(dir, shown, i + 1); // `**` as no folder
  };
  try {
    walk(start, "", 0);
  } catch {
    return null;
  }
  return over ? null : { paths: found, special };
}

/**
 * `sed -n '<N>p'` or `sed -n '<N>,<M>p'` and file operands that are literal and not options, nothing else.
 * @param {any[]} words
 */
function sedForm(words) {
  if (words.length < 3 || !words.every(literal)) return false;
  if (words[1].text !== "-n" || !/^[0-9]+(?:,[0-9]+)?p$/.test(String(words[2].text))) return false;
  return words.slice(3).every((w) => typeof w.text === "string" && w.text !== "" && !w.text.startsWith("-"));
}

/** @param {string[]} w */
function allowedWords(w) {
  const first = w[0] ?? "";
  if (PLAIN.has(first) || SEARCH.has(first) || PAGERS.has(first) || first === "find") return true;
  if (first !== "git") return false;
  const rest = w[1] === "-C" && w.length >= 4 ? w.slice(3) : w.slice(1);
  if (GIT_SUBS.has(rest[0] ?? "")) return true;
  return rest.length === 2 && rest[0] === "branch" && rest[1] === "--show-current";
}

/**
 * Why an allowed search or paging command is still refused (an option that runs a program, writes a file or never
 * ends), or null. Every word is checked, wherever it stands: a lone `--` is not trusted to end the options, because
 * it can be the value of one (`rg -e -- --pre=sh x` reads `--` as the pattern and `--pre` as an option). So a word
 * that only looks like an option, such as a pattern that starts with a dash, is refused too; that is the price.
 * Not covered: a command that waits on standard input because it was given no file. The Bash tool's timeout ends it.
 * @param {string[]} w @param {string[]} folders the folders the command may run in @param {any[]} [words] the tokenizer's
 * words of `w` (glob pieces included) @returns {string | null}
 */
function optionViolation(w, folders, words = []) {
  const first = w[0] ?? "";
  const args = w.slice(1);
  globEntries = GLOB_ENTRIES;
  /**
   * The word at args[i] reads a device (glob expansions included), "many" past the glob bounds, else null.
   * @param {number} i @returns {string | null}
   */
  const deviceAt = (i) => {
    for (const f of folders) {
      const list = pathsOf(words[i + 1], args[i] ?? "", f);
      if (!list) return "many";
      // Each path gets the whole lstat budget: the listing bound already limits how many there are.
      const hit = list.find((a) => ((walkBudget = WALK_BUDGET), readsDevice(a, f)));
      if (hit !== undefined) return hit;
    }
    return null;
  };
  // w3 item 1: GNU find's and du's -files0-from / --files0-from read the file they name (to the end, which a device
  // or FIFO may never reach), so that value is judged like an operand; du's long option in any shortened spelling.
  /** @param {(a: string) => boolean} isOpt @param {boolean} joined `--name=value` allowed */
  const filesFrom = (isOpt, joined) => {
    for (let i = 0; i < args.length; i++) {
      const a = args[i] ?? "";
      const name = a.split("=")[0] ?? "";
      if (!isOpt(name)) continue;
      const at = joined && a.includes("=") ? i : i + 1;
      const hit = at < args.length ? deviceAt(at) : null;
      if (hit === "many") return TOO_MANY;
      if (hit !== null) return `${first} ${hit} reads a device that may never end`;
    }
    return null;
  };
  if (first === "find") {
    const action = args.find((x) => FIND_ACTIONS.test(x));
    if (action) return `find ${action} runs a program or writes a file`;
    return filesFrom((n) => n === "-files0-from", false);
  }
  if (first === "du") return filesFrom((n) => n.length > 3 && n.startsWith("--f") && "--files0-from".startsWith(n), true);
  if (first === "stat") {
    // stat reads metadata only; its long options still pass by name only (and a lone `--` is not one of them).
    const bad = args.find((a) => a.startsWith("--") && !STAT_LONG.has(a.slice(2).split("=")[0] ?? ""));
    return bad ? `stat --${bad.slice(2).split("=")[0]} is not an allowed option (it may run a program, write a file or never end)` : null;
  }
  if (!SEARCH.has(first) && !PAGERS.has(first) && !READERS.has(first)) return null;
  // A device that never ends (/dev/zero, /dev/urandom) would keep cat, head, tail, wc or a search reading for ever,
  // also as an option's value (`--file=/dev/zero`, `-f/dev/zero`). /dev/null is allowed in each of those places.
  // A word longer than any path the system opens is not judged suffix by suffix (that took minutes for a word of a few
  // hundred thousand characters, past the hook's timeout); it is refused.
  if (args.some((a) => a.length > MAX_WORD)) return `${first}: a word longer than ${MAX_WORD} characters is too long to judge`;
  // For grep and rg `.` too: with no path they search the folder they run in (round 2, item C: so in /dev or below it
  // every search is refused, also one with a path elsewhere, since a pattern and a path cannot be told apart).
  const device = [...args, ...(SEARCH.has(first) ? ["."] : [])].find((a) => folders.some((f) => readsDevice(a, f)));
  if (device) return `${first} ${device} reads a device that may never end`;
  // w3 item 1: a word with a glob, judged on each path the shell may expand it to (the check above saw its text only).
  for (let i = 0; i < args.length; i++) {
    if (!hasGlob(words[i + 1])) continue;
    const hit = deviceAt(i);
    if (hit === "many") return `${first}: ${TOO_MANY}`;
    if (hit !== null) return `${first} ${hit} reads a device that may never end`;
  }
  if (first === "cut") return cutViolation(args);
  if (!SEARCH.has(first) && !PAGERS.has(first)) return null;
  for (const a of args) {
    if (a.startsWith("--")) {
      if (a === "--") continue;
      const name = a.slice(2).split("=")[0] ?? "";
      if (!(SEARCH.has(first) ? SEARCH_LONG : PAGE_LONG).has(name)) return `${first} --${name} is not an allowed option (it may run a program, write a file or never end)`;
    } else if (a.length > 1 && a.startsWith("-")) {
      // Short options, also inside a group or with a value attached (-5f, -nz): refused by letter.
      if (first === "tail" && /[fF]/.test(a)) return `tail ${a} follows the file and never ends`;
      if (first === "rg" && a.includes("z")) return `rg ${a}: -z starts decompression programs`;
      if (first !== "rg" && SEARCH.has(first) && a.includes("Q")) return `${first} ${a}: -Q opens an interactive screen`;
    }
  }
  return null;
}

/**
 * Why a cut command is refused, or null: only -b, -c, -f, -d (each with its value attached or as the next word), -s,
 * --complement and --output-delimiter (with `=` or the next word). Every other word that starts with a dash is refused,
 * a lone `--` included, so it never ends the check.
 * @param {string[]} args @returns {string | null}
 */
function cutViolation(args) {
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--complement" || a.startsWith("--output-delimiter=")) continue;
    if (a === "--output-delimiter") {
      i++;
      continue;
    }
    if (a.startsWith("--")) return `cut ${a.split("=")[0]} is not an allowed option; ${CUT_FORM}`;
    if (a.length < 2 || !a.startsWith("-")) continue; // a file operand, or `-` for standard input
    for (let j = 1; j < a.length; j++) {
      const ch = a[j] ?? "";
      if (ch === "s") continue;
      if (!"bcfd".includes(ch)) return `cut -${ch} is not an allowed option; ${CUT_FORM}`;
      if (j === a.length - 1) i++; // the value is the next word
      break;
    }
  }
  return null;
}

/**
 * Does an argument name a device other than /dev/null: as a whole word, as a long option's value (`--file=/dev/zero`)
 * or attached to short options (`-f/dev/zero`, `-rf../dev/zero`)? Each candidate path, a bare word included (round 2,
 * item C), is judged on its text resolved against `cwd` (`.`, `..` and repeated slashes collapsed: a path that is /dev
 * or under it, other than /dev/null, is refused, whatever the system says, since /dev/fd and /dev/stdin differ between
 * this process and the shell), and by `judged` on that normalised path and on the string as written (joined to `cwd`
 * when relative): the system follows a symlink before it applies the `..` after it, so `<link to />/../dev/zero` is
 * /dev/zero although its text-normalised form names a file that does not exist.
 * @param {string} arg @param {string} cwd
 */
function readsDevice(arg, cwd) {
  const candidates = [arg];
  const long = /^--[^=]+=(.*)$/.exec(arg);
  if (long) candidates.push(long[1] ?? "");
  // A value joined to a short-option cluster may start after any of its letters (`-rfdev/zero` is -r, then -f with
  // `dev/zero`), so every suffix after the first letter is a candidate, with or without a leading `=`.
  if (arg.startsWith("-") && !arg.startsWith("--")) {
    for (let j = 2; j < arg.length; j++) {
      const rest = arg.slice(j);
      candidates.push(rest.startsWith("=") ? rest.slice(1) : rest);
    }
  }
  return candidates.some((p) => {
    if (!p) return false;
    const normalised = posix.resolve(cwd, p);
    if (isDevice(normalised)) return true;
    return [normalised, p.startsWith("/") ? p : `${cwd}/${p}`].some((q) => judged(q) === "device");
  });
}

/**
 * What the system says about the absolute path `q`, asked only with lstat, readlink and stat: "device" when it reaches
 * a device, FIFO or socket other than /dev/null, or passes through /dev's file system on the way to anything but
 * /dev/null, or when two answers disagree (one says it exists, the other that it is missing), or when the walk is over
 * budget; "missing" when neither finds it; else its physical path (symlinks followed, `..` applied after them).
 * @param {string} q @returns {string}
 */
function judged(q) {
  const walked = resolve(q);
  /** @type {import("node:fs").Stats | null} */
  let st = null;
  try {
    st = statSync(q);
  } catch {
    // missing or unreachable: compared with the walk below
  }
  if (walked === "device" || walked === "budget") return "device";
  const found = walked !== "missing" && walked !== "unknown";
  if (found !== (st !== null)) return "device";
  if (!st) return "missing";
  if (sameId(st, NULL_ID)) return walked;
  if (st.isCharacterDevice() || st.isBlockDevice() || st.isFIFO() || st.isSocket()) return "device";
  if (specialDev(st.dev)) return "device";
  return isDevice(walked) ? "device" : walked;
}

/**
 * The physical path of the absolute path `p`, walked one name at a time with lstat and readlink, the way the kernel
 * reads it: a symlink is followed before the `..` after it. "missing" when a name does not exist or a non-folder has
 * names after it, "unknown" for a loop (over 40 links) or any other error, "device" when the walk passes through /dev's
 * file system and does not end at /dev/null (also when a later name is missing: `<link to /dev>/fd/63` names a
 * descriptor this process lacks but the command's shell may hold), "budget" past the lstat budget of this decision.
 * @param {string} p @returns {string}
 */
function resolve(p) {
  let rest = p.split("/").filter((x) => x !== "");
  const wantsFolder = p.endsWith("/") || p.endsWith("/.") || p.endsWith("/..");
  let cur = "/";
  let links = 0;
  let throughDev = false;
  /** @type {import("node:fs").Stats | null} */
  let last = null;
  while (rest.length) {
    const name = /** @type {string} */ (rest.shift());
    if (name === ".") continue;
    if (name === "..") {
      cur = posix.dirname(cur);
      continue;
    }
    const next = cur === "/" ? `/${name}` : `${cur}/${name}`;
    if (--walkBudget < 0) return "budget";
    /** @type {import("node:fs").Stats} */
    let st;
    try {
      st = lstatSync(next);
    } catch (err) {
      const code = /** @type {any} */ (err)?.code;
      if (throughDev) return "device";
      return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
    }
    if (st.isSymbolicLink()) {
      if (++links > 40) return "unknown";
      let target;
      try {
        target = readlinkSync(next);
      } catch {
        return "unknown";
      }
      if (target.startsWith("/")) cur = "/";
      rest = [...target.split("/").filter((x) => x !== ""), ...rest];
      continue;
    }
    if (specialDev(st.dev)) throughDev = true;
    if (rest.length && !st.isDirectory()) return throughDev ? "device" : "missing";
    cur = next;
    last = st;
  }
  if (wantsFolder && last && !last.isDirectory()) return throughDev ? "device" : "missing";
  if (last && sameId(last, NULL_ID)) return cur;
  if (throughDev) return "device";
  return cur;
}

/** @param {string} p @returns {{ dev: number, ino: number } | null} */
function statId(p) {
  try {
    const s = statSync(p);
    return { dev: s.dev, ino: s.ino };
  } catch {
    return null;
  }
}

/** @param {{ dev: number, ino: number }} s @param {{ dev: number, ino: number } | null} id */
function sameId(s, id) {
  return id !== null && s.dev === id.dev && s.ino === id.ino;
}

/**
 * The folders a `cd` segment may leave the shell in, or null when it is refused (see CD_FORM).
 * @param {any[]} words @param {string[]} folders @param {string | undefined} project @returns {string[] | null}
 */
function cdReach(words, folders, project) {
  if (typeof project !== "string" || !project.startsWith("/")) return null;
  const root = judged(project);
  const rootId = statId(project);
  if (!root.startsWith("/") || !rootId) return null;
  if (words.length !== 2 || !words.every(literal) || words.some((w) => w.redirect || w.assign)) return null;
  const target = String(words[1].text);
  if (!target || target.length > 1024 || /^[-+~=]/.test(target) || /[\x00-\x1f\x7f]/.test(target)) return null;
  // A relative path starts with `.` or `..` as its first name, so neither shell looks it up in CDPATH.
  const first = target.split("/")[0];
  if (!target.startsWith("/") && first !== "." && first !== "..") return null;
  /** @type {string[]} */
  const reached = [];
  for (const f of folders) {
    const logical = posix.resolve(f, target);
    for (const q of [logical, target.startsWith("/") ? target : `${f}/${target}`]) {
      const r = judged(q);
      if (r === "missing") continue; // no such folder from here: a cd there fails and leaves the shell where it was
      if (!r.startsWith("/") || isDevice(r) || !insideId(r, rootId)) return null;
      if (!isFolder(r)) continue;
      reached.push(r);
      if (q === logical) reached.push(logical); // the shell's $PWD after a logical cd
    }
  }
  return reached.length ? [...new Set(reached)] : null;
}

/**
 * Is the physical path `r` the folder with identity `rootId` or inside it? Compared by device and inode up the parents,
 * so a different spelling of the project folder (case, a symlinked parent) does not matter.
 * @param {string} r @param {{ dev: number, ino: number }} rootId
 */
function insideId(r, rootId) {
  for (let d = r; ; d = posix.dirname(d)) {
    try {
      if (sameId(statSync(d), rootId)) return true;
    } catch {
      return false;
    }
    if (d === "/") return false;
  }
}

/** @param {string} p */
function isFolder(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Is `x` /dev, /proc or /sys itself or under one of them, other than /dev/null (case-folded: /DEV is /dev on a
 * case-insensitive disk)? @param {string} x
 */
function isDevice(x) {
  const l = x.toLowerCase();
  return l !== "/dev/null" && SPECIAL_ROOTS.some((r) => l === r || l.startsWith(`${r}/`));
}

/** Is a file system identity that of /dev, /proc or /sys? @param {number} dev */
const specialDev = (dev) => SPECIAL_DEVS.includes(dev);

/**
 * Run as a hook only when executed directly (the tests import researcherViolation): the real paths of the entry script
 * and of this module are compared, not the name (fix-researcher-cd item 3: a script whose own name ended in
 * researcher-guard.mjs ran the hook block when it imported the guard, and the block ended that process mid-import).
 */
function isEntry() {
  try {
    return typeof process.argv[1] === "string" && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) {
  if ((process.env.ORCH_GUARDS ?? "").trim().toLowerCase() === "off") process.exit(0);
  if (duplicate("researcher-guard.mjs")) process.exit(0);
  /** @type {any} */
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  const type = typeof input?.agent_type === "string" ? input.agent_type.replace(/^orchestration:/, "") : "";
  const command = input?.tool_input?.command;
  if (type !== "researcher" || (input.tool_name !== undefined && input.tool_name !== "Bash") || typeof command !== "string" || !command.trim()) process.exit(0);
  // From here on an unexpected error refuses the command (exit 2), never another exit code.
  process.on("uncaughtException", () => process.exit(2));
  // Relative paths resolve against the folder the command runs in: the payload's cwd, else the project folder.
  // The project folder bounds `cd`; without an absolute CLAUDE_PROJECT_DIR every cd is refused.
  const project = process.env.CLAUDE_PROJECT_DIR;
  const v = researcherViolation(command, typeof input.cwd === "string" && input.cwd.startsWith("/") ? input.cwd : project || process.cwd(), project?.startsWith("/") ? project : undefined);
  if (!v) process.exit(0);
  try {
    ensureStateDir();
    const rec = { ts: new Date().toISOString(), gate: "researcher", decision: "deny", reason: v.reason.slice(0, 120), word: (v.word ?? "").slice(0, 40), session_id: input.session_id, agent_id: input.agent_id };
    appendFileSync(join(stateDir, "gates.jsonl"), `${JSON.stringify(rec)}\n`);
  } catch {
    // A failed log write never changes the decision.
  }
  process.stderr.write(`orchestration researcher guard denied this command: ${v.reason}. The researcher may run only commands starting with: ${ALLOWED_PREFIXES.join(", ")}; with no redirection, heredoc, substitution, variable or assignment.\n`);
  process.exit(2);
}
