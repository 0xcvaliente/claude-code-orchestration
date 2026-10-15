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
// `git * push*` also catches `git -C dir push` and `git -c k=v push`.
export const PUSH_BASH = ["Bash(git push*)", "Bash(git * push*)"];
// scripts/orchestrate.sh passes all of it to headless runs as --disallowedTools (verify.test.ts fails on drift).
// Everything here except PUSH_BASH is also in permissions.deny in .claude/settings.json (policy.test.ts fails on
// drift); interactive sessions may push as their permission mode allows. A guard against mistakes, not a sandbox: see
// README Limits.
export const UNSAFE_BASH = [
  ...PUSH_BASH, "Bash(git remote*)", "Bash(git * remote*)",
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
      "You size tasks (code, research, writing, analysis or operations) so the orchestrator can choose between a plain session and a multi-agent pipeline. " +
      "You only read the folder; you never edit it and never plan the work. Answer with the requested JSON and nothing else.",
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
 * When the pipeline pays for itself. The benchmark in docs/benchmarks.md (2 runs per cell, direction only) found no
 * correctness gain: every setup solved the small and medium tasks, where orchestration used 1.2x to 2.1x the tokens of a
 * plain session of the same model family and took longer; on the large splittable tasks (k1, k2) plain sessions spawned
 * built-in subagents and plain Opus reached full score sooner (on h3 the shipped orchestrator did, 7 vs 8 min median),
 * and on large tasks orchestration used 0.7x to 2.0x the tokens (median per task). False
 * successes: 1 in 28 plain runs, 0 in 28 orchestrated. The gates are what it adds.
 *
 * Tuning from that benchmark (2 reps, coding tasks only, so a direction, not a measurement): minParallelFiles went from 4
 * to 10. Triage had sent t1 (4 files, ~70 lines, 2 slices), h1 (9 files, ~1300 lines, 3 slices) and h2 (9 files, ~600
 * lines, 2 slices) to the pipeline, which used 1.1x to 2.8x the tokens of a plain Sonnet session (what `npm run auto`
 * runs for plain) at the same 100% score. Replayed through decide(), those 5 of 14 AUTO decisions now go plain and the
 * other 9 are unchanged. bigLines stays 1500: raising it to 2000 would send k1 (4 files, ~1800 lines, 4 slices) plain,
 * where plain Sonnet scored 98.8% against the shipped orchestrator's 99.9%. bigFiles stays 12: on k2 (12 files) plain
 * Sonnet scored no better than the orchestrator. No task had 10 or 11 files, so 10 is the lowest value the data allows,
 * not a measured optimum.
 */
export const TRIAGE = {
  /** At least this many independent slices ... */
  minParallelSlices: 2,
  /** ... and at least this many files in total make parallel worktrees worth their overhead. */
  minParallelFiles: 10,
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
