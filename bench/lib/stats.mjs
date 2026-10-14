// Small statistics helpers for bench/analyze.mjs: medians, type-7 quantiles, a seeded PRNG and bootstrap CIs.
// Every function ignores null, undefined and NaN entries, and returns null for an empty sample.

const clean = (xs) => (xs ?? []).filter((x) => typeof x === "number" && Number.isFinite(x));

// Linear interpolation between order statistics (R's type 7, numpy's default).
export function quantile(xs, p) {
  const s = clean(xs).sort((a, b) => a - b);
  if (!s.length) return null;
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

export const median = (xs) => quantile(xs, 0.5);
export const mean = (xs) => {
  const s = clean(xs);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
};
export const min = (xs) => (clean(xs).length ? Math.min(...clean(xs)) : null);
export const max = (xs) => (clean(xs).length ? Math.max(...clean(xs)) : null);

// Quartiles and their spread.
export function iqr(xs) {
  const q1 = quantile(xs, 0.25);
  const q3 = quantile(xs, 0.75);
  return q1 === null ? null : { q1, q3, width: q3 - q1 };
}

// mulberry32: a tiny seeded PRNG returning floats in [0, 1).
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap CI for statFn(resampleA, resampleB).
 * paired: sampleA[i] and sampleB[i] belong together (same rep), so index pairs are resampled together;
 * both samples must then have equal length. Unpaired resamples each sample independently.
 * Returns { estimate, lo, hi, iterations, paired } or null when either sample is empty or no resample is defined.
 */
export function bootstrapCI(sampleA, sampleB, statFn, { paired = false, iterations = 10_000, seed = 1, level = 0.95 } = {}) {
  const a = sampleA ?? [];
  const b = sampleB ?? [];
  if (!a.length || !b.length) return null;
  if (paired && a.length !== b.length) throw new Error("paired bootstrap needs samples of equal length");
  const rand = mulberry32(seed);
  const pick = (n) => Math.floor(rand() * n);
  const stats = [];
  for (let i = 0; i < iterations; i++) {
    let ra;
    let rb;
    if (paired) {
      ra = new Array(a.length);
      rb = new Array(a.length);
      for (let j = 0; j < a.length; j++) {
        const k = pick(a.length);
        ra[j] = a[k];
        rb[j] = b[k];
      }
    } else {
      ra = Array.from(a, () => a[pick(a.length)]);
      rb = Array.from(b, () => b[pick(b.length)]);
    }
    const v = statFn(ra, rb);
    if (typeof v === "number" && Number.isFinite(v)) stats.push(v);
  }
  if (!stats.length) return null;
  const alpha = (1 - level) / 2;
  return { estimate: statFn(a, b), lo: quantile(stats, alpha), hi: quantile(stats, 1 - alpha), iterations, paired };
}

// Difference of medians (A minus B) and ratio of medians (A over B), ready for bootstrapCI.
export const medianDiff = (a, b) => {
  const ma = median(a);
  const mb = median(b);
  return ma === null || mb === null ? null : ma - mb;
};
export const medianRatio = (a, b) => {
  const ma = median(a);
  const mb = median(b);
  return ma === null || mb === null || mb === 0 ? null : ma / mb;
};

// Bootstrap CI for the ratio of medians A / B.
export const ratioCI = (a, b, opts) => bootstrapCI(a, b, medianRatio, opts);
