import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentRequest, AgentResult, RunAgent } from "./agent.js";
import { git } from "./git.js";
import { orchestrate, waves, type Slice } from "./orchestrator.js";

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
  ok: true, text: "done", costUsd: 0.01, turns: 1, subtype: "success", durationMs: 1, model: "fake", ...over,
});

const kind = (req: AgentRequest) => {
  const props = (req.schema?.properties ?? {}) as Record<string, unknown>;
  return "questions" in props ? "questions" : "slices" in props ? "slices" : "pass" in props ? "verdict" : req.role;
};
const sliceOf = (req: AgentRequest) => /your slice \(([^)]+)\)/i.exec(req.prompt)?.[1] ?? "";

interface Hooks {
  /** Return false to fail verification; `n` counts verifier calls for that worktree. */
  verdict?: (n: number) => boolean;
  write?: (cwd: string, id: string) => void;
  cost?: number;
}

/** A scripted fake model: each slice writes `<id>.txt` unless a hook overrides it. */
function fake(slices: unknown[], hooks: Hooks = {}): { run: RunAgent; calls: AgentRequest[] } {
  const calls: AgentRequest[] = [];
  const verifierCalls = new Map<string, number>();
  const cost = hooks.cost ?? 0.01;
  const write = hooks.write ?? ((cwd, id) => writeFileSync(join(cwd, `${id}.txt`), `${id}\n`));

  const run: RunAgent = async (req) => {
    calls.push(req);
    switch (kind(req)) {
      case "questions":
        return result({ costUsd: cost, structured: { questions: ["where is the entry point?"] } });
      case "slices":
        return result({ costUsd: cost, structured: { slices } });
      case "explorer":
        return result({ costUsd: cost, text: "entry point is main.ts" });
      case "writer":
        write(req.cwd, sliceOf(req));
        return result({ costUsd: cost });
      default: {
        const n = (verifierCalls.get(req.cwd) ?? 0) + 1;
        verifierCalls.set(req.cwd, n);
        const pass = hooks.verdict ? hooks.verdict(n) : true;
        return result({ costUsd: cost, structured: { pass, issues: pass ? [] : ["fix the edge case"], summary: "" } });
      }
    }
  };
  return { run, calls };
}

const slice = (id: string, dependsOn: string[] = []) => ({
  id, goal: `do ${id}`, files: [`${id}.txt`], acceptance: "file exists", dependsOn,
});

test("happy path: plans, writes in worktrees, verifies, merges, tracks cost per role", async () => {
  const repo = await tempRepo();
  const { run, calls } = fake([slice("alpha"), slice("beta")]);
  const report = await orchestrate({ repo, task: "t", outRoot: outRoot(), run });

  assert.deepEqual(report.slices.map((s) => s.status), ["passed", "passed"]);
  assert.equal(report.merged.length, 2);
  assert.deepEqual(report.conflicted, []);
  const files = (await git(repo, "ls-tree", "--name-only", report.resultBranch!)).split("\n");
  assert.ok(files.includes("alpha.txt") && files.includes("beta.txt"));
  assert.ok((report.costByRole.writer ?? 0) > 0 && (report.costByRole.planner ?? 0) > 0);
  assert.equal(calls.filter((c) => c.role === "explorer").length, 1);
  assert.ok(calls.find((c) => c.role === "writer")!.prompt.includes("entry point is main.ts"), "findings reach writers");
});

test("failed verification retries the writer with the verifier's feedback", async () => {
  const repo = await tempRepo();
  const { run, calls } = fake([slice("alpha")], { verdict: (n) => n >= 2 });
  const report = await orchestrate({ repo, task: "t", outRoot: outRoot(), run });

  assert.equal(report.slices[0]!.status, "passed");
  assert.equal(report.slices[0]!.attempts, 2);
  const writers = calls.filter((c) => c.role === "writer");
  assert.ok(!writers[0]!.prompt.includes("fix the edge case"));
  assert.ok(writers[1]!.prompt.includes("fix the edge case"));
});

test("a failing test command skips the verifier and feeds the output back", async () => {
  const repo = await tempRepo();
  const { run, calls } = fake([slice("alpha")]);
  const report = await orchestrate({
    repo, task: "t", outRoot: outRoot(), run, testCmd: "echo boom >&2; exit 1", maxRetries: 1,
  });

  assert.equal(report.slices[0]!.status, "failed");
  assert.equal(calls.filter((c) => c.role === "verifier").length, 0, "no tokens spent on the verifier");
  assert.ok(calls.filter((c) => c.role === "writer")[1]!.prompt.includes("boom"));
});

test("run budget stops new work", async () => {
  const repo = await tempRepo();
  const { run } = fake([slice("alpha")], { cost: 1 });
  const report = await orchestrate({ repo, task: "t", outRoot: outRoot(), run, runBudgetUsd: 3 });

  assert.equal(report.slices[0]!.status, "failed");
  assert.deepEqual(report.slices[0]!.issues, ["run budget exhausted"]);
  assert.equal(report.resultBranch, undefined);
});

test("without a run budget there is no dollar cap", async () => {
  const repo = await tempRepo();
  const { run } = fake([slice("alpha")], { cost: 100 });
  const report = await orchestrate({ repo, task: "t", outRoot: outRoot(), run });

  assert.equal(report.slices[0]!.status, "passed");
  assert.ok(report.spentUsd > 100, "cost is still reported");
});

test("model-chosen slice ids cannot escape the worktree directory or collide", async () => {
  const repo = await tempRepo();
  const { run } = fake([slice("../../etc/passwd"), slice("../../etc/passwd")]);
  const report = await orchestrate({ repo, task: "t", outRoot: outRoot(), run });

  const ids = report.slices.map((s) => s.id);
  assert.equal(new Set(ids).size, 2);
  assert.ok(ids.every((id) => /^[a-z0-9-]+$/.test(id)));
});

test("conflicting slices: one merges, the other is reported, the user's checkout is untouched", async () => {
  const repo = await tempRepo();
  const { run } = fake([slice("alpha"), slice("beta")], {
    write: (cwd, id) => writeFileSync(join(cwd, "shared.txt"), `${id}\n`),
  });
  const report = await orchestrate({ repo, task: "t", outRoot: outRoot(), run, concurrency: 1 });

  assert.equal(report.merged.length, 1);
  assert.equal(report.conflicted.length, 1);
  assert.equal(readFileSync(join(repo, "README.md"), "utf8"), "base\n");
  assert.equal(await git(repo, "status", "--porcelain"), "");
});

test("plan-only stops after planning and creates no branches", async () => {
  const repo = await tempRepo();
  const { run, calls } = fake([slice("alpha")]);
  const report = await orchestrate({ repo, task: "t", outRoot: outRoot(), run, planOnly: true });

  assert.equal(report.slices.length, 0);
  assert.equal(calls.filter((c) => c.role === "writer").length, 0);
  assert.equal(await git(repo, "branch", "--list", "orch/*"), "");
});

test("a dependent slice starts from its dependency's work and is reviewed on its own diff", async () => {
  const repo = await tempRepo();
  const seen: Record<string, boolean> = {};
  const { run, calls } = fake([slice("beta", ["alpha"]), slice("alpha")], {
    write: (cwd, id) => {
      seen[id] = existsSync(join(cwd, "alpha.txt"));
      writeFileSync(join(cwd, `${id}.txt`), `${id}\n`);
    },
  });
  const report = await orchestrate({ repo, task: "t", outRoot: outRoot(), run });

  assert.equal(seen.beta, true, "beta's worktree already contains alpha's file");
  assert.equal(seen.alpha, false);
  assert.deepEqual(report.slices.map((s) => s.status), ["passed", "passed"]);
  assert.equal(report.conflicted.length, 0);
  const order = calls.filter((c) => c.role === "writer").map((c) => sliceOf(c));
  assert.deepEqual(order, ["alpha", "beta"], "alpha runs before beta despite being listed second");
  const betaReview = calls.find((c) => c.role === "verifier" && c.cwd.endsWith("beta"))!;
  assert.ok(!betaReview.prompt.includes(report.base), "beta is diffed against alpha's tip, not the repo base");
});

test("a slice whose dependency failed is skipped without spending tokens", async () => {
  const repo = await tempRepo();
  const { run, calls } = fake([slice("alpha"), slice("beta", ["alpha"])], { verdict: () => false });
  const report = await orchestrate({ repo, task: "t", outRoot: outRoot(), run, maxRetries: 0 });

  assert.deepEqual(report.slices.map((s) => s.status), ["failed", "failed"]);
  assert.match(report.slices[1]!.issues[0]!, /dependency failed \(alpha\)/);
  assert.equal(calls.filter((c) => c.role === "writer").length, 1, "beta never got a writer");
});

test("a failed or empty slice plan is reported as an error, not a clean run", async () => {
  const repo = await tempRepo();
  const empty = await orchestrate({ repo, task: "t", outRoot: outRoot(), run: fake([]).run });
  assert.equal(empty.error, "planner returned no usable slices");

  const base = fake([slice("alpha")]).run;
  const failing: RunAgent = async (req) =>
    kind(req) === "slices" ? result({ ok: false, subtype: "error_max_turns", text: "" }) : base(req);
  const failed = await orchestrate({ repo, task: "t", outRoot: outRoot(), run: failing });
  assert.equal(failed.error, "planner failed: error_max_turns");
  assert.equal(await git(repo, "branch", "--list", "orch/*"), "");

  const ok = await orchestrate({ repo, task: "t", outRoot: outRoot(), run: fake([slice("alpha")]).run, planOnly: true });
  assert.equal(ok.error, undefined, "plan-only with a valid plan is not an error");
});

test("a crash in one slice fails that slice only and the report is still written", async () => {
  const repo = await tempRepo();
  const out = outRoot();
  const { run } = fake([slice("alpha"), slice("beta")], {
    write: (cwd, id) => {
      if (id === "beta") throw new Error("disk on fire");
      writeFileSync(join(cwd, `${id}.txt`), `${id}\n`);
    },
  });
  const report = await orchestrate({ repo, task: "t", outRoot: out, run, concurrency: 1 });

  assert.deepEqual(report.slices.map((s) => s.status), ["passed", "failed"]);
  assert.match(report.slices[1]!.issues[0]!, /disk on fire/);
  assert.equal(report.merged.length, 1);
  assert.ok(existsSync(join(out, report.runId, "report.json")));
});

test("a NaN worker cost cannot disable the run budget", async () => {
  const repo = await tempRepo();
  const { run } = fake([slice("alpha")], { cost: 2 }); // planner x2 = $4 > $3, so the cap must trip
  const nanOnce: RunAgent = async (req) => {
    const r = await run(req);
    return req.role === "explorer" ? { ...r, costUsd: Number.NaN } : r;
  };
  const report = await orchestrate({ repo, task: "t", outRoot: outRoot(), run: nanOnce, runBudgetUsd: 3 });

  assert.ok(Number.isFinite(report.spentUsd));
  assert.deepEqual(report.slices[0]!.issues, ["run budget exhausted"]);
});

test("invalid limits are rejected before any model is called", async () => {
  const repo = await tempRepo();
  const { run, calls } = fake([slice("alpha")]);
  for (const bad of [{ runBudgetUsd: Number.NaN }, { concurrency: 0 }, { maxRetries: -1 }]) {
    await assert.rejects(orchestrate({ repo, task: "t", outRoot: outRoot(), run, ...bad }), RangeError);
  }
  assert.equal(calls.length, 0);
});

test("passing worktrees are removed after the run, branches stay, failed worktrees are kept", async () => {
  const repo = await tempRepo();
  const { run } = fake([slice("alpha"), slice("beta")], { verdict: () => true, write: (cwd, id) => {
    if (id === "beta") return; // no changes: beta fails
    writeFileSync(join(cwd, `${id}.txt`), `${id}\n`);
  } });
  const report = await orchestrate({ repo, task: "t", outRoot: outRoot(), run, maxRetries: 0 });

  assert.deepEqual(report.slices.map((s) => s.status), ["passed", "failed"]);
  const trees = await git(repo, "worktree", "list", "--porcelain");
  assert.ok(!trees.includes("worktrees/alpha") && !trees.includes("worktrees/result"), "passing and result worktrees are gone");
  assert.ok(trees.includes("worktrees/beta"), "failed worktree is kept for debugging");
  const branches = await git(repo, "branch", "--list", "orch/*");
  assert.ok(branches.includes("/alpha") && branches.includes("/result"), "branches survive cleanup");
  assert.ok((await git(repo, "ls-tree", "--name-only", report.resultBranch!)).includes("alpha.txt"));
});

test("keepWorktrees leaves every worktree in place", async () => {
  const repo = await tempRepo();
  const { run } = fake([slice("alpha")]);
  await orchestrate({ repo, task: "t", outRoot: outRoot(), run, keepWorktrees: true });
  const trees = await git(repo, "worktree", "list", "--porcelain");
  assert.ok(trees.includes("worktrees/alpha") && trees.includes("worktrees/result"));
});

test("setupCmd runs in each worktree before the writer; a failing setup fails the slice without spending on a writer", async () => {
  const repo = await tempRepo();
  let sawSetup = false;
  const ok = fake([slice("alpha")], { write: (cwd, id) => {
    sawSetup = existsSync(join(cwd, "setup.marker"));
    writeFileSync(join(cwd, `${id}.txt`), `${id}\n`);
  } });
  const good = await orchestrate({ repo, task: "t", outRoot: outRoot(), run: ok.run, setupCmd: "echo ready > setup.marker" });
  assert.equal(good.slices[0]!.status, "passed");
  assert.ok(sawSetup, "the writer started after setup finished");

  const bad = fake([slice("alpha")]);
  const failed = await orchestrate({ repo, task: "t", outRoot: outRoot(), run: bad.run, setupCmd: "echo no deps >&2; exit 3" });
  assert.equal(failed.slices[0]!.status, "failed");
  assert.match(failed.slices[0]!.issues[0]!, /setup failed \(exit 3\).*no deps/s);
  assert.equal(bad.calls.filter((c) => c.role === "writer").length, 0);
});

test("waves: orders by dependency and breaks cycles instead of hanging", () => {
  const mk = (id: string, dependsOn: string[]): Slice => ({ id, goal: "", files: [], acceptance: "", dependsOn });
  assert.deepEqual(waves([mk("c", ["b"]), mk("b", ["a"]), mk("a", [])]).map((w) => w.map((s) => s.id)), [["a"], ["b"], ["c"]]);
  assert.deepEqual(waves([mk("x", ["y"]), mk("y", ["x"])]).map((w) => w.map((s) => s.id)), [["x", "y"]]);
});

/** The fake, but the planner answers each `slices` request from `plans` in turn and verdicts follow `passes(cwd)`. */
function scripted(plans: unknown[][], passes: (cwd: string) => boolean) {
  const inner = fake([]);
  let n = 0;
  const run: RunAgent = async (req) => {
    if (kind(req) === "slices") {
      inner.calls.push(req);
      return result({ structured: { slices: plans[Math.min(n++, plans.length - 1)] } });
    }
    if (kind(req) === "verdict") {
      inner.calls.push(req);
      const pass = passes(req.cwd);
      return result({ structured: { pass, issues: pass ? [] : ["wrong approach"], summary: "" } });
    }
    return inner.run(req);
  };
  return { run, calls: inner.calls };
}

test("replan: failed slices are replaced by new slices for the missing work; the old branch is never merged", async () => {
  const repo = await tempRepo();
  const { run, calls } = scripted([[slice("alpha")], [slice("beta")]], (cwd) => cwd.endsWith("beta"));
  const report = await orchestrate({ repo, task: "t", outRoot: outRoot(), run, maxRetries: 0, maxReplans: 1 });

  assert.deepEqual(report.slices.map((s) => [s.id, s.status]), [["alpha", "replaced"], ["beta", "passed"]]);
  assert.equal(report.replans, 1);
  const files = (await git(repo, "ls-tree", "--name-only", report.resultBranch!)).split("\n");
  assert.ok(files.includes("beta.txt") && !files.includes("alpha.txt"));
  const replanPrompt = calls.filter((c) => kind(c) === "slices")[1]!.prompt;
  assert.ok(replanPrompt.includes("alpha") && replanPrompt.includes("wrong approach"), "the planner sees what failed and why");
});

test("replan is off by default, and a replan with no usable slices stops cleanly", async () => {
  const off = await orchestrate({ repo: await tempRepo(), task: "t", outRoot: outRoot(), run: scripted([[slice("alpha")]], () => false).run, maxRetries: 0 });
  assert.deepEqual(off.slices.map((s) => s.status), ["failed"]);
  assert.equal(off.replans, 0);

  const empty = await orchestrate({ repo: await tempRepo(), task: "t", outRoot: outRoot(), run: scripted([[slice("alpha")], []], () => false).run, maxRetries: 0, maxReplans: 2 });
  assert.deepEqual(empty.slices.map((s) => s.status), ["failed"], "nothing replaced when the planner offers nothing");
  assert.equal(empty.replans, 0);
});

test("a new slice may depend on a slice that already passed", async () => {
  const repo = await tempRepo();
  const plans = [[slice("alpha"), slice("beta")], [slice("gamma", ["alpha"])]];
  const { run } = scripted(plans, (cwd) => !cwd.endsWith("beta"));
  const report = await orchestrate({ repo, task: "t", outRoot: outRoot(), run, maxRetries: 0, maxReplans: 1 });

  assert.deepEqual(report.slices.map((s) => [s.id, s.status]), [["alpha", "passed"], ["beta", "replaced"], ["gamma", "passed"]]);
  const files = (await git(repo, "ls-tree", "--name-only", report.resultBranch!)).split("\n");
  assert.ok(files.includes("alpha.txt") && files.includes("gamma.txt"));
});

test("resume: skips planning and passed slices, restarts the failed one, and merges everything", async () => {
  const repo = await tempRepo();
  const out = outRoot();
  const first = scripted([[slice("alpha"), slice("beta")]], (cwd) => !cwd.endsWith("beta"));
  const r1 = await orchestrate({ repo, task: "build both", outRoot: out, run: first.run, maxRetries: 0 });
  assert.deepEqual(r1.slices.map((s) => s.status), ["passed", "failed"]);

  const second = scripted([[]], () => true);
  const r2 = await orchestrate({ repo, task: "ignored on resume", outRoot: out, run: second.run, resume: r1.runId });
  assert.equal(r2.resumed, true);
  assert.equal(r2.runId, r1.runId);
  assert.deepEqual(r2.slices.map((s) => s.status), ["passed", "passed"]);
  assert.ok(!second.calls.some((c) => c.role === "planner" || c.role === "explorer"), "no planning on resume");
  const writers = second.calls.filter((c) => c.role === "writer");
  assert.equal(writers.length, 1);
  assert.ok(writers[0]!.prompt.includes("build both") && writers[0]!.prompt.includes("beta"), "the journal's task is used");
  const files = (await git(repo, "ls-tree", "--name-only", r2.resultBranch!)).split("\n");
  assert.ok(files.includes("alpha.txt") && files.includes("beta.txt"));
});

test("resume: an unknown run id is an error, not a fresh run", async () => {
  const { run, calls } = fake([slice("alpha")]);
  const report = await orchestrate({ repo: await tempRepo(), task: "t", outRoot: outRoot(), run, resume: "20200101000000-dead" });
  assert.match(report.error!, /cannot resume/);
  assert.equal(calls.length, 0);
});
