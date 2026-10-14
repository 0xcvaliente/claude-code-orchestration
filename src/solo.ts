import type { RunAgent } from "./agent.js";
import { LIMITS } from "./config.js";
import { sh } from "./git.js";
import { newRunId, Run } from "./state.js";
import { parseVerdict, VERDICT_SCHEMA } from "./verdict.js";

export interface SoloReport {
  runId: string;
  /** The session finished without error, the tests pass (when a command was given) and the reviewer passed (when one ran). */
  ok: boolean;
  testsPassed?: boolean;
  /** Set only on the reviewed route. */
  reviewPassed?: boolean;
  /** Sessions run: 1 plus one per round of reviewer or test feedback. */
  attempts: number;
  spentTokens: number;
  tokensByRole: Record<string, number>;
  error?: string;
}

export interface SoloOptions {
  repo: string;
  task: string;
  outRoot: string;
  run: RunAgent;
  testCmd?: string;
  /** Add one independent reviewer after the session; its issues go back to the session, up to `maxRetries` times. */
  review?: boolean;
  maxRetries?: number;
  log?: (line: string) => void;
}

/**
 * The plain-session route: one agent, the repo itself, no worktrees, no planner.
 * Changes stay uncommitted in the working tree, as in an interactive session.
 * With `review`, an independent fresh-context reviewer checks the result before it is called done.
 */
export async function solo(opts: SoloOptions): Promise<SoloReport> {
  const log = opts.log ?? (() => undefined);
  const run = new Run(newRunId(), opts.outRoot);
  const report: SoloReport = { runId: run.id, ok: false, attempts: 0, spentTokens: 0, tokensByRole: {} };
  const rounds = (opts.review ? (opts.maxRetries ?? LIMITS.maxRetries) : 0) + 1;
  let feedback = "";

  for (let attempt = 1; attempt <= rounds; attempt++) {
    report.attempts = attempt;
    delete report.error;
    const r = await opts.run({
      role: "solo",
      cwd: opts.repo,
      prompt:
        `Task:\n${opts.task}\n\n` +
        (opts.testCmd ? `Before you finish, run \`${opts.testCmd}\` and fix any failure.\n` : "") +
        (feedback ? `\nA reviewer rejected the earlier attempt, whose changes are already in the working tree. Fix these problems:\n${feedback}\n` : "") +
        `Leave your changes uncommitted.`,
    });
    run.charge("solo", `session#${attempt}`, r);
    log(`solo: ${r.ok ? "finished" : `failed (${r.subtype})`}`);
    if (!r.ok) {
      report.error = `session failed: ${r.subtype}`;
      break;
    }

    // The gates do not trust the agent's claim: run the tests ourselves, as the pipeline does for each slice.
    if (opts.testCmd) {
      const t = await sh(opts.testCmd, opts.repo, LIMITS.testTimeoutMs);
      report.testsPassed = t.code === 0;
      log(`solo: tests ${report.testsPassed ? "pass" : `fail (exit ${t.code})`}`);
      if (!report.testsPassed) {
        report.error = `tests failed (exit ${t.code}): ${t.output.slice(-1000)}`;
        feedback = `Tests failed (exit ${t.code}):\n${t.output.slice(-3000)}`;
        if (opts.review && attempt < rounds) continue;
        break;
      }
    }

    if (!opts.review) break;
    const v = await opts.run({
      role: "verifier",
      cwd: opts.repo,
      schema: VERDICT_SCHEMA,
      prompt:
        `Goal:\n${opts.task}\n\nThe change is uncommitted in the working tree. Review it with \`git diff HEAD\`, and read any ` +
        `untracked files listed by \`git status --short\`. Run the tests if you can find them. Return your verdict as JSON.`,
    });
    run.charge("verifier", `review#${attempt}`, v);
    const verdict = v.ok ? parseVerdict(v.structured) : { pass: false, issues: [`reviewer failed: ${v.subtype}`] };
    report.reviewPassed = verdict.pass;
    log(`solo: review ${verdict.pass ? "pass" : `fail (${verdict.issues.length} issue(s))`}`);
    if (verdict.pass) break;
    feedback = verdict.issues.join("\n");
    report.error = `review failed: ${feedback.slice(0, 500)}`;
  }

  report.ok = !report.error && report.testsPassed !== false && report.reviewPassed !== false;
  report.spentTokens = run.spentTokens;
  report.tokensByRole = run.tokensByRole();
  run.save("report.json", report);
  return report;
}
