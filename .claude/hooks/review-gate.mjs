#!/usr/bin/env node
// Stop gate: if this session ran an implementer, the final reply waits until its work has a passing review.
// Exit 2 blocks and returns stderr; every decision goes to gates.jsonl in the state dir (state.mjs).
//
// 1. Agents still running: allow, reason agents_running, not counted as a block (the next Stop gates). Claude Code is
//    async: a background Agent launch returns at once, so a Stop can fire while its reviewer still runs (plugin logs:
//    430 of 440 give-ups fired while an agent was running, 320 of them a reviewer). Verified on Claude Code 2.1.314:
//    Stop input carries `background_tasks` (entries: id, type "subagent" | "workflow" | "shell" | ..., status such as
//    "running", description, agent_type for subagents, name for workflows); the final Stop of a finished session has
//    []. Headless `claude -p` fires an early Stop listing running tasks, delivers the result as a task-notification
//    UserPromptSubmit with a new prompt_id, then fires a second Stop. An active subagent, workflow or teammate entry
//    (running, pending or queued) defers. Without `background_tasks` (older Claude Code): a SubagentStart in
//    telemetry.jsonl with no later SubagentStop for its agent_id defers, but only a start younger than
//    ORCH_RUN_STALE_MIN minutes, so a lost stop cannot defer forever.
// 1b. Implementers that started and never stopped (1.2.0): implementer_unfinished. A subagent that runs out of turns
//    (maxTurns) or is killed fires no SubagentStop (seen on Claude Code 2.1.322: the only subagent starts without a
//    stop in the logs are the ones that hit the turn limit), so the test gate never ran for it and the journal has no
//    stop record: the fold counts no attempt and nothing below would gate its slice. Once nothing is running (step 1),
//    an implementer of this session whose latest SubagentStart has no later SubagentStop, and that has a launch record
//    (an Agent tool launch, so workflow agents are left to their script), blocks until it is resumed and stops, or a
//    later implementer stop of the same slice (any later implementer stop when its brief named no slice) takes over.
//    Its loop guard is per agent for the whole session: two blocks that name it, one give-up, then it is left alone.
// 2. Per slice of the current run (run.mjs folds journal-launches.jsonl, journal.jsonl, gates.jsonl and telemetry.jsonl
//    with brief.mjs foldRuns): every slice of the latest run with an implementer attempt, and the slice of the session's
//    last implementer, needs its latest review after its latest attempt to pass (no_reviewer_after_last_implementer,
//    last_reviewer_failed, last_reviewer_no_status). If that reviewer's brief had CHECKS, every id must be answered
//    with pass (constraints_unchecked; a brief without CHECKS skips this, logged). If a doubt signal fired (risky,
//    retry, read_answer, open_items, tests_failed_isolated; ORCH_ESCALATION=off|always), a passing review by an opus
//    reviewer must exist after the latest attempt (opus_review_required). A slice that failed for good (latest review
//    failed after 3 attempts) does not block: slice_failed_for_good, with a systemMessage naming it.
//    Reviews count by brief.mjs's fold (docs/brief-grammar.md, "Review counting"): a fail whose gaps are all below
//    ORCH_GAP_MIN (default 80; 0 = every fail counts) counts as a pass and adds the doubt signal low_confidence_fail;
//    a VALIDATE: gaps review supersedes the earlier reviews of the same attempt. Stall gate (ORCH_STALL_GATE, on unless
//    "off"): a slice whose last two counted failed reviews share a gap key at or above the cutoff, with no REPLAN plan
//    review finished since, blocks with replan_required instead of last_reviewer_failed.
// 3. Fallback, the old rule, when the session's last implementer has no slice in the run model (workflow agents, old
//    briefs, launches outside a run): a reviewer must have finished after the last implementer (telemetry.jsonl) with
//    STATUS: pass. Status is brief.mjs parseStatus (telemetry.mjs and journal.mjs both use it).
// Loop guard: at most MAX_BLOCKS blocks per reason since the last implementer stopped (a gate record with no reason,
// from older versions, counts for every reason). Then the reply goes out with a systemMessage saying the work is
// unverified, so giving up is never silent. Exits 0 on malformed input.
import { appendFileSync, existsSync, writeSync } from "node:fs";
import { join } from "node:path";
import { countedStatus, currentReviews, doubtSignals, hasOpusPass, staleMinutes, stallGateOn } from "./brief.mjs";
import { readJsonl, sessionRuns, sliceOfAgent } from "./run.mjs";
import { duplicate, ensureStateDir, stateDir } from "./state.mjs";

const MAX_BLOCKS = 2; // per reason since the last implementer finished; a new implementer stop resets the count
const ACTIVE_TYPES = new Set(["subagent", "workflow", "teammate"]);
const ACTIVE_STATUS = new Set(["running", "pending", "queued"]);
// Reasons that existed before slice A1 give up as "max_blocks_reached" (as before); the new ones as <reason>_gave_up.
const NEW_REASONS = new Set(["constraints_unchecked", "opus_review_required", "replan_required", "implementer_unfinished"]);
let sessionId = "";
/** @param {string} decision @param {string} reason @param {number} code @param {Record<string, unknown>} [extra] @returns {never} */
function decide(decision, reason, code, extra = {}) {
  try {
    ensureStateDir();
    appendFileSync(join(stateDir, "gates.jsonl"), `${JSON.stringify({ ts: new Date().toISOString(), gate: "review", decision, reason, session_id: sessionId, ...extra })}\n`);
  } catch {
    // logging must never change the decision
  }
  process.exit(code);
}
/** @param {number} fd @param {string} text */
const say = (fd, text) => {
  try {
    writeSync(fd, `${text}\n`);
  } catch {
    // a closed stream must not change the decision
  }
};

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
if (duplicate("review-gate.mjs")) process.exit(0); // the project's own copy gates this reply
/** @type {any} */
let input = {};
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
} catch {
  decide("allow", "unparseable_input", 0);
}
if (!input || typeof input !== "object") decide("allow", "unparseable_input", 0);
sessionId = typeof input.session_id === "string" ? input.session_id : "";
const now = Date.now();
const staleMs = staleMinutes(process.env) * 60000;

/** @param {unknown} ts */
const time = (ts) => Date.parse(String(ts ?? "")) || 0;
// Plugin agents arrive namespaced ("orchestration:implementer"); compare the bare role name.
/** @param {any} e */
const role = (e) => String(String(e.agent_type ?? e.role ?? "").split(":").pop());
const telemetry = readJsonl(stateDir, "telemetry.jsonl").filter((e) => e.session_id === sessionId);

// 1. Agents still running.
/** @returns {{ source: string, agents: string[] } | null} */
function running() {
  if (Array.isArray(input.background_tasks)) {
    const active = input.background_tasks.filter(
      (/** @type {any} */ t) => t && ACTIVE_TYPES.has(String(t.type ?? "").toLowerCase()) && ACTIVE_STATUS.has(String(t.status ?? "").toLowerCase()),
    );
    return active.length ? { source: "background_tasks", agents: active.map((/** @type {any} */ t) => String(t.agent_type ?? t.name ?? t.type)) } : null;
  }
  /** @type {Map<string, { start: number, stop: number, type: string }>} */
  const agents = new Map();
  for (const e of telemetry) {
    if (typeof e.agent_id !== "string" || !e.agent_id) continue;
    const a = agents.get(e.agent_id) ?? { start: -Infinity, stop: -Infinity, type: role(e) };
    if (e.hook_event_name === "SubagentStart") a.start = Math.max(a.start, time(e.ts));
    if (e.hook_event_name === "SubagentStop") a.stop = Math.max(a.stop, time(e.ts));
    agents.set(e.agent_id, a);
  }
  const live = [...agents.values()].filter((a) => a.start > a.stop && now - a.start <= staleMs);
  return live.length ? { source: "telemetry", agents: live.map((a) => a.type) } : null;
}
const busy = running();
if (busy) decide("allow", "agents_running", 0, { source: busy.source, agents: busy.agents });

if (!existsSync(join(stateDir, "telemetry.jsonl"))) decide("allow", "no_telemetry", 0);
const stops = telemetry.filter((e) => e.hook_event_name === "SubagentStop");
const implStops = stops.filter((e) => role(e) === "implementer");
const lastImpl = implStops.at(-1);
// 1b. Implementer agents whose latest SubagentStart has no later SubagentStop (step 1 found nothing running).
/** @type {Map<string, { id: string, start: number, stop: number }>} */
const implAgents = new Map();
for (const e of telemetry) {
  if (role(e) !== "implementer" || typeof e.agent_id !== "string" || !e.agent_id) continue;
  const a = implAgents.get(e.agent_id) ?? { id: e.agent_id, start: -Infinity, stop: -Infinity };
  if (e.hook_event_name === "SubagentStart") a.start = Math.max(a.start, time(e.ts));
  if (e.hook_event_name === "SubagentStop") a.stop = Math.max(a.stop, time(e.ts));
  implAgents.set(e.agent_id, a);
}
const neverStopped = [...implAgents.values()].filter((a) => a.start > a.stop);
if (!lastImpl && !neverStopped.length) decide("allow", "no_implementer_in_session", 0);

/** @type {ReturnType<typeof sessionRuns>["runs"]} */
let runs = [];
/** @type {ReturnType<typeof sessionRuns>["records"]} */
let records = { launches: [], stops: [], gates: [], starts: [] };
let foldFailed = false;
try {
  ({ runs, records } = sessionRuns(sessionId, { now, env: process.env }));
} catch {
  foldFailed = true;
}
// This session's review-gate records. An unfinished implementer is gated for its own lifetime, not per window: two
// blocks that name it, one give-up that names it, and then it is left alone, so an implementer the person stopped
// early in a long session does not block every later piece of work again.
const sessionGates = readJsonl(stateDir, "gates.jsonl").filter((g) => g.gate === "review" && g.session_id === sessionId);
/** @param {any} g @param {string} id */
const names = (g, id) => Array.isArray(g.unfinished) && g.unfinished.includes(id);
/** @param {string} id */
const unfinishedBlocks = (id) => sessionGates.filter((g) => g.decision === "block" && names(g, id)).length;
// Only an Agent tool launch (it has a launch record) counts, and only while no later implementer stop took the slice over.
const unfinished = neverStopped.flatMap((a) => {
  if (!records.launches.some((l) => l.agent_id === a.id && !l.workflow)) return [];
  if (sessionGates.some((g) => g.decision === "allow" && names(g, a.id))) return []; // the gate already gave up on it
  const slice = sliceOfAgent(records, a.id);
  const takenOver = slice
    ? records.stops.some((st) => role(st) === "implementer" && st.slice === slice && st.agent_id !== a.id && time(st.ts) > a.start)
    : implStops.some((e) => e.agent_id !== a.id && time(e.ts) > a.start);
  return takenOver ? [] : [{ ...a, slice }];
});
if (!lastImpl && !unfinished.length) decide("allow", "no_implementer_in_session", 0);

// Count only blocks after the last implementer finished (or, later than that, an unfinished one started). Counting the
// whole session would stop gating for good after MAX_BLOCKS, so later work in a long session would go out unreviewed.
// A record with no ts counts them all.
const since = Math.max(lastImpl ? time(lastImpl.ts) : 0, ...unfinished.map((u) => u.start));
const priorBlocks = sessionGates.filter((g) => g.decision === "block" && Date.parse(g.ts) >= since);
/** @param {string} reason */
const blocksFor = (reason) => priorBlocks.filter((g) => g.reason === undefined || g.reason === reason).length;

/** @typedef {{ reason: string, message: string, slice?: string, agent?: string }} Problem */
/** @type {Problem[]} */
const problems = [];
/** @type {string[]} */
const failedForGood = [];
/** @type {string[]} */
const skips = [];

// A fold that throws on the log's data must not approve the reply: block (with the usual loop guard) instead.
if (foldFailed) problems.push({ reason: "run_state_unreadable", message: "Review gate: the run state could not be folded from the logs, so the work cannot be shown reviewed. Send the result to a reviewer before replying, or say in your reply that it is unverified." });
for (const u of unfinished) {
  problems.push({
    ...(u.slice ? { slice: u.slice } : {}),
    agent: u.id,
    reason: "implementer_unfinished",
    message: `Review gate: ${u.slice ? `slice ${u.slice}` : "an implementer"}: its implementer (agent ${u.id}) started and never finished: it ran out of turns or was stopped, so its work was neither tested nor reviewed. Resume it with SendMessage (to: ${u.id}) so it finishes, or start a fresh implementer for the slice, then review the result; or report the slice as failed.`,
  });
}

// 2. Per slice of the current run.
const latest = runs.at(-1);
/** @type {Map<string, { run: import("./brief.mjs").Run, s: import("./brief.mjs").SliceState }>} */
const gated = new Map();
if (latest) for (const s of Object.values(latest.slices)) if (s.attempts > 0) gated.set(`${latest.id}:${s.slice}`, { run: latest, s });
const lastSlice = lastImpl ? sliceOfAgent(records, lastImpl.agent_id) : null;
const lastRun = lastSlice ? runs.findLast((r) => (r.slices[lastSlice]?.attempts ?? 0) > 0) : undefined;
const lastState = lastRun && lastSlice ? lastRun.slices[lastSlice] : undefined;
if (lastRun && lastState) gated.set(`${lastRun.id}:${lastSlice}`, { run: lastRun, s: lastState });

// 3. Fallback: the last implementer is not in the run model, so the old session-wide rule decides for it.
if (lastImpl && !lastState) {
  skips.push(lastSlice ? "last_implementer_outside_run" : "last_implementer_no_slice");
  const reviews = stops.slice(stops.lastIndexOf(lastImpl) + 1).filter((e) => role(e) === "reviewer");
  const last = reviews.at(-1);
  if (!last) problems.push({ reason: "no_reviewer_after_last_implementer", message: "Review gate: an implementer finished but no reviewer has run since. Send the result to a reviewer before replying." });
  else if (last.status === "fail") problems.push({ reason: "last_reviewer_failed", message: "Review gate: the last reviewer reported STATUS: fail. Retry the implementer with the gaps, or report the slice as failed with evidence." });
  else if (last.status !== "pass") problems.push({ reason: "last_reviewer_no_status", message: "Review gate: the last reviewer returned no STATUS line. Rerun the review, or report the slice as failed." });
}

for (const { run, s } of gated.values()) {
  const name = `slice ${s.slice} (run ${run.id})`;
  const review = currentReviews(s).at(-1);
  if (s.gaveUp) {
    failedForGood.push(s.slice);
    continue;
  }
  if (!review) {
    problems.push({ slice: s.slice, reason: "no_reviewer_after_last_implementer", message: `Review gate: ${name}: an implementer finished but no reviewer has run since. Send the result to a reviewer (brief starting SLICE: ${s.slice}) before replying.` });
    continue;
  }
  const counted = countedStatus(review);
  if (counted === "fail" && s.stalled && stallGateOn(process.env)) {
    problems.push({
      slice: s.slice,
      reason: "replan_required",
      message: `Review gate: ${name}: its last two failed reviews report the same gap, so another retry is unlikely to fix it. Send the plan to the plan reviewer in a brief that starts with PLAN REVIEW and REPLAN: <n>, with a changed approach for the slice, before retrying; or report the slice as failed with the reviewer's gaps.`,
    });
    continue;
  }
  if (counted === "fail") {
    problems.push({ slice: s.slice, reason: "last_reviewer_failed", message: `Review gate: ${name}: the last reviewer reported STATUS: fail. Retry the implementer with the gaps, or report the slice as failed with evidence.` });
    continue;
  }
  if (counted !== "pass") {
    problems.push({ slice: s.slice, reason: "last_reviewer_no_status", message: `Review gate: ${name}: the last reviewer returned no STATUS line. Rerun the review, or report the slice as failed.` });
    continue;
  }
  if (review.lowConfidence) skips.push(`last_reviewer_failed:${s.slice}:low_confidence`);
  if (!review.checks.length) skips.push(`constraints_unchecked:${s.slice}:no_checks`);
  else {
    const missing = review.checks.filter((id) => !review.answers[id]);
    const failed = review.checks.filter((id) => review.answers[id]?.verdict === "fail");
    if (missing.length || failed.length) {
      const what = [missing.length ? `without answering ${missing.join(", ")}` : "", failed.length ? `with ${failed.join(", ")} answered fail` : ""].filter(Boolean).join(" and ");
      problems.push({
        slice: s.slice,
        reason: "constraints_unchecked",
        message: `Review gate: ${name}: the reviewer passed it ${what}. Rerun the review with one line per CHECKS id: \`C1: pass (cmd) <command> -> <result>\`, \`C1: pass (read) <file:line or URL>\` or \`C1: fail <reason>\`, or fix the slice.`,
      });
      continue;
    }
  }
  const signals = doubtSignals(s, process.env);
  if (signals.length && !hasOpusPass(s)) {
    problems.push({
      slice: s.slice,
      reason: "opus_review_required",
      message: `Review gate: ${name} needs a passing review by an opus reviewer after its latest implementer attempt (doubt signals: ${signals.join(", ")}). Launch the reviewer with model: "opus" and the slice's CHECKS.`,
    });
  }
}

// Block on the first problem whose reason has blocks left; the message lists every open problem.
/** Blocks already spent on a problem: per agent for an unfinished implementer, per reason in the window otherwise. @param {Problem} p */
const spent = (p) => (p.agent ? unfinishedBlocks(p.agent) : blocksFor(p.reason));
// Every block message names all open problems, so each block and each give-up records the unfinished agents it named.
const unfinishedIds = problems.flatMap((p) => (p.agent ? [p.agent] : []));
const live = problems.find((p) => spent(p) < MAX_BLOCKS);
if (live) {
  const others = problems.filter((p) => p !== live).map((p) => p.message.replace(/^Review gate: /, ""));
  const last = spent(live) === MAX_BLOCKS - 1 ? " This is the last block: if no reviewer can pass the work, say in your reply that it is unverified and report the slice as failed." : "";
  say(2, `${live.message}${others.length ? ` Also: ${others.join(" ")}` : ""}${last}`);
  decide("block", live.reason, 2, { ...(live.slice ? { slice: live.slice } : {}), ...(unfinishedIds.length ? { unfinished: unfinishedIds } : {}), ...(skips.length ? { skips } : {}) });
}

const notes = [];
if (failedForGood.length) notes.push(`Review gate: ${failedForGood.map((s) => `slice ${s}`).join(", ")} failed for good (latest review failed after 3 implementer attempts). Report ${failedForGood.length > 1 ? "them" : "it"} as failed with the reviewer's gaps.`);
if (problems.length) {
  const reasons = [...new Set(problems.map((p) => p.reason))];
  const slices = [...new Set(problems.map((p) => p.slice).filter(Boolean))];
  notes.unshift(`Review gate: gave up after ${MAX_BLOCKS} blocks (${reasons.join(", ")}). ${slices.length ? `The work of ${slices.map((s) => `slice ${s}`).join(", ")} is` : "The last implementer's work is"} unverified; treat it as failed until a reviewer passes it.`);
  say(1, JSON.stringify({ systemMessage: notes.join(" ") }));
  say(2, notes.join(" "));
  const first = /** @type {string} */ (reasons[0]);
  decide("allow", NEW_REASONS.has(first) ? `${first}_gave_up` : "max_blocks_reached", 0, { gave_up: reasons, ...(unfinishedIds.length ? { unfinished: unfinishedIds } : {}), ...(failedForGood.length ? { failed_for_good: failedForGood } : {}), ...(skips.length ? { skips } : {}) });
}
if (failedForGood.length) {
  say(1, JSON.stringify({ systemMessage: notes.join(" ") }));
  say(2, notes.join(" "));
  decide("allow", "slice_failed_for_good", 0, { failed_for_good: failedForGood, ...(skips.length ? { skips } : {}) });
}
decide("allow", "reviewer_passed", 0, skips.length ? { skips } : {});
