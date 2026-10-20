#!/usr/bin/env node
// PreToolUse gate on Agent: checks each implementer brief against the slices launched earlier in
// this session, in code, before the implementer starts. The brief carries three lines:
//   SLICE: <id>    FILES: <owned files, comma-separated>    DEPENDS: <slice ids, or none>
// Blocks (exit 2, reason on stderr) when a FILES entry overlaps a file another slice owns and that slice is not in
// DEPENDS, or when DEPENDS closes a dependency cycle. A brief without SLICE or FILES is blocked at most
// MAX_FORMAT_BLOCKS times per session, then let through, so a format slip never stalls a run.
// Same slice id again (a retry) keeps its own files. Every decision goes to plan-check.jsonl in the state dir.
// Plan review: until a reviewer whose brief starts with PLAN REVIEW has finished in this session (journal.jsonl,
// slice "plan", written by journal.mjs), implementers are blocked. PATH: light in the brief skips the wait, but only
// for a session's single slice: once another slice has run, a light brief waits like any other. Each slice is blocked
// for this at most MAX_REVIEW_BLOCKS times, then let through (no_plan_review_gave_up), which opens the gate for the
// session, so a broken journal or a skipped review never stalls a run.
// A wave's launches arrive at the same time, so read-decide-append runs under a lock (an exclusive mkdir); a lock
// older than STALE_MS is taken over, and after WAIT_MS without it the hook decides unlocked rather than stall.
// A brief with an ORCHESTRATION: workflow line (the scripted workflow) is not checked. Exits 0 on malformed input.
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

const MAX_FORMAT_BLOCKS = 2;
const MAX_REVIEW_BLOCKS = 2;
const LOG = "plan-check.jsonl";
const WAIT_MS = 5000;
const STALE_MS = 10000;

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
if (duplicate("plan-check.mjs")) process.exit(0); // the project's own copy decides this launch
let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  process.exit(0);
}
const tool = input?.tool_input ?? {};
const role = String(tool.subagent_type ?? "").split(":").pop();
if (role !== "implementer" || typeof tool.prompt !== "string") process.exit(0);
// The scripted workflow fixes the order in code and plans its own slices, so its briefs say so and skip this check.
if (/^[ \t>*_`-]*ORCHESTRATION:\**[ \t]*workflow\b/im.test(tool.prompt)) process.exit(0);
const sessionId = input.session_id ?? "";

/** @param {string} key */
const line = (key) => tool.prompt.match(new RegExp(`^[ \\t>*_\`-]*${key}:\\**[ \\t]*(.+)$`, "im"))?.[1].trim();
/** @param {string | undefined} v */
const list = (v) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim().replace(/^[`'"]+|[`'"]+$/g, "").replace(/^\.\//, ""))
    .filter((s) => s && s.toLowerCase() !== "none");
const slice = line("SLICE")?.replace(/[`'"*]/g, "").split(/\s+/)[0];
const files = list(line("FILES"));
const depends = list(line("DEPENDS"));

const lock = join(stateDir, "plan-check.lock");
let locked = false;
try {
  ensureStateDir();
  const sleep = new Int32Array(new SharedArrayBuffer(4));
  for (const start = Date.now(); !locked && Date.now() - start < WAIT_MS; ) {
    try {
      mkdirSync(lock);
      locked = true;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmSync(lock, { recursive: true, force: true });
      } catch {
        // the holder just released it
      }
      Atomics.wait(sleep, 0, 0, 25);
    }
  }
} catch {
  // no state dir: decide unlocked
}

/** @param {string} name @returns {any[]} */
const readLog = (name) => {
  try {
    return readFileSync(join(stateDir, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e && e.session_id === sessionId);
  } catch {
    return []; // no log yet, or unreadable: decide as if nothing was launched, and still release the lock
  }
};
const prior = readLog(LOG);

/** @param {string} decision @param {string} reason @param {string} [message] */
function decide(decision, reason, message) {
  try {
    ensureStateDir();
    appendFileSync(join(stateDir, LOG), `${JSON.stringify({ ts: new Date().toISOString(), session_id: sessionId, decision, reason, slice, files, depends })}\n`);
  } catch {
    // logging must never change the decision
  }
  if (locked) rmSync(lock, { recursive: true, force: true });
  if (decision === "block") {
    try {
      writeSync(2, `${message}\n`);
    } catch {
      // a closed stream must not change the decision
    }
    process.exit(2);
  }
  process.exit(0);
}

if (!slice || files.length === 0) {
  const blocks = prior.filter((e) => e.decision === "block" && e.reason === "missing_lines").length;
  if (blocks >= MAX_FORMAT_BLOCKS) decide("allow", "missing_lines_gave_up");
  decide("block", "missing_lines", "Plan check: every implementer brief starts with SLICE: <id>, FILES: <owned files, comma-separated> and DEPENDS: <slice ids or none>. Add them and launch again.");
}

const launched = prior.filter((e) => e.decision === "allow" && e.slice);
const others = [...new Set(launched.map((e) => e.slice).filter((id) => id !== slice))];
const light = /^light\b/i.test(line("PATH") ?? "") && others.length === 0;
const open =
  readLog("journal.jsonl").some((e) => e.slice === "plan" && e.role === "reviewer") ||
  prior.some((e) => e.decision === "allow" && e.reason === "no_plan_review_gave_up");
let reviewGate = "open";
if (!open && !light) {
  const blocks = prior.filter((e) => e.decision === "block" && ["no_plan_review", "light_path_multi"].includes(e.reason) && e.slice === slice).length;
  reviewGate = "gave_up";
  if (blocks < MAX_REVIEW_BLOCKS) {
    if (/^light\b/i.test(line("PATH") ?? "")) {
      decide("block", "light_path_multi", `Plan check: PATH: light is only for a task with a single slice, and this session already runs ${others.join(", ")}. A plan with several slices needs a plan review first: send the plan to a reviewer in a brief that starts with PLAN REVIEW, wait for its report, then launch the implementers.`);
    }
    decide("block", "no_plan_review", "Plan check: no plan review has finished in this session. Send the plan to a reviewer in a brief that starts with PLAN REVIEW, wait for its report, fix the plan, then launch the implementers. Only the light path (a single slice) skips this, with the line PATH: light in the brief.");
  }
}

// A glob counts as its literal prefix; two paths overlap when equal or when one is a folder of the other.
/** @param {string} p */
const base = (p) => p.replace(/\*.*$/, "").replace(/\/+$/, "");
/** @param {string} a @param {string} b */
const overlaps = (a, b) => {
  const [x, y] = [base(a), base(b)];
  if (!x || !y) return true;
  return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
};

const clashes = [];
for (const e of launched) {
  if (e.slice === slice || depends.includes(e.slice)) continue;
  for (const f of files) for (const g of e.files ?? []) if (overlaps(f, g)) clashes.push(`${f} (owned by ${e.slice})`);
}
if (clashes.length) {
  decide("block", "file_overlap", `Plan check: slice ${slice} would change files another slice owns: ${[...new Set(clashes)].join(", ")}. Give each file one owner, or list the owning slice in DEPENDS if this slice runs after it.`);
}

// Cycle: following DEPENDS from this slice's dependencies leads back to this slice.
const deps = new Map(launched.map((e) => [e.slice, e.depends ?? []]));
deps.set(slice, depends);
const seen = new Set();
const stack = [...depends];
while (stack.length) {
  const s = stack.pop();
  if (s === slice) decide("block", "dependency_cycle", `Plan check: DEPENDS of slice ${slice} forms a cycle. Fix the order in the plan.`);
  if (seen.has(s)) continue;
  seen.add(s);
  stack.push(...(deps.get(s) ?? []));
}
decide("allow", reviewGate === "gave_up" ? "no_plan_review_gave_up" : light && !open ? "light_path" : "ok");
