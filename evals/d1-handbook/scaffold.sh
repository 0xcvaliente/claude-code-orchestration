#!/usr/bin/env bash
# Generated from bench/tasks/d1-handbook/setup: writes the bench task's starting files into the run workspace.
# Self-contained (heredocs) so it does not depend on where the eval runner invokes it from.
set -euo pipefail
mkdir -p 'sources'
cat > 'sources/access-policy.md' <<'EVAL_SCAFFOLD_EOF'
# Access policy

## AC-1
**Password length.** Passwords must be at least 14 characters long. Passphrases are encouraged.

## AC-2
**Two-factor authentication.** Every account that supports it must use two-factor authentication (2FA). A hardware security key is the preferred second factor; SMS codes are not allowed.

## AC-3
**Access review.** Each manager reviews the access of their team every 90 days and removes anything no longer needed.

## AC-4
**Single sign-on.** Internal apps sign in through single sign-on. Once an app is connected to single sign-on, its local accounts are disabled within 24 hours.
EVAL_SCAFFOLD_EOF
mkdir -p 'sources'
cat > 'sources/data-classification.md' <<'EVAL_SCAFFOLD_EOF'
# Data classification

## DT-1
**Classes.** All data has one of four classes: Public, Internal, Confidential and Restricted.

## DT-2
**Personal data.** Personally identifiable information (personal data that can identify someone) is classed Confidential at minimum.

## DT-3
**Storage.** Restricted data is stored only in the approved vault, never in chat or email.

## DT-4
**Retention.** Customer data is deleted 30 days after the customer's contract ends.
EVAL_SCAFFOLD_EOF
mkdir -p 'sources'
cat > 'sources/device-standard.md' <<'EVAL_SCAFFOLD_EOF'
# Device standard

## DV-1
**Disk encryption.** Every laptop uses full-disk encryption: FileVault on macOS, BitLocker on Windows.

## DV-2
**Screen lock.** Screens lock automatically after 5 minutes without input.

## DV-3
**Updates.** Security updates are installed within 7 days of release.

## DV-4
**Remote access.** Internal systems are reached only through the company VPN (virtual private network). Split tunneling is not allowed.
EVAL_SCAFFOLD_EOF
mkdir -p 'sources'
cat > 'sources/incident-runbook.md' <<'EVAL_SCAFFOLD_EOF'
# Incident runbook

## IN-1
**Reporting.** Report a suspected security incident within 1 hour in the #security-incidents channel, even if you are not sure.

## IN-2
**Who leads.** The on-call security engineer becomes the incident commander and makes the decisions until the incident is closed.

## IN-3
**Evidence.** Do not wipe or reimage an affected device until the incident commander says so.

## IN-4
**Review.** A blameless post-incident review is held within 5 business days of closing the incident.
EVAL_SCAFFOLD_EOF
mkdir -p 'tools'
cat > 'tools/check.mjs' <<'EVAL_SCAFFOLD_EOF'
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
EVAL_SCAFFOLD_EOF
