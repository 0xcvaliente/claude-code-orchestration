#!/usr/bin/env node
// The run-wide token cap of `npm run auto` (scripts/auto.sh). ORCH_BUDGET_TOKENS caps the whole run there: the triage
// call and every session after it (the plain session, the reviewer, the orchestrator, an escalated orchestrator). Before
// each session auto.sh subtracts what the run has spent so far and gives the session only the rest as its own
// ORCH_BUDGET_TOKENS, which scripts/orchestrate.sh turns into --max-budget-usd as before. `npm run native` is one session
// and keeps its cap as it is.
//
// What a call spent is read from what it already reports, at the launcher's rate (TOKENS_PER_USD in tokens.mjs):
//   - the triage decision of src/route.ts: `costUsd` (the call's total_cost_usd), else its `tokens`;
//   - a session's document from orchestrate.sh (scripts/run-result.mjs): `total_cost_usd`, which covers the whole session
//     and its subagents, else its token count (tokens.mjs, modelUsage or usage);
//   - anything unreadable (an error text, no document): 0, since nothing can be read from it.
// Dollars first because claude enforces the cap in dollars (--max-budget-usd and the SDK's maxBudgetUsd).
// A session never starts with less than MIN_SESSION_TOKENS, the smallest cap tokens.mjs accepts: the run ends instead.
//
// CLI (auto.sh):
//   node scripts/run-budget.mjs spent < document          prints the tokens the document's call spent (an integer)
//   node scripts/run-budget.mjs next <cap> <spent> <what>  prints the tokens left for the next session, or, when fewer than
//                                                           MIN_SESSION_TOKENS are left, says why on stderr and exits 3
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { formatTokens, parseTokens, TOKENS_PER_USD, totalTokens } from "./tokens.mjs";

/** The smallest cap the scripts accept (parseTokens' floor): a session never starts with less. */
export const MIN_SESSION_TOKENS = 10_000;
/** auto.sh's exit code when the run's cap is spent before a session could start. */
export const SPENT_EXIT = 3;

/** @param {unknown} v @returns {v is number} */
const isAmount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * Tokens a call spent, as the run's cap counts them.
 * @param {unknown} doc a triage decision or a session's result document
 */
export function spentOf(doc) {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return 0;
  const d = /** @type {Record<string, unknown>} */ (doc);
  const usd = isAmount(d.costUsd) ? d.costUsd : isAmount(d.total_cost_usd) ? d.total_cost_usd : undefined;
  if (usd !== undefined) return Math.round(usd * TOKENS_PER_USD);
  if (isAmount(d.tokens)) return Math.round(d.tokens);
  return Math.round(totalTokens(d));
}

/**
 * What is left of the run's cap for the next session.
 * @param {number} cap the run's cap in tokens
 * @param {number} spent tokens spent so far by the run
 * @returns {{ ok: true, left: number } | { ok: false, left: number }}
 */
export function nextSession(cap, spent) {
  const left = Math.max(0, Math.floor(cap - spent));
  return left >= MIN_SESSION_TOKENS ? { ok: true, left } : { ok: false, left };
}

/**
 * The message when the cap is spent before a session.
 * @param {string} capText ORCH_BUDGET_TOKENS as the person wrote it
 * @param {number} spent
 * @param {number} left
 * @param {string} what the session that does not start
 */
export const spentMessage = (capText, spent, left, what) =>
  `budget: ORCH_BUDGET_TOKENS=${capText} is the cap for the whole run, and this run has spent ${formatTokens(spent)} of it ` +
  `(the triage call and the sessions before this one), leaving ${formatTokens(left)}, under the ${formatTokens(MIN_SESSION_TOKENS)} ` +
  `a session needs: the ${what} does not start. Raise ORCH_BUDGET_TOKENS to give the run more.`;

// Entry script? Real paths on both sides: Node resolves symlinks in the main module's import.meta.url, not in argv[1].
const isEntry = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntry()) {
  const [cmd, a, b, what] = process.argv.slice(2);
  try {
    if (cmd === "spent") {
      let doc = null;
      try {
        doc = JSON.parse(readFileSync(0, "utf8"));
      } catch {
        // not a document: nothing to read, 0
      }
      console.log(String(spentOf(doc)));
    } else if (cmd === "next") {
      const cap = parseTokens(a ?? "");
      const spent = Number(b);
      if (!Number.isFinite(spent) || spent < 0) throw new Error(`run-budget.mjs next: spent must be a token count (got ${b})`);
      const r = nextSession(cap, spent);
      if (!r.ok) {
        console.error(spentMessage(String(a), spent, r.left, what || "next session"));
        process.exit(SPENT_EXIT);
      }
      console.log(String(r.left));
    } else {
      throw new Error("usage: run-budget.mjs spent < document | run-budget.mjs next <cap> <spent> <what>");
    }
  } catch (e) {
    console.error(/** @type {Error} */ (e).message);
    process.exit(1);
  }
}
