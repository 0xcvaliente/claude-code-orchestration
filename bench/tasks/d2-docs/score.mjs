// Grades d2-docs: one check per question in answers.json. The key is here, outside setup/, so a run never sees it.
// Kinds: exact (case and surrounding space ignored), regex (on the trimmed string), num (a JSON number, or a string whose
// first number, commas removed, is within tol). Each question names the document kind it tests (category), so analysis
// can split accuracy by kind (tables, scans, ...). Documents: gen/make_docs.py.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const KEY = [
  { id: "q1", category: "txt", kind: "exact", want: "BRAMBLE" },
  { id: "q2", category: "pdf-text", kind: "regex", want: /^2023-03-09$/ },
  { id: "q3", category: "pdf-table", kind: "num", want: 3.85, tol: 0.001 },
  { id: "q4", category: "pdf-scan", kind: "exact", want: "IC-58213-Q" },
  { id: "q5", category: "xlsx-formula", kind: "num", want: 18058.45, tol: 0.01 },
  { id: "q6", category: "chart", kind: "num", want: 47, tol: 2 },
  { id: "q7", category: "pdf-long", kind: "num", want: 450, tol: 0.5 },
];

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
  return {
    pass: passed === KEY.length, passed, total: KEY.length,
    categories: Object.fromEntries(res.map((r) => [r.category, r.ok])),
    failed: data ? res.filter((r) => !r.ok).map((r) => `${r.id} (${r.category})`) : ["answers.json missing or not valid JSON"],
  };
}
