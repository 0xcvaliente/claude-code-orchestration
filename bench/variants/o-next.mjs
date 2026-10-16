// O-next: the revised orchestration proposals as an overlay on the shipped .claude/, for benchmarking against O-mix.
// The shipped files stay the baseline; this only edits a run repo's copy. Changes:
//   1. Plan check in code: hooks/plan-check.mjs (PreToolUse on Agent) blocks an implementer whose FILES overlap
//      another slice's or whose DEPENDS closes a cycle. Briefs carry SLICE, FILES and DEPENDS lines.
//   2. Plan review: the orchestrator sends the plan to a reviewer (brief starts PLAN REVIEW) before implementing.
//   3. Per-slice review as each implementer returns (isolated code slices: on their branch, before integration),
//      with an optional FOCUS line in reviewer briefs.
//   4. Editor slice: a final implementer that aligns the sections of a document deliverable.
//   5. Run journal: hooks/journal.mjs (PostToolUse on Agent records the brief's slice by agent id, SubagentStop the
//      result) records each slice's results; the orchestrator resumes from it, and plan-check reads the plan review.
//      plan-check also blocks the first implementers until a PLAN REVIEW reviewer finished (PATH: light skips it).
// Every edit replaces an anchor that must occur exactly once in the shipped file, so a drifted prompt fails loudly
// (bench/o-next.test.mjs applies the overlay to this repo's .claude/ on every npm test).
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(dirname(fileURLToPath(import.meta.url)), "o-next");
export const HOOKS = ["plan-check.mjs", "journal.mjs"];

const hook = (script) => ({ type: "command", command: `node "\${CLAUDE_PROJECT_DIR}/.claude/hooks/${script}"` });
export const SETTINGS_HOOKS = {
  PreToolUse: [{ matcher: "Agent|Task", hooks: [hook("plan-check.mjs")] }],
  PostToolUse: [{ matcher: "Agent|Task", hooks: [hook("journal.mjs")] }],
  SubagentStop: [{ hooks: [hook("journal.mjs")] }],
};

const ORCHESTRATOR_EDITS = [
  [
    "Two slices never own the same file.",
    "Two slices never own the same file, except a final editor slice: when the deliverable is a document, report or research write-up split over several slices, plan a last slice for an `implementer` that lists every section slice in DEPENDS, owns their files, and aligns terms, removes repetition and fixes cross-references without changing substance. It is reviewed like any slice.",
  ],
  [
    "\n3. Implement: one `implementer` per slice.",
    "\n2a. Plan review (full path only, not the light path): before any implementer starts, send one `reviewer` a brief that starts with PLAN REVIEW and holds the task text verbatim, the researchers' findings and the plan. Wait for its report before launching any implementer: a plan-check hook blocks the first implementers until a plan review has finished. Fix every gap it reports in the plan. Review again only if you added or removed a slice; after one fix, go on.\n3. Implement: one `implementer` per slice.",
  ],
  [
    "4. Integrate (isolated code slices only): send the branch names to the `integrator`",
    "4. Integrate (isolated code slices only): once every slice of the wave has passed its branch review (step 5) or failed for good, send the passed branch names to the `integrator`",
  ],
  [
    "5. Review: send each finished slice",
    "5. Review: review each slice as soon as its implementer returns; do not wait for the rest of its wave, so a retry starts while other slices still run. An isolated code slice is reviewed on its branch before integration: give the reviewer the branch name and tell it to review `git -C <project> diff HEAD...<branch>`, and to run the acceptance check against that branch's worktree (`git worktree list` shows it) when it can without `cd`, for example `npm --prefix <worktree> test` or `python3 <worktree>/tests/<runner>.py`. After the integrator merges the passed branches, one final `reviewer` runs the full acceptance check on the merged result. For every review: send each finished slice",
  ],
  [
    'Paste the relevant plan text; do not refer to "the plan above".',
    'Paste the relevant plan text; do not refer to "the plan above".\n\nEvery implementer brief starts with three lines a plan-check hook reads before the implementer starts: `SLICE: <id>`, `FILES: <the files it owns, comma-separated>` and `DEPENDS: <ids of slices it runs after, or none>`. The hook blocks a brief whose FILES overlap a file another slice owns, unless that slice is in DEPENDS, and one whose DEPENDS closes a cycle. When it blocks, fix the plan; never rename a slice to get past it. A retry keeps the same SLICE id. On the light path, add a fourth line, `PATH: light`, so the hook does not wait for a plan review. It counts only for a task with a single slice: once a second slice launches, the hook waits for the plan review anyway, so never add it to a plan with several slices. Reviewer briefs start with `SLICE: <id>` too and may add `FOCUS: <what to check hardest>`, for example the edge cases of a risky module or every cited source.',
  ],
  [
    "For code in git, reviewers examine the integrated result in the project directory.",
    "For code in git, reviewers examine the integrated result in the project directory, except the branch reviews in step 5.",
  ],
];

const ORCHESTRATOR_APPEND =
  "\n## Resume\nA hook records every implementer and reviewer result by SLICE in `.claude/state/journal.jsonl` (one JSON line each: ts, session_id, slice, role, status). If the task asks you to resume an earlier run, Read that file first: a slice whose latest reviewer entry is pass is done. Plan only the rest, keep the same SLICE ids, and say in your report which slices you reused.\n";

const REVIEWER_EDITS = [
  [
    "Report only gaps that affect correctness",
    "- Plan review (the brief starts with PLAN REVIEW): you review a plan, not finished work. Check that every requirement of the task is covered by a slice, each acceptance check is runnable or checkable as written, no two slices own the same file unless one lists the other in DEPENDS, the dependencies have no cycle, and there are at most 6 slices. Run nothing that changes state.\n- A `FOCUS:` line in the brief names what to check hardest. Check it first, and still report any other correctness gap.\n\nReport only gaps that affect correctness",
  ],
];

/** Replace each anchor, which must occur exactly once. Throws naming the file and anchor otherwise. */
export function edit(text, edits, name) {
  let out = text;
  for (const [anchor, replacement] of edits) {
    const n = out.split(anchor).length - 1;
    if (n !== 1) throw new Error(`o-next: anchor found ${n} times in ${name}: ${JSON.stringify(anchor.slice(0, 60))}`);
    out = out.replace(anchor, () => replacement);
  }
  return out;
}

/** Append each event's hook entries to settings.hooks, keeping the shipped ones. */
export function withHooks(settings) {
  const hooks = { ...(settings.hooks ?? {}) };
  for (const [event, entries] of Object.entries(SETTINGS_HOOKS)) hooks[event] = [...(hooks[event] ?? []), ...entries];
  return { ...settings, hooks };
}

/** Apply the overlay to a copied .claude/ dir (agents, hooks and settings.json). */
export function applyONext(claudeDir) {
  const patch = (rel, edits, append = "") => {
    const file = join(claudeDir, rel);
    writeFileSync(file, edit(readFileSync(file, "utf8"), edits, rel) + append);
  };
  patch("agents/orchestrator.md", ORCHESTRATOR_EDITS, ORCHESTRATOR_APPEND);
  patch("agents/reviewer.md", REVIEWER_EDITS);
  for (const h of HOOKS) copyFileSync(join(HERE, "hooks", h), join(claudeDir, "hooks", h));
  const file = join(claudeDir, "settings.json");
  const settings = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, `${JSON.stringify(withHooks(settings), null, 2)}\n`);
}
