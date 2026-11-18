// Differential test of the Bash judge against the 1.4.0 release. src/fixtures/judge-core-1.4.0.mjs is a byte-for-byte
// copy of .claude/hooks/judge-core.mjs at release 1.4.0 (git show 5ab9175:.claude/hooks/judge-core.mjs); never edit it.
// Pure classification only: no model, no hook process.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDetail as next, tokenize as nextTokenize } from "../.claude/hooks/judge-core.mjs";
import { classifyDetail as old } from "./fixtures/judge-core-1.4.0.mjs";
import { classifyDetail as sdk, tokenize as sdkTokenize } from "./judge.js"; // tsx resolves it to judge.ts

const here = dirname(fileURLToPath(import.meta.url));
const CWD = "/w";

/** Every string literal in a test file (the same extraction as the parity test in judge-hook.test.mjs). @param {string} file */
function strings(file) {
  const src = readFileSync(join(here, file), "utf8");
  return [...src.matchAll(/"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\$]|\\.)*)`/g)].flatMap((m) => {
    try {
      return [m[1] !== undefined ? JSON.parse(`"${m[1]}"`) : (m[2] ?? m[3])];
    } catch {
      return [];
    }
  });
}

// The exec-env names (EXEC_ENV), GIT_CONFIG_* by one example.
const NAMES = ["GIT_EXTERNAL_DIFF", "GIT_EDITOR", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_PAGER", "GIT_ASKPASS", "GIT_SEQUENCE_EDITOR", "GIT_CONFIG_COUNT", "GIT_PROXY_COMMAND", "EDITOR", "VISUAL", "PAGER", "LD_PRELOAD", "BASH_ENV", "ENV", "PROMPT_COMMAND", "IFS", "PATH", "SHELLOPTS", "PS4", "ZDOTDIR", "BASH_FUNC_f%%"];

/** The quotings of one word `N<op>V` that the J2 property covers. @type {Array<(n: string, op: string, v: string) => string>} */
const QUOTINGS = [
  (n, op, v) => `"${n}${op}${v}"`,
  (n, op, v) => `'${n}${op}${v}'`,
  (n, op, v) => `${n.slice(0, 2)}"${n.slice(2)}${op}${v}"`,
  (n, op, v) => `""${n}${op}${v}`,
  (n, op, v) => `\\${n}${op}${v}`,
  (n, op, v) => `"${n}"${op}${v}`,
  (n, op, v) => `$'${n}'${op}${v}`,
  (n, op, v) => `${n}${op}"${v}"`,
];

// A command word (and its options) before the exec-env word, and what follows it on the line.
const BEFORE = ["env", "env -i", "env -u HOME", "env --", "env -iu HOME", "env -u HOME env", "timeout -s KILL 5 env", "taskset 1 env", "nice ${E}nv", "./e", "export", "declare -x", "command export", "readonly", "echo", "printf %s", "grep -rn", "git log --grep", "git commit -m", "find . -exec env", "xargs -0 env", "cat >"];
const AFTER = [" git status", " git fetch origin", "; git status", " && rm -r build", "; bash run.sh", " ls", " | sh", " src", " \\;"];

/** Every generated line, with its unquoted word and each quoting of it. */
function generated() {
  const out = [];
  for (const n of NAMES)
    for (const op of ["=", "+="])
      for (const v of ["/x"])
        for (const b of BEFORE)
          for (const a of AFTER) out.push({ plain: `${b} ${n}${op}${v}${a}`, quoted: QUOTINGS.map((q) => `${b} ${q(n, op, v)}${a}`) });
  return out;
}

// Audit items J1 to J5: the denies they add, and the inputs that got past the judge before them. Each input must be
// denied (or judged, for a push) by both copies, judge.ts and judge-core.mjs, alone and in the wrapped forms.
const HARDENING_REASONS = [
  // Release 2.0.0, slice w7: prompts set by builtins and expansions (N5), the size caps (N6), string wrappers (S1)
  /^setting PS[014] through a builtin or an expansion that assigns it/,
  /^[a-z]+ with (an argument the guard cannot read|an option cluster of more than|more attached option values).* is always blocked: it runs a command string through a shell/,
  /^a command (of|with) more than \d+ (characters|of [[{(]) is always blocked/,
  // w2, third attempt: the option allowlist (R1), wrapped programs (R4), git templates (R5)
  /^(set|setopt|unsetopt|shopt) .* is always blocked: the guard allows only option words it can read/,
  /^[a-z]+ (option )?[-+].* is always blocked: the guard allows only option (letters|s) it knows as harmless/,
  /^[a-z]+ after a wrapper \(xargs, env, timeout, nice, find -exec and the like\) is always blocked wherever it stands/,
  /^git (clone|init) --template is always blocked/,
  /\(<< inside \(\(\.\.\.\)\) is a left shift, not a here document\)/, // J1
  /\(brace expansion\)/, // J2: the scan no longer stops at a substitution
  /\(a NUL in \$'\.\.\.'\)/, // J3
  // Audit 2026-11-16 (J-1 to J-10)
  /\(<< inside \$\[\.\.\.\] or a subscript is a left shift, not a here document\)/,
  /\(a here-document delimiter with \$ or a backtick\)/,
  /^assigning zsh's functions, aliases/,
  /^a \$\(\.\.\.\) or backtick inside an array subscript/,
  /^hash -p and hash name=path/,
  /^enable -f loads a builtin/,
  // Audit 2026-11-16, second pass (fix-judge-2)
  /^assigning zsh's commands table/,
  /\(an assigning \$\{\.\.\.\} of a zsh function, alias or commands table\)/,
  // fix-judge-3: the same rule on the widest reading of the whole command text
  /^an assigning \$\{\.\.\.\} of zsh's functions, aliases or commands table/,
  // Release 2.0.0, slice w2
  /^(setopt|unsetopt) of globsubst or promptsubst/,
  /^set -o globsubst or promptsubst/,
  /^emulate is always blocked/,
  /^sched runs a command later/,
  /^(parallel|sem) runs its arguments/,
  /^setting PS[014] to a value with/,
  /^assigning zsh's options table/,
  /^[a-z]+ -?[-+][A-Za-z]* (with an option the guard cannot read|\S+) is always blocked: globsubst and promptsubst/,
  /^git clone .*: a config key that runs a program/,
];
/** @type {Array<[string, string[]]>} [command, the classes it may get] */
const HARDENED = [
  ["((1<<EOF))\nrm -rf .git\nEOF", ["deny"]],
  ["((1<<EOF))\nsudo id\nEOF", ["deny"]],
  ["((1<<EOF))\ngit push origin main\nEOF", ["deny"]],
  ["for ((i=0; i<<EOF; i++)); do :; done\nrm -rf .git\nEOF", ["deny"]],
  ["echo $((1<<'EOF'\n$(sudo id)\nEOF\n))", ["deny"]],
  ["env {rm,$(:)-rf,.git}", ["deny"]],
  ["env {git,$(:)push}", ["deny", "judge"]],
  ["env {rm,`echo x y`-rf,.git}", ["deny"]],
  ["env {rm,${X:- }-rf,.git}", ["deny"]],
  ["env {s,$(:)udo,id}", ["deny"]],
  ["$'sudo\\x00' id", ["deny"]],
  ["$'rm\\x00' -rf .git", ["deny"]],
  ["$'sudo\\0' id", ["deny"]],
  ["$'sudo\\000' id", ["deny"]],
  ["$'sudo\\u0000' id", ["deny"]],
  ["$'sudo\\U00000000' id", ["deny"]],
  ["$'sudo\\c@' id", ["deny"]],
  ["git $'push\\x00x' origin main", ["deny"]],
  ["git submodule foreach 'git push origin HEAD'", ["judge"]],
  ["git submodule foreach 'sudo id'", ["deny"]],
  ["git submodule --quiet foreach --recursive 'rm -rf .git'", ["deny"]],
  ["git submodule foreach 'rm -rf .git;' x", ["deny"]],
  ['git submodule foreach "$CMD"', ["deny"]],
  ["git rebase -x 'rm -rf .git' main", ["deny"]],
  ["git rebase --exec 'rm -rf .git' main", ["deny"]],
  ["git rebase --exec='rm -rf .git' main", ["deny"]],
  ["git rebase --exe 'rm -rf .git' main", ["deny"]],
  ["git rebase -x'rm -rf .git' main", ["deny"]],
  ["git rebase -ix 'rm -rf .git' main", ["deny"]],
  ["git rebase -x 'git push origin HEAD' main", ["judge"]],
  ['git rebase -x "$CMD" main', ["deny"]],
  ["git -C . rebase -x 'sudo id' main", ["deny"]],
  ["git bisect run 'rm -rf .git'", ["deny"]],
  ["git bisect run 'sudo id'", ["deny"]],
  ["git -c 'trailer.x.cmd=rm -rf .git' interpret-trailers --trailer x=1 f", ["deny"]],
  ["git -c 'trailer.x.command=rm -rf .git' interpret-trailers --trailer x=1 f", ["deny"]],
  ["git -c 'submodule.x.update=!rm -rf .git' submodule update", ["deny"]],
  ["git -c 'difftool.x.path=/tmp/evil' difftool --tool x", ["deny"]],
  ["git -c 'mergetool.x.path=/tmp/evil' mergetool --tool x", ["deny"]],
  ["git -c Trailer.X.Cmd=id interpret-trailers f", ["deny"]],
  ["git config trailer.x.cmd 'rm -rf .git'", ["deny"]],
  ["git config submodule.x.update '!rm -rf .git'", ["deny"]],
  ["git config difftool.x.path /tmp/evil", ["deny"]],
];
/** The string literals between `const <name>` and the next `];` of a test file. @param {string} file @param {string} name */
function listIn(file, name) {
  const src = readFileSync(join(here, file), "utf8");
  const at = src.indexOf(`const ${name}`);
  assert.ok(at >= 0, `${name} not found in ${file}`);
  const body = src.slice(at, src.indexOf("\n];", at));
  return [...body.matchAll(/^\s*"((?:[^"\\\n]|\\.)*)",/gm)].map((m) => JSON.parse(`"${m[1]}"`));
}
// Audit 2026-11-16, J-1 to J-10: every bypass row of judge.test.ts (AUDIT_1116_DENY) must be denied here too.
const AUDIT_1116 = listIn("judge.test.ts", "AUDIT_1116_DENY");
for (const c of AUDIT_1116) HARDENED.push([c, ["deny"]]);
// The second pass (fix-judge-2): J-3, J-4, J-8 and J-9 spellings (AUDIT_1116_2_DENY).
const AUDIT_1116_2 = listIn("judge.test.ts", "AUDIT_1116_2_DENY");
for (const c of AUDIT_1116_2) HARDENED.push([c, ["deny"]]);
// fix-judge-2, third attempt: an assigning ${...} into a zsh table with a prefix, flag or nesting before the name.
const AUDIT_1116_2_TABLE_EXPANSION = listIn("judge.test.ts", "AUDIT_1116_2_TABLE_EXPANSION_DENY");
for (const c of AUDIT_1116_2_TABLE_EXPANSION) HARDENED.push([c, ["deny"]]);
// fix-judge-3: the same rule on the widest reading (an escaped }, a backslash-newline, a quoted }, a nested expansion).
const AUDIT_1116_3_TABLE_EXPANSION = listIn("judge.test.ts", "AUDIT_1116_3_TABLE_EXPANSION_DENY");
for (const c of AUDIT_1116_3_TABLE_EXPANSION) HARDENED.push([c, ["deny"]]);
// Release 2.0.0, slice w2: the forms the docs listed as passing (W2_DENY), and the fetches that write a branch, which
// now go to the judge (W2_JUDGE).
const W2_DENY = listIn("judge.test.ts", "W2_DENY");
for (const c of W2_DENY) HARDENED.push([c, ["deny"]]);
// Third attempt: the option allowlist, wrapped programs and templates (W2R2_DENY).
for (const c of listIn("judge.test.ts", "W2R2_DENY")) HARDENED.push([c, ["deny"]]);
// Slice w7: commands after reserved words and modifiers (N1), wrapped refused programs (N4), prompts (N5) (W7_DENY).
const W7_DENY = listIn("judge.test.ts", "W7_DENY");
for (const c of W7_DENY) HARDENED.push([c, ["deny"]]);
for (const c of listIn("judge.test.ts", "W7_WRAPPERS")) HARDENED.push([c, ["deny"]]);
// Third review: the string wrappers' getopt spellings (S1) and zsh's stuck braces (S2) (W7_SHAPES).
for (const c of listIn("judge.test.ts", "W7_SHAPES")) HARDENED.push([c, ["deny"]]);
const W2_JUDGE = listIn("judge.test.ts", "W2_JUDGE");
for (const c of W2_JUDGE) HARDENED.push([c, ["judge", "deny"]]);
/** J4 and J5 deny with reasons older rules already give (`sudo is always blocked`, ...), so their inputs count by name. */
const HARDENED_INPUTS = new Set(HARDENED.map(([c]) => c));

/**
 * Audit 2026-11-16, J-15 (approved by the owner): the only forms 1.4.0 denied that may now pass, exactly these strings
 * and their wrapped forms. Everything else in GIT_EDITOR, core.editor and IFS stays denied (judge.test.ts, J-15 rows).
 */
const RELAXED = ["GIT_EDITOR=true git rebase --continue", "GIT_EDITOR=: git commit --amend", "GIT_EDITOR='true' git merge --continue", "git -c core.editor=true rebase --continue", "git -c core.editor=: commit --amend", "git -c 'core.editor=true' rebase --continue", 'while IFS= read -r f; do git add "$f"; done < files.txt', "IFS='' read -r line < f; git status"];
const RELAXED_FORMS = new Set(RELAXED.flatMap((s) => [s, `env ${s}`, `${s}; git status`]));

/** @param {{ cls: string, reason?: string }} r */
const fires = (r) => r.cls === "deny" && /^setting /.test(r.reason ?? "");

test("differential (J1): never weaker than 1.4.0 on every judge test string and the generated forms", () => {
  const corpus = JSON.parse(readFileSync(join(here, "fixtures", "judge-corpus.json"), "utf8"));
  const tested = [...strings("judge.test.ts"), ...strings("judge-hook.test.mjs"), ...corpus.cases.map((/** @type {{ command: string }} */ c) => c.command)];
  assert.ok(tested.length > 800, `only ${tested.length} strings`);
  const gen = generated().flatMap((g) => [g.plain, ...g.quoted]);
  // Wrapped forms: each tested string after a launcher, before a git call, and as a quoted argument.
  const wrapped = tested.flatMap((s) => [`env ${s}`, `${s}; git status`, `git log --grep '${s.replaceAll("'", "")}'`]);
  const all = [...new Set([...tested, ...gen, ...wrapped])];
  const weaker = [];
  for (const s of all) {
    const o = old(s, CWD);
    const n = next(s, CWD);
    if (RELAXED_FORMS.has(s) && n.cls === "pass") continue;
    if ((o.cls === "deny" && n.cls !== "deny") || (o.cls === "judge" && n.cls === "pass")) weaker.push(`${JSON.stringify(s)}: 1.4.0 ${o.cls}, now ${n.cls}`);
  }
  assert.deepEqual(weaker, []);
  assert.ok(AUDIT_1116.length >= 60, `only ${AUDIT_1116.length} audit rows read`);
  assert.ok(AUDIT_1116_2.length >= 50, `only ${AUDIT_1116_2.length} second-pass audit rows read`);
});

test("differential (J3): what 1.4.0 passes or judges becomes a deny only for the intended new rules", () => {
  const corpus = JSON.parse(readFileSync(join(here, "fixtures", "judge-corpus.json"), "utf8"));
  const tested = [...strings("judge.test.ts"), ...strings("judge-hook.test.mjs"), ...corpus.cases.map((/** @type {{ command: string }} */ c) => c.command)];
  const intended = (/** @type {{ reason?: string }} */ r) => /^setting [A-Z_0-9]+ on a command line/.test(r.reason ?? "") || /^find -rm /.test(r.reason ?? "") || HARDENING_REASONS.some((re) => re.test(r.reason ?? ""));
  const stray = [];
  for (const s of new Set(tested)) {
    const o = old(s, CWD);
    const n = next(s, CWD);
    if (o.cls !== "deny" && n.cls === "deny" && !intended(n) && !HARDENED_INPUTS.has(s)) stray.push(`${JSON.stringify(s)}: ${n.reason}`);
  }
  assert.deepEqual(stray, []);
  for (const s of ["grep -rn 'PATH=' src", 'echo "PATH=x"', "git log --grep 'XPATH='", 'git commit -m "fix PATH= handling"', "git log --grep=PATH=x"]) {
    assert.equal(next(s, CWD).cls, "pass", s);
    assert.equal(old(s, CWD).cls, "pass", s);
  }
});

test("exec-env property (J2): every quoting of the word fires the env deny exactly when the unquoted word does", () => {
  const differ = [];
  let fired = 0;
  for (const g of generated()) {
    const want = fires(next(g.plain, CWD));
    if (want) fired++;
    for (const q of g.quoted) if (fires(next(q, CWD)) !== want) differ.push(`${JSON.stringify(q)}: want ${want ? "env deny" : "no env deny"} as ${JSON.stringify(g.plain)}`);
  }
  assert.deepEqual(differ.slice(0, 20), []);
  assert.ok(fired > 1000, `the env deny fired on only ${fired} unquoted lines`);
});

test("hardening (J1-J5): both copies deny or judge every input that got past 1.4.4, alone and wrapped, and agree", () => {
  const wrong = [];
  for (const [s, want] of HARDENED) {
    for (const form of [s, `${s}; git status`, `true && ${s}`]) {
      const n = next(form, CWD);
      const k = sdk(form, CWD);
      if (JSON.stringify(n) !== JSON.stringify(k)) wrong.push(`${JSON.stringify(form)}: judge-core ${n.cls}, judge.ts ${k.cls}`);
      if (!want.includes(n.cls)) wrong.push(`${JSON.stringify(form)}: want ${want.join(" or ")}, got ${n.cls}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("zsh table expansion (fix-judge-2): every prefix, flag, operator and subscript of an assigning ${...} into a table is denied by both copies", () => {
  const tables = ["functions", "aliases", "galiases", "saliases", "dis_functions", "dis_aliases", "dis_galiases", "dis_saliases", "commands"];
  const chars = ["#", "+", "^", "=", "~", "!"];
  const prefixes = ["", ...chars, ...chars.flatMap((a) => chars.map((b) => a + b)), " ", "(P)", "(k)", "(e)", "(@)", "(AA)", "(#)", "#(k)"];
  const wrong = [];
  let n = 0;
  for (const t of tables)
    for (const p of prefixes)
      for (const op of ["=", ":=", "::="])
        for (const sub of ["", "[f]"])
          for (const inner of [`${p}${t}${sub}${op}echo MARK`, `${p}\${${t}${sub}${op}echo MARK}`])
            for (const line of [`: \${${inner}}`, `: "\${${inner}}"`, `if : \${${inner}}; then :; fi`, `env echo \${${inner}}`]) {
              n++;
              const a = next(line, CWD);
              const b = sdk(line, CWD);
              if (a.cls !== "deny" || JSON.stringify(a) !== JSON.stringify(b)) wrong.push(`${JSON.stringify(line)}: judge-core ${a.cls}, judge.ts ${b.cls}`);
            }
  assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} of ${n} forms`);
  for (const line of ["echo ${#functions}", "echo ${functions[f]}", "echo ${+commands[git]}", "echo ${x:=default}", "echo ${count::=0}", "echo ${#x:=functions}"]) {
    assert.equal(next(line, CWD).cls, "pass", line);
    assert.equal(sdk(line, CWD).cls, "pass", line);
  }
});

test("zsh table expansion (fix-judge-3): an escaped }, a backslash-newline anywhere, a quoted }, a nested expansion, a newline or spaces, wherever the expansion stands, is denied by both copies", () => {
  const tables = ["functions", "aliases", "galiases", "saliases", "dis_functions", "dis_aliases", "dis_galiases", "dis_saliases", "commands"];
  const expansions = (/** @type {string} */ t) => {
    const out = [
      `\${${t}[x\\}]::=echo MARK two words}`,
      `\${${t}[f]::=echo a\\}b MARK}`,
      `\${#${t}[x\\}]:=echo MARK}`,
      `\${+${t}[x\\}]=echo MARK}`,
      `\${${t}['}']::=echo MARK}`,
      `\${${t}["}"]::=echo MARK}`,
      `\${${t}[\${x:-g}]::=echo MARK}`,
      `\${${t}[\${x:-\\}}]::=echo MARK}`,
      `\${${t}[a\nb]::=echo MARK}`,
      `\${${t}[f]::=echo MARK\necho MARK}`,
      `\${${t}[a b]::=echo MARK}`,
      `\${${t}[a b]=echo MARK}`,
    ];
    // A backslash-newline at every place from just after the `$` to just before the `=`, with and without a prefix.
    for (const pre of ["", "#", "+"])
      for (const op of ["=", ":=", "::="]) {
        const s = `\${${pre}${t}[f]${op}echo MARK}`;
        for (let k = 1; k <= s.indexOf("="); k++) out.push(`${s.slice(0, k)}\\\n${s.slice(k)}`);
      }
    return out;
  };
  const sq = (/** @type {string} */ s) => `'${s.replaceAll("'", "'\\''")}'`;
  const dq = (/** @type {string} */ s) => `"${s.replace(/[\\"$`]/g, "\\$&")}"`;
  /** @type {Array<(e: string) => string>} */
  const placements = [
    (e) => `: ${e}; f`,
    (e) => `: "${e}"; f`,
    (e) => `if : ${e}; then f; fi`,
    (e) => `builtin : ${e}; f`,
    (e) => `! noglob : ${e}`,
    (e) => `env echo ${e}`,
    (e) => `echo ok; : ${e}`,
    (e) => `zsh -c ${sq(`: ${e}; f`)}`,
    (e) => `bash -c ${dq(`: ${e}; f`)}`,
    (e) => `eval ${sq(`: ${e}`)}`,
    (e) => `zsh -fc ${sq(`if : "${e}"; then f; fi`)}`,
  ];
  const wrong = [];
  let n = 0;
  for (const t of tables)
    for (const e of expansions(t))
      for (const place of placements) {
        const line = place(e);
        n++;
        const a = next(line, CWD);
        const b = sdk(line, CWD);
        if (a.cls !== "deny" || JSON.stringify(a) !== JSON.stringify(b)) wrong.push(`${JSON.stringify(line)}: judge-core ${a.cls}, judge.ts ${b.cls}`);
      }
  assert.deepEqual(wrong.slice(0, 20), [], `${wrong.length} of ${n} forms`);
  assert.ok(n > 5000, `only ${n} forms`);
  for (const line of ["echo ${#functions}", "echo ${functions[f]}", "echo ${+commands[git]}", "n=${#functions}; echo $n", "echo ${functions_dir:=x}", "echo ${my_commands:=y}", "echo '${functions[x\\}]::=echo MARK}'"]) {
    assert.equal(next(line, CWD).cls, "pass", line);
    assert.equal(sdk(line, CWD).cls, "pass", line);
  }
});

/** A file of this repository at commit `rev`, written into a scratch folder, or undefined when the clone does not hold
 * that commit (a shallow CI checkout). @param {string} rev @param {string} path */
function fromGit(rev, path) {
  let text;
  try {
    text = execFileSync("git", ["-C", here, "show", `${rev}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 });
  } catch {
    return undefined;
  }
  const dir = mkdtempSync(join(tmpdir(), "judge-rev-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, path.split("/").pop() ?? "x.mjs");
  writeFileSync(file, text);
  return pathToFileURL(file).href;
}
/** The strings every comparison below reads: every string literal of the judge tests, the corpus, the wrapped forms. */
function allStrings() {
  const corpus = JSON.parse(readFileSync(join(here, "fixtures", "judge-corpus.json"), "utf8"));
  const tested = [...strings("judge.test.ts"), ...strings("judge-hook.test.mjs"), ...corpus.cases.map((/** @type {{ command: string }} */ c) => c.command)];
  return [...new Set([...tested, ...tested.flatMap((s) => [`env ${s}`, `${s}; git status`, `true && ${s}`])])];
}
const shown = (/** @type {(s: string) => unknown} */ f, /** @type {string} */ s) => {
  try {
    return JSON.stringify(f(s));
  } catch (e) {
    return `throws ${e instanceof Error ? e.message : String(e)}`;
  }
};

// Slice w7, N6: the tokenizer's scans of `(`, `{` and `[` became linear (memos by index, lookups instead of rescans).
// The researcher guard imports the tokenizer, so its output must stay exactly what it was at 3bd0de6, the commit the
// slice started from: on every test string, and on random text made of the characters those scans read.
test("tokenizer (w7, N6): output equal to 3bd0de6's on every test string and on random shell text, in both copies", async (t) => {
  const url = fromGit("3bd0de6", ".claude/hooks/judge-core.mjs");
  if (!url) return t.skip("3bd0de6 is not in this clone (a shallow checkout)");
  const { tokenize: before } = await import(url);
  const inputs = allStrings();
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const atoms = ["(", ")", "{", "}", "[", "]", "$", "$(", "$((", "((", "))", "${", "'", '"', "`", "\\", " ", ";", "\n", ",", ".", "..", "<<", "<<E", "\nE\n", "<(", ">(", "a", "x=", "!", "^", ":alpha:", "|", "&", "#", "*", "?", "=", "~", "-"];
  for (let i = 0; i < 20000; i++) {
    let s = "";
    for (let n = 1 + Math.floor(random() * 24); n > 0; n--) s += atoms[Math.floor(random() * atoms.length)];
    inputs.push(s);
  }
  const differ = [];
  for (const s of inputs) {
    const want = shown(before, s);
    if (shown(nextTokenize, s) !== want || shown(sdkTokenize, s) !== want) differ.push(JSON.stringify(s));
  }
  assert.deepEqual(differ.slice(0, 20), [], `${differ.length} of ${inputs.length} inputs`);
});

// Never weaker than the release this work builds on: nothing release-1.6.1 (7b408fe) denies passes or is judged now,
// and nothing it judges passes, on every test string and its wrapped forms.
test("differential (w7): never weaker than release-1.6.1 on every judge test string and its wrapped forms", async (t) => {
  const url = fromGit("7b408fe", ".claude/hooks/judge-core.mjs");
  if (!url) return t.skip("7b408fe is not in this clone (a shallow checkout)");
  const { classifyDetail: release } = await import(url);
  const weaker = [];
  for (const s of allStrings()) {
    const o = release(s, CWD);
    const n = next(s, CWD);
    if ((o.cls === "deny" && n.cls !== "deny") || (o.cls === "judge" && n.cls === "pass")) weaker.push(`${JSON.stringify(s)}: 1.6.1 ${o.cls}, now ${n.cls}`);
  }
  assert.deepEqual(weaker, []);
});

// Slice w7, third review: the self-check of S1 and S2 against the real shells and tools. Each template has a slot for
// a body (B), a group (G) and a lock file (F). Kind: "zsh" runs as `zsh -f -c`, "bash" as `bash -c`, and "string" and
// "argv" (a wrapper that runs a command string through a shell, or its words as a program) as `sh -c` with the tool
// first. Run with the body `echo $((6*7))MARK`, a template that prints 42MARK runs its body; then the same template
// with `parallel x` as the body (and `setopt globsubst` for "zsh" and "string") must be denied by both copies. The third
// field is what the template printed on the machine the table was recorded on (Linux, zsh, bash, util-linux, shadow's
// sg, as root, whose shell is zsh; watch with TERM=xterm). The test runs each template again where its tool is
// installed (su and runuser only as root, watch never: it needs a terminal and waits) and requires the denial when
// either run printed the mark.
/** @type {Array<[string, string, number]>} */
const SELF_CHECK = [
  ["zsh", "@B@", 1], ["zsh", "{@B@}", 1], ["zsh", "{ @B@ }", 1], ["zsh", "{ @B@; }", 1], ["zsh", "{@B@;}", 1],
  ["zsh", "{{@B@}}", 0], ["zsh", "{ {@B@} }", 1], ["zsh", "true && {@B@}", 1], ["zsh", "true || false; {@B@}", 1],
  ["zsh", "false || {@B@}", 1], ["zsh", "true | {@B@}", 1], ["zsh", "! {@B@}", 1], ["zsh", "!{@B@}", 0],
  ["zsh", "time {@B@}", 1], ["zsh", "time @B@", 1], ["zsh", "nocorrect @B@", 1], ["zsh", "noglob @B@", 1],
  ["zsh", "noglob {@B@}", 0], ["zsh", "command @B@", 1], ["zsh", "builtin @B@", 1], ["zsh", "exec @B@", 1],
  ["zsh", "- @B@", 0], ["zsh", "repeat 1 @B@", 1], ["zsh", "repeat 1 {@B@}", 1], ["zsh", "repeat 1 { @B@ }", 1],
  ["zsh", "repeat 1 do @B@; done", 1], ["zsh", "repeat 1 { repeat 1 {@B@} }", 1], ["zsh", "if true; then @B@; fi", 1],
  ["zsh", "if true; then {@B@}; fi", 1], ["zsh", "if [[ x ]] then @B@; fi", 1], ["zsh", "if [[ x ]] {@B@}", 0],
  ["zsh", "if [[ x ]] { @B@ }", 0], ["zsh", "if [[ x ]] @B@", 1], ["zsh", "if (( 1 )) @B@", 1],
  ["zsh", "if false; then :; else @B@; fi", 1], ["zsh", "if false; then :; elif true; then @B@; fi", 1],
  ["zsh", "if false; then :; elif [[ x ]] then @B@; fi", 1], ["zsh", "if false; then :; else {@B@}; fi", 1],
  ["zsh", "while [[ x ]] {@B@; break}", 1], ["zsh", "while [[ x ]] { @B@; break }", 1],
  ["zsh", "while true; do @B@; break; done", 1], ["zsh", "while [[ x ]] do @B@; break; done", 1],
  ["zsh", "until false; do @B@; break; done", 1], ["zsh", "until [[ ]] {@B@; break}", 0], ["zsh", "for i (a) {@B@}", 1],
  ["zsh", "for i (a) { @B@ }", 1], ["zsh", "for i (a) @B@", 1], ["zsh", "for i in a; do @B@; done", 1],
  ["zsh", "for i in a; {@B@}", 1], ["zsh", "for i in a; @B@", 1], ["zsh", "for i in a {@B@}", 0],
  ["zsh", "for ((i=0;i<1;i++)) {@B@}", 1], ["zsh", "for ((i=0;i<1;i++)) do @B@; done", 1],
  ["zsh", "for ((i=0;i<1;i++)) @B@", 1], ["zsh", "foreach i (a) @B@; end", 1], ["zsh", "foreach i (a) {@B@}; end", 0],
  ["zsh", "select i in a; do @B@; break; done </dev/null", 0], ["zsh", "case a in a) @B@;; esac", 1],
  ["zsh", "case a in a) {@B@};; esac", 1], ["zsh", "case a { a) @B@ ;; }", 1], ["zsh", "case a { a) {@B@} ;; }", 1],
  ["zsh", "case a in (a) @B@;; esac", 1], ["zsh", "{ : } always {@B@}", 1], ["zsh", "{ : } always { @B@ }", 1],
  ["zsh", "{:} always {@B@}", 1], ["zsh", "{ @B@ } always { : }", 1], ["zsh", "(@B@)", 1], ["zsh", "( @B@ )", 1],
  ["zsh", "({@B@})", 1], ["zsh", "() {@B@}", 1], ["zsh", "() { @B@ }", 1], ["zsh", "function {@B@}", 0],
  ["zsh", "f() {@B@}; f", 1], ["zsh", "function f {@B@}; f", 0], ["zsh", "f() @B@; f", 1], ["zsh", "coproc @B@; wait", 0],
  ["zsh", "coproc {@B@}; cat <&p", 1], ["zsh", "x=1 @B@", 1], ["zsh", "@B@ > /dev/stdout", 1],
  ["zsh", "{@B@} >/dev/stdout", 1], ["zsh", "{@B@}|cat", 1], ["zsh", "echo $(@B@)", 1], ["zsh", "echo $({@B@})", 1],
  ["zsh", "echo `@B@`", 1], ["zsh", "cat <(@B@)", 1], ["zsh", "eval '@B@'", 1], ["zsh", "eval '{@B@}'", 1],
  ["zsh", "true; {@B@} always {:}", 1],
  ["bash", "{ @B@; }", 1], ["bash", "{@B@;}", 0], ["bash", "time @B@", 1], ["bash", "time -p @B@", 1], ["bash", "! @B@", 1],
  ["bash", "command @B@", 1], ["bash", "builtin @B@", 1], ["bash", "exec @B@", 1], ["bash", "if true; then @B@; fi", 1],
  ["bash", "if false; then :; else @B@; fi", 1], ["bash", "while true; do @B@; break; done", 1],
  ["bash", "until false; do @B@; break; done", 1], ["bash", "for i in a; do @B@; done", 1],
  ["bash", "for ((i=0;i<1;i++)); do @B@; done", 1], ["bash", "case a in a) @B@;; esac", 1], ["bash", "(@B@)", 1],
  ["bash", "coproc { @B@; }; cat <&${COPROC[0]}", 1], ["bash", "@B@ & wait", 1], ["bash", "true && @B@", 1],
  ["bash", "false || @B@", 1],
  ["string", "sg @G@ -c '@B@'", 1], ["string", "sg @G@ -c'@B@'", 1], ["string", "sg -c'@B@' @G@", 1],
  ["string", "sg -c '@B@' @G@", 1], ["string", "sg @G@ '@B@'", 1], ["string", "sg - @G@ -c '@B@'", 0],
  ["string", "sg - @G@ '@B@'", 0], ["string", "sg @G@ 'echo hi' -c '@B@'", 1], ["string", "sg @G@ -c 'echo hi' -c '@B@'", 1],
  ["string", "sg @G@ --command='@B@'", 1], ["string", "sg @G@ --command '@B@'", 1], ["string", "sg @G@ --comm='@B@'", 1],
  ["string", "sg @G@ -- '@B@'", 1], ["string", "sg @G@ -c -- '@B@'", 0], ["string", "sg @G@ -xc '@B@'", 0],
  ["argv", "sg @G@ @B@", 0], ["string", "sg @G@ \"@B@\"", 1],
  ["string", "su -c'@B@'", 1], ["string", "su -c '@B@'", 1], ["string", "su - root -c '@B@'", 1], ["string", "su root -c'@B@'", 1],
  ["string", "su --command='@B@'", 1], ["string", "su --command '@B@'", 1], ["string", "su --comm='@B@'", 1],
  ["string", "su --session-command='@B@'", 1], ["string", "su -lc '@B@'", 1], ["string", "su -l root -c '@B@'", 1],
  ["string", "runuser -l root -c '@B@'", 1], ["argv", "runuser -u root -- @B@", 1], ["argv", "runuser -u root @B@", 1],
  ["string", "runuser root -c'@B@'", 1], ["string", "runuser --command='@B@' root", 1],
  ["string", "flock @F@ -c '@B@'", 1], ["string", "flock -c'@B@' @F@", 0], ["string", "flock @F@ -c'@B@'", 0],
  ["string", "flock --command '@B@' @F@", 0], ["string", "flock --command='@B@' @F@", 0], ["string", "flock --comm='@B@' @F@", 0],
  ["string", "flock -xnc '@B@' @F@", 0], ["string", "flock -xc'@B@' @F@", 0], ["argv", "flock @F@ @B@", 1],
  ["argv", "flock -x @F@ @B@", 1], ["argv", "flock @F@ -- @B@", 0], ["string", "flock -w 1 @F@ -c '@B@'", 1],
  ["string", "script -c'@B@' /dev/null", 1], ["string", "script -qc '@B@' /dev/null", 1],
  ["string", "script --command='@B@' /dev/null", 1], ["string", "script --command '@B@' /dev/null", 1],
  ["string", "script --comm='@B@' /dev/null", 1], ["string", "script -qefc '@B@' /dev/null", 1],
  ["string", "script -q /dev/null -c '@B@'", 1], ["string", "script -qc'@B@' /dev/null", 1], ["string", "script -q -c '@B@'", 1],
  ["string", "script /dev/null -qc '@B@'", 1],
  ["string", "watch '@B@'", 1], ["string", "watch -n1 '@B@'", 1], ["string", "watch -n 1 '@B@'", 1], ["argv", "watch -x @B@", 1],
  ["argv", "watch -- @B@", 1], ["argv", "watch -t -n1 @B@", 1], ["string", "watch --interval=1 '@B@'", 1], ["string", "watch -g '@B@'", 1],
];
const MARK_BODY = "echo $((6*7))MARK";
/** Whether `tool` is on PATH. @param {string} tool */
const installed = (tool) => {
  try {
    execFileSync("sh", ["-c", `command -v ${tool}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

test("self-check (w7, S1 and S2): every template a real shell or tool runs is denied with a refused body, in both copies", async () => {
  assert.ok(SELF_CHECK.length >= 80, `only ${SELF_CHECK.length} templates`);
  const dir = mkdtempSync(join(tmpdir(), "judge-self-"));
  const lock = join(dir, "lock");
  writeFileSync(lock, "");
  const root = typeof process.getuid === "function" && process.getuid() === 0;
  const group = installed("id") ? execFileSync("id", ["-gn"], { encoding: "utf8" }).trim() : "root";
  /** @type {Map<string, boolean>} */
  const tools = new Map();
  const timeout = installed("timeout");
  const runnable = (/** @type {string} */ kind, /** @type {string} */ t) => {
    const tool = kind === "zsh" || kind === "bash" ? kind : (t.split(" ")[0] ?? "");
    if (tool === "watch" || ((tool === "su" || tool === "runuser") && !root) || !timeout) return false;
    if (!tools.has(tool)) tools.set(tool, installed(tool));
    return tools.get(tool) === true;
  };
  // One bash driver per group of templates runs each under `timeout 5` with stdin closed, after a line `@@<index>`;
  // the templates reach it as environment variables, never as shell text. Eight drivers at once.
  const DRIVER = 'for v in $LIST; do k=K_$v; c=C_$v; echo "@@$v"; case ${!k} in zsh) timeout 5 zsh -f -c "${!c}";; bash) timeout 5 bash -c "${!c}";; *) timeout 5 sh -c "${!c}";; esac </dev/null 2>&1; done';
  const todo = SELF_CHECK.flatMap(([k, t], i) => (runnable(k, t) ? [i] : []));
  const ran = new Array(SELF_CHECK.length).fill(false);
  const chunks = Array.from({ length: 8 }, (_, n) => todo.filter((_, j) => j % 8 === n)).filter((c) => c.length);
  await Promise.all(chunks.map((chunk) => new Promise((done) => {
    /** @type {Record<string, string | undefined>} */
    const env = { ...process.env, TERM: "dumb", LIST: chunk.join(" ") };
    for (const i of chunk) {
      const [k, t] = SELF_CHECK[i] ?? ["", ""];
      env[`K_${i}`] = k;
      env[`C_${i}`] = t.replaceAll("@G@", group).replaceAll("@F@", lock).replaceAll("@B@", MARK_BODY);
    }
    const child = execFile("bash", ["-c", DRIVER], { cwd: dir, env, timeout: 60_000, maxBuffer: 1 << 24 }, (_e, out) => {
      for (const part of String(out).split(/^@@/m).slice(1)) {
        const i = Number.parseInt(part, 10);
        if (Number.isInteger(i) && part.includes("42MARK")) ran[i] = true;
      }
      done(undefined);
    });
    child.stdin?.end();
  })));
  rmSync(dir, { recursive: true, force: true });
  /** @type {string[]} */
  const wrong = [];
  let required = 0;
  SELF_CHECK.forEach(([kind, t, recorded], i) => {
    if (!recorded && !ran[i]) return;
    required++;
    for (const body of kind === "zsh" || kind === "string" ? ["parallel x", "setopt globsubst"] : ["parallel x"]) {
      const c = t.replaceAll("@G@", "g").replaceAll("@F@", "/tmp/l").replaceAll("@B@", body);
      const a = next(c, CWD);
      const b = sdk(c, CWD);
      if (a.cls !== "deny" || JSON.stringify(a) !== JSON.stringify(b)) wrong.push(`${JSON.stringify(c)}: judge-core ${a.cls}, judge.ts ${b.cls}`);
    }
  });
  assert.deepEqual(wrong, []);
  assert.ok(required >= 140, `only ${required} templates are required`);
  // Where zsh is installed the table really ran: most of its zsh templates printed the mark.
  if (tools.get("zsh")) assert.ok(SELF_CHECK.filter(([k], i) => k === "zsh" && ran[i]).length >= 60, "zsh ran too few templates");
});
