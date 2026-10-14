import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRequest, AgentResult, RunAgent } from "./agent.js";
import { auto } from "./auto.js";
import { git } from "./git.js";

async function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "orch-repo-"));
  await git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "base\n");
  await git(dir, "add", "-A");
  await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return dir;
}
const outRoot = () => mkdtempSync(join(tmpdir(), "orch-out-"));
const result = (over: Partial<AgentResult> = {}): AgentResult => ({
  ok: true, text: "done", tokens: 50, turns: 1, subtype: "success", durationMs: 1, model: "fake", ...over,
});

/** Triager answers with `facts`; a solo session writes solo.txt; planner and the rest behave as in orchestrator.test.ts. */
function fake(facts: object): { run: RunAgent; calls: AgentRequest[] } {
  const calls: AgentRequest[] = [];
  const run: RunAgent = async (req) => {
    calls.push(req);
    const props = (req.schema?.properties ?? {}) as Record<string, unknown>;
    if (req.role === "triager") return result({ structured: facts });
    if (req.role === "solo") {
      writeFileSync(join(req.cwd, "solo.txt"), "x\n");
      return result();
    }
    if ("questions" in props) return result({ structured: { questions: [] } });
    if ("slices" in props) {
      return result({ structured: { slices: [{ id: "a", goal: "g", files: ["a.txt"], acceptance: "a", dependsOn: [] }] } });
    }
    if (req.role === "writer") writeFileSync(join(req.cwd, "a.txt"), "a\n");
    if ("pass" in props) return result({ structured: { pass: true, issues: [], summary: "" } });
    return result();
  };
  return { run, calls };
}

const small = { filesToTouch: 1, linesToChange: 20, independentSlices: 1, risky: false, reason: "tiny" };
const big = { filesToTouch: 9, linesToChange: 400, independentSlices: 3, risky: false, reason: "three modules" };

test("auto: a small task runs as a plain session in the repo itself, uncommitted, no pipeline roles", async () => {
  const repo = await tempRepo();
  const { run, calls } = fake(small);
  const out = outRoot();
  const r = await auto({ repo, task: "t", outRoot: out, run });

  assert.equal(r.decision.mode, "plain");
  assert.equal(r.report, undefined);
  assert.equal(r.soloReport!.ok, true);
  assert.deepEqual(calls.map((c) => c.role), ["triager", "solo"]);
  assert.ok(existsSync(join(repo, "solo.txt")), "edits land in the working tree");
  assert.equal((await git(repo, "rev-list", "--count", "HEAD")).trim(), "1", "nothing committed");
  assert.equal(r.soloReport!.tokensByRole.triager, 50, "triage tokens are reported");
  assert.equal(readFileSync(join(out, "routes.jsonl"), "utf8").trim().split("\n").length, 1);
});

test("auto: a parallel task runs the pipeline and reports the triage tokens", async () => {
  const repo = await tempRepo();
  const { run, calls } = fake(big);
  const r = await auto({ repo, task: "t", outRoot: outRoot(), run });

  assert.equal(r.decision.mode, "orchestrate");
  assert.equal(r.soloReport, undefined);
  assert.ok(calls.some((c) => c.role === "planner") && calls.some((c) => c.role === "writer"));
  assert.ok(!calls.some((c) => c.role === "solo"));
  assert.equal(r.report!.tokensByRole.triager, 50);
});

test("auto: a forced mode skips triage entirely", async () => {
  const repo = await tempRepo();
  const plain = fake(big);
  const p = await auto({ repo, task: "t", outRoot: outRoot(), run: plain.run, mode: "plain" });
  assert.deepEqual(plain.calls.map((c) => c.role), ["solo"]);
  assert.equal(p.decision.source, "forced");

  const orch = fake(small);
  const o = await auto({ repo: await tempRepo(), task: "t", outRoot: outRoot(), run: orch.run, mode: "orchestrate" });
  assert.ok(!orch.calls.some((c) => c.role === "triager" || c.role === "solo"));
  assert.equal(o.decision.mode, "orchestrate");
});

test("auto: --plan-only implies the pipeline without triage", async () => {
  const { run, calls } = fake(small);
  const r = await auto({ repo: await tempRepo(), task: "t", outRoot: outRoot(), run, planOnly: true });
  assert.equal(r.decision.reason, "--plan-only");
  assert.ok(!calls.some((c) => c.role === "triager"));
});

test("auto: a failing test command marks the plain session failed", async () => {
  const { run } = fake(small);
  const r = await auto({ repo: await tempRepo(), task: "t", outRoot: outRoot(), run, testCmd: "echo boom >&2; exit 1" });
  assert.equal(r.soloReport!.ok, false);
  assert.equal(r.soloReport!.testsPassed, false);
  assert.match(r.soloReport!.error!, /boom/);
});

test("auto: failed triage falls back to the pipeline", async () => {
  const { run } = fake({ nope: 1 });
  const r = await auto({ repo: await tempRepo(), task: "t", outRoot: outRoot(), run });
  assert.equal(r.decision.source, "fallback");
  assert.ok(r.report);
});

const risky = { filesToTouch: 2, linesToChange: 50, independentSlices: 1, risky: true, reason: "auth" };

/** Like fake(), but verdicts come from `verdicts` in order (then pass) and the solo session's tests can be made to fail once. */
function reviewed(facts: object, verdicts: boolean[]) {
  const inner = fake(facts);
  let v = 0;
  const run: RunAgent = async (req) => {
    if (req.role === "verifier" && !req.schema?.properties?.hasOwnProperty("slices") && req.cwd && !req.cwd.includes("worktrees")) {
      inner.calls.push(req);
      const pass = verdicts[Math.min(v++, verdicts.length - 1)]!;
      return result({ structured: { pass, issues: pass ? [] : ["missing null check"], summary: "" } });
    }
    return inner.run(req);
  };
  return { run, calls: inner.calls };
}

test("auto: a small risky change runs a plain session, then an independent reviewer", async () => {
  const repo = await tempRepo();
  const { run, calls } = reviewed(risky, [true]);
  const r = await auto({ repo, task: "t", outRoot: outRoot(), run });

  assert.equal(r.decision.mode, "reviewed");
  assert.deepEqual(calls.map((c) => c.role), ["triager", "solo", "verifier"]);
  assert.equal(r.soloReport!.reviewPassed, true);
  assert.equal(r.soloReport!.ok, true);
  assert.ok(calls[2]!.prompt.includes("git diff HEAD"), "the reviewer is pointed at the uncommitted change");
});

test("reviewed: the reviewer's issues go back to the session, then it is reviewed again", async () => {
  const { run, calls } = reviewed(risky, [false, true]);
  const r = await auto({ repo: await tempRepo(), task: "t", outRoot: outRoot(), run });

  assert.deepEqual(calls.map((c) => c.role), ["triager", "solo", "verifier", "solo", "verifier"]);
  assert.ok(calls[3]!.prompt.includes("missing null check"));
  assert.equal(r.soloReport!.attempts, 2);
  assert.equal(r.soloReport!.ok, true);
  assert.equal(r.escalated, false);
});

test("escalation: a triaged plain session that fails its tests is rerun through the pipeline", async () => {
  const repo = await tempRepo();
  const { run, calls } = fake(small);
  const r = await auto({ repo, task: "t", outRoot: outRoot(), run, testCmd: "test -f a.txt" });

  assert.equal(r.escalated, true);
  assert.equal(r.decision.source, "escalated");
  assert.equal(r.soloReport!.ok, false);
  assert.ok(calls.some((c) => c.role === "planner"), "the pipeline ran");
  assert.ok(r.report!.tokensByRole.triager! > 0 && r.report!.tokensByRole.solo! > 0, "earlier spend is carried into the report");
});

test("escalation: off for a forced mode and with escalate: false", async () => {
  const forced = fake(small);
  const a = await auto({ repo: await tempRepo(), task: "t", outRoot: outRoot(), run: forced.run, mode: "plain", testCmd: "exit 1" });
  assert.equal(a.escalated, false);
  assert.ok(!forced.calls.some((c) => c.role === "planner"));

  const optOut = fake(small);
  const b = await auto({ repo: await tempRepo(), task: "t", outRoot: outRoot(), run: optOut.run, testCmd: "exit 1", escalate: false });
  assert.equal(b.escalated, false);
  assert.equal(b.soloReport!.ok, false);
  assert.ok(!optOut.calls.some((c) => c.role === "planner"));
});

/** `fake()` with a fixed token count per role (default 1000), to exercise the budget arithmetic. */
const withTokens = (inner: RunAgent, by: Record<string, number>): RunAgent => async (req) => ({ ...(await inner(req)), tokens: by[req.role] ?? 1000 });
const calledRoles = (calls: AgentRequest[]) => calls.map((c) => c.role);

// The pipeline's planner calls (questions, slices) cost 2 x 1000 before the first slice checks the budget.
test("budget: triage tokens are subtracted, so the pipeline stops earlier than the full budget allows", async () => {
  const full = fake(big);
  const forced = await auto({ repo: await tempRepo(), task: "t", outRoot: outRoot(), run: withTokens(full.run, {}), mode: "orchestrate", runBudgetTokens: 4000 });
  assert.equal(forced.report!.slices[0]!.status, "passed", "4000 is enough when nothing was spent before");

  const { run, calls } = fake(big);
  const r = await auto({ repo: await tempRepo(), task: "t", outRoot: outRoot(), run: withTokens(run, { triager: 2500 }), runBudgetTokens: 4000 });
  assert.equal(r.decision.source, "triage");
  assert.deepEqual(r.report!.slices[0]!.issues, ["run budget exhausted"]); // 4000 - 2500 = 1500 < 2000 spent on planning
  assert.ok(!calledRoles(calls).includes("writer"));
  assert.equal(r.report!.spentTokens, 2500 + 2000, "triage tokens are carried into the report");
});

test("budget: an escalated pipeline run also gets the failed solo session's tokens subtracted", async () => {
  const { run, calls } = fake(small);
  const r = await auto({
    repo: await tempRepo(), task: "t", outRoot: outRoot(), run: withTokens(run, { triager: 500 }),
    testCmd: "test -f a.txt", runBudgetTokens: 3000, // 3000 - 500 triage - 1000 solo = 1500 < 2000 spent on planning
  });
  assert.equal(r.escalated, true);
  assert.equal(r.soloReport!.tokensByRole.solo, 1000);
  assert.deepEqual(r.report!.slices[0]!.issues, ["run budget exhausted"]);
  assert.ok(!calledRoles(calls).includes("writer"));
  assert.equal(r.report!.tokensByRole.triager, 500);
  assert.equal(r.report!.tokensByRole.solo, 1000);

  // Counting only the triage tokens would leave 2500, enough for the slice: the solo tokens are what stop it.
  const roomy = fake(small);
  const ok = await auto({ repo: await tempRepo(), task: "t", outRoot: outRoot(), run: withTokens(roomy.run, { triager: 500 }), testCmd: "test -f a.txt", runBudgetTokens: 4000 });
  assert.equal(ok.report!.slices[0]!.status, "passed");
});

test("budget: earlier spend that already meets the budget leaves a floor of 1 token, not a crash", async () => {
  const { run, calls } = fake(big);
  const r = await auto({ repo: await tempRepo(), task: "t", outRoot: outRoot(), run: withTokens(run, { triager: 5000 }), runBudgetTokens: 3000 });
  assert.deepEqual(r.report!.slices[0]!.issues, ["run budget exhausted"]);
  assert.ok(!calledRoles(calls).includes("writer"));
});
