#!/usr/bin/env node
// Token counts from a `claude -p --output-format json` result, shared by log-run.mjs, report.mjs and the bench scripts.
// "Tokens" = input + output + cache-read + cache-write, summed over every model in modelUsage (main loop and subagents);
// usage (main loop only) is the fallback when modelUsage is missing or empty.
// CLI: node scripts/tokens.mjs budget-usd <count>   prints the dollar cap for a token count such as 500k or 2M, or the error and exit 1.
import { pathToFileURL } from "node:url";

// A rough conversion, used only where `claude` or old logs speak in dollars (the native --max-budget-usd cap and
// legacy runs.jsonl rows). Real use per list-price dollar ranges from about 0.2M to 1.8M tokens with the cache mix.
export const TOKENS_PER_USD = 1_000_000;

const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const sum = (a, b) => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const fromModel = (u) => ({ input: n(u?.inputTokens), output: n(u?.outputTokens), cacheRead: n(u?.cacheReadInputTokens), cacheWrite: n(u?.cacheCreationInputTokens) });
const total = (u) => u.input + u.output + u.cacheRead + u.cacheWrite;

export function usageOf(result) {
  const models = Object.values(result?.modelUsage ?? {});
  if (models.length) return models.map(fromModel).reduce(sum, ZERO);
  const u = result?.usage;
  return { input: n(u?.input_tokens), output: n(u?.output_tokens), cacheRead: n(u?.cache_read_input_tokens), cacheWrite: n(u?.cache_creation_input_tokens) };
}

export const totalTokens = (result) => total(usageOf(result));

// { "opus-4-7": 12345 }: tokens per model, the "claude-" prefix dropped.
export const tokensByModel = (result) =>
  Object.fromEntries(Object.entries(result?.modelUsage ?? {}).map(([m, u]) => [m.replace(/^claude-/, ""), total(fromModel(u))]));

// Unit and decimals are chosen from the rounded value, so 999,999 prints "1.00M", never "1000k".
export function formatTokens(count) {
  const x = Math.round(count);
  if (x < 1_000) return String(x);
  const tenthsK = Math.round(x / 100);
  if (tenthsK < 100) return `${(tenthsK / 10).toFixed(1)}k`;
  const k = Math.round(x / 1_000);
  if (k < 1_000) return `${k}k`;
  const hundredthsM = Math.round(x / 10_000);
  if (hundredthsM < 1_000) return `${(hundredthsM / 100).toFixed(2)}M`;
  return `${(Math.round(x / 100_000) / 10).toFixed(1)}M`;
}

// "500000", "500k", "2M", "1.5m" -> integer, at least 10k (so an old dollar value such as 5 is refused).
export function parseTokens(text) {
  const m = /^(\d+(?:\.\d+)?)([kKmM]?)$/.exec(String(text));
  const count = m ? Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6 }[m[2].toLowerCase()] ?? 1)) : 0;
  if (count < 10_000) throw new Error(`ORCH_BUDGET_TOKENS must be a token count of at least 10k, such as 500000, 500k or 2M (got ${text})`);
  return count;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    if (process.argv[2] !== "budget-usd") throw new Error("usage: tokens.mjs budget-usd <count>");
    console.log(String(parseTokens(process.argv[3] ?? "") / TOKENS_PER_USD));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
