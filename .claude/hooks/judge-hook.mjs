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
//   call (audit 2026-11-16 J-12), and so is one whose glob matches the record's folder (globReachesStore). A text
//   check: a name built at run time gets past it, and the Write and Edit tools never reach this hook. Best-effort, not
//   a sandbox.
// - Malformed hook input: exit 0, no decision. Every floor or judged decision goes to gates.jsonl in the state dir.
// Settings: ORCH_JUDGE_CLAUDE_BIN (the claude binary, default `claude`), ORCH_JUDGE_MODEL (default opus),
// ORCH_JUDGE_TIMEOUT_MS (default 40000, clamped to 45000 so the hook always decides before Claude Code kills it).
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
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
// Out of reach (best-effort, not a sandbox): a name built at run time from variables or command output, a spelling
// nested deeper than DECODE_LEVELS script strings, and a line the tokenizer cannot read at the top level (the judge's
// floor denies that one anyway). Globs (`judge-*`, a `cd` into the parent then a relative glob) are matched against
// the folder's path below (globReachesStore).
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

// A glob can reach the store without holding its name (`cd ~/.claude/orchestration && cat judge-*/*/prompts.jsonl`,
// `echo x >> ~/.claude/*/judge-*/*/prompts.jsonl`, a relative glob after a `cd` into the parent in an earlier call).
// Each glob word of the line, of its substitutions and of the quoted words read again as script text (up to
// DECODE_LEVELS) is matched against the store folder's path, segment by segment (`*`, `?` and `[...]` within one
// segment, a `**` segment across segments, case ignored):
// - a glob with no expansion in it is resolved against the hook input's folder and every literal `cd`/`pushd` target
//   on the line (a bare `cd` is the home folder); it reaches the store when its leading segments match the store
//   folder's path (or its real path) to the end, so it names the store folder or something inside it;
// - a glob whose start the guard cannot know (`~`, `$HOME`, `$D`, or any relative glob on a line with a dynamic or
//   `cd -` target) reaches it when its segments after the last expansion line up with the end of the store folder's
//   path and one of those segments has a literal character (`$D/j*`, `~/.claude/orchestration/*`). So `"$dir"/*` alone
//   is not refused: a name built at run time stays out of reach, as above.
// Not refused either: a glob that names only a folder above the store (`ls ~/.claude/*`), and a recursive tool given
// such a folder (`grep -r x ~/.claude`), which reads the store without naming it.
const storeRoot = (() => {
  const at = promptStore.toLowerCase().lastIndexOf(PROMPT_STORE_NAME);
  return at < 0 ? "" : promptStore.slice(0, at + PROMPT_STORE_NAME.length);
})();

/** @typedef {({ lit: string } | { glob: string } | { dyn: true })[]} Seg */

/** A word's pieces split into path segments; `abs`: it starts with `/`. @param {any[]} pieces */
function segmentsOf(pieces) {
  /** @type {Seg[]} */
  const segs = [[]];
  /** @type {Seg} */
  let cur = segs[0] ?? [];
  for (const p of pieces) {
    if ("lit" in p) {
      /** @type {string[]} */
      const parts = p.lit.split("/");
      parts.forEach((part, i) => {
        if (i > 0) segs.push((cur = []));
        if (part) cur.push({ lit: part });
      });
    } else cur.push(p);
  }
  const abs = "lit" in (pieces[0] ?? {}) && pieces[0].lit.startsWith("/");
  return { segs: abs ? segs.slice(1) : segs, abs };
}

const isStar2 = (/** @type {Seg} */ s) => s.length === 2 && s.every((p) => "glob" in p && p.glob === "*");
const hasGlob = (/** @type {Seg} */ s) => s.some((p) => "glob" in p);
const hasLit = (/** @type {Seg} */ s) => s.some((p) => "lit" in p);
/** @param {Seg} seg @param {string} name */
function segMatch(seg, name) {
  if (isStar2(seg)) return true;
  const re = seg.map((p) => ("lit" in p ? p.lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : "glob" in p ? (p.glob === "*" ? "[^/]*" : "[^/]") : "[^/]*")).join("");
  return new RegExp(`^${re}$`, "i").test(name);
}

/**
 * The pattern segments `p` (from `i`) match the folder segments `r` (from `j`) to the end of `r`.
 * @param {Seg[]} p @param {number} i @param {string[]} r @param {number} j @returns {boolean}
 */
function reachesFrom(p, i, r, j) {
  const seg = p[i];
  const name = r[j];
  if (name === undefined) return true;
  if (!seg) return false;
  if (isStar2(seg)) return reachesFrom(p, i + 1, r, j) || reachesFrom(p, i, r, j + 1);
  return segMatch(seg, name) && reachesFrom(p, i + 1, r, j + 1);
}

/** Folder paths of the store: as configured and, when it exists, its real path. */
const storePaths = (() => {
  if (!storeRoot) return [];
  const out = [storeRoot.split("/").filter(Boolean)];
  try {
    const real = realpathSync(storeRoot);
    if (real !== storeRoot) out.push(real.split("/").filter(Boolean));
  } catch {
    // not created yet: the configured path is all there is
  }
  return out;
})();

/** @param {string} text @param {string} cwd @param {number} level @param {number} subDepth @returns {boolean} */
function globReachesStore(text, cwd, level, subDepth) {
  if (!storePaths.length || !/[*?[]/.test(text)) return false; // no glob character anywhere, nested text included
  /** @type {{ commands: { words: { pieces: any[], text: string, dynamic: boolean }[] }[], substitutions: string[] }} */
  let t;
  try {
    t = tokenize(text);
  } catch {
    return false; // unreadable: the floor denies it anyway at the top level
  }
  const bases = [cwd];
  let unknownBase = false;
  let cur = cwd;
  for (const { words } of t.commands) {
    const w0 = words.find((w) => !w.dynamic && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w.text));
    if (!w0 || !["cd", "pushd"].includes(w0.text)) continue;
    const target = words.slice(words.indexOf(w0) + 1).find((w) => w.dynamic || !w.text.startsWith("-") || w.text === "-");
    if (!target) cur = homedir();
    else if (target.dynamic || target.text === "-") {
      unknownBase = true;
      continue;
    } else cur = resolve(cur, target.text);
    bases.push(cur);
  }
  for (const { words } of t.commands)
    for (const w of words) {
      const { segs, abs } = segmentsOf(w.pieces);
      if (segs.some(hasGlob)) {
        let d = -1;
        segs.forEach((s, i) => {
          if (s.some((p) => "dyn" in p)) d = i;
        });
        if (d >= 0 || (!abs && unknownBase)) {
          const tail = segs.slice(d + 1);
          for (const r of storePaths)
            for (let o = Math.max(0, r.length - tail.length); o < r.length; o++) {
              const n = r.length - o;
              if (tail.slice(0, n).some(hasLit) && tail.slice(0, n).every((s, i) => segMatch(s, r[o + i] ?? ""))) return true;
            }
        }
        if (d < 0)
          for (const b of abs ? ["/"] : bases) {
            /** @type {Seg[]} */
            const full = b.split("/").filter(Boolean).map((x) => [{ lit: x }]);
            for (const s of segs) {
              const only = s.length === 1 && s[0] && "lit" in s[0] ? s[0].lit : undefined;
              if (only === ".") continue;
              if (only === "..") full.pop();
              else if (s.length) full.push(s);
            }
            if (storePaths.some((r) => reachesFrom(full, 0, r, 0))) return true;
          }
      }
      // A quoted word may be script text another command runs (`bash -c`, `eval`): read it again.
      if (!w.dynamic && level < DECODE_LEVELS && /[*?[]/.test(w.text) && /\s/.test(w.text) && globReachesStore(w.text, cwd, level + 1, subDepth)) return true;
    }
  return subDepth < 8 && t.substitutions.some((s) => globReachesStore(s, cwd, level, subDepth + 1));
}

if (globReachesStore(command, typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd(), 0, 0)) deny("always blocked: the command names the judge's record of the user's requests (through a glob)");

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
