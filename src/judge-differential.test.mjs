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
const NAMES = ["GIT_EXTERNAL_DIFF", "GIT_EDITOR", "GIT_SSH", "GIT_SSH_COMMAND", "GIT_PAGER", "GIT_ASKPASS", "GIT_SEQUENCE_EDITOR", "GIT_CONFIG_COUNT", "GIT_PROXY_COMMAND", "EDITOR", "VISUAL", "PAGER", "LD_PRELOAD", "BASH_ENV", "ENV", "PROMPT_COMMAND", "IFS", "PATH", "SHELLOPTS"];

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
];

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
    if ((o.cls === "deny" && n.cls !== "deny") || (o.cls === "judge" && n.cls === "pass")) weaker.push(`${JSON.stringify(s)}: 1.4.0 ${o.cls}, now ${n.cls}`);
  }
  assert.deepEqual(weaker, []);
});

test("differential (J3): what 1.4.0 passes or judges becomes a deny only for the intended new rules", () => {
  const corpus = JSON.parse(readFileSync(join(here, "fixtures", "judge-corpus.json"), "utf8"));
  const tested = [...strings("judge.test.ts"), ...strings("judge-hook.test.mjs"), ...corpus.cases.map((/** @type {{ command: string }} */ c) => c.command)];
  const intended = (/** @type {{ reason?: string }} */ r) => /^setting [A-Z_0-9]+ on a command line/.test(r.reason ?? "") || /^find -rm /.test(r.reason ?? "") || HARDENING_REASONS.some((re) => re.test(r.reason ?? ""));
  const stray = [];
  for (const s of new Set(tested)) {
    const o = old(s, CWD);
    const n = next(s, CWD);
    if (o.cls !== "deny" && n.cls === "deny" && !intended(n)) stray.push(`${JSON.stringify(s)}: ${n.reason}`);
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
