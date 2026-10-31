#!/usr/bin/env node
// Read logger: PostToolUse on Read|WebFetch -> reads.jsonl in the state dir (state.mjs), one line per call:
//   { ts, session_id, agent_id, agent_type (bare), tool, ... }
//   Read: path (relative to the project when inside it), ext, bytes (file size, or null), pages (tool_input.pages, or
//   null), kind (text | code | pdf | image | notebook | office | other).
//   WebFetch: host only (no path, query or prompt).
// Never the file or page content. Never blocks: exits 0 always, also on malformed input.
import { appendFileSync, statSync } from "node:fs";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
if (duplicate("read-log.mjs")) process.exit(0); // the project's own copy logs this event

/** @type {Record<string, string[]>} */
const KINDS = {
  text: ["md", "markdown", "mdx", "txt", "rst", "adoc", "csv", "tsv", "log", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml", "env", "lock"],
  code: ["js", "mjs", "cjs", "ts", "mts", "cts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "kts", "swift", "c", "h", "cc", "cpp", "hpp", "cs", "php", "sh", "bash", "zsh", "fish", "ps1", "sql", "css", "scss", "sass", "less", "html", "htm", "vue", "svelte", "astro", "lua", "r", "scala", "dart", "ex", "exs", "erl", "hs", "ml", "clj", "pl", "m", "mm", "zig", "nim", "tf", "gradle", "graphql", "proto"],
  pdf: ["pdf"],
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "tif", "tiff", "heic", "avif"],
  notebook: ["ipynb"],
  office: ["docx", "doc", "xlsx", "xls", "xlsm", "pptx", "ppt", "odt", "ods", "odp", "rtf", "pages", "numbers", "key"],
};
/** @param {string} ext */
export const kindOf = (ext) => Object.keys(KINDS).find((k) => KINDS[k]?.includes(ext)) ?? "other";

try {
  const p = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const tool = p?.tool_name;
  if (!p || typeof p !== "object" || (tool !== "Read" && tool !== "WebFetch")) process.exit(0);
  const input = p.tool_input && typeof p.tool_input === "object" ? p.tool_input : {};
  /** @type {Record<string, unknown>} */
  const rec = {
    ts: new Date().toISOString(),
    session_id: typeof p.session_id === "string" ? p.session_id : "",
    agent_id: typeof p.agent_id === "string" && p.agent_id ? p.agent_id : null,
    agent_type: typeof p.agent_type === "string" && p.agent_type ? p.agent_type.split(":").pop() : null,
    tool,
  };
  if (tool === "Read") {
    const file = typeof input.file_path === "string" ? input.file_path : "";
    if (!file) process.exit(0);
    const project = process.env.CLAUDE_PROJECT_DIR || (typeof p.cwd === "string" ? p.cwd : process.cwd());
    const abs = isAbsolute(file) ? file : resolve(typeof p.cwd === "string" ? p.cwd : project, file);
    const r = relative(project, abs);
    const ext = extname(abs).slice(1).toLowerCase();
    let bytes = null;
    try {
      bytes = statSync(abs).size;
    } catch {
      // missing or unreadable: bytes stays null
    }
    rec.path = r && !r.startsWith("..") && !isAbsolute(r) ? r.split(sep).join("/") : abs;
    rec.ext = ext;
    rec.bytes = bytes;
    rec.pages = typeof input.pages === "string" || typeof input.pages === "number" ? String(input.pages).slice(0, 40) : null;
    rec.kind = kindOf(ext);
  } else {
    let host = null;
    try {
      host = new URL(String(input.url)).hostname || null;
    } catch {
      // not a URL: host stays null
    }
    rec.host = host;
  }
  ensureStateDir();
  appendFileSync(join(stateDir, "reads.jsonl"), `${JSON.stringify(rec)}\n`);
} catch {
  // the log must never fail the agent
}
process.exit(0);
