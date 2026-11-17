import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { orchestrate, type OrchestrateOptions, type Report } from "./orchestrator.js";
import { solo, type SoloReport } from "./solo.js";
import { triage, type Decision } from "./triage.js";

export type RequestedMode = "auto" | "plain" | "reviewed" | "orchestrate";
export const MODES: readonly RequestedMode[] = ["auto", "plain", "reviewed", "orchestrate"];
/** The least run budget left for which a failed plain or reviewed session is rerun through the pipeline (--budget's floor). */
export const MIN_ESCALATION_TOKENS = 10_000;

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

/**
 * Choose the route for one task. A forced mode, --plan-only and --resume skip triage and use no tokens.
 * `triageBudgetTokens` caps the triage call (src/route.ts --budget); `auto` passes none, so the SDK CLI's triage is uncapped.
 */
export async function decideRoute(
  opts: Pick<AutoOptions, "run" | "repo" | "task" | "mode" | "planOnly" | "resume"> & { triageBudgetTokens?: number },
): Promise<Decision> {
  if (opts.planOnly || opts.resume) {
    // Both only mean something for the pipeline, so they imply that route.
    return { mode: "orchestrate", source: "forced", reason: opts.resume ? "--resume" : "--plan-only", tokens: 0 };
  }
  const requested = opts.mode ?? "auto";
  if (requested !== "auto") return { mode: requested, source: "forced", reason: `--mode ${requested}`, tokens: 0 };
  return triage({ run: opts.run, repo: opts.repo, task: opts.task, ...(opts.triageBudgetTokens !== undefined && { budgetTokens: opts.triageBudgetTokens }) });
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

  let spentBefore = decision.tokens;
  const earlier: Record<string, number> = decision.tokens > 0 ? { triager: decision.tokens } : {};
  let result: AutoResult = { decision, escalated: false };

  if (decision.mode !== "orchestrate") {
    const soloReport = await solo({ ...opts, review: decision.mode === "reviewed" });
    soloReport.spentTokens += decision.tokens;
    Object.assign(soloReport.tokensByRole, earlier);
    rewrite(opts.outRoot, soloReport);
    result = { decision, soloReport, escalated: false };

    const mayEscalate = decision.source !== "forced" && opts.escalate !== false;
    if (soloReport.ok || !mayEscalate) return result;
    // With a budget, the pipeline starts only with at least MIN_ESCALATION_TOKENS left (CHANGELOG 1.4.5: a session the
    // cap stopped escalated with almost nothing left, so a little more was spent). The same floor as `npm run auto`.
    const left = opts.runBudgetTokens === undefined ? undefined : opts.runBudgetTokens - soloReport.spentTokens;
    if (left !== undefined && left < MIN_ESCALATION_TOKENS) {
      soloReport.error = `${soloReport.error ?? "failed"}; not rerun through the pipeline: ${Math.max(left, 0)} tokens of the run budget left, fewer than ${MIN_ESCALATION_TOKENS}`;
      rewrite(opts.outRoot, soloReport);
      log(`route: no escalation - ${Math.max(left, 0)} tokens of the run budget left`);
      return result;
    }

    // The cheap route failed: fall back to the pipeline. The failed session's edits stay uncommitted in the working
    // tree (never reverted: they may sit beside the user's own changes); the pipeline works from HEAD in worktrees.
    const why = (soloReport.error ?? "failed").replace(/\s+/g, " ").slice(0, 160);
    // tokens 0: the triage call is not this decision's; neither is its cost.
    const { costUsd: _triageCost, ...earlierDecision } = decision;
    const escalated: Decision = { ...earlierDecision, mode: "orchestrate", source: "escalated", reason: `${decision.mode} session failed (${why}); rerunning through the pipeline`, tokens: 0 };
    logRoute(opts.outRoot, opts.task, escalated, { from: decision.mode });
    log(`route: orchestrate (escalated) - ${escalated.reason}`);
    spentBefore = soloReport.spentTokens;
    Object.assign(earlier, soloReport.tokensByRole);
    result = { decision: escalated, soloReport, escalated: true };
  }

  // With an explicit budget, what was already spent counts against it. Either way it shows up in the report.
  const runBudgetTokens = opts.runBudgetTokens === undefined ? undefined : Math.max(opts.runBudgetTokens - spentBefore, 1);
  const report = await orchestrate({ ...opts, runBudgetTokens });
  if (spentBefore > 0) {
    report.spentTokens += spentBefore;
    for (const [role, tokens] of Object.entries(earlier)) report.tokensByRole[role] = (report.tokensByRole[role] ?? 0) + tokens;
    rewrite(opts.outRoot, report);
  }
  return { ...result, report };
}
