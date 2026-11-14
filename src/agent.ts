import { tmpdir } from "node:os";
import { join } from "node:path";
import { query as sdkQuery, type HookCallbackMatcher, type Options } from "@anthropic-ai/claude-agent-sdk";
import { LIMITS, rolesFor, type Role } from "./config.js";
import { askOpus, bashGuard, HOOK_TIMEOUT_S, judgeEnabled, runGit, statPath, workerEnv, type JudgeDeps } from "./judge.js";
import { totalTokens, usageFromResult, type TokenUsage } from "./tokens.js";

export interface AgentRequest {
  role: Role;
  prompt: string;
  cwd: string;
  /** The user's original request, verbatim: the judge's authority for push and recursive deletion. Bash roles only. */
  task?: string;
  /** Where the judge appends its decisions (JSONL). Default: ORCH_JUDGE_AUDIT, else ./runs/judge-audit.jsonl (git-ignored). */
  auditFile?: string;
  /** JSON Schema for the final answer; the parsed value comes back as `structured`. */
  schema?: Record<string, unknown>;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  /** Total tokens of the worker: input + output + cache read + cache write, over every model it used. */
  tokens: number;
  usage?: TokenUsage;
  turns: number;
  subtype: string;
  durationMs: number;
  model: string;
}

/** Seam for tests: the orchestrator only depends on this signature. */
export type RunAgent = (req: AgentRequest) => Promise<AgentResult>;

export interface AgentEnv {
  /** Seam for tests: replaces the SDK's query(). */
  query?: typeof sdkQuery;
  env?: NodeJS.ProcessEnv;
  /** Seam for tests: the judge's dependencies; the default asks opus and appends to the audit file. */
  judgeDeps?: (auditFile: string) => JudgeDeps;
}

const defaultJudgeDeps = (auditFile: string): JudgeDeps => ({
  ask: askOpus(), git: runGit, stat: statPath, now: Date.now, auditFile, cache: new Map(),
});

/**
 * ORCH_SANDBOX=on: the OS sandbox behind the text floor, for Bash roles only. Off by default (opt-in until validated).
 * Checked in sdk.d.ts: `Options.sandbox` is `SandboxSettings` with `enabled`, `failIfUnavailable` (true makes query()
 * return an error result instead of running unsandboxed), `allowUnsandboxedCommands` (false ignores the model's
 * dangerouslyDisableSandbox escape), `filesystem.allowWrite` (extra writable paths; the cwd is writable by default),
 * `filesystem.denyWrite` and `network.allowedDomains` (wildcards allowed). scripts/sandbox-smoke.mjs ran once on macOS with
 * exactly these options: a write inside the cwd worked, and creating a marker file directly in the home folder (outside
 * the cwd and tmpdir()) was blocked with "operation not permitted" (marker removed afterwards, absence verified), so
 * allowWrite alone confines writes; no extra denyWrite is needed. A write into tmpdir() itself was not exercised (the
 * earlier sibling write under /private/tmp succeeded, as expected). Not covered: Linux, reads, network. Still opt-in.
 */
export function sandboxFor(env: NodeJS.ProcessEnv, cwd: string): Options["sandbox"] | undefined {
  if ((env.ORCH_SANDBOX ?? "").trim().toLowerCase() !== "on") return undefined;
  const domains = (env.ORCH_SANDBOX_DOMAINS ?? "").split(",").map((d) => d.trim()).filter(Boolean);
  return {
    enabled: true,
    failIfUnavailable: true,
    allowUnsandboxedCommands: false,
    filesystem: { allowWrite: [cwd, tmpdir()] },
    network: { allowedDomains: domains },
  };
}

/** One worker = one query() = one fresh context, cwd, tool set, and turn cap. */
export const makeRunAgent = (deps: AgentEnv = {}): RunAgent => async (req) => {
  const query = deps.query ?? sdkQuery;
  const env = deps.env ?? process.env;
  const cfg = rolesFor(env)[req.role];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LIMITS.workerTimeoutMs);
  const started = Date.now();
  // A worker that died mid-stream reports no tokens; runs are bounded by turns and timeouts unless a token budget is set.
  const fail = (subtype: string, text: string): AgentResult => ({
    ok: false, text, tokens: 0, turns: 0, subtype, durationMs: Date.now() - started, model: cfg.model,
  });

  // Bash roles: every Bash call passes the guard first. Plain `Bash` is pre-approved, so a guard that failed without
  // blocking would let the command run. Three layers keep that from happening: bashGuard denies on any throw of its
  // own, HOOK_TIMEOUT_S is above the judge's own timeout (and a PreToolUse callback that does time out blocks the call,
  // Claude Code 2.1.210 and later), and the matcher's onFailure "block" below covers what is left.
  // With the judge off the guard still denies the judged classes, on top of UNSAFE_BASH in disallowedTools.
  // The judge's own tokens are NOT part of the worker's `tokens` (they are a separate query() inside the hook).
  let hooks: Options["hooks"];
  if (cfg.tools.includes("Bash")) {
    const auditFile = req.auditFile ?? env.ORCH_JUDGE_AUDIT ?? join(process.cwd(), "runs", "judge-audit.jsonl");
    const guard = bashGuard({
      role: req.role, brief: req.prompt, task: req.task ?? "", cwd: req.cwd,
      enabled: judgeEnabled(env), deps: (deps.judgeDeps ?? defaultJudgeDeps)(auditFile),
    });
    // onFailure "block" (Agent SDK 0.3.317): a guard that throws, returns nothing or returns invalid output blocks the
    // command instead of letting it reach the pre-approved Bash rule. bashGuard already denies on its own errors; this
    // closes the cases outside it. The SDK refuses to start the query on a Claude Code that does not honor the option.
    const matcher: HookCallbackMatcher = { matcher: "Bash", timeout: HOOK_TIMEOUT_S, onFailure: "block", hooks: [guard] };
    hooks = { PreToolUse: [matcher] };
  }
  const sandbox = cfg.tools.includes("Bash") ? sandboxFor(env, req.cwd) : undefined;

  try {
    const stream = query({
      prompt: req.prompt,
      options: {
        model: cfg.model,
        cwd: req.cwd,
        effort: cfg.effort,
        maxTurns: cfg.maxTurns,
        tools: cfg.tools,
        allowedTools: cfg.tools,
        disallowedTools: cfg.disallowedTools,
        permissionMode: "dontAsk", // headless: anything not allowed above is denied, never prompted
        settingSources: ["project"],
        env: workerEnv(), // no Claude Code auto memory in a worker (see workerEnv)
        systemPrompt: { type: "preset", preset: "claude_code", append: cfg.system },
        abortController: abort,
        ...(hooks && { hooks }),
        ...(sandbox && { sandbox }),
        ...(req.schema && { outputFormat: { type: "json_schema" as const, schema: req.schema } }),
      },
    });

    for await (const msg of stream) {
      if (msg.type !== "result") continue;
      const usage = usageFromResult(msg);
      const common = {
        tokens: totalTokens(usage),
        usage,
        turns: msg.num_turns,
        subtype: msg.subtype,
        durationMs: Date.now() - started,
        model: cfg.model,
      };
      return msg.subtype === "success"
        ? { ...common, ok: !msg.is_error, text: msg.result, structured: msg.structured_output }
        : { ...common, ok: false, text: msg.errors.join("\n") };
    }
    return fail("no_result", "agent stream ended without a result");
  } catch (err) {
    return fail(abort.signal.aborted ? "timeout" : "exception", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
};

export const runAgent: RunAgent = makeRunAgent();
