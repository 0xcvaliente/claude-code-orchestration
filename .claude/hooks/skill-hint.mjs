// Skill hints for a worker launch: which installed skills (skill-catalog.mjs) the plan check suggests to the worker.
// Pure: no I/O, no side effects at import, never throws. Picks hold a skill name and a short reason code only.
// Order: the brief's SKILLS names first (validated against the catalog), then strong signals only: a document
// extension in FILES or SOURCES matched to skills whose name or description names that format (a description that
// sends the format to another skill does not count), then the preference table (RULES: security, bugfix, tdd, ui_work,
// motion; each suggests the first of its skills that is installed), else a minimum score from the brief's words against
// a skill's name and description. One pick per near-duplicate family; at most 3 picks (1 for a reviewer), none for the
// integrator or any other role.

/** Picks per role; a role not listed (the integrator, anything else) gets none. @type {Record<string, number>} */
export const MAX_PICKS = { implementer: 3, researcher: 3, reviewer: 1 };

// Document extensions and the words that name each format in a skill's name or description.
/** @type {Record<string, string[]>} */
const FORMATS = {
  docx: ["docx"],
  doc: ["docx"],
  pptx: ["pptx", "powerpoint"],
  ppt: ["pptx", "powerpoint"],
  xlsx: ["xlsx", "excel", "spreadsheet", "spreadsheets"],
  xls: ["xlsx", "excel", "spreadsheet", "spreadsheets"],
  pdf: ["pdf"],
  csv: ["csv"],
};
/** The reason code of an extension (doc counts as docx, and so on). @type {Record<string, string>} */
const EXT_REASON = { docx: "ext_docx", doc: "ext_docx", pptx: "ext_pptx", ppt: "ext_pptx", xlsx: "ext_xlsx", xls: "ext_xlsx", pdf: "ext_pdf", csv: "ext_csv" };

// Configuration, scheduling and session skills: never suggested on their own (an explicit SKILLS name still passes).
const META = new Set([
  "loop", "schedule", "update-config", "keybindings-help", "init", "fewer-permission-prompts", "statusline-setup",
  "config", "permissions", "remember", "handoff", "grill-me", "git-guardrails-claude-code", "update-mattpocock-skills",
  "claude-api", "workflow-authoring", "plugin-authoring", "artifact-design", "artifact-capabilities", "artifact-diagramming",
]);
// This plugin's own skills, project copies included.
const OWN = new Set(["orchestrate", "route", "orchestration-conventions"]);

// Words that never count: brief keys, glue words, and verbs and nouns that every brief uses.
const STOP = new Set(`
slice files depends path light risky checks skills skill sources read kind bugfix validate gaps goal focus none yes
replan plan review constraints status pass fail open orchestration workflow
the and for with that this from into onto over when then than each every only also into not use uses used using
any all one two its their your you are was were will would should could can may must has have had been being does
done make makes made build builds create creates update updates write writes edit edits add adds new old file
implement implements test tests code project task work worker brief line lines run runs check text name names
need needs want wants like such other more most some same own via per after before about which what where while
user users agent agents claude tool tools hook hooks change changes slices
`.split(/\s+/).filter(Boolean));
// Name tokens too generic to signal a skill on their own.
const GENERIC = new Set(["code", "review", "design", "web", "best", "practices", "frontend", "core", "skills", "skill", "docs", "data", "react", "anthropic"]);
// Keys that, as the first part of a name, would make a hint line parse as a brief or reply line.
const BRIEF_KEYS = new Set([
  "slice", "files", "depends", "path", "risky", "checks", "focus", "sources", "read", "kind", "validate", "skills", "goal",
  "replan", "constraints", "status", "open", "gap", "quote",
]);
const NAME_RE = /^[A-Za-z0-9][\w./-]*(?::[A-Za-z0-9][\w./-]*)*$/;

/** @typedef {{ name: string, description?: string, disableModelInvocation?: boolean, contextFork?: boolean }} CatalogSkill */
/** @typedef {{ name: string, reason: string }} SkillPick */

/** @param {string} name */
const bareName = (name) => name.split(":").pop() ?? name;

/** Lower-case word tokens of at least 3 characters. @param {unknown} s */
const tokens = (s) => String(s ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3);

/**
 * Tokens of a description outside its negated clauses ("Do NOT use for PDFs, spreadsheets" names no format it serves).
 * @param {unknown} s
 */
const affirmed = (s) =>
  String(s ?? "")
    .split(/[.;:!?()\n]+/)
    .filter((c) => !/\b(?:not|never|no|don't|doesn't|isn't|except|unless|instead)\b/i.test(c))
    .flatMap(tokens);

/** A name safe to print on a hint line: a skill name whose first part is not a brief or reply key. @param {unknown} n */
export function safeName(n) {
  if (typeof n !== "string" || n.length > 100 || !NAME_RE.test(n)) return false;
  const first = (n.split(":")[0] ?? "").toLowerCase();
  // ORCHESTRATION: counts only as "ORCHESTRATION: workflow" (the scripted workflow's marker).
  if (first === "orchestration" && /^orchestration:workflow\b/i.test(n)) return false;
  return !BRIEF_KEYS.has(first) && !/^c\d+$/.test(first);
}

/** Family key parts: the first token of the bare name. @param {string} name */
const familyHead = (name) => tokens(bareName(name).replace(/[._/]/g, "-"))[0] ?? bareName(name).toLowerCase();

/**
 * Near-duplicates: the same first name token, or first tokens sharing a prefix of 5 or more characters (animate,
 * animation-performance), or a shared non-generic name token (anthropic-skills:pptx, pptx-deck).
 * @param {string} a @param {string} b
 */
export function sameFamily(a, b) {
  const [x, y] = [familyHead(a), familyHead(b)];
  if (x === y) return true;
  let n = 0;
  while (n < x.length && n < y.length && x[n] === y[n]) n++;
  if (n >= 5) return true;
  const ta = new Set(tokens(bareName(a)).filter((t) => !GENERIC.has(t)));
  return tokens(bareName(b)).some((t) => !GENERIC.has(t) && ta.has(t));
}

/** Suggestable without a SKILLS line: model-invocable, not forked, not this plugin's, not a meta skill. @param {CatalogSkill} s */
function autoOk(s) {
  if (s.disableModelInvocation || s.contextFork) return false;
  if (s.name.startsWith("orchestration:")) return false;
  const bare = bareName(s.name).toLowerCase();
  return !OWN.has(bare) && !META.has(bare) && safeName(s.name);
}

/**
 * A description that sends work in this format to another skill ("→ that format's skill", "use the docx skill",
 * "not for .pdf"): such a skill is no format match.
 * @param {unknown} desc @param {string[]} words the format's words
 */
function redirects(desc, words) {
  const d = String(desc ?? "").toLowerCase().replace(/[’']/g, "'");
  if (/that format's skill|the format's (?:own )?skill/.test(d)) return true;
  if (/\buse (?:the|a|its) [\w:.-]+ skill\b/.test(d)) return true;
  return words.some((w) => new RegExp(`\\bnot (?:for|use for|used for) [^.;]*\\b\\.?${w}\\b`).test(d));
}

// The preference table: rule -> reason code and skills in order of preference (the first installed one wins).
const UI_EXTS = new Set(["tsx", "jsx", "vue", "svelte", "css", "scss", "html"]);
const UI_WORDS = ["ui", "page", "pages", "component", "components", "layout", "layouts", "design", "landing", "style", "styles", "styling", "screen", "screens", "dashboard", "dashboards"];
const MOTION_WORDS = ["animation", "animations", "animate", "transition", "transitions", "motion"];
const BUG_WORDS = ["bug", "bugs", "fix", "fixes", "regression", "regressions", "crash", "crashes", "failing"];
const SECURITY_WORDS = ["auth", "authentication", "authorization", "login", "token", "tokens", "password", "passwords", "permission", "permissions", "crypto", "injection", "xss", "csrf", "security"];
/** @type {{ reason: string, skills: string[], roles: string[] }[]} */
const RULES = [
  { reason: "security", skills: ["security-best-practices", "security-review"], roles: ["implementer", "reviewer"] },
  { reason: "bugfix", skills: ["diagnosing-bugs", "tdd"], roles: ["implementer"] },
  { reason: "tdd", skills: ["tdd"], roles: ["implementer"] },
  { reason: "ui_work", skills: ["frontend-design", "ui-design", "web-design-guidelines"], roles: ["implementer"] },
  { reason: "motion", skills: ["animate"], roles: ["implementer"] },
];

/**
 * The preference rules that fire for a launch, in table order.
 * @param {{ role: string, files: string[], kind: string | null, risky: boolean, text: string }} a
 * @returns {{ reason: string, skills: string[] }[]}
 */
export function preferenceRules(a) {
  const lower = a.text.toLowerCase();
  const words = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  const any = (/** @type {string[]} */ list) => list.some((w) => words.has(w));
  const ui = a.files.some((f) => UI_EXTS.has(extOf(f)));
  /** @type {Record<string, boolean>} */
  const fires = {
    security: a.risky && any(SECURITY_WORDS),
    bugfix: a.kind === "bugfix" || any(BUG_WORDS),
    tdd: words.has("tdd") || /\btest[- ]first\b/.test(lower),
    ui_work: ui && any(UI_WORDS),
    motion: ui && any(MOTION_WORDS),
  };
  return RULES.filter((r) => r.roles.includes(a.role) && fires[r.reason]).map((r) => ({ reason: r.reason, skills: r.skills }));
}

/** The lower-case extension of a path or glob ("" when none). @param {string} p */
const extOf = (p) => (p.replace(/[?#].*$/, "").match(/\.([A-Za-z0-9]+)$/)?.[1] ?? "").toLowerCase();

/**
 * Skill hints for one launch.
 * @param {{ role?: string, header?: { files?: string[], sources?: string[], depends?: string[], skills?: string[], kind?: string | null, risky?: boolean }, brief?: string, catalog?: CatalogSkill[] }} args
 * @returns {SkillPick[]}
 */
export function skillHints(args) {
  try {
    const role = String(args?.role ?? "").split(":").pop() ?? "";
    const max = MAX_PICKS[role] ?? 0;
    if (!max) return [];
    const header = args?.header ?? {};
    const catalog = (Array.isArray(args?.catalog) ? args.catalog : []).filter((s) => s && typeof s.name === "string" && s.name);
    /** @type {SkillPick[]} */
    const picks = [];
    const taken = new Set();
    /** @param {string} name @param {string} reason */
    const add = (name, reason) => {
      if (picks.length >= max || taken.has(name) || !safeName(name)) return;
      taken.add(name);
      picks.push({ name, reason });
    };

    // 1. Explicit SKILLS names, validated against the catalog (exact, any case, or a unique bare name).
    for (const want of Array.isArray(header.skills) ? header.skills : []) {
      if (typeof want !== "string") continue;
      const w = want.toLowerCase();
      const bareMatches = catalog.filter((s) => bareName(s.name).toLowerCase() === w);
      const hit = catalog.find((s) => s.name === want) ?? catalog.find((s) => s.name.toLowerCase() === w) ?? (!want.includes(":") && bareMatches.length === 1 ? bareMatches[0] : undefined);
      if (!hit) add(want, "explicit_not_found");
      else if (hit.disableModelInvocation) add(hit.name, "explicit_not_invocable");
      else add(hit.name, "explicit");
    }

    const pool = catalog.filter(autoOk);
    /** @param {CatalogSkill} s */
    const fresh = (s) => !taken.has(s.name) && !picks.some((p) => sameFamily(p.name, s.name));

    // 2. Document extensions in FILES or SOURCES: skills naming the format in their name first, then in the description.
    const paths = [...(Array.isArray(header.files) ? header.files : []), ...(Array.isArray(header.sources) ? header.sources : [])].filter((p) => typeof p === "string");
    const exts = [...new Set(paths.map(extOf).filter((e) => e in FORMATS))];
    // Name matches of every format come before any description match, so two formats each get their own skill.
    /** @type {{ s: CatalogSkill, reason: string }[]} */
    const byName = [];
    /** @type {{ s: CatalogSkill, reason: string }[]} */
    const byDesc = [];
    for (const ext of exts) {
      const words = FORMATS[ext] ?? [];
      const reason = EXT_REASON[ext] ?? `ext_${ext}`;
      const named = pool.filter((s) => tokens(bareName(s.name)).some((t) => words.includes(t))).sort((a, b) => a.name.localeCompare(b.name));
      byName.push(...named.map((s) => ({ s, reason })));
      const described = pool
        .filter((s) => !named.includes(s) && !redirects(s.description, words))
        .map((s) => ({ s, n: affirmed(s.description).filter((t) => words.includes(t)).length }))
        .filter((x) => x.n > 0)
        .sort((a, b) => b.n - a.n || a.s.name.localeCompare(b.s.name));
      byDesc.push(...described.map((x) => ({ s: x.s, reason })));
    }
    for (const { s, reason } of [...byName, ...byDesc]) if (fresh(s)) add(s.name, reason);

    let text = String(args?.brief ?? "");
    // Paths and names already used above are not words of the task.
    for (const v of [...paths, ...(Array.isArray(header.depends) ? header.depends : []), ...(Array.isArray(header.skills) ? header.skills : [])]) {
      if (typeof v === "string" && v) text = text.split(v).join(" ");
    }

    // 3. No format signal: the brief's words against name and description, above a minimum score. The best match comes
    // before the preference table (it names the task more precisely), the rest after it.
    /** @type {CatalogSkill[]} */
    let goal = [];
    if (!exts.length) {
      const words = new Set(tokens(text).filter((t) => !STOP.has(t)));
      const scored = pool
        .map((s) => {
          const nameToks = [...new Set(tokens(bareName(s.name)))].filter((t) => !STOP.has(t) && !GENERIC.has(t));
          const nameHits = nameToks.filter((t) => words.has(t)).length;
          const descHits = [...new Set(tokens(s.description))].filter((t) => t.length >= 4 && !STOP.has(t) && !nameToks.includes(t) && words.has(t)).length;
          return { s, nameHits, descHits, score: 3 * nameHits + descHits };
        })
        .filter((x) => x.nameHits >= 1 && x.descHits >= 2 && x.score >= 5)
        .sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
      goal = scored.map((x) => x.s);
    }
    const best = goal.find(fresh);
    if (best) add(best.name, "goal_match");

    // 4. The preference table: each rule that fires suggests the first of its skills that is installed (and suggestable).
    const files = (Array.isArray(header.files) ? header.files : []).filter((p) => typeof p === "string");
    const fired = preferenceRules({ role, files, kind: typeof header.kind === "string" ? header.kind : null, risky: header.risky === true, text });
    for (const rule of fired) {
      const s = rule.skills.map((n) => pool.find((x) => x.name === n)).find((x) => x !== undefined);
      if (s && fresh(s)) add(s.name, rule.reason);
    }

    // 5. The remaining goal matches.
    for (const s of goal) if (fresh(s)) add(s.name, "goal_match");
    return picks;
  } catch {
    return [];
  }
}

/** The intro line of the hint block. */
export const HINT_INTRO = "Suggested skills (plan check): load each with the Skill tool before you start if it fits the slice; if one does not fit, skip it and say so in one line of your report, not under OPEN.";

/**
 * The block appended to a brief: a blank line, the intro, one bullet per pick (name and reason code only). "" for no
 * picks.
 * @param {SkillPick[]} picks
 */
export function hintBlock(picks) {
  const rows = (Array.isArray(picks) ? picks : []).filter((p) => p && safeName(p.name) && /^[a-z0-9_]+$/.test(String(p.reason))).map((p) => `- ${p.name} (${p.reason})`);
  return rows.length ? ["", "", HINT_INTRO, ...rows].join("\n") : "";
}
