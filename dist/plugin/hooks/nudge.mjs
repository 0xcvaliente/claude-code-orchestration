#!/usr/bin/env node
// SessionStart hook (plugin only; also UserPromptSubmit, below): remind the main session to size non-trivial tasks with the route skill. That
// covers any task (code, research, writing, analysis, operations), not only coding in a git repository: the route
// skill, this text and the orchestrator's sizing step describe the same three routes (see .claude/rules/agents.md).
// Silent when ORCH_NO_NUDGE is set; scripts/orchestrate.sh sets it for every headless run so those sessions do not
// triage a task that was already routed. Must exit 0 on any input.
// The text below is model-facing, so it names gate reasons but no environment switch: the session cannot set them.
// For maintainers: the opus escalation it describes is the review gate's; ORCH_ESCALATION=off disables it and
// ORCH_ESCALATION=always requires an opus review for every slice. The other gate switches are listed in
// .claude/rules/agents.md (among them ORCH_SKILL_HINTS=off, which drops the plan check's suggested-skills block but
// never an explicit SKILLS line). Skill creation (the "New skill" sentences) is switched by ORCH_SKILL_CREATE,
// ORCH_SKILLS_REPO_PRIVATE and ORCH_SKILLS_REPO_PUBLIC, described in plan-check.mjs; the text names only the plan
// check's block reasons.
// With CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 an Agent call that passes `name` starts a teammate instead of a
// subagent; the plan check and the journal never see it, so the nudge adds a warning then.
// Silent too when the session itself runs as the orchestrator (`claude --agent orchestrator`, or an `agent` setting,
// as in this repo's own .claude/settings.json): it is already routed, its prompt holds the same rules, and it has no
// Skill tool to run the route skill with. SessionStart input carries `agent_type` for such a session.
// UserPromptSubmit (1.6.0; project and plugin, the plugin copy exits on duplicate()): when the typed prompt holds the
// word `ultracode` (whole word, any case), one context line says that keyword-started workflows are off here and that
// the task goes through the orchestrator; any other prompt gets nothing. The event also fires for a subagent's report,
// a task notification and another session's message; `typedPrompt` in state.mjs tells them apart by their text, and
// they get nothing. It never blocks the prompt, runs for every
// session (the orchestrator's too) and is not silenced by ORCH_NO_NUDGE: it describes a refusal workflow-guard.mjs makes
// anyway (the guard's own switch turns the guard off, not this line). Claude Code still highlights the keyword and the
// prompt still reaches the model.
import { readFileSync } from "node:fs";
import { duplicate, typedPrompt } from "./state.mjs";

/** @type {any} */
let input = null;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  // no input, or input that is not JSON: nudge as before
}

const ULTRACODE_LINE =
  "Orchestration: workflows started by the ultracode keyword or written on the spot are off in this project, and a Workflow call with a script is refused. Do this task through this project's orchestrator instead, or suggest that the person start the saved orchestrate workflow; never start a workflow yourself.";

if (input?.hook_event_name === "UserPromptSubmit") {
  if (duplicate("nudge.mjs")) process.exit(0);
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (typedPrompt(input) && /(^|[^A-Za-z0-9_])ultracode(?![A-Za-z0-9_])/i.test(prompt)) {
    process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: ULTRACODE_LINE } }) + "\n");
  }
  process.exit(0);
}

if (process.env.ORCH_NO_NUDGE) process.exit(0);
if (String(input?.agent_type ?? "").split(":").pop() === "orchestrator") process.exit(0);

const lines = [
  "Orchestration plugin: before starting a non-trivial task (code, research, writing, analysis or operations; more than a quick edit or a quick question), run the orchestration:route skill with the task description and follow the route it returns.",
  "- plain: do it in this session; if it changed code, run the project's tests before saying it is done, otherwise check the result against the request.",
  "- reviewed: do it here, then have orchestration:reviewer check the result before you report: `git diff HEAD` for code in a git repository, otherwise the files or answer you produced.",
  "- orchestrate: act as the orchestrator yourself: at most 6 slices with disjoint output files, delegate with the Agent tool to orchestration:researcher, orchestration:implementer, orchestration:reviewer and orchestration:integrator, and implement nothing yourself. Give each slice an acceptance check: for code the narrowest command that proves the slice (the tests of the files it owns), otherwise a checklist a reviewer can verify. The test gate runs the project's whole suite when an implementer stops and the integrator runs it once more after the merge, so a brief never also asks a worker to run the whole suite: the integrator's brief is the one that names the project's whole suite. Start each implementer brief with SLICE: <id>, FILES: <owned files> and DEPENDS: <ids or none>; send a plan of several slices to orchestration:reviewer in a PLAN REVIEW brief before launching implementers (only the light path, one small low-risk slice, skips it with PATH: light in the brief): the task's hard requirements as a CONSTRAINTS: block of C<n>: <text> lines, then each slice as its SLICE:, FILES:, DEPENDS: and GOAL: lines, plus RISKY: yes when risky and CHECKS: <ids> for the constraints its files can break; a bug-fix slice carries KIND: bugfix (its implementer writes a failing reproduction test first). Start reviewer briefs with SLICE: <id>, optionally FOCUS: <what to check hardest>; researcher briefs may start with SOURCES: <paths or URLs> and READ: lookup|extract|judge, and researchers back facts read from files with QUOTE: <locator> | <verbatim text> lines. Implementer and reviewer briefs carry the slice's CHECKS: line and constraint texts, and workers answer each id (C1: pass (cmd) <command> -> <result>, C1: pass (read) <file:line or URL>, or C1: fail <reason>); reviewers list each gap as GAP: <0-100> <text>. When a slice clearly needs an installed skill you know (a document skill for a .docx/.pptx/.xlsx/.pdf deliverable, a frontend skill for UI work, a security review skill for a risky auth change), add SKILLS: <comma-separated skill names> to that implementer, researcher or reviewer brief, each name exactly as the Skill tool lists it; never invent a name and never give one to the integrator. Load yourself at most two installed skills that shape the plan itself (domain rules, architecture, a threat model), since each loaded skill stays in your context; every other fitting skill goes to the workers by name. In the PLAN REVIEW brief a slice may carry SKILLS: <names> or SKILLS: none, and a RISKY slice always carries one of the two. The plan check may append suggested skills to those briefs; workers load each named skill with the Skill tool before starting and ignore one that does not fit, saying so in one line of the report, not under OPEN, and end the report with SKILLS-USED: and SKILLS-SKIPPED: lines. New skill: when no installed skill covers knowledge the task needs and that knowledge is reusable beyond this task, the plan may hold one skill slice per run; when a person can answer, propose it first (name, when it triggers, target, category) and wait for a yes, and in an unattended run do not ask. Its implementer brief adds KIND: skill, SKILL: <name> and, for the public repository only, TARGET: public, with FILES relative to the skills repository (skills/<name>/, README.md); it never runs with isolation: worktree, reports DRAFT: <name> <branch> instead of BRANCH, and the integrator never merges it. Later slices that need it carry DRAFTS: <name>. If it fails for good, or the plan check blocks it with skill_create_off or skill_repo_missing, do the task without it and say so in the report; the report names the draft and its branch, and publishing it is a separate step a person runs. Without these optional lines nothing is tracked and no slice is risky. A run opens at the PLAN REVIEW (or the light-path launch) and closes when every slice is final; while it is open the plan check blocks fork and built-in subagents and implementers not in the reviewed plan. Review a RISKY slice with model opus from the start; for others, a passing review with a doubt signal (a (read) answer, non-empty OPEN, a retry, an isolated test failure, a test gate that gave up on the slice's latest attempt, a failing review whose gaps are all below the cutoff, which counts as a pass with a doubt signal) goes to an opus reviewer before you accept it (the Stop gate enforces this). A review fails on a failed id or a gap of confidence 80 or more: before a retry, send those gaps with the diff to a fresh reviewer whose brief starts with SLICE: <id> and VALIDATE: gaps, and send the implementer only the gaps it confirms (by SendMessage to the same implementer; for a worktree slice check that its resumed report keeps the same BRANCH). Run the third and last attempt as a fresh implementer with model opus. When a slice fails for good (its review still fails after that) or a launch or your reply is blocked with replan_required (two failing reviews of a slice in a row report the same gap), send one PLAN REVIEW with REPLAN: 1 that plans only the missing work instead of retrying; at most one replan per run. When your reply is blocked with implementer_unfinished (an implementer ran out of turns or was stopped before it finished, so nothing tested or reviewed its work), resume it with SendMessage so it finishes, or start a fresh implementer for the slice, then review the result; a partial result is never a finished slice. Subagents run in the background and report as a new turn, so ending your turn to wait is fine (the Stop review gate defers while one runs; claude -p waits for them, but not for background Bash tasks, so never leave one running); never write the final report until every worker has reported. Only for code in a git repository: parallel slices use isolation: worktree when worktree.baseRef is \"head\" (else one at a time) and orchestration:integrator merges them. Work that changes no code runs in the shared folder, and its slices with disjoint files may run in parallel; code outside a git repository runs one slice at a time. If you write the answer yourself from the researchers' findings, send the draft and its sources to orchestration:reviewer before you reply, and to a second, opus reviewer for a risky one.",
  "- fixed order: the gated workflow /orchestration:orchestrate (project copy: /orchestrate) runs the orchestrate route with its order fixed in code (plan with a constraints ledger, build, review with opus escalation, one replan, integrate). Only the user starts it: suggest it when a fixed order helps, never start it unasked.",
  "- output: short bullets or key: value lines; the route on one line with its reason; progress in one short line, only when something changed; a final report of at most 15 lines (plain and reviewed: what changed, the check and its result, what is open; orchestrate: one line per slice, <id>: pass|fail - <evidence pointer>); more detail only when the user asks.",
  "Skip routing for quick questions, tiny edits, and when the user names the route themselves.",
];
if (process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1") {
  lines.push(
    "Warning: agent teams are switched on in this session. An Agent call that passes a name starts a teammate, not a subagent, and teammates run outside the plan check, the run journal and the gates. Never pass a name when you launch orchestration agents.",
  );
}

process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } }) + "\n");
