// "Change these together" contracts from .claude/rules/agents.md, enforced per file: the triage numbers, the three
// route names and the brief-format tokens must agree across the prose files and the hooks that parse the briefs.
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRIAGE } from "./config.js";
import { GAP_MIN_DEFAULT } from "../.claude/hooks/brief.mjs";
import { PLAN_SLICE_CAP, RESEARCH_QUESTION_CAP, WAVE_CAP_DEFAULT } from "../.claude/hooks/limits.mjs";
import { PLAN_CHECK_BLOCK_REASONS, REVIEW_GATE_BLOCK_REASONS } from "../.claude/hooks/reasons.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const SKILL = ".claude/skills/route/SKILL.md";
const ORCH = ".claude/agents/orchestrator.md";
const REVIEWER = ".claude/agents/reviewer.md";
const NUDGE = ".claude/hooks/nudge.mjs";
const keys = Object.keys(TRIAGE) as (keyof typeof TRIAGE)[];

/** 1500 -> "1,500", as the prose writes large numbers. */
const num = (n: number) => n.toLocaleString("en-US");

/** The text from a heading line to the next heading of the same or a higher level. */
function section(text: string, heading: RegExp): string {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => heading.test(l));
  assert.ok(start >= 0, `heading ${heading} not found`);
  const level = lines[start]!.match(/^#+/)![0].length;
  const end = lines.findIndex((l, i) => i > start && /^#+ /.test(l) && l.match(/^#+/)![0].length <= level);
  return lines.slice(start, end < 0 ? undefined : end).join("\n");
}

/** Every "<name> <number>" a doc states must equal TRIAGE. */
function assertNamedValues(file: string, text: string) {
  for (const k of keys) {
    for (const m of text.matchAll(new RegExp(`\`?${k}\`? (\\d+)\\b`, "g"))) assert.equal(Number(m[1]), TRIAGE[k], `${file} states ${m[0]}`);
  }
}

test("route skill lists every TRIAGE threshold by name and value, and its rules agree", () => {
  const skill = read(SKILL);
  for (const [k, v] of Object.entries(TRIAGE)) assert.match(skill, new RegExp(`\\b${k} ${v}\\b`), `${SKILL} must list "${k} ${v}"`);
  const rules = skill.slice(skill.indexOf("Apply these rules in order"), skill.indexOf("Thresholds:"));
  assert.match(rules, new RegExp(`at most ${TRIAGE.reviewedMaxFiles} files and at most ${TRIAGE.reviewedMaxLines} lines`));
  assert.match(rules, new RegExp(`${TRIAGE.bigFiles} or more files`));
  assert.match(rules, new RegExp(`${TRIAGE.minParallelSlices} or more independent slices`));
  assert.match(rules, new RegExp(`${TRIAGE.minParallelFilesCode} or more files when \`code\` is true, ${TRIAGE.minParallelFilesNonCode} or more when it is false, or ${TRIAGE.bigLines} or more lines`));
});

test("orchestrator 'Size the task first' step states the light-path and big-work numbers from TRIAGE", () => {
  const step = read(ORCH).split("\n").find((l) => l.startsWith("0. Size the task first"));
  assert.ok(step, `${ORCH} has a "0. Size the task first" step`);
  assert.match(step, new RegExp(`at most ${TRIAGE.reviewedMaxFiles} files AND under about ${num(TRIAGE.bigLines)} changed lines`));
  assert.match(step, new RegExp(`large work \\(${num(TRIAGE.bigLines)}\\+ lines\\)`));
  const allowed = new Set<number>(Object.values(TRIAGE));
  for (const m of step.matchAll(/\b(\d[\d,]*)\+? (?:changed )?(files|lines)\b/g)) {
    assert.ok(allowed.has(Number(m[1]!.replace(/,/g, ""))), `${ORCH} step 0 states ${m[0]}, which is not a TRIAGE value`);
  }
  assertNamedValues(ORCH, step);
});

test("README carries the thresholds in its single 'Choosing a route (triage)' section", () => {
  const readme = read("README.md");
  assert.equal(readme.split("\n").filter((l) => /^#+ Choosing a route \(triage\)/.test(l)).length, 1, "exactly one triage section");
  const triage = section(readme, /^## Choosing a route \(triage\)/);
  assert.match(triage, new RegExp(`at most ${TRIAGE.reviewedMaxFiles} files, at most ${TRIAGE.reviewedMaxLines} lines`));
  assert.match(triage, new RegExp(`${TRIAGE.minParallelSlices} or more independent slices`));
  assert.match(triage, new RegExp(`${TRIAGE.minParallelFilesCode} or more files`));
  assert.match(triage, new RegExp(`${TRIAGE.minParallelFilesNonCode} or more when the task changes no code`));
  assert.match(triage, new RegExp(`${num(TRIAGE.bigLines)} or more lines`));
  assert.match(triage, new RegExp(`${TRIAGE.bigFiles} or more files \\|`));
  assert.match(triage, new RegExp(`\`bigLines\` ${TRIAGE.bigLines} and \`reviewedMaxLines\` ${TRIAGE.reviewedMaxLines}`));
  assertNamedValues("README.md", readme);
});

test("docs/native-mode.md: any threshold it states equals TRIAGE", () => {
  const doc = read("docs/native-mode.md");
  assertNamedValues("docs/native-mode.md", doc);
  for (const m of doc.matchAll(/\b(\d[\d,]*)\+ lines/g)) assert.equal(Number(m[1]!.replace(/,/g, "")), TRIAGE.bigLines, `native-mode.md states ${m[0]}`);
  for (const m of doc.matchAll(/\bat most (\d+) files\b/g)) assert.equal(Number(m[1]), TRIAGE.reviewedMaxFiles, `native-mode.md states ${m[0]}`);
  for (const m of doc.matchAll(/\bfrom (\d+) files for code\b/g)) assert.equal(Number(m[1]), TRIAGE.minParallelFilesCode, `native-mode.md states ${m[0]}`);
  for (const m of doc.matchAll(/\bfrom (\d+) files for work that changes no code\b/g)) assert.equal(Number(m[1]), TRIAGE.minParallelFilesNonCode, `native-mode.md states ${m[0]}`);
});

test("the three route names appear in nudge.mjs, the route skill and the orchestrator", () => {
  for (const file of [NUDGE, SKILL, ORCH]) {
    const text = read(file);
    for (const route of ["plain", "reviewed", "orchestrate"]) assert.match(text, new RegExp(`\\b${route}\\b`), `${file} must name the route "${route}"`);
  }
});

test("brief tokens appear in the orchestrator and the reviewer", () => {
  const orch = read(ORCH);
  for (const t of ["SLICE:", "FILES:", "DEPENDS:", "PATH: light", "PLAN REVIEW"]) assert.ok(orch.includes(t), `${ORCH} must mention ${t}`);
  const reviewer = read(REVIEWER);
  for (const t of ["SLICE:", "FOCUS:"]) assert.ok(reviewer.includes(t), `${REVIEWER} must mention ${t}`);
});

test("the route skill and nudge.mjs describe the same brief rules", () => {
  for (const file of [SKILL, NUDGE]) {
    const text = read(file);
    for (const t of ["SLICE:", "FILES:", "DEPENDS:", "PATH: light", "PLAN REVIEW", "FOCUS:"]) assert.ok(text.includes(t), `${file} must mention ${t}`);
    assert.match(text, /implementer/, `${file} says the briefs are for implementers`);
    assert.match(text, /reviewer/, `${file} says reviewer briefs start with SLICE`);
  }
});

// --- The hooks actually parse each token (invoked as src/plan-hooks.test.mjs does). ---
function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "contracts-"));
  const hooks = join(dir, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  for (const h of ["state.mjs", "brief.mjs", "run.mjs", "plan-check.mjs", "builtin-agents.mjs", "journal.mjs"]) copyFileSync(join(root, ".claude", "hooks", h), join(hooks, h));
  return dir;
}
const run = (dir: string, script: string, payload: unknown) =>
  spawnSync("node", [join(dir, ".claude", "hooks", script)], { input: typeof payload === "string" ? payload : JSON.stringify(payload), env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: "utf8" });
const launch = (dir: string, prompt: string, session = "s1") => run(dir, "plan-check.mjs", { session_id: session, tool_name: "Agent", tool_input: { subagent_type: "implementer", prompt } });
const readLog = (dir: string, name: string) =>
  readFileSync(join(dir, ".claude", "state", name), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const post = (dir: string, id: string, type: string, prompt: string) =>
  run(dir, "journal.mjs", { hook_event_name: "PostToolUse", session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: type, prompt }, tool_response: { status: "async_launched", agentId: id } });
const stop = (dir: string, id: string, type: string, last: string) =>
  run(dir, "journal.mjs", { hook_event_name: "SubagentStop", session_id: "s1", agent_id: id, agent_type: type, last_assistant_message: last });

test("plan-check.mjs parses SLICE, FILES and DEPENDS from a brief", () => {
  const dir = project();
  try {
    // Open the plan-review gate through the same path production uses.
    post(dir, "rev0", "reviewer", "PLAN REVIEW\nTask: ...");
    stop(dir, "rev0", "reviewer", "STATUS: pass");
    assert.equal(launch(dir, "SLICE: a\nFILES: src/a.ts, src/a.test.ts\nDEPENDS: none\nGoal: x").status, 0);
    const clash = launch(dir, "SLICE: b\nFILES: src/a.ts\nDEPENDS: none");
    assert.equal(clash.status, 2, "FILES overlapping slice a is blocked");
    assert.match(clash.stderr, /src\/a\.ts \(owned by a\)/);
    assert.equal(launch(dir, "SLICE: b\nFILES: src/a.ts\nDEPENDS: a").status, 0, "DEPENDS lifts the overlap");
    const log = readLog(dir, "plan-check.jsonl");
    assert.equal(log[0].slice, "a");
    assert.deepEqual(log[0].files, ["src/a.ts", "src/a.test.ts"]);
    assert.deepEqual(log[0].depends, []);
    assert.deepEqual(log.at(-1).depends, ["a"]);
    assert.equal(launch(dir, "SLICE: x\nGoal: no files").status, 2, "a brief without FILES is blocked");
    assert.equal(run(dir, "plan-check.mjs", "not json").status, 0, "malformed input exits 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan-check.mjs honours PATH: light, and journal.mjs turns PLAN REVIEW into slice plan", () => {
  const dir = project();
  try {
    assert.equal(launch(dir, "SLICE: p\nFILES: p.ts\nDEPENDS: none").status, 2, "no plan review yet: blocked");
    assert.equal(launch(dir, "SLICE: only\nFILES: one.ts\nDEPENDS: none\nPATH: light", "s2").status, 0, "PATH: light skips the plan review");
    assert.equal(readLog(dir, "plan-check.jsonl").at(-1).reason, "light_path");
    post(dir, "rev1", "reviewer", "PLAN REVIEW\nTask: ...");
    stop(dir, "rev1", "reviewer", "STATUS: pass");
    const entry = readLog(dir, "journal.jsonl").at(-1);
    assert.deepEqual([entry.slice, entry.role, entry.status], ["plan", "reviewer", "pass"]);
    assert.equal(launch(dir, "SLICE: p\nFILES: p.ts\nDEPENDS: none").status, 0, "open after the plan review");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("journal.mjs parses SLICE in implementer and reviewer briefs, with a FOCUS line present", () => {
  const dir = project();
  try {
    post(dir, "i1", "implementer", "SLICE: toml\nFILES: toml.py\nDEPENDS: none");
    stop(dir, "i1", "implementer", "STATUS: pass");
    post(dir, "r1", "orchestration:reviewer", "SLICE: toml\nFOCUS: dates\nGoal: check");
    stop(dir, "r1", "orchestration:reviewer", "STATUS: fail\nGAPS: x");
    assert.deepEqual(readLog(dir, "journal.jsonl").map((e) => [e.slice, e.role, e.status]), [["toml", "implementer", "pass"], ["toml", "reviewer", "fail"]]);
    assert.equal(run(dir, "journal.mjs", "{").status, 0, "malformed input exits 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- 0.4.0 lines: every model-facing place that describes briefs and replies names them. ---
const IMPLEMENTER = ".claude/agents/implementer.md";
const RESEARCHER = ".claude/agents/researcher.md";
const CONVENTIONS = ".claude/skills/orchestration-conventions/SKILL.md";
const nudgeContext = (env: Record<string, string> = {}) => {
  const r = spawnSync("node", [join(root, NUDGE)], { input: "{}", env: { ...process.env, ORCH_NO_NUDGE: "", CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "", ...env }, encoding: "utf8" });
  assert.equal(r.status, 0);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
};

test("0.4.0 brief and reply lines appear in the orchestrator, the route skill and the nudge", () => {
  const texts: [string, string][] = [[ORCH, read(ORCH)], [SKILL, read(SKILL)], [NUDGE, nudgeContext()]];
  for (const [file, text] of texts) {
    for (const t of ["SOURCES:", "READ:", "KIND: bugfix", "VALIDATE: gaps", "GAP: <0-100> <text>", "QUOTE: <locator> | <verbatim text>", "replan_required"]) assert.ok(text.includes(t), `${file} must mention ${t}`);
    assert.match(text, /lookup\|extract\|judge/, `${file} names the READ modes`);
    assert.match(text, /third and last attempt[^.]*\bfresh\b[^.]*\bopus\b/i, `${file} runs the third attempt as a fresh opus implementer`);
    assert.match(text, /model:? "?opus"?/, `${file} says the last attempt runs on opus`);
    assert.match(text, /BRANCH/, `${file} checks the BRANCH of a resumed worktree agent`);
  }
});

test("the route skill and the nudge list the integrator in the delegation list", () => {
  assert.match(read(SKILL), /delegate with the Agent tool to `orchestration:researcher`, `orchestration:implementer`, `orchestration:reviewer` and `orchestration:integrator`/);
  assert.match(nudgeContext(), /delegate with the Agent tool to orchestration:researcher, orchestration:implementer, orchestration:reviewer and orchestration:integrator/);
});

test("worker agents and the conventions skill describe their 0.4.0 lines", () => {
  const reviewer = read(REVIEWER);
  for (const t of ["GAP: <0-100>", "VALIDATE: gaps", "predate the slice", "linter", "nitpicks", "style"]) assert.ok(reviewer.includes(t), `${REVIEWER} must mention ${t}`);
  assert.match(reviewer, /STATUS is pass when no gap stands/);
  assert.match(read(IMPLEMENTER), /`KIND: bugfix`, reproduce the bug first: write a test that fails/);
  const researcher = read(RESEARCHER);
  for (const t of ["QUOTE: <locator> | <verbatim text>", "path:line", "p.N", "SOURCES:", "READ:", "`pages` parameter"]) assert.ok(researcher.includes(t), `${RESEARCHER} must mention ${t}`);
  assert.match(researcher, /redirection are refused, except a stderr redirection written exactly `2>\/dev\/null` or `2>&1`/, `${RESEARCHER} names the two stderr redirections the guard allows`);
  const conventions = read(CONVENTIONS);
  for (const t of ["GAP: <0-100> <text>", "QUOTE: <locator> | <verbatim text>"]) assert.ok(conventions.includes(t), `${CONVENTIONS} must mention ${t}`);
});

test("model-facing text names gate reasons but no environment switch", () => {
  const switches = /ORCH_(ESCALATION|ALLOW_BUILTINS|RUN_STALE_MIN|GAP_MIN|STALL_GATE|GUARDS|READ_ROUTER|QUOTE_CHECK|BASELINE|BUGFIX_CHECK|SKILL_HINTS|TEST_CMD|JUDGE|ALLOW_HAIKU|SKILL_CREATE|SKILLS_REPO_PRIVATE|SKILLS_REPO_PUBLIC|WORKFLOW_GUARD|WAVE_MAX)\b|CLAUDE_PLUGIN_OPTION_|\bskill_hints\b|\ballow_haiku\b|\bskill_create\b|\bskills_repo_(private|public)\b|\bworkflow_guard\b/;
  const authoring = [".claude/skills/skill-authoring/SKILL.md", ...["skill-shape", "evaluation", "compliance"].map((f) => `.claude/skills/skill-authoring/references/${f}.md`)];
  const files = [ORCH, REVIEWER, IMPLEMENTER, RESEARCHER, ".claude/agents/integrator.md", SKILL, CONVENTIONS, ...authoring];
  for (const file of files) assert.doesNotMatch(read(file).replace(/^---\n[\s\S]*?\n---\n/, ""), switches, `${file} names a switch`);
  for (const env of [{}, { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }] as Record<string, string>[]) assert.doesNotMatch(nudgeContext(env), switches, "the nudge context names a switch");
  // 1.6.1: the nudge refuses a typed prompt holding the workflow keyword; its reason is shown to the person.
  const keyword = spawnSync("node", [join(root, NUDGE)], { input: JSON.stringify({ hook_event_name: "UserPromptSubmit", prompt: "ultracode x" }), env: { ...process.env, ORCH_WORKFLOW_GUARD: "", CLAUDE_PLUGIN_OPTION_WORKFLOW_GUARD: "" }, encoding: "utf8" });
  const refusal = JSON.parse(keyword.stdout) as { decision: string; reason: string };
  assert.equal(refusal.decision, "block");
  assert.doesNotMatch(refusal.reason, switches, "the nudge's refusal names a switch");
  for (const reason of ["not_in_plan", "opus_review_required", "replan_required", "builtin_agent_in_run"]) assert.ok(read(ORCH).includes(reason), `${ORCH} keeps the reason ${reason}`);
  const maintainer = read(".claude/rules/agents.md") + read("CLAUDE.md");
  for (const s of ["ORCH_GAP_MIN", "ORCH_STALL_GATE", "ORCH_GUARDS", "ORCH_READ_ROUTER", "ORCH_QUOTE_CHECK", "ORCH_BASELINE", "ORCH_BUGFIX_CHECK", "ORCH_SKILL_HINTS", "ORCH_ALLOW_HAIKU", "ORCH_SKILL_CREATE", "ORCH_SKILLS_REPO_PRIVATE", "ORCH_SKILLS_REPO_PUBLIC", "ORCH_WORKFLOW_GUARD", "CLAUDE_PLUGIN_OPTION_"]) assert.ok(maintainer.includes(s), `maintainer text must name ${s}`);
  assert.match(read(NUDGE), /ORCH_ESCALATION=off[\s\S]*ORCH_ESCALATION=always/, "the nudge's maintainer comment names both escalation settings");
});

// --- Skill selection (0.4.0 addendum): the SKILLS line, the plan check's suggestions and the Skill tool. ---
test("the orchestrator, the route skill and the nudge describe the SKILLS line the same way", () => {
  const texts: [string, string][] = [[ORCH, read(ORCH)], [SKILL, read(SKILL)], [NUDGE, nudgeContext()]];
  for (const [file, text] of texts) {
    assert.ok(text.includes("SKILLS: <comma-separated skill names>"), `${file} must give the SKILLS line`);
    assert.match(text, /clearly needs/, `${file} adds SKILLS only when a slice clearly needs a skill`);
    assert.match(text, /never invent a (skill )?name/i, `${file} forbids invented skill names`);
    assert.match(text, /as the Skill tool lists it/, `${file} names skills as the Skill tool lists them`);
    assert.match(text, /implementer, researcher or reviewer brief/, `${file} limits SKILLS to those roles`);
    assert.match(text, /integrator/, `${file} keeps SKILLS away from the integrator`);
    assert.match(text, /plan check may append/i, `${file} mentions the plan check's suggestions`);
  }
  assert.match(read(ORCH), /VALIDATE and SKILLS are optional/, `${ORCH} lists SKILLS among the optional lines`);
});

test("workers load listed skills with the Skill tool and ignore ones that do not fit", () => {
  for (const file of [IMPLEMENTER, RESEARCHER, REVIEWER]) {
    const text = read(file);
    assert.match(text, /load each skill named in the brief's `SKILLS:` line or in the plan check's suggested-skills block with the Skill tool/, `${file} loads listed skills`);
    assert.match(text, /does not fit[^.]*ignore it and say so in one line of your report, not under OPEN/, `${file} ignores a skill that does not fit and says so outside OPEN`);
  }
  assert.match(read(REVIEWER), /review skill only to sharpen the review, never to change files/);
  assert.match(read(RESEARCHER), /you still change nothing/);
  assert.match(read(CONVENTIONS), /`SKILLS:` line[^.]*load each with it before starting work/);
  assert.doesNotMatch(read(".claude/agents/integrator.md"), /SKILLS|Skill tool/, "the integrator gets no skills");
});

test("the Skill tool goes to the orchestrator, the researcher and the reviewer, not the integrator", async () => {
  const { NATIVE_TOOLS } = await import("./config.js");
  assert.ok(NATIVE_TOOLS.orchestrator.tools?.includes("Skill"));
  assert.ok(NATIVE_TOOLS.researcher.tools?.includes("Skill"));
  assert.ok(NATIVE_TOOLS.reviewer.tools?.includes("Skill"));
  assert.ok(!NATIVE_TOOLS.integrator.tools?.includes("Skill"));
  assert.ok(!NATIVE_TOOLS.implementer.disallowedTools?.includes("Skill"), "the implementer inherits Skill");
  for (const file of [ORCH, RESEARCHER, REVIEWER]) assert.match(read(file), /^tools: .*\bSkill\b/m, `${file} frontmatter lists Skill`);
});

test("the orchestrator, the route skill and the nudge cap plan-shaping skills at two and ask for a SKILLS decision on RISKY slices", () => {
  const texts: [string, string][] = [[ORCH, read(ORCH)], [SKILL, read(SKILL)], [NUDGE, nudgeContext()]];
  for (const [file, text] of texts) {
    assert.match(text, /at most two installed skills that shape the plan itself \(domain rules, architecture, a threat model\)/, `${file} caps plan-shaping skills at two`);
    assert.match(text, /every other fitting skill (goes )?to the workers/i, `${file} sends other skills to the workers`);
    assert.match(text, /`?SKILLS: <names>`? or `?SKILLS: none`?/, `${file} gives both forms of the slice's skill decision`);
    assert.match(text, /a RISKY slice always carries one of the two/, `${file} requires a decision on RISKY slices`);
    assert.match(text, /PLAN REVIEW/, `${file} puts the decision in the PLAN REVIEW brief`);
  }
  assert.match(read(ORCH), /stays in your context/, `${ORCH} says why it loads few skills itself`);
});

// --- Two reviewers for a RISKY slice (2.1.0): the rule the review gate's `second_review_required` enforces. ---
test("the orchestrator, the route skill and the nudge state the two-reviewer rule for RISKY slices the same way", () => {
  const texts: [string, string][] = [[ORCH, read(ORCH)], [SKILL, read(SKILL)], [NUDGE, nudgeContext()]];
  for (const [file, text] of texts) {
    assert.doesNotMatch(text, /RISKY slice with [^.]*opus"? from the start/, `${file} no longer reviews a RISKY slice with one opus reviewer`);
    assert.match(text, /RISKY slice gets two [^.;]*in one message with the same brief, one with `?model:? "?opus"?`? and one on the default model/, `${file} launches two reviewers at once`);
    assert.match(text, /passes only when both pass/, `${file} needs both passes`);
    assert.match(text, /second_review_required/, `${file} names the gate's reason`);
    assert.match(text, /wait for both reports before you validate gaps or retry/i, `${file} waits for both reports`);
    assert.match(text, /new attempt is reviewed by two fresh reviewers, never a resumed one/, `${file} reviews a new attempt with fresh reviewers`);
    assert.match(text, /gap validation confirms no gap, its pass counts as one of the two/, `${file} counts a validation's pass as one of the two`);
    assert.match(text, /one more fresh reviewer, with `?model:? "?opus"?`? when no pass of the attempt ran on opus/, `${file} sends one more fresh reviewer after a validation`);
    assert.match(text, /refused with `?tests_failed_after_report`?, resume the implementer first and launch the two reviewers only after it has reported again/, `${file} resumes the implementer before the two reviewers`);
  }
  const stop = read(ORCH).split("\n").find((l) => l.startsWith("A Stop hook blocks your final reply while"));
  assert.ok(stop, `${ORCH} lists what the Stop hook blocks on`);
  assert.match(stop, /RISKY slice[^.]*`second_review_required`/, `${ORCH} names second_review_required where it lists what the Stop hook blocks on`);
});

test("the reviewer reviews on its own when another reviewer reviews the same slice", () => {
  const body = read(REVIEWER).replace(/^---\n[\s\S]*?\n---\n/, "");
  assert.match(body, /Another reviewer may review the same slice at the same time\. Your verdict rests on your own checks alone: do not look for that reviewer's report and do not rely on it\./);
});

test("the plan reviewer checks each slice's skill choice", () => {
  const reviewer = read(REVIEWER);
  assert.match(reviewer, /`SKILLS: <names>` or `SKILLS: none`/);
  assert.match(reviewer, /Check each slice's skill choice/);
  assert.match(reviewer, /a named skill that is not installed or does not fit the slice's goal and files is a gap/);
  assert.match(reviewer, /a RISKY slice with no `SKILLS:` line/);
});

test("maintainer text describes the skill suggestions and the widened allow", () => {
  for (const file of [".claude/rules/agents.md", "CLAUDE.md"]) {
    const text = read(file);
    for (const t of ["SKILLS:", "ORCH_SKILL_HINTS=off", "skill_hints", "at most 3", "anthropic-skills:<name>", "synced/<uuid>/<name>", ".claude/skills", "Workflow agents get no hints", "light_path", "never for built-ins or fork"]) {
      assert.ok(text.includes(t), `${file} must mention ${t}`);
    }
    assert.match(text, /1 for (a )?reviewers?|at most 1 for a reviewer/, `${file} caps reviewer hints at 1`);
    assert.match(text, /names and reason codes only|skill names and reason codes only/, `${file} says the block holds names and reason codes only`);
    assert.match(text, /not found on disk pass through/, `${file} says unknown SKILLS names pass through`);
    assert.match(text, /never lower/i, `${file} says the allow never lowers a model`);
  }
});

test("the orchestrator says once that an answer it writes itself is reviewed", () => {
  assert.equal(read(ORCH).match(/answer you write yourself/g)?.length, 1);
});

// --- Output to the person: keywords, not prose (the three-places rule). ---
test("the orchestrator, the route skill and the nudge state the same terse output rule", () => {
  const texts: [string, string][] = [[ORCH, read(ORCH)], [SKILL, read(SKILL)], [NUDGE, nudgeContext()]];
  for (const [file, text] of texts) {
    assert.match(text, /short bullets or key: value lines/, `${file} asks for short bullets or key: value lines`);
    assert.match(text, /one short line, only when something changed/, `${file} limits progress notes to one line when something changed`);
    assert.match(text, /final report of at most 15 lines/i,`${file} caps the final report at 15 lines`);
    assert.match(text, /<id>: pass\|fail - <evidence pointer>/, `${file} gives the per-slice report line`);
    assert.match(text, /more detail only when (the (person|user) )?asks/i, `${file} gives more detail only when asked`);
  }
});

test("the orchestrator shows the plan once as summary lines and puts the full plan only into the PLAN REVIEW brief", () => {
  const orch = read(ORCH);
  assert.match(orch, /full plan[^.]*goes? only into the PLAN REVIEW brief/, `${ORCH} keeps the full plan out of the visible reply`);
  assert.match(orch, /one line per slice/, `${ORCH} shows one line per slice`);
  assert.match(orch, /Path: light\|full - <reason/, `${ORCH} gives the path line's form`);
  assert.doesNotMatch(orch, /write the plan in your reply/, `${ORCH} no longer writes the full plan in the reply`);
  assert.match(orch, /Do not claim success without evidence/, `${ORCH} still requires evidence`);
});

test("the three texts name a test gate that gave up as a doubt signal where they list doubt signals", () => {
  const texts: [string, string][] = [[ORCH, read(ORCH)], [SKILL, read(SKILL)], [NUDGE, nudgeContext()]];
  for (const [file, text] of texts) {
    const list = text.match(/doubt signal \(([^)]*\([^)]*\)[^)]*)\)/)?.[1] ?? "";
    assert.match(list, /a test gate that gave up on (its|the slice's) latest attempt/, `${file} lists a test gate that gave up among the doubt signals`);
  }
});

test("the three texts launch a non-RISKY slice's one review on opus directly when the opus review is certain", () => {
  const texts: [string, string][] = [[ORCH, read(ORCH)], [SKILL, read(SKILL)], [NUDGE, nudgeContext()]];
  for (const [file, text] of texts) {
    assert.match(text, /For a slice that is not RISKY, when the opus review is certain before the review starts \((the slice is )?a retry after a failed review, or the slice has checked constraints \(a `?CHECKS:`? line\) and no command can prove any of them, so every answer will be `?\(read\)`?\), launch its one review on opus directly[^.;]*instead of a default-model review followed by an opus one; that review is the slice's review\./, `${file} launches a certain opus review directly`);
    assert.match(text, /When in doubt whether a command can prove a constraint, start on the default model\./, `${file} starts on the default model when in doubt`);
  }
});

test("the three texts start a slice with no checked constraints on the default model", () => {
  const texts: [string, string][] = [[ORCH, read(ORCH)], [SKILL, read(SKILL)], [NUDGE, nudgeContext()]];
  for (const [file, text] of texts) {
    assert.match(text, /A slice with no checked constraints \(no `?CHECKS:`? line\) starts on the default model\./, `${file} starts a slice with no checked constraints on the default model`);
  }
});

test("nudge warns about agent teams only when they are switched on", () => {
  assert.doesNotMatch(nudgeContext(), /agent teams/i);
  assert.doesNotMatch(nudgeContext({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "0" }), /agent teams/i);
  const on = nudgeContext({ CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" });
  assert.match(on, /agent teams are switched on/i);
  assert.match(on, /passes a name starts a teammate/);
  assert.match(on, /outside the plan check/);
  const bad = spawnSync("node", [join(root, NUDGE)], { input: "not json", env: { ...process.env, ORCH_NO_NUDGE: "" }, encoding: "utf8" });
  assert.equal(bad.status, 0, "malformed input exits 0");
});

// --- The acceptance check: the narrowest command, since the test gate already runs the whole suite. ---
test("every place that states the acceptance check asks for the narrowest command and leaves the whole suite to the test gate", () => {
  const texts: [string, string][] = [[IMPLEMENTER, read(IMPLEMENTER)], [ORCH, read(ORCH)], [SKILL, read(SKILL)], [NUDGE, nudgeContext()]];
  for (const [file, text] of texts) {
    assert.match(text, /narrowest command that proves the slice/, `${file} asks for the narrowest command that proves the slice`);
    assert.match(text, /tests of the files (it|you) owns?/, `${file} says that for code it is the tests of the files the slice owns`);
    assert.match(text, /test gate runs the project's whole suite when (an|the|each) implementer stops|test gate runs the project's whole suite when you stop/, `${file} says the test gate runs the whole suite`);
    assert.match(text, /once more after (integration|the merge)/, `${file} says the whole suite runs once more after integration`);
    // The test gate fires only on an implementer's stop; the integrator, not the gate, runs the suite after the merge.
    assert.match(text, /the integrator runs it once more after the merge/, `${file} makes the integrator the one that runs the whole suite after the merge`);
    assert.doesNotMatch(text, /test gate runs the project's whole suite when [^.:;]*?,? and (it runs )?once more after/, `${file} never makes the test gate run the whole suite after the merge`);
  }
  assert.match(read(IMPLEMENTER), /run the whole suite only when your brief asks for it/, `${IMPLEMENTER} runs the whole suite only when asked`);
  for (const [file, text] of texts.slice(1)) {
    assert.match(text, /a brief never also asks a worker to run the whole suite/, `${file} keeps the whole suite out of worker briefs`);
    assert.match(text, /the integrator's brief is the one that names the project's whole suite/, `${file} names the integrator's brief as the exception`);
  }
  const review = read(ORCH).split("\n").find((l) => l.startsWith("5. Review"))!;
  assert.match(review, /slice's own acceptance check/, "a slice's reviewer runs the slice's own check");
  assert.doesNotMatch(review, /npm --prefix <worktree> test/, "the review example is not the whole suite");
  assert.match(review, /only the integrator's brief names the whole suite/, "step 5 says which brief names the whole suite");
  const workflow = read(".claude/workflows/orchestrate.js");
  assert.equal(workflow.match(/narrowest command that proves the slice/g)?.length, 2, "both planner rules (code and not code) ask for the narrowest command");
  assert.match(workflow, /not the project's whole suite: the test gate already ran it/, "the reviewer brief leaves the whole suite to the test gate");
  assert.match(workflow, /the command that runs the project's whole test suite, or empty when there is none/, "the planner is asked for the whole-suite command");
});

// --- The integrator after a conflict: a failed `git merge --abort` must never leave the tree mid-merge. ---
test("the integrator checks that no merge is left in progress after an abort and never merges on into a half-merged tree", () => {
  const body = read(".claude/agents/integrator.md").replace(/^---\n[\s\S]*?\n---\n/, "");
  const conflict = body.split("\n").find((l) => l.startsWith("For each branch:"));
  assert.ok(conflict, "the per-branch rule is there");
  // The check is one plain command whose Bash result shows the answer by itself (no `$?`, no variables).
  assert.match(conflict, /run `git merge --abort`, then check[^.]*`git rev-parse -q --verify MERGE_HEAD`/, "a check right after the abort");
  assert.match(conflict, /prints a commit hash while a merge is in progress and nothing[^.]*when none is/, "the check reads from the output alone");
  assert.match(conflict, /`git status` to refresh the index, then `git merge --abort` again/, "refresh, then a second abort");
  assert.match(conflict, /`git reset --merge` as the last resort/, "the last resort");
  assert.match(conflict, /still in progress after that[^.]*merge no further branch[^.]*STATUS: fail[^.]*under OPEN/, "a merge left in progress stops the merges and fails");
  assert.match(conflict, /Never start a merge while one is in progress/, "never continues while a merge is in progress");
  assert.doesNotMatch(conflict, /\$\?|\$\{|PIPESTATUS/, "the check needs no exit-code variable");
  assert.match(body, /^OPEN: /m, "the reply format has an OPEN line for the tree state");
});

// --- 2.1.0 caps (one home: .claude/hooks/limits.mjs) and the block reasons the orchestrator must know. ---
test("the orchestrator, the route skill and the nudge state the caps of limits.mjs", () => {
  const orch = read(ORCH);
  const step1 = orch.split("\n").find((l) => l.startsWith("1. Explore"))!;
  const step2 = orch.split("\n").find((l) => l.startsWith("2. Plan"))!;
  assert.match(step1, new RegExp(`ask at most ${RESEARCH_QUESTION_CAP} narrow questions`), `${ORCH} step 1 caps researcher questions`);
  assert.match(step2, new RegExp(`\\(at most ${PLAN_SLICE_CAP} slices\\)`), `${ORCH} step 2 caps slices`);
  assert.match(orch, new RegExp(`Wave: at most ${WAVE_CAP_DEFAULT} implementers run at a time`), `${ORCH} step 3 states the wave cap`);
  assert.match(orch, new RegExp(`launch ${WAVE_CAP_DEFAULT} and start the next ready slice`), `${ORCH} launches a full wave, then the next ready slice`);
  const texts: [string, string][] = [[ORCH, orch], [SKILL, read(SKILL)], [NUDGE, nudgeContext()]];
  for (const [file, text] of texts) {
    // Every cap a text states matches limits.mjs; no other number stands where a cap does.
    for (const m of text.matchAll(/at most (\d+) (?:narrow |researcher )?questions/g)) assert.equal(Number(m[1]), RESEARCH_QUESTION_CAP, `${file} states ${m[0]}`);
    for (const m of text.matchAll(/at most (\d+) slices/g)) assert.equal(Number(m[1]), PLAN_SLICE_CAP, `${file} states ${m[0]}`);
    for (const m of text.matchAll(/at most (\d+) implementers run at a time/g)) assert.equal(Number(m[1]), WAVE_CAP_DEFAULT, `${file} states ${m[0]}`);
    assert.match(text, new RegExp(`at most ${RESEARCH_QUESTION_CAP} (?:narrow |researcher )?questions`, "i"), `${file} caps researcher questions`);
    assert.match(text, new RegExp(`at most ${PLAN_SLICE_CAP} slices`), `${file} caps slices`);
    assert.match(text, new RegExp(`at most ${WAVE_CAP_DEFAULT} implementers run at a time`), `${file} caps implementers at once`);
    assert.match(text, /`?wave_full`? means wait for a running implementer's report, then launch it again|`wave_full` is not a plan problem: wait for a running implementer's report, then launch the slice again/, `${file} says what to do on wave_full`);
    assert.match(text, /in worktrees the plan check may allow fewer|for slices in worktrees the plan check may allow fewer/, `${file} says worktree waves may be smaller`);
  }
});

test("the plan reviewer checks the slice cap of limits.mjs", () => {
  const body = read(REVIEWER).replace(/^---\n[\s\S]*?\n---\n/, "");
  const plan = body.split("\n").find((l) => l.startsWith("- Plan review"));
  assert.ok(plan, `${REVIEWER} has its plan-review rule`);
  assert.match(plan, new RegExp(`there are at most ${PLAN_SLICE_CAP} slices`), `${REVIEWER} checks the slice cap`);
  for (const m of body.matchAll(/at most (\d+) slices/g)) assert.equal(Number(m[1]), PLAN_SLICE_CAP, `${REVIEWER} states ${m[0]}`);
});

test("the gap cutoff the three texts state equals the code's default", () => {
  const texts: [string, string][] = [[ORCH, read(ORCH)], [SKILL, read(SKILL)], [NUDGE, nudgeContext()]];
  for (const [file, text] of texts) {
    const stated = [...text.matchAll(/gap (?:with|of) confidence (\d+) or more/g)].map((m) => Number(m[1]));
    assert.ok(stated.length > 0, `${file} states the gap cutoff`);
    for (const n of stated) assert.equal(n, GAP_MIN_DEFAULT, `${file} states a cutoff of ${n}`);
  }
});

/** The block reasons plan-check.mjs can give, read from its code; fails when a block path it cannot read appears. */
function planCheckBlockReasons(): string[] {
  const src = read(".claude/hooks/plan-check.mjs");
  const reasons = new Set<string>();
  const args = [...src.matchAll(/\bdecide\(\s*"block",\s*([^,]+),/g)].map((m) => m[1]!.trim());
  for (const a of args) {
    const lit = a.match(/^"([a-z_]+)"$/);
    if (lit) reasons.add(lit[1]!);
    else assert.equal(a, "reason", `plan-check.mjs blocks with a reason the test cannot read: ${a}`);
  }
  // The one non-literal block is the skill-slice helper `gate(reason, message)`.
  assert.equal(args.filter((a) => a === "reason").length, 1, "plan-check.mjs has one block through the skill-slice helper");
  for (const m of src.matchAll(/\bgate\(\s*"([a-z_]+)"/g)) reasons.add(m[1]!);
  // The reviewer hold exits 2 itself with HOLD_REASON; decide() is the only other exit 2.
  const hold = src.match(/const HOLD_REASON = "([a-z_]+)"/)?.[1];
  assert.ok(hold, "plan-check.mjs names HOLD_REASON");
  reasons.add(hold);
  assert.equal(src.match(/process\.exit\(2\)/g)?.length, 2, "plan-check.mjs exits 2 only in decide() and the reviewer hold");
  for (const known of ["not_in_plan", "wave_full", "skill_limit", "tests_failed_after_report"]) assert.ok(reasons.has(known), `the reading of plan-check.mjs finds ${known}`);
  return [...reasons];
}

/** The block reasons review-gate.mjs can give: every problem's reason literal (block() takes only live.reason). */
function reviewGateBlockReasons(): string[] {
  const src = read(".claude/hooks/review-gate.mjs");
  const calls = [...src.matchAll(/(?<!function )\bblock\(([^,()\n]+),/g)].map((m) => m[1]!.trim());
  assert.deepEqual(calls, ["live.reason"], "review-gate.mjs blocks only with the reason of a listed problem");
  assert.doesNotMatch(src, /decide\(\s*"block"/, "review-gate.mjs blocks only through block()");
  assert.equal(src.match(/process\.exit\(2\)/g)?.length, 1, "review-gate.mjs exits 2 only in block()");
  const reasons = new Set([...src.matchAll(/\breason: "([a-z_]+)"/g)].map((m) => m[1]!));
  for (const known of ["opus_review_required", "implementer_unfinished", "last_reviewer_failed"]) assert.ok(reasons.has(known), `the reading of review-gate.mjs finds ${known}`);
  return [...reasons];
}

test("reasons.mjs lists exactly the block reasons the hooks' code gives, both ways", () => {
  const sorted = (xs: readonly string[]) => [...new Set(xs)].sort();
  assert.ok(Object.isFrozen(PLAN_CHECK_BLOCK_REASONS) && Object.isFrozen(REVIEW_GATE_BLOCK_REASONS), "reasons.mjs exports frozen arrays");
  assert.equal(new Set(PLAN_CHECK_BLOCK_REASONS).size, PLAN_CHECK_BLOCK_REASONS.length, "reasons.mjs: no duplicate plan-check reason");
  assert.equal(new Set(REVIEW_GATE_BLOCK_REASONS).size, REVIEW_GATE_BLOCK_REASONS.length, "reasons.mjs: no duplicate review-gate reason");
  assert.deepEqual(sorted(PLAN_CHECK_BLOCK_REASONS), sorted(planCheckBlockReasons()), "PLAN_CHECK_BLOCK_REASONS equals the reasons plan-check.mjs blocks with");
  assert.deepEqual(sorted(REVIEW_GATE_BLOCK_REASONS), sorted(reviewGateBlockReasons()), "REVIEW_GATE_BLOCK_REASONS equals the reasons review-gate.mjs blocks with");
  // A list, not a run-time dependency: it imports nothing, and no hook imports it.
  assert.doesNotMatch(read(".claude/hooks/reasons.mjs"), /^\s*import\b|\bimport\(|\brequire\(/m, "reasons.mjs imports nothing");
  for (const hook of ["plan-check.mjs", "review-gate.mjs"]) assert.doesNotMatch(read(`.claude/hooks/${hook}`), /reasons\.mjs/, `${hook} does not import reasons.mjs`);
});

test("the orchestrator's Block reasons section names every block reason of the plan check and the review gate", () => {
  const list = section(read(ORCH), /^## Block reasons/);
  const plan = list.slice(list.indexOf("- Plan check"), list.indexOf("- Review gate"));
  const review = list.slice(list.indexOf("- Review gate"));
  for (const r of planCheckBlockReasons()) assert.ok(plan.includes(`\`${r}\``), `${ORCH} Block reasons, plan check: names ${r}`);
  for (const r of reviewGateBlockReasons()) assert.ok(review.includes(`\`${r}\``), `${ORCH} Block reasons, review gate: names ${r}`);
  // The section against the module, each part against its own list, both ways.
  const named = (text: string) => [...new Set([...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]!))].sort();
  assert.deepEqual(named(plan), [...PLAN_CHECK_BLOCK_REASONS].sort(), `${ORCH} Block reasons, plan check: names exactly PLAN_CHECK_BLOCK_REASONS`);
  assert.deepEqual(named(review), [...REVIEW_GATE_BLOCK_REASONS].sort(), `${ORCH} Block reasons, review gate: names exactly REVIEW_GATE_BLOCK_REASONS`);
  // Every reason the section names is one the hooks can give (no stale entries).
  const known = new Set([...planCheckBlockReasons(), ...reviewGateBlockReasons()]);
  for (const m of list.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)) assert.ok(known.has(m[1]!), `${ORCH} Block reasons names ${m[1]}, which no hook gives`);
});
