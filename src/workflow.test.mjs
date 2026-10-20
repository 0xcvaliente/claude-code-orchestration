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

const slice = (id, o = {}) => ({ id, goal: `goal ${id}`, files: [`${id}.txt`], acceptance: `check ${id}`, dependsOn: [], risky: false, ...o });

// Runs the script with a fake runtime. `slices` is the plan; `verdict(label)` returns a reviewer verdict.
async function run({ args = {}, slices, questions = [], verdict = () => ({ pass: true, gaps: [], evidence: "ok" }), implement } = {}) {
  const calls = [];
  const phases = [];
  const logs = [];
  const fakeAgent = async (prompt, opts = {}) => {
    calls.push({ prompt, opts });
    const { label = "", agentType } = opts;
    if (label === "plan:questions") return { questions };
    if (label === "plan:slices") return { slices };
    if (label === "checkpoint") return { status: "pass", commit: "abc123", open: "" };
    if (agentType === "researcher") return `answer to ${prompt}`;
    if (agentType === "implementer") return implement ? implement(label, opts) : { status: "pass", branch: opts.isolation ? `wt-${label}` : "", evidence: "ok", open: "" };
    if (agentType === "reviewer") return verdict(label);
    if (agentType === "integrator") return "merged";
    throw new Error(`unexpected agent call ${label}`);
  };
  const parallel = (fns) => Promise.all(fns.map((f) => f()));
  const pipeline = (items, fn) => Promise.all(items.map((i) => fn(i)));
  const fn = new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", body);
  const result = await fn({ task: "do the thing", ...args }, fakeAgent, parallel, pipeline, (t) => phases.push(t), (m) => logs.push(m));
  return { result, calls, phases, logs };
}
const labels = (calls) => calls.map((c) => c.opts.label);
const implementers = (calls) => calls.filter((c) => c.opts.agentType === "implementer");

test("meta is a pure literal whose phases match the phase() titles the script uses", async () => {
  assert.equal(meta.name, "orchestrate");
  assert.ok(meta.description && meta.description.length > 10);
  const titles = Array.from(meta.phases, (p) => p.title);
  assert.deepEqual(titles, ["Plan", "Explore", "Build", "Integrate"]);
  const used = new Set([...source.matchAll(/\bphase\('([^']+)'\)/g)].map((m) => m[1]));
  for (const u of used) assert.ok(titles.includes(u), `phase ${u} declared in meta`);
  const optsUsed = new Set([...source.matchAll(/phase: '([^']+)'/g)].map((m) => m[1]));
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
  const idx = (x) => l.indexOf(x);
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
  assert.deepEqual(l.slice(-4), ["build:a#1", "review:a#1", "build:a#2", "review:a#2"]);
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
  for (const h of ["state.mjs", "plan-check.mjs"]) copyFileSync(join(root, ".claude", "hooks", h), join(hooks, h));
  return dir;
}
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
