import { join } from "node:path";
import type { RunAgent } from "./agent.js";
import { LIMITS } from "./config.js";
import { addWorktree, CommitError, commitAll, deleteBranch, git, headRef, mergeAll, removeWorktree, sh } from "./git.js";
import type { Run } from "./state.js";
import { parseVerdict, VERDICT_SCHEMA } from "./verdict.js";

export interface Slice { id: string; goal: string; files: string[]; acceptance: string; dependsOn: string[] }
export interface SliceResult {
  id: string;
  branch: string;
  /** replaced: failed, then superseded by a replan. Its branch stays as history and is never merged. */
  status: "passed" | "failed" | "replaced";
  attempts: number;
  issues: string[];
}

/** Everything one slice's lifecycle needs; fixed for the whole run once planning is done. */
export interface SliceContext {
  run: RunAgent;
  /** The run's directory and token ledger: worktrees live under it, every worker is charged to it. */
  state: Run;
  repo: string;
  base: string;
  task: string;
  /**
   * The user's request as given on THIS invocation, for the judge only (AgentRequest.task). Never read back from disk:
   * workers can edit journal.json. Empty on a resume with no task passed, so the judge refuses pushes and deletes.
   */
  judgeTask: string;
  findings: string;
  maxRetries: number;
  /** Token cap; unset means no cap. */
  budget?: number;
  setupCmd?: string;
  testCmd?: string;
  /** Resuming: a failed slice's leftover worktree and branch are dropped before it starts over. */
  resumed: boolean;
  /** Results so far; dependencies are looked up here. */
  finished: ReadonlyMap<string, SliceResult>;
  log: (line: string) => void;
}

/** An error that ended a slice outside its checks (a git error, say), with the attempts made before it. */
export class SliceError extends Error {
  constructor(cause: unknown, readonly attempts: number) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SliceError";
  }
}

/**
 * Write (isolated worktree) -> cheap gate -> independent verify -> retry with feedback. A failed commit (a commit hook)
 * is the next attempt's feedback. May throw on git errors; one inside the attempt loop is a SliceError with the attempts.
 */
export async function runSlice(ctx: SliceContext, slice: Slice): Promise<SliceResult> {
  const { run: runAgent, state: run, repo, base, task, judgeTask, findings, maxRetries, budget, finished, log } = ctx;
  const dir = join(run.dir, "worktrees", slice.id);
  const branch = `orch/${run.id}/${slice.id}`;
  const res: SliceResult = { id: slice.id, branch, status: "failed", attempts: 0, issues: [] };

  const blocked = slice.dependsOn.filter((d) => finished.get(d)?.status !== "passed");
  if (blocked.length > 0) {
    res.issues = [`skipped: dependency failed (${blocked.join(", ")})`];
    log(`${slice.id}: ${res.issues[0]}`);
    return res;
  }
  if (ctx.resumed) {
    // A failed slice from the earlier session starts over: drop its leftover worktree and branch.
    await removeWorktree(repo, dir);
    await deleteBranch(repo, branch);
  }
  await addWorktree(repo, dir, branch, base);
  // Start from the dependencies' work; the verifier then reviews only this slice's own diff.
  const deps = slice.dependsOn.map((d) => finished.get(d)!.branch);
  const { conflicted } = await mergeAll(dir, deps);
  if (conflicted.length > 0) {
    res.issues = [`could not combine dependencies (${conflicted.join(", ")})`];
    return res;
  }
  if (ctx.setupCmd) {
    const s = await sh(ctx.setupCmd, dir, LIMITS.testTimeoutMs);
    if (s.code !== 0) {
      res.issues = [`setup failed (exit ${s.code}): ${s.output.slice(-1000)}`];
      log(`${slice.id}: ${res.issues[0]!.split("\n")[0]}`);
      return res;
    }
  }
  const sliceBase = await headRef(dir);
  let feedback = "";

  try {
    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      if (budget !== undefined && run.overBudget(budget)) {
        res.issues = ["run budget exhausted"];
        break;
      }
      res.attempts = attempt;
      log(`${slice.id}: attempt ${attempt}`);

      const w = await runAgent({
        role: "writer",
        cwd: dir,
        task: judgeTask,
        auditFile: join(run.dir, "judge-audit.jsonl"),
        prompt:
          `Overall task:\n${task}\n\nYour slice (${slice.id}):\nGoal: ${slice.goal}\n` +
          `Files likely involved: ${slice.files.join(", ") || "unspecified"}\nAcceptance: ${slice.acceptance}\n\n` +
          `Exploration findings:\n${findings || "(none)"}\n` +
          (feedback ? `\nA previous attempt is already in this worktree but was rejected. Fix these problems:\n${feedback}\n` : ""),
      });
      run.charge("writer", `${slice.id}#${attempt}`, w);
      if (!w.ok) {
        feedback = `The previous attempt ended with: ${w.subtype}. ${w.text}`.trim();
        res.issues = [feedback];
        continue;
      }
      try {
        await commitAll(dir, `orchestrator: ${slice.id} (attempt ${attempt})`);
      } catch (err) {
        if (!(err instanceof CommitError)) throw err;
        // A commit hook said no (a lint finding, say): its output is the next attempt's feedback. Hooks are never skipped.
        feedback = `Committing your work failed; git and the repository's commit hook said:\n${err.output.slice(-3000)}`;
        res.issues = [feedback];
        continue;
      }
      // An attempt that adds no commit is fine when an earlier one committed work; a branch empty against its base is not.
      if ((await git(dir, "diff", "--name-only", sliceBase, "HEAD")) === "") {
        feedback = "The worker made no changes. Implement the slice.";
        res.issues = [feedback];
        continue;
      }

      if (ctx.testCmd) {
        const t = await sh(ctx.testCmd, dir, LIMITS.testTimeoutMs);
        if (t.code !== 0) {
          feedback = `Tests failed (exit ${t.code}):\n${t.output.slice(-3000)}`;
          res.issues = [feedback];
          continue;
        }
      }

      const v = await runAgent({
        role: "verifier",
        cwd: dir,
        task: judgeTask,
        auditFile: join(run.dir, "judge-audit.jsonl"),
        schema: VERDICT_SCHEMA,
        prompt:
          `Goal: ${slice.goal}\nAcceptance: ${slice.acceptance}\n\n` +
          `The change is committed on this branch. Review it with \`git diff ${sliceBase}...HEAD\`, run the tests if you can, ` +
          `and return your verdict as JSON.`,
      });
      run.charge("verifier", `${slice.id}#${attempt}`, v);
      const verdict = v.ok ? parseVerdict(v.structured) : { pass: false, issues: [`verifier failed: ${v.subtype}`] };
      if (verdict.pass) {
        res.status = "passed";
        res.issues = [];
        break;
      }
      feedback = verdict.issues.join("\n");
      res.issues = verdict.issues;
    }
  } catch (err) {
    // Any other error (a git error, say) still ends the slice, now with the attempts it had made.
    throw new SliceError(err, res.attempts);
  }
  log(`${slice.id}: ${res.status}`);
  return res;
}
