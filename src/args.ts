/** Numeric limits come from CLI text and env: reject NaN, zero and negatives instead of silently disabling a cap. */

export function usd(label: string, n: number): number {
  if (!Number.isFinite(n) || n <= 0) throw new RangeError(`${label} must be a number greater than 0 (got ${n})`);
  return n;
}

export function count(label: string, n: number, min: number): number {
  if (!Number.isInteger(n) || n < min) throw new RangeError(`${label} must be an integer >= ${min} (got ${n})`);
  return n;
}
