// Grades d3-reader: one check per question in answers.json. The key is here, outside setup/, so a run never sees it.
// Kinds: exact (case and surrounding space ignored), regex (on the trimmed string), num (a JSON number, or a string whose
// first number, commas removed, is within tol). Each question names the document kind it tests (category); HARD lists
// the kinds the read router raises to sonnet (tables, scans, charts, xlsx formulas, docx tables), so analysis can split
// accuracy into hard and easy kinds (H14 amendment for d3-reader). Documents: gen/make_docs.py.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const KEY = [
  { id: "q1", category: "pdf-text", kind: "regex", want: /^2023-03-09$/ },
  { id: "q2", category: "pdf-text", kind: "num", want: 186, tol: 0 },
  { id: "q3", category: "pdf-table", kind: "num", want: 3.85, tol: 0.001 },
  { id: "q4", category: "pdf-table", kind: "num", want: 9.1, tol: 0.001 },
  { id: "q5", category: "pdf-scan", kind: "exact", want: "IC-58213-Q" },
  { id: "q6", category: "pdf-scan", kind: "num", want: 7731, tol: 0 },
  { id: "q7", category: "chart", kind: "num", want: 47, tol: 2 },
  { id: "q8", category: "chart", kind: "exact", want: "Highlands" },
  { id: "q9", category: "xlsx-formula", kind: "num", want: 18058.45, tol: 0.01 },
  { id: "q10", category: "xlsx-formula", kind: "num", want: 1256.24, tol: 0.01 },
  { id: "q11", category: "docx", kind: "num", want: 45, tol: 0 },
  { id: "q12", category: "pdf-long", kind: "num", want: 450, tol: 0.5 },
];

// The kinds the read router profiles as sonnet (file-profile.mjs, checked on these documents when the task was made);
// pdf-text and pdf-long profile as haiku. bench/analyze.mjs keeps its own copy (READER_HARD) and a test keeps them equal.
export const HARD = ["pdf-table", "pdf-scan", "chart", "xlsx-formula", "docx"];

export function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const m = v.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}

export function checkAnswer(q, v) {
  if (v === undefined || v === null) return false;
  if (q.kind === "num") {
    const n = toNumber(v);
    return n !== null && Math.abs(n - q.want) <= q.tol;
  }
  const s = String(v).trim();
  if (q.kind === "regex") return q.want.test(s);
  return s.toLowerCase() === q.want.toLowerCase();
}

export function score(dir) {
  const file = join(dir, "answers.json");
  let data = null;
  if (existsSync(file)) {
    try { data = JSON.parse(readFileSync(file, "utf8")); } catch { data = null; }
  }
  const ok = (q) => Boolean(data && typeof data === "object" && checkAnswer(q, data[q.id]));
  const res = KEY.map((q) => ({ id: q.id, category: q.category, ok: ok(q) }));
  const passed = res.filter((r) => r.ok).length;
  const by_cat = {};
  for (const r of res) {
    const c = (by_cat[r.category] ??= [0, 0]);
    c[0] += r.ok ? 1 : 0;
    c[1] += 1;
  }
  return {
    pass: passed === KEY.length, passed, total: KEY.length,
    by_cat, // {category: [passed, total]}, kept by bench/grade.mjs in grades.jsonl
    flags: data ? res.filter((r) => !r.ok).map((r) => `${r.id} (${r.category}) wrong`) : ["answers.json missing or not valid JSON"],
  };
}
