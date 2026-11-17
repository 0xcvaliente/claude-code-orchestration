import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { HookCallback, Options, query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { makeRunAgent, sandboxFor, TRIAGE_TITLE, type AgentRequest } from "./agent.js";
import { ROLES, rolesFor, SDK_DENIED_BASH, UNSAFE_BASH, type Role } from "./config.js";
import { solo } from "./solo.js";
import { HOOK_TIMEOUT_S, JUDGE_TIMEOUT_MS, statPath, type JudgeDeps } from "./judge.js";

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
    assert.equal(m[0]!.onFailure, "block", "a guard that fails blocks the command (Agent SDK 0.3.317)");
    assert.equal(o.env?.CLAUDE_CODE_DISABLE_AUTO_MEMORY, "1", "a worker never starts Claude Code auto memory");
    assert.equal(o.env?.PATH, process.env.PATH, "the rest of the environment is passed on");
    assert.ok(HOOK_TIMEOUT_S * 1000 > JUDGE_TIMEOUT_MS);
    assert.deepEqual(o.disallowedTools, SDK_DENIED_BASH);
    assert.ok(o.allowedTools!.includes("Bash"));
  }
});

test("every worker opts out of a project's main agent: project settings are loaded, the flag settings unset `agent`", async () => {
  // With settingSources ["project"], an `agent` setting in the repo (this repo's own names the orchestrator) would run
  // the worker as that agent, with that agent's tools. Probed on Claude Code 2.1.325: docs/data/live-checks-2026-11-16.md.
  for (const role of Object.keys(ROLES) as Role[]) {
    const o = await optionsFor(req(role), {});
    assert.deepEqual(o.settingSources, ["project"], role);
    assert.equal((o.settings as { agent?: string }).agent, "", role);
    if (role !== "triager") assert.deepEqual(o.settings, { agent: "", disableClaudeAiConnectors: true }, role);
    assert.equal((o as { agent?: string }).agent, undefined, `${role}: no --agent equivalent either`);
  }
});

// Live run of 2026-11-16 (docs/data/live-checks-2026-11-16.md, Checks 8 and 10): the triage session of `npm run auto`
// carried the MCP tools of the person's claude.ai account connectors, which the triager can never use (about 110k tokens
// per turn), and wrote a session transcript. 1.5.1 fixed the triager only; 1.6.0 gives every role the same MCP options.
const TRIAGE_ONLY = ["persistSession", "maxBudgetUsd", "title"] as const;
const settingsOf = (o: Options) => o.settings as Record<string, unknown>;

test("triage call: no MCP server, no claude.ai connector, no session transcript", async () => {
  const o = await optionsFor(req("triager"), {});
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.mcpServers, {});
  assert.deepEqual(o.settings, { agent: "", disableClaudeAiConnectors: true, disableAllHooks: true });
  assert.equal(o.persistSession, false);
  assert.equal("maxBudgetUsd" in o, false, "no cap unless the request carries one");
  const kept = await optionsFor(req("triager"), { ORCH_SESSION_PERSISTENCE: "1" });
  assert.equal("persistSession" in kept, false, "ORCH_SESSION_PERSISTENCE=1 keeps the transcript (the SDK default)");
  assert.equal(kept.strictMcpConfig, true);
  assert.deepEqual(kept.settings, { agent: "", disableClaudeAiConnectors: true, disableAllHooks: true });
});

// 1.5.1 Known and not fixed: a small haiku call in every triage. Live on 2026-11-17 (docs/data/live-checks-2026-11-17.md,
// Check 2) it was Claude Code's session-title call (`source=generate_session_title`), and a given title removed it.
test("triage call: a fixed title, so Claude Code makes no haiku call to name the session", async () => {
  for (const env of [{}, { ORCH_SESSION_PERSISTENCE: "1" }, { ORCH_SDK_MCP: "project" }]) {
    const o = await optionsFor(req("triager"), env);
    assert.equal(o.title, TRIAGE_TITLE, JSON.stringify(env));
  }
  assert.equal(TRIAGE_TITLE, "triage");
});

test("triage call: a request's dollar cap reaches query() as maxBudgetUsd", async () => {
  const o = await optionsFor(req("triager", { maxBudgetUsd: 0.3 }), {});
  assert.equal(o.maxBudgetUsd, 0.3);
});

// 1.5.1 Known and not fixed: the triager loaded the project's settings and so ran the hooks of the folder it reads
// (Check 10: a review-gate record from the triage). disableAllHooks in the flag settings, which rank above the project's.
test("triage call: runs no hook of the project it reads, and still reads its settings and CLAUDE.md with `agent` unset", async () => {
  for (const env of [{}, { ORCH_SESSION_PERSISTENCE: "1" }, { ORCH_SDK_MCP: "project" }]) {
    const o = await optionsFor(req("triager", { maxBudgetUsd: 0.3 }), env);
    assert.equal(settingsOf(o).disableAllHooks, true, JSON.stringify(env));
    assert.equal(settingsOf(o).agent, "");
    assert.deepEqual(o.settingSources, ["project"]);
    assert.equal(o.hooks, undefined, "no SDK hook callbacks either");
  }
});

// 1.5.1 Known and not fixed: every other role took the account connectors and every configured MCP server.
test("every non-triage role: no claude.ai connector and, by default, no MCP server; hooks, transcript and cap untouched", async () => {
  for (const role of (Object.keys(ROLES) as Role[]).filter((r) => r !== "triager")) {
    for (const env of [{}, { ORCH_SESSION_PERSISTENCE: "1" }, { ORCH_SESSION_PERSISTENCE: "0" }, { ORCH_SDK_MCP: "" }, { ORCH_SDK_MCP: "on" }, { ORCH_SDK_MCP: "1" }]) {
      const o = await optionsFor(req(role, { maxBudgetUsd: 0.3 }), env);
      const at = `${role} ${JSON.stringify(env)}`;
      assert.equal(o.strictMcpConfig, true, at);
      assert.deepEqual(o.mcpServers, {}, at);
      assert.equal(o.mcpServersDelivery, "initialize", `${at}: the SDK's non-deprecated delivery`);
      assert.deepEqual(o.settings, { agent: "", disableClaudeAiConnectors: true }, at);
      for (const k of TRIAGE_ONLY) assert.equal(k in o, false, `${at}: ${k} is triage-only`);
    }
  }
});

test("ORCH_SDK_MCP=project keeps the folder's .mcp.json servers for writer, solo and verifier only, never the connectors", async () => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), "agent-mcp-")));
  const servers = { docs: { command: "node", args: ["./mcp.js"], env: { TOKEN: "x" } }, web: { type: "http", url: "http://127.0.0.1:9/mcp" } };
  writeFileSync(join(folder, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
  for (const value of ["project", " Project "]) {
    for (const role of Object.keys(ROLES) as Role[]) {
      const o = await optionsFor(req(role, { cwd: folder }), { ORCH_SDK_MCP: value });
      const working = ["writer", "solo", "verifier"].includes(role);
      assert.deepEqual(o.mcpServers, working ? servers : {}, `${role} ${value}`);
      assert.equal(o.strictMcpConfig, true, `${role}: no user, plugin or other server either`);
      assert.equal(o.mcpServersDelivery, "initialize", `${role}: env and headers stay off the command line`);
      assert.equal(settingsOf(o).disableClaudeAiConnectors, true, role);
    }
  }
  // Off by default even with a .mcp.json there.
  assert.deepEqual((await optionsFor(req("writer", { cwd: folder }), {})).mcpServers, {});
  // A missing, broken or odd .mcp.json gives no server.
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "agent-mcp-none-")));
  assert.deepEqual((await optionsFor(req("writer", { cwd: empty }), { ORCH_SDK_MCP: "project" })).mcpServers, {});
  for (const body of ["{", "[]", "null", '{"mcpServers":[1]}', '{"mcpServers":"x"}']) {
    writeFileSync(join(empty, ".mcp.json"), body);
    assert.deepEqual((await optionsFor(req("solo", { cwd: empty }), { ORCH_SDK_MCP: "project" })).mcpServers, {}, body);
  }
  writeFileSync(join(empty, ".mcp.json"), JSON.stringify({ mcpServers: { ok: { command: "x" }, bad: 3, list: [] } }));
  assert.deepEqual((await optionsFor(req("verifier", { cwd: empty }), { ORCH_SDK_MCP: "project" })).mcpServers, { ok: { command: "x" } });
});

test("a result's total_cost_usd comes back as costUsd; no result, no cost", async () => {
  const query = (() =>
    (async function* () {
      yield { type: "result", subtype: "error_max_budget_usd", is_error: true, errors: [], num_turns: 2, usage: {}, modelUsage: {}, total_cost_usd: 0.31 };
    })()) as unknown as typeof sdkQuery;
  const r = await makeRunAgent({ query, env: {} })(req("triager", { maxBudgetUsd: 0.3 }));
  assert.equal(r.subtype, "error_max_budget_usd");
  assert.equal(r.costUsd, 0.31);
  const none = (() => (async function* () {})()) as unknown as typeof sdkQuery;
  assert.equal("costUsd" in (await makeRunAgent({ query: none, env: {} })(req("triager"))), false);
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

test("audit 2026-11-16 J-13: through makeRunAgent, rm targets resolve against the hook input's folder, bounded by the worktree", async () => {
  const outer = realpathSync(mkdtempSync(join(tmpdir(), "agent-cwd-")));
  const wt = join(outer, "wt");
  mkdirSync(join(wt, "src"), { recursive: true });
  mkdirSync(join(outer, "outside"));
  symlinkSync(join(outer, "outside"), join(wt, "src", "out"));
  const judge = fakeJudge(["allow", "allow"]);
  judge.deps.stat = statPath; // the real file system check
  const o = await optionsFor(req("solo", { cwd: wt, task: "clean up" }), {}, judge);
  const at = (cwd: string, command: string) =>
    hookOf(o)({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, tool_use_id: "t1", session_id: "s", transcript_path: "", cwd } as never, "t1", { signal: new AbortController().signal });
  assert.equal(decisionOf(await at(join(wt, "src"), "rm -rf out"))?.permissionDecision, "deny", "src/out is a symlink to a folder outside");
  assert.equal(decisionOf(await at(join(outer, "outside"), "rm -r x"))?.permissionDecision, "deny", "the shell left the worktree");
  assert.equal(judge.prompts.length, 0);
});

/** A query() that streams assistant messages (one repeated under its id, as the SDK does per content block), then fails. */
function failingQuery(end: "throw" | "no_result") {
  return (() =>
    (async function* () {
      const usage = { input_tokens: 100_000, output_tokens: 5_000, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 0 };
      yield { type: "assistant", message: { id: "m1", usage } };
      yield { type: "assistant", message: { id: "m1", usage } }; // the same message again: counted once
      yield { type: "assistant", message: { id: "m2", usage } };
      yield { type: "assistant", message: { id: "m3", usage: { input_tokens: Number.NaN, output_tokens: 7 } } }; // NaN counts 0
      if (end === "throw") throw new Error("stream died");
    })()) as unknown as typeof sdkQuery;
}

test("audit 2026-11-16 S-2: a worker that crashes or ends without a result is charged the tokens its stream reported", async () => {
  for (const end of ["throw", "no_result"] as const) {
    const res = await makeRunAgent({ query: failingQuery(end), env: {} })(req("planner"));
    assert.equal(res.ok, false, end);
    assert.equal(res.subtype, end === "throw" ? "exception" : "no_result");
    assert.equal(res.tokens, 2 * 205_000 + 7, end);
    assert.deepEqual(res.usage, { input: 200_000, output: 10_007, cacheRead: 200_000, cacheWrite: 0 }, end);
  }
});
