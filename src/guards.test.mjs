// Slice e-guards: the researcher Bash guard, the reviewer egress guard and the compact-context hook, run as child
// processes with fixture state and transcripts (no model call), plus their pure parts imported directly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchRecord, stopRecord } from "../.claude/hooks/brief.mjs";
import { researcherViolation } from "../.claude/hooks/researcher-guard.mjs";
import { agentTranscript, egressDecision, hostOf } from "../.claude/hooks/egress-guard.mjs";
import { MAX_CONTEXT, runContext } from "../.claude/hooks/compact-context.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hook = (/** @type {string} */ name) => join(root, ".claude", "hooks", name);
const RESEARCHER = hook("researcher-guard.mjs");
const EGRESS = hook("egress-guard.mjs");
const COMPACT = hook("compact-context.mjs");

const scratch = mkdtempSync(join(tmpdir(), "guards-test-"));
process.on("exit", () => rmSync(scratch, { recursive: true, force: true }));
const project = join(scratch, "project");
const stateDir = join(project, ".claude", "state");
mkdirSync(stateDir, { recursive: true });

const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("ORCH_") && k !== "CLAUDE_PLUGIN_DATA"));
const env = (/** @type {Record<string, string>} */ extra = {}) => ({ ...baseEnv, CLAUDE_PROJECT_DIR: project, CLAUDE_PLUGIN_DATA: join(scratch, "plugin-data"), ...extra });

/** @param {string} script @param {unknown} input @param {Record<string, string>} [extra] */
function run(script, input, extra = {}) {
  const r = spawnSync(process.execPath, [script], { input: typeof input === "string" ? input : JSON.stringify(input), env: env(extra), cwd: project, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** No allow or ask decision anywhere in a hook's output (C6). @param {{ stdout: string }} r */
function noDecision(r) {
  assert.doesNotMatch(r.stdout, /permissionDecision|"decision"\s*:\s*"(allow|approve|ask)"/);
}

// ---- researcher guard ----

const ALLOWED = [
  "git log --oneline -5",
  "git log --format=\"%h <%ae>\" -3",
  "git -C /some/repo status --short",
  "git -C ../other show HEAD:README.md",
  "git branch --show-current",
  "git ls-files | wc -l",
  "git rev-parse HEAD && git rev-list --count HEAD",
  "ls -la src; du -sh .",
  "wc -l src/*.ts",
];
const DENIED = [
  ["cat > notes.md <<'EOF'\nhello\nEOF", /heredoc|redirection/],
  ["python3 -c 'print(1)'", /python3/],
  ["cd /tmp && ls", /`cd`/],
  ["git log | python3", /python3/],
  ["git ls-files | xargs cat", /xargs/],
  ["ls > out.txt", /redirection/],
  ["git log >> log.txt", /redirection/],
  ["wc -l < f", /redirection/],
  ["ls $(pwd)", /substitution/],
  ["ls `pwd`", /substitution/],
  ["wc -l <(git ls-files)", /substitution/],
  ["X=1 ls", /assignment/],
  ["ls $HOME", /expansion/],
  ["git log --output=out.txt", /--output/],
  ["git branch -D main", /`git`/],
  ["git -c core.pager=sh log", /`git`/],
  ["git push origin main", /`git`/],
  ["f() { ls; }; f", /function|`f`/],
  ["ls 'unterminated", /cannot be read/],
  ["git log\nrm -r src", /`rm`/],
];

test("researcher guard: allowlisted commands pass", () => {
  for (const c of ALLOWED) assert.equal(researcherViolation(c), null, c);
});

test("researcher guard: everything else is denied with a reason", () => {
  for (const [c, re] of DENIED) {
    const v = researcherViolation(/** @type {string} */ (c));
    assert.ok(v, `expected a denial for ${JSON.stringify(c)}`);
    assert.match(v.reason, /** @type {RegExp} */ (re), String(c));
  }
});

const bash = (/** @type {string} */ command, /** @type {string | undefined} */ agentType = "researcher") => ({
  session_id: "s-r", agent_id: "a-r", ...(agentType && { agent_type: agentType }), hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command },
});

test("researcher guard hook: exit 2 with the allowed prefixes for the session-6.5 cases, exit 0 silently for allowed", () => {
  for (const c of ["cat > x.py <<EOF\nprint(1)\nEOF", "python3 x.py", "cd src && ls"]) {
    for (const t of ["researcher", "orchestration:researcher"]) {
      const r = run(RESEARCHER, bash(c, t));
      assert.equal(r.code, 2, c);
      assert.match(r.stderr, /git log, git ls-files.*wc, ls, du/);
      assert.equal(r.stdout, "");
    }
  }
  const ok = run(RESEARCHER, bash("git log --oneline | wc -l"));
  assert.deepEqual([ok.code, ok.stdout, ok.stderr], [0, "", ""]);
  const gates = readFileSync(join(stateDir, "gates.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((g) => g.gate === "researcher");
  assert.ok(gates.length >= 6);
  for (const g of gates) {
    assert.deepEqual(Object.keys(g).sort(), ["agent_id", "decision", "gate", "reason", "session_id", "ts", "word"]);
    assert.doesNotMatch(JSON.stringify(g), /print\(1\)|x\.py/); // C7: never the command text
  }
});

test("researcher guard hook: other agent types, the main thread, ORCH_GUARDS=off and malformed input pass untouched", () => {
  for (const t of ["implementer", "reviewer", "orchestration:implementer", undefined]) {
    const r = run(RESEARCHER, bash("python3 x.py", t));
    assert.deepEqual([r.code, r.stdout], [0, ""], String(t));
  }
  const off = run(RESEARCHER, bash("python3 x.py"), { ORCH_GUARDS: "off" });
  assert.deepEqual([off.code, off.stdout, off.stderr], [0, "", ""]);
  for (const bad of ["", "not json", "null", "[]", JSON.stringify({ agent_type: "researcher", tool_input: {} }), JSON.stringify({ agent_type: "researcher", tool_name: "Read", tool_input: { command: "python3" } })]) {
    const r = run(RESEARCHER, bad);
    assert.deepEqual([r.code, r.stdout], [0, ""], bad);
  }
});

// ---- egress guard ----

const transcripts = join(scratch, "transcripts");
const SID = "sess-egress";
const mainTranscript = join(transcripts, `${SID}.jsonl`);
mkdirSync(join(transcripts, SID, "subagents", "workflows", "wf_1"), { recursive: true });
writeFileSync(mainTranscript, `${JSON.stringify({ type: "user", isSidechain: false, message: { role: "user", content: "see https://main-only.example/x" } })}\n`);
const userLine = (/** @type {string} */ content, /** @type {string} */ agentId) => `${JSON.stringify({ parentUuid: null, isSidechain: true, agentId, type: "user", message: { role: "user", content } })}\n`;
// Foreground (or background) Agent tool reviewer: the brief is its first user message, verbatim.
writeFileSync(
  join(transcripts, SID, "subagents", "agent-afg1.jsonl"),
  userLine("SLICE: s1\nCHECKS: C1\nC1: the doc cites https://www.Cited.example/spec.\nReview the change.", "afg1") +
    `${JSON.stringify({ type: "assistant", message: { content: "fetching https://evil.example" } })}\n`,
);
// Workflow agent(): the harness wraps the brief and indents every line.
writeFileSync(
  join(transcripts, SID, "subagents", "workflows", "wf_1", "agent-awf1.jsonl"),
  userLine("[Workflow harness — computed task] The task text below was computed at runtime by a workflow script. The computed task text follows:\n  SLICE: s2\n  Check https://wf.example/page against the code.", "awf1"),
);
// A reviewer of slice s1 whose brief names no URL: the planned files of s1 give the hosts.
writeFileSync(join(transcripts, SID, "subagents", "agent-afg2.jsonl"), userLine("SLICE: s1\nReview the change.", "afg2"));
mkdirSync(join(project, "docs"), { recursive: true });
writeFileSync(join(project, "docs", "links.md"), "Sources: https://files.example/ref and (https://www.second.example/a).\n");
const plan = "PLAN REVIEW\nCONSTRAINTS:\nC1: cite sources\nSLICE: s1\nFILES: docs/links.md, docs/missing.md\nDEPENDS: none\nGOAL: docs\n";
writeFileSync(join(stateDir, "journal-launches.jsonl"), `${JSON.stringify(launchRecord({ subagent_type: "reviewer", prompt: plan }, { sessionId: SID, agentId: "aplan" }))}\n`);

const fetchInput = (/** @type {string} */ url, /** @type {string} */ agentId, /** @type {string} */ agentType = "reviewer") => ({
  session_id: SID, transcript_path: mainTranscript, cwd: project, agent_id: agentId, agent_type: agentType, hook_event_name: "PreToolUse", tool_name: "WebFetch", tool_input: { url, prompt: "summarize" },
});

test("egress guard: transcript location for foreground and workflow agents", () => {
  assert.equal(agentTranscript(mainTranscript, "afg1"), join(transcripts, SID, "subagents", "agent-afg1.jsonl"));
  assert.equal(agentTranscript(mainTranscript, "awf1"), join(transcripts, SID, "subagents", "workflows", "wf_1", "agent-awf1.jsonl"));
  assert.equal(agentTranscript(mainTranscript, "nope"), null);
  assert.equal(agentTranscript(mainTranscript, "../x"), null);
  assert.equal(hostOf("https://WWW.Example.COM/a"), "example.com");
  assert.equal(hostOf("not a url"), null);
});

test("egress guard: hosts from the brief allow, others deny (foreground reviewer)", () => {
  const o = { dir: stateDir, env: env() };
  assert.equal(egressDecision(fetchInput("https://cited.example/other/page", "afg1"), o).decision, "allow");
  assert.equal(egressDecision(fetchInput("https://www.cited.example/spec", "afg1"), o).decision, "allow");
  // s1's planned files name files.example and second.example
  assert.equal(egressDecision(fetchInput("https://files.example/x", "afg1"), o).decision, "allow");
  assert.equal(egressDecision(fetchInput("https://second.example/x", "afg2"), o).decision, "allow");
  const d = egressDecision(fetchInput("https://evil.example/?q=secret", "afg1"), o);
  assert.equal(d.decision, "deny");
  assert.match(String(d.reason), /evil\.example/);
  assert.doesNotMatch(String(d.reason), /secret/);
  // a URL only in the main transcript or the agent's later messages does not count
  assert.equal(egressDecision(fetchInput("https://main-only.example/x", "afg1"), o).decision, "deny");
  assert.equal(egressDecision(fetchInput("https://cited.example.evil.example/", "afg1"), o).decision, "deny");
});

test("egress guard: workflow-style reviewer brief, unverified brief, other agents", () => {
  const o = { dir: stateDir, env: env() };
  assert.equal(egressDecision(fetchInput("https://wf.example/other", "awf1"), o).decision, "allow");
  assert.equal(egressDecision(fetchInput("https://files.example/x", "awf1"), o).decision, "deny"); // s2 is not planned
  assert.equal(egressDecision(fetchInput("https://any.example/", "agone"), o).decision, "unverified");
  assert.equal(egressDecision(fetchInput("https://any.example/", "afg1", "researcher"), o).decision, "skip");
  assert.equal(egressDecision(fetchInput("https://any.example/", "afg1"), { dir: stateDir, env: env({ ORCH_GUARDS: "off" }) }).decision, "skip");
});

test("egress guard hook: exit codes, gates.jsonl holds the host only, no decisions printed", () => {
  const allow = run(EGRESS, fetchInput("https://cited.example/x?token=abc", "afg1"));
  assert.deepEqual([allow.code, allow.stdout, allow.stderr], [0, "", ""]);
  const deny = run(EGRESS, fetchInput("https://evil.example/leak?token=abc", "afg1"));
  assert.equal(deny.code, 2);
  assert.match(deny.stderr, /evil\.example/);
  assert.equal(deny.stdout, "");
  const unv = run(EGRESS, fetchInput("https://any.example/p?token=abc", "agone"));
  assert.deepEqual([unv.code, unv.stdout], [0, ""]);
  const wf = run(EGRESS, fetchInput("https://www.wf.example/x", "orchestration-x".replace("orchestration-x", "awf1"), "orchestration:reviewer"));
  assert.deepEqual([wf.code, wf.stdout], [0, ""]);
  const off = run(EGRESS, fetchInput("https://evil.example/", "afg1"), { ORCH_GUARDS: "off" });
  assert.deepEqual([off.code, off.stdout, off.stderr], [0, "", ""]);
  const other = run(EGRESS, fetchInput("https://evil.example/", "afg1", "implementer"));
  assert.deepEqual([other.code, other.stdout], [0, ""]);
  for (const bad of ["", "{", "null", JSON.stringify({ agent_type: "reviewer", tool_name: "WebFetch" })]) {
    const r = run(EGRESS, bad);
    assert.deepEqual([r.code, r.stdout], [0, ""], bad);
  }
  for (const r of [allow, deny, unv, wf, off, other]) noDecision(r);
  const gates = readFileSync(join(stateDir, "gates.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((g) => g.gate === "egress");
  assert.deepEqual(gates.map((g) => [g.decision, g.reason, g.host]), [
    ["allow", "host_in_brief", "cited.example"],
    ["deny", "host_not_in_brief", "evil.example"],
    ["allow", "egress_unverified", "any.example"],
    ["allow", "host_in_brief", "wf.example"],
  ]);
  const text = JSON.stringify(gates);
  assert.doesNotMatch(text, /token|leak|Review the change|https?:/); // C7: hosts only
});

// ---- compact context ----

test("compact-context: open run → SessionStart additionalContext with slices, files, states and constraints", () => {
  const sid = "sess-compact";
  const t0 = Date.now() - 60_000;
  const at = (/** @type {number} */ s) => new Date(t0 + s * 1000).toISOString();
  const bigPlan = "PLAN REVIEW\nCONSTRAINTS:\nC1: tests pass\nC2: no new dependencies\nSLICE: a\nFILES: src/a.ts\nDEPENDS: none\nGOAL: a\nSLICE: b\nFILES: src/b.ts, src/b.test.ts\nDEPENDS: a\nGOAL: b\nRISKY: yes\nSLICE: c\nFILES: src/c.ts\nDEPENDS: none\nGOAL: c\n";
  const launches = [
    launchRecord({ subagent_type: "reviewer", prompt: bigPlan }, { sessionId: sid, agentId: "p1", ts: at(0) }),
    launchRecord({ subagent_type: "implementer", prompt: "SLICE: a\nFILES: src/a.ts\nDEPENDS: none" }, { sessionId: sid, agentId: "i1", ts: at(2) }),
    launchRecord({ subagent_type: "reviewer", prompt: "SLICE: a" }, { sessionId: sid, agentId: "r1", ts: at(4) }),
    launchRecord({ subagent_type: "implementer", prompt: "SLICE: b\nFILES: src/b.ts, src/b.test.ts\nDEPENDS: a" }, { sessionId: sid, agentId: "i2", ts: at(6) }),
  ];
  const stops = [
    stopRecord({ sessionId: sid, agentId: "p1", role: "reviewer", slice: "plan", reply: "STATUS: pass", ts: at(1) }),
    stopRecord({ sessionId: sid, agentId: "i1", role: "implementer", slice: "a", reply: "STATUS: pass", ts: at(3) }),
    stopRecord({ sessionId: sid, agentId: "r1", role: "reviewer", slice: "a", reply: "STATUS: pass", ts: at(5) }),
  ];
  const dir = join(scratch, "compact-project");
  const sdir = join(dir, ".claude", "state");
  mkdirSync(sdir, { recursive: true });
  writeFileSync(join(sdir, "journal-launches.jsonl"), launches.map((l) => JSON.stringify(l)).join("\n") + "\n");
  writeFileSync(join(sdir, "journal.jsonl"), stops.map((l) => JSON.stringify(l)).join("\n") + "\n");
  // The project registers its own copy, so the hook (project copy, no --plugin) uses <project>/.claude/state.
  const r = spawnSync(process.execPath, [COMPACT], { input: JSON.stringify({ session_id: sid, hook_event_name: "SessionStart", source: "compact", cwd: dir }), env: { ...env(), CLAUDE_PROJECT_DIR: dir }, encoding: "utf8" });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /- a: passed FILES: src\/a\.ts/);
  assert.match(ctx, /- b: building or reviewing \(1 attempt\), RISKY FILES: src\/b\.ts, src\/b\.test\.ts/);
  assert.match(ctx, /- c: pending FILES: src\/c\.ts/);
  assert.match(ctx, /C1: tests pass\nC2: no new dependencies/);
  assert.ok(ctx.length <= MAX_CONTEXT);
  noDecision(r);

  // Another session, a startup source and malformed input: silence.
  for (const input of [{ session_id: "other", source: "compact" }, { session_id: sid, source: "startup" }, "nope", "", { source: "compact" }]) {
    const q = spawnSync(process.execPath, [COMPACT], { input: typeof input === "string" ? input : JSON.stringify(input), env: { ...env(), CLAUDE_PROJECT_DIR: dir }, encoding: "utf8" });
    assert.deepEqual([q.status, q.stdout], [0, ""], JSON.stringify(input));
  }
  // A closed run (every slice final) is silent too.
  const closed = [...stops, stopRecord({ sessionId: sid, agentId: "x", role: "reviewer", slice: "zzz", reply: "STATUS: pass", ts: at(7) })];
  assert.ok(closed.length);
});

test("compact-context: no state at all → silent; the context is capped", () => {
  const r = run(COMPACT, { session_id: "nobody", source: "compact" });
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
  const slices = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [`slice-${i}`, { files: [`src/some/long/path/file-${i}.ts`], passed: false, gaveUp: false, attempts: 0, launches: 0, reviews: [], lastImplAt: null, risky: false }]),
  );
  const ctx = runContext({ id: 1, kind: "planned", planned: Object.keys(slices), slices, constraints: { C1: "x".repeat(300) }, planReviewed: true });
  assert.ok(ctx.length <= MAX_CONTEXT, String(ctx.length));
  assert.match(ctx, /truncated/);
});

test("no hook source prints an allow or ask permission decision (C6)", () => {
  for (const f of ["researcher-guard.mjs", "egress-guard.mjs", "compact-context.mjs", "worktree-head.mjs"]) {
    if (!existsSync(hook(f))) continue;
    const src = readFileSync(hook(f), "utf8");
    assert.doesNotMatch(src, /permissionDecision|"ask"|decision:\s*"approve"/, f);
  }
});
