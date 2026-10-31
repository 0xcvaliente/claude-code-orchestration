// Read router (plan-check.mjs, ORCH_READ_ROUTER=on) and quote check (quote-check.mjs), run as hooks in a throwaway
// project with the hooks copied from .claude/hooks. PDF fixtures: src/fixtures/files (make.sh rebuilds them).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    env: { ...base, CLAUDE_PROJECT_DIR: dir, ...env },
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
    for (const env of [{}, { ORCH_READ_ROUTER: "off" }, { ORCH_READ_ROUTER: "1" }]) {
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
    const unknown = out(launch(dir, { subagent_type: "researcher", prompt: "SOURCES: scanned.pdf\nQ" }, ON));
    assert.equal(unknown.updatedInput.model, "sonnet", "an unknown model counts as haiku");
    const log = logOf(dir, "reads-route.jsonl");
    assert.deepEqual(log.map((e) => e.model_source), ["call", "call", "call", "agent_file", "env", "unknown"]);
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
