#!/usr/bin/env node
// Handbook checker: node tools/check.mjs [repo dir]. Prints one line per check and exits 1 if any fails.
// Checks structure, terms and links. The final grade also checks each rule's paragraph (rule 1 of task.md).
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SECTIONS = ["access", "devices", "incidents", "data"];
export const TERMS = [
  ["MFA", "mfa"],
  ["SSO", "sso"],
  ["VPN", "vpn"],
  ["PII", "pii"],
  ["Incident commander", "incident-commander"],
];
// Terms each section's source needs, so its section must mention and link them.
const SECTION_TERMS = { access: ["MFA", "SSO"], devices: ["VPN"], incidents: ["Incident commander"], data: ["PII"] };
const BANNED = ["2FA", "two-factor", "single sign-on", "personally identifiable"];

export const slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
const read = (f) => (existsSync(f) ? readFileSync(f, "utf8") : null);
const headings = (text) => [...(text ?? "").matchAll(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm)].map((m) => slug(m[1]));
const links = (text) => [...(text ?? "").matchAll(/\[([^\]]*)\]\(([^)\s]+)\)/g)].map((m) => ({ text: m[1], target: m[2], start: m.index, end: m.index + m[0].length }));
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const termRe = (t) => new RegExp(`(?<![\\p{L}\\p{N}])${escape(t)}(?![\\p{L}\\p{N}])`, "giu");
// Body text with headings blanked out (same length, so offsets still match).
const body = (text) => text.replace(/^#{1,6}[ \t].*$/gm, (l) => " ".repeat(l.length));

/**
 * @param {string} hb handbook dir   @param {string} sources sources dir (for ../sources/ links)
 * @param {{rule?: (file: string, para: string) => boolean, rules?: Array<{id: string, section: string, source: string, key: string}>}} [opts]
 * @returns {Array<{name: string, ok: boolean, why?: string}>}
 */
export function checks(hb, sources, { rules = [] } = {}) {
  const out = [];
  const add = (name, ok, why) => out.push(ok ? { name, ok } : { name, ok, why });
  const files = Object.fromEntries([...SECTIONS, "glossary", "README"].map((s) => [s, read(join(hb, `${s}.md`))]));

  // Rule paragraphs: cited exactly once across the handbook, in the right section, with the key wording.
  for (const r of rules) {
    const href = `../sources/${r.source}#${r.id.toLowerCase()}`;
    const hits = [];
    for (const s of [...SECTIONS, "glossary", "README"]) {
      for (const para of (files[s] ?? "").split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+\.)\s)/)) {
        if (links(para).some((l) => l.target === href)) hits.push({ s, para });
      }
    }
    const ok = hits.length === 1 && hits[0].s === r.section && hits[0].para.toLowerCase().includes(r.key.toLowerCase());
    add(`rule ${r.id}`, ok, hits.length !== 1 ? `cited ${hits.length} times` : hits[0].s !== r.section ? `in ${hits[0].s}.md` : `missing "${r.key}"`);
  }

  for (const s of SECTIONS) {
    const text = files[s];
    if (text === null) {
      add(`${s}: no banned terms`, false, "file missing");
      add(`${s}: glossary terms linked on first mention`, false, "file missing");
      continue;
    }
    const banned = BANNED.filter((b) => termRe(b).test(text));
    add(`${s}: no banned terms`, banned.length === 0, banned.join(", "));
    const b = body(text);
    const ls = links(b);
    const bad = [];
    for (const [term, anchor] of TERMS) {
      const m = termRe(term).exec(b);
      if (!m) {
        if (SECTION_TERMS[s].includes(term)) bad.push(`${term} not mentioned`);
        continue;
      }
      const inLink = ls.find((l) => m.index > l.start && m.index < l.start + 1 + l.text.length);
      if (!inLink || inLink.target !== `glossary.md#${anchor}`) bad.push(`${term} first mention not linked to glossary.md#${anchor}`);
    }
    add(`${s}: glossary terms linked on first mention`, bad.length === 0, bad.join("; "));
  }

  const gl = files.glossary;
  for (const [term] of TERMS) {
    const m = gl && new RegExp(`^##[ \\t]+${escape(term)}[ \\t]*\\n+([^#][^\\n]*)`, "im").exec(gl);
    add(`glossary: ${term}`, Boolean(m && m[1].trim().split(/\s+/).length >= 5), gl === null ? "file missing" : "no heading with a definition of 5+ words");
  }

  const order = links(files.README).map((l) => l.target.replace(/^\.\//, "").split("#")[0]);
  const want = ["access.md", "devices.md", "incidents.md", "data.md", "glossary.md"];
  const pos = want.map((w) => order.indexOf(w));
  add("README: sections in order, then glossary", pos.every((p, i) => p >= 0 && (i === 0 || p > pos[i - 1])), `link order ${JSON.stringify(order)}`);

  const broken = [];
  for (const [s, text] of Object.entries(files)) {
    for (const { target } of links(text)) {
      if (/^[a-z]+:/i.test(target)) continue;
      const [path, anchor] = target.split("#");
      const file = path === "" ? join(hb, `${s}.md`) : path.startsWith("../sources/") ? join(sources, path.slice("../sources/".length)) : join(hb, path);
      const t = read(file);
      if (t === null || (anchor && !headings(t).includes(anchor))) broken.push(`${s}.md -> ${target}`);
    }
  }
  add("all relative links resolve", broken.length === 0 && files.README !== null, broken.slice(0, 5).join(", ") || "README.md missing");
  return out;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const repo = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const res = checks(join(repo, "handbook"), join(repo, "sources"));
  for (const r of res) console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name}${r.ok ? "" : `: ${r.why}`}`);
  const failed = res.filter((r) => !r.ok).length;
  console.log(failed ? `${failed} of ${res.length} checks failed` : `all ${res.length} checks passed`);
  process.exit(failed ? 1 : 0);
}
