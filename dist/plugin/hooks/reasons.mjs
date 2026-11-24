// The block reasons of the plan check and the review gate (2.1.0), in one place. Not a hook and not a run-time
// dependency: plan-check.mjs and review-gate.mjs keep their own string literals and never import this file, so a copy of
// the hooks without it blocks exactly as before. Tests pin the lists to the hooks' code (src/contracts.test.ts, which
// reads every block reason from the hooks by pattern and compares both ways), to the "Block reasons" section of
// .claude/agents/orchestrator.md and to the pane's GATE_REASONS (src/reasons.test.mjs). A reason a hook adds goes into
// this file, that section and the pane together. Imports nothing, so it loads alone wherever the hooks are copied.
//
// Only reasons that block are listed: an allow (`ok`, `agents_running`, a `<reason>_gave_up` or `<reason>_unrecorded`
// form) is not a block reason.

/** Every reason plan-check.mjs blocks an Agent launch with. */
export const PLAN_CHECK_BLOCK_REASONS = Object.freeze([
  "missing_lines",
  "no_plan_review",
  "light_path_multi",
  "not_in_plan",
  "builtin_agent_in_run",
  "wave_full",
  "file_overlap",
  "dependency_cycle",
  "worktree_base_not_head",
  "replan_required",
  "tests_failed_after_report",
  "skill_create_off",
  "skill_name_invalid",
  "skill_repo_missing",
  "skill_exists",
  "skill_limit",
]);

/** Every reason review-gate.mjs blocks the orchestrator's final reply with. */
export const REVIEW_GATE_BLOCK_REASONS = Object.freeze([
  "no_reviewer_after_last_implementer",
  "last_reviewer_failed",
  "last_reviewer_no_status",
  "constraints_unchecked",
  "opus_review_required",
  "replan_required",
  "implementer_unfinished",
  "run_state_unreadable",
  "second_review_required",
]);
