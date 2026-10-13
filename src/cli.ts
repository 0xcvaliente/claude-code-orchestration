import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { runAgent } from "./agent.js";
import { count, usd } from "./args.js";
import { isDirty } from "./git.js";
import { orchestrate } from "./orchestrator.js";

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
  },
});

if (!values.repo || !values.task) {
  console.error(
    'usage: npm start -- --repo <git repo> --task "<what to do>" [--test-cmd "npm test"] [--setup-cmd "npm ci"] ' +
      "[--budget USD] [--concurrency N] [--retries N] [--plan-only] [--keep-worktrees] [--out DIR]",
  );
  process.exit(2);
}

let limits: { runBudgetUsd?: number; concurrency?: number; maxRetries?: number };
try {
  limits = {
    runBudgetUsd: values.budget === undefined ? undefined : usd("--budget", Number(values.budget)),
    concurrency: values.concurrency === undefined ? undefined : count("--concurrency", Number(values.concurrency), 1),
    maxRetries: values.retries === undefined ? undefined : count("--retries", Number(values.retries), 0),
  };
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}

const repo = resolve(values.repo);
try {
  if (await isDirty(repo)) {
    console.warn("warning: the repo has uncommitted changes; workers branch from HEAD and will not see them.");
  }
} catch {
  console.error(`error: ${repo} is not a git repository (or does not exist)`);
  process.exit(2);
}

const report = await orchestrate({
  repo,
  task: values.task,
  outRoot: resolve(values.out),
  run: runAgent,
  testCmd: values["test-cmd"],
  setupCmd: values["setup-cmd"],
  keepWorktrees: values["keep-worktrees"],
  planOnly: values["plan-only"],
  ...limits,
  log: (line) => console.log(line),
});

console.log(`\nrun ${report.runId}  spent $${report.spentUsd.toFixed(2)}  by role: ${JSON.stringify(report.costByRole)}`);
for (const s of report.slices) console.log(`  ${s.status.padEnd(6)} ${s.id} (${s.attempts} attempt(s)) ${s.issues[0] ?? ""}`);
if (report.resultBranch) {
  console.log(`result branch: ${report.resultBranch} (merged ${report.merged.length}, conflicted ${report.conflicted.length})`);
}
if (report.error) console.error(`error: ${report.error}`);
process.exit(report.error || report.slices.some((s) => s.status === "failed") || report.conflicted.length > 0 ? 1 : 0);
