#!/usr/bin/env node
// PreToolUse hook (matcher Bash): the native Bash judge. Opt-in: it does nothing unless ORCH_JUDGE=native.
// Deny-only: it never prints an allow or ask decision, so it cannot loosen any permission rule or mode; it can only
// refuse. Exit 2 with the reason on stderr denies the command; exit 0 with no output leaves it to the session's own
// permission rules.
// - Floor (judge-core.mjs `decide`): sudo/su family, catastrophic or non-plain recursive rm, and any command the
//   tokenizer cannot read are denied with no model call.
// - Judged commands (git push, remote changes and alias/config routes to them, a plain `rm -r <paths>`): one call to
//   `claude -p` (opus, one turn, no tools, no user settings or plugins, from an empty temp dir) with the user's typed
//   requests of this session (prompts.jsonl, written by prompt-capture.mjs) as the only authority. Approve: exit 0.
//   Anything else (a refusal, a timeout, a missing CLI, an unreadable answer, no recorded request): deny.
// - The record of those requests (state.mjs `promptStore`) is a per-user folder outside the project; a prompts.jsonl
//   in the project's state dir is never read. A Bash command that names the record's folder is denied with no model
//   call (audit 2026-11-16 J-12). A text check: a glob or a name built at run time gets past it, and the Write and Edit
//   tools never reach this hook. Best-effort, not a sandbox.
// - Malformed hook input: exit 0, no decision. Every floor or judged decision goes to gates.jsonl in the state dir.
// Settings: ORCH_JUDGE_CLAUDE_BIN (the claude binary, default `claude`), ORCH_JUDGE_MODEL (default opus),
// ORCH_JUDGE_TIMEOUT_MS (default 40000, clamped to 45000 so the hook always decides before Claude Code kills it).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_REQUEST_REASON, checkRmTargets, decide, judgeTimeoutMs, nativePrompt, parseCliOutput, tokenize } from "./judge-core.mjs";
import { PROMPT_STORE_NAME, duplicate, ensureStateDir, promptStore, stateDir } from "./state.mjs";

if ((process.env.ORCH_JUDGE ?? "").trim().toLowerCase() !== "native") process.exit(0);
if (process.env.ORCH_JUDGE_INNER === "1") process.exit(0); // the judge's own claude -p run
if (duplicate("judge-hook.mjs")) process.exit(0); // the project's own copy judges this command

// Never above 45 s: Claude Code kills a hook at its timeout (60 s by default) and the command then runs.
const timeoutMs = judgeTimeoutMs(process.env.ORCH_JUDGE_TIMEOUT_MS);

/** @type {any} */
let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  input = undefined;
}
const sessionId = typeof input?.session_id === "string" ? input.session_id : undefined;
const agentId = typeof input?.agent_id === "string" && input.agent_id ? input.agent_id : undefined;
const command = input?.tool_input?.command;

/** @param {"allow" | "deny" | "skip"} decision @param {string} reason @param {string} [cmd] */
function log(decision, reason, cmd) {
  try {
    ensureStateDir();
    const rec = { ts: new Date().toISOString(), gate: "judge", decision, reason, command: (cmd ?? "").slice(0, 200), session_id: sessionId, ...(agentId && { agent_id: agentId }) };
    appendFileSync(join(stateDir, "gates.jsonl"), `${JSON.stringify(rec)}\n`);
  } catch {
    // A failed log write never changes the decision.
  }
}

/** @param {string} reason @returns {never} */
function deny(reason) {
  log("deny", reason, command);
  process.stderr.write(`orchestration judge denied this command: ${reason}\n`);
  process.exit(2);
}

if (typeof input !== "object" || input === null || (input.tool_name !== undefined && input.tool_name !== "Bash") || typeof command !== "string" || !command.trim()) {
  log("skip", "malformed or non-Bash hook input: no decision");
  process.exit(0);
}

// The judge's authority must stay out of the judged worker's reach: a command that names the record's folder (its
// absolute path, `~/...`, `$HOME/...`, or the bare folder name, all of which hold the name) is refused, even one that
// only reads. Case is ignored (a case-insensitive file system). What it looks at, any hit refuses:
// - the raw text with quotes and backslashes dropped, so `judge'-'prompts` and `judge\-prompts` count, also where the
//   tokenizer cannot read the line;
// - each word as the judge's tokenizer decodes it (`tokenize` in judge-core.mjs), in every command of the line and of
//   the `$(...)`, backtick and process substitutions it records (up to 8 deep): each run of literal text in a word,
//   with its quoting removed and `$'...'` escapes decoded, so `judge-$'prompts'`, `judge-$"prompts"` and
//   `$'judge\x2dprompts'` count. A run ends at an expansion or a glob character.
// - the decoded words read again as command text, whichever command would run them (`bash -c`, `sh -c`, `zsh -c`,
//   `eval`, or none), up to DECODE_LEVELS levels: each command's decoded words joined by spaces (each word alone when
//   that joined text cannot be read) get the same looks, the raw one with `$` dropped too. So `bash -c "cat
//   judge-\$'prompts'/x"`, `eval cat judge-\$\'prompts\'/x` and a script string inside a script string count. A
//   decoded text with no quote, backslash, `$` or backtick decodes to itself and is not read again.
// Out of reach (best-effort, not a sandbox): a glob (`judge-*`), a name built at run time from variables or command
// output, a `cd` into the parent then a relative glob, a spelling nested deeper than DECODE_LEVELS script strings, and
// a line the tokenizer cannot read at the top level (the judge's floor denies that one anyway).
const DECODE_LEVELS = 4;

/** @param {string} command @returns {boolean} */
function namesPromptStore(command) {
  return scanForStore(command, 0, 0) === true;
}

/**
 * true when `text` (decoded `level` times already) names the store, false when it is read and does not, null when the
 * tokenizer cannot read it (only the raw look was made).
 * @param {string} text @param {number} level @param {number} subDepth @returns {boolean | null}
 */
function scanForStore(text, level, subDepth) {
  if (text.replace(level ? /[\\'"$]/g : /[\\'"]/g, "").toLowerCase().includes(PROMPT_STORE_NAME)) return true;
  /** @type {{ commands: { words: { pieces: ({ lit: string } | object)[] }[] }[], substitutions: string[] }} */
  let t;
  try {
    t = tokenize(text);
  } catch {
    return null; // unreadable: the raw-text look above is all this check can do here
  }
  /** @type {string[][]} */
  const decoded = [];
  for (const { words } of t.commands) {
    /** @type {string[]} */
    const texts = [];
    for (const { pieces } of words) {
      let run = "";
      let whole = "";
      for (const p of [...pieces, {}]) {
        if ("lit" in p) {
          run += p.lit;
          whole += p.lit;
        } else if (run.toLowerCase().includes(PROMPT_STORE_NAME)) return true;
        else {
          run = "";
          whole += " ";
        }
      }
      texts.push(whole.trim());
    }
    decoded.push(texts);
  }
  if (subDepth < 8 && t.substitutions.some((s) => scanForStore(s, level, subDepth + 1) === true)) return true;
  if (level >= DECODE_LEVELS) return false;
  const again = (/** @type {string} */ s) => (/[\\'"$`]/.test(s) ? scanForStore(s, level + 1, subDepth) : false);
  for (const texts of decoded) {
    const joined = again(texts.join(" "));
    if (joined === true) return true;
    if (joined === null && texts.some((w) => again(w) === true)) return true;
  }
  return false;
}

if (namesPromptStore(command)) deny("always blocked: the command names the judge's record of the user's requests");

/** The user's typed requests in this session, oldest first. @returns {string[]} */
function requests() {
  const file = promptStore;
  if (!sessionId || !existsSync(file)) return [];
  // The file holds every session's prompts, so a line that cannot hold this session's id is skipped before parsing.
  // prompt-capture.mjs writes each record with JSON.stringify, so a record of this session holds the id as
  // JSON.stringify writes it; parsing and the session check below still decide.
  const id = JSON.stringify(sessionId);
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line.includes(id)) return [];
      try {
        const r = JSON.parse(line);
        return r && r.session_id === sessionId && typeof r.text === "string" && r.text.trim() ? [r.text] : [];
      } catch {
        return [];
      }
    });
}

/**
 * Read-only git facts for the prompt (branch, remotes), 2 s each; nothing on any failure.
 * @param {string} cwd
 * @returns {string[]}
 */
function gitFacts(cwd) {
  /** @param {string[]} args */
  const git = (args) => {
    try {
      const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
      return r.status === 0 ? String(r.stdout).trim() : "";
    } catch {
      return "";
    }
  };
  const branch = git(["branch", "--show-current"]);
  const remotes = git(["remote", "-v"]).split("\n").slice(0, 10).join("\n");
  return [...(branch ? [`git branch: ${branch}`] : []), ...(remotes ? [`git remote -v:\n${remotes}`] : [])];
}

/** One `claude -p` call. @param {string} prompt @returns {Promise<{ stdout: string } | { error: string, timeout?: boolean }>} */
function askClaude(prompt) {
  return new Promise((done) => {
    const bin = process.env.ORCH_JUDGE_CLAUDE_BIN || "claude";
    const model = process.env.ORCH_JUDGE_MODEL || "opus";
    // --setting-sources project from an empty dir: no user, project or local settings, so no plugins and no hooks.
    // --tools "" and --strict-mcp-config: no built-in tools and no MCP servers.
    // CLAUDE_CODE_DISABLE_AUTO_MEMORY=1 (below): without it Claude Code adds its auto-memory instructions to the judge's
    // prompt and leaves an empty projects/<temp folder>/memory folder behind after every call (seen on 2.1.325).
    const args = ["-p", "--model", model, "--max-turns", "1", "--output-format", "json", "--setting-sources", "project", "--tools", "", "--strict-mcp-config", "--no-session-persistence"];
    /** @type {string} */
    let dir;
    try {
      dir = mkdtempSync(join(tmpdir(), "orch-judge-"));
    } catch (err) {
      done({ error: `no temp dir (${err instanceof Error ? err.message : String(err)})` });
      return;
    }
    let out = "";
    let finished = false;
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    /** @type {import("node:child_process").ChildProcess | undefined} */
    let child;
    /** @param {{ stdout: string } | { error: string, timeout?: boolean }} result */
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try {
        child?.kill("SIGKILL");
      } catch {
        // already gone
      }
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // a leftover empty temp dir is harmless
      }
      done(result);
    };
    try {
      child = spawn(bin, args, { cwd: dir, env: { ...process.env, ORCH_JUDGE_INNER: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }, stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      finish({ error: `could not start ${bin} (${err instanceof Error ? err.message : String(err)})` });
      return;
    }
    timer = setTimeout(() => finish({ error: `judge_timeout: timed out after ${timeoutMs} ms`, timeout: true }), timeoutMs);
    child.on("error", (/** @type {NodeJS.ErrnoException} */ err) =>
      finish({ error: err.code === "ENOENT" ? `claude CLI not found (${bin})` : `claude CLI failed (${err.message})` }),
    );
    child.stdout?.on("data", (chunk) => {
      out += chunk;
      if (out.length > 1 << 20) finish({ error: "the claude CLI output is too large" });
    });
    child.on("close", (code) => finish(code === 0 ? { stdout: out } : { error: `claude CLI exited with code ${code}` }));
    child.stdin?.on("error", () => {});
    child.stdin?.end(prompt);
  });
}

try {
  const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
  const d = decide(command, cwd);
  if (d.action === "none") process.exit(0);
  if (d.action === "floor") deny(`always blocked: ${d.reason}`);
  /** @type {string[]} */
  const facts = [];
  if (d.kind === "rm") {
    // As the SDK judge: a symlinked, out-of-tree or unresolvable target is denied without a model call.
    const t = checkRmTargets(d.targets, cwd);
    if ("reason" in t) deny(`always blocked: ${t.reason}`);
    facts.push(`real target paths: ${JSON.stringify(t.resolved)}`);
  }
  const asked = requests();
  if (!asked.length) deny(NO_REQUEST_REASON);
  facts.push(...gitFacts(cwd));
  const answer = await askClaude(nativePrompt(d.kind, command, asked, { cwd, targets: d.targets, facts }));
  if ("error" in answer) deny(answer.timeout ? `${answer.error}: denied` : `judge failed (${answer.error}): denied`);
  const verdict = parseCliOutput(answer.stdout);
  if ("error" in verdict) deny(`judge answer rejected (${verdict.error}): denied`);
  if (verdict.decision !== "allow") deny(`judge refused: ${verdict.reason}`);
  log("allow", verdict.reason, command); // logged only; the hook prints nothing, the session's rules still apply
  process.exit(0);
} catch (err) {
  deny(`judge hook failed (${err instanceof Error ? err.message : String(err)}): denied`);
}
