import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HookCallback, Options, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { makeRunAgent, sandboxFor, type AgentRequest } from "./agent.js";
import { rolesFor, SDK_DENIED_BASH, UNSAFE_BASH, type Role } from "./config.js";
import { solo } from "./solo.js";
import { HOOK_TIMEOUT_S, JUDGE_TIMEOUT_MS, type JudgeDeps } from "./judge.js";

const BASH_ROLES: Role[] = ["solo", "writer", "verifier"];
const NO_BASH_ROLES: Role[] = ["planner", "explorer", "triager"];

/** A query() that records its options and ends with a successful result. */
function fakeQuery() {
  const seen: Options[] = [];
  const query = ((args: { prompt: string; options: Options }) => {
    seen.push(args.options);
    return (async function* () {
      yield { type: "result", subtype: "success", is_error: false, result: "done", num_turns: 1, usage: {}, modelUsage: {} };
    })();
  }) as unknown as typeof sdkQuery;
  return { query, seen };
}

/** Judge deps with a scripted model: answers come from `answers` in order; prompts are recorded. */
function fakeJudge(answers: Array<"allow" | "deny" | Error>) {
  const prompts: string[] = [];
  const deps: JudgeDeps = {
    ask: async (prompt) => {
      prompts.push(prompt);
      const a = answers.shift() ?? "deny";
      if (a instanceof Error) throw a;
      return { text: JSON.stringify({ decision: a, reason: `fake ${a}` }), tokens: 1, model: "fake" };
    },
    git: async () => "",
    stat: async () => ({ exists: true, isDir: true, isSymlink: false, sizeKb: 1 }),
    now: () => 0,
    cache: new Map(),
  };
  return { deps, prompts };
}

const req = (role: Role, over: Partial<AgentRequest> = {}): AgentRequest => ({ role, prompt: "brief", cwd: "/work/repo", ...over });

async function optionsFor(r: AgentRequest, env: NodeJS.ProcessEnv, judge = fakeJudge([])) {
  const { query, seen } = fakeQuery();
  const res = await makeRunAgent({ query, env, judgeDeps: () => judge.deps })(r);
  assert.equal(res.ok, true);
  return seen[0]!;
}

const hookOf = (o: Options): HookCallback => o.hooks!.PreToolUse![0]!.hooks[0]!;
const call = (hook: HookCallback, command: string) =>
  hook(
    { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd: "/work/repo" } as never,
    "t1",
    { signal: new AbortController().signal },
  );
const decisionOf = (out: Awaited<ReturnType<HookCallback>>) =>
  (out as { hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } }).hookSpecificOutput;

test("judge on: Bash roles carry the PreToolUse hook with a timeout above the judge's own, and only sudo is denied by rule", async () => {
  for (const role of BASH_ROLES) {
    const o = await optionsFor(req(role), {});
    const m = o.hooks!.PreToolUse!;
    assert.equal(m.length, 1);
    assert.equal(m[0]!.matcher, "Bash");
    assert.equal(m[0]!.timeout, HOOK_TIMEOUT_S);
    assert.ok(HOOK_TIMEOUT_S * 1000 > JUDGE_TIMEOUT_MS);
    assert.deepEqual(o.disallowedTools, SDK_DENIED_BASH);
    assert.ok(o.allowedTools!.includes("Bash"));
  }
});

test("judge off: Bash roles keep UNSAFE_BASH and the hook denies the judged classes without asking", async () => {
  const judge = fakeJudge(["allow"]);
  for (const role of BASH_ROLES) {
    const o = await optionsFor(req(role), { ORCH_JUDGE: "off" }, judge);
    assert.deepEqual(o.disallowedTools, UNSAFE_BASH);
    assert.equal(o.hooks!.PreToolUse![0]!.timeout, HOOK_TIMEOUT_S);
    assert.equal(decisionOf(await call(hookOf(o), "git push origin main"))?.permissionDecision, "deny");
    assert.equal(decisionOf(await call(hookOf(o), "rm -rf build"))?.permissionDecision, "deny");
  }
  assert.equal(judge.prompts.length, 0);
});

test("non-Bash roles get no hook, no sandbox and no deny list", async () => {
  for (const role of NO_BASH_ROLES) {
    const o = await optionsFor(req(role), { ORCH_SANDBOX: "on" });
    assert.equal(o.hooks, undefined);
    assert.equal(o.sandbox, undefined);
    assert.deepEqual(o.disallowedTools, []);
  }
});

test("rolesFor reads the model overrides and the judge switch from env, and ROLES gains no judge role", () => {
  const r = rolesFor({ ORCH_MODEL_WRITER: "my-writer", ORCH_MODEL_PLANNER: "my-planner", ORCH_JUDGE: "off" });
  assert.equal(r.writer.model, "my-writer");
  assert.equal(r.planner.model, "my-planner");
  assert.equal(r.solo.model, rolesFor({}).solo.model);
  assert.deepEqual(r.writer.disallowedTools, UNSAFE_BASH);
  assert.deepEqual(rolesFor({}).writer.disallowedTools, SDK_DENIED_BASH);
  assert.deepEqual(Object.keys(rolesFor({})).sort(), ["explorer", "planner", "solo", "triager", "verifier", "writer"]);
});

test("worker system texts: commits and branches stay forbidden, push and rm are task-dependent and judged", () => {
  for (const role of ["solo", "writer"] as const) {
    const s = rolesFor({})[role].system;
    assert.match(s, /never run git commit or branch commands|Do not run git commit or branch commands/);
    assert.match(s, /only when the task asks for it/);
    assert.match(s, /checked by a reviewer model/);
    assert.match(s, /do not retry a different way/);
  }
});

test("the hook asks the judge for git push: allow then deny, and the task reaches the judge prompt", async () => {
  const judge = fakeJudge(["allow", "deny"]);
  const task = "TASK-TEXT push the release branch to origin when done";
  const o = await optionsFor(req("writer", { task }), {}, judge);
  const hook = hookOf(o);
  const a = decisionOf(await call(hook, "git push origin release-a"));
  assert.equal(a?.permissionDecision, "allow");
  const d = decisionOf(await call(hook, "git push origin release-b"));
  assert.equal(d?.permissionDecision, "deny");
  assert.equal(judge.prompts.length, 2);
  assert.ok(judge.prompts[0]!.includes(task));
});

test("rm -rf / is denied by the floor and the judge is never called", async () => {
  const judge = fakeJudge(["allow"]);
  const o = await optionsFor(req("solo", { task: "delete everything" }), {}, judge);
  assert.equal(decisionOf(await call(hookOf(o), "rm -rf /"))?.permissionDecision, "deny");
  assert.equal(judge.prompts.length, 0);
});

test("a judge that throws makes the hook deny, never return nothing", async () => {
  const judge = fakeJudge([new Error("boom")]);
  const o = await optionsFor(req("solo", { task: "push it" }), {}, judge);
  const out = await call(hookOf(o), "git push origin x");
  assert.equal(decisionOf(out)?.permissionDecision, "deny");
});

test("ordinary commands get no opinion from the hook", async () => {
  const o = await optionsFor(req("solo"), {});
  assert.deepEqual(await call(hookOf(o), "npm test"), {});
});

test("the audit file is the request's, else ORCH_JUDGE_AUDIT, else runs/judge-audit.jsonl", async () => {
  const files: string[] = [];
  const run = async (r: AgentRequest, env: NodeJS.ProcessEnv) => {
    const { query } = fakeQuery();
    await makeRunAgent({ query, env, judgeDeps: (f) => (files.push(f), fakeJudge([]).deps) })(r);
  };
  await run(req("solo", { auditFile: "/x/req.jsonl" }), { ORCH_JUDGE_AUDIT: "/x/env.jsonl" });
  await run(req("solo"), { ORCH_JUDGE_AUDIT: "/x/env.jsonl" });
  await run(req("solo"), {});
  assert.deepEqual(files.slice(0, 2), ["/x/req.jsonl", "/x/env.jsonl"]);
  assert.match(files[2]!, /runs[\\/]judge-audit\.jsonl$/);
});

test("the sandbox option appears only with ORCH_SANDBOX=on, for Bash roles, and fails closed", async () => {
  assert.equal((await optionsFor(req("writer"), {})).sandbox, undefined);
  assert.equal((await optionsFor(req("writer"), { ORCH_SANDBOX: "off" })).sandbox, undefined);
  const o = await optionsFor(req("writer", { cwd: "/work/wt" }), { ORCH_SANDBOX: "on", ORCH_SANDBOX_DOMAINS: "github.com, *.example.com ," });
  assert.equal(o.sandbox?.enabled, true);
  assert.equal(o.sandbox?.failIfUnavailable, true);
  assert.equal(o.sandbox?.allowUnsandboxedCommands, false);
  assert.ok(o.sandbox?.filesystem?.allowWrite?.includes("/work/wt"));
  assert.deepEqual(o.sandbox?.network?.allowedDomains, ["github.com", "*.example.com"]);
  assert.deepEqual(sandboxFor({ ORCH_SANDBOX: "on" }, "/w")?.network?.allowedDomains, []);
  assert.equal(sandboxFor({}, "/w"), undefined);
});

test("solo passes the original task and a per-run audit file on every Bash role call", async () => {
  const calls: AgentRequest[] = [];
  const out = mkdtempSync(join(tmpdir(), "solo-out-"));
  const r = await solo({
    repo: out, task: "THE TASK", outRoot: out, review: true, maxRetries: 0,
    run: async (q) => (calls.push(q), { ok: true, text: "", structured: { pass: true, issues: [], summary: "" }, tokens: 1, turns: 1, subtype: "success", durationMs: 1, model: "m" }),
  });
  assert.deepEqual(calls.map((c) => c.role), ["solo", "verifier"]);
  for (const c of calls) {
    assert.equal(c.task, "THE TASK");
    assert.equal(c.auditFile, join(out, r.runId, "judge-audit.jsonl"));
  }
});
