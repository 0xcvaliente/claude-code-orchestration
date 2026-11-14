// Skill hints: skill-catalog.mjs (installed skills), skill-hint.mjs (picks) and their use in plan-check.mjs, run as a
// hook in a throwaway project. Every catalog here comes from temp roots (a temp CLAUDE_CONFIG_DIR or ORCH_SKILL_ROOTS),
// never the real HOME.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { skillCatalog, skillRoots, frontmatter } from "../.claude/hooks/skill-catalog.mjs";
import { skillHints, hintBlock, sameFamily, safeName, preferenceRules, HINT_INTRO } from "../.claude/hooks/skill-hint.mjs";
import { parseHeader, parseReply } from "../.claude/hooks/brief.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const fx = (/** @type {string} */ f) => join(root, "src", "fixtures", "files", f);

/** @param {string} dir @param {string} folder @param {string} body */
function skill(dir, folder, body) {
  mkdirSync(join(dir, folder), { recursive: true });
  writeFileSync(join(dir, folder, "SKILL.md"), body);
  return join(dir, folder, "SKILL.md");
}
/** @param {Record<string, string | boolean>} fm */
const md = (fm) => `---\n${Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\nBody text that is never parsed.\n`;
const temp = (/** @type {string} */ p) => mkdtempSync(join(tmpdir(), p));

// ---------------------------------------------------------------------------------------------------- catalog

test("catalog: user, synced, project and enabled plugin skills; disabled plugins and dot folders skipped", () => {
  const cfg = temp("skills-cfg-");
  const proj = temp("skills-proj-");
  try {
    skill(join(cfg, "skills"), "user-a", md({ name: "user-alpha", description: "Alpha things." }));
    skill(join(cfg, "skills"), "plain", md({ description: "No name: the folder names it." }));
    skill(join(cfg, "skills", "synced", "uuid-1"), "docx", md({ name: "docx", description: "Word .docx files." }));
    skill(join(cfg, "skills", "synced", ".bucket-uuid-1"), "hidden", md({ name: "hidden", description: "x" }));
    skill(join(cfg, "skills", ".dot"), "x", md({ name: "x", description: "x" }));
    skill(join(proj, ".claude", "skills"), "proj-skill", md({ name: "proj-skill", description: "Project skill." }));
    for (const p of ["good", "off", "local-off", "mine"]) skill(join(cfg, "plugins", "cache", p, "skills"), `${p}-s`, md({ description: `${p} skill` }));
    skill(join(cfg, "plugins", "cache", "other-proj", "skills"), "wrong", md({ description: "another project's install" }));
    mkdirSync(join(cfg, "plugins"), { recursive: true });
    const entry = (/** @type {string} */ p, extra = {}) => ({ scope: "user", installPath: join(cfg, "plugins", "cache", p), version: "1", ...extra });
    writeFileSync(
      join(cfg, "plugins", "installed_plugins.json"),
      JSON.stringify({
        version: 2,
        plugins: {
          "good@m": [entry("good")],
          "off@m": [entry("off")],
          "local-off@m": [entry("local-off")],
          "mine@m": [entry("other-proj", { scope: "project", projectPath: "/elsewhere" }), entry("mine", { scope: "project", projectPath: proj })],
          "absent@m": [entry("absent")],
        },
      }),
    );
    writeFileSync(join(cfg, "settings.json"), JSON.stringify({ enabledPlugins: { "good@m": true, "off@m": false, "local-off@m": true } }));
    mkdirSync(join(proj, ".claude"), { recursive: true });
    writeFileSync(join(proj, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: { "mine@m": true } }));
    writeFileSync(join(proj, ".claude", "settings.local.json"), JSON.stringify({ enabledPlugins: { "local-off@m": false } }));

    const env = { CLAUDE_CONFIG_DIR: cfg };
    const names = skillCatalog({ env, projectDir: proj }).map((s) => s.name);
    assert.deepEqual(names.sort(), ["anthropic-skills:docx", "good:good-s", "mine:mine-s", "plain", "proj-skill", "user-alpha"].sort());
    const docx = skillCatalog({ env, projectDir: proj }).find((s) => s.name === "anthropic-skills:docx");
    assert.equal(docx?.description, "Word .docx files.");
    assert.equal(docx?.path, join(cfg, "skills", "synced", "uuid-1", "docx", "SKILL.md"));
  } finally {
    rmSync(cfg, { recursive: true, force: true });
    rmSync(proj, { recursive: true, force: true });
  }
});

test("catalog: symlinked skill folders are followed; broken links, files and missing roots are skipped", () => {
  const dir = temp("skills-link-");
  try {
    const outside = join(dir, "outside");
    skill(outside, "real", md({ name: "linked-skill", description: "Reached through a symlink." }));
    mkdirSync(join(dir, "root"), { recursive: true });
    symlinkSync(join(outside, "real"), join(dir, "root", "linked"));
    symlinkSync(join(dir, "nowhere"), join(dir, "root", "broken"));
    writeFileSync(join(dir, "root", "file.md"), "not a folder");
    mkdirSync(join(dir, "root", "empty"));
    const env = { ORCH_SKILL_ROOTS: [join(dir, "root"), join(dir, "missing")].join(process.platform === "win32" ? ";" : ":") };
    const cat = skillCatalog({ env });
    assert.deepEqual(cat.map((s) => s.name), ["linked-skill"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog: frontmatter flags, quoted and folded values; malformed frontmatter never throws", () => {
  const dir = temp("skills-fm-");
  try {
    const r = join(dir, "r");
    skill(r, "dmi", md({ name: "dmi", description: '"Quoted: with colon."', "disable-model-invocation": true }));
    skill(r, "forked", md({ name: "forked", description: "'It''s forked.'", context: "fork" }));
    skill(r, "folded", "---\nname: folded\ndescription: >\n  First line\n  second line.\n---\n");
    skill(r, "noclose", "---\nname: wrong-name\ndescription: never closed\n");
    skill(r, "nofm", "# Just a heading\n");
    skill(r, "badname", md({ name: "has spaces in it", description: "Name is not a skill name." }));
    writeFileSync(join(r, "nofm", "SKILL.md"), Buffer.from([0xff, 0xfe, 0x00, 0x01]));
    const cat = skillCatalog({ env: { ORCH_SKILL_ROOTS: r } });
    const by = Object.fromEntries(cat.map((s) => [s.name, s]));
    assert.deepEqual(Object.keys(by).sort(), ["badname", "dmi", "folded", "forked", "noclose", "nofm"]);
    assert.equal(by.dmi?.disableModelInvocation, true);
    assert.equal(by.dmi?.description, "Quoted: with colon.");
    assert.equal(by.forked?.contextFork, true);
    assert.equal(by.forked?.description, "It's forked.");
    assert.equal(by.folded?.description, "First line second line.");
    assert.equal(by.noclose?.description, "", "an unclosed frontmatter is ignored: the folder names it");
    assert.equal(by.nofm?.description, "");
    assert.deepEqual(frontmatter(/** @type {any} */ (null)), {});
    assert.deepEqual(skillCatalog(/** @type {any} */ ({ env: { ORCH_SKILL_ROOTS: "\0bad" } })), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog: cached in the state dir by SKILL.md paths and mtimes; an edit refreshes it", () => {
  const dir = temp("skills-cache-");
  try {
    const r = join(dir, "r");
    const cache = join(dir, "state");
    const file = skill(r, "one", md({ name: "one", description: "First." }));
    const env = { ORCH_SKILL_ROOTS: r };
    assert.equal(skillCatalog({ env, cacheDir: cache })[0]?.description, "First.");
    const cf = join(cache, "skill-catalog.json");
    assert.ok(existsSync(cf));
    // Same key: the cached list is used (proved by tampering with it).
    const c = JSON.parse(readFileSync(cf, "utf8"));
    c.skills[0].description = "From the cache.";
    writeFileSync(cf, JSON.stringify(c));
    assert.equal(skillCatalog({ env, cacheDir: cache })[0]?.description, "From the cache.");
    // An edited SKILL.md (new mtime) parses again.
    writeFileSync(file, md({ name: "one", description: "Second." }));
    const later = new Date(Date.now() + 5000);
    utimesSync(file, later, later);
    assert.equal(skillCatalog({ env, cacheDir: cache })[0]?.description, "Second.");
    // A new skill changes the path list.
    skill(r, "two", md({ name: "two", description: "Two." }));
    assert.deepEqual(skillCatalog({ env, cacheDir: cache }).map((s) => s.name), ["one", "two"]);
    // A corrupt cache is ignored.
    writeFileSync(cf, "{not json");
    assert.equal(skillCatalog({ env, cacheDir: cache }).length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog: ORCH_SKILL_ROOTS replaces the roots; <ns>=<dir> namespaces them", () => {
  const roots = skillRoots({ env: { ORCH_SKILL_ROOTS: ["/a", "p=/b"].join(process.platform === "win32" ? ";" : ":"), CLAUDE_CONFIG_DIR: "/cfg" } });
  assert.deepEqual(roots, [{ dir: "/a", ns: null }, { dir: "/b", ns: "p" }]);
});

// ---------------------------------------------------------------------------------------------------- picks

/** @type {import("../.claude/hooks/skill-hint.mjs").CatalogSkill[]} */
const CATALOG = [
  { name: "anthropic-skills:docx", description: "Create or edit Word documents (.docx). Do NOT use for PDFs, spreadsheets or slides." },
  { name: "anthropic-skills:pptx", description: "Any time a .pptx file is involved: slide decks and presentations." },
  { name: "anthropic-skills:xlsx", description: "Spreadsheets: .xlsx, .xlsm, .csv files, formulas and charts." },
  { name: "anthropic-skills:pdf", description: "Read, fill and create PDF files." },
  { name: "pptx-deck", description: "Build PowerPoint .pptx decks from a brief." },
  { name: "documents", description: "Office files - Word (.docx), spreadsheets (.xlsx, .csv), slide decks (.pptx), PDF." },
  { name: "gsap-core", description: "Implement or debug GSAP tweens, easing, staggers and reduced motion." },
  { name: "gsap-scrolltrigger", description: "GSAP ScrollTrigger scroll animation: scrubbing, pinning, trigger geometry." },
  { name: "gsap-timeline", description: "GSAP timelines, labels, nesting and playback controls for animation." },
  { name: "animate", description: "Web UI animation and transitions with timing, interruption and reduced motion." },
  { name: "animation-performance", description: "Fix web animation jank: composite properties, transforms, opacity." },
  { name: "tdd", description: "Test-driven development with red-green-refactor loops." },
  { name: "secret-tool", description: "Handles docx and gsap animation scrolltrigger.", disableModelInvocation: true },
  { name: "forked-docx", description: "Runs .docx work in a fork.", contextFork: true },
  { name: "orchestration:route", description: "Route a .docx task with gsap scrolltrigger animation." },
  { name: "route", description: "Project copy of route for .docx and gsap scrolltrigger animation." },
  { name: "loop", description: "Run gsap scrolltrigger animation .docx on a loop." },
  { name: "update-config", description: "Configure docx gsap scrolltrigger animation settings." },
  { name: "slice:evil", description: "A plugin named slice: its lines would parse as SLICE lines .docx." },
];
/** @param {string} role @param {string} brief */
const picks = (role, brief, catalog = CATALOG) => skillHints({ role, header: parseHeader(brief), brief, catalog });

test("picks: document extensions in FILES or SOURCES pick format skills, name matches first, one per family", () => {
  assert.deepEqual(picks("implementer", "SLICE: a\nFILES: out/report.docx\nDEPENDS: none\nWrite it."), [
    { name: "anthropic-skills:docx", reason: "ext_docx" },
    { name: "documents", reason: "ext_docx" },
  ]);
  assert.deepEqual(picks("implementer", "SLICE: a\nFILES: deck.pptx\nDEPENDS: none"), [
    { name: "anthropic-skills:pptx", reason: "ext_pptx" },
    { name: "documents", reason: "ext_pptx" },
  ], "pptx-deck is the same family as anthropic-skills:pptx");
  assert.deepEqual(picks("researcher", "SOURCES: book.xlsx\nREAD: extract\nSum column B."), [
    { name: "anthropic-skills:xlsx", reason: "ext_xlsx" },
    { name: "documents", reason: "ext_xlsx" },
  ], "a negated mention (docx: Do NOT use for spreadsheets) is not a match");
  assert.deepEqual(picks("researcher", "SOURCES: a.pdf\nWhat is the total?"), [
    { name: "anthropic-skills:pdf", reason: "ext_pdf" },
    { name: "documents", reason: "ext_pdf" },
  ]);
  assert.deepEqual(picks("researcher", "SOURCES: a.pdf, b.xlsx\nQ").map((p) => p.name), ["anthropic-skills:pdf", "anthropic-skills:xlsx", "documents"], "each format gets its own skill first");
  assert.deepEqual(picks("implementer", "SLICE: a\nFILES: data/in.csv\nDEPENDS: none").map((p) => p.reason), ["ext_csv", "ext_csv"]);
});

test("picks: explicit SKILLS names first (found, not found, not invocable), then the cap", () => {
  assert.deepEqual(picks("implementer", "SLICE: a\nFILES: x.ts\nDEPENDS: none\nSKILLS: tdd, nope:missing, docx\nFix it."), [
    { name: "tdd", reason: "explicit" },
    { name: "nope:missing", reason: "explicit_not_found" },
    { name: "anthropic-skills:docx", reason: "explicit" },
  ], "a bare name that names one installed skill resolves to it");
  assert.deepEqual(picks("implementer", "SLICE: a\nFILES: x.docx\nDEPENDS: none\nSKILLS: secret-tool"), [
    { name: "secret-tool", reason: "explicit_not_invocable" },
    { name: "anthropic-skills:docx", reason: "ext_docx" },
    { name: "documents", reason: "ext_docx" },
  ]);
  assert.deepEqual(picks("implementer", "SLICE: a\nFILES: x.ts\nDEPENDS: none\nSKILLS: orchestration:route, slice:evil"), [{ name: "orchestration:route", reason: "explicit" }], "a brief-key name is never printed");
  assert.equal(picks("implementer", "SLICE: a\nFILES: x.ts\nDEPENDS: none\nSKILLS: a1, a2, a3, a4, a5").length, 3);
});

test("picks: goal words need a strong match; one pick per near-duplicate family", () => {
  const brief = "SLICE: hero\nFILES: src/hero.tsx\nDEPENDS: none\nGOAL: add a GSAP ScrollTrigger pinned scroll animation with scrubbing and a timeline";
  assert.deepEqual(picks("implementer", brief), [{ name: "gsap-scrolltrigger", reason: "goal_match" }, { name: "animate", reason: "motion" }], "the best goal match first, then the motion rule");
  assert.ok(sameFamily("gsap-core", "gsap-timeline"));
  assert.ok(sameFamily("animate", "animation-performance"));
  assert.ok(sameFamily("anthropic-skills:pptx", "pptx-deck"));
  assert.ok(!sameFamily("anthropic-skills:docx", "documents"));
  assert.ok(!sameFamily("anthropic-skills:pdf", "anthropic-skills:docx"));
  assert.deepEqual(picks("implementer", "SLICE: a\nFILES: src/parser.ts\nDEPENDS: none\nRename the parser option."), [], "no strong signal, no picks");
  assert.deepEqual(picks("implementer", "SLICE: a\nFILES: src/x.ts\nDEPENDS: none\nMake the animation smoother."), [], "one word is not enough");
});

test("picks: reviewer cap 1, nothing for the integrator or unknown roles, exclusions hold", () => {
  assert.deepEqual(picks("reviewer", "SLICE: a\nReview the change to report.docx."), []);
  assert.deepEqual(picks("orchestration:reviewer", "SLICE: a\nSOURCES: report.docx\nReview it.").length, 1);
  assert.deepEqual(picks("reviewer", "SLICE: a\nSKILLS: tdd, documents\nReview."), [{ name: "tdd", reason: "explicit" }]);
  assert.deepEqual(picks("integrator", "SLICE: a\nFILES: a.docx\nSKILLS: tdd\nMerge."), []);
  assert.deepEqual(picks("orchestration:integrator", "SLICE: a\nFILES: a.docx"), []);
  assert.deepEqual(picks("general-purpose", "SLICE: a\nFILES: a.docx"), []);
  // Only excluded skills match: nothing comes back.
  const excluded = CATALOG.filter((s) => s.disableModelInvocation || s.contextFork || ["orchestration:route", "route", "loop", "update-config", "slice:evil"].includes(s.name));
  assert.deepEqual(picks("implementer", "SLICE: a\nFILES: a.docx\nDEPENDS: none\nGOAL: gsap scrolltrigger animation loop config", excluded), []);
  assert.deepEqual(skillHints(/** @type {any} */ (null)), []);
  assert.deepEqual(skillHints(/** @type {any} */ ({ role: "implementer", header: { files: [1, null] }, catalog: [null, 3] })), []);
});

test("hint block: names and reason codes only; no line parses as a brief or reply line", () => {
  const p = picks("implementer", "SLICE: a\nFILES: a.docx\nDEPENDS: none\nSKILLS: nope");
  const block = hintBlock(p);
  assert.ok(block.startsWith(`\n\n${HINT_INTRO}\n`));
  assert.match(HINT_INTRO, /say so in one line of your report, not under OPEN\.$/, "a skipped suggestion is no OPEN item (a doubt signal)");
  assert.deepEqual(block.split("\n").slice(3), ["- nope (explicit_not_found)", "- anthropic-skills:docx (ext_docx)", "- documents (ext_docx)"]);
  for (const s of CATALOG) if (s.description) assert.ok(!block.includes(s.description.slice(0, 20)), "no description text");
  assert.ok(!/https?:/.test(block));
  const h = parseHeader(block);
  assert.deepEqual([h.slice, h.files, h.depends, h.skills, h.sources, h.checks, h.path, h.read, h.kind, h.focus, h.risky, h.validate, h.workflow], [null, [], [], [], [], [], null, null, null, null, false, false, false]);
  const r = parseReply(block);
  assert.deepEqual([r.status, r.open, r.answers, r.gaps, r.quotes], [null, [], {}, [], []]);
  for (const l of block.split("\n")) assert.ok(!/^[\s>*_`#-]*(SKILLS|SLICE|FILES|DEPENDS|STATUS|OPEN|GOAL|CHECKS|SOURCES|GAP|QUOTE|C\d+):/i.test(l), l);
  assert.equal(hintBlock([{ name: "slice:x", reason: "explicit" }, { name: "ok", reason: "bad reason!" }]), "");
  assert.ok(!safeName("FILES:x") && !safeName("orchestration:workflow") && safeName("orchestration:route") && !safeName("c1:x") && !safeName("a b") && safeName("anthropic-skills:docx"));
});

// ---------------------------------------------------------------------------------------------------- preference table

/** A catalog read from a temp root (user skills plus anthropic-skills synced ones). @param {(user: string, synced: string) => void} fill */
function tempCatalog(fill) {
  const dir = temp("skills-pref-");
  try {
    const user = join(dir, "user");
    const synced = join(dir, "synced");
    mkdirSync(user, { recursive: true });
    mkdirSync(synced, { recursive: true });
    fill(user, synced);
    const sep = process.platform === "win32" ? ";" : ":";
    return skillCatalog({ env: { ORCH_SKILL_ROOTS: [user, `anthropic-skills=${synced}`].join(sep) } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const PREF = tempCatalog((user, synced) => {
  for (const [n, d] of /** @type {[string, string][]} */ ([
    ["frontend-design", "Distinctive visual design for new UI."],
    ["ui-design", "Designs and builds React UI."],
    ["web-design-guidelines", "Review web interfaces."],
    ["animate", "Build web UI animations and transitions."],
    ["diagnosing-bugs", "Diagnosis loop for hard bugs."],
    ["tdd", "Test-driven development."],
    ["security-best-practices", "Security reviews and secure-by-default coding."],
    ["documents", "Office files: Word (.docx), slides (.pptx), PDF."],
  ])) skill(user, n, md({ name: n, description: d }));
  skill(synced, "docx", md({ name: "docx", description: '"Word documents (.docx). Do NOT use for PDFs."' }));
  skill(synced, "docs", md({ name: "docs", description: "'Editable docs; exports to Word or PDF; a .docx to change or use as a template → that format''s skill.'" }));
});

test("preference table: ui_work, motion, bugfix, tdd and security pick the first installed skill of each rule", () => {
  const p = (/** @type {string} */ role, /** @type {string} */ brief, catalog = PREF) => skillHints({ role, header: parseHeader(brief), brief, catalog });
  assert.deepEqual(p("implementer", "SLICE: hero\nFILES: src/Hero.tsx, src/hero.css\nDEPENDS: none\nGOAL: build the landing page hero component"), [{ name: "frontend-design", reason: "ui_work" }]);
  assert.deepEqual(p("implementer", "SLICE: m\nFILES: src/Menu.vue\nDEPENDS: none\nGOAL: add a slide-in transition to the menu"), [{ name: "animate", reason: "motion" }]);
  assert.deepEqual(p("implementer", "SLICE: m\nFILES: src/menu.ts\nDEPENDS: none\nGOAL: add a slide-in transition to the menu"), [], "motion needs a UI extension");
  assert.deepEqual(p("implementer", "SLICE: p\nFILES: toolkit/parse.py\nDEPENDS: none\nGOAL: fix the crash on empty input"), [{ name: "diagnosing-bugs", reason: "bugfix" }]);
  assert.deepEqual(p("implementer", "SLICE: p\nFILES: toolkit/parse.py\nDEPENDS: none\nKIND: bugfix\nGOAL: empty input"), [{ name: "diagnosing-bugs", reason: "bugfix" }], "KIND: bugfix alone fires");
  assert.deepEqual(p("implementer", "SLICE: p\nFILES: toolkit/parse.py\nDEPENDS: none\nKIND: bugfix\nGOAL: work test-first"), [{ name: "diagnosing-bugs", reason: "bugfix" }, { name: "tdd", reason: "tdd" }]);
  assert.deepEqual(p("implementer", "SLICE: q\nFILES: q.py\nDEPENDS: none\nGOAL: add the parser with tdd"), [{ name: "tdd", reason: "tdd" }]);
  const noDiag = PREF.filter((s) => s.name !== "diagnosing-bugs");
  assert.deepEqual(p("implementer", "SLICE: p\nFILES: p.py\nDEPENDS: none\nGOAL: fix the regression", noDiag), [{ name: "tdd", reason: "bugfix" }], "the next installed skill of the rule");
  assert.deepEqual(p("implementer", "SLICE: p\nFILES: p.py\nDEPENDS: none\nGOAL: fix the regression", PREF.filter((s) => !["diagnosing-bugs", "tdd"].includes(s.name))), [], "a rule with no installed skill gives nothing");
  const noFrontend = PREF.filter((s) => s.name !== "frontend-design");
  assert.deepEqual(p("implementer", "SLICE: d\nFILES: app/page.jsx\nDEPENDS: none\nGOAL: dashboard layout", noFrontend), [{ name: "ui-design", reason: "ui_work" }]);
  // Security: RISKY plus a security word; implementers and reviewers (cap 1).
  const auth = "SLICE: auth\nFILES: src/auth/login.ts\nDEPENDS: none\nRISKY: yes\nGOAL: rotate the session token on login and fix the failing check";
  assert.deepEqual(p("implementer", auth), [{ name: "security-best-practices", reason: "security" }, { name: "diagnosing-bugs", reason: "bugfix" }]);
  assert.deepEqual(p("reviewer", "SLICE: auth\nRISKY: yes\nReview the password reset change and fix suggestions."), [{ name: "security-best-practices", reason: "security" }], "reviewer: security only, cap 1");
  assert.deepEqual(p("reviewer", "SLICE: auth\nReview the password reset change."), [], "security needs RISKY");
  assert.deepEqual(p("reviewer", "SLICE: x\nFILES: a.tsx\nRISKY: yes\nReview the landing page and the bug fix."), [], "other rules are not for reviewers");
  assert.deepEqual(p("researcher", auth), [], "rules are not for researchers");
  assert.deepEqual(p("integrator", auth), []);
  // Caps and explicit names first.
  const all = "SLICE: x\nFILES: src/App.tsx\nDEPENDS: none\nRISKY: yes\nKIND: bugfix\nGOAL: tdd fix for the login page animation";
  assert.deepEqual(p("implementer", all).map((x) => x.reason), ["security", "bugfix", "tdd"]);
  assert.deepEqual(p("implementer", `${all}\nSKILLS: documents`).map((x) => x.reason), ["explicit", "security", "bugfix"]);
  assert.deepEqual(preferenceRules({ role: "implementer", files: ["a.html"], kind: null, risky: false, text: "style the screen" }).map((r) => r.reason), ["ui_work"]);
});

test("format picks: a skill whose description sends the format to another skill is skipped", () => {
  const p = (/** @type {string} */ brief) => skillHints({ role: "implementer", header: parseHeader(brief), brief, catalog: PREF });
  assert.equal(PREF.find((s) => s.name === "anthropic-skills:docs")?.description.includes("that format's skill"), true);
  assert.deepEqual(p("SLICE: r\nFILES: out/report.docx\nDEPENDS: none\nWrite it."), [
    { name: "anthropic-skills:docx", reason: "ext_docx" },
    { name: "documents", reason: "ext_docx" },
  ], "no anthropic-skills:docs");
  assert.deepEqual(p("SLICE: r\nFILES: out/report.pdf\nDEPENDS: none\nWrite it.").map((x) => x.name), ["documents"], "docx says not for PDFs, docs redirects");
});

// ---------------------------------------------------------------------------------------------------- plan-check

const HOOKS = ["state.mjs", "brief.mjs", "run.mjs", "plan-check.mjs", "builtin-agents.mjs", "file-profile.mjs", "skill-catalog.mjs", "skill-hint.mjs"];
/** A throwaway project with the hooks, a haiku researcher agent file, a fixture text file and a temp skills root. */
function project({ hooks = HOOKS, reviewed = false } = {}) {
  const dir = temp("skills-e2e-");
  mkdirSync(join(dir, ".claude", "hooks"), { recursive: true });
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  for (const h of hooks) copyFileSync(join(root, ".claude", "hooks", h), join(dir, ".claude", "hooks", h));
  writeFileSync(join(dir, ".claude", "agents", "researcher.md"), "---\nname: researcher\nmodel: haiku\n---\nbody\n");
  copyFileSync(fx("plain.txt"), join(dir, "plain.txt"));
  const skills = join(dir, "skills-root");
  skill(skills, "docx", md({ name: "docx", description: "SECRET-DESCRIPTION Word .docx files." }));
  skill(skills, "documents", md({ name: "documents", description: "Office files: Word (.docx), slides (.pptx) and PDF." }));
  skill(skills, "tdd", md({ name: "tdd", description: "Test-driven development." }));
  if (reviewed) {
    mkdirSync(join(dir, ".claude", "state"), { recursive: true });
    writeFileSync(join(dir, ".claude", "state", "journal.jsonl"), `${JSON.stringify({ ts: "t", session_id: "s1", slice: "plan", role: "reviewer", status: "pass", agent_id: "r0" })}\n`);
  }
  return dir;
}
const CLEAR = ["ORCH_SKILL_HINTS", "CLAUDE_PLUGIN_OPTION_SKILL_HINTS", "ORCH_SKILL_ROOTS", "ORCH_READ_ROUTER", "ORCH_READ_ROUTER_BUDGET_MS", "ORCH_ALLOW_BUILTINS", "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_PLUGIN_ROOT", "ORCH_STALL_GATE"];
/** @param {string} dir @param {unknown} payload @param {Record<string, string>} [env] */
function hook(dir, payload, env = {}) {
  const base = { ...process.env };
  for (const k of CLEAR) delete base[k];
  for (const k of Object.keys(base)) if (k.startsWith("CLAUDE_PLUGIN_OPTION_")) delete base[k];
  return spawnSync(process.execPath, [join(dir, ".claude", "hooks", "plan-check.mjs")], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    // ORCH_ALLOW_HAIKU: the project's researcher file says haiku, and these tests are about hints and the router, not the haiku rule.
    env: { ...base, CLAUDE_PROJECT_DIR: dir, CLAUDE_CONFIG_DIR: join(dir, "no-config"), ORCH_SKILL_ROOTS: join(dir, "skills-root"), ORCH_ALLOW_HAIKU: "1", ...env },
    encoding: "utf8",
  });
}
/** @param {string} dir @param {string} type @param {string} prompt @param {Record<string, string>} [env] @param {Record<string, unknown>} [more] */
const launch = (dir, type, prompt, env = {}, more = {}) => hook(dir, { session_id: "s1", tool_name: "Agent", tool_input: { subagent_type: type, prompt, ...more } }, env);
/** @param {string} dir @param {string} name @returns {any[]} */
const logOf = (dir, name) => {
  const f = join(dir, ".claude", "state", name);
  return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
/** @param {{ stdout: string }} r */
const out = (r) => JSON.parse(r.stdout).hookSpecificOutput;
/** A plan-check.jsonl record without its timestamp. @param {any} e */
const noTs = ({ ts, ...rest }) => rest;
const DOCX = "SLICE: a\nFILES: out/report.docx\nDEPENDS: none\nPATH: light\nWrite the report.";

test("plan check: an implementer allow (light_path or ok) gets the hint block in an allow with updatedInput", () => {
  const dir = project();
  try {
    const r = launch(dir, "implementer", DOCX, {}, { description: "d" });
    assert.equal(r.status, 0);
    const o = out(r);
    assert.equal(o.permissionDecision, "allow");
    assert.equal(o.updatedInput.description, "d");
    assert.equal(o.updatedInput.subagent_type, "implementer");
    assert.equal("model" in o.updatedInput, false, "a hint never sets a model");
    assert.equal(o.updatedInput.prompt, `${DOCX}\n\n${HINT_INTRO}\n- docx (ext_docx)\n- documents (ext_docx)`);
    assert.ok(!o.updatedInput.prompt.includes("SECRET-DESCRIPTION"));
    const log = logOf(dir, "plan-check.jsonl");
    assert.deepEqual(log.map((e) => e.reason), ["light_path"]);
    assert.deepEqual(Object.keys(log[0]).sort(), ["agent_type", "decision", "depends", "files", "reason", "run", "session_id", "skips", "slice", "ts"], "the launch record is unchanged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const rev = project({ reviewed: true });
  try {
    const o = out(launch(rev, "orchestration:implementer", "SLICE: b\nFILES: b.docx\nDEPENDS: none\nSKILLS: tdd, ghost", { ORCH_SKILL_HINTS: "on" }, { model: "opus" }));
    assert.equal(o.updatedInput.model, "opus", "the model is kept as chosen");
    assert.match(o.updatedInput.prompt, /\n- tdd \(explicit\)\n- ghost \(explicit_not_found\)\n- docx \(ext_docx\)$/);
    assert.deepEqual(logOf(rev, "plan-check.jsonl").map((e) => e.reason), ["ok"]);
  } finally {
    rmSync(rev, { recursive: true, force: true });
  }
});

test("plan check: blocks still block and give-up allows get no hints", () => {
  const dir = project({ reviewed: true });
  try {
    const noLines = "FILES: a.docx\nWrite it.";
    for (let i = 0; i < 2; i++) {
      const b = launch(dir, "implementer", noLines);
      assert.equal(b.status, 2);
      assert.equal(b.stdout, "");
    }
    const gaveUp = launch(dir, "implementer", noLines);
    assert.equal(gaveUp.status, 0);
    assert.equal(gaveUp.stdout, "", "missing_lines_gave_up: no hints");
    assert.equal(logOf(dir, "plan-check.jsonl").at(-1).reason, "missing_lines_gave_up");
    assert.notEqual(launch(dir, "implementer", "SLICE: a\nFILES: a.docx\nDEPENDS: none").stdout, "");
    const clash = launch(dir, "implementer", "SLICE: b\nFILES: a.docx\nDEPENDS: none");
    assert.equal(clash.status, 2);
    assert.equal(clash.stdout, "");
    assert.match(clash.stderr, /owned by a/);
    assert.equal(launch(dir, "other-plugin:implementer", "SLICE: c\nFILES: c.docx\nDEPENDS: none").stdout, "", "another plugin's implementer: checked, never hinted");
    assert.equal(logOf(dir, "plan-check.jsonl").at(-1).reason, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan check: a researcher gets the router's model and the hints in one updatedInput; a reviewer gets one hint", () => {
  const dir = project();
  try {
    const brief = "SOURCES: plain.txt\nRISKY: yes\nSKILLS: tdd\nWhat does it say?";
    const r = launch(dir, "researcher", brief, { ORCH_READ_ROUTER: "on" });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim().split("\n").length, 1, "one JSON object");
    const o = out(r);
    assert.equal(o.permissionDecision, "allow");
    assert.equal(o.updatedInput.model, "opus");
    assert.equal(o.updatedInput.prompt, `${brief}\n\n${HINT_INTRO}\n- tdd (explicit)`);
    assert.equal(logOf(dir, "reads-route.jsonl").at(-1).decision, "route");

    const routerOnly = out(launch(dir, "researcher", "SOURCES: plain.txt\nRISKY: yes\nQ", { ORCH_READ_ROUTER: "on" }));
    assert.equal(routerOnly.updatedInput.model, "opus");
    assert.equal(routerOnly.updatedInput.prompt, "SOURCES: plain.txt\nRISKY: yes\nQ", "no picks: the router's change alone");

    const hintsOnly = out(launch(dir, "orchestration:researcher", "SOURCES: book.docx\nQ"));
    assert.equal(hintsOnly.updatedInput.model, undefined);
    assert.match(hintsOnly.updatedInput.prompt, /- docx \(ext_docx\)\n- documents \(ext_docx\)$/);

    const rev = out(launch(dir, "reviewer", "SLICE: a\nSOURCES: out/report.docx\nReview it."));
    assert.equal(rev.updatedInput.prompt, `SLICE: a\nSOURCES: out/report.docx\nReview it.\n\n${HINT_INTRO}\n- docx (ext_docx)`);
    assert.equal(launch(dir, "reviewer", "SLICE: a\nReview the parser fix.").stdout, "", "no picks, no output");
    assert.equal(logOf(dir, "plan-check.jsonl").length, 0, "researcher and reviewer launches write no plan-check record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan check: built-ins, fork, the integrator and other plugins' agents are never touched", () => {
  const dir = project();
  try {
    const brief = "SLICE: a\nFILES: a.docx\nSOURCES: a.docx\nSKILLS: tdd\nDo it.";
    for (const type of ["general-purpose", "Explore", "Plan", "claude", "fork", "", "integrator", "orchestration:integrator", "other:researcher", "other:reviewer", "my-agent"]) {
      const r = launch(dir, type, brief, { ORCH_ALLOW_BUILTINS: "1" });
      assert.equal(r.status, 0, type);
      assert.equal(r.stdout, "", type);
    }
    assert.equal(logOf(dir, "skills.jsonl").length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan check: ORCH_SKILL_HINTS=off and a failed module load behave exactly as before", () => {
  const brief = DOCX;
  /** @param {{ hooks?: string[], env?: Record<string, string>, mutate?: (dir: string) => void }} o */
  const session = (o) => {
    const dir = project({ hooks: o.hooks });
    try {
      o.mutate?.(dir);
      const rs = [
        launch(dir, "implementer", brief, o.env),
        launch(dir, "reviewer", "SLICE: a\nSOURCES: a.docx\nSKILLS: tdd", o.env),
        launch(dir, "researcher", "SOURCES: a.docx\nQ", o.env),
        launch(dir, "implementer", "SLICE: b\nFILES: out/report.docx\nDEPENDS: none\nPATH: light", o.env),
        hook(dir, "not json", o.env),
      ].map((r) => [r.status, r.stdout, r.stderr]);
      return { rs, log: logOf(dir, "plan-check.jsonl").map(noTs), skills: existsSync(join(dir, ".claude", "state", "skills.jsonl")) };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const before = session({ hooks: HOOKS.filter((h) => !h.startsWith("skill-")) });
  assert.ok(before.rs.every(([, stdout]) => stdout === ""));
  assert.equal(before.rs[3]?.[0], 2, "the second light slice is still blocked");
  for (const env of /** @type {Record<string, string>[]} */ ([{ ORCH_SKILL_HINTS: "off" }, { ORCH_SKILL_HINTS: " OFF " }, { CLAUDE_PLUGIN_OPTION_SKILL_HINTS: "off" }])) {
    assert.deepEqual(session({ env }), before, JSON.stringify(env));
  }
  const broken = session({ mutate: (dir) => writeFileSync(join(dir, ".claude", "hooks", "skill-hint.mjs"), "export const x = ;\n") });
  assert.deepEqual(broken.rs, before.rs, "a module that fails to load gives no hints");
  assert.deepEqual(broken.log, before.log);
  const noExport = session({ mutate: (dir) => writeFileSync(join(dir, ".claude", "hooks", "skill-catalog.mjs"), "export const nothing = 1;\n") });
  assert.deepEqual(noExport.rs, before.rs);
  const throwing = session({ mutate: (dir) => writeFileSync(join(dir, ".claude", "hooks", "skill-catalog.mjs"), "export function skillCatalog() { throw new Error('boom'); }\n") });
  assert.deepEqual(throwing.rs, before.rs, "a throwing catalog gives no hints");
  assert.deepEqual(throwing.log, before.log);
});

test("plan check: missing, broken or unreadable skill roots never fail a launch", () => {
  const dir = project();
  try {
    const bad = join(dir, "bad-root");
    mkdirSync(bad);
    symlinkSync(join(dir, "nowhere"), join(bad, "broken"));
    symlinkSync(bad, join(bad, "loop"));
    mkdirSync(join(bad, "unreadable"));
    writeFileSync(join(bad, "unreadable", "SKILL.md"), md({ name: "unreadable", description: ".docx" }));
    try {
      spawnSync("chmod", ["000", join(bad, "unreadable", "SKILL.md")]);
    } catch {
      // chmod missing: the file stays readable
    }
    for (const roots of [join(dir, "missing"), bad, "", join(dir, "plain.txt")]) {
      const r = launch(dir, "implementer", "SLICE: a\nFILES: a.docx\nDEPENDS: none\nPATH: light", { ORCH_SKILL_ROOTS: roots });
      assert.equal(r.status, 0, roots);
      assert.equal(r.stderr, "");
    }
    assert.deepEqual(logOf(dir, "plan-check.jsonl").map((e) => e.reason), ["light_path", "light_path", "light_path", "light_path"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("plan check: researcher and reviewer hints leave the light path and overlap logic unchanged", () => {
  const dir = project();
  try {
    assert.notEqual(launch(dir, "reviewer", "SLICE: x\nFILES: a.docx\nSOURCES: a.docx").stdout, "");
    assert.notEqual(launch(dir, "researcher", "SLICE: y\nFILES: a.docx\nSOURCES: a.docx").stdout, "");
    const first = launch(dir, "implementer", "SLICE: a\nFILES: a.docx\nDEPENDS: none\nPATH: light");
    assert.equal(first.status, 0);
    assert.deepEqual(logOf(dir, "plan-check.jsonl").map((e) => [e.slice, e.reason]), [["a", "light_path"]], "the reviewer and researcher are not launches of a slice");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const rev = project({ reviewed: true });
  try {
    launch(rev, "reviewer", "SLICE: z\nFILES: shared.docx\nSOURCES: shared.docx");
    assert.equal(launch(rev, "implementer", "SLICE: a\nFILES: shared.docx\nDEPENDS: none").status, 0, "a reviewer's FILES own nothing");
    assert.equal(launch(rev, "implementer", "SLICE: b\nFILES: shared.docx\nDEPENDS: none").status, 2, "the implementer's do");
  } finally {
    rmSync(rev, { recursive: true, force: true });
  }
});

test("plan check: skills.jsonl holds parsed fields only", () => {
  const dir = project();
  try {
    launch(dir, "implementer", "SLICE: a\nFILES: a.docx\nDEPENDS: none\nPATH: light\nSKILLS: ghost\nGOAL: UNIQUE-BRIEF-WORDS here");
    launch(dir, "reviewer", "SLICE: a\nReview UNIQUE-BRIEF-WORDS.");
    const log = logOf(dir, "skills.jsonl");
    assert.deepEqual(log.map((e) => e.decision), ["hint", "none"]);
    const allowed = ["ts", "session_id", "agent_type", "role", "slice", "decision", "reason", "names", "reasons", "picks", "catalog", "explicit", "not_found"];
    for (const e of log) for (const k of Object.keys(e)) assert.ok(allowed.includes(k), k);
    assert.deepEqual(log[0].names, ["ghost", "docx", "documents"]);
    assert.deepEqual(log[0].reasons, ["explicit_not_found", "ext_docx", "ext_docx"]);
    assert.deepEqual([log[0].picks, log[0].catalog, log[0].explicit, log[0].not_found], [3, 3, 1, 1]);
    const raw = readFileSync(join(dir, ".claude", "state", "skills.jsonl"), "utf8");
    assert.ok(!raw.includes("UNIQUE-BRIEF-WORDS") && !raw.includes("SECRET-DESCRIPTION") && !raw.includes("Office files"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
