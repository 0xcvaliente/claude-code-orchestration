/** Token accounting for one worker, session or run: input + output + cache-read + cache-write, over every model used. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The parts of an SDK result message that carry token counts. */
interface UsageSource {
  modelUsage?: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
}

/** A missing or non-finite count is 0, so one bad field cannot turn a total into NaN. */
const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * Tokens of one result message. `modelUsage` covers every model call of the query (main loop, subagents, internal
 * calls); `usage` is the main loop only, so it is the fallback when `modelUsage` is missing or empty.
 */
export function usageFromResult(msg: UsageSource): TokenUsage {
  const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const models = Object.values(msg.modelUsage ?? {});
  if (models.length > 0) {
    for (const m of models) {
      total.input += n(m?.inputTokens);
      total.output += n(m?.outputTokens);
      total.cacheRead += n(m?.cacheReadInputTokens);
      total.cacheWrite += n(m?.cacheCreationInputTokens);
    }
  } else if (msg.usage) {
    total.input = n(msg.usage.input_tokens);
    total.output = n(msg.usage.output_tokens);
    total.cacheRead = n(msg.usage.cache_read_input_tokens);
    total.cacheWrite = n(msg.usage.cache_creation_input_tokens);
  }
  return total;
}

export const totalTokens = (u: TokenUsage) => u.input + u.output + u.cacheRead + u.cacheWrite;

/** 950 -> "950", 4500 -> "4.5k", 45600 -> "46k", 1234567 -> "1.23M", 12345678 -> "12.3M". */
export function formatTokens(count: number): string {
  const v = Math.round(count);
  if (v < 1_000) return String(v);
  if (v < 1_000_000) return `${(v / 1_000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return `${(v / 1_000_000).toFixed(v < 10_000_000 ? 2 : 1)}M`;
}
