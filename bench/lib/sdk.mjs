// The SDK arm of the benchmark: everything that differs from the `claude -p` arms lives here.
//   sdkCommand      how the SDK pipeline (src/cli.ts) is launched
//   sdkAuthOk       the preflight check (API key or `claude` login)
//   finalizeSdkRun  after the launch: bring the SDK's result into the run repo's working tree, then build the result
//                   document the analysis reads (tokens, errors) from the SDK's own run directory
// The SDK pipeline keeps its result on git branches and its numbers in <out>/<runId>/ (journal.json, telemetry.jsonl,
// report.json); the run repo's working tree stays at the init commit. See bench/README.md and H8 in HYPOTHESES.md.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const readJsonl = (file) => {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").flatMap((l) => {
    try {
      return l.trim() ? [JSON.parse(l)] : [];
    } catch {
      return []; // a torn last line from a killed run
    }
  });
};
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

// npx tsx src/cli.ts ..., cwd = repo root. outDir is where the SDK writes its run directory.
export function sdkCommand({ prompt, runRepo, root, outDir, testCmd, budgetTokens }) {
  const args = ["tsx", "src/cli.ts", "--repo", runRepo, "--task", prompt, "--mode", "orchestrate", "--no-escalate", "--out", outDir];
  if (testCmd) args.push("--test-cmd", testCmd);
  if (budgetTokens != null) args.push("--budget", String(budgetTokens));
  return { cmd: "npx", args, cwd: root };
}

// The SDK starts the Claude Code executable, which uses ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN) when set and
// otherwise the `claude` login. So: a credential variable counts as logged in (its value is never printed);
// without one, ask `claude auth status` (loggedIn is the function from run-exec).
export function sdkAuthOk({ env = process.env, loggedIn }) {
  if (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN) return true;
  return loggedIn();
}

// <outDir>/<runId>/: the newest subdirectory (run ids start with a timestamp) that holds a journal, telemetry or report.
export function sdkRunDir(outDir) {
  if (!existsSync(outDir)) return null;
  const dirs = readdirSync(outDir)
    .filter((n) => statSync(join(outDir, n)).isDirectory() && ["journal.json", "telemetry.jsonl", "report.json"].some((f) => existsSync(join(outDir, n, f))))
    .sort();
  return dirs.length ? { id: dirs.at(-1), dir: join(outDir, dirs.at(-1)) } : null;
}

const git = (repo, ...args) => spawnSync("git", ["-c", "user.email=bench@local", "-c", "user.name=bench", "-c", "core.quotepath=off", ...args], { cwd: repo, encoding: "utf8" });
const branchExists = (repo, b) => git(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${b}`).status === 0;

function mergeBranch(repo, branch, ffOnly) {
  const r = git(repo, "merge", "--no-edit", ...(ffOnly ? ["--ff-only"] : []), branch);
  if (r.status === 0) return true;
  git(repo, "merge", "--abort"); // harmless when no merge is in progress
  return false;
}

// Brings the SDK's output into repo's working tree. Returns {mode, run_id, merged, conflicted, missing}.
//   "result_branch": report.json names orch/<runId>/result and it exists: fast-forward to it (else a normal merge).
//   "salvage":       no usable result branch (the run was killed before step 7, or integration failed): merge the
//                    branch of every slice journal.json records as passed, in plan order; a conflicting or missing branch
//                    is skipped and listed.
//   "none":          no SDK run directory, or nothing passed.
export function adaptSdkResult(repo, outDir) {
  const found = sdkRunDir(outDir);
  const out = { mode: "none", run_id: found?.id ?? null, merged: [], conflicted: [], missing: [] };
  if (!found) return out;
  const report = readJson(join(found.dir, "report.json"));
  const branch = report?.resultBranch;
  if (typeof branch === "string" && branchExists(repo, branch)) {
    out.mode = "result_branch";
    if (mergeBranch(repo, branch, true) || mergeBranch(repo, branch, false)) out.merged.push(branch);
    else out.conflicted.push(branch);
    return out;
  }
  const journal = readJson(join(found.dir, "journal.json"));
  if (!journal) return out;
  const finished = new Map((journal.finished ?? []).map((r) => [r.id, r]));
  const planned = (journal.slices ?? []).map((s) => finished.get(s.id)).filter((r) => r?.status === "passed");
  if (!planned.length) return out;
  out.mode = "salvage";
  for (const r of planned) {
    if (!branchExists(repo, r.branch)) out.missing.push(r.branch);
    else if (mergeBranch(repo, r.branch, false)) out.merged.push(r.branch);
    else out.conflicted.push(r.branch);
  }
  return out;
}

// ---------- errors ----------

const AUTH = /Failed to authenticate|OAuth|not logged in|invalid api key|authentication|\b401\b/i;
const RATE = /usage limit|rate limit|\b429\b|overloaded|quota/i;

// "auth", "rate" or null, from what the run left behind: report.error, the text of failed slices and failed workers
// (telemetry lines with ok:false), and the tail of stderr. Rate limits win, as in classifyRow.
export function sdkErrorKind({ report, telemetry = [], stderr = "" }) {
  const texts = [
    report?.error,
    ...(report?.slices ?? []).filter((s) => s.status === "failed").flatMap((s) => (s.issues ?? []).map((i) => String(i).slice(0, 400))),
    ...telemetry.filter((t) => t.ok === false).map((t) => `${t.subtype ?? ""} ${t.preview ?? ""}`),
    String(stderr).slice(-2000),
  ].filter((t) => typeof t === "string" && t);
  if (texts.some((t) => RATE.test(t))) return "rate";
  if (texts.some((t) => AUTH.test(t))) return "auth";
  return null;
}

// ---------- the result document ----------

// A `claude -p` style result document for the SDK run, so tokens and classification need no special cases:
//   tokens   report.json spentTokens when present, else the sum of telemetry `tokens` (one line per worker as it
//            happens, so a killed run keeps the spend of workers that FINISHED; tokens of workers still running at the kill are lost, so a capped run's total is an undercount). Same basis as scripts/tokens.mjs: input+output+cacheRead+cacheWrite.
//            Per-model usage comes from the telemetry lines; any remainder is attributed to model "unattributed".
//   errors   is_error true when the run reports an error; an auth or rate-limit failure writes the words
//            classifyRow looks for into `result`.
// Returns null when the SDK left no run directory (nothing ran).
export function sdkResultDoc(outDir, { stderr = "", exitCode = null } = {}) {
  const found = sdkRunDir(outDir);
  if (!found) return null;
  const report = readJson(join(found.dir, "report.json"));
  const telemetry = readJsonl(join(found.dir, "telemetry.jsonl"));
  const modelUsage = {};
  let breakdown = 0;
  let turns = 0;
  for (const t of telemetry) {
    turns += num(t.turns);
    if (!t.usage) continue;
    const m = (modelUsage[t.model ?? "unknown"] ??= { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
    m.inputTokens += num(t.usage.input);
    m.outputTokens += num(t.usage.output);
    m.cacheReadInputTokens += num(t.usage.cacheRead);
    m.cacheCreationInputTokens += num(t.usage.cacheWrite);
    breakdown += num(t.usage.input) + num(t.usage.output) + num(t.usage.cacheRead) + num(t.usage.cacheWrite);
  }
  const total = typeof report?.spentTokens === "number" && Number.isFinite(report.spentTokens) ? report.spentTokens : telemetry.reduce((s, t) => s + num(t.tokens), 0);
  if (breakdown > total) for (const m of Object.keys(modelUsage)) delete modelUsage[m]; // inconsistent: use the plain total
  else if (total > breakdown) modelUsage.unattributed = { inputTokens: total - breakdown, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
  const kind = sdkErrorKind({ report, telemetry, stderr });
  const failed = (report?.slices ?? []).filter((s) => s.status === "failed").length;
  const message = kind === "rate" ? "rate limit: the SDK run hit a usage or rate limit" : kind === "auth" ? "Failed to authenticate: the SDK run could not log in" : report?.error ?? null;
  return {
    type: "result",
    subtype: report ? (report.error ? "error" : "success") : "killed_or_incomplete",
    is_error: Boolean(kind || report?.error),
    result: message ?? (report ? `SDK run ${report.runId}: ${(report.slices ?? []).length} slice(s), ${failed} failed` : `SDK run ${found.id} left no report.json (exit ${exitCode})`),
    num_turns: turns,
    modelUsage,
    sdk: { run_id: found.id, spent_tokens: total, tokens_by_role: report?.tokensByRole ?? null, workers: telemetry.length, has_report: Boolean(report) },
  };
}

// The one call run-exec makes after the launch: adapt, build the document, write sdk-adapter.json next to the run.
// Returns {results: [doc] | [], sdk: summary}.
export function finalizeSdkRun({ runRepo, outDir, runOutDir, stderrFile, exitCode }) {
  const sdk = adaptSdkResult(runRepo, outDir);
  const stderr = stderrFile && existsSync(stderrFile) ? readFileSync(stderrFile, "utf8") : "";
  const doc = sdkResultDoc(outDir, { stderr, exitCode });
  writeFileSync(join(runOutDir, "sdk-adapter.json"), `${JSON.stringify(sdk, null, 2)}\n`);
  return { results: doc ? [doc] : [], sdk };
}
