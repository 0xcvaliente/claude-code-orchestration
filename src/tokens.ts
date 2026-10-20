import { formatTokens as sharedFormatTokens, usageOf } from "../scripts/tokens.mjs";

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

/** Summing (modelUsage, else usage fallback; non-finite counts are 0) is single-sourced in scripts/tokens.mjs. */
export function usageFromResult(msg: UsageSource): TokenUsage {
  return usageOf(msg);
}

export const totalTokens = (u: TokenUsage) => u.input + u.output + u.cacheRead + u.cacheWrite;

/** 950 -> "950", 4500 -> "4.5k", 45600 -> "46k", 1234567 -> "1.23M", 12345678 -> "12.3M". Single-sourced in scripts/tokens.mjs. */
export const formatTokens: (count: number) => string = sharedFormatTokens;
