// Read router (plan-check.mjs, ORCH_READ_ROUTER=on) and quote check (quote-check.mjs), run as hooks in a throwaway
// project with the hooks copied from .claude/hooks. PDF fixtures: src/fixtures/files (make.sh rebuilds them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fx = (/** @type {string} */ f) => join(root, "src", "fixtures", "files", f);
const hasPoppler = (() => {
  try {
    for (const t of ["pdfinfo", "pdftotext", "pdfimages"]) execFileSync(t, ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();
const POPPLER = hasPoppler ? false : "poppler is not installed: PDF routing tests skipped";
const HOOKS = ["state.mjs", "brief.mjs", "run.mjs", "plan-check.mjs", "file-profile.mjs", "quote-check.mjs"];
const ENV_KEYS = ["ORCH_READ_ROUTER", "ORCH_QUOTE_CHECK", "ORCH_READ_ROUTER_BUDGET_MS", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_PLUGIN_ROOT", "ORCH_ALLOW_BUILTINS"];

/** A project with the hooks, a haiku researcher agent file and the fixture files at its root. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), "router-"));
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  for (const h of HOOKS) copyFileSync(join(root, ".claude", "hooks", h), join(dir, ".claude", "hooks", h));
  writeFileSync(join(dir, ".claude", "agents", "researcher.md"), "---\nname: researcher\nmodel: haiku\n---\nbody\n");
  for (const f of ["plain.txt", "text.pdf", "table.pdf", "scanned.pdf", "long.pdf", "doc.docx"]) copyFileSync(fx(f), join(dir, f));
  return dir;
}
/** @param {string} dir @param {string} script @param {unknown} payload @param {Record<string, string>} [env] */
function run(dir, script, payload, env = {}) {
  const base = { ...process.env };
  for (const k of ENV_KEYS) delete base[k];
  return spawnSync(process.execPath, [join(dir, ".claude", "hooks", script)], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    env: { ...base, CLAUDE_PROJECT_DIR: dir, ORCH_SKILL_HINTS: "off", ...env }, // skill hints off: the exact assertions stay machine-independent
    encoding: "utf8",
  });
}
/** @param {string} dir @param {Record<string, unknown>} toolInput @param {Record<string, string>} [env] */
const launch = (dir, toolInput, env = {}) => run(dir, "plan-check.mjs", { session_id: "s1", tool_name: "Agent", tool_input: toolInput }, env);
const ON = { ORCH_READ_ROUTER: "on" };
/** @param {string} dir @param {string} name */
const logOf = (dir, name) => {
  const f = join(dir, ".claude", "state", name);
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
/** @param {{ stdout: string }} r */
const out = (r) => JSON.parse(r.stdout).hookSpecificOutput;

test("router off: identical output to before (no stdout, exit 0, no route log) for every agent type", () => {
  const dir = project();
  try {
    const brief = "SOURCES: scanned.pdf, table.pdf\nREAD: judge\nRISKY: yes\nWhat does it say?";
    for (const env of /** @type {Record<string, string>[]} */ ([{}, { ORCH_READ_ROUTER: "off" }, { ORCH_READ_ROUTER: "1" }])) {
      for (const type of ["researcher", "orchestration:researcher", "reviewer"]) {
        const r = launch(dir, { subagent_type: type, prompt: brief }, env);
        assert.equal(r.status, 0);
        assert.equal(r.stdout, "");
        assert.equal(r.stderr, "");
      }
    }
    assert.equal(logOf(dir, "reads-route.jsonl").length, 0);
    assert.equal(existsSync(join(dir, ".claude", "state", "read-cache")), false, "nothing profiled");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router on: text sources and briefs without SOURCES change nothing", () => {
  const dir = project();
  try {
    const txt = launch(dir, { subagent_type: "researcher", prompt: "SOURCES: plain.txt\nREAD: lookup\nFind the name." }, ON);
    assert.equal(txt.status, 0);
    assert.equal(txt.stdout, "");
    const none = launch(dir, { subagent_type: "researcher", prompt: "Find the name in the repo." }, ON);
    assert.equal(none.stdout, "");
    const log = logOf(dir, "reads-route.jsonl");
    assert.deepEqual(log.map((e) => e.decision), ["keep", "skip"]);
    assert.equal(log[0].tier, "haiku");
    assert.equal(log[0].raised, false);
    assert.equal(log[0].model, "haiku");
    assert.equal(log[0].model_source, "agent_file");
    assert.equal(log[1].reason, "no_sources");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router on: a scanned PDF raises the researcher to sonnet; a table PDF also gets the conversion note", { skip: POPPLER }, () => {
  const dir = project();
  try {
    const scan = launch(dir, { subagent_type: "researcher", prompt: "SOURCES: scanned.pdf\nREAD: extract\nRead the total.", description: "d" }, ON);
    assert.equal(scan.status, 0);
    const s = out(scan);
    assert.equal(s.hookEventName, "PreToolUse");
    assert.equal(s.permissionDecision, "allow");
    assert.equal(s.updatedInput.model, "sonnet");
    assert.equal(s.updatedInput.subagent_type, "researcher");
    assert.equal(s.updatedInput.description, "d", "other tool_input fields are kept");
    assert.equal(s.updatedInput.prompt, "SOURCES: scanned.pdf\nREAD: extract\nRead the total.", "a scan has no conversion, so no note");

    const table = out(launch(dir, { subagent_type: "orchestration:researcher", prompt: "SOURCES: table.pdf\nREAD: extract\nQ" }, ON));
    assert.equal(table.updatedInput.model, "sonnet");
    assert.match(table.updatedInput.prompt, /^SOURCES: table\.pdf\nREAD: extract\nQ\n\nConverted sources/);
    assert.match(table.updatedInput.prompt, new RegExp(`- ${join(dir, "table.pdf").replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} -> \\S+read-cache/[0-9a-f]+\\.txt; hard pages [^\\n]*: 2`));

    const textPdf = out(launch(dir, { subagent_type: "researcher", prompt: "SOURCES: text.pdf\nQ" }, ON));
    assert.equal(textPdf.updatedInput.model, undefined, "haiku is enough: the model is not set");
    assert.match(textPdf.updatedInput.prompt, /Converted sources[\s\S]*text\.pdf -> .*; no hard pages/);

    const log = logOf(dir, "reads-route.jsonl");
    assert.deepEqual(log.map((e) => [e.decision, e.tier, e.raised, e.to]), [["route", "sonnet", true, "sonnet"], ["route", "sonnet", true, "sonnet"], ["route", "haiku", false, null]]);
    assert.ok(log[0].reasons.includes("pdf_scanned"));
    assert.ok(log[1].reasons.includes("pdf_tables"));
    assert.equal(log[1].conversions, 1);
    assert.equal(log[1].hard_pages, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router on: a judge question over a long document goes to opus; RISKY goes to opus", { skip: POPPLER }, () => {
  const dir = project();
  try {
    const judge = out(launch(dir, { subagent_type: "researcher", prompt: "SOURCES: long.pdf\nREAD: judge\nDoes the argument hold?" }, ON));
    assert.equal(judge.updatedInput.model, "opus");
    assert.match(judge.updatedInput.prompt, /read all of it, do not split it by page/);
    const lookup = launch(dir, { subagent_type: "researcher", prompt: "SOURCES: long.pdf\nREAD: lookup\nQ" }, ON);
    assert.equal(out(lookup).updatedInput.model, undefined, "a lookup in a long text PDF stays on haiku");
    const risky = out(launch(dir, { subagent_type: "researcher", prompt: "SOURCES: plain.txt\nRISKY: yes\nQ" }, ON));
    assert.equal(risky.updatedInput.model, "opus");
    const log = logOf(dir, "reads-route.jsonl");
    assert.ok(log[0].reasons.includes("long_judge"));
    assert.ok(log[2].reasons.includes("risky"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router on: an explicit or configured model is never lowered; fable is never changed", { skip: POPPLER }, () => {
  const dir = project();
  try {
    const opus = launch(dir, { subagent_type: "researcher", prompt: "SOURCES: scanned.pdf\nQ", model: "opus" }, ON);
    assert.equal(opus.stdout, "", "opus outranks sonnet and a scan has no note: nothing to change");
    const opusTable = out(launch(dir, { subagent_type: "researcher", prompt: "SOURCES: table.pdf\nQ", model: "opus" }, ON));
    assert.equal(opusTable.updatedInput.model, "opus", "only the note is added; the model stays opus");
    const fable = launch(dir, { subagent_type: "researcher", prompt: "SOURCES: long.pdf\nREAD: judge\nQ", model: "fable" }, ON);
    assert.equal(out(fable).updatedInput.model, "fable");
    writeFileSync(join(dir, ".claude", "agents", "researcher.md"), "---\nname: researcher\nmodel: claude-opus-5-5\n---\n");
    assert.equal(launch(dir, { subagent_type: "researcher", prompt: "SOURCES: scanned.pdf\nQ" }, ON).stdout, "", "agent file opus is kept");
    writeFileSync(join(dir, ".claude", "agents", "researcher.md"), "---\nname: researcher\n---\n");
    const viaEnv = launch(dir, { subagent_type: "researcher", prompt: "SOURCES: scanned.pdf\nQ" }, { ...ON, CLAUDE_CODE_SUBAGENT_MODEL: "sonnet" });
    assert.equal(viaEnv.stdout, "", "CLAUDE_CODE_SUBAGENT_MODEL sonnet is enough for a scan");
    const none = launch(dir, { subagent_type: "researcher", prompt: "SOURCES: scanned.pdf\nQ" }, ON);
    assert.equal(none.stdout, "", "no model anywhere: the agent may run on the parent's model, so no routing");
    writeFileSync(join(dir, ".claude", "agents", "researcher.md"), "---\nname: researcher\nmodel: inherit\n---\n");
    assert.equal(launch(dir, { subagent_type: "researcher", prompt: "SOURCES: long.pdf\nREAD: judge\nQ" }, ON).stdout, "", "inherit is never routed");
    assert.equal(launch(dir, { subagent_type: "researcher", prompt: "SOURCES: table.pdf\nREAD: judge\nQ" }, ON).stdout, "", "inherit: no note either");
    for (const model of ["mystery-model", "us.anthropic.claude-opus-x", "haikuish"]) {
      assert.equal(launch(dir, { subagent_type: "researcher", prompt: "SOURCES: scanned.pdf\nQ", model }, ON).stdout, "", `unrankable ${model}`);
    }
    assert.equal(launch(dir, { subagent_type: "researcher", prompt: "SOURCES: scanned.pdf\nQ", model: "claude-opus-5-5" }, ON).stdout, "", "a full opus id is opus");
    assert.equal(out(launch(dir, { subagent_type: "researcher", prompt: "SOURCES: scanned.pdf\nQ", model: "claude-haiku-5-5" }, ON)).updatedInput.model, "sonnet", "a full haiku id is haiku");
    assert.equal(launch(dir, { subagent_type: "researcher", prompt: "SOURCES: scanned.pdf\nQ", model: "claude-sonnet-5-5" }, ON).stdout, "", "a full sonnet id is enough for a scan");
    const log = logOf(dir, "reads-route.jsonl");
    assert.deepEqual(log.map((e) => e.model_source), ["call", "call", "call", "agent_file", "env", "unknown", "agent_file", "agent_file", "call", "call", "call", "call", "call", "call"]);
    assert.deepEqual(log.map((e) => e.reason ?? e.decision), ["keep", "route", "route", "keep", "keep", "model_unranked", "model_unranked", "model_unranked", "model_unranked", "model_unranked", "model_unranked", "keep", "route", "keep"]);
    assert.ok(log.every((e) => e.to !== "haiku"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router on: built-ins, fork, other plugins' researchers and non-researchers are untouched", { skip: POPPLER }, () => {
  const dir = project();
  try {
    const brief = "SOURCES: scanned.pdf\nREAD: judge\nQ";
    for (const type of ["general-purpose", "Explore", "fork", "", "other:researcher", "reviewer", "orchestration:reviewer", "integrator"]) {
      const r = launch(dir, { subagent_type: type, prompt: brief }, { ...ON, ORCH_ALLOW_BUILTINS: "1" });
      assert.equal(r.status, 0, type);
      assert.equal(r.stdout, "", `no allow for ${type || "(none)"}`);
    }
    const impl = launch(dir, { subagent_type: "implementer", prompt: `SLICE: a\nFILES: x.py\nDEPENDS: none\nPATH: light\n${brief}` }, ON);
    assert.equal(impl.status, 0);
    assert.equal(impl.stdout, "", "implementers go through the plan check, never the router");
    const wf = launch(dir, { subagent_type: "researcher", prompt: `ORCHESTRATION: workflow\n${brief}` }, ON);
    assert.equal(wf.stdout, "");
    assert.equal(logOf(dir, "reads-route.jsonl").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router on: a plan-check block still blocks, with no allow", { skip: POPPLER }, () => {
  const dir = project();
  try {
    // An open run (a PLAN REVIEW launch) makes a built-in launch block; the router never sees it.
    mkdirSync(join(dir, ".claude", "state"), { recursive: true });
    writeFileSync(join(dir, ".claude", "state", "journal-launches.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), session_id: "s1", agent_id: "p1", agent_type: "reviewer", slice: "plan", isPlanReview: true, replan: null, plan: { constraints: {}, slices: [{ slice: "a", files: ["x.py"], depends: [] }] } })}\n`);
    const r = launch(dir, { subagent_type: "general-purpose", prompt: "SOURCES: scanned.pdf\nQ" }, ON);
    assert.equal(r.status, 2);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /built-in/);
    const impl = launch(dir, { subagent_type: "implementer", prompt: "Goal only\nSOURCES: scanned.pdf" }, ON);
    assert.equal(impl.status, 2, "missing_lines still blocks");
    assert.equal(impl.stdout, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router on: a profiler error or timeout skips routing", () => {
  const dir = project();
  try {
    const profiler = join(dir, ".claude", "hooks", "file-profile.mjs");
    writeFileSync(profiler, "export function profileSources() { throw new Error('boom'); }\n");
    const err = launch(dir, { subagent_type: "researcher", prompt: "SOURCES: scanned.pdf\nREAD: judge\nQ" }, ON);
    assert.equal(err.status, 0);
    assert.equal(err.stdout, "");
    writeFileSync(profiler, "export function profileSources() { return { tier: 'galaxy', files: [] }; }\n");
    assert.equal(launch(dir, { subagent_type: "researcher", prompt: "SOURCES: scanned.pdf\nQ" }, ON).stdout, "", "a malformed profile is an error");
    writeFileSync(profiler, "export function profileSources() { const end = Date.now() + 5000; while (Date.now() < end); return { tier: 'opus', reasons: [], files: [{ tier: 'opus' }] }; }\n");
    const started = Date.now();
    const slow = launch(dir, { subagent_type: "researcher", prompt: "SOURCES: scanned.pdf\nQ" }, { ...ON, ORCH_READ_ROUTER_BUDGET_MS: "300" });
    assert.equal(slow.status, 0);
    assert.equal(slow.stdout, "");
    assert.ok(Date.now() - started < 4000, "the budget cut the profiler off");
    rmSync(profiler);
    assert.equal(launch(dir, { subagent_type: "researcher", prompt: "SOURCES: scanned.pdf\nQ" }, ON).stdout, "", "a missing profiler is an error");
    assert.deepEqual(logOf(dir, "reads-route.jsonl").map((e) => e.reason), ["profiler_error", "profiler_error", "profiler_timeout", "profiler_error"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router on: malformed input exits 0 with no output", () => {
  const dir = project();
  try {
    for (const p of ["not json", "null", "[]", JSON.stringify({ tool_input: "x" }), JSON.stringify({ tool_input: { subagent_type: "researcher", prompt: 5 } })]) {
      const r = run(dir, "plan-check.mjs", p, ON);
      assert.equal(r.status, 0);
      assert.equal(r.stdout, "");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("router logs hold parsed fields only: no brief, prompt or file text", { skip: POPPLER }, () => {
  const dir = project();
  try {
    const secret = "ZEBRA-SECRET-QUESTION";
    launch(dir, { subagent_type: "researcher", prompt: `SOURCES: table.pdf, plain.txt, https://example.com/a.pdf\nREAD: judge\n${secret}` }, ON);
    const raw = readFileSync(join(dir, ".claude", "state", "reads-route.jsonl"), "utf8");
    assert.ok(!raw.includes(secret));
    assert.ok(!raw.includes("SOURCES"));
    const fileText = readFileSync(fx("plain.txt"), "utf8").trim().split("\n")[0]?.slice(0, 30) ?? "";
    if (fileText) assert.ok(!raw.includes(fileText), "no file text");
    const pdfText = execFileSync("pdftotext", [fx("table.pdf"), "-"], { encoding: "utf8" }).trim().split("\n")[0]?.slice(0, 30) ?? "";
    if (pdfText) assert.ok(!raw.includes(pdfText), "no PDF text");
    const [e] = JSON.parse(`[${raw.trim().split("\n").join(",")}]`);
    assert.deepEqual(Object.keys(e).sort(), ["agent_type", "conversions", "decision", "files", "hard_pages", "model", "model_source", "paths", "raised", "reasons", "session_id", "tier", "to", "ts"].sort());
    assert.deepEqual(e.paths, [join(dir, "table.pdf"), join(dir, "plain.txt"), "example.com"]);
    assert.ok(e.reasons.every((/** @type {string} */ c) => /^[a-z_]+$/.test(c)), `short codes: ${e.reasons}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- quote-check.mjs ----

/** A researcher transcript: the brief, then the final report (as text, or as a SubagentHandback message). */
function transcript(/** @type {string} */ dir, /** @type {string} */ report, handback = false) {
  const f = join(dir, `t-${Math.random().toString(36).slice(2)}.jsonl`);
  const last = handback ? { type: "tool_use", name: "SubagentHandback", input: { message: report } } : { type: "text", text: report };
  const lines = [
    { type: "user", message: { content: "SOURCES: notes.md\nQ" } },
    { type: "assistant", message: { content: [{ type: "text", text: "QUOTE: notes.md:1 | not the final report" }] } },
    { type: "assistant", message: { content: handback ? [{ type: "text", text: "Here it is." }, last] : [last] } },
  ];
  writeFileSync(f, lines.map((l) => JSON.stringify(l)).join("\n"));
  return f;
}
/** @param {string} dir @param {string} report @param {{ agent?: string, type?: string, env?: Record<string, string>, handback?: boolean, last?: string }} [o] */
function stop(dir, report, o = {}) {
  return run(
    dir,
    "quote-check.mjs",
    {
      session_id: "s1",
      hook_event_name: "SubagentStop",
      agent_id: o.agent ?? "r1",
      agent_type: o.type ?? "researcher",
      agent_transcript_path: report === "" ? join(dir, "missing.jsonl") : transcript(dir, report, o.handback),
      ...(o.last !== undefined ? { last_assistant_message: o.last } : {}),
    },
    o.env ?? {},
  );
}
/** @param {string} dir */
function notes(dir) {
  writeFileSync(join(dir, "notes.md"), "# Notes\n\nThe parser **never throws** on bad input.\nIt returns  empty\nfields instead.\n\nThe cache is keyed by path, size and mtime.\n");
}

test("quote check: verified quotes in text, markdown, PDF and docx sources pass and are counted", { skip: POPPLER }, () => {
  const dir = project();
  try {
    notes(dir);
    mkdirSync(join(dir, ".claude", "state"), { recursive: true });
    writeFileSync(join(dir, ".claude", "state", "journal-launches.jsonl"), `${JSON.stringify({ ts: "t", session_id: "s1", agent_id: "r1", agent_type: "researcher", slice: "facts" })}\n`);
    const report = [
      "STATUS: pass",
      "QUOTE: notes.md:3 | \"The parser never throws on bad input.\"",
      "- QUOTE: `notes.md:4-5` | it returns empty fields INSTEAD",
      `QUOTE: ${join(dir, "notes.md")}#L7 | The cache is keyed by path ... and mtime.`,
      "QUOTE: text.pdf p.1 | supplier survey regional in while flat board extend to sites",
      "QUOTE: doc.docx | Output rose in every quarter & costs stayed flat.",
      "QUOTE: table.pdf, p. 2 | quarter stayed the to pilot",
      "OPEN: none",
    ].join("\n");
    const r = stop(dir, report);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, "");
    const [e] = logOf(dir, "quotes.jsonl");
    assert.deepEqual({ agent_id: e.agent_id, slice: e.slice, total: e.total, verified: e.verified, unverified: e.unverified, unverifiable: e.unverifiable, blocked: e.blocked }, { agent_id: "r1", slice: "facts", total: 6, verified: 6, unverified: 0, unverifiable: 0, blocked: false });
    // The PDF and docx conversions land in the read router's cache.
    assert.ok(existsSync(join(dir, ".claude", "state", "read-cache")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quote check: an unverified quote blocks the researcher once, then the next stop passes", { skip: POPPLER }, () => {
  const dir = project();
  try {
    notes(dir);
    const report = "STATUS: pass\nQUOTE: notes.md:3 | The parser always throws.\nQUOTE: text.pdf p.2 | the moon is made of cheese\nQUOTE: notes.md:7 | keyed by path, size and mtime\nOPEN: none";
    const first = stop(dir, report, { handback: true });
    assert.equal(first.status, 2);
    assert.match(first.stderr, /2 of your QUOTE lines were not found/);
    assert.match(first.stderr, /- notes\.md:3\n- text\.pdf p\.2\n/);
    assert.match(first.stderr, /drop that QUOTE and list its claim under OPEN/);
    const second = stop(dir, report, { handback: true });
    assert.equal(second.status, 0, "the second stop always passes");
    assert.equal(stop(dir, report, { agent: "r2" }).status, 2, "another researcher is blocked on its own first stop");
    const log = logOf(dir, "quotes.jsonl");
    assert.deepEqual(log.map((e) => [e.agent_id, e.verified, e.unverified, e.blocked]), [["r1", 1, 2, true], ["r1", 1, 2, false], ["r2", 1, 2, true]]);
    assert.deepEqual(log[0].unverified_paths, [join(dir, "notes.md"), join(dir, "text.pdf")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quote check: URLs, scans, images, missing and unreadable files are unverifiable and never block", { skip: POPPLER }, () => {
  const dir = project();
  try {
    copyFileSync(fx("chart.png"), join(dir, "chart.png"));
    const report = [
      "STATUS: pass",
      "QUOTE: https://example.com/spec.html | anything at all",
      "QUOTE: scanned.pdf p.1 | Total revenue 42",
      "QUOTE: chart.png | Q3 peak",
      "QUOTE: nowhere/missing.md:4 | invented",
      "QUOTE: .claude | a directory",
    ].join("\n");
    const r = stop(dir, report);
    assert.equal(r.status, 0);
    const [e] = logOf(dir, "quotes.jsonl");
    assert.deepEqual([e.total, e.verified, e.unverified, e.unverifiable, e.blocked], [5, 0, 0, 5, false]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quote check: locators outside the project dir, also through a symlink, are unverifiable and never read", () => {
  const dir = project();
  const outside = mkdtempSync(join(tmpdir(), "router-outside-"));
  try {
    notes(dir);
    writeFileSync(join(outside, "secret.txt"), "the vault code is 1234\n");
    symlinkSync(join(outside, "secret.txt"), join(dir, "link.txt"));
    symlinkSync(outside, join(dir, "linkdir"));
    const rel = relative(dir, join(outside, "secret.txt"));
    const report = [
      "STATUS: pass",
      `QUOTE: ${rel} p.1 | the vault code is 1234`,
      `QUOTE: ${join(outside, "secret.txt")} | the vault code is 9999`,
      "QUOTE: link.txt:1 | the vault code is 1234",
      "QUOTE: linkdir/secret.txt:1 | not the code",
      "QUOTE: ../../../../../../etc/passwd p.1 | root",
      "QUOTE: /etc/hosts | localhost",
      "QUOTE: notes.md:3 | the parser never throws",
    ].join("\n");
    const r = stop(dir, report);
    assert.equal(r.status, 0, "nothing outside the project can be unverified, so nothing blocks");
    const [e] = logOf(dir, "quotes.jsonl");
    assert.deepEqual([e.total, e.verified, e.unverified, e.unverifiable], [7, 1, 0, 6]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("quote check: off switch, other agents, no quotes and malformed input", () => {
  const dir = project();
  try {
    notes(dir);
    const bad = "STATUS: pass\nQUOTE: notes.md:1 | not in the file";
    const off = stop(dir, bad, { env: { ORCH_QUOTE_CHECK: "off" } });
    assert.equal(off.status, 0);
    assert.equal(off.stderr, "");
    assert.equal(stop(dir, bad, { type: "reviewer" }).status, 0, "only researchers are checked");
    assert.equal(stop(dir, bad, { type: "orchestration:researcher", agent: "p1" }).status, 2, "the plugin's researcher is checked");
    assert.equal(stop(dir, "", { agent: "r9", last: "STATUS: pass\nQUOTE: notes.md | never in it" }).status, 2, "last_assistant_message when the transcript is missing");
    assert.equal(stop(dir, "STATUS: pass\nOPEN: none", { agent: "r3" }).status, 0);
    for (const p of ["not json", "null", "[]", "42", JSON.stringify({ agent_type: "researcher", agent_transcript_path: 5, last_assistant_message: 7 })]) {
      assert.equal(run(dir, "quote-check.mjs", p).status, 0, p);
    }
    const log = logOf(dir, "quotes.jsonl");
    assert.deepEqual(log.map((e) => [e.agent_id, e.total]), [["p1", 1], ["r9", 1], ["r3", 0], [null, 0]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("quote check: the log holds counts and paths only, never quote, reply or file text", () => {
  const dir = project();
  try {
    notes(dir);
    stop(dir, "STATUS: pass\nQUOTE: notes.md:3 | ZEBRA invented sentence\nQUOTE: notes.md:3 | the parser never throws\nOPEN: GIRAFFE");
    const raw = readFileSync(join(dir, ".claude", "state", "quotes.jsonl"), "utf8");
    for (const s of ["ZEBRA", "GIRAFFE", "never throws", "STATUS", "QUOTE", "notes.md:3"]) assert.ok(!raw.includes(s), s);
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ["agent_id", "blocked", "session_id", "slice", "total", "ts", "unverifiable", "unverified", "unverified_paths", "verified"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
