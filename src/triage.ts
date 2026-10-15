import type { RunAgent } from "./agent.js";
import { LIMITS, TRIAGE } from "./config.js";

/** reviewed: a plain session, then one independent reviewer (with retries on its feedback). */
export type Mode = "plain" | "reviewed" | "orchestrate";

/**
 * What the triager reports about a task, of any kind: code, research, writing, analysis or operations.
 * The policy in `decide` turns these facts into a mode.
 */
export interface Facts {
  /**
   * True when the task creates or changes source code, tests, build or CI configuration in a repository. False for
   * research, writing, analysis, planning or operations whose output is documents, data, answers or commands run.
   * In `decide` it changes one thing, the parallel-files threshold (TRIAGE.minParallelFilesCode or
   * minParallelFilesNonCode). Callers also use it to decide git machinery (worktrees, CHECKPOINT commits, the
   * integrator) and, in `npm run auto`, whether web tools are allowed. The test gate never reads it: it judges the
   * changed files itself.
   */
  code: boolean;
  /** Files the task will create or change, of any kind (source, docs, reports, data, config). */
  filesToTouch: number;
  /** Estimated lines added or changed across them, prose and data included. */
  linesToChange: number;
  /**
   * Parts separate workers could do at the same time with no shared output file and no dependency on each other:
   * modules, documents, or research questions whose findings are combined at the end. 1 when sequential or small.
   */
  independentSlices: number;
  /**
   * A wrong result is costly: security, authentication, payments, data migrations or deletion, public API changes,
   * production operations (deploys, infrastructure, credentials), content sent or published outside the team, or
   * changes spanning several modules where a wrong change is costly.
   */
  risky: boolean;
  reason: string;
}

export interface Decision {
  mode: Mode;
  /** forced: the user chose a mode. triage: the policy decided. fallback: triage failed, so the full pipeline runs. escalated: a cheaper route failed. */
  source: "forced" | "triage" | "fallback" | "escalated";
  reason: string;
  facts?: Facts;
  /** Tokens the triage call used; 0 when triage was forced or skipped. */
  tokens: number;
}

export const TRIAGE_SCHEMA = {
  type: "object",
  properties: {
    code: { type: "boolean" },
    filesToTouch: { type: "integer", minimum: 0 },
    linesToChange: { type: "integer", minimum: 0 },
    independentSlices: { type: "integer", minimum: 1, maximum: LIMITS.maxSlices },
    risky: { type: "boolean" },
    reason: { type: "string" },
  },
  required: ["code", "filesToTouch", "linesToChange", "independentSlices", "risky", "reason"],
  additionalProperties: false,
};

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;

/**
 * Model output is untrusted input: anything that is not a well-formed fact sheet is rejected, numbers are clamped.
 * `code` is the one lenient field: a sheet from an older caller or a logged line has none, and a missing or non-boolean
 * `code` means true, the conservative choice: git machinery stays on and headless web tools stay off.
 */
export function parseFacts(x: unknown): Facts | undefined {
  if (!isRecord(x)) return undefined;
  const { code, filesToTouch, linesToChange, independentSlices, risky, reason } = x;
  if (typeof filesToTouch !== "number" || !Number.isFinite(filesToTouch)) return undefined;
  if (typeof linesToChange !== "number" || !Number.isFinite(linesToChange)) return undefined;
  if (typeof independentSlices !== "number" || !Number.isFinite(independentSlices)) return undefined;
  if (typeof risky !== "boolean") return undefined;
  return {
    code: typeof code === "boolean" ? code : true,
    filesToTouch: Math.max(0, Math.round(filesToTouch)),
    linesToChange: Math.max(0, Math.round(linesToChange)),
    independentSlices: Math.min(LIMITS.maxSlices, Math.max(1, Math.round(independentSlices))),
    risky,
    reason: typeof reason === "string" ? reason.slice(0, 300) : "",
  };
}

/**
 * The parallel-files threshold for a fact sheet: the code value unless `code` is exactly false, so a sheet with a missing
 * or odd `code` is sized like code, matching parseFacts' default of true.
 */
export function minParallelFiles(f: Pick<Facts, "code">): number {
  return f.code === false ? TRIAGE.minParallelFilesNonCode : TRIAGE.minParallelFilesCode;
}

/**
 * Deterministic policy: thresholds live in config.ts (`TRIAGE`), so they can be tuned and tested without a model. The
 * `code` fact only picks the parallel-files threshold; every other rule is the same for any kind of task.
 */
export function decide(f: Facts): { mode: Mode; reason: string } {
  if (f.risky && f.independentSlices < TRIAGE.minParallelSlices && f.filesToTouch <= TRIAGE.reviewedMaxFiles && f.linesToChange <= TRIAGE.reviewedMaxLines) {
    return { mode: "reviewed", reason: `small risky change (${f.filesToTouch} file(s), ~${f.linesToChange} lines): a plain session plus an independent reviewer` };
  }
  if (f.risky) return { mode: "orchestrate", reason: "risky change that is not small: independent review per slice" };
  if (f.filesToTouch >= TRIAGE.bigFiles) {
    return { mode: "orchestrate", reason: `large change (${f.filesToTouch} files): split it across fresh contexts` };
  }
  if (f.independentSlices >= TRIAGE.minParallelSlices && (f.filesToTouch >= minParallelFiles(f) || f.linesToChange >= TRIAGE.bigLines)) {
    return {
      mode: "orchestrate",
      reason: `${f.independentSlices} independent slices over ${f.filesToTouch} files, ~${f.linesToChange} lines: parallel slices pay off`,
    };
  }
  if (f.linesToChange >= TRIAGE.bigLines) {
    return {
      mode: "plain",
      reason: `large but sequential change (~${f.linesToChange} lines, ${f.independentSlices} slice(s)): one session keeps a coupled design in one context`,
    };
  }
  return { mode: "plain", reason: `small or sequential change (${f.filesToTouch} file(s), ${f.independentSlices} slice(s)): a plain session is cheaper and as correct` };
}

export function triagePrompt(task: string): string {
  return (
    `Task:\n${task}\n\n` +
    `The task may be code, research, writing, analysis, planning or operations. Skim the folder (a code repository or any ` +
    `other folder; it may hold little for a research task) only as much as needed to size the task. Do not plan or implement it. Report:\n` +
    `- code: true when the task creates or changes source code, tests, build or CI configuration in a repository; false for ` +
    `research, writing, analysis, planning or operations whose output is documents, data, answers or commands run.\n` +
    `- filesToTouch: files the task will create or change, of any kind (source, docs, reports, data, config).\n` +
    `- linesToChange: estimated lines added or changed across them, prose and data included, counting new files; a ` +
    `2,000-line engine in 3 files is 2000, and a 400-line report in 1 file is 400.\n` +
    `- independentSlices: parts separate workers could do at the same time with no shared output file and no dependency on ` +
    `each other: modules, documents, or research questions whose findings are combined at the end. Each must be substantial ` +
    `work, not a one-line edit. Use 1 when the work is sequential or small.\n` +
    `- risky: true when a wrong result is costly: security, authentication, payments, data migrations or deletion, public ` +
    `API changes, production operations (deploys, infrastructure, credentials), content sent or published outside the team, ` +
    `or changes spanning several modules where a wrong change is costly.\n` +
    `- reason: one sentence.`
  );
}

/**
 * One cheap read-only call, then the policy. A failed triage falls back to the full pipeline, the pre-triage behaviour.
 * `repo` is the folder the task is about: any folder works, a git repository is not required, and triage never calls git.
 */
export async function triage(opts: { run: RunAgent; repo: string; task: string }): Promise<Decision> {
  const r = await opts.run({ role: "triager", cwd: opts.repo, schema: TRIAGE_SCHEMA, prompt: triagePrompt(opts.task) });
  const tokens = Number.isFinite(r.tokens) ? r.tokens : 0;
  const facts = r.ok ? parseFacts(r.structured) : undefined;
  if (!facts) {
    return {
      mode: "orchestrate",
      source: "fallback",
      reason: `triage failed (${r.ok ? "invalid output" : r.subtype}); using the full pipeline`,
      tokens,
    };
  }
  return { ...decide(facts), source: "triage", facts, tokens };
}
