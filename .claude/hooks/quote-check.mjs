#!/usr/bin/env node
// SubagentStop quote check for researchers (0.4.0; design: docs/research-2026-10-31.md section 2.5). Registered for the
// researcher; it also returns at once for any other bare agent_type. ORCH_QUOTE_CHECK=off disables it.
// Since 1.2.0 it is also registered on PreToolUse for the SubagentHandback tool, where the report is
// tool_input.message and exit 2 keeps the report from being delivered until the researcher sends it again; records
// written there carry `at: "handback"`, and the SubagentStop that follows such a record exits at once.
// It reads the researcher's final report (the last assistant text block or SubagentHandback message of
// agent_transcript_path, as telemetry.mjs finds it; else last_assistant_message), takes its QUOTE lines with brief.mjs
// parseReply, and looks each quote's text up in the locator's file:
//   - the locator is `path:line`, `path:line-line`, `path#L12`, `path p.N` (also `p. N`, `pp.`, `page`) or a bare path;
//     a relative path is resolved against the project dir. The whole file is searched, so a wrong line or page number
//     does not fail a quote that is there;
//   - text and code files are read as they are; PDF, xlsx, docx and pptx through file-profile.mjs's cached text
//     conversion (profileFile with the read router's cache dir, <state dir>/read-cache);
//   - text is compared after Unicode NFKC, lower-casing, straight quotes and dashes, dropping *, _ and backticks, and
//     collapsing whitespace; an ellipsis (... or …) splits a quote into parts that must appear in order.
// Unverifiable, never unverified: URLs, images and other binaries, missing or unreadable files, a PDF with no usable
// text layer (a scan), a quote whose page has no text (a page number outside the document is unverified, not this), and any path whose real path (symlinks resolved) is outside the
// project dir and the read cache: such a file is never read, so the hook says nothing about it. Each stop logs { agent_id, slice, total, verified,
// unverified, unverifiable, blocked } and the unverified quotes' paths to quotes.jsonl in the state dir (counts and
// paths only, never quote, reply or file text). When a quote is unverified and quote-check has not blocked this agent
// before, it exits 2 with the unverified locators, asking the researcher to correct each quote from its source or drop
// it and list the claim under OPEN; the next stop always passes. Exits early on duplicate(); exits 0 on malformed input.
// A refusal at a hand-back is marked in handback-refusals.jsonl with the report's key (report_key, the same key
// handback-check.mjs puts on its capture). Without a tool_use_id the two hooks, which run side by side, cannot be tied
// by id, so this hook first waits, at most CAPTURE_WAIT_MS, for that capture and writes the refusal after it (2.0.0, w6
// item 3); when it does not come in time the refusal is still written, and journal.mjs matches it by key.
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { parseReply } from "./brief.mjs";
import { profileFile } from "./file-profile.mjs";
import { appendJsonl, loadRecords, readJsonl, sliceOfAgent } from "./run.mjs";
import { duplicate, ensureStateDir, HANDBACK_LOG, recordHandbackRefusal, stateDir } from "./state.mjs";

const LOG = "quotes.jsonl";
const MAX_TEXT_BYTES = 64 * 1024 * 1024; // larger sources are not read: their quotes count as unverifiable
/** A page with fewer non-space characters than this has no text to check against (file-profile's scan threshold). */
const EMPTY_PAGE_CHARS = 100;
/** How long a refusal without tool_use_id waits for handback-check.mjs's capture of the same report. */
const CAPTURE_WAIT_MS = 1000;

/** handback-check.mjs reportKey, copied (a test project may hold this hook without that one): keep them equal. @param {string} message */
const reportKey = (message) => createHash("sha256").update(message, "utf8").digest("hex").slice(0, 16);

/**
 * Wait, at most `ms`, for the capture of this report (same session, agent and report_key, written in the last 30 s).
 * @param {string} sessionId @param {string} agentId @param {string} key @param {number} ms
 */
function awaitCapture(sessionId, agentId, key, ms) {
  const end = Date.now() + ms;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    const now = Date.now();
    try {
      if (readJsonl(stateDir, HANDBACK_LOG, sessionId).some((c) => c && c.agent_id === agentId && (c.session_id ?? "") === sessionId && c.report_key === key && now - Date.parse(c.ts) <= 30_000)) return true;
    } catch {
      // unreadable: keep waiting
    }
    if (now >= end) return false;
    Atomics.wait(cell, 0, 0, 25);
  }
}

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
if (duplicate("quote-check.mjs")) process.exit(0);
if (String(process.env.ORCH_QUOTE_CHECK ?? "").trim().toLowerCase() === "off") process.exit(0);
/** @type {any} */
let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  process.exit(0);
}
if (!input || typeof input !== "object" || Array.isArray(input)) process.exit(0);
if ((String(input.agent_type ?? "").split(":").pop() ?? "") !== "researcher") process.exit(0);

/** Final report from the subagent transcript: the last assistant text block or SubagentHandback message. @param {unknown} path */
function reportFromTranscript(path) {
  if (typeof path !== "string" || !path) return undefined;
  try {
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let entry;
      try {
        entry = JSON.parse(/** @type {string} */ (lines[i]));
      } catch {
        continue;
      }
      const content = entry?.type === "assistant" ? entry.message?.content : undefined;
      if (!Array.isArray(content)) continue;
      for (let j = content.length - 1; j >= 0; j--) {
        const b = content[j];
        if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) return b.text;
        if (b?.type === "tool_use" && b.name === "SubagentHandback" && typeof b.input?.message === "string") return b.input.message;
      }
    }
  } catch {
    // unreadable transcript: fall back to last_assistant_message
  }
  return undefined;
}

// 1.2.0: registered on PreToolUse for SubagentHandback too. In auto mode the report is that call's message, and a
// SubagentStop block comes after it was delivered; checked here, an unverified quote is corrected before delivery.
const atHandback = input.tool_name === "SubagentHandback" && typeof input.tool_input?.message === "string";
if (input.tool_name !== undefined && !atHandback) process.exit(0); // a tool call that carries no report
const reportAgentId = typeof input.agent_id === "string" && input.agent_id ? input.agent_id : null;
// quotes.jsonl is read once per call: only its records of this agent matter.
const prior = reportAgentId ? readJsonl(stateDir, LOG).filter((e) => e.agent_id === reportAgentId) : [];
// The stop that follows a checked handback has nothing new to check.
if (!atHandback && reportAgentId && prior.some((e) => e.agent_id === reportAgentId && e.at === "handback")) process.exit(0);
const report = atHandback ? String(input.tool_input.message) : (reportFromTranscript(input.agent_transcript_path) ?? (typeof input.last_assistant_message === "string" ? input.last_assistant_message : ""));
const quotes = parseReply(report).quotes;
const projectDir = process.env.CLAUDE_PROJECT_DIR || (typeof input.cwd === "string" && input.cwd) || process.cwd();
const cacheDir = `${stateDir}/read-cache`;

/** @param {string} s */
const norm = (s) =>
  s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
/** @param {string} s */
const nonSpace = (s) => s.replace(/\s+/g, "").length;

/**
 * The path and page of a locator; null path for a URL.
 * @param {string} locator @returns {{ path: string | null, page: number | null }}
 */
function locate(locator) {
  let p = locator.trim();
  if (/^https?:\/\//i.test(p)) return { path: null, page: null };
  let page = null;
  const pm = p.match(/[,;]?\s+(?:p|pp|pg|page|pages)\.?\s*(\d+)(?:\s*[-–]\s*\d+)?\s*$/i);
  if (pm) {
    page = Number(pm[1]);
    p = p.slice(0, pm.index);
  }
  p = p.replace(/#L\d+(?:-L?\d+)?$/i, "").replace(/:\d+(?:\s*[-–]\s*\d+)?(?::\d+)?$/, "").trim();
  return { path: p ? resolve(projectDir, p) : null, page };
}

/** A real path, or null when it does not resolve. @param {string} p */
const real = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
/** @param {string} rp a real path @param {string} r a real root */
const under = (rp, r) => rp === r || rp.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
// The read cache is read only when it is a folder itself, not a symlink to one (file-profile.mjs cacheDirSafe, the read
// router's rule); a missing cache has nothing to read.
const cacheReal = (() => {
  try {
    const st = lstatSync(cacheDir);
    return st.isDirectory() && !st.isSymbolicLink() ? real(cacheDir) : null;
  } catch {
    return null;
  }
})();
// Locators are confined to the project dir and the read cache, after symlinks resolve: anything else is never read.
const roots = /** @type {string[]} */ ([real(projectDir), cacheReal].filter(Boolean));
/** @param {string} rp a real path */
const inside = (rp) => roots.some((r) => under(rp, r));
/**
 * An entry of the read cache (its folder resolves into the cache) that is not a regular file, a symlink above all, is
 * absent: never read, whatever it points at (file-profile.mjs readCache, the read router's rule). A path outside the
 * cache is judged by `inside` alone, as before. @param {string} abs
 */
const cacheEntryRefused = (abs) => {
  const parent = real(dirname(abs));
  const inCache = (cacheReal && parent && under(parent, cacheReal)) || under(resolve(abs), resolve(cacheDir));
  if (!inCache) return false;
  try {
    return !lstatSync(abs).isFile();
  } catch {
    return true;
  }
};
/** A cache file's text, read without following a symlink (O_NOFOLLOW), or null. @param {string} p */
function readNoFollow(p) {
  try {
    if (!lstatSync(p).isFile()) return null;
    const fd = openSync(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      return fstatSync(fd).isFile() ? readFileSync(fd, "utf8") : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** @type {Map<string, { text: string, pages: string[] | null } | null>} */
const sources = new Map();
/** Source text of a file, or null when it cannot be checked (scan, image, binary, missing, unreadable). @param {string} abs */
function sourceText(abs) {
  if (sources.has(abs)) return sources.get(abs) ?? null;
  /** @type {{ text: string, pages: string[] | null } | null} */
  let src = null;
  try {
    const st = statSync(abs);
    if (!cacheEntryRefused(abs) && inside(realpathSync(abs)) && st.isFile() && st.size <= MAX_TEXT_BYTES) {
      const prof = profileFile(abs, { cacheDir });
      if (prof.kind === "text" || prof.kind === "code") src = { text: readFileSync(abs, "utf8"), pages: null };
      else if (["pdf", "xlsx", "docx", "pptx"].includes(prof.kind) && prof.textPath) {
        const scanned = prof.kind === "pdf" && typeof prof.charsPerPage === "number" && prof.charsPerPage < EMPTY_PAGE_CHARS;
        const text = scanned ? null : readNoFollow(prof.textPath);
        if (text !== null) {
          // Only the document's own pages: pdftotext ends each page with a form feed, so the split's last element
          // (page N+1) is not a page, and neither is any number past pdfinfo's page count.
          const all = text.split("\f");
          const count = typeof prof.pages === "number" && prof.pages > 0 ? prof.pages : Math.max(all.length - 1, 1);
          src = { text, pages: prof.kind === "pdf" ? all.slice(0, count) : null };
        }
      }
    }
  } catch {
    src = null; // unreadable: unverifiable
  }
  sources.set(abs, src);
  return src;
}

/** @type {Map<string, string>} */
const normed = new Map();
/** @param {{ locator: string, text: string }} q @returns {{ result: 'verified' | 'unverified' | 'unverifiable', path: string | null }} */
function check(q) {
  const { path, page } = locate(q.locator);
  if (!path) return { result: "unverifiable", path: null };
  const src = sourceText(path);
  if (!src) return { result: "unverifiable", path };
  if (!normed.has(path)) normed.set(path, norm(src.text));
  const hay = normed.get(path) ?? "";
  const parts = q.text.split(/\s*(?:\.\.\.|…)\s*/).map(norm).filter(Boolean);
  if (!parts.length) return { result: "unverifiable", path };
  let at = 0;
  let found = true;
  for (const part of parts) {
    const i = hay.indexOf(part, at);
    if (i === -1) {
      found = false;
      break;
    }
    at = i + part.length;
  }
  if (found) return { result: "verified", path };
  // A quote from a page with no text layer (an image page in a text PDF) cannot be checked. A page the document does
  // not have is not such a page: that quote is unverified (T-7).
  if (src.pages && page !== null && page >= 1 && page <= src.pages.length && nonSpace(src.pages[page - 1] ?? "") < EMPTY_PAGE_CHARS) return { result: "unverifiable", path };
  return { result: "unverified", path };
}

const counts = { verified: 0, unverified: 0, unverifiable: 0 };
/** @type {string[]} */
const unverifiedLocators = [];
/** @type {string[]} */
const unverifiedPaths = [];
for (const q of quotes) {
  let r;
  try {
    r = check(q);
  } catch {
    r = { result: /** @type {const} */ ("unverifiable"), path: null };
  }
  counts[r.result]++;
  if (r.result === "unverified") {
    unverifiedLocators.push(q.locator);
    if (r.path && !unverifiedPaths.includes(r.path)) unverifiedPaths.push(r.path);
  }
}

const sessionId = typeof input.session_id === "string" ? input.session_id : "";
const agentId = typeof input.agent_id === "string" && input.agent_id ? input.agent_id : null;
let slice = null;
try {
  slice = sliceOfAgent(loadRecords(sessionId, stateDir), agentId);
} catch {
  // no journal: no slice
}
// At a hand-back a refusal must be provably the only one: a refused report is not delivered until the researcher sends
// it again, and after three refusals it is never delivered. So there the hook blocks only with an agent id (without
// one a second report cannot be told from the first) and only once the record of the refusal is written and readable.
const blockedBefore = agentId ? prior.some((e) => e.agent_id === agentId && e.blocked === true) : atHandback ? true : input.stop_hook_active === true;
const block = counts.unverified > 0 && !blockedBefore;
let recorded = false;
try {
  ensureStateDir();
  // Read back from the end of the log only (appendJsonl), so the log is read in full once per call.
  const readable = appendJsonl(stateDir, LOG, { ts: new Date().toISOString(), session_id: sessionId, agent_id: agentId, slice, total: quotes.length, ...counts, blocked: block, ...(atHandback ? { at: "handback" } : {}), ...(unverifiedPaths.length ? { unverified_paths: unverifiedPaths } : {}) });
  recorded = !atHandback || !block || readable;
} catch {
  // at SubagentStop logging never changes the decision; at a hand-back an unrecorded refusal is not made (below)
}
if (block && (recorded || !atHandback)) {
  // A refused hand-back is not delivered: mark it, so the stop never takes handback-check.mjs's capture of it (G-14).
  if (atHandback && agentId) {
    const toolUseId = typeof input.tool_use_id === "string" && input.tool_use_id ? input.tool_use_id : null;
    const key = reportKey(report);
    // No id ties this refusal to its capture: write it after the capture (bounded wait), so it is matched in any order.
    if (!toolUseId) awaitCapture(sessionId, agentId, key, CAPTURE_WAIT_MS);
    const refusal = { session_id: sessionId, agent_id: agentId, tool_use_id: toolUseId, gate: "quote", report_key: key };
    recordHandbackRefusal(refusal);
  }
  const list = unverifiedLocators.map((l) => `- ${l}`).join("\n");
  try {
    process.stderr.write(
      `Quote check: ${counts.unverified} of your QUOTE lines ${counts.unverified === 1 ? "was" : "were"} not found in the source text:\n${list}\nFor each one, open the source and correct the QUOTE text to the exact words there, or drop that QUOTE and list its claim under OPEN. Then give your final report again.\n`,
    );
  } catch {
    // a closed stream must not change the decision
  }
  process.exit(2);
}
process.exit(0);
