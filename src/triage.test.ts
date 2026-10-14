import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentRequest, AgentResult, RunAgent } from "./agent.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideRoute } from "./auto.js";
import { TRIAGE } from "./config.js";
import { decide, parseFacts, triage, triagePrompt, TRIAGE_SCHEMA, type Facts } from "./triage.js";

const facts = (over: Partial<Facts> = {}): Facts => ({ code: true, filesToTouch: 2, linesToChange: 50, independentSlices: 1, risky: false, reason: "", ...over });

test("decide: small or sequential work goes to a plain session", () => {
  assert.equal(decide(facts()).mode, "plain");
  assert.equal(decide(facts({ filesToTouch: 8, independentSlices: 1 })).mode, "plain", "sequential, however many files");
  assert.equal(decide(facts({ filesToTouch: 3, independentSlices: 3 })).mode, "plain", "too little work to parallelise");
});

test("decide: parallel, large or risky work goes to the pipeline", () => {
  assert.equal(decide(facts({ filesToTouch: 5, independentSlices: 2 })).mode, "orchestrate");
  assert.equal(decide(facts({ filesToTouch: 12, independentSlices: 1 })).mode, "orchestrate");
  assert.equal(decide(facts({ filesToTouch: 6, risky: true })).mode, "orchestrate", "risky and spread over files");
  assert.equal(decide(facts({ filesToTouch: 2, independentSlices: 2, risky: true })).mode, "orchestrate", "risky and parallel");
});

test("decide: a small risky change gets a plain session plus an independent reviewer", () => {
  assert.equal(decide(facts({ filesToTouch: 1, risky: true })).mode, "reviewed");
  assert.equal(decide(facts({ filesToTouch: 3, risky: true })).mode, "reviewed");
  assert.equal(decide(facts({ filesToTouch: 4, risky: true })).mode, "orchestrate");
});

test("decide: line count matters, not only files", () => {
  assert.equal(decide(facts({ filesToTouch: 3, linesToChange: 2000, independentSlices: 3 })).mode, "orchestrate", "big and parallel across few files");
  const seq = decide(facts({ filesToTouch: 3, linesToChange: 2000, independentSlices: 1 }));
  assert.equal(seq.mode, "plain");
  assert.match(seq.reason, /coupled design in one context/);
  assert.equal(decide(facts({ filesToTouch: 3, linesToChange: 1499, independentSlices: 3 })).mode, "plain");
  assert.equal(decide(facts({ filesToTouch: 2, linesToChange: 200, risky: true })).mode, "reviewed");
  assert.equal(decide(facts({ filesToTouch: 2, linesToChange: 201, risky: true })).mode, "orchestrate", "risky and too large to review alone");
});

test("decide: the code fact is not part of the policy; any kind of task is sized by the same thresholds", () => {
  const sheets: Partial<Facts>[] = [
    {},
    { filesToTouch: 5, independentSlices: 2 },
    { filesToTouch: 12 },
    { filesToTouch: 3, linesToChange: 2000, independentSlices: 1 },
    { filesToTouch: 1, risky: true },
    { filesToTouch: 6, risky: true },
  ];
  for (const s of sheets) {
    assert.deepEqual(decide(facts({ ...s, code: false })), decide(facts({ ...s, code: true })), JSON.stringify(s));
  }
  // A report and a research fan-out are sized like code: one long document stays in one session, several documents split.
  assert.equal(decide(facts({ code: false, filesToTouch: 1, linesToChange: 2000 })).mode, "plain");
  assert.equal(decide(facts({ code: false, filesToTouch: 4, linesToChange: 800, independentSlices: 4 })).mode, "orchestrate");
});

test("decide: reasons do not talk about git, so they fit any kind of task", () => {
  const sheets: Partial<Facts>[] = [
    {},
    { filesToTouch: 5, independentSlices: 2 },
    { filesToTouch: 12 },
    { filesToTouch: 3, linesToChange: 2000 },
    { filesToTouch: 1, risky: true },
    { filesToTouch: 6, risky: true },
  ];
  const reasons = sheets.map((s) => decide(facts(s)).reason);
  assert.equal(new Set(reasons).size, reasons.length, "each rule says something different");
  for (const reason of reasons) assert.doesNotMatch(reason, /worktree|\bgit\b|\bcommit|\bbranch/i, reason);
  assert.match(decide(facts({ filesToTouch: 5, independentSlices: 2 })).reason, /parallel slices pay off/);
});

test("route skill mentions every TRIAGE threshold (in-model fallback cannot drift)", () => {
  const skill = readFileSync(new URL("../.claude/skills/route/SKILL.md", import.meta.url), "utf8");
  for (const [k, v] of Object.entries(TRIAGE)) {
    // Name and number together, as the "Thresholds:" line lists them ("bigLines 1500"); a bare number like 2 or 3 would match anywhere.
    assert.ok(new RegExp(`\\b${k} ${v}\\b`).test(skill), `SKILL.md must list "${k} ${v}"`);
  }
});

test("parseFacts: rejects malformed output and clamps numbers", () => {
  for (const bad of [undefined, null, "x", {}, { filesToTouch: "3", linesToChange: 1, independentSlices: 1, risky: false }, { filesToTouch: NaN, linesToChange: 1, independentSlices: 1, risky: false }, { filesToTouch: 1, linesToChange: 1, independentSlices: 1, risky: "no" }, { filesToTouch: 1, independentSlices: 1, risky: false }, { filesToTouch: 1, linesToChange: NaN, independentSlices: 1, risky: false }]) {
    assert.equal(parseFacts(bad), undefined);
  }
  const f = parseFacts({ filesToTouch: -4, linesToChange: -9, independentSlices: 99, risky: false, reason: "x".repeat(1000) })!;
  assert.equal(f.filesToTouch, 0);
  assert.equal(f.linesToChange, 0);
  assert.equal(f.independentSlices, 6);
  assert.equal(f.reason.length, 300);
  assert.equal(parseFacts({ filesToTouch: 2, linesToChange: 5, independentSlices: 0, risky: true, reason: 5 })!.independentSlices, 1);
});

test("parseFacts: keeps a boolean code; a missing or non-boolean code means true and does not invalidate the sheet", () => {
  const sheet = { filesToTouch: 2, linesToChange: 5, independentSlices: 1, risky: false, reason: "r" };
  assert.equal(parseFacts({ ...sheet, code: true })!.code, true);
  assert.equal(parseFacts({ ...sheet, code: false })!.code, false);
  assert.equal(parseFacts(sheet)!.code, true, "an older caller or a logged line has no code");
  for (const odd of [undefined, null, "false", "no", 0, 1, [], {}]) {
    assert.equal(parseFacts({ ...sheet, code: odd })!.code, true, `code: ${JSON.stringify(odd)}`);
  }
  // The other fields are still validated whatever code says.
  assert.equal(parseFacts({ ...sheet, code: false, risky: "no" }), undefined);
  assert.equal(parseFacts({ ...sheet, code: false, filesToTouch: "3" }), undefined);
});

test("TRIAGE_SCHEMA requires every fact, code included, and nothing else", () => {
  assert.ok(TRIAGE_SCHEMA.required.includes("code"));
  assert.deepEqual(TRIAGE_SCHEMA.properties.code, { type: "boolean" });
  assert.deepEqual([...TRIAGE_SCHEMA.required].sort(), Object.keys(TRIAGE_SCHEMA.properties).sort());
  assert.equal(TRIAGE_SCHEMA.additionalProperties, false);
});

test("triagePrompt: sizes any kind of task and defines every fact", () => {
  const p = triagePrompt("compare three vendors and write a recommendation");
  assert.ok(p.startsWith("Task:\ncompare three vendors and write a recommendation\n"));
  for (const name of ["code", "filesToTouch", "linesToChange", "independentSlices", "risky", "reason"]) {
    assert.ok(p.includes(`- ${name}:`), `the prompt defines ${name}`);
  }
  assert.match(p, /research/i);
  assert.match(p, /writing/i);
  assert.match(p, /code repository or any other folder/);
  assert.match(p, /only as much as needed to size/);
  assert.match(p, /Do not plan or implement/);
  // code is told apart by what the output is, and the other facts count documents and prose, not only source files.
  assert.match(p, /code: true when the task creates or changes source code, tests, build or CI configuration/);
  assert.match(p, /false for research, writing, analysis, planning or operations/);
  assert.match(p, /of any kind \(source, docs, reports, data, config\)/);
  assert.match(p, /prose and data included/);
  assert.match(p, /report in 1 file is 400/, "a long report counts its lines too");
  assert.match(p, /research questions whose findings are combined at the end/);
  assert.match(p, /no shared output file/);
  assert.match(p, /content sent or published outside the team/);
  assert.match(p, /production operations \(deploys, infrastructure, credentials\)/);
});

const result = (over: Partial<AgentResult>): AgentResult => ({
  ok: true, text: "", tokens: 40, turns: 1, subtype: "success", durationMs: 1, model: "fake", ...over,
});
const runWith = (res: Partial<AgentResult>): { run: RunAgent; calls: AgentRequest[] } => {
  const calls: AgentRequest[] = [];
  return { calls, run: async (req) => (calls.push(req), result(res)) };
};

test("triage: one read-only triager call, policy applied, tokens recorded", async () => {
  const { run, calls } = runWith({ structured: { filesToTouch: 1, linesToChange: 3, independentSlices: 1, risky: false, reason: "typo" } });
  const d = await triage({ run, repo: "/r", task: "fix the typo in README" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.role, "triager");
  assert.ok(calls[0]!.prompt.includes("fix the typo in README"));
  assert.deepEqual([d.mode, d.source, d.tokens], ["plain", "triage", 40]);
  assert.equal(d.facts!.reason, "typo");
});

test("triage: failure or invalid output falls back to the full pipeline", async () => {
  const failed = await triage({ ...runWith({ ok: false, subtype: "error_max_turns" }), repo: "/r", task: "t" });
  assert.deepEqual([failed.mode, failed.source], ["orchestrate", "fallback"]);
  assert.match(failed.reason, /error_max_turns/);
  const invalid = await triage({ ...runWith({ structured: { nope: 1 } }), repo: "/r", task: "t" });
  assert.deepEqual([invalid.mode, invalid.source], ["orchestrate", "fallback"]);
  assert.equal(invalid.tokens, 40, "a failed triage still reports its tokens");
  assert.equal(failed.tokens, 40, "so does a failed worker");
});

test("triage: a folder that is not a git repository works, and neither triage nor the route decision calls git", async () => {
  const dir = mkdtempSync(join(tmpdir(), "orch-notgit-"));
  mkdirSync(join(dir, "interviews"));
  writeFileSync(join(dir, "interviews", "notes.md"), "interview notes\n");
  assert.equal(existsSync(join(dir, ".git")), false);
  // A git first on PATH that records every call and fails: if anything on the triage path used git, it would show.
  const bin = mkdtempSync(join(tmpdir(), "orch-gitstub-"));
  const marker = join(bin, "git-was-called");
  writeFileSync(join(bin, "git"), `#!/bin/sh\necho "$@" >> "${marker}"\nexit 1\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const { run, calls } = runWith({ structured: { code: false, filesToTouch: 1, linesToChange: 120, independentSlices: 1, risky: false, reason: "one report" } });
    const d = await triage({ run, repo: dir, task: "summarise the interview notes in a report" });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.role, "triager");
    assert.equal(calls[0]!.cwd, dir, "the triager reads the folder it was given, git or not");
    assert.deepEqual([d.mode, d.source], ["plain", "triage"]);
    assert.equal(d.facts!.code, false);

    // The route JSON that scripts/auto.sh and the /route skill read: facts.code from triage, no facts for a forced mode.
    const routed = JSON.parse(JSON.stringify(await decideRoute({ run, repo: dir, task: "t", mode: "auto" })));
    assert.equal(routed.facts.code, false);
    assert.equal(routed.mode, "plain");
    const forced = JSON.parse(JSON.stringify(await decideRoute({ run, repo: dir, task: "t", mode: "reviewed" })));
    assert.deepEqual([forced.mode, forced.source], ["reviewed", "forced"]);
    assert.equal(forced.facts, undefined, "a forced route has no facts; the caller looks at the folder");
  } finally {
    process.env.PATH = path;
  }
  assert.equal(existsSync(marker), false, "git was never called");
});

test("triage: a sheet without code still routes, and code stays true for the caller", async () => {
  const d = await triage({ ...runWith({ structured: { filesToTouch: 1, linesToChange: 3, independentSlices: 1, risky: false, reason: "typo" } }), repo: "/r", task: "t" });
  assert.deepEqual([d.mode, d.source], ["plain", "triage"]);
  assert.equal(d.facts!.code, true);
});
