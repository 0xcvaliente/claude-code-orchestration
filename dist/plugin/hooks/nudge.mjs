#!/usr/bin/env node
// SessionStart hook (plugin only): remind the main session to size non-trivial coding tasks with the route skill.
// Silent when ORCH_NO_NUDGE is set; scripts/orchestrate.sh sets it for every headless run so those sessions do not
// triage a task that was already routed. Must exit 0 on any input.
if (process.env.ORCH_NO_NUDGE) process.exit(0);

const context = [
  "Orchestration plugin: before starting a non-trivial coding task (more than a quick edit or a question), run the orchestration:route skill with the task description and follow the route it returns.",
  "- plain: do it in this session and run the project's tests before saying it is done.",
  "- reviewed: do it here, then have orchestration:reviewer check `git diff HEAD` before you report.",
  "- orchestrate: act as the orchestrator yourself. Plan at most 6 slices with disjoint files, delegate with the Agent tool to orchestration:researcher, orchestration:implementer (isolation: worktree for parallel slices only when worktree.baseRef is \"head\", else one at a time), orchestration:integrator and orchestration:reviewer, and do not implement anything yourself.",
  "Skip routing for questions, tiny edits, and when the user names the route themselves.",
].join("\n");

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }) + "\n");
