// Telemetry v2 (slice b-telemetry): tokens, turns, models and max_turns_hit at SubagentStop (telemetry.mjs),
// files_touched for implementer stops (journal.mjs), the read logger (read-log.mjs) and the report's new sections.
// The hooks run as processes on synthetic transcripts that mimic Claude Code's layout (one line per content block,
// usage repeated on each, api-request and attachment lines in between); no real transcript text is used.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SECRET = "SECRET-CONTENT-7f3a"; // planted in transcripts and files; must never reach a log record

function project() {
  const dir = mkdtempSync(join(tmpdir(), "telemetry-v2-"));
  const hooks = join(dir, ".claude", "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of ["state.mjs", "brief.mjs", "run.mjs", "telemetry.mjs", "journal.mjs", "read-log.mjs"]) copyFileSync(join(root, ".claude", "hooks", h), join(hooks, h));
  return dir;
}
/** @param {string} dir @param {string} script @param {unknown} payload @param {string[]} [args] */
const run = (dir, script, payload, args = [], env = {}) =>
  spawnSync("node", [join(dir, ".claude", "hooks", script), ...args], { input: typeof payload === "string" ? payload : JSON.stringify(payload), env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_PLUGIN_ROOT: "", ...env }, encoding: "utf8" });
/** @param {string} dir @param {string} name @returns {any[]} */
const log = (dir, name) => {
  try {
    return readFileSync(join(dir, ".claude", "state", name), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
/** @param {string} dir @param {string} name @param {unknown[]} entries */
const transcript = (dir, name, entries) => {
  const path = join(dir, name);
  writeFileSync(path, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return path;
};

const usage = (/** @type {number} */ i, /** @type {number} */ o, cr = 0, cw = 0) => ({ input_tokens: i, output_tokens: o, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, server_tool_use: { web_search_requests: 0 } });
/** One assistant message written as one line per content block, each repeating the usage. */
const assistant = (/** @type {string} */ id, /** @type {any[]} */ blocks, /** @type {any} */ u, model = "claude-sonnet-x", stop = "tool_use", extra = {}) =>
  blocks.map((b) => ({ type: "assistant", uuid: `${id}-${b.type}`, ...extra, message: { id, model, role: "assistant", stop_reason: stop, content: [b], usage: u } }));
const toolUse = (/** @type {string} */ id, name = "Bash", input = {}) => ({ type: "tool_use", id, name, input });
const result = (/** @type {string} */ id, extra = {}, isError = false) => ({ type: "user", ...extra, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: SECRET, is_error: isError }] } });
const brief = (text = `SLICE: s1\nFILES: a.txt\nDEPENDS: none\n${SECRET}`) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const noise = [{ type: "api-request", id: "r", params: SECRET }, { type: "attachment", attachment: { type: "date", date: "2026-10-31" } }];

const stop = (/** @type {string} */ path, type = "orchestration:reviewer", extra = {}) => ({ hook_event_name: "SubagentStop", session_id: "s1", agent_id: "ag1", agent_type: type, last_assistant_message: "", agent_transcript_path: path, ...extra });

test("telemetry 1.2.0: one-hour cache writes and mid-run cache rewrites are counted", () => {
  const dir = project();
  try {
    const oneHour = (/** @type {number} */ cw, /** @type {number} */ h) => ({ ...usage(1, 10, 0, cw), cache_creation: { ephemeral_5m_input_tokens: cw - h, ephemeral_1h_input_tokens: h } });
    const path = transcript(dir, "t.jsonl", [
      brief(),
      // The first request always writes its context: never a rewrite.
      ...assistant("m1", [toolUse("t1")], oneHour(60000, 60000)),
      result("t1"),
      // Warm: mostly read.
      ...assistant("m2", [toolUse("t2")], usage(1, 10, 60000, 900)),
      result("t2"),
      // Cold in mid-run: the whole context written again, almost nothing read.
      ...assistant("m3", [toolUse("t3")], usage(1, 10, 2000, 61000)),
      result("t3"),
      // A large write next to a larger read is ordinary growth, not a rewrite; a small cold write is below the floor.
      ...assistant("m4", [toolUse("t4")], usage(1, 10, 121000, 25000)),
      result("t4"),
      ...assistant("m5", [{ type: "text", text: "STATUS: pass" }], usage(1, 10, 0, 19999), "claude-sonnet-x", "end_turn"),
    ]);
    assert.equal(run(dir, "telemetry.mjs", stop(path)).status, 0);
    const [rec] = log(dir, "telemetry.jsonl");
    assert.equal(rec.tokens.cache_write, 60000 + 900 + 61000 + 25000 + 19999);
    assert.equal(rec.tokens.cache_write_1h, 60000);
    assert.deepEqual(rec.cache_rewrites, { requests: 1, tokens: 61000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("telemetry: tokens deduped by message id, turns, models and a normal SubagentHandback finish", () => {
  const dir = project();
  try {
    const path = transcript(dir, "t.jsonl", [
      brief(),
      ...noise,
      ...assistant("m1", [{ type: "thinking", thinking: SECRET }, toolUse("t1")], usage(10, 100, 1000, 50)),
      result("t1"),
      ...noise,
      ...assistant("m2", [{ type: "text", text: SECRET }, toolUse("t2")], usage(2, 20, 2000, 0), "claude-opus-x"),
      result("t2"),
      ...assistant("syn", [{ type: "text", text: "API error" }], usage(999, 999), "<synthetic>", "end_turn"),
      ...assistant("m3", [toolUse("t3", "SubagentHandback", { message: `STATUS: pass\n${SECRET}` })], usage(1, 5, 3000, 7), "claude-opus-x"),
      result("t3", { toolEndsTurn: true }),
    ]);
    assert.equal(run(dir, "telemetry.mjs", stop(path)).status, 0);
    const [rec] = log(dir, "telemetry.jsonl");
    assert.deepEqual(rec.tokens, { input: 13, output: 125, cache_read: 6000, cache_write: 57, cache_write_1h: 0 });
    assert.deepEqual(rec.cache_rewrites, { requests: 0, tokens: 0 });
    assert.equal(rec.turns, 3);
    assert.deepEqual(rec.models.sort(), ["claude-opus-x", "claude-sonnet-x"]);
    assert.equal(rec.max_turns_hit, false);
    assert.equal(rec.status, "pass");
    assert.ok(!JSON.stringify(rec).includes(SECRET), "no transcript text in the record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("telemetry: max_turns_hit true at a maxTurns stop, false at end_turn, null when it cannot tell", () => {
  const dir = project();
  try {
    // maxTurns: the last turn called a tool, its result came back, and no assistant message follows.
    const hit = transcript(dir, "hit.jsonl", [brief(), ...assistant("m1", [toolUse("t1")], usage(1, 1)), result("t1"), ...noise, ...assistant("m2", [toolUse("t2")], usage(1, 1)), result("t2"), ...noise]);
    const done = transcript(dir, "done.jsonl", [brief(), ...assistant("m1", [toolUse("t1")], usage(1, 1)), result("t1"), ...assistant("m2", [{ type: "text", text: "STATUS: pass" }], usage(1, 1), "claude-sonnet-x", "end_turn"), ...noise]);
    const userLast = transcript(dir, "user.jsonl", [brief(), ...assistant("m1", [toolUse("t1")], usage(1, 1)), result("t1"), brief("The coordinator sent a message")]);
    const empty = transcript(dir, "empty.jsonl", [brief()]);
    for (const p of [hit, done, userLast, empty]) assert.equal(run(dir, "telemetry.mjs", stop(p)).status, 0);
    assert.deepEqual(log(dir, "telemetry.jsonl").map((r) => r.max_turns_hit), [true, false, null, null]);
    assert.deepEqual(log(dir, "telemetry.jsonl").map((r) => r.turns), [2, 2, 1, 0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("telemetry: with the role's maxTurns known, a tool_result ending is a hit only at the limit (else a killed agent: null)", () => {
  const dir = project();
  const plugin = mkdtempSync(join(tmpdir(), "telemetry-v2-plugin-"));
  try {
    const agentFile = (/** @type {string} */ d, /** @type {string} */ role, /** @type {number} */ n) => {
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, `${role}.md`), `---\nname: ${role}\nmodel: sonnet\nmaxTurns: ${n}\n---\n\nBody mentioning maxTurns: 99\n`);
    };
    agentFile(join(dir, ".claude", "agents"), "reviewer", 2);
    agentFile(join(dir, ".claude", "agents"), "implementer", 3);
    agentFile(join(plugin, "agents"), "researcher", 2);
    agentFile(join(plugin, "agents"), "implementer", 2); // the project's file wins
    const twoTurns = transcript(dir, "two.jsonl", [brief(), ...assistant("m1", [toolUse("t1")], usage(1, 1)), result("t1"), ...assistant("m2", [toolUse("t2")], usage(1, 1)), result("t2")]);
    const env = { CLAUDE_PLUGIN_ROOT: plugin };
    assert.equal(run(dir, "telemetry.mjs", stop(twoTurns, "orchestration:reviewer"), [], env).status, 0); // 2 >= 2: hit
    assert.equal(run(dir, "telemetry.mjs", stop(twoTurns, "orchestration:implementer"), [], env).status, 0); // 2 < 3: killed
    assert.equal(run(dir, "telemetry.mjs", stop(twoTurns, "orchestration:researcher"), [], env).status, 0); // plugin root: 2 >= 2
    assert.equal(run(dir, "telemetry.mjs", stop(twoTurns, "orchestration:integrator"), [], env).status, 0); // no agent file: heuristic
    assert.deepEqual(log(dir, "telemetry.jsonl").map((r) => r.max_turns_hit), [true, null, true, true]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(plugin, { recursive: true, force: true });
  }
});

test("telemetry: each usage field is the maximum over a message's lines, so a partial early line cannot undercount", () => {
  const dir = project();
  try {
    const path = transcript(dir, "partial.jsonl", [
      brief(),
      ...assistant("m1", [{ type: "thinking", thinking: "" }], usage(3, 1, 0, 0)),
      ...assistant("m1", [toolUse("t1")], usage(3, 40, 500, 20)),
      ...assistant("m1", [{ type: "text", text: "" }], usage(2, 10, 500, 0)),
      result("t1"),
      ...assistant("m2", [{ type: "text", text: "STATUS: pass" }], usage(1, 5, 100, 1), "claude-sonnet-x", "end_turn"),
    ]);
    assert.equal(run(dir, "telemetry.mjs", stop(path)).status, 0);
    const [rec] = log(dir, "telemetry.jsonl");
    assert.deepEqual(rec.tokens, { input: 4, output: 45, cache_read: 600, cache_write: 21, cache_write_1h: 0 });
    assert.equal(rec.turns, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("telemetry: a missing transcript and non-stop events leave the new fields out; malformed input exits 0", () => {
  const dir = project();
  try {
    assert.equal(run(dir, "telemetry.mjs", stop(join(dir, "missing.jsonl"))).status, 0);
    assert.equal(run(dir, "telemetry.mjs", { hook_event_name: "SubagentStart", session_id: "s1", agent_type: "reviewer" }).status, 0);
    for (const rec of log(dir, "telemetry.jsonl")) for (const k of ["tokens", "turns", "models", "max_turns_hit"]) assert.ok(!(k in rec), k);
    assert.equal(run(dir, "telemetry.mjs", "not json{").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** @param {string} cwd @param {string[]} args */
const git = (cwd, args) =>
  execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } });

test("journal: files_touched from tool calls in the shared tree, tools+git in an isolated worktree", () => {
  const dir = project();
  try {
    writeFileSync(join(dir, ".gitignore"), ".claude/\n");
    writeFileSync(join(dir, "base.txt"), "base\n");
    git(dir, ["init", "-q", "-b", "main"]);
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "base"]);

    // Shared tree: Edit, Write and NotebookEdit calls that succeeded; an errored Edit and a Read do not count.
    const shared = transcript(dir, "shared.jsonl", [
      brief(),
      ...assistant("m1", [toolUse("e1", "Edit", { file_path: join(dir, "src", "a.ts"), old_string: SECRET, new_string: SECRET })], usage(1, 1)),
      result("e1", { cwd: dir }),
      ...assistant("m2", [toolUse("w1", "Write", { file_path: "docs/b.md", content: SECRET })], usage(1, 1)),
      result("w1"),
      ...assistant("m3", [toolUse("n1", "NotebookEdit", { notebook_path: join(dir, "nb.ipynb"), new_source: SECRET })], usage(1, 1)),
      result("n1"),
      ...assistant("m4", [toolUse("e2", "Edit", { file_path: join(dir, "failed.ts") })], usage(1, 1)),
      result("e2", {}, true),
      ...assistant("m5", [toolUse("r1", "Read", { file_path: join(dir, "read.ts") })], usage(1, 1)),
      result("r1"),
    ]);
    assert.equal(run(dir, "journal.mjs", stop(shared, "orchestration:implementer", { cwd: dir })).status, 0);

    // Isolated worktree: a commit, an uncommitted edit and an untracked file since the fork point.
    const wt = join(dir, ".claude", "worktrees", "agent-x");
    git(dir, ["worktree", "add", "-q", "-b", "wt", wt]);
    writeFileSync(join(wt, "committed.txt"), "c\n");
    git(wt, ["add", "-A"]);
    git(wt, ["commit", "-qm", "c"]);
    writeFileSync(join(wt, "base.txt"), "changed\n");
    writeFileSync(join(wt, "untracked.txt"), "u\n");
    writeFileSync(join(dir, "main-only.txt"), "m\n");
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-qm", "main moves on"]); // a later main commit is not the worktree's change
    const iso = transcript(dir, "iso.jsonl", [
      { ...brief(), cwd: wt },
      ...assistant("m1", [toolUse("e1", "Edit", { file_path: join(wt, "src", "edited.ts") })], usage(1, 1), "claude-sonnet-x", "tool_use", { cwd: wt }),
      result("e1", { cwd: wt }),
    ]);
    assert.equal(run(dir, "journal.mjs", stop(iso, "orchestration:implementer", { agent_id: "ag2", cwd: dir })).status, 0);

    // A reviewer stop gets no files fields; malformed input exits 0.
    assert.equal(run(dir, "journal.mjs", stop(shared, "orchestration:reviewer", { agent_id: "ag3" })).status, 0);
    assert.equal(run(dir, "journal.mjs", "not json{").status, 0);
    // No readable transcript: the shared tree cannot tell (fields left out, not an empty list); a worktree uses git alone.
    assert.equal(run(dir, "journal.mjs", stop(join(dir, "missing.jsonl"), "orchestration:implementer", { agent_id: "ag4", cwd: dir })).status, 0);
    assert.equal(run(dir, "journal.mjs", stop(join(dir, "missing.jsonl"), "orchestration:implementer", { agent_id: "ag5", cwd: wt })).status, 0);

    const recs = [...log(dir, "journal.jsonl"), ...log(dir, "journal-pending.jsonl")];
    const by = (/** @type {string} */ id) => recs.find((r) => r.agent_id === id);
    assert.deepEqual(by("ag1").files_touched.sort(), ["docs/b.md", "nb.ipynb", "src/a.ts"]);
    assert.equal(by("ag1").files_source, "tools");
    assert.deepEqual(by("ag2").files_touched, ["base.txt", "committed.txt", "src/edited.ts", "untracked.txt"]);
    assert.ok(by("ag4") && !("files_touched" in by("ag4")) && !("files_source" in by("ag4")), "unknown tool paths in the shared tree");
    assert.deepEqual(by("ag5").files_touched, ["base.txt", "committed.txt", "untracked.txt"]);
    assert.equal(by("ag5").files_source, "git");
    assert.equal(by("ag2").files_source, "tools+git");
    assert.ok(!("files_touched" in by("ag3")) && !("files_source" in by("ag3")));
    assert.ok(!JSON.stringify(recs).includes(SECRET), "no brief, reply or file text in journal records");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-log: Read records path, ext, bytes, pages and kind; WebFetch records the host only; never content", () => {
  const dir = project();
  try {
    const files = { "a.md": "text", "b.ts": "code", "c.pdf": "pdf", "d.PNG": "image", "e.ipynb": "notebook", "f.docx": "office", "g.bin": "other" };
    for (const f of Object.keys(files)) writeFileSync(join(dir, f), SECRET);
    const read = (/** @type {Record<string, unknown>} */ input, extra = {}) => run(dir, "read-log.mjs", { hook_event_name: "PostToolUse", session_id: "s1", agent_id: "ag1", agent_type: "orchestration:researcher", tool_name: "Read", tool_input: input, tool_response: { file: { content: SECRET } }, ...extra });
    for (const f of Object.keys(files)) assert.equal(read({ file_path: join(dir, f), ...(f === "c.pdf" ? { pages: "1-5" } : {}) }).status, 0);
    assert.equal(read({ file_path: "/nowhere/outside.py" }, { agent_id: undefined, agent_type: undefined }).status, 0);
    assert.equal(run(dir, "read-log.mjs", { session_id: "s1", tool_name: "WebFetch", tool_input: { url: `https://docs.example.com/p/${SECRET}?q=${SECRET}`, prompt: SECRET }, tool_response: SECRET }).status, 0);
    assert.equal(run(dir, "read-log.mjs", { session_id: "s1", tool_name: "Bash", tool_input: { command: "ls" } }).status, 0);
    assert.equal(run(dir, "read-log.mjs", "not json{").status, 0, "malformed input exits 0");
    assert.equal(run(dir, "read-log.mjs", { tool_name: "Read", tool_input: null }).status, 0);

    const recs = log(dir, "reads.jsonl");
    assert.equal(recs.length, 9);
    assert.deepEqual(recs.slice(0, 7).map((r) => r.kind), Object.values(files));
    assert.deepEqual(recs.slice(0, 7).map((r) => r.path), Object.keys(files));
    const pdf = recs[2];
    assert.deepEqual({ tool: pdf.tool, ext: pdf.ext, bytes: pdf.bytes, pages: pdf.pages, agent_id: pdf.agent_id, agent_type: pdf.agent_type }, { tool: "Read", ext: "pdf", bytes: SECRET.length, pages: "1-5", agent_id: "ag1", agent_type: "researcher" });
    assert.equal(recs[3].ext, "png");
    assert.equal(recs[0].pages, null);
    assert.deepEqual({ path: recs[7].path, bytes: recs[7].bytes, kind: recs[7].kind, agent_id: recs[7].agent_id }, { path: "/nowhere/outside.py", bytes: null, kind: "code", agent_id: null });
    assert.deepEqual(Object.keys(recs[8]).sort(), ["agent_id", "agent_type", "host", "session_id", "tool", "ts"]);
    assert.equal(recs[8].host, "docs.example.com");
    assert.ok(!JSON.stringify(recs).includes(SECRET), "no content, prompt, URL path or query in read records");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("read-log: the plugin copy exits early when the project registers its own", () => {
  const dir = project();
  try {
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ hooks: { PostToolUse: [{ matcher: "Read|WebFetch", hooks: [{ type: "command", command: "node .claude/hooks/read-log.mjs" }] }] } }));
    writeFileSync(join(dir, "a.md"), "x");
    assert.equal(run(dir, "read-log.mjs", { session_id: "s1", tool_name: "Read", tool_input: { file_path: join(dir, "a.md") } }, ["--plugin"]).status, 0);
    assert.equal(log(dir, "reads.jsonl").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report: agents by role and reads by kind, with older records lacking the new fields", () => {
  const dir = project();
  try {
    const state = join(dir, ".claude", "state");
    mkdirSync(state, { recursive: true });
    const tel = [
      { ts: "t1", session_id: "s1", hook_event_name: "SubagentStop", agent_type: "orchestration:implementer", tokens: { input: 10, output: 2000, cache_read: 5000, cache_write: 30 }, turns: 12, models: ["claude-sonnet-x"], max_turns_hit: true },
      { ts: "t2", session_id: "s1", hook_event_name: "SubagentStop", agent_type: "implementer", tokens: { input: 5, output: 1000, cache_read: 0, cache_write: 0 }, turns: 3, models: ["claude-opus-x"], max_turns_hit: false },
      { ts: "t3", session_id: "s1", hook_event_name: "SubagentStop", agent_type: "reviewer", status: "pass" }, // older record
      { ts: "t0", session_id: "s1", hook_event_name: "SubagentStart", agent_type: "reviewer" },
    ];
    writeFileSync(join(state, "telemetry.jsonl"), tel.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const reads = [
      { ts: "t", session_id: "s1", agent_type: "researcher", tool: "Read", kind: "pdf" },
      { ts: "t", session_id: "s1", agent_type: "researcher", tool: "Read", kind: "pdf" },
      { ts: "t", session_id: "s1", agent_type: "implementer", tool: "Read", kind: "code" },
      { ts: "t", session_id: "s1", agent_type: null, tool: "WebFetch", host: "example.com" },
    ];
    writeFileSync(join(state, "reads.jsonl"), reads.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const r = spawnSync("node", [join(root, "scripts", "report.mjs"), dir], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const html = readFileSync(join(state, "report.html"), "utf8");
    assert.match(html, /<h2>Agents by role<\/h2>/);
    assert.match(html, /<td>implementer<\/td><td>2<\/td><td>2<\/td><td>15<\/td>/);
    assert.match(html, /claude-sonnet-x, claude-opus-x<\/td><td>1 of 2<\/td>/);
    assert.match(html, /<td>reviewer<\/td><td>1<\/td><td>0<\/td>.*<td>0<\/td><td>n\/a<\/td><td>n\/a<\/td>/);
    assert.match(html, /<h2>Reads by kind and role<\/h2>/);
    assert.match(html, /<th>Kind<\/th><th>implementer<\/th><th>main<\/th><th>researcher<\/th><th>Total<\/th>/);
    assert.match(html, /<td>pdf<\/td><td>0<\/td><td>0<\/td><td>2<\/td><td>2<\/td>/);
    assert.match(html, /<td>web<\/td><td>0<\/td><td>1<\/td><td>0<\/td><td>1<\/td>/);
    assert.match(html, /<h2>Agent events<\/h2>/, "the existing sections stay");

    // A state dir with only older telemetry and no reads still renders.
    writeFileSync(join(state, "telemetry.jsonl"), JSON.stringify(tel[2]) + "\n");
    rmSync(join(state, "reads.jsonl"));
    assert.equal(spawnSync("node", [join(root, "scripts", "report.mjs"), dir], { encoding: "utf8" }).status, 0);
    assert.match(readFileSync(join(state, "report.html"), "utf8"), /No reads logged yet/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
