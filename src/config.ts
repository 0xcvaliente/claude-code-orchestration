// Role tiers and limits. Model IDs are overridable per role: ORCH_MODEL_PLANNER, etc.

export type Role = "planner" | "explorer" | "writer" | "verifier" | "triager" | "solo";

export interface RoleConfig {
  model: string;
  effort: "low" | "medium" | "high";
  maxTurns: number;
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
  triager: {
    model: env("ORCH_MODEL_TRIAGER", "claude-sonnet-5-5"),
    effort: "low",
    maxTurns: 12,
    tools: READ_ONLY,
    disallowedTools: [],
    system:
      "You size coding tasks so the orchestrator can choose between a plain session and a multi-agent pipeline. " +
      "You only read the repository; you never edit it and never plan the work. Answer with the requested JSON and nothing else.",
  },
  solo: {
    model: env("ORCH_MODEL_SOLO", "claude-sonnet-5-5"),
    effort: "medium",
    maxTurns: 60,
    tools: [...READ_ONLY, "Edit", "Write", "Bash"],
    disallowedTools: UNSAFE_BASH,
    system:
      "You do the whole task yourself in this repository, as one plain session. Make focused changes, run the project's tests, " +
      "and fix failures. Leave your changes uncommitted in the working tree; never run git commit, push, or branch commands. " +
      "When finished, reply with a short summary and the command you ran to check the work.",
  },
  planner: {
    model: env("ORCH_MODEL_PLANNER", "claude-opus-5-5"),
    effort: "high",
    maxTurns: 20,
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
    tools: [...READ_ONLY, "Bash"],
    disallowedTools: UNSAFE_BASH,
    system:
      "You are an independent reviewer with fresh context. You did not write this code. " +
      "Check the diff against the goal and acceptance criteria, run the project's tests if you can find them, " +
      "and look for bugs, missing cases, and unrelated changes. Never modify files. " +
      "Pass only if the acceptance criteria are met.",
  },
};

/**
 * When the pipeline pays for itself. Measured in README "Benchmark": it matched a plain session on correctness, cost
 * 1.1x to 2x more, and was faster only when slices ran in parallel. So it is chosen for parallel, large or risky work.
 */
export const TRIAGE = {
  /** At least this many independent slices ... */
  minParallelSlices: 2,
  /** ... and at least this many files in total make parallel worktrees worth their overhead. */
  minParallelFiles: 4,
  /** This many files no longer fit one session's context comfortably. */
  bigFiles: 12,
  /** A risky change this small gets a plain session plus one independent reviewer instead of the whole pipeline. */
  reviewedMaxFiles: 3,
  /** A change this many lines with at least minParallelSlices independent parts is worth splitting even across few files: an interface-first plan lets slices run in parallel. */
  bigLines: 1500,
  /** A risky change gets the reviewed route only when it is also this many lines or fewer. */
  reviewedMaxLines: 200,
};

export const LIMITS = {
  concurrency: 3,
  maxRetries: 2,
  maxSlices: 6,
  maxQuestions: 4,
  workerTimeoutMs: 15 * 60_000,
  /** Service errors (rate limit, overload, dropped stream) are retried this many times with exponential backoff. */
  transientRetries: 2,
  transientBackoffMs: 2_000,
  testTimeoutMs: 10 * 60_000,
};
