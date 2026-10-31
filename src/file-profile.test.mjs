// The zero-model file profiler (.claude/hooks/file-profile.mjs): kinds, tier rules, reasons, conversions, the cache,
// hard pages, URLs, missing files and the fallback without poppler. Fixtures: src/fixtures/files (make.sh rebuilds them).
// Tests that run poppler skip with a message when it is absent; the fallback tests use an injected tool runner.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  READ_TIERS,
  cachePath,
  defaultRun,
  imageSize,
  maxTier,
  pageLayout,
  profileFile,
  profileSources,
  sheetToCsv,
} from "../.claude/hooks/file-profile.mjs";
import { READ_TIERS as CONFIG_READ_TIERS } from "./config.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIX = join(here, "fixtures", "files");
const HOOK = join(here, "..", ".claude", "hooks", "file-profile.mjs");
const fx = (/** @type {string} */ name) => join(FIX, name);
const tmp = () => mkdtempSync(join(tmpdir(), "file-profile-"));

const hasPoppler = (() => {
  try { execFileSync("pdfinfo", ["-v"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const POPPLER = hasPoppler ? false : "poppler (pdfinfo, pdftotext, pdfimages) is not installed: PDF tests skipped";
const hasUnzip = (() => {
  try { execFileSync("unzip", ["-v"], { stdio: "ignore" }); return true; } catch { return false; }
})();
const UNZIP = hasUnzip ? false : "unzip is not installed: office-file tests skipped";

/** A runner that fails like a missing binary for the named tools and runs the rest for real. */
function without(/** @type {string[]} */ missing, calls = /** @type {string[]} */ ([])) {
  /** @type {import("../.claude/hooks/file-profile.mjs").ToolRunner} */
  const run = (cmd, args, opts) => {
    calls.push(cmd);
    if (missing.includes(cmd)) throw Object.assign(new Error(`spawnSync ${cmd} ENOENT`), { code: "ENOENT" });
    return defaultRun(cmd, args, opts);
  };
  return run;
}

/** A runner with canned output per tool (for PDF and zip shapes no fixture has). */
function canned(/** @type {Record<string, string | ((args: string[]) => string)>} */ out) {
  /** @type {import("../.claude/hooks/file-profile.mjs").ToolRunner} */
  const run = (cmd, args) => {
    const v = out[cmd];
    if (v === undefined) throw Object.assign(new Error(`${cmd} ENOENT`), { code: "ENOENT" });
    return typeof v === "function" ? v(args) : v;
  };
  return run;
}
const PDFINFO = (/** @type {number} */ pages) => `Title: x\nPages:          ${pages}\nPage size:      612 x 792 pts (letter)\n`;
const NO_IMAGES = "page num type width height color comp bpc enc interp object ID x-ppi y-ppi size ratio\n-----\n";
const prose = (/** @type {number} */ chars) => "word ".repeat(Math.ceil(chars / 4)).trim();

test("READ_TIERS holds the starting thresholds and src/config.ts re-exports it", () => {
  assert.equal(READ_TIERS.textCharsPerPage, 500);
  assert.equal(READ_TIERS.scannedCharsPerPage, 100);
  assert.equal(READ_TIERS.longDocPages, 50);
  assert.ok(READ_TIERS.tableLineRatio > 0 && READ_TIERS.figureAreaRatio > 0);
  assert.ok(READ_TIERS.quickTimeoutMs > 0 && READ_TIERS.extractTimeoutMs > 0 && READ_TIERS.maxToolBytes > 0);
  assert.equal(CONFIG_READ_TIERS, READ_TIERS);
});

test("maxTier picks the highest tier", () => {
  assert.equal(maxTier(), "haiku");
  assert.equal(maxTier("haiku", "sonnet", "haiku"), "sonnet");
  assert.equal(maxTier("opus", "sonnet"), "opus");
});

test("text and code read as is at haiku; a large text notes the price step", () => {
  const t = profileFile(fx("plain.txt"));
  assert.equal(t.kind, "text");
  assert.equal(t.ext, "txt");
  assert.equal(t.tier, "haiku");
  assert.equal(t.bytes, statSync(fx("plain.txt")).size);
  assert.deepEqual(t.reasons, ["text: read as is"]);
  assert.equal(t.textPath, undefined);
  const c = profileFile(HOOK);
  assert.equal(c.kind, "code");
  assert.equal(c.tier, "haiku");
  const dir = tmp();
  const big = join(dir, "big.log");
  writeFileSync(big, "x".repeat(READ_TIERS.largeTextBytes + 1));
  const b = profileFile(big);
  assert.equal(b.tier, "haiku");
  assert.match(b.reasons.join(" "), /price step/);
});

test("no known extension: sniffed as text, binary or PDF by magic", { skip: POPPLER }, () => {
  const dir = tmp();
  writeFileSync(join(dir, "NOTES"), "just words\n");
  writeFileSync(join(dir, "blob.dat"), Buffer.from([1, 2, 0, 3, 0, 0, 9]));
  copyFileSync(fx("text.pdf"), join(dir, "report"));
  const t = profileFile(join(dir, "NOTES"), { cacheDir: dir });
  assert.equal(t.kind, "text");
  assert.match(t.reasons[0] ?? "", /sniffed as text/);
  const b = profileFile(join(dir, "blob.dat"), { cacheDir: dir });
  assert.equal(b.kind, "binary");
  assert.equal(b.tier, "haiku");
  assert.match(b.reasons.join(" "), /binary/);
  const p = profileFile(join(dir, "report"), { cacheDir: dir });
  assert.equal(p.kind, "pdf");
  assert.equal(p.tier, "haiku");
});

test("missing files and directories are kind missing", () => {
  const m = profileFile(join(FIX, "nope.pdf"));
  assert.equal(m.kind, "missing");
  assert.equal(m.bytes, 0);
  assert.equal(m.tier, "haiku");
  assert.deepEqual(m.reasons, ["missing or not a regular file"]);
  assert.equal(profileFile(FIX).kind, "missing");
});

test("images go to sonnet with their dimensions; JPEG and GIF headers parse", () => {
  const p = profileFile(fx("chart.png"));
  assert.equal(p.kind, "image");
  assert.equal(p.tier, "sonnet");
  assert.equal(p.width, 220);
  assert.equal(p.height, 130);
  assert.match(p.reasons[0] ?? "", /220x130.*without a model/);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0, 0, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x2c, 0x02, 0x58, 3]);
  assert.deepEqual(imageSize(jpeg), { width: 600, height: 300 });
  const gif = Buffer.from("GIF89a\x10\x00\x08\x00", "latin1");
  assert.deepEqual(imageSize(gif), { width: 16, height: 8 });
  assert.equal(imageSize(Buffer.from("nope")), undefined);
});

test("text PDF: haiku, cached plain text, no hard pages", { skip: POPPLER }, () => {
  const dir = tmp();
  const p = profileFile(fx("text.pdf"), { cacheDir: dir });
  assert.equal(p.kind, "pdf");
  assert.equal(p.pages, 3);
  assert.equal(p.tier, "haiku");
  assert.ok((p.charsPerPage ?? 0) >= READ_TIERS.textCharsPerPage);
  assert.equal(p.images, 0);
  assert.equal(p.tables, 0);
  assert.equal(p.columns, 1);
  assert.equal(p.hardPages, undefined);
  assert.match(p.reasons[0] ?? "", /^text layer: \d+ chars\/page$/);
  assert.ok(p.textPath?.startsWith(dir));
  const text = readFileSync(p.textPath ?? "", "utf8");
  assert.equal(text.split("\f").filter((s) => s.trim()).length, 3, "page map: one form feed per page");
  assert.match(text, /pilot/);
});

test("PDF with a table: sonnet, table page is hard", { skip: POPPLER }, () => {
  const p = profileFile(fx("table.pdf"), { cacheDir: tmp() });
  assert.equal(p.tier, "sonnet");
  assert.ok((p.tables ?? 0) >= 1);
  assert.deepEqual(p.hardPages, [2]);
  assert.ok(p.reasons.includes("tables on pages 2"));
  assert.match(readFileSync(p.textPath ?? "", "utf8"), /Region\s{2,}Q1\s{2,}Q2/);
});

test("scanned PDF: sonnet, every page hard, no text conversion", { skip: POPPLER }, () => {
  const p = profileFile(fx("scanned.pdf"), { cacheDir: tmp() });
  assert.equal(p.tier, "sonnet");
  assert.equal(p.charsPerPage, 0);
  assert.equal(p.images, 2);
  assert.deepEqual(p.hardPages, [1, 2]);
  assert.equal(p.textPath, undefined);
  assert.match(p.reasons[0] ?? "", /^scanned or image-only/);
});

test("PDF with a large figure: sonnet, figure page hard", { skip: POPPLER }, () => {
  const p = profileFile(fx("figure.pdf"), { cacheDir: tmp() });
  assert.equal(p.tier, "sonnet");
  assert.equal(p.images, 1);
  assert.deepEqual(p.hardPages, [2]);
  assert.ok(p.reasons.includes("figures on pages 2"));
  assert.ok(p.textPath);
});

test("long PDF: haiku for lookup, one whole-document opus read for judge", { skip: POPPLER }, () => {
  const dir = tmp();
  const look = profileFile(fx("long.pdf"), { cacheDir: dir, read: "lookup" });
  assert.equal(look.pages, 55);
  assert.equal(look.tier, "haiku");
  assert.equal(look.wholeDocument, undefined);
  const judge = profileFile(fx("long.pdf"), { cacheDir: dir, read: "judge" });
  assert.equal(judge.tier, "opus");
  assert.equal(judge.wholeDocument, true);
  assert.equal(judge.hardPages, undefined, "no page split");
  assert.match(judge.reasons.join(" "), /long document \(55 pages\).*whole-document/);
  assert.ok(judge.textPath);
});

test("thin text layer, multi-column pages and many small images go to sonnet (canned tools)", () => {
  const dir = tmp();
  const f = join(dir, "x.pdf");
  writeFileSync(f, "%PDF-1.4\n");
  const thin = profileFile(f, { cacheDir: tmp(), run: canned({ pdfinfo: PDFINFO(2), pdftotext: `${prose(300)}\f${prose(300)}\f`, pdfimages: NO_IMAGES }) });
  assert.equal(thin.tier, "sonnet");
  assert.match(thin.reasons[0] ?? "", /^thin text layer/);
  assert.equal(thin.hardPages, undefined);

  const col = "left column words here and more" + " ".repeat(8) + "right column words here and more";
  const page = Array.from({ length: 20 }, () => col).join("\n");
  const cols = profileFile(f, { cacheDir: tmp(), run: canned({ pdfinfo: PDFINFO(1), pdftotext: page + "\f", pdfimages: NO_IMAGES }) });
  assert.equal(cols.columns, 2);
  assert.equal(cols.tier, "sonnet");
  assert.ok(cols.reasons.includes("multi-column layout"));
  assert.deepEqual(cols.hardPages, [1]);

  const icons = NO_IMAGES + [1, 2, 3].map((n) => `   2  ${n} image 10 10 rgb 3 8 image no ${n} 0 72 72 1K 50%`).join("\n");
  const many = profileFile(f, { cacheDir: tmp(), run: canned({ pdfinfo: PDFINFO(2), pdftotext: `${prose(900)}\f${prose(900)}\f`, pdfimages: icons }) });
  assert.equal(many.images, 3);
  assert.deepEqual(many.hardPages, [2]);
  assert.equal(many.tier, "sonnet");

  const blank = profileFile(f, { cacheDir: tmp(), run: canned({ pdfinfo: PDFINFO(2), pdftotext: `${prose(1500)}\f\f`, pdfimages: NO_IMAGES }) });
  assert.deepEqual(blank.hardPages, [2]);
  assert.ok(blank.reasons.includes("no text on pages 2"));
});

test("pageLayout finds aligned-column tables and two-column layouts, not prose", () => {
  const prosePage = "This is a plain sentence of prose that runs across the page.\n".repeat(10);
  assert.deepEqual(pageLayout(prosePage), { tables: 0, columns: 1 });
  const table = "Name    Qty    Price\nA    1    2\nB    3    4\nC    5    6\n";
  assert.deepEqual(pageLayout(prosePage + table), { tables: 1, columns: 1 });
  const two = "a long left hand column text" + "      " + "a long right hand column text\n";
  assert.equal(pageLayout(two.repeat(5)).columns, 2);
  assert.equal(pageLayout("").tables, 0);
});

test("xlsx with formulas: sonnet; sheets, formulas, merged cells and CSV from cached values", { skip: UNZIP }, () => {
  const p = profileFile(fx("formulas.xlsx"), { cacheDir: tmp() });
  assert.equal(p.kind, "xlsx");
  assert.equal(p.tier, "sonnet");
  assert.equal(p.sheets, 2);
  assert.equal(p.formulas, 4);
  assert.equal(p.mergedCells, 1);
  assert.deepEqual(p.reasons, ["2 sheet(s)", "4 formulas", "1 merged cell ranges: layout lost in CSV, sonnet to be safe"]);
  assert.ok(p.textPath?.endsWith(".csv"));
  assert.equal(readFileSync(p.textPath ?? "", "utf8"),
    "# sheet: Sheet1\nItem,Qty,Price,Total\nWidget,3,2.5,7.5\nGadget,4,10,40\n,,,47.5\n\n# sheet: Summary\nBudget 2026\n\"Grand, total\",47.5\n");
});

test("plain xlsx: haiku, read as CSV", { skip: UNZIP }, () => {
  const p = profileFile(fx("plain.xlsx"), { cacheDir: tmp() });
  assert.equal(p.tier, "haiku");
  assert.equal(p.formulas, 0);
  assert.deepEqual(p.reasons, ["1 sheet(s)", "plain data: read as CSV"]);
  const csv = readFileSync(p.textPath ?? "", "utf8").split("\n");
  assert.equal(csv[0], "# sheet: Data");
  assert.equal(csv[1], "Item,Qty");
  assert.equal(csv[2], "Widget,6");
});

test("sheetToCsv: shared, inline, boolean and gap cells", () => {
  const xml = '<row r="1"><c r="A1" t="s"><v>1</v></c><c r="C1" t="b"><v>1</v></c></row><row r="2"><c r="B2" t="inlineStr"><is><t>a &amp; "b"</t></is></c></row>';
  assert.equal(sheetToCsv(xml, ["zero", "one"]), 'one,,TRUE\n,"a & ""b"""');
});

test("docx and pptx: haiku, text from the XML", { skip: UNZIP }, () => {
  const d = profileFile(fx("doc.docx"), { cacheDir: tmp() });
  assert.equal(d.kind, "docx");
  assert.equal(d.tier, "haiku");
  assert.equal(d.images, 0);
  assert.equal(readFileSync(d.textPath ?? "", "utf8"),
    "Quarterly note\nOutput rose in every quarter & costs stayed flat.\nThe board extended the pilot.\n");
  const s = profileFile(fx("deck.pptx"), { cacheDir: tmp() });
  assert.equal(s.kind, "pptx");
  assert.equal(s.tier, "haiku");
  assert.equal(s.pages, 2);
  assert.equal(s.images, 1);
  assert.deepEqual(s.reasons, ["text from XML, 1 media file(s)"]);
  assert.match(readFileSync(s.textPath ?? "", "utf8"), /--- slide 2 ---\nResults\nOutput up 12 percent/);
});

test("image-heavy pptx and docx with tables go to sonnet (canned unzip)", () => {
  const dir = tmp();
  const deck = join(dir, "d.pptx");
  const doc = join(dir, "d.docx");
  writeFileSync(deck, "PK");
  writeFileSync(doc, "PK");
  const listing = (/** @type {string[]} */ names) =>
    "  Length      Date    Time    Name\n---------  ---------- -----   ----\n" +
    names.map((n) => `      10  01-01-2026 00:00   ${n}`).join("\n") + "\n---------                     -------\n";
  const heavy = profileFile(deck, { cacheDir: tmp(), run: canned({
    unzip: (a) => a[0] === "-l" ? listing(["ppt/slides/slide1.xml", "ppt/media/a.png", "ppt/media/b.png", "ppt/media/c.png"]) : "<a:t>Hi</a:t>",
  }) });
  assert.equal(heavy.tier, "sonnet");
  assert.equal(heavy.images, 3);
  assert.ok(heavy.reasons.includes("image-heavy: 3 media files"));
  const tabled = profileFile(doc, { cacheDir: tmp(), run: canned({
    unzip: (a) => a[0] === "-l" ? listing(["word/document.xml"]) : "<w:tbl><w:p><w:r><w:t>cell</w:t></w:r></w:p></w:tbl>",
  }) });
  assert.equal(tabled.tier, "sonnet");
  assert.equal(tabled.tables, 1);
  assert.ok(tabled.reasons.includes("1 tables: structure lost in text, sonnet to be safe"));
});

test("never throws: an unwritable cacheDir keeps the tier and drops textPath", { skip: UNZIP || POPPLER }, () => {
  const dir = tmp();
  const notDir = join(dir, "a-file");
  writeFileSync(notDir, "x");
  const badCache = join(notDir, "cache");
  const d = profileFile(fx("doc.docx"), { cacheDir: badCache });
  assert.equal(d.tier, "haiku");
  assert.equal(d.textPath, undefined);
  assert.ok(d.reasons.includes("cache unwritable (ENOTDIR): no text conversion"), d.reasons.join("|"));
  const p = profileFile(fx("text.pdf"), { cacheDir: badCache });
  assert.equal(p.tier, "haiku");
  assert.equal(p.textPath, undefined);
  assert.ok(p.reasons.includes("cache unwritable (ENOTDIR): no text conversion"), p.reasons.join("|"));
});

test("never throws: an unreadable file with an unknown extension is sonnet with the error", { skip: process.getuid?.() === 0 ? "root can read any file" : false }, () => {
  const dir = tmp();
  const f = join(dir, "secret.unknownext");
  writeFileSync(f, "data");
  chmodSync(f, 0o000);
  try {
    const p = profileFile(f, { cacheDir: dir });
    assert.equal(p.tier, "sonnet");
    assert.equal(p.kind, "missing");
    assert.deepEqual(p.reasons, ["unreadable (EACCES): sonnet to be safe"]);
  } finally {
    chmodSync(f, 0o600);
  }
});

test("never throws: bad arguments and internal errors give a conservative result", () => {
  const u = profileFile(/** @type {any} */ (undefined));
  assert.equal(u.kind, "missing");
  assert.equal(u.tier, "sonnet");
  assert.deepEqual(u.reasons, ["invalid path: not a non-empty string"]);
  assert.equal(profileFile(/** @type {any} */ (42)).tier, "sonnet");
  const none = profileSources(/** @type {any} */ (null));
  assert.equal(none.tier, "haiku");
  assert.deepEqual(none.files, []);
  assert.deepEqual(none.reasons, ["no source list given"]);
  const mixed = profileSources(/** @type {any} */ ([null, fx("plain.txt")]), /** @type {any} */ (null));
  assert.equal(mixed.tier, "sonnet");
  assert.equal(mixed.files.length, 2);
  const boom = profileFile(fx("text.pdf"), { cacheDir: tmp(), run: () => { throw "not an Error"; } });
  assert.equal(boom.tier, "sonnet");
  const crash = profileFile(fx("plain.xlsx"), { cacheDir: tmp(), run: /** @type {any} */ (() => 7) });
  assert.equal(crash.kind, "xlsx");
  assert.equal(crash.tier, "sonnet");
  assert.match(crash.reasons[0] ?? "", /^profiler error \(.+\): sonnet to be safe$/);
});

test("conversions are cached by path, size and mtime", { skip: POPPLER }, () => {
  const dir = tmp();
  const src = join(dir, "copy.pdf");
  copyFileSync(fx("text.pdf"), src);
  const first = /** @type {string[]} */ ([]);
  const a = profileFile(src, { cacheDir: dir, run: without([], first) });
  assert.ok(first.includes("pdftotext"));
  const second = /** @type {string[]} */ ([]);
  const b = profileFile(src, { cacheDir: dir, run: without([], second) });
  assert.equal(b.textPath, a.textPath);
  assert.ok(!second.includes("pdftotext"), "cache hit skips pdftotext");
  assert.ok(b.reasons.includes("text from cache"));
  assert.equal(b.tier, a.tier);
  assert.equal(b.charsPerPage, a.charsPerPage);
  utimesSync(src, new Date(), new Date(Date.now() + 5000));
  const c = profileFile(src, { cacheDir: dir });
  assert.notEqual(c.textPath, a.textPath, "a new mtime is a new key");
  const st = statSync(src);
  assert.equal(c.textPath, cachePath(dir, realpathSync(src), st, ".txt"));
  assert.match(basename(c.textPath ?? ""), /^[0-9a-f]{40}\.txt$/);
});

test("without poppler: PDFs fall back to the extension at sonnet and say so", () => {
  const p = profileFile(fx("text.pdf"), { cacheDir: tmp(), run: without(["pdfinfo", "pdftotext", "pdfimages"]) });
  assert.equal(p.kind, "pdf");
  assert.equal(p.tier, "sonnet");
  assert.equal(p.textPath, undefined);
  assert.deepEqual(p.reasons, ["pdfinfo not found", "poppler unavailable: tier by extension (pdf)"]);
  const failing = profileFile(fx("text.pdf"), { cacheDir: tmp(), run: canned({ pdfinfo: PDFINFO(3), pdftotext: () => { throw new Error("Syntax Error\nmore"); } }) });
  assert.equal(failing.tier, "sonnet");
  assert.deepEqual(failing.reasons, ["pdftotext failed: Syntax Error", "pdftotext unavailable: tier by extension (pdf)"]);
  const noImages = profileFile(fx("text.pdf"), { cacheDir: tmp(), run: canned({ pdfinfo: PDFINFO(1), pdftotext: prose(900) + "\f" }) });
  assert.equal(noImages.tier, "sonnet");
  assert.ok(noImages.reasons.includes("pdfimages not found"));
});

test("without unzip: office files fall back to the extension at sonnet", () => {
  const p = profileFile(fx("plain.xlsx"), { cacheDir: tmp(), run: without(["unzip"]) });
  assert.equal(p.tier, "sonnet");
  assert.deepEqual(p.reasons, ["unzip not found", "unzip unavailable: tier by extension (xlsx)"]);
});

test("CLI prints JSON; a PATH without poppler falls back", () => {
  const r = spawnSync(process.execPath, [HOOK, fx("text.pdf"), fx("plain.txt")], {
    encoding: "utf8", env: { ...process.env, PATH: "/nonexistent" },
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.tier, "sonnet");
  assert.equal(out.files[0].kind, "pdf");
  assert.ok(out.files[0].reasons.includes("pdfinfo not found"));
  assert.equal(out.files[1].tier, "haiku");
  const usage = spawnSync(process.execPath, [HOOK], { encoding: "utf8" });
  assert.equal(usage.status, 2);
});

test("importing the module has no side effects", () => {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(HOOK)});`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "");
});

test("URLs are tiered by path extension", () => {
  const pdf = profileFile("https://example.org/papers/a.pdf?dl=1");
  assert.equal(pdf.kind, "url");
  assert.equal(pdf.ext, "pdf");
  assert.equal(pdf.tier, "sonnet");
  assert.equal(pdf.host, "example.org");
  const page = profileFile("http://docs.example.com/guide/");
  assert.equal(page.tier, "haiku");
  assert.equal(page.ext, "");
  assert.equal(profileFile("https://x.example/data.csv").tier, "haiku");
});

test("profileSources: question tier, file tiers and risky combine to the highest", () => {
  const dir = tmp();
  assert.deepEqual(profileSources([fx("plain.txt")], { read: "lookup", cacheDir: dir }).tier, "haiku");
  assert.equal(profileSources([fx("plain.txt")], { read: "extract", cacheDir: dir }).tier, "haiku");
  const judge = profileSources([fx("plain.txt")], { read: "judge", cacheDir: dir });
  assert.equal(judge.tier, "sonnet");
  assert.deepEqual(judge.reasons, ["read judge: sonnet"]);
  const mixed = profileSources([fx("plain.txt"), fx("chart.png"), "https://example.org/x.html"], { read: "lookup", cacheDir: dir });
  assert.equal(mixed.tier, "sonnet");
  assert.deepEqual(mixed.reasons, ["read lookup: haiku", "chart.png: sonnet"]);
  assert.equal(mixed.files.length, 3);
  const risky = profileSources([fx("plain.txt")], { read: "lookup", risky: true, cacheDir: dir });
  assert.equal(risky.tier, "opus");
  assert.ok(risky.reasons.includes("risky slice: opus"));
  assert.equal(profileSources([], {}).tier, "haiku");
});

test("profiles hold parsed fields only: no file text in the result", { skip: POPPLER }, () => {
  const p = profileSources([fx("text.pdf"), fx("plain.txt")], { read: "extract", cacheDir: tmp() });
  const json = JSON.stringify(p);
  assert.doesNotMatch(json, /pilot|survey/);
});

/** @param {string} p */
function basename(p) {
  return p.split("/").pop() ?? "";
}
