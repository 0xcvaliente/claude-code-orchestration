// Pure helpers for bench/run.mjs: matrix expansion, blocks, seeded shuffle, prompt footer, settings merge,
// result parsing, rate-limit detection and resume filtering. No file system or process access here.

const pad = (n, w = 2) => String(n).padStart(w, "0");

// Local wall-clock time as HH:MM:SS.
export const hms = (d = new Date()) => `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

// Local YYYYMMDDTHHMM, for default campaign names.
export const stamp = (d = new Date()) =>
  `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}`;

export const runIdOf = (task, arm, cell, rep) => `${task}__${arm}__${cell}__r${rep}`;
export const blockKeyOf = (task, cell, rep) => `${task}__${cell}__r${rep}`;

// Every run of the matrix, in matrix order, duplicates (same run_id from two groups) dropped.
// metaOf(taskId) returns the task's meta.json; a cell's cap_min overrides meta.cap_min.
export function expandMatrix(matrix, metaOf) {
  if (!matrix || !Array.isArray(matrix.groups)) throw new Error("matrix needs a groups array");
  const runs = [];
  const seen = new Set();
  for (const [gi, g] of matrix.groups.entries()) {
    for (const key of ["tasks", "arms", "cells"]) {
      if (!Array.isArray(g[key]) || !g[key].length) throw new Error(`matrix group ${gi + 1}: ${key} must be a non-empty array`);
    }
    const reps = Number.isInteger(g.reps) && g.reps > 0 ? g.reps : 1;
    for (const task of g.tasks) {
      const meta = metaOf(task);
      for (const cell of g.cells) {
        if (!cell?.id) throw new Error(`matrix group ${gi + 1}: every cell needs an id`);
        const cap_min = cell.cap_min ?? meta.cap_min;
        if (!(typeof cap_min === "number" && cap_min > 0)) throw new Error(`${task}/${cell.id}: no positive cap_min`);
        for (let rep = 1; rep <= reps; rep++) {
          for (const arm of g.arms) {
            const run_id = runIdOf(task, arm, cell.id, rep);
            if (seen.has(run_id)) continue;
            seen.add(run_id);
            runs.push({ run_id, task, arm, cell: cell.id, rep, cap_min, budget_tokens: cell.budget_tokens ?? null, block: blockKeyOf(task, cell.id, rep) });
          }
        }
      }
    }
  }
  return runs;
}

// Runs grouped by (task, cell, rep), blocks in first-seen order: [{key, runs}].
export function groupBlocks(runs) {
  const map = new Map();
  for (const r of runs) {
    if (!map.has(r.block)) map.set(r.block, { key: r.block, runs: [] });
    map.get(r.block).runs.push(r);
  }
  return [...map.values()];
}

// mulberry32: a small deterministic PRNG, returns floats in [0, 1).
export function prng(seed) {
  let a = (Number(seed) >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Fisher-Yates with the seeded PRNG; returns a new array.
export function shuffle(items, seed) {
  const out = [...items];
  const rnd = prng(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function footer(capMin, start, deadline) {
  return (
    `HARD TIME LIMIT: ${capMin} minutes of wall-clock time. Started at ${hms(start)} local time; at ${hms(deadline)} this process is killed without warning, and whatever is then in this directory's working tree is graded. Work in other git worktrees or branches that has not been merged into this working tree by then does not count. Check the time with \`date\` and keep the working tree gradable at all times.\n` +
    "No human is available: do not ask questions; make reasonable decisions."
  );
}

export const buildPrompt = (taskMd, capMin, start, deadline) => `${String(taskMd).trim()}\n\n${footer(capMin, start, deadline)}`;

// The run repo's settings: the copied settings (if any), plus extra keys, plus every user-enabled plugin disabled.
export function mergeSettings(existing, disabledIds, extra = {}) {
  const base = existing && typeof existing === "object" ? existing : {};
  const enabledPlugins = { ...(base.enabledPlugins ?? {}) };
  for (const id of disabledIds) enabledPlugins[id] = false;
  return { ...base, ...extra, enabledPlugins };
}

// Ids of plugins with "enabled": true in `claude plugin list --json` output. Throws on unparseable output.
export function enabledPluginIds(text) {
  const list = JSON.parse(text);
  if (!Array.isArray(list)) throw new Error("claude plugin list --json did not print an array");
  return list.filter((p) => p && p.enabled === true && typeof p.id === "string").map((p) => p.id);
}

// End index (exclusive) of the JSON object starting at text[start] === "{", string-aware; -1 if unbalanced.
function objectEnd(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

const isResultDoc = (o) => o && typeof o === "object" && !Array.isArray(o) && (o.type === "result" || "is_error" in o || "modelUsage" in o || "result" in o);

// Every result document printed on stdout, in order. A candidate starts at a "{" that is the first non-blank
// character of a line; documents may span lines; non-JSON lines and non-result objects are skipped.
export function parseResults(stdout) {
  const text = String(stdout ?? "");
  const docs = [];
  let i = 0;
  while (i < text.length) {
    const lineStart = i === 0 || text[i - 1] === "\n";
    if (lineStart) {
      let j = i;
      while (j < text.length && (text[j] === " " || text[j] === "\t" || text[j] === "\r")) j++;
      if (text[j] === "{") {
        const end = objectEnd(text, j);
        if (end !== -1) {
          try {
            const o = JSON.parse(text.slice(j, end));
            if (isResultDoc(o)) {
              docs.push(o);
              i = end;
              continue;
            }
          } catch {
            // not JSON: fall through to the next line
          }
        }
      }
    }
    const nl = text.indexOf("\n", i);
    if (nl === -1) break;
    i = nl + 1;
  }
  return docs;
}

const RATE_LIMIT = /usage limit|rate limit|429|overloaded|quota/i;
export const isRateLimited = (results) =>
  (results ?? []).some((r) => r?.is_error === true && RATE_LIMIT.test(typeof r.result === "string" ? r.result : JSON.stringify(r.result ?? "")));

const AUTH_ERROR = /Failed to authenticate|OAuth|not logged in|invalid api key|authentication/i;
export const isAuthError = (results) =>
  (results ?? []).some((r) => r?.is_error === true && AUTH_ERROR.test(typeof r.result === "string" ? r.result : JSON.stringify(r.result ?? "")));

export const AUTH_PAUSE_REASON = "claude CLI not logged in; run `claude auth login`";

// `claude auth status` stdout -> true only for JSON with loggedIn === true.
export function parseAuthStatus(text) {
  try {
    return JSON.parse(String(text ?? "")).loggedIn === true;
  } catch {
    return false;
  }
}

// run_ids that a resume skips: rows that ended "exited" or "deadline".
export function finishedRunIds(rowsText) {
  const done = new Set();
  for (const line of String(rowsText ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.end_reason === "exited" || row.end_reason === "deadline") done.add(row.run_id);
    } catch {
      // a torn last line from a killed runner: ignore
    }
  }
  return done;
}

export const filterResume = (runs, done) => runs.filter((r) => !done.has(r.run_id));

// snapshots/t0060: elapsed seconds, 4-digit zero padded.
export const snapName = (secs) => `t${pad(secs, 4)}`;

// .claude/ paths and blank lines removed, sorted unique.
export const diffFiles = (lists) =>
  [...new Set(lists.flatMap((t) => String(t).split("\n")).map((l) => l.trim()).filter((l) => l && !l.startsWith(".claude/")))].sort();

// The campaign seed. Resume: the manifest's seed (save=true when an older manifest lacks one, then the matrix seed is
// used and must be written back); an explicit --seed on resume is an error. New campaign: --seed, else matrix seed, else 1.
export function resolveSeed({ resumeManifest, cliSeed, matrixSeed }) {
  const num = (v, what) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`${what} must be a number (got ${v})`);
    return n;
  };
  if (resumeManifest) {
    if (cliSeed != null) throw new Error("--seed cannot be used with --resume: a resumed campaign keeps the seed in its manifest.json");
    if (resumeManifest.seed != null) return { seed: num(resumeManifest.seed, "manifest seed"), save: false };
    return { seed: num(matrixSeed ?? 1, "matrix seed"), save: true };
  }
  return { seed: num(cliSeed ?? matrixSeed ?? 1, "--seed"), save: false };
}
