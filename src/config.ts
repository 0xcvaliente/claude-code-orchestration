// Role tiers and limits. Model IDs are overridable per role: ORCH_MODEL_PLANNER, etc.

export type Role = "planner" | "explorer" | "writer" | "verifier";

export interface RoleConfig {
  model: string;
  effort: "low" | "medium" | "high";
  maxTurns: number;
  maxBudgetUsd: number;
  tools: string[];
  disallowedTools: string[];
  system: string;
}

const env = (key: string, fallback: string) => process.env[key] || fallback;

// Never let a worker publish or escalate; the orchestrator owns git history.
// `git * push*` also catches `git -C dir push` and `git -c k=v push`. Keep in step with permissions.deny in
// .claude/settings.json (policy.test.ts fails on drift). A guard against mistakes, not a sandbox: see README Limits.
export const UNSAFE_BASH = [
  "Bash(git push*)", "Bash(git * push*)", "Bash(git remote*)", "Bash(git * remote*)",
  "Bash(sudo*)", "Bash(rm -rf*)", "Bash(rm -fr*)", "Bash(rm -r -f*)", "Bash(rm -f -r*)",
];
const READ_ONLY = ["Read", "Glob", "Grep"];

export const ROLES: Record<Role, RoleConfig> = {
  planner: {
    model: env("ORCH_MODEL_PLANNER", "claude-opus-5-5"),
    effort: "high",
    maxTurns: 20,
    maxBudgetUsd: 1.5,
    tools: READ_ONLY,
    disallowedTools: [],
    system:
      "You are the planner in an orchestrated workflow. You only read the repository; you never edit it. " +
      "Answer with the requested JSON and nothing else.",
  },
  explorer: {
    model: env("ORCH_MODEL_EXPLORER", "claude-haiku-5-5"),
    effort: "low",
    maxTurns: 15,
    maxBudgetUsd: 0.25,
    tools: READ_ONLY,
    disallowedTools: [],
    system:
      "You are a read-only explorer. Answer the question with concrete file paths and line references. " +
      "Reply in at most 250 words. Do not paste large code blocks.",
  },
  writer: {
    model: env("ORCH_MODEL_WRITER", "claude-sonnet-5-5"),
    effort: "medium",
    maxTurns: 40,
    maxBudgetUsd: 2.0,
    tools: [...READ_ONLY, "Edit", "Write", "Bash"],
    disallowedTools: UNSAFE_BASH,
    system:
      "You implement exactly one slice of a larger task inside your own git worktree. " +
      "Touch only the files your slice needs. Do not run git commit, push, or branch commands; the orchestrator commits. " +
      "When finished, reply with a two-sentence summary of what you changed.",
  },
  verifier: {
    model: env("ORCH_MODEL_VERIFIER", "claude-sonnet-5-5"),
    effort: "medium",
    maxTurns: 25,
    maxBudgetUsd: 1.0,
    tools: [...READ_ONLY, "Bash"],
    disallowedTools: UNSAFE_BASH,
    system:
      "You are an independent reviewer with fresh context. You did not write this code. " +
      "Check the diff against the goal and acceptance criteria, run the project's tests if you can find them, " +
      "and look for bugs, missing cases, and unrelated changes. Never modify files. " +
      "Pass only if the acceptance criteria are met.",
  },
};

export const LIMITS = {
  concurrency: 3,
  maxRetries: 2,
  maxSlices: 6,
  maxQuestions: 4,
  runBudgetUsd: 10,
  workerTimeoutMs: 15 * 60_000,
  testTimeoutMs: 10 * 60_000,
};
