// Tests orchestrate.js against a STUBBED Workflow runtime (fake agent/parallel/pipeline/phase/log).
// They do not show that the real runtime's agent() launches reach PreToolUse hooks or that Stop gates fire.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, ".claude", "workflows", "orchestrate.js"), "utf8");
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

// `export const meta = {...}` must be a pure literal: evaluate it alone in an empty vm context.
function loadMeta() {
  const m = source.match(/^export const meta = (\{[\s\S]*?\n\})\n/m);
  assert.ok(m, "export const meta block found");
  return vm.runInNewContext(`(${m[1]})`, Object.create(null));
}
const meta = loadMeta();
const body = source.replace(/^export const meta = /m, "const meta = ");

/** @param {string} id @param {Record<string, unknown>} [o] */
const slice = (id, o = {}) => ({ id, goal: `goal ${id}`, files: [`${id}.txt`], acceptance: `check ${id}`, dependsOn: [], risky: false, ...o });

// Runs the script with a fake runtime. `slices` is the plan; `verdict(label)` returns a reviewer verdict.
/** @typedef {{ args?: Record<string, unknown>, slices?: any[], constraints?: any[], replan?: any, questions?: string[], verdict?: (label: string, opts: any) => any, implement?: (label: string, opts: any) => any }} RunOpts */
/** @param {RunOpts} [opts] */
async function run({ args = {}, slices, constraints, replan = { slices: [] }, questions = [], verdict = () => ({ pass: true, gaps: [], evidence: "ok" }), implement } = {}) {
  /** @type {any[]} */
  const calls = [];
  /** @type {string[]} */
  const phases = [];
  /** @type {string[]} */
  const logs = [];
  /** @param {string} prompt @param {any} [opts] */
  const fakeAgent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts });
    const { label = "", agentType } = opts;
    if (label === "plan:questions") return { questions };
    if (label === "plan:slices") return constraints ? { constraints, slices } : { slices };
    if (label === "plan:replan") return replan;
    if (label === "checkpoint") return { status: "pass", commit: "abc123", open: "" };
    if (agentType === "researcher") return `answer to ${prompt}`;
    if (agentType === "implementer") return implement ? implement(label, opts) : { status: "pass", branch: opts.isolation ? `wt-${label}` : "", evidence: "ok", open: "" };
    if (agentType === "reviewer") return verdict(label, opts);
    if (agentType === "integrator") return "merged";
    throw new Error(`unexpected agent call ${label}`);
  };
  /** @param {Array<() => unknown>} fns */
  const parallel = (fns) => Promise.all(fns.map((f) => f()));
  /** @param {any[]} items @param {(item: any) => unknown} fn */
  const pipeline = (items, fn) => Promise.all(items.map((i) => fn(i)));
  const fn = new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", body);
  const result = await fn({ task: "do the thing", ...args }, fakeAgent, parallel, pipeline, (/** @type {string} */ t) => phases.push(t), (/** @type {string} */ m) => logs.push(m));
  return { result, calls, phases, logs };
}
/** @param {any[]} calls */
const labels = (calls) => calls.map((c) => c.opts.label);
/** @param {any[]} calls */
const implementers = (calls) => calls.filter((c) => c.opts.agentType === "implementer");

test("meta is a pure literal whose phases match the phase() titles the script uses", async () => {
  assert.equal(meta.name, "orchestrate");
  assert.ok(meta.description && meta.description.length > 10);
  const titles = Array.from(meta.phases, (p) => p.title);
  assert.deepEqual(titles, ["Plan", "Explore", "Build", "Integrate"]);
  const used = new Set([...source.matchAll(/\bphase\('([^']+)'\)/g)].map((m) => /** @type {string} */ (m[1])));
  for (const u of used) assert.ok(titles.includes(u), `phase ${u} declared in meta`);
  const optsUsed = new Set([...source.matchAll(/phase: '([^']+)'/g)].map((m) => /** @type {string} */ (m[1])));
  for (const u of optsUsed) assert.ok(titles.includes(u), `agent phase ${u} declared in meta`);
  const r = await run({ slices: [slice("a")] });
  assert.deepEqual(r.phases, ["Plan", "Explore", "Build"], "Integrate only when worktrees were used");
});

test("one slice: plan, explore, implement (workflow brief), review, in that order", async () => {
  const r = await run({ slices: [slice("only")], questions: ["q1", "q2"] });
  assert.deepEqual(labels(r.calls), ["plan:questions", "explore:q1", "explore:q2", "plan:slices", "build:only#1", "review:only#1"]);
  const brief = implementers(r.calls)[0].prompt;
  assert.match(brief, /^ORCHESTRATION: workflow\nSlice only\n/);
  assert.match(brief, /Files you own: only\.txt/);
  assert.match(brief, /Do not commit\./);
  assert.deepEqual(r.result.slices, [{ id: "only", status: "passed", attempts: 1, gaps: [] }]);
  assert.equal(r.result.passed, 1);
  assert.equal(r.result.failed, 0);
});

test("no slices returns early without implementers", async () => {
  const r = await run({ slices: [] });
  assert.equal(implementers(r.calls).length, 0);
  assert.equal(r.result.note, "planner returned no slices");
});

test("multi-slice plan: dependencies fix the order; shared-tree code runs one slice at a time", async () => {
  const slices = [slice("a"), slice("b"), slice("c", { dependsOn: ["a", "b"] })];
  const r = await run({ slices });
  const l = labels(r.calls);
  const idx = (/** @type {string} */ x) => l.indexOf(x);
  assert.ok(idx("plan:slices") < idx("build:a#1"));
  // without baseRefHead a wave of two runs sequentially: a built and reviewed before b starts
  assert.ok(idx("build:a#1") < idx("review:a#1") && idx("review:a#1") < idx("build:b#1"));
  assert.ok(idx("review:b#1") < idx("build:c#1"), "c waits for a and b");
  assert.ok(!l.includes("checkpoint") && !l.includes("integrate"));
  assert.ok(r.logs.some((m) => /baseRefHead is not set/.test(m)));
  assert.equal(r.result.passed, 3);
});

test("baseRefHead: a parallel wave is checkpointed, isolated, integrated, then reviewed", async () => {
  const r = await run({ args: { baseRefHead: true }, slices: [slice("a"), slice("b")] });
  const l = labels(r.calls);
  assert.ok(l.indexOf("checkpoint") < l.indexOf("build:a#1"));
  assert.ok(l.indexOf("build:b#1") < l.indexOf("integrate"));
  assert.ok(l.indexOf("integrate") < l.indexOf("review:a"));
  assert.ok(implementers(r.calls).every((c) => c.opts.isolation === "worktree" && /isolated worktree/.test(c.prompt)));
  assert.deepEqual(r.phases.slice(-1), ["Integrate"]);
  assert.equal(r.result.passed, 2);
});

test("code: false runs a wave in the shared folder with no checkpoint, integrator or commit", async () => {
  const r = await run({ args: { code: false, baseRefHead: true }, slices: [slice("a"), slice("b")] });
  const l = labels(r.calls);
  assert.ok(!l.includes("checkpoint") && !l.includes("integrate"));
  assert.ok(implementers(r.calls).every((c) => !c.opts.isolation && /Do not commit\./.test(c.prompt)));
  assert.equal(r.result.passed, 2);
});

test("the plan is bounded to 6 slices by default and by args.maxSlices", async () => {
  /** @param {number} [maxSlices] */
  const planCall = async (maxSlices) => {
    const r = await run({ args: maxSlices ? { maxSlices } : {}, slices: [slice("a")] });
    return r.calls.find((c) => c.opts.label === "plan:slices");
  };
  const def = await planCall();
  assert.equal(def.opts.schema.properties.slices.maxItems, 6);
  assert.match(def.prompt, /at most 6 slices/);
  const three = await planCall(3);
  assert.equal(three.opts.schema.properties.slices.maxItems, 3);
  assert.match(three.prompt, /at most 3 slices/);
});

test("a failing review retries with the gaps, then reports failed after maxRetries", async () => {
  const r = await run({
    args: { maxRetries: 1 },
    slices: [slice("a")],
    verdict: () => ({ pass: false, gaps: ["missing test"], evidence: "x" }),
  });
  const l = labels(r.calls);
  assert.deepEqual(l.slice(-5), ["build:a#1", "review:a#1", "build:a#2", "review:a#2", "plan:replan"], "then one replan (which here returns nothing)");
  assert.match(implementers(r.calls)[1].prompt, /A previous attempt was rejected\. Fix:\nmissing test/);
  assert.doesNotMatch(implementers(r.calls)[0].prompt, /previous attempt/);
  assert.deepEqual(r.result.slices, [{ id: "a", status: "failed", attempts: 2, gaps: ["missing test"] }]);
  assert.equal(r.result.failed, 1);
});

test("risky slices get an extra opus review; a review that fails then passes ends passed on attempt 2", async () => {
  let n = 0;
  const r = await run({ slices: [slice("a", { risky: true })], verdict: () => (++n <= 2 ? { pass: false, gaps: ["g"], evidence: "" } : { pass: true, gaps: [], evidence: "" }) });
  const reviews = r.calls.filter((c) => c.opts.agentType === "reviewer");
  assert.deepEqual(reviews.map((c) => c.opts.model), [undefined, "opus", undefined, "opus"]);
  assert.equal(r.result.slices[0].status, "passed");
  assert.equal(r.result.slices[0].attempts, 2);
});

test("a failing implementer is retried without a review in between", async () => {
  let n = 0;
  const r = await run({ args: { maxRetries: 1 }, slices: [slice("a")], implement: () => (++n === 1 ? { status: "fail", branch: "", evidence: "boom", open: "x" } : { status: "pass", branch: "", evidence: "", open: "" }) });
  assert.deepEqual(labels(r.calls).slice(-3), ["build:a#1", "build:a#2", "review:a#2"]);
  assert.match(implementers(r.calls)[1].prompt, /boom/);
});

// Hook contract: the marker the script writes is exactly what plan-check.mjs skips.
function hookProject() {
  const dir = mkdtempSync(join(tmpdir(), "workflow-hooks-"));
  const hooks = join(dir, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of ["state.mjs", "brief.mjs", "run.mjs", "plan-check.mjs"]) copyFileSync(join(root, ".claude", "hooks", h), join(hooks, h));
  return dir;
}
/** @param {string} dir @param {string} prompt */
const launch = (dir, prompt) =>
  spawnSync("node", [join(dir, ".claude", "hooks", "plan-check.mjs")], {
    input: JSON.stringify({ session_id: "wf", tool_name: "Agent", tool_input: { subagent_type: "implementer", prompt } }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    encoding: "utf8",
  });

test("every implementer brief the script sends is skipped by plan-check.mjs; the same brief without the marker is blocked", async () => {
  const dir = hookProject();
  try {
    const r = await run({ args: { baseRefHead: true }, slices: [slice("a"), slice("b"), slice("c", { dependsOn: ["a"] })], verdict: () => ({ pass: false, gaps: ["g"], evidence: "" }) });
    const briefs = implementers(r.calls).map((c) => c.prompt);
    assert.ok(briefs.length >= 3);
    for (const b of briefs) {
      assert.ok(b.startsWith("ORCHESTRATION: workflow\n"));
      const res = launch(dir, b);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stderr, "", "skipped silently, not merely let through");
    }
    // Control: with the marker removed the brief has no SLICE:/FILES: lines, so plan-check blocks it.
    const stripped = briefs[0].replace(/^ORCHESTRATION: workflow\n/, "");
    assert.equal(launch(dir, stripped).status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** @param {any[]} calls */
const reviewers = (calls) => calls.filter((c) => c.opts.agentType === "reviewer");
const C = [{ id: "C1", text: "parsing never throws" }, { id: "c2", text: "no new dependencies" }];
/** @param {string[]} ids @param {"cmd"|"read"} [mode] */
const answered = (ids, mode = "cmd") => ({ pass: true, gaps: [], evidence: "ok", open: "", answers: ids.map((id) => ({ id, verdict: "pass", mode, detail: "npm test -> ok" })) });

test("constraints and checks: CHECKS line and constraint texts in implementer and reviewer briefs, marker still first", async () => {
  const r = await run({ constraints: C, slices: [slice("a", { checks: ["c1", "C2", "C1"] }), slice("b")], verdict: (l) => (l.startsWith("review:a") ? answered(["C1", "C2"]) : answered([])) });
  const [ia, ib] = implementers(r.calls).map((c) => c.prompt);
  assert.match(ia, /^ORCHESTRATION: workflow\nSlice a\nCHECKS: C1, C2\nC1: parsing never throws\nC2: no new dependencies\nGoal: goal a\n/);
  assert.match(ia, /Meet every constraint in CHECKS/);
  assert.match(ib, /^ORCHESTRATION: workflow\nSlice b\nGoal: goal b\n/, "no CHECKS line without checks");
  const [ra, rb] = reviewers(r.calls);
  assert.match(ra.prompt, /^CHECKS: C1, C2\nC1: parsing never throws\nC2: no new dependencies\nGoal: goal a\n/);
  assert.match(ra.prompt, /Answer every id in CHECKS/);
  assert.doesNotMatch(rb.prompt, /CHECKS/);
  assert.deepEqual(ra.opts.schema.required, ["pass", "gaps", "evidence", "answers", "open"]);
  const planCall = r.calls.find((c) => c.opts.label === "plan:slices");
  assert.deepEqual(planCall.opts.schema.required, ["constraints", "slices"]);
  assert.ok(planCall.opts.schema.properties.slices.items.required.includes("checks"));
  assert.equal(r.result.passed, 2);
  assert.deepEqual(labels(r.calls).filter((l) => /^review/.test(l)), ["review:a#1", "review:b#1"], "cmd answers and no open: no escalation");
});

test("a checked id left unanswered, or answered fail, counts as a failed review and retries", async () => {
  let n = 0;
  const r = await run({ constraints: C, slices: [slice("a", { checks: ["C1", "C2"] })], verdict: () => (++n === 1 ? { ...answered(["C2"]), answers: [{ id: "c2", verdict: "fail", mode: "cmd", detail: "added lodash" }] } : answered(["C1", "C2"])) });
  const l = labels(r.calls);
  assert.deepEqual(l.filter((x) => /^(build|review)/.test(x)), ["build:a#1", "review:a#1", "build:a#2", "review:a#2", "review:a#2:opus"], "the passing retry is escalated to opus");
  assert.match(implementers(r.calls)[1].prompt, /A previous attempt was rejected\. Fix:\nC1: not answered\nC2: added lodash/);
  assert.equal(r.result.slices[0].status, "passed");
});

test("escalation: a read-mode answer or a non-empty open sends a passing review to one opus reviewer, whose verdict decides", async () => {
  const read = await run({ constraints: C, slices: [slice("a", { checks: ["C1"] })], verdict: () => answered(["C1"], "read") });
  assert.deepEqual(reviewers(read.calls).map((c) => [c.opts.label, c.opts.model]), [["review:a#1", undefined], ["review:a#1:opus", "opus"]]);
  assert.match(reviewers(read.calls)[1].prompt, /^CHECKS: C1\n/);
  assert.equal(read.result.passed, 1);
  // open items, then the opus review fails: the slice retries.
  const open = await run({ args: { maxRetries: 1 }, slices: [slice("a")], verdict: (_l, o) => (o.model === "opus" ? { pass: false, gaps: ["opus gap"], evidence: "", answers: [], open: "" } : { pass: true, gaps: [], evidence: "", answers: [], open: "flaky test" }) });
  assert.deepEqual(labels(open.calls).filter((x) => /^(build|review)/.test(x)), ["build:a#1", "review:a#1", "review:a#1:opus", "build:a#2", "review:a#2", "review:a#2:opus"]);
  assert.match(implementers(open.calls)[1].prompt, /opus gap/);
  assert.equal(open.result.slices[0].status, "failed");
  // "none" in open is not a doubt signal.
  const none = await run({ slices: [slice("a")], verdict: () => ({ pass: true, gaps: [], evidence: "", answers: [], open: "none" }) });
  assert.equal(reviewers(none.calls).length, 1);
});

test("one replan: slices failed for good go back to the planner once, which may depend on finished slices", async () => {
  const r = await run({
    args: { maxRetries: 1 },
    slices: [slice("a"), slice("b")],
    replan: { constraints: [{ id: "C9", text: "new rule" }], slices: [slice("a2", { dependsOn: ["b"], checks: ["C9"] }), slice("b")] },
    verdict: (l) => (l.startsWith("review:b") ? answered([]) : { pass: false, gaps: ["broken"], evidence: "", answers: [], open: "" }),
  });
  const l = labels(r.calls);
  assert.equal(l.filter((x) => x === "plan:replan").length, 1, "exactly one replan even though a2 fails too");
  const rp = r.calls.find((c) => c.opts.label === "plan:replan");
  assert.match(rp.prompt, /Finished slices[^\n]*\n- b: goal b/);
  assert.match(rp.prompt, /Failed slices[^\n]*\n- a: goal a \[a\.txt\]\n {2}gaps: broken/);
  assert.ok(l.indexOf("plan:replan") < l.indexOf("build:a2#1"));
  assert.ok(!l.slice(l.indexOf("plan:replan")).includes("build:b#1"), "the finished id b is not planned again");
  assert.match(implementers(r.calls).find((c) => c.opts.label === "build:a2#1").prompt, /CHECKS: C9\nC9: new rule\n/);
  assert.deepEqual(r.result.slices.map((/** @type {any} */ s) => [s.id, s.status]), [["a", "replanned"], ["b", "passed"], ["a2", "failed"]]);
  assert.equal(r.result.failed, 1);
  assert.ok(r.logs.some((m) => m.startsWith("plan after replan: ")));
});

test("no replan when nothing failed for good; an empty replan leaves the slice failed", async () => {
  const ok = await run({ slices: [slice("a")] });
  assert.ok(!labels(ok.calls).includes("plan:replan"));
  const empty = await run({ args: { maxRetries: 1 }, slices: [slice("a")], verdict: () => ({ pass: false, gaps: ["g"], evidence: "" }) });
  assert.ok(labels(empty.calls).includes("plan:replan"));
  assert.deepEqual(empty.result.slices.map((/** @type {any} */ s) => s.status), ["failed"]);
});

test("the plan JSON is logged once and resumes a new run through args.plan and args.skip", async () => {
  const first = await run({ constraints: C, slices: [slice("a", { checks: ["C1"] }), slice("b", { dependsOn: ["a"] })], verdict: () => answered(["C1"]) });
  const planLogs = first.logs.filter((m) => m.startsWith("plan: "));
  assert.equal(planLogs.length, 1);
  const plan = JSON.parse(String(planLogs[0]).slice("plan: ".length));
  assert.deepEqual(plan.constraints, [{ id: "C1", text: "parsing never throws" }, { id: "C2", text: "no new dependencies" }]);
  const resumed = await run({ args: { plan, skip: ["a"] }, verdict: () => answered(["C1"]) });
  const l = labels(resumed.calls);
  assert.ok(!l.some((x) => /^(plan|explore):/.test(x)), "no planning with args.plan");
  assert.deepEqual(l, ["build:b#1", "review:b#1"], "a is skipped; b, which depends on it, runs");
  assert.deepEqual(resumed.phases, ["Build"]);
  assert.deepEqual(resumed.result.slices.map((/** @type {any} */ s) => [s.id, s.status]), [["a", "skipped"], ["b", "passed"]]);
  // args.plan keeps its constraint texts in the briefs.
  const again = await run({ args: { plan }, verdict: () => answered(["C1"]) });
  assert.match(implementers(again.calls)[0].prompt, /^ORCHESTRATION: workflow\nSlice a\nCHECKS: C1\nC1: parsing never throws\n/);
});

test("C5: the script never reads the clock or randomness", () => {
  assert.doesNotMatch(source, /Date\.now\(|Math\.random\(|new Date\(/);
});

test("briefs with CHECKS lines are still skipped by plan-check.mjs", async () => {
  const dir = hookProject();
  try {
    const r = await run({ constraints: C, slices: [slice("a", { checks: ["C1"] })], verdict: () => answered(["C1"]) });
    const b = implementers(r.calls)[0].prompt;
    assert.ok(b.startsWith("ORCHESTRATION: workflow\n"));
    const res = launch(dir, b);
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stderr, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("replan: slices that depend on a slice that failed for good, directly or transitively, are reported failed and never run", async () => {
  const r = await run({
    args: { maxRetries: 1 },
    slices: [slice("a"), slice("b")],
    replan: { slices: [slice("x", { dependsOn: ["a"] }), slice("y", { dependsOn: ["x"] }), slice("z", { dependsOn: ["b"] })] },
    verdict: (l) => (l.startsWith("review:a") ? { pass: false, gaps: ["broken"], evidence: "", answers: [], open: "" } : answered([])),
  });
  const l = labels(r.calls);
  assert.ok(!l.some((x) => /^build:[xy]#/.test(x)), "x and y are never built, not even by the cycle fallback");
  assert.ok(l.includes("build:z#1"));
  assert.ok(!r.logs.some((m) => /dependency cycle/.test(m)));
  const byId = Object.fromEntries(r.result.slices.map((/** @type {any} */ s) => [s.id, s]));
  assert.deepEqual(byId.x.gaps, ["depends on failed a"]);
  assert.deepEqual(byId.y.gaps, ["depends on failed x"]);
  assert.equal(byId.x.status, "failed");
  assert.equal(byId.a.status, "replanned", "z still replaces part of the work");
  assert.equal(byId.z.status, "passed");
  assert.equal(r.result.failed, 2);
  // Every replanned slice blocked: the failed slice stays failed and nothing else runs.
  const blocked = await run({ args: { maxRetries: 1 }, slices: [slice("a")], replan: { slices: [slice("x", { dependsOn: ["a"] })] }, verdict: () => ({ pass: false, gaps: ["g"], evidence: "", answers: [], open: "" }) });
  assert.ok(!labels(blocked.calls).includes("build:x#1"));
  assert.deepEqual(blocked.result.slices.map((/** @type {any} */ s) => [s.id, s.status]), [["a", "failed"], ["x", "failed"]]);
});

test("args.skip: unknown ids are ignored and logged; a slice whose dependency is not skipped runs again; skipped slices count as passed", async () => {
  const plan = { constraints: [], slices: [slice("a"), slice("b", { dependsOn: ["a"] }), slice("c")] };
  const r = await run({ args: { plan, skip: ["b", "c", "nope"] } });
  const l = labels(r.calls);
  assert.ok(r.logs.some((m) => /ignoring ids not in the plan: nope/.test(m)));
  assert.ok(r.logs.some((m) => /running again[^\n]*: b/.test(m)));
  assert.deepEqual(l, ["build:a#1", "review:a#1", "build:b#1", "review:b#1"], "c is skipped; b runs again because a is not skipped");
  assert.deepEqual(r.result.slices.map((/** @type {any} */ s) => [s.id, s.status]), [["c", "skipped"], ["a", "passed"], ["b", "passed"]]);
  assert.equal(r.result.passed, 3, "skipped slices count as passed");
  // Skipping a and b together skips both.
  const both = await run({ args: { plan, skip: ["a", "b"] } });
  assert.deepEqual(labels(both.calls), ["build:c#1", "review:c#1"]);
  assert.equal(both.result.passed, 3);
});
