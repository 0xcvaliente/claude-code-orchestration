#!/usr/bin/env node
// Seal of a draft skill (design: Part 2 of the skills design, "skill-seal.mjs"). A library and a CLI; Node built-ins
// only, no model, no network. Not a hook: a skill slice's worker runs the CLI on its draft skill folder after its last
// change, skill-gate.mjs verifies the seal at the worker's stop, and scripts/skill-publish.mjs verifies it again before
// a person publishes the draft.
//
//   seal(skillDir, meta)  writes <skillDir>/provenance.json:
//     { v: 1, name, created_at, created_by: "claude-code-orchestration <version>", target, files: { <path>: <sha256> }, digest }
//     `files` holds every regular file under the folder except provenance.json itself, by POSIX relative path in sorted
//     order; `digest` is the sha256 of the sorted `path:sha256` lines joined by "\n". `name` is the folder's name. A
//     symlink or any other non-regular entry makes the seal fail (it is never followed). Sealing a sealed folder keeps
//     its created_at (and its target, unless meta names one). A skill folder that is itself a symlink is refused by
//     seal and by verify. The target is meta.target, else the existing seal's,
//     else the draft home's <target> folder when the skill sits in .../skill-drafts/<target>/<name>/skills/<name>,
//     else "private". The version comes from the plugin manifest (<plugin root>/.claude-plugin/plugin.json, for the
//     plugin copy in <plugin root>/hooks) or this repo's package.json (two folders up, for the project copy in
//     .claude/hooks), each only when its name is this tool's; without either, created_by is the bare tool name.
//   verify(skillDir)      { ok, problems }: the seal is missing, unreadable or malformed, a listed file changed or is
//     gone, a file exists that the seal does not list, an entry is a symlink, or the digest does not match.
//
// CLI: skill-seal.mjs <skillDir> [--verify] [--target private|public]
//   exit 0 on success, 1 on a failed seal or verify (the problems on stderr), 2 on bad usage.
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const SEAL_FILE = "provenance.json";
const TOOL = "claude-code-orchestration";
const TARGETS = new Set(["private", "public"]);
const HERE = dirname(fileURLToPath(import.meta.url));

/** @param {string | Buffer} data */
const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** The `name version` of a JSON manifest when its name is `want`, else null. @param {string} path @param {string} want */
function manifestVersion(path, want) {
  try {
    const m = JSON.parse(readFileSync(path, "utf8"));
    return m && m.name === want && typeof m.version === "string" && m.version ? m.version : null;
  } catch {
    return null;
  }
}

/** created_by: this tool's name and, when a manifest of it can be found from here, its version. */
export function createdBy() {
  const v = manifestVersion(join(HERE, "..", ".claude-plugin", "plugin.json"), "orchestration") ?? manifestVersion(join(HERE, "..", "..", "package.json"), TOOL);
  return v ? `${TOOL} ${v}` : TOOL;
}

/**
 * Every regular file under `dir` except the seal itself, as sorted POSIX relative paths. Throws on a symlink or any
 * other entry that is neither a file nor a folder.
 * @param {string} dir @returns {string[]}
 */
function listFiles(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} abs @param {string} rel */
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs)) {
      const a = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(a);
      if (st.isSymbolicLink()) throw new Error(`${r} is a symlink; a sealed skill holds regular files only`);
      if (st.isDirectory()) walk(a, r);
      else if (st.isFile()) {
        if (r !== SEAL_FILE) out.push(r);
      } else throw new Error(`${r} is not a regular file`);
    }
  };
  walk(dir, "");
  return out.sort();
}

/** @param {Record<string, string>} files */
const digestOf = (files) =>
  sha256(
    Object.keys(files)
      .sort()
      .map((p) => `${p}:${files[p]}`)
      .join("\n"),
  );

/** The existing seal's parsed JSON, or null. @param {string} dir @returns {any} */
function readSeal(dir) {
  try {
    const s = JSON.parse(readFileSync(join(dir, SEAL_FILE), "utf8"));
    return s && typeof s === "object" && !Array.isArray(s) ? s : null;
  } catch {
    return null;
  }
}

/** The draft home's target for a skill at .../skill-drafts/<target>/<name>/skills/<name>, else null. @param {string} dir */
function targetFromPath(dir) {
  const parts = resolve(dir).split(sep);
  const n = parts.length;
  if (n >= 5 && parts[n - 2] === "skills" && parts[n - 5] === "skill-drafts" && parts[n - 3] === parts[n - 1] && TARGETS.has(String(parts[n - 4]))) return String(parts[n - 4]);
  return null;
}

/**
 * Write <skillDir>/provenance.json and return it. Throws when the folder cannot be read, holds a symlink or another
 * non-regular entry, or the meta target is not private or public.
 * @param {string} skillDir
 * @param {{ target?: string, now?: Date }} [meta]
 */
export function seal(skillDir, meta = {}) {
  const dir = resolve(skillDir);
  const st = lstatSync(dir);
  if (st.isSymbolicLink()) throw new Error(`${dir} is a symlink; seal the real folder, inside the draft worktree`);
  if (!st.isDirectory()) throw new Error(`${dir} is not a folder`);
  if (meta.target !== undefined && !TARGETS.has(meta.target)) throw new Error("target must be private or public");
  const before = readSeal(dir);
  /** @type {Record<string, string>} */
  const files = {};
  for (const rel of listFiles(dir)) files[rel] = sha256(readFileSync(join(dir, ...rel.split("/"))));
  const target = meta.target ?? (TARGETS.has(before?.target) ? before.target : null) ?? targetFromPath(dir) ?? "private";
  const record = {
    v: 1,
    name: basename(dir),
    created_at: typeof before?.created_at === "string" && before.created_at ? before.created_at : (meta.now ?? new Date()).toISOString(),
    created_by: createdBy(),
    target,
    files,
    digest: digestOf(files),
  };
  writeFileSync(join(dir, SEAL_FILE), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

/**
 * Whether the seal matches the folder. Never throws.
 * @param {string} skillDir @returns {{ ok: boolean, problems: string[] }}
 */
export function verify(skillDir) {
  /** @type {string[]} */
  const problems = [];
  try {
    const dir = resolve(skillDir);
    try {
      const st = lstatSync(dir);
      if (st.isSymbolicLink()) return { ok: false, problems: ["the skill folder is a symlink; a sealed skill is a real folder"] };
      if (!st.isDirectory()) return { ok: false, problems: ["the skill folder is not a folder"] };
    } catch {
      return { ok: false, problems: ["the skill folder is missing"] };
    }
    let text;
    try {
      text = readFileSync(join(dir, SEAL_FILE), "utf8");
    } catch {
      return { ok: false, problems: [`${SEAL_FILE} is missing or unreadable`] };
    }
    /** @type {any} */
    let s;
    try {
      s = JSON.parse(text);
    } catch {
      return { ok: false, problems: [`${SEAL_FILE} is not valid JSON`] };
    }
    if (!s || typeof s !== "object" || Array.isArray(s) || s.v !== 1 || !s.files || typeof s.files !== "object" || Array.isArray(s.files) || typeof s.digest !== "string") {
      return { ok: false, problems: [`${SEAL_FILE} does not have the expected fields`] };
    }
    if (s.name !== basename(dir)) problems.push(`${SEAL_FILE} names a different skill than the folder`);
    let actual;
    try {
      actual = listFiles(dir);
    } catch (e) {
      return { ok: false, problems: [...problems, e instanceof Error ? e.message : "the folder cannot be read"] };
    }
    const listed = /** @type {Record<string, unknown>} */ (s.files);
    for (const rel of Object.keys(listed).sort()) {
      if (!actual.includes(rel)) {
        problems.push(`${rel} is listed in the seal but is gone`);
        continue;
      }
      let hash;
      try {
        hash = sha256(readFileSync(join(dir, ...rel.split("/"))));
      } catch {
        problems.push(`${rel} cannot be read`);
        continue;
      }
      if (hash !== listed[rel]) problems.push(`${rel} changed after the seal`);
    }
    for (const rel of actual) if (!(rel in listed)) problems.push(`${rel} is not listed in the seal`);
    const strings = Object.values(listed).every((v) => typeof v === "string");
    if (!strings || digestOf(/** @type {Record<string, string>} */ (listed)) !== s.digest) problems.push("the seal's digest does not match its file list");
  } catch {
    problems.push("the seal could not be checked");
  }
  return { ok: problems.length === 0, problems };
}

/** @param {string[]} argv @returns {number} exit code */
export function main(argv) {
  const usage = "usage: skill-seal.mjs <skillDir> [--verify] [--target private|public]";
  /** @type {string[]} */
  const pos = [];
  let doVerify = false;
  /** @type {string | undefined} */
  let target;
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a === "--verify") doVerify = true;
    else if (a === "--target") {
      target = argv[++i];
      if (!target || !TARGETS.has(target)) {
        process.stderr.write(`${usage}\n`);
        return 2;
      }
    } else if (a.startsWith("-")) {
      process.stderr.write(`${usage}\n`);
      return 2;
    } else pos.push(a);
  }
  if (pos.length !== 1 || (doVerify && target !== undefined)) {
    process.stderr.write(`${usage}\n`);
    return 2;
  }
  const dir = String(pos[0]);
  if (doVerify) {
    const r = verify(dir);
    if (!r.ok) {
      process.stderr.write(`${r.problems.join("\n")}\n`);
      return 1;
    }
    process.stdout.write(`seal ok: ${resolve(dir)}\n`);
    return 0;
  }
  try {
    const rec = seal(dir, target ? { target } : {});
    process.stdout.write(`sealed ${Object.keys(rec.files).length} files in ${join(resolve(dir), SEAL_FILE)}\n`);
    return 0;
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : "the seal failed"}\n`);
    return 1;
  }
}

const invoked = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invoked) process.exitCode = main(process.argv.slice(2));
