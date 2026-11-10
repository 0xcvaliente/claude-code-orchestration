#!/usr/bin/env node
// Subagent status line (1.2.0): the row Claude Code shows under the prompt for each running subagent, rewritten for
// this plugin's workers as `<role> <slice> #<attempt> · <model> · <tokens> (<context %>) · <progress>`.
// Not a hook: Claude Code runs the `subagentStatusLine` command once per refresh tick with one JSON object on stdin
// (`columns`, and `tasks`: id, agentType, status, label, description, model, tokenCount, contextWindowSize, ...) and
// replaces the row of each `{"id", "content"}` line written to stdout (docs: statusline, "Subagent status lines").
// A plugin may set exactly two settings keys, `agent` and `subagentStatusLine`, so scripts/build-plugin.mjs ships this
// as the plugin's settings.json; a `subagentStatusLine` in the user's or project's settings takes its place.
// Rows of other agents (built-ins, other plugins) are left as Claude Code draws them: no line is written for them.
// The slice, the attempt and the flags come from the launch records (journal-launches.jsonl, parsed fields only);
// a row whose launch is not logged yet shows the role without them. It never fails a row: any error prints nothing,
// which keeps the default rows. Reads the state dir only; writes nothing.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stateDirFor } from "./state.mjs";

const WORKERS = new Set(["researcher", "implementer", "reviewer", "integrator"]);

/** @param {unknown} t */
const bare = (t) => String(t ?? "").split(":").pop() ?? "";
/** "941", "12.3k", "128k", "1.2M". @param {number} n */
export function shortTokens(n) {
  if (!(n >= 0)) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
/** @param {unknown} model */
const family = (model) => String(model ?? "").toLowerCase().match(/fable|mythos|opus|sonnet|haiku/)?.[0] ?? "";

/**
 * The row body of one task, or null to keep Claude Code's own row.
 * @param {any} task one entry of the `tasks` array @param {any[]} launches this session's launch records, oldest first
 * @param {number} [columns] usable row width
 * @returns {string | null}
 */
export function rowFor(task, launches, columns = 0) {
  const role = bare(task?.agentType);
  if (!task || typeof task.id !== "string" || !WORKERS.has(role)) return null;
  const launch = launches.findLast((l) => l.agent_id === task.id);
  const head = [role];
  if (launch?.isPlanReview) head.push(launch.replan === null || launch.replan === undefined ? "plan" : "replan");
  else if (typeof launch?.slice === "string" && launch.slice) {
    head.push(launch.slice);
    if (role === "implementer") {
      // Fresh launches of the slice up to this one; a SendMessage resume makes no launch, so it keeps its number.
      const nth = launches.filter((l) => bare(l.agent_type) === "implementer" && l.slice === launch.slice && l.ts <= launch.ts).length;
      if (nth > 1) head.push(`#${nth}`);
    }
    if (launch.validate) head.push("validate");
  }
  if (launch?.risky) head.push("risky");
  const parts = [head.join(" ")];
  const fam = family(task.model);
  if (fam) parts.push(fam);
  if (typeof task.tokenCount === "number") {
    const pct = typeof task.contextWindowSize === "number" && task.contextWindowSize > 0 ? ` (${Math.round((100 * task.tokenCount) / task.contextWindowSize)}%)` : "";
    parts.push(`${shortTokens(task.tokenCount)}${pct}`);
  }
  if (typeof task.status === "string" && task.status && task.status !== "running") parts.push(task.status);
  const label = typeof task.label === "string" && task.label.trim() ? task.label.trim() : typeof task.description === "string" ? task.description.trim() : "";
  if (label) parts.push(label.replace(/\s+/g, " "));
  const row = parts.join(" · ");
  return columns > 8 && row.length > columns ? `${row.slice(0, columns - 1)}…` : row;
}

// Run as the status line command only when executed directly (the tests import rowFor).
if (process.argv[1]?.endsWith("subagent-statusline.mjs")) {
  try {
    /** @type {any} */
    const input = JSON.parse(readFileSync(0, "utf8"));
    const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
    if (tasks.some((/** @type {any} */ t) => WORKERS.has(bare(t?.agentType)))) {
      const project = process.env.CLAUDE_PROJECT_DIR || (typeof input.workspace?.project_dir === "string" && input.workspace.project_dir) || (typeof input.cwd === "string" && input.cwd) || process.cwd();
      const { dir } = stateDirFor(project, { plugin: process.argv.includes("--plugin") });
      /** @type {any[]} */
      let launches = [];
      try {
        launches = readFileSync(join(dir, "journal-launches.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean)
          .flatMap((l) => {
            try {
              const r = JSON.parse(l);
              return r && typeof r === "object" && (!input.session_id || r.session_id === input.session_id) ? [r] : [];
            } catch {
              return [];
            }
          });
      } catch {
        // no launch records yet: rows show the role, model and tokens only
      }
      const columns = typeof input.columns === "number" ? input.columns : 0;
      const out = [];
      for (const t of tasks) {
        const content = rowFor(t, launches, columns);
        if (content !== null) out.push(JSON.stringify({ id: t.id, content }));
      }
      if (out.length) process.stdout.write(`${out.join("\n")}\n`);
    }
  } catch {
    // malformed input: print nothing, so every row keeps its default
  }
  process.exit(0);
}
