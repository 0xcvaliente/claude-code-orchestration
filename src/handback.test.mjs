// 1.2.0: reports checked before delivery. handback-check.mjs (PreToolUse on SubagentHandback: STATUS line, CHECKS
// answers) and quote-check.mjs on the same event, run as child processes with fixture state (no model call).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { launchRecord } from "../.claude/hooks/brief.mjs";
import { reportProblem } from "../.claude/hooks/handback-check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = (/** @type {string} */ name) => join(root, ".claude", "hooks", name);
const SECRET = "the-report-body-must-never-be-logged";

function project() {
  const dir = mkdtempSync(join(tmpdir(), "orch-handback-"));
  mkdirSync(join(dir, ".claude", "state"), { recursive: true });
  return dir;
}
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCH_") && !k.startsWith("CLAUDE_PLUGIN_")));
/** @param {string} dir @param {string} script @param {unknown} input @param {Record<string, string>} [extra] */
function run(dir, script, input, extra = {}) {
  const r = spawnSync(process.execPath, [hook(script)], { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...baseEnv, CLAUDE_PROJECT_DIR: dir, ...extra }, cwd: dir, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}
/** @param {string} message @param {{ type?: string | null, agent?: string | null, tool?: string }} [o] */
const handback = (message, o = {}) => ({
  session_id: "s1",
  hook_event_name: "PreToolUse",
  tool_name: o.tool ?? "SubagentHandback",
  tool_input: { message },
  ...(o.agent === null ? {} : { agent_id: o.agent ?? "a1" }),
  ...(o.type === null ? {} : { agent_type: o.type ?? "orchestration:reviewer" }),
});
/** @param {string} dir */
const gates = (dir) => {
  const f = join(dir, ".claude", "state", "gates.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};

test("reportProblem: a report needs a STATUS line; a reviewer's pass needs an answer for every checked id", () => {
  assert.equal(reportProblem("implementer", "STATUS: pass\nFILES: a.py"), null);
  assert.equal(reportProblem("researcher", "Here is what I found.\n\n**STATUS: fail**\nOPEN: none"), null);
  for (const text of ["All done, tests pass.", "", "> STATUS: pass", "STATUS: pass or fail", "The STATUS: pass line is below"]) {
    assert.equal(reportProblem("implementer", text)?.reason, "no_status", JSON.stringify(text));
  }
  const p = reportProblem("reviewer", "STATUS: pass\nC1: pass (cmd) npm test -> 4 pass", ["C1", "C2", "C3"]);
  assert.deepEqual([p?.reason, p?.missing], ["checks_unanswered", ["C2", "C3"]]);
  assert.match(p?.message ?? "", /without answering C2, C3/);
  assert.equal(reportProblem("reviewer", "STATUS: pass\nC1: pass (read) a.py:3\nC2: pass (cmd) x -> ok", ["C1", "C2"]), null);
  // A failing review reports gaps, not answers; another role's CHECKS are the review gate's business.
  assert.equal(reportProblem("reviewer", "STATUS: fail\nGAP: 90 crashes", ["C1"]), null);
  assert.equal(reportProblem("implementer", "STATUS: pass", ["C1"]), null);
  assert.equal(reportProblem("reviewer", "STATUS: pass"), null, "no CHECKS known: nothing to ask for");
});

test("handback check: a report without STATUS is sent back once, then goes through; the log holds no report text", () => {
  const dir = project();
  try {
    const first = run(dir, "handback-check.mjs", handback(`Looks fine to me.\n${SECRET}`));
    assert.equal(first.code, 2);
    assert.match(first.stderr, /no STATUS line.*`STATUS: pass` or `STATUS: fail`/);
    assert.equal(first.stdout, "", "deny-only: never a permission decision on stdout");
    // The same report again: the worker is never sent back twice.
    const second = run(dir, "handback-check.mjs", handback(`Looks fine to me.\n${SECRET}`));
    assert.deepEqual([second.code, second.stdout, second.stderr], [0, "", ""]);
    const log = gates(dir).filter((g) => g.gate === "handback");
    assert.deepEqual(log.map((g) => [g.decision, g.reason, g.agent_id, g.agent_type]), [["deny", "no_status", "a1", "reviewer"], ["allow", "no_status_gave_up", "a1", "reviewer"]]);
    assert.ok(!JSON.stringify(log).includes(SECRET));
    // A report with its STATUS line passes without a record.
    const ok = run(dir, "handback-check.mjs", handback("STATUS: pass\nOPEN: none", { agent: "a2", type: "implementer" }));
    assert.deepEqual([ok.code, ok.stdout, ok.stderr], [0, "", ""]);
    assert.equal(gates(dir).filter((g) => g.agent_id === "a2").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handback check: a reviewer's pass that skips a checked id is sent back, with the ids from its launch record", () => {
  const dir = project();
  try {
    const launch = launchRecord({ subagent_type: "orchestration:reviewer", prompt: "SLICE: a\nCHECKS: C1, C2\nC1: no throw\nC2: no new deps" }, { ts: new Date().toISOString(), sessionId: "s1", agentId: "rev1" });
    writeFileSync(join(dir, ".claude", "state", "journal-launches.jsonl"), `${JSON.stringify(launch)}\n`);
    const r = run(dir, "handback-check.mjs", handback("STATUS: pass\nC1: pass (cmd) pytest -> 3 passed", { agent: "rev1" }));
    assert.equal(r.code, 2);
    assert.match(r.stderr, /without answering C2\..*one line per checked id/);
    assert.deepEqual(gates(dir).at(-1)?.missing, ["C2"]);
    // Answered in full it passes; so does a reviewer with no launch record yet (a foreground launch).
    assert.equal(run(dir, "handback-check.mjs", handback("STATUS: pass\nC1: pass (cmd) pytest -> 3 passed\nC2: pass (read) package.json:12", { agent: "rev1" })).code, 0);
    assert.equal(run(dir, "handback-check.mjs", handback("STATUS: pass\nC1: pass (cmd) pytest -> 3 passed", { agent: "rev-foreground" })).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handback check: other agents, other tools, no agent id, the switch and malformed input pass untouched", () => {
  const dir = project();
  try {
    const bad = "no status here";
    for (const type of ["general-purpose", "Explore", "orchestration:orchestrator", null]) assert.equal(run(dir, "handback-check.mjs", handback(bad, { type })).code, 0, String(type));
    assert.equal(run(dir, "handback-check.mjs", handback(bad, { tool: "Bash" })).code, 0);
    assert.equal(run(dir, "handback-check.mjs", handback(bad, { agent: null })).code, 0, "no agent id: a second report could not be told from the first");
    assert.equal(gates(dir).at(-1)?.reason, "no_status_gave_up");
    for (const off of ["off", " OFF "]) assert.equal(run(dir, "handback-check.mjs", handback(bad, { agent: "z" }), { ORCH_HANDBACK_CHECK: off }).code, 0);
    assert.equal(run(dir, "handback-check.mjs", handback(bad, { agent: "z" }), { CLAUDE_PLUGIN_OPTION_HANDBACK_CHECK: "off" }).code, 0, "the plugin setting reaches the hook");
    for (const input of ["", "not json", "null", "[]", JSON.stringify({ tool_name: "SubagentHandback", agent_type: "reviewer", tool_input: {} })]) assert.equal(run(dir, "handback-check.mjs", input).code, 0, input);
    assert.equal(gates(dir).filter((g) => g.decision === "deny").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quote check at handback: an unverified quote is refused before delivery, once; the stop that follows is silent", () => {
  const dir = project();
  try {
    writeFileSync(join(dir, "notes.md"), "# Notes\n\nThe parser never throws on bad input.\n");
    const quotes = () => readFileSync(join(dir, ".claude", "state", "quotes.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const wrong = 'STATUS: pass\nQUOTE: notes.md:3 | "The parser always throws on bad input."';
    const right = 'STATUS: pass\nQUOTE: notes.md:3 | "The parser never throws on bad input."';
    const researcher = { agent: "q1", type: "orchestration:researcher" };
    const first = run(dir, "quote-check.mjs", handback(wrong, researcher));
    assert.equal(first.code, 2);
    assert.match(first.stderr, /Quote check: 1 of your QUOTE lines was not found.*notes\.md:3/s);
    const second = run(dir, "quote-check.mjs", handback(right, researcher));
    assert.deepEqual([second.code, second.stderr], [0, ""]);
    assert.deepEqual(quotes().map((q) => [q.at, q.blocked, q.verified, q.unverified]), [["handback", true, 0, 1], ["handback", false, 1, 0]]);
    // The SubagentStop after a checked handback adds nothing: no record, no block, even with a report it would refuse.
    const transcript = join(dir, "t.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "SubagentHandback", input: { message: wrong } }] } })}\n`);
    const stop = run(dir, "quote-check.mjs", { session_id: "s1", hook_event_name: "SubagentStop", agent_id: "q1", agent_type: "orchestration:researcher", agent_transcript_path: transcript });
    assert.deepEqual([stop.code, stop.stderr], [0, ""]);
    assert.equal(quotes().length, 2);
    // Another tool's PreToolUse and another agent's handback are not its business.
    assert.equal(run(dir, "quote-check.mjs", { ...handback(wrong, { agent: "q2", type: "researcher" }), tool_name: "Bash" }).code, 0);
    assert.equal(run(dir, "quote-check.mjs", handback(wrong, { agent: "q3", type: "reviewer" })).code, 0);
    assert.equal(quotes().length, 2);
    // Without a handback (another permission mode) the stop checks as before.
    const plain = run(dir, "quote-check.mjs", { session_id: "s1", hook_event_name: "SubagentStop", agent_id: "q4", agent_type: "researcher", agent_transcript_path: join(dir, "missing.jsonl"), last_assistant_message: wrong });
    assert.equal(plain.code, 2);
    assert.equal(quotes().at(-1)?.at, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- Review of 2026-11-10: a refusal at a hand-back must be provably the only one. ----

test("quote check at handback: without an agent id it never refuses (a second report could not be told from the first)", () => {
  const dir = project();
  try {
    writeFileSync(join(dir, "notes.md"), "hello world\n");
    const wrong = 'STATUS: pass\nQUOTE: notes.md:1 | "goodbye moon"';
    for (let i = 0; i < 3; i++) {
      const r = run(dir, "quote-check.mjs", handback(wrong, { agent: null, type: "researcher" }));
      assert.deepEqual([r.code, r.stderr], [0, ""], `call ${i + 1}`);
    }
    // At SubagentStop the old rule stands: no agent id falls back to stop_hook_active.
    const stop = { session_id: "s1", hook_event_name: "SubagentStop", agent_type: "researcher", agent_transcript_path: join(dir, "missing.jsonl"), last_assistant_message: wrong };
    assert.equal(run(dir, "quote-check.mjs", stop).code, 2);
    assert.equal(run(dir, "quote-check.mjs", { ...stop, stop_hook_active: true }).code, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("handback checks: when the refusal cannot be recorded, nothing is refused", { skip: process.getuid?.() === 0 ? "root ignores directory permissions" : false }, async () => {
  const { chmodSync } = await import("node:fs");
  const dir = project();
  const state = join(dir, ".claude", "state");
  try {
    writeFileSync(join(dir, "notes.md"), "hello world\n");
    chmodSync(state, 0o555); // the logs cannot be created
    for (let i = 0; i < 2; i++) {
      assert.equal(run(dir, "handback-check.mjs", handback("no status line", { agent: "w1" })).code, 0, "report check");
      assert.equal(run(dir, "quote-check.mjs", handback('STATUS: pass\nQUOTE: notes.md:1 | "goodbye moon"', { agent: "w2", type: "researcher" })).code, 0, "quote check");
    }
    assert.equal(gates(dir).length, 0);
  } finally {
    chmodSync(state, 0o755);
    rmSync(dir, { recursive: true, force: true });
  }
});
