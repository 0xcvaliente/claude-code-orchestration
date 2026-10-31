#!/usr/bin/env node
// PreToolUse hook (matcher Bash): holds the researcher to its read-only Bash allowlist. The researcher's tools line
// allows only git log/ls-files/rev-list/rev-parse/status/show, git branch --show-current (each also as git -C <dir> ...),
// wc, ls and du; a researcher once wrote a file with a heredoc and ran python3 regardless (docs/research-2026-10-31.md,
// section 6.5). This hook enforces the same list on every segment of the command.
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
  "git -C <dir> <one of those>", "wc", "ls", "du",
];
const GIT_SUBS = new Set(["log", "ls-files", "rev-list", "rev-parse", "status", "show"]);

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
  // Quoted text removed, any < or > left is a redirection or a heredoc (the tokenizer records no word for a heredoc).
  const unquoted = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "");
  if (/[<>]/.test(unquoted)) return { reason: "output redirection or a heredoc" };
  for (const c of t.commands) {
    const words = /** @type {any[]} */ (c.words);
    if (words.some((w) => w.redirect)) return { reason: "output redirection or a heredoc" };
    if (words.some((w) => w.assign)) return { reason: "a variable assignment", word: words[0]?.text };
    if (words.some((w) => w.pieces.some((/** @type {any} */ p) => p.dyn))) return { reason: "a variable or other expansion", word: words[0]?.text };
    const w = words.map((x) => String(x.text));
    if (!allowedWords(w)) return { reason: `\`${w[0] ?? ""}\` is not an allowed command`, word: w[0] };
    if (w[0] === "git" && w.some((x) => /^--output(=|$)/.test(x))) return { reason: "git --output writes a file", word: "git" };
  }
  return null;
}

/** @param {string[]} w */
function allowedWords(w) {
  const first = w[0] ?? "";
  if (["wc", "ls", "du"].includes(first)) return true;
  if (first !== "git") return false;
  const rest = w[1] === "-C" && w.length >= 4 ? w.slice(3) : w.slice(1);
  if (GIT_SUBS.has(rest[0] ?? "")) return true;
  return rest.length === 2 && rest[0] === "branch" && rest[1] === "--show-current";
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
