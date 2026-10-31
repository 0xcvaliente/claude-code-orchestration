#!/usr/bin/env node
// PreToolUse hook (matcher WebFetch): keeps a reviewer's fetches to the hosts its own work names. The reviewer holds
// untrusted input, the repo and an outward channel; a page or file it reads could ask it to send data to some URL.
// Allowed hosts: the hosts of the URLs in the reviewer's brief (brief.mjs briefUrls) plus the hosts of URLs found in
// the planned FILES of the brief's slice (parseHeader(brief).slice, files from the session's open run via run.mjs; at
// most 1 MB read per file). A fetch whose host (lowercased, leading "www." ignored) is allowed exits 0; any other is
// denied with exit 2. WebSearch is not gated.
// The brief is the subagent's first user message in its own transcript. Live check (Claude Code 2.1.316,
// docs/data/live-checks-2026-10-31.md, "Check E"): a subagent's PreToolUse input carries agent_id and agent_type but no
// agent_transcript_path; transcript_path is the main session's. The subagent transcript is
// <transcript_path minus .jsonl>/subagents/agent-<agent_id>.jsonl (Agent tool, foreground or background) or
// .../subagents/workflows/<run>/agent-<agent_id>.jsonl (workflow agent(), its brief wrapped and indented by the harness).
// Brief unreadable: exit 0 and log egress_unverified.
// Deny-only: exit 2 with the reason on stderr, or exit 0 with no output; never an allow or ask decision. Acts only for
// the bare agent_type `reviewer`; ORCH_GUARDS=off disables it; malformed input exits 0. Decisions go to gates.jsonl
// (gate "egress", the host only, never the URL path, the brief or file text).
import { appendFileSync, closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { briefUrls, parseHeader } from "./brief.mjs";
import { sessionRuns } from "./run.mjs";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

const MAX_BYTES = 1 << 20;

/** Host of a URL, lowercased, without a leading www.; null when it does not parse. @param {string} url */
export function hostOf(url) {
  try {
    const h = new URL(url).hostname.toLowerCase().replace(/\.$/, "");
    return h ? h.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

/** First `max` bytes of a file as text; "" when unreadable. @param {string} path @param {number} [max] */
export function readHead(path, max = MAX_BYTES) {
  let fd;
  try {
    if (!statSync(path).isFile()) return "";
    fd = openSync(path, "r");
    const buf = Buffer.alloc(max);
    const n = readSync(fd, buf, 0, max, 0);
    return buf.subarray(0, n).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The subagent's own transcript, from the main transcript path and the agent id; null when none is found.
 * @param {unknown} transcriptPath @param {unknown} agentId @returns {string | null}
 */
export function agentTranscript(transcriptPath, agentId) {
  if (typeof transcriptPath !== "string" || !transcriptPath.endsWith(".jsonl")) return null;
  if (typeof agentId !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(agentId)) return null;
  const sub = join(transcriptPath.slice(0, -".jsonl".length), "subagents");
  const direct = join(sub, `agent-${agentId}.jsonl`);
  if (existsSync(direct)) return direct;
  try {
    for (const run of readdirSync(join(sub, "workflows"))) {
      const p = join(sub, "workflows", run, `agent-${agentId}.jsonl`);
      if (existsSync(p)) return p;
    }
  } catch {
    // no workflow agents in this session
  }
  return null;
}

/** Text of the first user message in a transcript; null when there is none. @param {string} path @returns {string | null} */
export function firstUserText(path) {
  for (const line of readHead(path, 4 * MAX_BYTES).split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r?.type !== "user") continue;
      const c = r.message?.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("\n");
      return null;
    } catch {
      // a partial last line
    }
  }
  return null;
}

/**
 * Allowed hosts for a reviewer brief: its URLs' hosts plus the hosts of URLs in its slice's planned files.
 * @param {string} brief @param {string[]} files planned FILES of the brief's slice @param {string} baseDir
 * @returns {Set<string>}
 */
export function allowedHosts(brief, files, baseDir) {
  const hosts = new Set(/** @type {string[]} */ (briefUrls(brief).map(hostOf).filter(Boolean)));
  for (const f of files) {
    if (typeof f !== "string" || !f || /[*?[]/.test(f)) continue;
    for (const u of briefUrls(readHead(isAbsolute(f) ? f : resolve(baseDir, f)))) {
      const h = hostOf(u);
      if (h) hosts.add(h);
    }
  }
  return hosts;
}

/**
 * The decision for one WebFetch input. "skip": not ours; "unverified": the brief cannot be read; else allow or deny.
 * @param {any} input @param {{ env?: NodeJS.ProcessEnv, dir?: string }} [opts]
 * @returns {{ decision: "skip" | "unverified" | "allow" | "deny", host?: string | null, reason?: string }}
 */
export function egressDecision(input, opts = {}) {
  const env = opts.env ?? process.env;
  if ((env.ORCH_GUARDS ?? "").trim().toLowerCase() === "off") return { decision: "skip" };
  if (typeof input !== "object" || input === null) return { decision: "skip" };
  const type = typeof input.agent_type === "string" ? input.agent_type.replace(/^orchestration:/, "") : "";
  if (type !== "reviewer" || (input.tool_name !== undefined && input.tool_name !== "WebFetch")) return { decision: "skip" };
  const url = input.tool_input?.url;
  if (typeof url !== "string" || !url.trim()) return { decision: "skip" };
  const host = hostOf(url);
  const path = agentTranscript(input.transcript_path, input.agent_id);
  const brief = path ? firstUserText(path) : null;
  if (!brief) return { decision: "unverified", host };
  /** @type {string[]} */
  let files = [];
  const slice = parseHeader(brief).slice;
  if (slice && typeof input.session_id === "string") {
    try {
      const { open } = sessionRuns(input.session_id, { dir: opts.dir ?? stateDir, env });
      files = open?.slices[slice]?.files ?? [];
    } catch {
      files = [];
    }
  }
  // Known limit (review GAP 25): planned files are read from the reviewer's cwd (else the project dir). A file that so
  // far exists only on an isolated slice's branch (its worktree) is not seen there, so its URLs do not count. This fails
  // safe: such a fetch is denied, never allowed, and the brief can name the URL itself.
  const base = typeof input.cwd === "string" && input.cwd ? input.cwd : env.CLAUDE_PROJECT_DIR || process.cwd();
  const allowed = allowedHosts(brief, files, base);
  if (host && allowed.has(host)) return { decision: "allow", host };
  return {
    decision: "deny",
    host,
    reason: `host ${host ?? "(unreadable URL)"} is not named in this reviewer's brief or its slice's planned files${allowed.size ? ` (allowed: ${[...allowed].slice(0, 10).join(", ")})` : " (no URLs there)"}`,
  };
}

if (process.argv[1]?.endsWith("egress-guard.mjs")) {
  if ((process.env.ORCH_GUARDS ?? "").trim().toLowerCase() === "off") process.exit(0);
  if (duplicate("egress-guard.mjs")) process.exit(0);
  /** @type {any} */
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    process.exit(0);
  }
  /** @type {ReturnType<typeof egressDecision>} */
  let d;
  try {
    d = egressDecision(input);
  } catch {
    process.exit(0);
  }
  if (d.decision === "skip") process.exit(0);
  try {
    ensureStateDir();
    const reason = d.decision === "unverified" ? "egress_unverified" : d.decision === "deny" ? "host_not_in_brief" : "host_in_brief";
    const rec = { ts: new Date().toISOString(), gate: "egress", decision: d.decision === "unverified" ? "allow" : d.decision, reason, host: d.host ?? null, session_id: input.session_id, agent_id: input.agent_id };
    appendFileSync(join(stateDir, "gates.jsonl"), `${JSON.stringify(rec)}\n`);
  } catch {
    // A failed log write never changes the decision.
  }
  if (d.decision === "deny") {
    process.stderr.write(`orchestration egress guard denied this fetch: ${d.reason}. A reviewer may fetch only hosts its brief or its slice's files name.\n`);
    process.exit(2);
  }
  process.exit(0);
}
