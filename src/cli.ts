import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runAgent as baseAgent } from "./agent.js";
import { withTransientRetry } from "./retry.js";
import { count, parseTokens } from "./args.js";
import { formatTokens } from "./tokens.js";
import { isDirty } from "./git.js";
import { auto, MODES, type RequestedMode } from "./auto.js";

const runAgent = withTransientRetry(baseAgent);
const byRole = (tokens: Record<string, number>) => Object.entries(tokens).map(([role, n]) => `${role} ${formatTokens(n)}`).join(", ");

// The pipeline plans, branches and merges in git worktrees, so it is for code in a git repository only.
const SCOPE = "The SDK pipeline (npm start) works on code in a git repository.";
const OTHER_TASKS = "For other tasks (research, writing, analysis, operations) use the plugin's /route, `claude --agent orchestrator` or `npm run auto`.";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    task: { type: "string" },
    "test-cmd": { type: "string" },
    "setup-cmd": { type: "string" },
    "keep-worktrees": { type: "boolean", default: false },
    out: { type: "string", default: "runs" },
    budget: { type: "string" },
    concurrency: { type: "string" },
    retries: { type: "string" },
    "plan-only": { type: "boolean", default: false },
    mode: { type: "string", default: "auto" },
    resume: { type: "string" },
    replans: { type: "string" },
    "no-escalate": { type: "boolean", default: false },
  },
});

if (!values.repo || !(values.task || values.resume)) {
  console.error(
    'usage: npm start -- --repo <git repo> --task "<what to do>" [--test-cmd "npm test"] [--setup-cmd "npm ci"] ' +
      "[--mode auto|plain|reviewed|orchestrate] [--no-escalate] [--budget TOKENS] [--concurrency N] [--retries N] [--replans N] " +
      `[--plan-only] [--keep-worktrees] [--out DIR]\n       npm start -- --repo <git repo> --resume <run id> [--out DIR]\n${SCOPE} ${OTHER_TASKS}`,
  );
  process.exit(2);
}

let limits: { runBudgetTokens?: number; concurrency?: number; maxRetries?: number; maxReplans?: number };
try {
  limits = {
    runBudgetTokens: values.budget === undefined ? undefined : parseTokens("--budget", values.budget),
    concurrency: values.concurrency === undefined ? undefined : count("--concurrency", Number(values.concurrency), 1),
    maxRetries: values.retries === undefined ? undefined : count("--retries", Number(values.retries), 0),
    maxReplans: values.replans === undefined ? undefined : count("--replans", Number(values.replans), 0),
  };
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

if (!MODES.includes(values.mode as RequestedMode)) {
  console.error(`--mode must be one of ${MODES.join(", ")} (got ${values.mode})`);
  process.exit(2);
}

const repo = resolve(values.repo);
try {
  if (await isDirty(repo)) {
    console.warn("warning: the repo has uncommitted changes; workers branch from HEAD and will not see them.");
  }
} catch {
  console.error(`error: ${repo} is not a git repository (or does not exist). ${SCOPE} ${OTHER_TASKS}`);
  process.exit(2);
}

const { report, soloReport, escalated } = await auto({
  mode: values.mode as RequestedMode,
  repo,
  task: values.task ?? "",
  resume: values.resume,
  escalate: !values["no-escalate"],
  outRoot: resolve(values.out),
  run: runAgent,
  testCmd: values["test-cmd"],
  setupCmd: values["setup-cmd"],
  keepWorktrees: values["keep-worktrees"],
  planOnly: values["plan-only"],
  ...limits,
  log: (line) => console.log(line),
});

if (soloReport && !escalated) {
  const kind = soloReport.reviewPassed === undefined ? "plain session" : "plain session + reviewer";
  console.log(`\nrun ${soloReport.runId}  ${kind}  ${formatTokens(soloReport.spentTokens)} tokens  by role: ${byRole(soloReport.tokensByRole)}`);
  if (soloReport.testsPassed !== undefined) console.log(`  tests ${soloReport.testsPassed ? "pass" : "fail"}`);
  if (soloReport.reviewPassed !== undefined) console.log(`  review ${soloReport.reviewPassed ? "pass" : "fail"} (${soloReport.attempts} session(s))`);
  console.log("  changes are uncommitted in the working tree");
  if (soloReport.error) console.error(`error: ${soloReport.error}`);
  process.exit(soloReport.ok ? 0 : 1);
}
if (escalated) console.warn("note: the failed plain attempt's edits are still uncommitted in the working tree; the pipeline result is on its own branch.");
if (!report) process.exit(1);
console.log(`\nrun ${report.runId}  ${formatTokens(report.spentTokens)} tokens  by role: ${byRole(report.tokensByRole)}`);
for (const s of report.slices) console.log(`  ${s.status.padEnd(6)} ${s.id} (${s.attempts} attempt(s)) ${s.issues[0] ?? ""}`);
if (report.replans > 0) console.log(`  replanned ${report.replans} time(s)`);
if (report.error || report.slices.some((s) => s.status === "failed")) console.log(`  resume with: npm start -- --repo ${repo} --resume ${report.runId}`);
if (report.resultBranch) {
  console.log(`result branch: ${report.resultBranch} (merged ${report.merged.length}, conflicted ${report.conflicted.length})`);
}
if (report.error) console.error(`error: ${report.error}`);
process.exit(report.error || report.slices.some((s) => s.status === "failed") || report.conflicted.length > 0 ? 1 : 0);
