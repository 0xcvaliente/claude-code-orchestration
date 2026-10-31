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
// - Malformed hook input: exit 0, no decision. Every floor or judged decision goes to gates.jsonl in the state dir.
// Settings: ORCH_JUDGE_CLAUDE_BIN (the claude binary, default `claude`), ORCH_JUDGE_MODEL (default opus),
// ORCH_JUDGE_TIMEOUT_MS (default 60000; the hook's own timeout in settings must stay above it).
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NO_REQUEST_REASON, decide, nativePrompt, parseCliOutput } from "./judge-core.mjs";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

if ((process.env.ORCH_JUDGE ?? "").trim().toLowerCase() !== "native") process.exit(0);
if (process.env.ORCH_JUDGE_INNER === "1") process.exit(0); // the judge's own claude -p run
if (duplicate("judge-hook.mjs")) process.exit(0); // the project's own copy judges this command

const timeoutMs = (() => {
  const n = Number.parseInt(process.env.ORCH_JUDGE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 60_000;
})();

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

/** The user's typed requests in this session, oldest first. @returns {string[]} */
function requests() {
  const file = join(stateDir, "prompts.jsonl");
  if (!sessionId || !existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      try {
        const r = JSON.parse(line);
        return r && r.session_id === sessionId && typeof r.text === "string" && r.text.trim() ? [r.text] : [];
      } catch {
        return [];
      }
    });
}

/** One `claude -p` call. @param {string} prompt @returns {Promise<{ stdout: string } | { error: string }>} */
function askClaude(prompt) {
  return new Promise((done) => {
    const bin = process.env.ORCH_JUDGE_CLAUDE_BIN || "claude";
    const model = process.env.ORCH_JUDGE_MODEL || "opus";
    // --setting-sources project from an empty dir: no user, project or local settings, so no plugins and no hooks.
    // --tools "" and --strict-mcp-config: no built-in tools and no MCP servers.
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
    /** @param {{ stdout: string } | { error: string }} result */
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
      child = spawn(bin, args, { cwd: dir, env: { ...process.env, ORCH_JUDGE_INNER: "1" }, stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      finish({ error: `could not start ${bin} (${err instanceof Error ? err.message : String(err)})` });
      return;
    }
    timer = setTimeout(() => finish({ error: `timed out after ${timeoutMs} ms` }), timeoutMs);
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
  const asked = requests();
  if (!asked.length) deny(NO_REQUEST_REASON);
  const answer = await askClaude(nativePrompt(d.kind, command, asked, { cwd, targets: d.targets }));
  if ("error" in answer) deny(`judge failed (${answer.error}): denied`);
  const verdict = parseCliOutput(answer.stdout);
  if ("error" in verdict) deny(`judge answer rejected (${verdict.error}): denied`);
  if (verdict.decision !== "allow") deny(`judge refused: ${verdict.reason}`);
  log("allow", verdict.reason, command); // logged only; the hook prints nothing, the session's rules still apply
  process.exit(0);
} catch (err) {
  deny(`judge hook failed (${err instanceof Error ? err.message : String(err)}): denied`);
}
