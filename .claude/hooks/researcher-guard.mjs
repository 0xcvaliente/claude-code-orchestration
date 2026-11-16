#!/usr/bin/env node
// PreToolUse hook (matcher Bash): holds the researcher to its read-only Bash allowlist. The researcher's tools line
// allows only git log/ls-files/rev-list/rev-parse/status/show, git branch --show-current (each also as git -C <dir> ...),
// wc, ls and du, (1.2.0) read-only search and paging: grep, rg, find, head, tail and cat, and (audit 2026-11-16 T-11)
// `cd <one literal path>`, `sed -n '<N>p'`/`'<N>,<M>p'`, cut, stat and echo in narrow forms. A researcher once wrote a
// file with a heredoc and ran python3 regardless (docs/research-2026-10-31.md, section 6.5). This hook enforces the same
// list on every segment of the command.
// Why search runs through Bash: on macOS and Linux Claude Code leaves the Grep and Glob tools out of an agent whose
// tools list also names Bash, and `grep` and `find` in its shell are embedded ugrep and bfs (docs: tools reference,
// "Glob tool behavior"). Without them the researcher could only Read whole files (docs/research-2026-11-10.md). Each is
// held to forms that cannot write a file or start a program: `find` without its exec, ok, delete and fprint actions,
// `grep` and `rg` with long options from SEARCH_LONG only (so no --filter, --pager, --pre or config file) and
// without rg -z or grep -Q, `tail` without follow in any spelling, and none of them (nor wc) on a /dev/ device other
// than /dev/null (also as an option's value; judged on the normalised and resolved path, not its text); no command may hold a glob in an option's name (`tail -?`, `find . -delet[e]`). A lone `--`
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
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { join, posix } from "node:path";
import { tokenize } from "./judge-core.mjs";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

export const ALLOWED_PREFIXES = [
  "git log", "git ls-files", "git rev-list", "git rev-parse", "git status", "git show", "git branch --show-current",
  "git -C <dir> <one of those>", "wc", "ls", "du", "grep", "rg", "find (no -exec, -ok, -delete or -fprint)", "head", "tail (no -f)", "cat",
  "cd <one literal path>", "sed -n '<N>p' or '<N>,<M>p'", "cut (-b, -c, -f, -d, -s, --complement, --output-delimiter)", "stat", "echo",
];
const GIT_SUBS = new Set(["log", "ls-files", "rev-list", "rev-parse", "status", "show"]);
// Audit 2026-11-16 T-11 (approved by the owner): five more read-only forms, each held to what cannot write a file or
// start a program. stat reads metadata only (its long options from STAT_LONG); echo only prints (redirection stays
// refused); cut has no write or exec option, and only -b, -c, -f, -d, -s, --complement and --output-delimiter pass;
// sed only as `sed -n '<N>p'` or `sed -n '<N>,<M>p'` (no -i, no w, e or s///w script, no glob operand that could expand
// into an option); cd only with one literal path as a command of its own, never into /dev, and later segments' relative
// paths are judged from each folder the cd may have reached.
const PLAIN = new Set(["wc", "ls", "du", "stat", "echo", "cut", "sed"]);
const STAT_LONG = new Set(["dereference", "file-system", "format", "printf", "terse", "cached", "help", "version"]);
const CD_FORM = "`cd` is allowed only with one literal path and nothing else, as a command of its own (`cd /repo && git log -1`)";
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
// and so does a symlink to it (its real path, when it exists). The commands that read their operands are under the
// rule: the search and paging commands, wc, and the narrow sed and cut forms.
const READERS = new Set(["wc", "sed", "cut"]);
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
  if (word === "cd") return "put absolute paths in the command itself (`grep -n foo /repo/a.txt`, `git -C /repo log`)";
  if (word === "sed" || word === "awk") return "to print a line range use the Read tool with offset and limit, `head` and `tail`, or `sed -n '10,40p' <file>`";
  return USE_ALLOWED;
}

/**
 * Why `command` is outside the researcher's allowlist, or null when it is inside.
 * @param {string} command @param {string} [cwd] the folder the command runs in (relative paths resolve against it)
 * @returns {{ reason: string, word?: string } | null}
 */
export function researcherViolation(command, cwd = process.cwd()) {
  return violation(withoutStderrNull(command), cwd);
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

/** @param {string} command @param {string} cwd @returns {{ reason: string, word?: string } | null} */
function violation(command, cwd) {
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
  // The folders a segment may run in: the given one, and each a `cd` before it may have reached (a cd may fail).
  let cwds = [cwd];
  for (const c of t.commands) {
    const words = /** @type {any[]} */ (c.words);
    if (words.some((w) => w.redirect)) return { reason: "output redirection or a heredoc" };
    if (words.some((w) => w.assign)) return { reason: `a variable assignment; ${USE_ALLOWED}`, word: words[0]?.text };
    if (words[0]?.text === "cd") {
      const target = cdTarget(words);
      if (target === null) return { reason: CD_FORM, word: "cd" };
      const reached = target.startsWith("/") ? [posix.resolve(target)] : [...cwds.map((d) => posix.resolve(d, target)), ...(/^\.\.?\//.test(target) ? [] : [posix.resolve("/", target)])];
      if (reached.some(inDev)) return { reason: `cd ${target} enters /dev, whose devices may never end`, word: "cd" };
      cwds = [...new Set([...cwds, ...reached])];
      continue;
    }
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
    const option = optionViolation(w, cwds);
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

/**
 * The path of a `cd` in its one allowed form, or null: exactly one literal argument, not an option (`-`, `-P`), not
 * `~`, and no `..` inside a relative path that CDPATH could resolve elsewhere (`x/../../dev`).
 * @param {any[]} words @returns {string | null}
 */
function cdTarget(words) {
  if (words.length !== 2 || !literal(words[0]) || !literal(words[1])) return null;
  const p = String(words[1].text);
  if (!p || p.startsWith("-") || p.startsWith("~")) return null;
  if (!/^(?:\/|\.\.?\/|\.\.?$)/.test(p) && p.split("/").includes("..")) return null;
  return p;
}

/** Is a folder /dev or under it, by its normalised path or, when it exists, its real path? @param {string} dir */
function inDev(dir) {
  const paths = [dir];
  try {
    paths.push(realpathSync(dir));
  } catch {
    // no such folder: the lexical path decides
  }
  return paths.some((x) => x === "/dev" || x.startsWith("/dev/"));
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
 * @param {string[]} w @param {string[]} cwds the folders the command may run in @returns {string | null}
 */
function optionViolation(w, cwds) {
  const first = w[0] ?? "";
  const args = w.slice(1);
  if (first === "find") {
    const action = args.find((x) => FIND_ACTIONS.test(x));
    return action ? `find ${action} runs a program or writes a file` : null;
  }
  if (first === "stat") {
    // stat reads metadata only; its long options still pass by name only (and a lone `--` is not one of them).
    const bad = args.find((a) => a.startsWith("--") && !STAT_LONG.has(a.slice(2).split("=")[0] ?? ""));
    return bad ? `stat --${bad.slice(2).split("=")[0]} is not an allowed option (it may run a program, write a file or never end)` : null;
  }
  if (!SEARCH.has(first) && !PAGERS.has(first) && !READERS.has(first)) return null;
  // A device that never ends (/dev/zero, /dev/urandom) would keep cat, head, tail, wc or a search reading for ever,
  // also as an option's value (`--file=/dev/zero`, `-f/dev/zero`). /dev/null is allowed in each of those places.
  const device = args.find((a) => cwds.some((d) => readsDevice(a, d)));
  if (device) return `${first} ${device} reads a device that may never end`;
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
 * or attached to short options (`-f/dev/zero`, `-rf../dev/zero`)? Each candidate path is resolved against `cwd`
 * (which normalises `.`, `..` and repeated slashes) and, when it exists, through its symlinks.
 * @param {string} arg @param {string} cwd
 */
function readsDevice(arg, cwd) {
  const candidates = [arg];
  const long = /^--[^=]+=(.*)$/.exec(arg);
  if (long) candidates.push(long[1] ?? "");
  const short = /^-[A-Za-z0-9]+=?(.*)$/.exec(arg);
  if (short && !arg.startsWith("--")) candidates.push(short[1] ?? "");
  return candidates.some((p) => {
    if (!p) return false;
    const paths = [posix.resolve(cwd, p)];
    try {
      paths.push(realpathSync(paths[0] ?? p));
    } catch {
      // no such file: the lexical path decides
    }
    return paths.some((x) => x.startsWith("/dev/") && x !== "/dev/null");
  });
}

// Run as a hook only when executed directly (the tests import researcherViolation).
if (process.argv[1]?.endsWith("researcher-guard.mjs")) {
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
  const v = researcherViolation(command, typeof input.cwd === "string" && input.cwd.startsWith("/") ? input.cwd : process.cwd());
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
