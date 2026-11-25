// The caps of the native orchestrator (2.1.0), in one place. Not a hook: plan-check.mjs loads it with a dynamic import
// (a copy of the hooks without this file gets no wave cap, never a block), and the tests pin every prose or script copy
// of a value to it. Imports nothing, so it loads alone wherever the hooks are copied. The frozen SDK pipeline keeps its
// own values in LIMITS in src/config.ts; nothing here replaces them.
//
// Maintainer switch (environment only, no plugin setting; never named in model-facing text):
//   ORCH_WAVE_MAX  how many implementers may run at once, a whole number from 1 to WAVE_CAP_CEILING; anything else
//                  counts as unset (WAVE_CAP_DEFAULT).

/** Slices in one plan. */
export const PLAN_SLICE_CAP = 12;
/** Researcher questions in one run. */
export const RESEARCH_QUESTION_CAP = 6;
/** Implementers running at once (the plan check's wave_full), unless ORCH_WAVE_MAX says otherwise. */
export const WAVE_CAP_DEFAULT = 4;
/** The most ORCH_WAVE_MAX may allow. */
export const WAVE_CAP_CEILING = 8;
/**
 * How long an implementer launch the plan check allowed counts as on its way when no SubagentStart has followed it, in
 * ms: a wave launched in one message reaches the plan check before any of its agents starts. A launch that never starts
 * (refused later by a permission rule, or by the person) holds its place this long.
 */
export const WAVE_PENDING_MS = 120_000;

/**
 * The cap on implementers running at once: ORCH_WAVE_MAX when it is a whole number from 1 to WAVE_CAP_CEILING
 * (surrounding spaces allowed), else WAVE_CAP_DEFAULT.
 * @param {Record<string, string | undefined>} [env] @returns {number}
 */
export function waveMax(env = process.env) {
  const v = String(env.ORCH_WAVE_MAX ?? "").trim();
  if (!/^\d+$/.test(v)) return WAVE_CAP_DEFAULT;
  const n = Number(v);
  return n >= 1 && n <= WAVE_CAP_CEILING ? n : WAVE_CAP_DEFAULT;
}
