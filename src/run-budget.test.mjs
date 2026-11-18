import "./test-tmp.mjs";
// scripts/run-budget.mjs: the arithmetic of the run-wide cap of `npm run auto` (scripts/auto.sh). The launcher's own use
// of it is tested in src/verify.test.ts ("auto.sh run-wide cap: ...").
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MIN_SESSION_TOKENS, nextSession, sessionSpentOf, spentMessage, spentOf, SPENT_EXIT, unknownMessage } from "../scripts/run-budget.mjs";

const scripts = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const script = join(scripts, "run-budget.mjs");

test("spentOf: dollars first at 1M tokens per dollar, then the call's tokens, then nothing", () => {
  assert.equal(spentOf({ costUsd: 0.0289293, tokens: 14030 }), 28929, "a triage decision: its cost");
  assert.equal(spentOf({ total_cost_usd: 0.25, modelUsage: { m: { inputTokens: 5 } } }), 250000, "a session: its total_cost_usd");
  assert.equal(spentOf({ tokens: 14030 }), 14030, "a decision without a cost: its tokens");
  assert.equal(spentOf({ result: "x", modelUsage: { m: { inputTokens: 1000, outputTokens: 200, cacheReadInputTokens: 30, cacheCreationInputTokens: 4 } } }), 1234);
  for (const odd of [null, undefined, "text", 3, [], {}, { costUsd: -1 }, { total_cost_usd: Number.NaN }]) assert.equal(spentOf(odd), 0, JSON.stringify(odd));
});

test("nextSession: the rest of the cap, and never a session under the smallest cap", () => {
  assert.deepEqual(nextSession(300_000, 50_000), { ok: true, left: 250_000 });
  assert.deepEqual(nextSession(300_000, 300_000 - MIN_SESSION_TOKENS), { ok: true, left: MIN_SESSION_TOKENS });
  assert.deepEqual(nextSession(300_000, 300_000 - MIN_SESSION_TOKENS + 1), { ok: false, left: MIN_SESSION_TOKENS - 1 });
  assert.deepEqual(nextSession(300_000, 400_000), { ok: false, left: 0 }, "overspent: nothing left, not a negative cap");
  assert.equal(MIN_SESSION_TOKENS, 10_000, "the floor of tokens.mjs parseTokens");
});

test("run-budget.mjs CLI: spent reads stdin, next prints the rest or exits 3 with the message", () => {
  const run = (/** @type {string[]} */ args, input = "") => spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8" });
  assert.equal(run(["spent"], JSON.stringify({ total_cost_usd: 0.1 })).stdout, "100000\n");
  assert.equal(run(["spent"], "not json").stdout, "0\n");
  assert.equal(run(["next", "300k", "50000", "reviewer"]).stdout, "250000\n");
  const out = run(["next", "300k", "295000", "reviewer"]);
  assert.equal(out.status, SPENT_EXIT);
  assert.equal(SPENT_EXIT, 3);
  assert.equal(out.stdout, "");
  assert.equal(out.stderr.trim(), spentMessage("300k", 295000, 5000, "reviewer"));
  assert.equal(run(["next", "5", "0", "x"]).status, 1, "a bad cap is an error, not a spent cap");
  assert.equal(run(["next", "300k", "-1", "x"]).status, 1);
});

// 1.6.0 Known and not fixed: a session that left no readable result (a crash with no output) counted as having spent
// nothing, so the next session started with the whole remainder of the cap. Its spend is unknown: it now uses up the cap.
const NO_RESULT = '{"type":"result","subtype":"no_result","is_error":true,"terminal_reason":"no_result","result":"","orch_totals":{"results":0,"turns":2,"wall_ms":10,"exit_code":137,"complete":false}}';

test("sessionSpentOf: a readable session counts as before; no readable result is unknown (null)", () => {
  assert.equal(sessionSpentOf({ result: "done", total_cost_usd: 0.1 }), 100000);
  assert.equal(sessionSpentOf({ result: "done" }), 0, "a readable result without a figure: 0, as before");
  assert.equal(sessionSpentOf({ ...JSON.parse(NO_RESULT), total_cost_usd: 0.02 }), 20000, "a figure is a figure");
  for (const odd of [null, undefined, "Segfault", 3, [], JSON.parse(NO_RESULT)]) assert.equal(sessionSpentOf(odd), null, JSON.stringify(odd));
});

test("run-budget.mjs CLI: spent --session prints unknown, and next with unknown spend exits 3 naming the earlier session", () => {
  const run = (/** @type {string[]} */ args, input = "") => spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8" });
  assert.equal(run(["spent", "--session"], "").stdout, "unknown\n");
  assert.equal(run(["spent", "--session"], "Segfault\n").stdout, "unknown\n");
  assert.equal(run(["spent", "--session"], NO_RESULT).stdout, "unknown\n");
  assert.equal(run(["spent", "--session"], '{"result":"done","total_cost_usd":0.1}').stdout, "100000\n");
  assert.equal(run(["spent"], "").stdout, "0\n", "a triage decision is read as before");
  const out = run(["next", "300k", "unknown", "orchestrator", "plain session"]);
  assert.equal(out.status, SPENT_EXIT);
  assert.equal(out.stdout, "");
  assert.equal(out.stderr.trim(), unknownMessage("300k", "plain session", "orchestrator"));
  assert.match(out.stderr, /the plain session before it left no result, so what it spent is unknown/);
  assert.match(out.stderr, /the orchestrator does not start/);
});

/** auto.sh with a fake `claude` (prints `session`, exits `exit`) and a fake triage (`npx` prints `route`). */
function runAuto(/** @type {{ session: string, exit: number, route: object }} */ o) {
  const bin = mkdtempSync(join(tmpdir(), "rb-bin-"));
  const repo = mkdtempSync(join(tmpdir(), "rb-repo-"));
  mkdirSync(join(repo, ".claude", "agents"), { recursive: true });
  for (const name of ["orchestrator", "reviewer"]) writeFileSync(join(repo, ".claude", "agents", `${name}.md`), `---\nname: ${name}\ndescription: stub\n---\n`);
  const log = join(bin, "calls");
  mkdirSync(log);
  writeFileSync(join(bin, "session.out"), o.session);
  writeFileSync(join(bin, "claude"), `#!/bin/sh\n[ "$1" = plugin ] && exit 1\nprintf '%s\\n' "$@" > "${log}/$$"\nfor a in "$@"; do [ "$a" = reviewer ] && { echo '{"result":"STATUS: pass"}'; exit 0; }; done\ncat "${bin}/session.out"\nexit ${o.exit}\n`, { mode: 0o755 });
  writeFileSync(join(bin, "route.json"), JSON.stringify(o.route));
  writeFileSync(join(bin, "npx"), `#!/bin/sh\ncat "${bin}/route.json"\n`, { mode: 0o755 });
  const env = { ...process.env };
  for (const k of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete env[k];
  const r = spawnSync("bash", [join(scripts, "auto.sh"), "write the summary", repo], {
    env: { ...env, PATH: `${bin}:${process.env.PATH}`, GIT_CEILING_DIRECTORIES: dirname(repo), ORCH_MODE: "", ORCH_TEST_CMD: "", ORCH_ALLOWED_TOOLS: "", ORCH_EXTRA_ALLOWED_TOOLS: "", ORCH_NO_ESCALATE: "", ORCH_AGENT_PREFIX: "", ORCH_BUDGET_USD: "", ORCH_BUDGET_TOKENS: "300k" },
    encoding: "utf8",
  });
  const calls = readdirSync(log).map((f) => readFileSync(join(log, f), "utf8"));
  return { ...r, agents: calls.map((c) => { const l = c.split("\n"); return l.includes("--agent") ? l[l.indexOf("--agent") + 1] : "none"; }) };
}
const route = (/** @type {string} */ mode) => ({ mode, source: "triage", reason: "stub", tokens: 9000, costUsd: 0.01 });

test("auto.sh run-wide cap: a plain session that crashed with no output starts no escalated orchestrator and exits 3", () => {
  const r = runAuto({ session: "", exit: 1, route: route("plain") });
  assert.equal(r.status, SPENT_EXIT, r.stderr);
  assert.match(r.stderr, /budget: ORCH_BUDGET_TOKENS=300k is the cap for the whole run, and the plain session before it left no result, so what it spent is unknown/);
  assert.match(r.stderr, /the orchestrator does not start/);
  assert.deepEqual(r.agents, ["none"], "the escalated orchestrator never started");
});

test("auto.sh run-wide cap: a crash after start-up (no result record) starts no reviewer and exits 3", () => {
  const r = runAuto({ session: '{"type":"system","subtype":"init"}\n', exit: 0, route: route("reviewed") });
  assert.equal(r.status, SPENT_EXIT, r.stderr);
  assert.match(r.stderr, /the plain session before it left no result, so what it spent is unknown.*the reviewer does not start/);
  assert.deepEqual(r.agents, ["none"]);
});

test("auto.sh run-wide cap: a session with a readable result is counted as before and the reviewer starts", () => {
  const r = runAuto({ session: '{"result":"done","total_cost_usd":0.1}', exit: 0, route: route("reviewed") });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.agents.sort(), ["none", "reviewer"]);
});
