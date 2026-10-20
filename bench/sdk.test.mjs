// node --test bench/sdk.test.mjs: the SDK arm. No model calls; git runs in temp repos, the SDK output is faked.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { ARMS, command, envAdditions, runEnv } from "./arms.mjs";
import { ARMS as ANALYZE_ARMS, analyzeRun, tokensOf } from "./analyze.mjs";
import { adaptSdkResult, sdkAuthOk, sdkErrorKind, sdkResultDoc } from "./lib/sdk.mjs";
import { classifyRow } from "./lib/run-exec.mjs";
import { isAuthError, isRateLimited } from "./lib/run-core.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const tmps = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "sdk-arm-"));
  tmps.push(d);
  return d;
};
after(() => tmps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const git = (cwd, ...a) => {
  const r = spawnSync("git", a, { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
function repoWith(files = { "base.txt": "base\n" }) {
  const d = tmp();
  git(d, "init", "-q", "-b", "main");
  git(d, "config", "user.email", "t@t");
  git(d, "config", "user.name", "t");
  for (const [f, c] of Object.entries(files)) writeFileSync(join(d, f), c);
  git(d, "add", "-A");
  git(d, "commit", "-qm", "init");
  return d;
}
// A branch off main that adds or changes one file; main is left checked out and unchanged.
function sliceBranch(repo, branch, file, content) {
  git(repo, "checkout", "-q", "-b", branch, "main");
  writeFileSync(join(repo, file), content);
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", branch);
  git(repo, "checkout", "-q", "main");
}
// A fake SDK output dir: <out>/<runId>/{journal.json,telemetry.jsonl,report.json}
function fakeRun(out, id, { journal, report, telemetry }) {
  const dir = join(out, id);
  mkdirSync(dir, { recursive: true });
  if (journal) writeFileSync(join(dir, "journal.json"), JSON.stringify(journal));
  if (report) writeFileSync(join(dir, "report.json"), JSON.stringify(report));
  if (telemetry) writeFileSync(join(dir, "telemetry.jsonl"), `${telemetry.map((t) => JSON.stringify(t)).join("\n")}\n`);
  return dir;
}

test("SDK arm: command and env", () => {
  assert.equal(ARMS.SDK.copyClaude, false);
  const c = command("SDK", "do it", "/r/repo", "/root", { outDir: "/c/run/sdk", testCmd: "python3 t.py", budgetTokens: 3_000_000 });
  assert.equal(c.cmd, "npx");
  assert.equal(c.cwd, "/root");
  assert.deepEqual(c.args, ["tsx", "src/cli.ts", "--repo", "/r/repo", "--task", "do it", "--mode", "orchestrate", "--no-escalate", "--out", "/c/run/sdk", "--test-cmd", "python3 t.py", "--budget", "3000000"]);
  const bare = command("SDK", "p", "/r", "/root", { outDir: "/o" });
  assert.ok(!bare.args.includes("--test-cmd") && !bare.args.includes("--budget"));
  // existing arms are untouched
  assert.deepEqual(command("O-mix", "p", "/r", "/root"), { cmd: "bash", args: [join("/root", "scripts", "orchestrate.sh"), "p", "/r"], cwd: "/root" });
  // env: no ORCH_* additions; inherited ORCH_* stripped, ANTHROPIC_* kept
  assert.deepEqual(envAdditions("SDK", { test_cmd: "x" }, { budget_tokens: 5 }), {});
  const env = runEnv("SDK", {}, {}, { ORCH_MODEL: "x", ORCH_BUDGET_TOKENS: "1", ANTHROPIC_API_KEY: "k", PATH: "/bin" });
  assert.deepEqual(env, { ANTHROPIC_API_KEY: "k", PATH: "/bin" });
});

test("every arm in arms.mjs is known to analyze.mjs, SDK included", () => {
  for (const id of Object.keys(ARMS)) assert.ok(ANALYZE_ARMS.includes(id), `${id} missing from analyze ARMS`);
  assert.ok(ANALYZE_ARMS.includes("SDK"));
});

test("auth preflight: a credential variable passes without asking claude; otherwise claude auth status decides", () => {
  const never = () => assert.fail("must not call claude");
  assert.equal(sdkAuthOk({ env: { ANTHROPIC_API_KEY: "sk-secret" }, loggedIn: never }), true);
  assert.equal(sdkAuthOk({ env: { CLAUDE_CODE_OAUTH_TOKEN: "t" }, loggedIn: never }), true);
  assert.equal(sdkAuthOk({ env: {}, loggedIn: () => true }), true);
  assert.equal(sdkAuthOk({ env: { ANTHROPIC_API_KEY: "" }, loggedIn: () => false }), false);
});

test("adapter: fast-forwards the result branch into the working tree", () => {
  const repo = repoWith();
  sliceBranch(repo, "orch/R1/a", "a.txt", "A\n");
  sliceBranch(repo, "orch/R1/b", "b.txt", "B\n");
  git(repo, "checkout", "-q", "-b", "orch/R1/result", "main");
  git(repo, "merge", "-q", "--no-edit", "orch/R1/a", "orch/R1/b");
  git(repo, "checkout", "-q", "main");
  assert.ok(!existsSync(join(repo, "a.txt")));
  const out = join(tmp(), "sdk");
  fakeRun(out, "R1", { report: { runId: "R1", resultBranch: "orch/R1/result", slices: [], merged: [], conflicted: [] } });
  const r = adaptSdkResult(repo, out);
  assert.equal(r.mode, "result_branch");
  assert.deepEqual(r.merged, ["orch/R1/result"]);
  assert.ok(existsSync(join(repo, "a.txt")) && existsSync(join(repo, "b.txt")));
  assert.equal(git(repo, "branch", "--show-current"), "main");
});

test("adapter: no SDK output dir means nothing to do", () => {
  const repo = repoWith();
  const head = git(repo, "rev-parse", "HEAD");
  assert.equal(adaptSdkResult(repo, join(tmp(), "none")).mode, "none");
  assert.equal(git(repo, "rev-parse", "HEAD"), head);
});

test("salvage after a kill: merges passed slices only, skips conflicts and missing branches, records them", () => {
  const repo = repoWith({ "shared.txt": "base\n" });
  sliceBranch(repo, "orch/K1/a", "a.txt", "A\n");
  sliceBranch(repo, "orch/K1/b", "shared.txt", "from b\n");
  sliceBranch(repo, "orch/K1/c", "shared.txt", "from c\n"); // conflicts with b once b is merged
  sliceBranch(repo, "orch/K1/e", "e.txt", "E\n"); // failed slice: never merged
  const out = join(tmp(), "sdk");
  const slice = (id) => ({ id, goal: id, files: [], acceptance: [], dependsOn: [] });
  const fin = (id, status) => ({ id, branch: `orch/K1/${id}`, status, attempts: 1, issues: [] });
  // No report.json: the run was killed. f never finished; d passed but its branch is gone.
  fakeRun(out, "K1", {
    journal: { task: "t", base: "x", questions: [], findings: "", replans: 0, slices: ["a", "b", "c", "d", "e", "f"].map(slice), finished: [fin("a", "passed"), fin("b", "passed"), fin("c", "passed"), fin("d", "passed"), fin("e", "failed")] },
  });
  const r = adaptSdkResult(repo, out);
  assert.equal(r.mode, "salvage");
  assert.deepEqual(r.merged, ["orch/K1/a", "orch/K1/b"]);
  assert.deepEqual(r.conflicted, ["orch/K1/c"]);
  assert.deepEqual(r.missing, ["orch/K1/d"]);
  assert.equal(readFileSync(join(repo, "shared.txt"), "utf8"), "from b\n");
  assert.ok(existsSync(join(repo, "a.txt")) && !existsSync(join(repo, "e.txt")));
  assert.equal(git(repo, "status", "--porcelain"), "", "the conflicted merge was aborted");
});

test("salvage also covers a report without a result branch (integration failed)", () => {
  const repo = repoWith();
  sliceBranch(repo, "orch/K2/a", "a.txt", "A\n");
  const out = join(tmp(), "sdk");
  fakeRun(out, "K2", {
    journal: { slices: [{ id: "a" }], finished: [{ id: "a", branch: "orch/K2/a", status: "passed" }] },
    report: { runId: "K2", resultBranch: "orch/K2/result", error: "integration failed: x", slices: [] },
  });
  const r = adaptSdkResult(repo, out);
  assert.equal(r.mode, "salvage");
  assert.deepEqual(r.merged, ["orch/K2/a"]);
});

test("tokens: report.json spentTokens wins; telemetry-only (killed run) sums per-worker tokens", () => {
  const telemetry = [
    { role: "planner", model: "claude-opus-5-5", tokens: 1000, ok: true, usage: { input: 100, output: 200, cacheRead: 600, cacheWrite: 100 } },
    { role: "writer", model: "claude-sonnet-5-5", tokens: 500, ok: true, usage: { input: 50, output: 50, cacheRead: 400, cacheWrite: 0 } },
    { role: "writer", model: "claude-sonnet-5-5", tokens: 250, ok: true }, // no usage breakdown
  ];
  const a = join(tmp(), "sdk");
  fakeRun(a, "T1", { telemetry, report: { runId: "T1", spentTokens: 1750, tokensByRole: { planner: 1000, writer: 750 }, slices: [] } });
  const docA = sdkResultDoc(a);
  assert.equal(tokensOf([docA], []).total, 1750);
  assert.equal(tokensOf([docA], []).output_total, 250);
  assert.equal(docA.is_error, false);
  assert.deepEqual(docA.sdk.tokens_by_role, { planner: 1000, writer: 750 });

  const b = join(tmp(), "sdk");
  fakeRun(b, "T2", { telemetry }); // killed: telemetry.jsonl only
  const docB = sdkResultDoc(b);
  assert.equal(tokensOf([docB], []).total, 1750);
  assert.equal(docB.subtype, "killed_or_incomplete");
  assert.equal(docB.sdk.has_report, false);

  // a fast exit that spent tokens is never "no model usage"
  assert.equal(classifyRow({ end_reason: "exited", wall_ms: 5000, results: [docB] }).end_reason, "exited");
  // and with no run dir at all, nothing ran
  assert.equal(sdkResultDoc(join(tmp(), "empty")), null);
});

test("errors: auth and rate-limit wording in report.error, failed workers or stderr map to the shared classification", () => {
  const out = () => join(tmp(), "sdk");
  const rate = out();
  fakeRun(rate, "E1", { report: { runId: "E1", spentTokens: 5, error: "planner failed: error_during_execution", slices: [] }, telemetry: [{ tokens: 5, ok: false, subtype: "x", preview: "API Error: 429 rate limit exceeded" }] });
  const dRate = sdkResultDoc(rate);
  assert.equal(isRateLimited([dRate]), true);
  assert.equal(classifyRow({ end_reason: "exited", wall_ms: 90_000, results: [dRate] }).end_reason, "rate_limited");

  const auth = out();
  fakeRun(auth, "E2", { report: { runId: "E2", spentTokens: 0, error: "planner failed: Invalid API key", slices: [] } });
  const dAuth = sdkResultDoc(auth);
  assert.equal(isAuthError([dAuth]), true);
  assert.equal(classifyRow({ end_reason: "exited", wall_ms: 90_000, results: [dAuth] }).end_reason, "auth_error");

  const err = out();
  fakeRun(err, "E3", { telemetry: [{ tokens: 0, ok: true }] });
  assert.equal(isAuthError([sdkResultDoc(err, { stderr: "x\nFailed to authenticate: please run claude login" })]), true);

  // a plain quality failure is not an infrastructure error
  const q = out();
  fakeRun(q, "E4", { report: { runId: "E4", spentTokens: 9, slices: [{ id: "a", status: "failed", issues: ["tests failed: 3 assertions"] }] }, telemetry: [{ tokens: 9, ok: true }] });
  const dq = sdkResultDoc(q);
  assert.equal(dq.is_error, false);
  assert.equal(sdkErrorKind({ report: { slices: [{ status: "failed", issues: ["tests failed"] }] } }), null);
  assert.equal(classifyRow({ end_reason: "exited", wall_ms: 90_000, results: [dq] }).end_reason, "exited");
});

test("analyze: a row with snapshots none has null timeline metrics, not zeros; subagent fields do not break", () => {
  const campaign = { dir: tmp(), manifest: { campaign: "c" }, lenient: null, audit: null };
  const row = { run_id: "k2__SDK__cap10__r1", task: "k2-stdlib-toolkit-xl", arm: "SDK", cell: "cap10", rep: 1, cap_min: 10, wall_ms: 600_000, end_reason: "deadline", snapshots: "none", results: [], routes: [] };
  const grades = [{ run_id: row.run_id, snap: "final", passed: 100, total: 100, pass: true }];
  const r = analyzeRun(row, grades, campaign);
  assert.equal(r.score_pct, 100);
  assert.deepEqual([r.t90_s, r.t100_s, r.auc, r.has_snapshots], [null, null, null, false]);
  assert.deepEqual(r.timeline, []);
  assert.equal(r.self_delegated, false);
  assert.equal(r.subagent_count, 0);
});

test("dry-run on the sdk-vs-native matrix prints both arms' commands and env", () => {
  const r = spawnSync("node", [join(here, "run.mjs"), "--matrix", join(here, "matrix", "sdk-vs-native.json"), "--dry-run"], { encoding: "utf8", cwd: root });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /8 runs in 4 blocks/);
  assert.match(r.stdout, /arm=O-mix cap=10min/);
  assert.match(r.stdout, /arm=SDK cap=10min/);
  assert.match(r.stdout, /ORCH_AGENT="orchestrator"/);
  assert.match(r.stdout, /npx "tsx" "src\/cli\.ts" "--repo" .* "--mode" "orchestrate" "--no-escalate" "--out" .*\/k2-stdlib-toolkit-xl__SDK__cap10__r1\/sdk" "--test-cmd" "python3 tests\/run_public\.py"/);
  assert.match(r.stdout, /no additions; ANTHROPIC_\* passes through/);
  assert.ok(!/--budget/.test(r.stdout));
});

test("analyze: a run whose SDK left no report.json is flagged sdk_capped", () => {
  const campaign = { dir: tmp(), manifest: { campaign: "c" }, lenient: null, audit: null };
  const base = { task: "k2-stdlib-toolkit-xl", arm: "SDK", cell: "cap10", rep: 1, cap_min: 10, wall_ms: 600_000, snapshots: "none", routes: [] };
  const doc = (has_report) => ({ type: "result", sdk: { has_report } });
  assert.equal(analyzeRun({ ...base, run_id: "a", results: [doc(false)] }, [], campaign).sdk_capped, true);
  assert.equal(analyzeRun({ ...base, run_id: "b", results: [doc(true)] }, [], campaign).sdk_capped, false);
});
