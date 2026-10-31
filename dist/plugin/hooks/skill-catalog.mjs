// Installed skills, for the plan check's skill hints (skill-hint.mjs picks from this list). A library, not a hook: it
// has no side effects at import and never throws; any unreadable root, folder or file is skipped.
// Sources (config dir = CLAUDE_CONFIG_DIR or ~/.claude; project dir = CLAUDE_PROJECT_DIR or the cwd):
//   user     <config>/skills/<folder>/SKILL.md                    named by its frontmatter name, else the folder
//   synced   <config>/skills/synced/<id>/<folder>/SKILL.md        named anthropic-skills:<name> (dot folders such as
//                                                                 .bucket-* skipped)
//   project  <project>/.claude/skills/<folder>/SKILL.md           named like user skills
//   plugins  <config>/plugins/installed_plugins.json (version 2: plugins[key][] of { installPath, scope, projectPath }),
//            the entry for this project or else the user-scope one, kept only when enabledPlugins[key] is true in the
//            merged user, project and project-local settings; <installPath>/skills/<folder>/SKILL.md named
//            <plugin>:<name>, where <plugin> is the key before "@".
// Folders are followed through symlinks (stat, not Dirent.isDirectory); one level deep only, so a loop cannot recur.
// Only the frontmatter is parsed: name, description, disable-model-invocation, context.
// Cache: <cacheDir>/skill-catalog.json, keyed by the list of SKILL.md paths with their mtimes and sizes; any change
// (a new, removed or edited SKILL.md) parses again.
// Test-only override: ORCH_SKILL_ROOTS replaces every root with a list separated by the path delimiter; each entry is a
// skills folder scanned like the user's (`<dir>`), or `<ns>=<dir>` to name its skills `<ns>:<name>`.
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

const CACHE = "skill-catalog.json";
const MAX_FRONTMATTER = 64 * 1024;
const MAX_SKILLS = 2000;

/**
 * @typedef {{ name: string, description: string, path: string, disableModelInvocation: boolean, contextFork: boolean }} Skill
 * @typedef {{ dir: string, ns: string | null }} Root
 */

/** @param {string} p */
const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** @param {string} p @returns {any} */
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

/** @param {string} dir @returns {string[]} */
const entries = (dir) => {
  try {
    return readdirSync(dir).filter((n) => !n.startsWith(".")).sort();
  } catch {
    return [];
  }
};

/** Enabled plugin keys: user settings, then project, then project-local; a later value wins. @param {string} config @param {string} project */
function enabledPlugins(config, project) {
  /** @type {Record<string, boolean>} */
  const on = {};
  for (const f of [join(config, "settings.json"), join(project, ".claude", "settings.json"), join(project, ".claude", "settings.local.json")]) {
    const ep = readJson(f)?.enabledPlugins;
    if (!ep || typeof ep !== "object" || Array.isArray(ep)) continue;
    for (const [k, v] of Object.entries(ep)) on[k] = v === true;
  }
  return on;
}

/**
 * The skill roots to scan, in precedence order (a name seen earlier wins).
 * @param {{ env?: NodeJS.ProcessEnv, projectDir?: string }} [opts] @returns {Root[]}
 */
export function skillRoots(opts = {}) {
  const env = opts.env ?? process.env;
  try {
    const override = env.ORCH_SKILL_ROOTS;
    if (typeof override === "string" && override.trim()) {
      return override
        .split(delimiter)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => {
          const m = s.match(/^([A-Za-z0-9][\w.-]*)=(.+)$/);
          return m ? { dir: m[2] ?? "", ns: m[1] ?? null } : { dir: s, ns: null };
        });
    }
    const config = env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const project = opts.projectDir || env.CLAUDE_PROJECT_DIR || process.cwd();
    /** @type {Root[]} */
    const roots = [{ dir: join(project, ".claude", "skills"), ns: null }, { dir: join(config, "skills"), ns: null }];
    const synced = join(config, "skills", "synced");
    for (const id of entries(synced)) if (isDir(join(synced, id))) roots.push({ dir: join(synced, id), ns: "anthropic-skills" });
    const installed = readJson(join(config, "plugins", "installed_plugins.json"));
    const plugins = installed && typeof installed.plugins === "object" && installed.plugins ? installed.plugins : {};
    const on = enabledPlugins(config, project);
    for (const key of Object.keys(plugins).sort()) {
      if (on[key] !== true) continue;
      const list = Array.isArray(plugins[key]) ? plugins[key].filter((/** @type {any} */ e) => e && typeof e === "object" && typeof e.installPath === "string") : [];
      const entry = list.find((/** @type {any} */ e) => e.projectPath === project) ?? list.find((/** @type {any} */ e) => e.scope === "user");
      const name = key.split("@")[0];
      if (entry && name) roots.push({ dir: join(entry.installPath, "skills"), ns: name });
    }
    return roots;
  } catch {
    return [];
  }
}

/**
 * The SKILL.md files under the roots with their stat, in root order. A user root skips its synced folder.
 * @param {Root[]} roots @returns {{ file: string, folder: string, ns: string | null, mtimeMs: number, size: number }[]}
 */
function skillFiles(roots) {
  const out = [];
  for (const r of roots) {
    for (const folder of entries(r.dir)) {
      if (r.ns === null && folder === "synced") continue;
      const file = join(r.dir, folder, "SKILL.md");
      try {
        if (!statSync(join(r.dir, folder)).isDirectory()) continue;
        const st = statSync(file);
        if (!st.isFile()) continue;
        out.push({ file, folder, ns: r.ns, mtimeMs: st.mtimeMs, size: st.size });
      } catch {
        // a broken symlink or a folder without SKILL.md
      }
      if (out.length >= MAX_SKILLS) return out;
    }
  }
  return out;
}

/** The text of a file's first MAX_FRONTMATTER bytes. @param {string} file */
function head(file) {
  let fd = -1;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(MAX_FRONTMATTER);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd >= 0) {
      try {
        closeSync(fd);
      } catch {
        // already closed
      }
    }
  }
}

/** A YAML scalar: quotes removed ('' and \" unescaped). @param {string} v */
function scalar(v) {
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/**
 * Top-level keys of a SKILL.md frontmatter (the block between a first `---` line and the next). Handles plain, quoted,
 * folded (`>`) and literal (`|`) values and indented continuation lines; anything else is skipped. No frontmatter
 * gives {}.
 * @param {string} text @returns {Record<string, string>}
 */
export function frontmatter(text) {
  /** @type {Record<string, string>} */
  const out = {};
  try {
    const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
    if ((lines[0] ?? "").trim() !== "---") return out;
    let key = "";
    /** @type {string[]} */
    let parts = [];
    let block = false;
    const flush = () => {
      if (key) out[key] = block ? parts.join(" ").replace(/\s+/g, " ").trim() : scalar(parts.join(" "));
      key = "";
      parts = [];
      block = false;
    };
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i] ?? "";
      if (l.trim() === "---") {
        flush();
        return out;
      }
      const m = l.match(/^([A-Za-z][\w-]*):[ \t]*(.*)$/);
      if (m) {
        flush();
        key = (m[1] ?? "").toLowerCase();
        const v = (m[2] ?? "").trim();
        if (/^[>|][+-]?$/.test(v)) block = true;
        else parts.push(v);
      } else if (key && /^\s/.test(l)) {
        parts.push(l.trim());
      }
    }
    return {}; // no closing ---: malformed, as if there were no frontmatter
  } catch {
    return {};
  }
}

/** @param {string | undefined} v */
const truthy = (v) => /^(true|yes|on)$/i.test(String(v ?? "").trim());

/** @param {{ file: string, folder: string, ns: string | null }} f @returns {Skill | null} */
function parseSkill(f) {
  const fm = frontmatter(head(f.file));
  const own = String(fm.name ?? "").trim();
  const bare = /^[A-Za-z0-9][\w.-]*$/.test(own) ? own : f.folder;
  if (!bare) return null;
  return {
    name: f.ns ? `${f.ns}:${bare}` : bare,
    description: String(fm.description ?? "").slice(0, 4000),
    path: f.file,
    disableModelInvocation: truthy(fm["disable-model-invocation"]),
    contextFork: String(fm.context ?? "").trim().toLowerCase() === "fork",
  };
}

/**
 * The installed skills, deduplicated by name (the first root wins). Never throws: anything unreadable is left out.
 * @param {{ env?: NodeJS.ProcessEnv, projectDir?: string, cacheDir?: string | null }} [opts] @returns {Skill[]}
 */
export function skillCatalog(opts = {}) {
  try {
    const files = skillFiles(skillRoots(opts));
    const key = createHash("sha1").update(JSON.stringify(files.map((f) => [f.file, f.ns, f.mtimeMs, f.size]))).digest("hex");
    const cacheFile = opts.cacheDir ? join(opts.cacheDir, CACHE) : null;
    if (cacheFile) {
      const c = readJson(cacheFile);
      if (c && c.key === key && Array.isArray(c.skills)) return c.skills;
    }
    /** @type {Skill[]} */
    const skills = [];
    const seen = new Set();
    for (const f of files) {
      const s = parseSkill(f);
      if (!s || seen.has(s.name)) continue;
      seen.add(s.name);
      skills.push(s);
    }
    if (cacheFile && opts.cacheDir) {
      try {
        mkdirSync(opts.cacheDir, { recursive: true });
        const tmp = `${cacheFile}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify({ key, skills }));
        renameSync(tmp, cacheFile);
      } catch {
        // an unwritable cache only costs a re-parse next time
      }
    }
    return skills;
  } catch {
    return [];
  }
}
