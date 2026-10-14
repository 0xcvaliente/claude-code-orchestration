import { query } from "@anthropic-ai/claude-agent-sdk";
import { LIMITS, ROLES, type Role } from "./config.js";

export interface AgentRequest {
  role: Role;
  prompt: string;
  cwd: string;
  /** JSON Schema for the final answer; the parsed value comes back as `structured`. */
  schema?: Record<string, unknown>;
}

export interface AgentResult {
  ok: boolean;
  text: string;
  structured?: unknown;
  costUsd: number;
  turns: number;
  subtype: string;
  durationMs: number;
  model: string;
}

/** Seam for tests: the orchestrator only depends on this signature. */
export type RunAgent = (req: AgentRequest) => Promise<AgentResult>;

/** One worker = one query() = one fresh context, cwd, tool set, and turn cap. */
export const runAgent: RunAgent = async (req) => {
  const cfg = ROLES[req.role];
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), LIMITS.workerTimeoutMs);
  const started = Date.now();
  // A worker that died mid-stream reports no cost; runs are bounded by turns and timeouts, not dollars.
  const fail = (subtype: string, text: string): AgentResult => ({
    ok: false, text, costUsd: 0, turns: 0, subtype, durationMs: Date.now() - started, model: cfg.model,
  });

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
        systemPrompt: { type: "preset", preset: "claude_code", append: cfg.system },
        abortController: abort,
        ...(req.schema && { outputFormat: { type: "json_schema" as const, schema: req.schema } }),
      },
    });

    for await (const msg of stream) {
      if (msg.type !== "result") continue;
      const common = {
        costUsd: msg.total_cost_usd,
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
