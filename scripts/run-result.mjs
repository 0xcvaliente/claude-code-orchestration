#!/usr/bin/env node
// Reduces the output of one headless run to the one result document scripts/orchestrate.sh prints and logs.
// Usage: node scripts/run-result.mjs <file with claude's stdout> [start time, epoch ms] [claude's exit code]
//
// Why: `claude -p` answers once per wake-up of the session. An orchestrator that launches agents stops, is woken by
// each agent's result and stops again, and every stop is a result of its own, with `num_turns` and `duration_ms` for
// that stretch only. `--output-format json` prints the last one alone, so a two-minute run with eleven turns was logged
// as one turn and eight seconds. orchestrate.sh therefore asks for the event stream (stream-json), and this script
// keeps the last result and adds `orch_totals` to it:
//   results  how many results the session produced (1 when it never waited for an agent)
//   turns    num_turns summed over them
//   wall_ms  the time from the start time given to the moment this script started; null without a start time
// With claude's exit code given (orchestrate.sh always gives it), two more:
//   exit_code  claude's exit code
//   complete   true only when that code is 0. A run cut short (claude killed or failing after an interim wake-up)
//              still ends with a result record, but that record is an interim answer, not the final one.
// Every other field is the last result's, as before: `result` is the final answer, and `modelUsage` and
// `total_cost_usd` already cover the whole session.
// Output that is not an event stream (an error text, or one JSON document without a `type`) is printed unchanged.
import { createReadStream, realpathSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const STARTED = Date.now();

/** @param {unknown} v @returns {v is number} */
const isCount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * @param {AsyncIterable<string> | Iterable<string>} lines claude's stdout, line by line
 * @param {number | null} wallMs
 * @param {number | null} exitCode claude's exit code; null when not known (then orch_totals has no exit_code or complete)
 * @returns {Promise<string>} the text to print
 */
export async function reduce(lines, wallMs = null, exitCode = null) {
  /** @type {Record<string, unknown> | null} */
  let last = null;
  let results = 0;
  let turns = 0;
  /** @type {string[]} */
  const other = [];
  for await (const line of lines) {
    /** @type {unknown} */
    let rec = null;
    try {
      rec = JSON.parse(line);
    } catch {
      // not a stream record
    }
    const isRecord = typeof rec === "object" && rec !== null && !Array.isArray(rec) && typeof /** @type {any} */ (rec).type === "string";
    if (!isRecord) {
      other.push(line);
      continue;
    }
    const r = /** @type {Record<string, unknown>} */ (rec);
    if (r.type !== "result") continue;
    last = r;
    results++;
    if (isCount(r.num_turns)) turns += r.num_turns;
  }
  if (!last) return other.join("\n");
  /** @type {Record<string, unknown>} */
  const totals = { results, turns, wall_ms: isCount(wallMs) ? Math.round(wallMs) : null };
  if (Number.isInteger(exitCode)) Object.assign(totals, { exit_code: exitCode, complete: exitCode === 0 });
  return JSON.stringify({ ...last, orch_totals: totals });
}

// Entry script? Real paths on both sides: Node resolves symlinks in the main module's import.meta.url, not in argv[1].
const isEntry = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};
if (isEntry()) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: run-result.mjs <file> [start epoch ms] [exit code]");
    process.exit(2);
  }
  const start = Number(process.argv[3]);
  const wall = process.argv[3] && Number.isFinite(start) ? STARTED - start : null;
  const codeArg = process.argv[4];
  const code = codeArg !== undefined && /^\d+$/.test(codeArg) ? Number(codeArg) : null;
  const text = await reduce(createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity }), wall, code);
  process.stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
}
