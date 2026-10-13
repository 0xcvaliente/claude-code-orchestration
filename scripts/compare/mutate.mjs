#!/usr/bin/env node
// Sanity check for the hidden tests: each mutation breaks the reference solution in a plausible way,
// and the hidden tests must fail for it. A surviving mutation means the tests are too weak.
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const MUTATIONS = {
  "h1-query-engine": [
    ["nulls last in ASC", "a === null ? -1 : b === null ? 1 : a < b", "a === null ? 1 : b === null ? -1 : a < b"],
    ["LIKE case-sensitive", '"is")', '"s")'],
    ["NOT IN ignores NULL in list", "const r = hit ? true : unknown ? null : false;", "const r = hit ? true : false;"],
    ["OR binds tighter than AND", "let e = andExpr(); while (acceptKw(\"OR\")) e = { k: \"or\", a: e, b: andExpr() }; return e;", "let e = andExpr(); while (acceptKw(\"OR\")) e = { k: \"and\", a: e, b: andExpr() }; return e;"],
    ["AVG divides by row count", "s / vs.length", "s / grp.length"],
    ["JOIN matches NULL = NULL", "if (x !== null && y !== null && x === y)", "if (x === y)"],
    ["OFFSET ignored", "rows.slice(q.offset, end)", "rows.slice(0, end)"],
    ["unstable sort tiebreak", "return x.i - y.i;", "return y.i - x.i;"],
    ["empty aggregate returns no row", 'groups.set("all", combos)', 'if (combos.length) groups.set("all", combos)'],
    ["rows share storage with table", "t.rows.push(out);", "t.rows.push(row);"],
    ["string compare numeric coercion", 'if (typeof a !== typeof b) throw new Error("type mismatch");', ""],
    ["trailing tokens accepted", 'if (p < toks.length) fail("unexpected trailing tokens");', ""],
  ],
  "h2-scheduler": [
    ["head-of-line blocking", "continue;\n      free--;", "break;\n      free--;"],
    ["priority ascending", "b.j.priority - a.j.priority", "a.j.priority - b.j.priority"],
    ["skip only direct dependents", "let changed = true;", "let changed = false; for (const o of st.values()) if (o.status === \"pending\" && o.j.deps.includes(r.id)) o.status = \"skipped\";"],
    ["one retry too few", "s.attempt < 1 + s.j.maxRetries", "s.attempt < s.j.maxRetries"],
    ["one retry too many", "s.attempt < 1 + s.j.maxRetries", "s.attempt < 2 + s.j.maxRetries"],
    ["ties choose largest path", "(c.length === top.length && lexLess(c.path, top.path))", "(c.length === top.length && lexLess(top.path, c.path))"],
    ["fail when attempt equals failAttempts", "s.attempt > s.j.failAttempts", "s.attempt >= s.j.failAttempts"],
    ["resources not released", "for (const [k, n] of Object.entries(st.get(r.id).j.needs)) avail[k] += n;", ""],
    ["gantt marks failures as success", 'cover.some((a) => a.ok) ? "#" : cover.length ? "x" : "."', 'cover.length ? "#" : "."'],
    ["id tiebreak descending", "cmpStr(a.j.id, b.j.id)", "cmpStr(b.j.id, a.j.id)"],
    ["no cycle detection message ids", "throw new Error(`cycle: ${[...cyc, id].join(\" -> \")}`);", "throw new Error(\"cycle\");"],
    ["makespan ignores failed attempts", "attempts.reduce((m, a) => Math.max(m, a.end), 0)", "attempts.filter((a) => a.ok).reduce((m, a) => Math.max(m, a.end), 0)"],
  ],
};

let survived = 0;
for (const [task, list] of Object.entries(MUTATIONS)) {
  const src = readFileSync(join(here, "tasks", task, "ref", "index.js"), "utf8");
  for (const [name, from, to] of list) {
    if (!src.includes(from)) { console.log(`SKIP  ${task}: "${name}" (pattern not found)`); survived++; continue; }
    const dir = mkdtempSync(join(tmpdir(), "mut-"));
    writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
    cpSync(join(here, "tasks", task, "hidden.test.js"), join(dir, "hidden.test.js"));
    writeFileSync(join(dir, "index.js"), src.replace(from, to));
    const r = spawnSync("node", ["--test", "hidden.test.js"], { cwd: dir, encoding: "utf8", timeout: 60_000 });
    const killed = r.status !== 0;
    if (!killed) survived++;
    console.log(`${killed ? "caught  " : "SURVIVED"} ${task}: ${name}`);
  }
}
console.log(survived ? `\n${survived} mutation(s) not caught` : "\nall mutations caught");
process.exit(survived ? 1 : 0);
