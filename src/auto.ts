import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orchestrate, type OrchestrateOptions, type Report } from "./orchestrator.js";
import { solo, type SoloReport } from "./solo.js";
import { triage, type Decision } from "./triage.js";

export type RequestedMode = "auto" | "plain" | "reviewed" | "orchestrate";
export const MODES: readonly RequestedMode[] = ["auto", "plain", "reviewed", "orchestrate"];

export interface AutoOptions extends OrchestrateOptions {
  /** auto (default): triage decides. Anything else skips triage and uses that route. */
  mode?: RequestedMode;
  /** When a triaged plain or reviewed session fails, rerun the task through the pipeline (default true). */
  escalate?: boolean;
}
export interface AutoResult {
  decision: Decision;
  /** Present when the pipeline ran. */
  report?: Report;
  /** Present when a plain or reviewed session ran (also when it failed and the task escalated). */
  soloReport?: SoloReport;
  escalated: boolean;
}

/** Choose the route for one task. A forced mode, --plan-only and --resume skip triage and cost nothing. */
export async function decideRoute(
  opts: Pick<AutoOptions, "run" | "repo" | "task" | "mode" | "planOnly" | "resume">,
): Promise<Decision> {
  if (opts.planOnly || opts.resume) {
    // Both only mean something for the pipeline, so they imply that route.
    return { mode: "orchestrate", source: "forced", reason: opts.resume ? "--resume" : "--plan-only", costUsd: 0 };
  }
  const requested = opts.mode ?? "auto";
  if (requested !== "auto") return { mode: requested, source: "forced", reason: `--mode ${requested}`, costUsd: 0 };
  return triage({ run: opts.run, repo: opts.repo, task: opts.task });
}

/** One line per decision, so thresholds in config.ts can be tuned against what actually happened. */
export function logRoute(outRoot: string, task: string, d: Decision, extra: object = {}) {
  mkdirSync(outRoot, { recursive: true });
  appendFileSync(join(outRoot, "routes.jsonl"), JSON.stringify({ ts: new Date().toISOString(), task: task.slice(0, 200), ...d, ...extra }) + "\n");
}

const rewrite = (outRoot: string, r: { runId: string }) =>
  writeFileSync(join(outRoot, r.runId, "report.json"), JSON.stringify(r, null, 2));

export async function auto(opts: AutoOptions): Promise<AutoResult> {
  const log = opts.log ?? (() => undefined);
  const decision = await decideRoute(opts);
  logRoute(opts.outRoot, opts.task, decision);
  log(`route: ${decision.mode} (${decision.source}) - ${decision.reason}`);

  let spentBefore = decision.costUsd;
  const earlier: Record<string, number> = decision.costUsd > 0 ? { triager: decision.costUsd } : {};
  let result: AutoResult = { decision, escalated: false };

  if (decision.mode !== "orchestrate") {
    const soloReport = await solo({ ...opts, review: decision.mode === "reviewed" });
    soloReport.spentUsd += decision.costUsd;
    Object.assign(soloReport.costByRole, earlier);
    rewrite(opts.outRoot, soloReport);
    result = { decision, soloReport, escalated: false };

    const mayEscalate = decision.source !== "forced" && opts.escalate !== false;
    if (soloReport.ok || !mayEscalate) return result;

    // The cheap route failed: fall back to the pipeline. The failed session's edits stay uncommitted in the working
    // tree (never reverted: they may sit beside the user's own changes); the pipeline works from HEAD in worktrees.
    const why = (soloReport.error ?? "failed").replace(/\s+/g, " ").slice(0, 160);
    const escalated: Decision = { ...decision, mode: "orchestrate", source: "escalated", reason: `${decision.mode} session failed (${why}); rerunning through the pipeline`, costUsd: 0 };
    logRoute(opts.outRoot, opts.task, escalated, { from: decision.mode });
    log(`route: orchestrate (escalated) - ${escalated.reason}`);
    spentBefore = soloReport.spentUsd;
    Object.assign(earlier, soloReport.costByRole);
    result = { decision: escalated, soloReport, escalated: true };
  }

  // With an explicit budget, what was already spent counts against it. Either way it shows up in the report.
  const runBudgetUsd = opts.runBudgetUsd === undefined ? undefined : Math.max(opts.runBudgetUsd - spentBefore, 0.01);
  const report = await orchestrate({ ...opts, runBudgetUsd });
  if (spentBefore > 0) {
    report.spentUsd += spentBefore;
    for (const [role, cost] of Object.entries(earlier)) report.costByRole[role] = (report.costByRole[role] ?? 0) + cost;
    rewrite(opts.outRoot, report);
  }
  return { ...result, report };
}
