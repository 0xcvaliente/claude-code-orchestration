#!/usr/bin/env node
// PreToolUse hook (matcher Bash): holds the researcher to its read-only Bash allowlist. The researcher's tools line
// allows only git log/ls-files/rev-list/rev-parse/status/show, git branch --show-current (each also as git -C <dir> ...),
// wc, ls and du, and (1.2.0) read-only search and paging: grep, rg, find, head, tail and cat. A researcher once wrote a
// file with a heredoc and ran python3 regardless (docs/research-2026-10-31.md, section 6.5). This hook enforces the same
// list on every segment of the command.
// Why search runs through Bash: on macOS and Linux Claude Code leaves the Grep and Glob tools out of an agent whose
// tools list also names Bash, and `grep` and `find` in its shell are embedded ugrep and bfs (docs: tools reference,
// "Glob tool behavior"). Without them the researcher could only Read whole files (docs/research-2026-11-10.md). Each is
// held to forms that cannot write a file or start a program: `find` without its exec, ok, delete and fprint actions,
// `grep` and `rg` with long options from SEARCH_LONG only (so no --filter, --pager, --pre or config file) and
// without rg -z or grep -Q, `tail` without follow in any spelling, and none of them on a /dev/ device. A lone `--`
// never ends the check (review of 2026-11-10: `rg -e -- --pre=sh x` used it to hide an option).
// Deny-only: exit 2 with the reason on stderr, or exit 0 with no output (the session's own permission rules then
// decide). It never prints an allow or ask decision. Acts only when the bare agent_type is `researcher`; any other
// agent, the main thread and malformed input exit 0 at once. ORCH_GUARDS=off disables it.
// Allowed only when every simple command (split on ;, &&, ||, |, & and newlines by judge-core.mjs's tokenizer) starts
// with an allowed prefix and the command has no redirection, heredoc, command or process substitution, backticks,
// variable expansion, assignment or function definition. Anything the tokenizer cannot read is denied.
// Decisions go to gates.jsonl in the state dir (gate "researcher", the first word of the offending segment only).
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenize } from "./judge-core.mjs";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

export const ALLOWED_PREFIXES = [
  "git log", "git ls-files", "git rev-list", "git rev-parse", "git status", "git show", "git branch --show-current",
  "git -C <dir> <one of those>", "wc", "ls", "du", "grep", "rg", "find (no -exec, -ok, -delete or -fprint)", "head", "tail (no -f)", "cat",
];
const GIT_SUBS = new Set(["log", "ls-files", "rev-list", "rev-parse", "status", "show"]);
const PLAIN = new Set(["wc", "ls", "du"]);
const SEARCH = new Set(["grep", "egrep", "fgrep", "rg"]);
// find and bfs actions that run a program or write a file.
// `-rm` is bfs's own name for -delete.
const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|rm|fprint|fprint0|fprintf|fls)$/;
// The long options of head and tail that only choose what is printed. Anything else is refused by name, which covers
// tail's --follow and --retry and every shortened spelling GNU tail accepts for them (--fol, --f).
const PAGE_LONG = new Set(["lines", "bytes", "quiet", "silent", "verbose", "zero-terminated", "help", "version"]);
const PAGERS = new Set(["head", "tail", "cat"]);
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

/**
 * Why `command` is outside the researcher's allowlist, or null when it is inside.
 * @param {string} command @returns {{ reason: string, word?: string } | null}
 */
export function researcherViolation(command) {
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
  for (const c of t.commands) {
    const words = /** @type {any[]} */ (c.words);
    if (words.some((w) => w.redirect)) return { reason: "output redirection or a heredoc" };
    if (words.some((w) => w.assign)) return { reason: "a variable assignment", word: words[0]?.text };
    if (words.some((w) => w.pieces.some((/** @type {any} */ p) => p.dyn))) return { reason: "a variable or other expansion", word: words[0]?.text };
    const w = words.map((x) => String(x.text));
    if (!allowedWords(w)) return { reason: `\`${w[0] ?? ""}\` is not an allowed command`, word: w[0] };
    const option = optionViolation(w);
    if (option) return { reason: option, word: w[0] };
    if (w[0] === "git" && w.some((x) => /^--output(=|$)/.test(x))) return { reason: "git --output writes a file", word: "git" };
  }
  return null;
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
 * @param {string[]} w @returns {string | null}
 */
function optionViolation(w) {
  const first = w[0] ?? "";
  const args = w.slice(1);
  if (first === "find") {
    const action = args.find((x) => FIND_ACTIONS.test(x));
    return action ? `find ${action} runs a program or writes a file` : null;
  }
  if (!SEARCH.has(first) && !PAGERS.has(first)) return null;
  // A device that never ends (/dev/zero, /dev/urandom) would keep cat, head, tail or a search reading for ever.
  const device = args.find((a) => /^\/dev\//.test(a) && a !== "/dev/null");
  if (device) return `${first} ${device} reads a device that may never end`;
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
  const v = researcherViolation(command);
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
