import type { RunAgent } from "./agent.js";
import { LIMITS, TRIAGE } from "./config.js";

/** reviewed: a plain session, then one independent reviewer (with retries on its feedback). */
export type Mode = "plain" | "reviewed" | "orchestrate";

/** What the triager reports about a task. The policy in `decide` turns these facts into a mode. */
export interface Facts {
  filesToTouch: number;
  /** Parts that could be built at the same time with no shared files and no dependency on each other. */
  independentSlices: number;
  risky: boolean;
  reason: string;
}

export interface Decision {
  mode: Mode;
  /** forced: the user chose a mode. triage: the policy decided. fallback: triage failed, so the full pipeline runs. escalated: a cheaper route failed. */
  source: "forced" | "triage" | "fallback" | "escalated";
  reason: string;
  facts?: Facts;
  costUsd: number;
}

export const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    filesToTouch: { type: "integer", minimum: 0 },
    independentSlices: { type: "integer", minimum: 1, maximum: LIMITS.maxSlices },
    risky: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["filesToTouch", "independentSlices", "risky", "reason"],
  additionalProperties: false,
};

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

/** Model output is untrusted input: anything that is not a well-formed fact sheet is rejected, numbers are clamped. */
export function parseFacts(x: unknown): Facts | undefined {
  if (!isRecord(x)) return undefined;
  const { filesToTouch, independentSlices, risky, reason } = x;
  if (typeof filesToTouch !== "number" || !Number.isFinite(filesToTouch)) return undefined;
  if (typeof independentSlices !== "number" || !Number.isFinite(independentSlices)) return undefined;
  if (typeof risky !== "boolean") return undefined;
  return {
    filesToTouch: Math.max(0, Math.round(filesToTouch)),
    independentSlices: Math.min(LIMITS.maxSlices, Math.max(1, Math.round(independentSlices))),
    risky,
    reason: typeof reason === "string" ? reason.slice(0, 300) : "",
  };
}

/** Deterministic policy: thresholds live in config.ts (`TRIAGE`), so they can be tuned and tested without a model. */
export function decide(f: Facts): { mode: Mode; reason: string } {
  if (f.risky && f.independentSlices < TRIAGE.minParallelSlices && f.filesToTouch <= TRIAGE.reviewedMaxFiles) {
    return { mode: "reviewed", reason: `small risky change (${f.filesToTouch} file(s)): a plain session plus an independent reviewer` };
  }
  if (f.risky) return { mode: "orchestrate", reason: "risky change across several files: independent review per slice" };
  if (f.filesToTouch >= TRIAGE.bigFiles) {
    return { mode: "orchestrate", reason: `large change (${f.filesToTouch} files): split it across fresh contexts` };
  }
  if (f.independentSlices >= TRIAGE.minParallelSlices && f.filesToTouch >= TRIAGE.minParallelFiles) {
    return { mode: "orchestrate", reason: `${f.independentSlices} independent slices over ${f.filesToTouch} files: parallel worktrees pay off` };
  }
  return { mode: "plain", reason: `small or sequential change (${f.filesToTouch} file(s), ${f.independentSlices} slice(s)): a plain session is cheaper and as correct` };
}

export function triagePrompt(task: string): string {
  return (
    `Task:\n${task}\n\n` +
    `Skim the repository only as much as needed to size this task. Do not plan or implement it. Report:\n` +
    `- filesToTouch: files you expect to change or create.\n` +
    `- independentSlices: parts that different people could build at the same time with no shared files and no dependency ` +
    `on each other. Each must be substantial work, not a one-line edit. Use 1 when the work is sequential or small.\n` +
    `- risky: true only for security-sensitive code, authentication, payments, data migrations, public API changes, or ` +
    `changes spanning several modules where a wrong change is costly.\n` +
    `- reason: one sentence.`
  );
}

/** One cheap read-only call, then the policy. A failed triage falls back to the full pipeline, the pre-triage behaviour. */
export async function triage(opts: { run: RunAgent; repo: string; task: string }): Promise<Decision> {
  const r = await opts.run({ role: "triager", cwd: opts.repo, schema: TRIAGE_SCHEMA, prompt: triagePrompt(opts.task) });
  const costUsd = Number.isFinite(r.costUsd) ? r.costUsd : 0;
  const facts = r.ok ? parseFacts(r.structured) : undefined;
  if (!facts) {
    return {
      mode: "orchestrate",
      source: "fallback",
      reason: `triage failed (${r.ok ? "invalid output" : r.subtype}); using the full pipeline`,
      costUsd,
    };
  }
  return { ...decide(facts), source: "triage", facts, costUsd };
}
