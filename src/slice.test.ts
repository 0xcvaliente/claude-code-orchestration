import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRequest, AgentResult, RunAgent } from "./agent.js";
import { git, headRef } from "./git.js";
import { runSlice, type Slice, type SliceContext, type SliceResult } from "./slice.js";
import { Run } from "./state.js";

async function tempRepo() {
  const dir = mkdtempSync(join(tmpdir(), "slice-repo-"));
  await git(dir, "init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "base\n");
  await git(dir, "add", "-A");
  await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
  return dir;
}

const result = (over: Partial<AgentResult> = {}): AgentResult => ({
  ok: true, text: "done", tokens: 1000, turns: 1, subtype: "success", durationMs: 1, model: "fake", ...over,
});

const slice: Slice = { id: "alpha", goal: "do alpha", files: ["alpha.txt"], acceptance: "file exists", dependsOn: [] };

/** Writers create alpha.txt; the verifier's verdict for call n comes from `verdict`. */
function fake(verdict: (n: number) => boolean = () => true, tokens = 1000) {
  const calls: AgentRequest[] = [];
  let verifier = 0;
  const run: RunAgent = async (req) => {
    calls.push(req);
    if (req.role === "writer") {
      writeFileSync(join(req.cwd, "alpha.txt"), "alpha\n");
      return result({ tokens });
    }
    const pass = verdict(++verifier);
    return result({ tokens, structured: { pass, issues: pass ? [] : ["fix the edge case"], summary: "" } });
  };
  return { run, calls };
}

async function ctxFor(run: RunAgent, over: Partial<SliceContext> = {}) {
  const repo = await tempRepo();
  const logs: string[] = [];
  const ctx: SliceContext = {
    run, state: new Run("r1", mkdtempSync(join(tmpdir(), "slice-out-"))), repo, base: await headRef(repo),
    task: "t", judgeTask: "t", findings: "", maxRetries: 2, resumed: false, finished: new Map(), log: (l) => logs.push(l), ...over,
  };
  return { ctx, logs };
}

test("skips when a dependency did not pass, without touching git or the model", async () => {
  const { run, calls } = fake();
  const finished = new Map<string, SliceResult>([
    ["dep", { id: "dep", branch: "orch/r1/dep", status: "failed", attempts: 1, issues: ["x"] }],
  ]);
  const { ctx, logs } = await ctxFor(run, { finished });
  const r = await runSlice(ctx, { ...slice, dependsOn: ["dep", "missing"] });

  assert.equal(r.status, "failed");
  assert.equal(r.attempts, 0);
  assert.deepEqual(r.issues, ["skipped: dependency failed (dep, missing)"]);
  assert.equal(r.branch, "orch/r1/alpha");
  assert.equal(calls.length, 0);
  assert.deepEqual(logs, ["alpha: skipped: dependency failed (dep, missing)"]);
});

test("a failing setup command fails the slice before any writer runs", async () => {
  const { run, calls } = fake();
  const { ctx, logs } = await ctxFor(run, { setupCmd: "echo nope >&2; exit 3" });
  const r = await runSlice(ctx, slice);

  assert.equal(r.status, "failed");
  assert.equal(r.attempts, 0);
  assert.match(r.issues[0]!, /^setup failed \(exit 3\): .*nope/s);
  assert.equal(calls.length, 0);
  assert.ok(logs[0]!.startsWith("alpha: setup failed (exit 3)"));
});

test("writer and verifier get the user's original task and a judge audit file in the run folder", async () => {
  const { run, calls } = fake();
  const { ctx } = await ctxFor(run, { task: "journal task", judgeTask: "ORIGINAL USER TASK" });
  await runSlice(ctx, slice);

  assert.deepEqual(calls.map((c) => c.role), ["writer", "verifier"]);
  for (const c of calls) {
    assert.equal(c.task, "ORIGINAL USER TASK");
    assert.equal(c.auditFile, join(ctx.state.dir, "judge-audit.jsonl"));
  }
});

test("passes on the first attempt", async () => {
  const { run, calls } = fake();
  const { ctx, logs } = await ctxFor(run);
  const r = await runSlice(ctx, slice);

  assert.deepEqual(r, { id: "alpha", branch: "orch/r1/alpha", status: "passed", attempts: 1, issues: [] });
  assert.deepEqual(calls.map((c) => c.role), ["writer", "verifier"]);
  assert.deepEqual(logs, ["alpha: attempt 1", "alpha: passed"]);
  assert.equal(ctx.state.spentTokens, 2000);
  assert.ok((await git(ctx.repo, "ls-tree", "--name-only", r.branch)).split("\n").includes("alpha.txt"));
});

test("retries with the verifier's feedback, then passes", async () => {
  const { run, calls } = fake((n) => n >= 2);
  const { ctx } = await ctxFor(run);
  const r = await runSlice(ctx, slice);

  assert.equal(r.status, "passed");
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.issues, []);
  const writers = calls.filter((c) => c.role === "writer");
  assert.ok(!writers[0]!.prompt.includes("fix the edge case"));
  assert.ok(writers[1]!.prompt.includes("A previous attempt is already in this worktree but was rejected"));
  assert.ok(writers[1]!.prompt.includes("fix the edge case"));
});

test("exhausted retries leave the slice failed with the last issues", async () => {
  const { run, calls } = fake(() => false);
  const { ctx, logs } = await ctxFor(run, { maxRetries: 1 });
  const r = await runSlice(ctx, slice);

  assert.equal(r.status, "failed");
  assert.equal(r.attempts, 2);
  assert.deepEqual(r.issues, ["fix the edge case"]);
  assert.equal(calls.filter((c) => c.role === "writer").length, 2);
  assert.equal(logs.at(-1), "alpha: failed");
});

test("a slice with no work against its base fails even when a later attempt changes nothing", async () => {
  // Attempt 1's writer errors out; attempt 2's writer succeeds but writes nothing. Nothing is committed on the branch.
  const calls: AgentRequest[] = [];
  let writers = 0;
  const run: RunAgent = async (req) => {
    calls.push(req);
    if (req.role === "writer") {
      writers++;
      return writers === 1 ? result({ ok: false, subtype: "error_during_execution", text: "boom" }) : result();
    }
    return result({ structured: { pass: true, issues: [], summary: "" } });
  };
  const { ctx } = await ctxFor(run, { maxRetries: 1 });
  const r = await runSlice(ctx, slice);

  assert.equal(r.status, "failed");
  assert.equal(calls.filter((c) => c.role === "verifier").length, 0, "no verifier runs on an empty diff");
  assert.deepEqual(r.issues, ["The worker made no changes. Implement the slice."]);
});

test("a later attempt that adds no new commit still counts the earlier attempt's work", async () => {
  // Attempt 1 writes alpha.txt, the verifier rejects; attempt 2 changes nothing and the verifier passes.
  const calls: AgentRequest[] = [];
  let verifier = 0;
  const run: RunAgent = async (req) => {
    calls.push(req);
    if (req.role === "writer") {
      if (!calls.some((c, i) => c.role === "writer" && i < calls.length - 1)) writeFileSync(join(req.cwd, "alpha.txt"), "alpha\n");
      return result();
    }
    const pass = ++verifier >= 2;
    return result({ structured: { pass, issues: pass ? [] : ["are you sure?"], summary: "" } });
  };
  const { ctx } = await ctxFor(run, { maxRetries: 1 });
  const r = await runSlice(ctx, slice);

  assert.equal(r.status, "passed");
  assert.equal(r.attempts, 2);
});

test("a spent token budget stops the slice before the next attempt", async () => {
  const { run, calls } = fake(() => false, 1000);
  const { ctx } = await ctxFor(run, { budget: 2000, maxRetries: 5 });
  const r = await runSlice(ctx, slice);

  assert.equal(r.status, "failed");
  assert.equal(r.attempts, 1, "one attempt (writer + verifier = 2000 tokens) exhausts the budget");
  assert.deepEqual(r.issues, ["run budget exhausted"]);
  assert.equal(calls.length, 2);
});
