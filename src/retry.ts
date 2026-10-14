import type { AgentResult, RunAgent } from "./agent.js";
import { LIMITS } from "./config.js";

/**
 * A worker that failed because of the service, not the task: rate limit, overload, a 5xx, a dropped connection.
 * Never a turn cap, our own timeout or a refusal: retrying those only repeats the failure.
 */
export function isTransient(r: AgentResult): boolean {
  if (r.ok || r.subtype === "timeout" || r.subtype === "error_max_turns") return false;
  return /rate.?limit|too many requests|\b429\b|overloaded|\b529\b|\b50[0234]\b|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|stream (ended|closed)|temporarily unavailable/i.test(
    `${r.subtype} ${r.text}`,
  );
}

export interface RetryOptions {
  /** Delay before retry n (1-based), in ms. */
  backoffMs?: (attempt: number) => number;
  sleep?: (ms: number) => Promise<void>;
  retries?: number;
  onRetry?: (attempt: number, r: AgentResult) => void;
}

const defaultBackoff = (attempt: number) => LIMITS.transientBackoffMs * 4 ** (attempt - 1) + Math.floor(Math.random() * 500);

/** Rerun a worker that hit a transient service error. Costs add up across attempts so reports stay honest. */
export function withTransientRetry(run: RunAgent, opts: RetryOptions = {}): RunAgent {
  const retries = opts.retries ?? LIMITS.transientRetries;
  const backoff = opts.backoffMs ?? defaultBackoff;
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (req) => {
    let spent = 0;
    for (let attempt = 0; ; attempt++) {
      const r = await run(req);
      spent += Number.isFinite(r.costUsd) ? r.costUsd : 0;
      if (attempt >= retries || !isTransient(r)) return { ...r, costUsd: spent };
      opts.onRetry?.(attempt + 1, r);
      await sleep(backoff(attempt + 1));
    }
  };
}
