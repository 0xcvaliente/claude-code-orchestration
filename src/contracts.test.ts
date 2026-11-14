// "Change these together" contracts from .claude/rules/agents.md, enforced per file: the triage numbers, the three
// route names and the brief-format tokens must agree across the prose files and the hooks that parse the briefs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { TRIAGE } from "./config.js";

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
  const conventions = read(CONVENTIONS);
  for (const t of ["GAP: <0-100> <text>", "QUOTE: <locator> | <verbatim text>"]) assert.ok(conventions.includes(t), `${CONVENTIONS} must mention ${t}`);
});

test("model-facing text names gate reasons but no environment switch", () => {
  const switches = /ORCH_(ESCALATION|ALLOW_BUILTINS|RUN_STALE_MIN|GAP_MIN|STALL_GATE|GUARDS|READ_ROUTER|QUOTE_CHECK|BASELINE|BUGFIX_CHECK|SKILL_HINTS|TEST_CMD|JUDGE|ALLOW_HAIKU)\b|CLAUDE_PLUGIN_OPTION_|\bskill_hints\b|\ballow_haiku\b/;
  const files = [ORCH, REVIEWER, IMPLEMENTER, RESEARCHER, ".claude/agents/integrator.md", SKILL, CONVENTIONS];
  for (const file of files) assert.doesNotMatch(read(file).replace(/^---\n[\s\S]*?\n---\n/, ""), switches, `${file} names a switch`);
  for (const env of [{}, { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" }] as Record<string, string>[]) assert.doesNotMatch(nudgeContext(env), switches, "the nudge context names a switch");
  for (const reason of ["not_in_plan", "opus_review_required", "replan_required", "builtin_agent_in_run"]) assert.ok(read(ORCH).includes(reason), `${ORCH} keeps the reason ${reason}`);
  const maintainer = read(".claude/rules/agents.md") + read("CLAUDE.md");
  for (const s of ["ORCH_GAP_MIN", "ORCH_STALL_GATE", "ORCH_GUARDS", "ORCH_READ_ROUTER", "ORCH_QUOTE_CHECK", "ORCH_BASELINE", "ORCH_BUGFIX_CHECK", "ORCH_SKILL_HINTS", "ORCH_ALLOW_HAIKU", "CLAUDE_PLUGIN_OPTION_"]) assert.ok(maintainer.includes(s), `maintainer text must name ${s}`);
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

test("the Skill tool goes to the researcher and the reviewer, not the integrator", async () => {
  const { NATIVE_TOOLS } = await import("./config.js");
  assert.ok(NATIVE_TOOLS.researcher.tools?.includes("Skill"));
  assert.ok(NATIVE_TOOLS.reviewer.tools?.includes("Skill"));
  assert.ok(!NATIVE_TOOLS.integrator.tools?.includes("Skill"));
  assert.ok(!NATIVE_TOOLS.implementer.disallowedTools?.includes("Skill"), "the implementer inherits Skill");
  for (const file of [RESEARCHER, REVIEWER]) assert.match(read(file), /^tools: .*\bSkill\b/m, `${file} frontmatter lists Skill`);
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
