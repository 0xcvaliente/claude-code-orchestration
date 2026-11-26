#!/usr/bin/env node
// SessionStart hook (plugin only; also UserPromptSubmit, below): remind the main session to size non-trivial tasks with the route skill. That
// covers any task (code, research, writing, analysis, operations), not only coding in a git repository: the route
// skill, this text and the orchestrator's sizing step describe the same three routes (see .claude/rules/agents.md).
// Since 2.2.0 the orchestrate route's rules live in the route skill and the orchestrator alone: this text keeps the
// routing lines, a pointer to the skill and the few rules a session needs before or without it, so the SessionStart
// context stays under Claude Code's 10,000-character hook context cap (src/nudge-length.test.mjs holds it at 9,000).
// A rule removed from here must be in the route skill first.
// Silent when ORCH_NO_NUDGE is set; scripts/orchestrate.sh sets it for every headless run so those sessions do not
// triage a task that was already routed. Must exit 0 on any input.
// The text below is model-facing, so it names gate reasons but no environment switch: the session cannot set them.
// For maintainers: the opus escalation the route skill describes is the review gate's; ORCH_ESCALATION=off disables it
// and ORCH_ESCALATION=always requires an opus review for every slice. The other gate switches are listed in
// .claude/rules/agents.md (among them ORCH_SKILL_HINTS=off, which drops the plan check's suggested-skills block but
// never an explicit SKILLS line). Skill creation (the skill's "New skill" sentences) is switched by ORCH_SKILL_CREATE,
// ORCH_SKILLS_REPO_PRIVATE and ORCH_SKILLS_REPO_PUBLIC, described in plan-check.mjs.
// With CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 an Agent call that passes `name` starts a teammate instead of a
// subagent; the plan check and the journal never see it, so the nudge adds a warning then.
// Silent too when the session itself runs as the orchestrator (`claude --agent orchestrator`, or an `agent` setting,
// as in this repo's own .claude/settings.json): it is already routed, its prompt holds the same rules, and it has no
// Skill tool to run the route skill with. SessionStart input carries `agent_type` for such a session.
// UserPromptSubmit (project and plugin, the plugin copy exits on duplicate()): since 1.6.1 a typed prompt that holds the
// word `ultracode` (whole word, any case) is refused with {"decision":"block","reason":...}, so it never reaches the
// model (1.6.0 only added a context line, and the prompt still went through). The reason is shown to the person: it
// says keyword-started workflows are off here and to type the request again without the word, or use the orchestrator,
// and names no switch. Every other input gets exactly what it got before: nothing at UserPromptSubmit. The event also
// fires for a subagent's report, a task notification and another session's message; `typedPrompt` in state.mjs tells
// them apart by their text, and they are never blocked. It runs for every session (the orchestrator's too) and is not
// silenced by ORCH_NO_NUDGE; the workflow guard's switch, ORCH_WORKFLOW_GUARD=off (plugin option workflow_guard, the
// environment wins; `guardOff` of workflow-guard.mjs), turns it off with the guard.
import { readFileSync } from "node:fs";
import { duplicate, typedPrompt } from "./state.mjs";
import { guardOff } from "./workflow-guard.mjs";

/** @type {any} */
let input = null;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  // no input, or input that is not JSON: nudge as before
}

const ULTRACODE_BLOCK =
  "Workflows started by the ultracode keyword are off in this project, so this prompt was not sent. Type the request again without the word ultracode, or use this project's orchestrator (the orchestrator agent, or the saved orchestrate workflow).";

if (input?.hook_event_name === "UserPromptSubmit") {
  if (duplicate("nudge.mjs")) process.exit(0);
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (!guardOff(process.env) && typedPrompt(input) && /(^|[^A-Za-z0-9_])ultracode(?![A-Za-z0-9_])/i.test(prompt)) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: ULTRACODE_BLOCK }) + "\n");
  }
  process.exit(0);
}

if (process.env.ORCH_NO_NUDGE) process.exit(0);
if (String(input?.agent_type ?? "").split(":").pop() === "orchestrator") process.exit(0);

const lines = [
  "Orchestration plugin: before starting a non-trivial task (code, research, writing, analysis or operations; more than a quick edit or a quick question), run the orchestration:route skill with the task description and follow the route it returns.",
  "- plain: do it in this session; if it changed code, run the project's tests before saying it is done, otherwise check the result against the request.",
  "- reviewed: do it here, then have orchestration:reviewer check the result before you report: `git diff HEAD` for code in a git repository, otherwise the files or answer you produced.",
  "- orchestrate: follow the orchestrate route as the orchestration:route skill describes it (run the skill first if you have not, also when the user named this route; the skill holds every brief line, gate and retry rule): act as the orchestrator yourself, delegate with the Agent tool to orchestration:researcher, orchestration:implementer, orchestration:reviewer and orchestration:integrator, and implement nothing yourself. These rules hold before and without the skill:",
  "  - Small question: a question about the project that changes nothing and that at most 5 of your own Read, Grep or Glob calls can settle is answered directly, with a file and line reference for each fact and no researcher, and goes to orchestration:reviewer only when a wrong answer is costly.",
  "  - If you write the answer yourself from the researchers' findings, send the draft and its sources to orchestration:reviewer before you reply, and to a second, opus reviewer for a risky one.",
  "  - Only for code in a git repository: parallel slices use isolation: worktree when worktree.baseRef is \"head\" (else one at a time) and orchestration:integrator merges them. Work that changes no code runs in the shared folder, and its slices with disjoint files may run in parallel; code outside a git repository runs one slice at a time.",
  "  - An implementer's report arrives before its test gate has finished; when a reviewer launch for its slice is refused with tests_failed_after_report, the tests failed after the worker reported: resume that implementer with SendMessage (the refusal names its agent id), then review.",
  "  - Never write the final report until every worker has reported; a `completed` notification from a worker that already handed back its report is not a new report and needs no new review, retry or reply.",
  "  - Only the person starts /ship, which pushes the hand-off branch, opens the pull request and watches CI (/steward watches an existing pull request); never invoke /ship or /steward, or the ship, ship-local or steward skills.",
  "- fixed order: the gated workflow /orchestration:orchestrate (project copy: /orchestrate) runs the orchestrate route with its order fixed in code (plan with a constraints ledger, build, review with opus escalation, one replan, integrate). Only the user starts it: suggest it when a fixed order helps, never start it unasked.",
  "- output: short bullets or key: value lines; the route on one line with its reason; progress in one short line, only when something changed; a final report of at most 15 lines (plain and reviewed: what changed, the check and its result, what is open; orchestrate: one line per slice, <id>: pass|fail - <evidence pointer>, for code in git handoff: <branch> at <commit> or handoff: none - <why>, then, when the hand-off made a branch, Next: type /ship (Next: type /steward when a pull request for it exists), then what is open); more detail only when the user asks.",
  "Skip routing for quick questions, tiny edits, and when the user names the route themselves.",
];
if (process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1") {
  lines.push(
    "Warning: agent teams are switched on in this session. An Agent call that passes a name starts a teammate, not a subagent, and teammates run outside the plan check, the run journal and the gates. Never pass a name when you launch orchestration agents.",
  );
}

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }) + "\n");
