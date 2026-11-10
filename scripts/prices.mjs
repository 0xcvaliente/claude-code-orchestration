// List prices in USD per million tokens (Anthropic first-party API), for the cost estimate in scripts/report.mjs.
// Source: the claude-api reference bundled with Claude Code 2.1.322 (its model table and prompt-caching economics,
// cached 2026-11-03). A cache read is priced per model: 0.025x input on Fable 5.2 and 5.1, 0.05x on Opus 5.5 and
// Sonnet 5.5, 0.1x elsewhere. A cache write costs 1.25x input at the five-minute lifetime and 2x at the one-hour
// lifetime. Haiku 5.5's higher price for prompts above 100K tokens is not modelled.
// This is an estimate for comparing roles and models, not a bill: a subscription is not billed per token, and
// Bedrock and Vertex AI have their own prices. Update the table when a model or a price changes.

/** @typedef {{ input: number, output: number, cacheRead: number }} Price */
/** @type {Record<string, Price>} */
export const PRICES = {
  "claude-fable-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-mythos-5-2": { input: 8, output: 40, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-fable-5": { input: 10, output: 50, cacheRead: 1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};
export const CACHE_WRITE_5M = 1.25;
export const CACHE_WRITE_1H = 2;
export const PRICES_AS_OF = "2026-11-03";

/**
 * The price of a model id as transcripts record it: a provider prefix (`us.anthropic.`), a `[1m]` suffix, a date
 * suffix (`-20261001`) and a Bedrock version suffix (`-v1:0`) are ignored. null when the model has no listed price.
 * @param {unknown} model @returns {Price | null}
 */
export function priceOf(model) {
  if (typeof model !== "string") return null;
  const id = model
    .trim()
    .toLowerCase()
    .replace(/^.*anthropic\./, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-v\d+(:\d+)?$/, "")
    .replace(/[-@]\d{8}$/, "");
  return Object.hasOwn(PRICES, id) ? /** @type {Price} */ (PRICES[id]) : null;
}

/** @param {unknown} v */
const n = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * Estimated list-price cost in USD of a telemetry `tokens` object ({ input, output, cache_read, cache_write,
 * cache_write_1h }) on `model`, or null when the model has no listed price. cache_write_1h is the part of cache_write
 * written at the one-hour lifetime; records without it price every write at the five-minute rate.
 * @param {any} tokens @param {unknown} model @returns {number | null}
 */
export function costOf(tokens, model) {
  const p = priceOf(model);
  if (!p || !tokens || typeof tokens !== "object") return null;
  const write1h = Math.min(n(tokens.cache_write_1h), n(tokens.cache_write));
  const write5m = n(tokens.cache_write) - write1h;
  return (n(tokens.input) * p.input + n(tokens.output) * p.output + n(tokens.cache_read) * p.cacheRead + write5m * p.input * CACHE_WRITE_5M + write1h * p.input * CACHE_WRITE_1H) / 1e6;
}

/** "$0.004", "$1.23", "$1,234": enough digits to compare small agents. @param {number} usd */
export function formatUsd(usd) {
  if (usd < 0.01) return `$${usd.toFixed(3)}`;
  if (usd < 100) return `$${usd.toFixed(2)}`;
  return `$${Math.round(usd).toLocaleString("en-US")}`;
}
