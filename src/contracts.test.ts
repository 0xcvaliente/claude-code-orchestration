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
  for (const h of ["state.mjs", "plan-check.mjs", "journal.mjs"]) copyFileSync(join(root, ".claude", "hooks", h), join(hooks, h));
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
