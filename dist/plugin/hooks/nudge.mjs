#!/usr/bin/env node
// SessionStart hook (plugin only): remind the main session to size non-trivial tasks with the route skill. That
// covers any task (code, research, writing, analysis, operations), not only coding in a git repository: the route
// skill, this text and the orchestrator's sizing step describe the same three routes (see .claude/rules/agents.md).
// Silent when ORCH_NO_NUDGE is set; scripts/orchestrate.sh sets it for every headless run so those sessions do not
// triage a task that was already routed. Must exit 0 on any input.
if (process.env.ORCH_NO_NUDGE) process.exit(0);

const context = [
  "Orchestration plugin: before starting a non-trivial task (code, research, writing, analysis or operations; more than a quick edit or a quick question), run the orchestration:route skill with the task description and follow the route it returns.",
  "- plain: do it in this session; if it changed code, run the project's tests before saying it is done, otherwise check the result against the request.",
  "- reviewed: do it here, then have orchestration:reviewer check the result before you report: `git diff HEAD` for code in a git repository, otherwise the files or answer you produced.",
  "- orchestrate: act as the orchestrator yourself: at most 6 slices with disjoint output files, delegate with the Agent tool to orchestration:researcher, orchestration:implementer and orchestration:reviewer, and implement nothing yourself. Only for code in a git repository: parallel slices use isolation: worktree when worktree.baseRef is \"head\" (else one at a time) and orchestration:integrator merges them. Work that changes no code runs in the shared folder, and its slices with disjoint files may run in parallel; code outside a git repository runs one slice at a time. If you write the answer yourself from the researchers' findings, send the draft and its sources to orchestration:reviewer before you reply.",
  "Skip routing for quick questions, tiny edits, and when the user names the route themselves.",
].join("\n");

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }) + "\n");
