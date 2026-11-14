#!/usr/bin/env node
// Reduces the output of one headless run to the one result document scripts/orchestrate.sh prints and logs.
// Usage: node scripts/run-result.mjs <file with claude's stdout> [start time, epoch ms]
//
// Why: `claude -p` answers once per wake-up of the session. An orchestrator that launches agents stops, is woken by
// each agent's result and stops again, and every stop is a result of its own, with `num_turns` and `duration_ms` for
// that stretch only. `--output-format json` prints the last one alone, so a two-minute run with eleven turns was logged
// as one turn and eight seconds. orchestrate.sh therefore asks for the event stream (stream-json), and this script
// keeps the last result and adds `orch_totals` to it:
//   results  how many results the session produced (1 when it never waited for an agent)
//   turns    num_turns summed over them
//   wall_ms  the time from the start time given to the moment this script started; null without a start time
// Every other field is the last result's, as before: `result` is the final answer, and `modelUsage` and
// `total_cost_usd` already cover the whole session.
// Output that is not an event stream (an error text, or one JSON document without a `type`) is printed unchanged.
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const STARTED = Date.now();

/** @param {unknown} v @returns {v is number} */
const isCount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

/**
 * @param {AsyncIterable<string> | Iterable<string>} lines claude's stdout, line by line
 * @param {number | null} wallMs
 * @returns {Promise<string>} the text to print
 */
export async function reduce(lines, wallMs = null) {
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
  return JSON.stringify({ ...last, orch_totals: { results, turns, wall_ms: isCount(wallMs) ? Math.round(wallMs) : null } });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error("usage: run-result.mjs <file> [start epoch ms]");
    process.exit(2);
  }
  const start = Number(process.argv[3]);
  const wall = process.argv[3] && Number.isFinite(start) ? STARTED - start : null;
  const text = await reduce(createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity }), wall);
  process.stdout.write(text.endsWith("\n") || text === "" ? text : `${text}\n`);
}
