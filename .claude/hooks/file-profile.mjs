#!/usr/bin/env node
// Zero-model file profiler for the read router (design: docs/research-2026-10-31.md section 2).
// It looks at a file with cheap local tools (poppler, unzip) and picks the cheapest adequate reading tier.
// It never calls a model. When a tool is missing or fails it falls back to the extension and says so in `reasons`.
// Text conversions are cached under cacheDir (never in a .jsonl log), keyed by a sha1 of path, size and mtime.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Starting guesses (section 2.2); calibrate with the d2-docs eval before trusting them. */
export const READ_TIERS = Object.freeze({
  /** A PDF with at least this many non-space characters per page has a usable text layer. */
  textCharsPerPage: 500,
  /** Below this a page (or the whole PDF, on average) counts as scanned or image-only. */
  scannedCharsPerPage: 100,
  /** A page has a table when this share of its non-empty lines are aligned-column rows... */
  tableLineRatio: 0.1,
  /** ...and at least this many such rows run back to back. */
  tableMinRows: 3,
  /** An aligned-column row has at least this many cells split by 2+ spaces. */
  tableMinCells: 3,
  /** A page is laid out in columns when this share of its lines split into two long halves. */
  columnLineRatio: 0.4,
  /** A PDF image counts as a figure when it covers at least this share of the page. */
  figureAreaRatio: 0.15,
  /** A page with at least this many images counts as a figure page, whatever their size. */
  figureImagesPerPage: 3,
  /** Long document: at this page count a judge question stays one whole-document read at opus. */
  longDocPages: 50,
  /** A docx or pptx with at least this many embedded media files is image-heavy. */
  imageHeavyMedia: 3,
  /** Text above this size crosses Haiku's 100K-token price step (noted in reasons, tier unchanged). */
  largeTextBytes: 400_000,
  /** Files above this size skip the tools and are tiered by extension. */
  maxToolBytes: 200_000_000,
  /** Largest tool output read into memory. */
  maxBuffer: 64 * 1024 * 1024,
  /** Tool timeouts in ms: quick metadata calls, and text extraction. */
  quickTimeoutMs: 5_000,
  extractTimeoutMs: 20_000,
});

/** @typedef {'haiku'|'sonnet'|'opus'} Tier */
/** @typedef {'text'|'code'|'pdf'|'xlsx'|'docx'|'pptx'|'image'|'url'|'binary'|'missing'} Kind */
/** @typedef {'lookup'|'extract'|'judge'} ReadKind */
/** @typedef {(cmd: string, args: string[], opts: { timeout: number, maxBuffer: number }) => string} ToolRunner */
/**
 * @typedef {object} FileProfile
 * @property {string} path
 * @property {Kind} kind
 * @property {string} ext
 * @property {number} bytes
 * @property {number} [pages]
 * @property {number} [charsPerPage]
 * @property {number} [images]
 * @property {number} [tables]
 * @property {number} [columns]
 * @property {number} [sheets]
 * @property {number} [formulas]
 * @property {number} [mergedCells]
 * @property {number} [width]
 * @property {number} [height]
 * @property {string} [host]
 * @property {Tier} tier
 * @property {string[]} reasons
 * @property {string} [textPath]
 * @property {number[]} [hardPages]
 * @property {boolean} [wholeDocument]
 */
/**
 * @typedef {object} ProfileOptions
 * @property {ReadKind} [read]
 * @property {string} [cacheDir]
 * @property {ToolRunner} [run]
 */

const TIER_RANK = { haiku: 0, sonnet: 1, opus: 2 };
/** @param {Tier[]} tiers @returns {Tier} */
export function maxTier(...tiers) {
  return tiers.reduce((a, b) => (TIER_RANK[b] > TIER_RANK[a] ? b : a), /** @type {Tier} */ ("haiku"));
}

const TEXT_EXT = new Set(["txt", "md", "markdown", "rst", "adoc", "json", "jsonl", "csv", "tsv", "log", "yaml", "yml",
  "xml", "html", "htm", "toml", "ini", "cfg", "conf", "svg", "tex", "srt", "env"]);
const CODE_EXT = new Set(["js", "mjs", "cjs", "ts", "tsx", "jsx", "mts", "cts", "py", "rb", "go", "rs", "java", "kt", "kts",
  "scala", "c", "h", "cc", "cpp", "hpp", "cs", "swift", "m", "mm", "php", "pl", "lua", "r", "sql", "sh", "bash", "zsh",
  "fish", "ps1", "css", "scss", "less", "vue", "svelte", "dart", "ex", "exs", "erl", "hs", "ml", "clj", "zig", "nim"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "heif"]);
/** @type {Record<string, Kind>} */
const OFFICE_EXT = { pdf: "pdf", xlsx: "xlsx", xlsm: "xlsx", docx: "docx", pptx: "pptx" };

/** @type {ToolRunner} */
export function defaultRun(cmd, args, { timeout, maxBuffer }) {
  return execFileSync(cmd, args, { encoding: "utf8", timeout, maxBuffer, stdio: ["ignore", "pipe", "pipe"] });
}

/** @param {string} ext @returns {Kind | undefined} */
function kindOfExt(ext) {
  if (OFFICE_EXT[ext]) return OFFICE_EXT[ext];
  if (TEXT_EXT.has(ext)) return "text";
  if (CODE_EXT.has(ext)) return "code";
  if (IMAGE_EXT.has(ext)) return "image";
  return undefined;
}

/** First bytes of a file, for magic numbers and the text/binary sniff. @param {string} path */
function head(path, n = 4096) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(n);
    const got = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

/** @param {Buffer} b @returns {Kind} */
function sniff(b) {
  if (b.subarray(0, 5).toString("latin1") === "%PDF-") return "pdf";
  if (b[0] === 0x89 && b.subarray(1, 4).toString("latin1") === "PNG") return "image";
  if (b[0] === 0xff && b[1] === 0xd8) return "image";
  if (b.subarray(0, 4).toString("latin1") === "GIF8") return "image";
  return b.includes(0) ? "binary" : "text";
}

/** Width and height from a PNG, GIF or JPEG header, without a tool. @param {Buffer} b */
export function imageSize(b) {
  if (b[0] === 0x89 && b.length >= 24) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.subarray(0, 4).toString("latin1") === "GIF8" && b.length >= 10) return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1] ?? 0;
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + b.readUInt16BE(i + 2);
    }
  }
  return undefined;
}

/** Cache file for a conversion: sha1 of the resolved path, size and mtime. @param {string} cacheDir @param {string} path @param {import("node:fs").Stats} st @param {string} suffix */
export function cachePath(cacheDir, path, st, suffix) {
  const key = createHash("sha1").update(`${path}\0${st.size}\0${st.mtimeMs}`).digest("hex");
  return join(cacheDir, `${key}${suffix}`);
}

/** @param {string} s */
function decodeXml(s) {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e) => {
    if (e === "lt") return "<";
    if (e === "gt") return ">";
    if (e === "amp") return "&";
    if (e === "quot") return '"';
    if (e === "apos") return "'";
    return String.fromCodePoint(e[1] === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

/** @param {string} xml @param {string} tag e.g. "w:t" @returns {string[]} */
function tagTexts(xml, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => decodeXml(m[1] ?? ""));
}

/** Non-space characters. @param {string} s */
const nonSpace = (s) => s.replace(/\s+/g, "").length;

/**
 * Tables and column layout on one page of `pdftotext -layout` output.
 * @param {string} page
 * @param {typeof READ_TIERS} t
 */
export function pageLayout(page, t = READ_TIERS) {
  const lines = page.split("\n").filter((l) => l.trim());
  let run = 0, best = 0, rows = 0, regions = 0, twoCol = 0;
  for (const line of lines) {
    const cells = line.trim().split(/\s{2,}/);
    if (cells.length >= t.tableMinCells) {
      rows++;
      run++;
      if (run === t.tableMinRows) regions++;
      best = Math.max(best, run);
    } else {
      run = 0;
    }
    const halves = line.trim().split(/\s{4,}/);
    if (halves.length === 2 && (halves[0] ?? "").length >= 15 && (halves[1] ?? "").length >= 15) twoCol++;
  }
  const n = lines.length || 1;
  const table = best >= t.tableMinRows && rows / n >= t.tableLineRatio;
  return { tables: table ? regions : 0, columns: lines.length && twoCol / n >= t.columnLineRatio ? 2 : 1 };
}

/** @param {string} msg */
const short = (msg) => msg.split("\n")[0]?.slice(0, 80) ?? "";

/** Error code or first line, for reasons (never file text). @param {unknown} err */
const errName = (err) => {
  const e = /** @type {NodeJS.ErrnoException} */ (err);
  return (e && typeof e === "object" && e.code) || short(String((e && typeof e === "object" && e.message) || e));
};

/**
 * Write a conversion to the cache. A cache failure keeps the tier: it drops textPath and says why.
 * @param {string} cacheDir @param {string} file @param {string} text @param {string[]} reasons
 */
function writeCache(cacheDir, file, text, reasons) {
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, text);
    return true;
  } catch (err) {
    reasons.push(`cache unwritable (${errName(err)}): no text conversion`);
    return false;
  }
}

/** Cached text, or undefined when absent or unreadable. @param {string} file */
function readCache(file) {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Run a tool; on failure return undefined and note why (missing or failed) in reasons.
 * @param {ToolRunner} run @param {string} cmd @param {string[]} args @param {number} timeout @param {string[]} reasons
 */
function tool(run, cmd, args, timeout, reasons) {
  try {
    return run(cmd, args, { timeout, maxBuffer: READ_TIERS.maxBuffer });
  } catch (err) {
    const e = /** @type {NodeJS.ErrnoException} */ (err);
    reasons.push(e.code === "ENOENT" ? `${cmd} not found` : `${cmd} failed: ${short(String(e.message ?? e))}`);
    return undefined;
  }
}

/** @param {FileProfile} p @param {Tier} tier @param {string} why */
function byExtension(p, tier, why) {
  p.tier = tier;
  p.reasons.push(`${why}: tier by extension (${p.ext || "none"})`);
  return p;
}

/**
 * @param {FileProfile} p @param {string} abs @param {import("node:fs").Stats} st
 * @param {Required<Omit<ProfileOptions, "read">> & { read?: ReadKind }} o
 */
function profilePdf(p, abs, st, o) {
  const t = READ_TIERS;
  const reasons = p.reasons;
  const info = tool(o.run, "pdfinfo", [abs], t.quickTimeoutMs, reasons);
  if (info === undefined) return byExtension(p, "sonnet", "poppler unavailable");
  const pages = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
  const size = /^Page size:\s+([\d.]+) x ([\d.]+)/m.exec(info);
  const pageArea = size ? Number(size[1]) * Number(size[2]) : 612 * 792;
  p.pages = pages;

  const txtPath = cachePath(o.cacheDir, abs, st, ".txt");
  const fromCache = readCache(txtPath);
  let cached = fromCache !== undefined;
  if (cached) reasons.push("text from cache");
  const text = fromCache ?? tool(o.run, "pdftotext", ["-layout", "-enc", "UTF-8", abs, "-"], t.extractTimeoutMs, reasons);
  if (text === undefined) return byExtension(p, "sonnet", "pdftotext unavailable");
  if (!cached && nonSpace(text) > 0) cached = writeCache(o.cacheDir, txtPath, text, reasons);
  const pageTexts = text.split("\f").slice(0, Math.max(pages, 1));
  const totalChars = nonSpace(text);
  p.charsPerPage = Math.round(totalChars / Math.max(pages, 1));
  if (totalChars > 0 && cached) p.textPath = txtPath;

  /** @type {Map<number, number>} figure share and image count per 1-based page */
  const area = new Map(), count = new Map();
  let images = 0;
  const list = tool(o.run, "pdfimages", ["-list", abs], t.quickTimeoutMs, reasons);
  if (list !== undefined) {
    for (const line of list.split("\n").slice(2)) {
      const f = line.trim().split(/\s+/);
      if (f.length < 14 || f[2] !== "image") continue;
      const page = Number(f[0]), w = Number(f[3]), h = Number(f[4]), xppi = Number(f[12]) || 72, yppi = Number(f[13]) || 72;
      images++;
      area.set(page, (area.get(page) ?? 0) + ((w / xppi) * 72 * (h / yppi) * 72) / pageArea);
      count.set(page, (count.get(page) ?? 0) + 1);
    }
  }
  p.images = images;

  let tables = 0, columns = 1;
  /** @type {Set<number>} */
  const hard = new Set(), tablePages = new Set(), figurePages = new Set(), emptyPages = new Set();
  for (let i = 1; i <= pages; i++) {
    const pt = pageTexts[i - 1] ?? "";
    const lay = pageLayout(pt, t);
    tables += lay.tables;
    columns = Math.max(columns, lay.columns);
    if (lay.tables) tablePages.add(i);
    if (lay.columns > 1) hard.add(i);
    if ((area.get(i) ?? 0) >= t.figureAreaRatio || (count.get(i) ?? 0) >= t.figureImagesPerPage) figurePages.add(i);
    if (nonSpace(pt) < t.scannedCharsPerPage) emptyPages.add(i);
  }
  for (const s of [tablePages, figurePages, emptyPages]) for (const i of s) hard.add(i);
  p.tables = tables;
  p.columns = columns;
  const hardPages = [...hard].sort((a, b) => a - b);

  if (pages >= t.longDocPages && o.read === "judge") {
    p.tier = "opus";
    p.wholeDocument = true;
    reasons.push(`long document (${pages} pages) with a judge question: one whole-document read, no page split`);
    return p;
  }
  /** @type {Tier} */
  let tier = "haiku";
  if (p.charsPerPage < t.scannedCharsPerPage) {
    tier = "sonnet";
    reasons.push(`scanned or image-only: ${p.charsPerPage} chars/page`);
  } else if (p.charsPerPage < t.textCharsPerPage) {
    tier = "sonnet";
    reasons.push(`thin text layer: ${p.charsPerPage} chars/page`);
  } else {
    reasons.push(`text layer: ${p.charsPerPage} chars/page`);
  }
  if (tablePages.size) { tier = "sonnet"; reasons.push(`tables on pages ${[...tablePages].join(",")}`); }
  if (columns > 1) { tier = "sonnet"; reasons.push("multi-column layout"); }
  if (figurePages.size) { tier = "sonnet"; reasons.push(`figures on pages ${[...figurePages].join(",")}`); }
  if (emptyPages.size && p.charsPerPage >= t.scannedCharsPerPage) { tier = "sonnet"; reasons.push(`no text on pages ${[...emptyPages].join(",")}`); }
  if (list === undefined) { tier = "sonnet"; reasons.push("images unknown: sonnet to be safe"); }
  p.tier = tier;
  if (hardPages.length) p.hardPages = hardPages;
  return p;
}

/** Column letters of a cell ref ("AB12") to a 0-based index. @param {string} ref */
function colIndex(ref) {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, "")) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** @param {string} v */
function csvCell(v) {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** Sheet XML to CSV using shared strings and cached `<v>` values. @param {string} xml @param {string[]} shared */
export function sheetToCsv(xml, shared) {
  /** @type {string[]} */
  const out = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    /** @type {string[]} */
    const cells = [];
    for (const c of (row[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? "", body = c[2] ?? "";
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
      const type = /\bt="(\w+)"/.exec(attrs)?.[1];
      const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
      let value = "";
      if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
      else if (type === "inlineStr") value = tagTexts(body, "t").join("");
      else if (type === "b" && v !== undefined) value = v === "1" ? "TRUE" : "FALSE";
      else if (v !== undefined) value = decodeXml(v);
      const idx = ref ? colIndex(ref) : cells.length;
      while (cells.length < idx) cells.push("");
      cells[idx] = csvCell(value);
    }
    out.push(cells.join(","));
  }
  return out.join("\n");
}

/** @param {string} listing output of `unzip -l` */
function zipNames(listing) {
  return listing.split("\n").map((l) => /^\s*\d+\s+\S+\s+\S+\s+(.+)$/.exec(l)?.[1]?.trim()).filter((n) => n && n !== "Name" && !n.startsWith("-"))
    .map(String);
}

/** @param {string} a @param {string} b */
const byNumber = (a, b) => Number(/(\d+)\.xml$/.exec(a)?.[1] ?? 0) - Number(/(\d+)\.xml$/.exec(b)?.[1] ?? 0);

/**
 * @param {FileProfile} p @param {string} abs @param {import("node:fs").Stats} st
 * @param {Required<Omit<ProfileOptions, "read">> & { read?: ReadKind }} o
 */
function profileZip(p, abs, st, o) {
  const t = READ_TIERS;
  const reasons = p.reasons;
  const listing = tool(o.run, "unzip", ["-l", abs], t.quickTimeoutMs, reasons);
  if (listing === undefined) return byExtension(p, "sonnet", "unzip unavailable");
  const names = zipNames(listing);
  /** @param {string} entry */
  const part = (entry) => tool(o.run, "unzip", ["-p", abs, entry], t.extractTimeoutMs, reasons) ?? "";
  const textPath = cachePath(o.cacheDir, abs, st, p.kind === "xlsx" ? ".csv" : ".txt");
  /** @type {string} */
  let text;
  /** @type {Tier} */
  let tier = "haiku";

  if (p.kind === "xlsx") {
    const sheetFiles = names.filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort(byNumber);
    const wb = part("xl/workbook.xml");
    const rels = part("xl/_rels/workbook.xml.rels");
    /** @type {Map<string, string>} */
    const target = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      /\bId="([^"]+)"/.exec(m[0])?.[1] ?? "", "xl/" + (/\bTarget="([^"]+)"/.exec(m[0])?.[1] ?? "").replace(/^\/?xl\//, "")]));
    const order = [...wb.matchAll(/<sheet\b[^>]*>/g)].map((m) => ({
      name: decodeXml(/\bname="([^"]*)"/.exec(m[0])?.[1] ?? ""),
      file: target.get(/\br:id="([^"]+)"/.exec(m[0])?.[1] ?? "") ?? "",
    })).filter((s) => sheetFiles.includes(s.file));
    const sheets = order.length ? order : sheetFiles.map((f, i) => ({ name: `Sheet${i + 1}`, file: f }));
    const shared = names.includes("xl/sharedStrings.xml")
      ? [...part("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => tagTexts(m[1] ?? "", "t").join(""))
      : [];
    let formulas = 0, merged = 0;
    /** @type {string[]} */
    const sections = [];
    for (const s of sheets) {
      const xml = part(s.file);
      formulas += (xml.match(/<f[\s>/]/g) ?? []).length;
      merged += (xml.match(/<mergeCell\b/g) ?? []).length;
      sections.push(`# sheet: ${s.name}\n${sheetToCsv(xml, shared)}`);
    }
    text = sections.join("\n\n") + "\n";
    p.sheets = sheets.length;
    p.formulas = formulas;
    p.mergedCells = merged;
    reasons.push(`${sheets.length} sheet(s)`);
    if (formulas) { tier = "sonnet"; reasons.push(`${formulas} formulas`); }
    // Conservative beyond the research table (2.2): merged cells mean a layout the CSV export flattens.
    if (merged) { tier = "sonnet"; reasons.push(`${merged} merged cell ranges: layout lost in CSV, sonnet to be safe`); }
    if (!formulas && !merged) reasons.push("plain data: read as CSV");
  } else if (p.kind === "docx") {
    const xml = part("word/document.xml");
    text = xml.split(/<\/w:p>/).map((para) => tagTexts(para, "w:t").join("")).filter((l) => l).join("\n") + "\n";
    p.images = names.filter((n) => n.startsWith("word/media/")).length;
    p.tables = (xml.match(/<w:tbl>/g) ?? []).length;
    // Conservative beyond the research table (2.2): "any table goes to sonnet" (2.7), as the text export flattens it.
    if (p.tables) { tier = "sonnet"; reasons.push(`${p.tables} tables: structure lost in text, sonnet to be safe`); }
  } else {
    const slides = names.filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort(byNumber);
    text = slides.map((s, i) => `--- slide ${i + 1} ---\n${tagTexts(part(s), "a:t").join("\n")}`).join("\n") + "\n";
    p.pages = slides.length;
    p.images = names.filter((n) => n.startsWith("ppt/media/")).length;
  }
  if (p.kind !== "xlsx") {
    const images = p.images ?? 0;
    if (images >= t.imageHeavyMedia) { tier = "sonnet"; reasons.push(`image-heavy: ${images} media files`); }
    else reasons.push(`text from XML, ${images} media file(s)`);
  }
  if (writeCache(o.cacheDir, textPath, text, reasons)) p.textPath = textPath;
  p.tier = tier;
  return p;
}

/**
 * Profile one path or URL. Never calls a model.
 * @param {string} path
 * @param {ProfileOptions} [opts]
 * @returns {FileProfile}
 */
export function profileFile(path, opts = {}) {
  if (typeof path !== "string" || !path) {
    return { path: String(path ?? ""), kind: "missing", ext: "", bytes: 0, tier: "sonnet", reasons: ["invalid path: not a non-empty string"] };
  }
  try {
    return profileFileUnsafe(path, opts && typeof opts === "object" ? opts : {});
  } catch (err) {
    const ext = extname(path).slice(1).toLowerCase();
    const kind = /^https?:\/\//i.test(path) ? "url" : kindOfExt(ext) ?? "missing";
    return { path, kind, ext, bytes: 0, tier: "sonnet", reasons: [`profiler error (${errName(err)}): sonnet to be safe`] };
  }
}

/** @param {string} path @param {ProfileOptions} opts @returns {FileProfile} */
function profileFileUnsafe(path, opts) {
  const o = { run: opts.run ?? defaultRun, cacheDir: opts.cacheDir ?? join(tmpdir(), "orchestration-file-cache"), read: opts.read };
  if (/^https?:\/\//i.test(path)) return profileUrl(path);
  const abs = resolve(path);
  const ext = extname(abs).slice(1).toLowerCase();
  /** @type {FileProfile} */
  const p = { path: abs, kind: "missing", ext, bytes: 0, tier: "haiku", reasons: [] };
  /** @type {import("node:fs").Stats} */
  let st;
  try {
    st = statSync(abs);
    if (!st.isFile()) throw new Error("not a file");
  } catch {
    p.reasons.push("missing or not a regular file");
    return p;
  }
  p.bytes = st.size;
  const real = (() => { try { return realpathSync(abs); } catch { return abs; } })();
  let kind = kindOfExt(ext);
  if (!kind) {
    try {
      kind = sniff(head(real));
    } catch (err) {
      p.tier = "sonnet";
      p.reasons.push(`unreadable (${errName(err)}): sonnet to be safe`);
      return p;
    }
    p.reasons.push(`no known extension: sniffed as ${kind}`);
  }
  p.kind = kind;
  if (kind === "text" || kind === "code") {
    try {
      accessSync(real, constants.R_OK);
    } catch (err) {
      p.kind = "missing";
      p.tier = "sonnet";
      p.reasons.push(`unreadable (${errName(err)}): sonnet to be safe`);
      return p;
    }
    p.reasons.push(`${kind}: read as is`);
    if (st.size > READ_TIERS.largeTextBytes) p.reasons.push(`large: ${st.size} bytes, over Haiku's 100K-token price step`);
    return p;
  }
  if (kind === "binary") {
    p.reasons.push("binary: no text to read");
    return p;
  }
  if (kind === "image") {
    const size = (() => { try { return imageSize(head(real, 65536)); } catch { return undefined; } })();
    if (size) { p.width = size.width; p.height = size.height; }
    p.tier = "sonnet";
    p.reasons.push(`image${size ? ` ${size.width}x${size.height}` : ""}: content cannot be judged without a model`);
    return p;
  }
  if (st.size > READ_TIERS.maxToolBytes) return byExtension(p, "sonnet", `over ${READ_TIERS.maxToolBytes} bytes`);
  return kind === "pdf" ? profilePdf(p, real, st, o) : profileZip(p, real, st, o);
}

/** @param {string} url @returns {FileProfile} */
function profileUrl(url) {
  /** @type {URL | undefined} */
  let u;
  try { u = new URL(url); } catch { /* fall through */ }
  const ext = u ? extname(u.pathname).slice(1).toLowerCase() : "";
  const pdf = ext === "pdf";
  return {
    path: url, kind: "url", ext, bytes: 0, host: u?.host,
    tier: pdf ? "sonnet" : "haiku",
    reasons: [pdf ? "URL to a PDF: sonnet" : `URL${ext ? ` (.${ext})` : ""}: haiku`],
  };
}

/** @type {Record<ReadKind, Tier>} */
const QUESTION_TIER = { lookup: "haiku", extract: "haiku", judge: "sonnet" };

/**
 * Profile every source of a read and pick the overall tier: the highest of the file tiers, the question tier
 * (READ: lookup/extract -> haiku, judge -> sonnet) and opus for a RISKY slice.
 * @param {string[]} list paths or URLs
 * @param {{ read?: ReadKind, risky?: boolean, cacheDir?: string, run?: ToolRunner }} [opts]
 */
export function profileSources(list, opts = {}) {
  if (!opts || typeof opts !== "object") opts = {};
  const sources = Array.isArray(list) ? list : [];
  const files = sources.map((src) => profileFile(src, { read: opts.read, cacheDir: opts.cacheDir, run: opts.run }));
  /** @type {string[]} */
  const reasons = [];
  /** @type {Tier} */
  let tier = "haiku";
  if (list !== null && list !== undefined && !Array.isArray(list)) {
    tier = "sonnet";
    reasons.push("source list is not an array: sonnet to be safe");
  } else if (!sources.length) {
    reasons.push("no source list given");
  }
  if (opts.read) {
    const question = QUESTION_TIER[opts.read] ?? "haiku";
    tier = maxTier(tier, question);
    reasons.push(`read ${opts.read}: ${question}`);
  }
  for (const f of files) {
    if (TIER_RANK[f.tier] > TIER_RANK[tier]) reasons.push(`${f.kind === "url" ? f.path : basename(f.path)}: ${f.tier}`);
    tier = maxTier(tier, f.tier);
  }
  if (opts.risky) {
    tier = "opus";
    reasons.push("risky slice: opus");
  }
  return { tier, reasons, files };
}

// CLI: node .claude/hooks/file-profile.mjs <paths...>  (only when run directly; importing has no side effects)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args.length) {
    process.stderr.write("usage: node .claude/hooks/file-profile.mjs <paths or URLs...>\n");
    process.exit(2);
  }
  process.stdout.write(JSON.stringify(profileSources(args), null, 2) + "\n");
}
