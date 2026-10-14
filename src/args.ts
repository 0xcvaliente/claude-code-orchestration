/** Limits come from CLI text and env: reject NaN, zero and negatives instead of silently disabling a cap. */

const TOKEN_TEXT = /^\d+(\.\d+)?[kKmM]?$/;
const MIN_TOKENS = 10_000;

/** A token count such as 500000, 500k or 1.5M. At least 10k, which also catches an old budget such as `5`. */
export function parseTokens(label: string, text: string): number {
  const m = TOKEN_TEXT.exec(text);
  const unit = m ? text.slice(-1).toLowerCase() : "";
  const scale = unit === "k" ? 1_000 : unit === "m" ? 1_000_000 : 1;
  const value = m ? Math.round(Number.parseFloat(text) * scale) : Number.NaN;
  if (!Number.isFinite(value) || value < MIN_TOKENS) {
    throw new RangeError(`${label} must be a token count of at least 10k, such as 500000, 500k or 2M (got ${text})`);
  }
  return value;
}

export function count(label: string, n: number, min: number): number {
  if (!Number.isInteger(n) || n < min) throw new RangeError(`${label} must be an integer >= ${min} (got ${n})`);
  return n;
}
