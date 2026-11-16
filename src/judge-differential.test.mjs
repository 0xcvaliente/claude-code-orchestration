// Differential test of the Bash judge against the 1.4.0 release. src/fixtures/judge-core-1.4.0.mjs is a byte-for-byte
// copy of .claude/hooks/judge-core.mjs at release 1.4.0 (git show 5ab9175:.claude/hooks/judge-core.mjs); never edit it.
// Pure classification only: no model, no hook process.
import "./test-tmp.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyDetail as next } from "../.claude/hooks/judge-core.mjs";
import { classifyDetail as old } from "./fixtures/judge-core-1.4.0.mjs";
import { classifyDetail as sdk } from "./judge.js"; // tsx resolves it to judge.ts

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
