#!/usr/bin/env node
// Skill gate (design: Part 2 of the skills design, "skill-gate.mjs"). SubagentStop hook for this project's or plugin's
// own implementer (bare `implementer` or `orchestration:implementer`; registered beside verify.sh with the same disjoint
// matchers, so the project and plugin copies never see the same stop and no duplicate() check is needed). Deny-only:
// exit 2 with one message, or exit 0 with no output.
//
// It acts only when the stopping agent's launch record in journal-launches.jsonl (same session and agent id; journal.mjs)
// has kind "skill" and a valid skill name; when the stop comes before its launch record (a foreground agent), the brief
// is read from the agent transcript's first user message instead. Every other stop exits 0 with no output and no record.
// The draft worktree is <CLAUDE_CONFIG_DIR or ~/.claude>/orchestration/skill-drafts/<target>/<name> (the same path
// plan-check.mjs gives the worker; a small local copy of its private helper), target private unless the brief said
// TARGET: public. Checks, each with a reason code; all failures go into one block message:
//   draft_missing  the draft worktree does not exist or is not a git work tree (no other check runs).
//   skill_dir      skills/<name> is a link, not a folder, or resolves outside the draft worktree (the skill_md,
//                  validator, secrets and seal checks then do not run on it).
//   skill_md       skills/<name>/SKILL.md exists, its frontmatter name equals the folder, its description has 1 to 1024
//                  characters, and it has at most 500 lines.
//   validator      scripts/ matches the merge base with the base branch (no commit, staged or unstaged change, and no
//                  untracked or ignored file under it), then `python3 -I -B scripts/validate.py skills/<name>` exits 0
//                  in the draft worktree (isolated: neither the script's folder, the current folder, PYTHON* variables
//                  nor the user site can change what it imports; -B: no bytecode is written; minimal environment; 60 s
//                  limit). Its output, trimmed and with secrets masked, goes into the message.
//   secrets        no private key block, well-known token prefix (GitHub, AWS, Slack, OpenAI, Anthropic, Google), e-mail
//                  address (git@<host>, example.com/.org/.net and their subdomains, and the final labels .test,
//                  .example, .invalid and .localhost excepted) or home-directory path (/root/, /home/<user>/,
//                  /Users/<user>/, also after a URL scheme such as file://) in any file under skills/<name>/ (bytes
//                  scanned whatever the content; a file over 5 MB or unreadable is a finding of its own) or in the
//                  README.md lines the branch adds. The message gives file, line and kind, never the matched text.
//   seal           provenance.json exists and skill-seal.mjs verify() passes.
//   git_state      the draft worktree is clean, is on branch skill/<name>, and that branch has at least one commit its
//                  base does not. The base is the one plan-check logged for this skill in skill-create.jsonl, else the
//                  branch of the skills repository's main worktree.
// Loop guard: after three blocks for the same agent and slice in this session the stop goes through and the record
// says skill_gate_gave_up. Records go to skill-gate.jsonl in the state dir: decision, reason, failed reason codes,
// skill, target, slice, agent id, session and counts; never file text, validator output or matched secrets.
// It reads only: git runs with optional locks off and only read commands, python writes no bytecode; it never writes
// into the draft worktree (a test compares the tree before and after),
// never pushes and never installs or links anything. Exits 0 with no output on input it cannot read or on any error.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { isSkillName, parseHeader, sliceOfBrief } from "./brief.mjs";
import { readJsonl } from "./run.mjs";
import { verify } from "./skill-seal.mjs";
import { ensureStateDir, stateDir } from "./state.mjs";

const LOG = "skill-gate.jsonl";
const MAX_BLOCKS = 3;
const OWN_IMPLEMENTER = new Set(["implementer", "orchestration:implementer"]);
const VALIDATOR_MS = 60_000;
const MAX_SCAN_BYTES = 5 * 1024 * 1024;
const MAX_FINDINGS_SHOWN = 20;

/**
 * Secret and personal-detail patterns: [kind, global regex, excuse]. The kind is what the message says; the match is
 * never shown. `excuse` (when given) lets a match through: only for e-mail addresses on the reserved example domains.
 * @type {[string, RegExp, ((m: RegExpMatchArray) => boolean)?][]}
 */
const SECRET_PATTERNS = [
  ["private key block", /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/g],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["OpenAI API key", /\bsk-(?!ant-)(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/g],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,})/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["Slack token", /\bxox[abposr]-[A-Za-z0-9-]{10,}/g],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}/g],
  ["e-mail address", /(?<![\w.%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})\b/g, (m) => reservedAddress(String(m[1]), String(m[2]))],
  // After start, a character that cannot be part of a path, or a URL scheme's "://" (file:///home/alice/...).
  ["home-directory path", /(?:^|[^\w.~/-]|:\/\/)(?:\/root\/|\/home\/[A-Za-z0-9._-]+\/|\/Users\/[A-Za-z0-9._-]+\/)/g],
  // The same path behind a host, for the schemes that name a file on a machine (file://localhost/home/alice/...).
  ["home-directory path", /\b(?:file|sftp|ssh|scp|rsync|ftp):\/\/[^\s/]+(?:\/root\/|\/home\/[A-Za-z0-9._-]+\/|\/Users\/[A-Za-z0-9._-]+\/)/g],
];

/**
 * An address that names nobody: git@<host> (an SSH remote), or a domain that is example.com, example.org, example.net
 * or a subdomain of one, or whose final label is test, example, invalid or localhost.
 * @param {string} local @param {string} domain
 */
function reservedAddress(local, domain) {
  const d = domain.toLowerCase();
  if (local === "git") return true;
  if (/(?:^|\.)example\.(?:com|org|net)$/.test(d)) return true;
  return /\.(?:test|example|invalid|localhost)$/.test(d);
}

/** The kinds found in one line. @param {string} line @returns {string[]} */
function kindsIn(line) {
  /** @type {string[]} */
  const kinds = [];
  for (const [kind, re, excuse] of SECRET_PATTERNS) {
    for (const m of line.matchAll(re)) {
      if (excuse && excuse(m)) continue;
      kinds.push(kind);
      break;
    }
  }
  return kinds;
}

/**
 * The secret findings in one text: line number and kind, never the match.
 * @param {string} text @returns {{ line: number, kind: string }[]}
 */
function scanText(text) {
  /** @type {{ line: number, kind: string }[]} */
  const out = [];
  text.split("\n").forEach((l, i) => {
    for (const kind of kindsIn(l)) out.push({ line: i + 1, kind });
  });
  return out;
}

/** Text with every secret match (excused addresses aside) replaced by [masked]. @param {string} text */
const mask = (text) =>
  SECRET_PATTERNS.reduce((t, [, re, excuse]) => t.replace(re, (...a) => {
    const m = /** @type {RegExpMatchArray} */ (/** @type {unknown} */ (a.slice(0, -2).filter((x) => typeof x === "string" || x === undefined)));
    return excuse && excuse(m) ? String(a[0]) : "[masked]";
  }), text);

/**
 * Frontmatter fields of a SKILL.md: name and description as strings (folded block and quoted scalars read), null when
 * missing; `ok` false when there is no frontmatter block.
 * @param {string} text @returns {{ ok: boolean, name: string | null, description: string | null }}
 */
function frontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { ok: false, name: null, description: null };
  const lines = String(m[1]).split(/\r?\n/);
  /** @type {Record<string, string>} */
  const fields = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(String(lines[i]));
    if (!kv) continue;
    const key = String(kv[1]);
    let v = String(kv[2]).trim();
    /** @type {string[]} */
    const cont = [];
    while (i + 1 < lines.length && (/^[ \t]+\S/.test(String(lines[i + 1])) || (String(lines[i + 1]).trim() === "" && /^[>|]/.test(v)))) cont.push(String(lines[++i]).trim());
    if (/^[>|][+-]?$/.test(v)) v = cont.join(v.startsWith("|") ? "\n" : " ").trim();
    else {
      if (cont.length) v = [v, ...cont].join(" ");
      const q = /^"([\s\S]*)"$/.exec(v) ?? /^'([\s\S]*)'$/.exec(v);
      if (q) v = String(q[1]);
    }
    fields[key] = v;
  }
  return { ok: true, name: fields.name ?? null, description: fields.description ?? null };
}

/** git -C dir with optional locks off: { status, out }, status null on a spawn error or timeout. @param {string} dir @param {string[]} args */
function git(dir, args) {
  // Repository config must not steer the gate's own git calls: no fsmonitor program, no hooks.
  const r = spawnSync("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", dir, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: r.error ? null : r.status, out: typeof r.stdout === "string" ? r.stdout : "" };
}

/** Every regular file under `dir` (symlinks not followed), as POSIX paths relative to `dir`. @param {string} dir */
function filesUnder(dir) {
  /** @type {string[]} */
  const out = [];
  /** @param {string} abs @param {string} rel */
  const walk = (abs, rel) => {
    let names = [];
    try {
      names = readdirSync(abs);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      const a = join(abs, n);
      const r = rel ? `${rel}/${n}` : n;
      try {
        const st = lstatSync(a);
        if (st.isDirectory()) walk(a, r);
        else if (st.isFile()) out.push(r);
      } catch {
        // unreadable entry: skipped
      }
    }
  };
  walk(dir, "");
  return out;
}

/** The README.md lines the branch adds (merge base to working tree, or HEAD when no base), with their line numbers. @param {string} draft @param {string | null} mergeBase */
function addedReadmeLines(draft, mergeBase) {
  const r = git(draft, ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "-U0", mergeBase ?? "HEAD", "--", "README.md"]);
  /** @type {{ line: number, text: string }[]} */
  const out = [];
  if (r.status !== 0) return out;
  let n = 0;
  for (const l of r.out.split("\n")) {
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      n = Number(h[1]);
      continue;
    }
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) out.push({ line: n++, text: l.slice(1) });
  }
  return out;
}

/**
 * Why skills/<name> is not a real folder inside the draft worktree, or null when it is (or does not exist: the other
 * checks report that). Never throws.
 * @param {string} draft @param {string} skillDir @returns {string | null}
 */
function skillDirProblem(draft, skillDir) {
  let st;
  try {
    st = lstatSync(skillDir);
  } catch {
    return null;
  }
  if (st.isSymbolicLink()) return "is a link";
  if (!st.isDirectory()) return "is not a folder";
  try {
    const real = realpathSync(skillDir);
    const top = realpathSync(draft);
    if (!real.startsWith(`${top}${sep}`)) return "resolves to a place outside the draft worktree";
  } catch {
    return "cannot be resolved";
  }
  return null;
}

/**
 * Whether the branch (commits, staged or unstaged changes, untracked or ignored files) differs from `mergeBase` under
 * scripts/; null when git cannot tell.
 * @param {string} draft @param {string} mergeBase @returns {boolean | null}
 */
function scriptsChangedSince(draft, mergeBase) {
  const diff = git(draft, ["diff", "--quiet", "--no-ext-diff", "--no-textconv", "--no-renames", mergeBase, "--", "scripts"]);
  if (diff.status === 1) return true;
  if (diff.status !== 0) return null;
  const staged = git(draft, ["diff", "--quiet", "--cached", "--no-ext-diff", "--no-textconv", mergeBase, "--", "scripts"]);
  if (staged.status === 1) return true;
  if (staged.status !== 0) return null;
  // --others without --exclude-standard lists ignored files too.
  const extra = git(draft, ["ls-files", "--others", "-z", "--", "scripts"]);
  if (extra.status !== 0) return null;
  return extra.out.length > 0;
}

/**
 * Run the gate's checks on a draft.
 * @param {{ draft: string, name: string, base: string | null }} o
 * @returns {{ code: string, text: string }[]} the failures, empty when the draft passes
 */
function checkDraft({ draft, name, base }) {
  /** @type {{ code: string, text: string }[]} */
  const fail = [];
  const skillRel = `skills/${name}`;
  const skillDir = join(draft, "skills", name);
  const branch = `skill/${name}`;

  // The base and the merge base, for the README scan, the validator check and the commit count.
  let baseRef = base && git(draft, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).status === 0 ? base : null;
  if (!baseRef) {
    const wt = git(draft, ["worktree", "list", "--porcelain"]);
    const main = /^branch refs\/heads\/(\S+)$/m.exec(wt.out.split("\n\n")[0] ?? "");
    if (wt.status === 0 && main && main[1] !== branch) baseRef = String(main[1]);
  }
  const mb = baseRef ? git(draft, ["merge-base", baseRef, "HEAD"]) : null;
  const mergeBase = mb && mb.status === 0 && mb.out.trim() ? mb.out.trim() : null;

  // The skill folder must be a real folder inside the draft worktree: a link (of the folder or of skills/) would let
  // every check below pass on files the branch does not hold.
  const dirProblem = skillDirProblem(draft, skillDir);
  if (dirProblem) fail.push({ code: "skill_dir", text: `${skillRel} ${dirProblem}. Make it a real folder in the draft worktree holding the skill's files, never a link.` });

  // a. SKILL.md
  if (!dirProblem) {
    const skillMd = join(skillDir, "SKILL.md");
    /** @type {string | null} */
    let md = null;
    try {
      if (lstatSync(skillMd).isFile()) md = readFileSync(skillMd, "utf8");
    } catch {
      md = null;
    }
    if (md === null) {
      fail.push({ code: "skill_md", text: `${skillRel}/SKILL.md is missing. Write it in the draft worktree, with frontmatter that has name: ${name} and a description.` });
    } else {
      /** @type {string[]} */
      const issues = [];
      const fm = frontmatter(md);
      if (!fm.ok) issues.push("it has no frontmatter block (a --- line, name and description, a --- line) at the top");
      else {
        if (fm.name !== name) issues.push(`its frontmatter name must be ${name}, the folder's name`);
        const len = [...(fm.description ?? "")].length;
        if (len < 1 || len > 1024) issues.push(`its description has ${len} characters; it needs 1 to 1024`);
      }
      const lineCount = md.split("\n").length - (md.endsWith("\n") ? 1 : 0);
      if (lineCount > 500) issues.push(`it has ${lineCount} lines; keep it at 500 or fewer and move long material into references/`);
      if (issues.length) fail.push({ code: "skill_md", text: `${skillRel}/SKILL.md: ${issues.join("; ")}.` });
    }
  }

  // b. The validator. Nothing the branch adds or changes may steer it: scripts/ must match the merge base (tracked and
  // untracked, ignored files included), and python runs isolated (-I: no script folder or current folder on the module
  // path, no PYTHON* variables, no user site) without writing bytecode (-B), in a minimal environment.
  const scriptsChanged = mergeBase ? scriptsChangedSince(draft, mergeBase) : null;
  if (!existsSync(join(draft, "scripts", "validate.py"))) {
    fail.push({ code: "validator", text: "scripts/validate.py is missing in the draft worktree. Restore it from the base branch; the gate runs the repository's own validator." });
  } else if (scriptsChanged === null) {
    fail.push({ code: "validator", text: "The validator was not run: scripts/ cannot be compared with the base branch. The draft worktree must come from the command in your brief." });
  } else if (scriptsChanged) {
    fail.push({ code: "validator", text: "The branch adds or changes files under scripts/. Restore scripts/ exactly as the base branch has it and delete any file you added there; a skill branch changes only its skill folder and README.md." });
  } else if (!dirProblem) {
    const env = /** @type {Record<string, string>} */ (Object.fromEntries(["PATH", "HOME", "LANG", "LC_ALL", "SYSTEMROOT", "TMPDIR"].flatMap((k) => (process.env[k] ? [[k, String(process.env[k])]] : []))));
    const r = spawnSync("python3", ["-I", "-B", "scripts/validate.py", skillRel], { cwd: draft, env, encoding: "utf8", timeout: VALIDATOR_MS, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 });
    const err = /** @type {NodeJS.ErrnoException | undefined} */ (r.error);
    if (err && err.code === "ENOENT") {
      fail.push({ code: "validator", text: "python3 is not available, so the validator could not run. Say so under OPEN in your report; the stop cannot pass this check without it." });
    } else if (err || r.status !== 0) {
      const raw = mask(`${r.stdout ?? ""}${r.stderr ?? ""}`).trim();
      const out = raw.length > 1500 ? `...${raw.slice(-1500)}` : raw;
      const why = err ? `did not finish within ${VALIDATOR_MS / 1000} s` : `exited ${r.status}`;
      fail.push({ code: "validator", text: `python3 scripts/validate.py ${skillRel} ${why}. Fix what it reports and run it again in the draft worktree.${out ? `\n   Validator output:\n   ${out.split("\n").join("\n   ")}` : ""}` });
    }
  }

  // c. Secrets and personal details: every file of the skill, whatever its content, and the README lines the branch
  // adds. A file too large to scan or unreadable is a finding of its own, never skipped.
  /** @type {{ file: string, line: number | null, kind: string }[]} */
  const findings = [];
  if (!dirProblem) {
    for (const rel of filesUnder(skillDir)) {
      const file = `${skillRel}/${rel}`;
      try {
        const abs = join(skillDir, ...rel.split("/"));
        const size = statSync(abs).size;
        if (size > MAX_SCAN_BYTES) {
          findings.push({ file, line: null, kind: `too large to scan (${size} bytes; the limit is ${MAX_SCAN_BYTES} bytes): remove it or split it` });
          continue;
        }
        // Bytes as latin1, and once more with NUL bytes removed, so text stored as UTF-16 is scanned too.
        const raw = readFileSync(abs).toString("latin1");
        const seen = new Set();
        for (const text of raw.includes("\0") ? [raw, raw.replace(/\0/g, "")] : [raw]) {
          for (const f of scanText(text)) {
            const key = `${f.line}:${f.kind}`;
            if (!seen.has(key)) findings.push({ file, ...f });
            seen.add(key);
          }
        }
      } catch {
        findings.push({ file, line: null, kind: "cannot be read, so it was not scanned: make it a readable file or remove it" });
      }
    }
  }
  for (const { line, text } of addedReadmeLines(draft, mergeBase)) for (const f of scanText(text)) findings.push({ file: "README.md", line, kind: f.kind });
  if (findings.length) {
    const shown = findings.slice(0, MAX_FINDINGS_SHOWN).map((f) => `   - ${f.file}${f.line === null ? "" : ` line ${f.line}`}: ${f.kind}`);
    const more = findings.length > MAX_FINDINGS_SHOWN ? [`   - and ${findings.length - MAX_FINDINGS_SHOWN} more`] : [];
    fail.push({
      code: "secrets",
      text: [`Possible secrets or personal details, or files the scan could not read (${findings.length}). Remove each secret, or replace it with a placeholder such as <token>, user@example.com or ~/; never put a real key, address or home path in a skill:`, ...shown, ...more].join("\n"),
    });
  }

  // d. The seal.
  const v = dirProblem ? null : verify(skillDir);
  if (v && !v.ok) {
    fail.push({ code: "seal", text: `The seal does not match the skill: ${v.problems.slice(0, 10).join("; ")}. Run the seal command from your brief after your last change, then commit.` });
  }

  // e. Committed on the branch.
  /** @type {string[]} */
  const gitIssues = [];
  const st = git(draft, ["status", "--porcelain"]);
  if (st.status !== 0) gitIssues.push("git status failed in the draft worktree");
  else if (st.out.trim()) gitIssues.push(`the draft worktree has ${st.out.split("\n").filter(Boolean).length} uncommitted paths; commit them on ${branch}`);
  const head = git(draft, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (head.status === 0 && head.out.trim() !== branch) gitIssues.push(`the draft worktree is not on branch ${branch}; check it out there`);
  if (git(draft, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).status !== 0) gitIssues.push(`branch ${branch} does not exist; create the draft worktree with the command from your brief`);
  else if (!baseRef) gitIssues.push(`the base branch of ${branch} cannot be found; the draft worktree must come from the command in your brief`);
  else {
    const ahead = git(draft, ["rev-list", "--count", `${baseRef}..refs/heads/${branch}`]);
    if (ahead.status !== 0 || Number(ahead.out.trim()) < 1) gitIssues.push(`branch ${branch} has no commit that ${baseRef} lacks; commit the skill, its README.md row and provenance.json on it`);
  }
  if (gitIssues.length) fail.push({ code: "git_state", text: `${gitIssues.join("; ")}. Commit only; never push.` });
  return fail;
}

/** The first user message of a transcript as text, or "". @param {unknown} path */
function briefFromTranscript(path) {
  if (typeof path !== "string" || !path) return "";
  try {
    for (const l of readFileSync(path, "utf8").split("\n")) {
      if (!l) continue;
      let e;
      try {
        e = JSON.parse(l);
      } catch {
        continue;
      }
      if (e?.type !== "user") continue;
      const c = e.message?.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((/** @type {any} */ b) => (b?.type === "text" && typeof b.text === "string" ? b.text : "")).join("\n");
      return "";
    }
  } catch {
    // no transcript
  }
  return "";
}

/** Both paths name the same folder (real paths). @param {string} a @param {string} b */
function sameDir(a, b) {
  try {
    return !!a && realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/** @param {Record<string, unknown>} rec */
function log(rec) {
  try {
    ensureStateDir();
    appendFileSync(join(stateDir, LOG), `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`);
  } catch {
    // logging must never change the decision
  }
}

async function run() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  /** @type {any} */
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    return 0;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return 0;
  if (input.hook_event_name !== undefined && input.hook_event_name !== "SubagentStop") return 0;
  const type = typeof input.agent_type === "string" ? input.agent_type : "";
  if (!OWN_IMPLEMENTER.has(type)) return 0;
  const sessionId = typeof input.session_id === "string" ? input.session_id : "";
  const agentId = typeof input.agent_id === "string" && input.agent_id ? input.agent_id : null;
  if (!agentId) return 0;

  // The launch record of this agent in this session, else the brief in its transcript.
  const launch = readJsonl(stateDir, "journal-launches.jsonl").findLast((e) => e.session_id === sessionId && e.agent_id === agentId);
  /** @type {{ kind: unknown, skill: unknown, target: unknown, slice: unknown } | null} */
  let facts = null;
  if (launch) {
    if (launch.agent_type !== "implementer") return 0;
    facts = { kind: launch.kind, skill: launch.skill, target: launch.target, slice: launch.slice };
  } else {
    const brief = briefFromTranscript(input.agent_transcript_path);
    if (!brief) return 0;
    const h = parseHeader(brief);
    facts = { kind: h.kind, skill: h.skill, target: h.target, slice: sliceOfBrief(brief) };
  }
  if (facts.kind !== "skill" || !isSkillName(facts.skill)) return 0;
  const name = facts.skill;
  const target = facts.target === "public" ? "public" : "private";
  const slice = typeof facts.slice === "string" ? facts.slice : null;
  const draft = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "orchestration", "skill-drafts", target, name);
  const base = { session_id: sessionId, agent_id: agentId, agent_type: type, slice, skill: name, target };

  /** @type {{ code: string, text: string }[]} */
  let failures;
  let isDir = false;
  try {
    isDir = lstatSync(draft).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    failures = [{ code: "draft_missing", text: `The draft worktree ${draft} does not exist. Create it with the worktree command from your brief, write the skill there, seal it and commit it on skill/${name}.` }];
  } else if (!sameDir(git(draft, ["rev-parse", "--show-toplevel"]).out.trim(), draft)) {
    failures = [{ code: "draft_missing", text: `${draft} is not a git worktree of the skills repository. Create the draft worktree with the command from your brief.` }];
  } else {
    // The base is the commit the plan check pinned at this skill's first allowed launch, before the worker could
    // commit anything: a branch name could be moved onto the worker's own commits. Older records hold the name only.
    const allows = readJsonl(stateDir, "skill-create.jsonl").filter((e) => e.session_id === sessionId && e.decision === "allow" && e.skill === name);
    const pinned = allows.find((e) => typeof e.base_sha === "string" && /^[0-9a-f]{40,64}$/.test(e.base_sha));
    const made = allows.findLast((e) => typeof e.base === "string" && e.base);
    failures = checkDraft({ draft, name, base: pinned ? String(pinned.base_sha) : made ? String(made.base) : null });
  }
  const failed = failures.map((f) => f.code);
  if (!failures.length) {
    log({ ...base, decision: "allow", reason: "ok", failed, problems: 0 });
    return 0;
  }
  const blocks = readJsonl(stateDir, LOG).filter((e) => e.session_id === sessionId && e.agent_id === agentId && e.slice === slice && e.decision === "block").length;
  if (blocks >= MAX_BLOCKS) {
    log({ ...base, decision: "allow", reason: "skill_gate_gave_up", failed, problems: failures.length, blocks });
    return 0;
  }
  log({ ...base, decision: "block", reason: "checks_failed", failed, problems: failures.length, blocks: blocks + 1 });
  const msg = [
    `Skill gate: the draft skill ${name} is not ready (${failures.length} ${failures.length === 1 ? "problem" : "problems"}). The draft worktree is ${draft}. Fix each, then stop again:`,
    ...failures.map((f, i) => `${i + 1}. [${f.code}] ${f.text}`),
  ].join("\n");
  process.stderr.write(`${msg}\n`);
  return 2;
}

try {
  process.exitCode = await run();
} catch {
  process.exitCode = 0;
}
