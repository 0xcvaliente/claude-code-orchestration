#!/usr/bin/env node
// Soak test of the gates (2.0.1; docs/data/probes-2.0.1-soak.md): a seeded, model-free run of random worker life cycles
// through the REAL hook scripts in .claude/hooks, checking nine invariants after every step.
//
//   npm run soak -- [--minutes N] [--seed S] [--sequences K] [--concurrency C] [--replay FILE] [--save FILE] [--hooks DIR] [--plant]
//
// --minutes  the time box, default 10, a positive number of at most 60 (a larger or unreadable value exits 2 and runs
//            nothing). New sequences start until the deadline; a sequence still running then is cut at its next step
//            (not checked), and every hook still running 5 s later is killed.
// --sequences  run sequences 0 to K-1 of the seed at most (default: as many as the time box allows).
// --seed     the run's seed (default: the clock). Sequence k is generated from (seed, k) alone, so the same seed replays it.
// --replay   run the one sequence in FILE (the JSON printed after `REPLAY` with a violation, or that whole line).
// --save     write each violating sequence, one JSON per line, to FILE.
// --hooks    the hooks folder to drive (default: this checkout's .claude/hooks); a copy of older hooks shows a finding
//            against the unfixed code.
// --plant    add a step that runs a hook which crashes (exit 1): a planted I5 violation, to test the report itself. It is
//            the sequence's first step (2.1.0), so no time box cuts the sequence before it.
//
// One summary line at the end: seed, sequences run, hook calls, violations. Exit 0 with no violation, 1 with one, 2 on a
// usage error. Every violation prints its invariant, seed, sequence and step, and a `REPLAY <json>` line. No model call,
// no network: each sequence works in its own temp project (state dir, transcripts, a fake test command), all removed at
// the end. It never reads or writes this project's .claude/state.
//
// What a sequence drives (payload shapes as Claude Code 2.1.326 sends them, taken from the tests and the probe pages):
// a PLAN REVIEW, then 2 to 4 workers (implementer, reviewer, researcher, integrator; bare or plugin-prefixed types; at
// times no agent id) whose steps are interleaved at random with global steps: the orchestrator's Stop (background_tasks
// listing running agents in any order), malformed and empty payloads, a log line truncated or garbage, and faults on a
// state log (its full read, its tail read or its writes fail, or the log is a folder). A worker launches (plan-check,
// telemetry, journal), finishes by a text stop, a hand-back (handback-check, quote-check, verify.sh --handback; refused
// reports are fixed or sent again, at most three tries) or a text stop that Claude Code turns into a forced hand-back and
// a continued stop (which other workers' steps may come between); it may be woken after delivery (a late background
// shell, a typed prompt) and resumed with SendMessage (a new hand-back, a STATUS line in its last message or only in its
// transcript, or none). Implementer tests pass or fail through a flag file; a blocked stop is fixed and stopped again.
// Some sequences launch all their implementers in one step (2.1.0: a wave sent in one message), their plan checks side
// by side, under a wave cap of WAVE_CAP (ORCH_WAVE_MAX in every hook call).
//
// Invariants (each a named function below; a violation names it):
//   I1 caps: no agent is denied or blocked more often than its gate's cap (hand-back check 1, quote check 1, test gate 2
//      since the agent's latest start, plan check 2 per reason and slice, reviewer hold 2 per slice, agent and block,
//      review gate 2 per reason since the last implementer stop, implementer_unfinished 2 per agent); and the wave cap
//      (2.1.0): the implementers of a wave that pass together, plus those running before it, stay within WAVE_CAP unless
//      a record of the wave says it gave up, went unrecorded, judged without its lock or could not read its logs.
//   I2 every sequence can end: once nothing runs, the orchestrator's Stop is let through within a bounded number of
//      tries, and a Stop that lists a running subagent is never blocked.
//   I3 one delivered review is counted once by foldRuns, with its delivered status and an attempt no later than itself,
//      and a woken worker's extra stop adds no attempt and drops no current review.
//   I4 no delivered report is lost: each review episode (a launch or a resume that reports) is one review in the fold.
//   I5 a hook exits 0 or 2, never crashes, and exits 0 on malformed input.
//   I6 no hook call takes longer than its registered timeout, and a node hook's CPU time stays under CPU_BOUND_MS.
//   I7 every implementer stop the test gate handles leaves a test-gate record, and a first stop since a start pairs.
//   I8 no record in the state dir holds brief or report text.
//   I9 only plan-check.mjs ever prints an allow decision.
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const MAX_MINUTES = 60;
/** Registered hook timeouts in seconds (.claude/settings.json; Claude Code's default for the rest). */
const TIMEOUT_S = /** @type {Record<string, number>} */ ({ "plan-check.mjs": 60, "verify.sh": 900 });
const DEFAULT_TIMEOUT_S = 60;
/** CPU time a node hook decision may take (user + system, in ms; generous: in-process work only). */
export const CPU_BOUND_MS = 5000;
/** Tries of the orchestrator's Stop at the end of a sequence before I2 calls it stuck. */
const STOP_TRIES = 16;
/** The wave cap every hook call runs with (ORCH_WAVE_MAX): low, so a sequence's few implementers meet it. */
export const WAVE_CAP = 2;
/** The run-stale window the hooks use by default (ORCH_RUN_STALE_MIN unset), in ms: an older start does not count. */
const STALE_MS = 30 * 60_000;

// ---------------------------------------------------------------- arguments

/** @param {string[]} argv @returns {{ minutes: number, seed: number, concurrency: number, sequences: number, replay: string | null, save: string | null, hooks: string, plant: boolean, quiet: boolean } | { error: string }} */
export function parseArgs(argv) {
  /** @type {any} */
  const o = { minutes: 10, seed: Date.now() % 2147483647, concurrency: Math.max(1, Math.min(4, Math.floor(cpus().length / 2))), sequences: Infinity, replay: null, save: null, hooks: join(ROOT, ".claude", "hooks"), plant: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = /** @type {string} */ (argv[i]);
    const [flag, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    const value = () => (inline !== undefined ? inline : argv[++i]);
    if (flag === "--minutes") {
      const v = value();
      const n = Number(v);
      if (v === undefined || !/^\s*\d*\.?\d+\s*$/.test(v) || !Number.isFinite(n) || n <= 0) return { error: `--minutes must be a positive number, got ${JSON.stringify(v ?? "")}` };
      if (n > MAX_MINUTES) return { error: `--minutes ${v} is over the ${MAX_MINUTES}-minute limit of a soak run; nothing was run` };
      o.minutes = n;
    } else if (flag === "--seed") {
      const v = value();
      if (v === undefined || !/^\d+$/.test(v)) return { error: `--seed must be a whole number, got ${JSON.stringify(v ?? "")}` };
      o.seed = Number(v) % 2147483647;
    } else if (flag === "--concurrency") {
      const v = Number(value());
      if (!Number.isInteger(v) || v < 1 || v > 16) return { error: "--concurrency must be 1 to 16" };
      o.concurrency = v;
    } else if (flag === "--sequences") {
      const v = value();
      if (v === undefined || !/^\d+$/.test(v) || Number(v) < 1) return { error: `--sequences must be a whole number of at least 1, got ${JSON.stringify(v ?? "")}` };
      o.sequences = Number(v);
    } else if (flag === "--replay") o.replay = value() ?? null;
    else if (flag === "--save") o.save = value() ?? null;
    else if (flag === "--hooks") o.hooks = resolve(String(value() ?? ""));
    else if (flag === "--plant") o.plant = true;
    else if (flag === "--quiet") o.quiet = true;
    else return { error: `unknown argument ${a}` };
  }
  if (o.replay === "" || o.save === "") return { error: "--replay and --save need a file" };
  return o;
}

// ---------------------------------------------------------------- random

/** mulberry32 @param {number} a */
function prng(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** The seed of sequence k of a run. @param {number} seed @param {number} k */
const seqSeed = (seed, k) => (Math.imul(seed ^ 0x9e3779b9, 2654435761) + Math.imul(k + 1, 40503)) >>> 0;

// ---------------------------------------------------------------- generation

const ROLES = ["implementer", "reviewer", "researcher", "integrator"];
const LOGS = ["gates.jsonl", "journal.jsonl", "journal-launches.jsonl", "telemetry.jsonl", "handbacks.jsonl", "handback-refusals.jsonl", "quotes.jsonl", "review-hold.jsonl", "plan-check.jsonl"];

/**
 * One sequence: its agents and its ops, in the order they run. Pure function of (seed, k).
 * @param {number} seed @param {number} k @param {{ plant?: boolean }} [opts]
 */
export function generate(seed, k, opts = {}) {
  const r = prng(seqSeed(seed, k));
  const pick = (/** @type {any[]} */ xs) => xs[Math.floor(r() * xs.length)];
  const chance = (/** @type {number} */ p) => r() < p;
  const headless = chance(0.3);
  const n = 2 + Math.floor(r() * 3);
  /** @type {any[]} */
  const agents = [];
  /** @type {any[][]} */
  const lists = [];
  const slices = ["x", "y"];
  for (let i = 0; i < n; i++) {
    const role = i === 0 ? "implementer" : i === 1 ? pick(["reviewer", "reviewer", "implementer", "researcher", "integrator"]) : pick(ROLES);
    const slice = role === "implementer" || role === "reviewer" ? (chance(0.8) ? "x" : "y") : null;
    const a = { i, role, prefixed: chance(0.25), noId: chance(0.05), slice, model: role === "reviewer" ? pick(["sonnet", "opus"]) : null, checks: role === "reviewer" && chance(0.6) };
    agents.push(a);
    /** @type {any[]} */
    const ops = [{ op: "launch", a: i, badSlice: role === "implementer" && chance(0.08) }];
    /** A finish of a launch or a resume. @param {boolean} resume */
    const finish = (resume) => {
      const mode = pick(["handback", "handback", "text", "forced"]);
      const report = role === "reviewer" ? pick(["ok", "ok", "fail", "lowfail", "nostatus", ...(a.checks ? ["unanswered"] : [])]) : role === "researcher" ? pick(["goodquote", "badquote", "nostatus"]) : pick(["ok", "ok", "nostatus"]);
      const tests = role === "implementer" ? pick(["pass", "pass", "failfix", "failstuck"]) : null;
      const where = resume && role === "reviewer" && mode === "text" ? pick(["last", "transcript", "none"]) : "last";
      if (mode === "forced") {
        ops.push({ op: "textstop", a: i, report, tests, where, preamble: chance(0.5) });
        ops.push({ op: "forced", a: i, report, refix: chance(0.7) });
      } else ops.push({ op: "finish", a: i, mode, report, tests, where, refix: chance(0.7) });
    };
    finish(false);
    if (chance(0.35)) ops.push({ op: "wake", a: i, by: pick(["shell", "prompt"]), start: chance(0.5) });
    if (chance(0.4)) {
      ops.push({ op: "resume", a: i });
      finish(true);
      if (chance(0.25)) ops.push({ op: "wake", a: i, by: pick(["shell", "prompt"]), start: chance(0.5) });
    }
    lists.push(ops);
  }
  // Interleave the agents' ops (each agent's own order kept); a reviewer of a slice mostly comes after an implementer.
  /** @type {any[]} */
  const ops = [];
  const pos = lists.map(() => 0);
  for (;;) {
    const live = lists.map((l, i) => i).filter((i) => (pos[i] ?? 0) < (lists[i]?.length ?? 0));
    if (!live.length) break;
    const i = /** @type {number} */ (pick(live));
    ops.push(lists[i]?.[pos[i] ?? 0]);
    pos[i] = (pos[i] ?? 0) + 1;
    if (chance(0.12)) ops.push({ op: "stopgate" });
    if (chance(0.06)) ops.push({ op: "malformed", hook: pick(["handback-check.mjs", "quote-check.mjs", "journal.mjs", "telemetry.mjs", "review-gate.mjs", "plan-check.mjs", "verify.sh", "verify.sh --handback"]), kind: pick(["empty", "garbage", "array", "null", "partial", "string"]) });
    if (chance(0.04)) ops.push({ op: "corrupt", file: pick(LOGS), kind: pick(["truncated", "garbage"]) });
    if (chance(0.05)) ops.push({ op: "fault", file: pick(LOGS), kind: pick(["full", "tail", "full+tail", "write", "dir"]) });
    if (chance(0.06)) ops.push({ op: "unfault" });
  }
  // The planted step comes first (2.1.0): a sequence cut by its time box has always run it. The draw is kept, so the
  // steps after it are the same as before.
  if (opts.plant) {
    r();
    ops.unshift({ op: "planted" });
  }
  if (chance(0.5)) ops.push({ op: "unfault" });
  // A wave (2.1.0): the implementers of the sequence launched in one step, before any other step of theirs.
  const impl = agents.filter((a) => a.role === "implementer").map((a) => a.i);
  if (impl.length >= 2 && chance(0.5)) {
    const rest = ops.filter((o) => !(o.op === "launch" && impl.includes(o.a)));
    rest.splice(opts.plant ? 1 : 0, 0, { op: "wave", as: impl });
    return { v: 1, seed, k, headless, agents, ops: rest };
  }
  return { v: 1, seed, k, headless, agents, ops };
}

// ---------------------------------------------------------------- texts

const STATE = (/** @type {string} */ dir) => join(dir, ".claude", "state");
/** @param {any} ctx @param {any} a @param {string} kind */
function reportText(ctx, a, kind) {
  const secret = `${ctx.secret} report ${a.i}`;
  const answers = a.checks ? "C1: pass (cmd) npm test -> ok\n" : "";
  switch (kind) {
    case "ok":
      return `STATUS: pass\n${answers}${secret}\nOPEN: none`;
    case "fail":
      return `STATUS: fail\nGAP: 90 x.txt:1 the change breaks the parser\n${secret}\nOPEN: none`;
    case "lowfail":
      return `STATUS: fail\nGAP: 40 x.txt:2 a nit in the wording\n${secret}\nOPEN: none`;
    case "unanswered":
      return `STATUS: pass\n${secret}\nOPEN: none`;
    case "goodquote":
      return `STATUS: pass\nQUOTE: src.txt:1 | the quick brown fox\n${secret}\nOPEN: none`;
    case "badquote":
      return `STATUS: pass\nQUOTE: src.txt:1 | words that are nowhere in the source\n${secret}\nOPEN: none`;
    default:
      return `All done here, see above.\n${secret}`;
  }
}
/** The report a worker sends after a refusal: corrected, or the same again. @param {string} kind @param {boolean} fix */
const fixed = (kind, fix) => (!fix ? kind : kind === "badquote" ? "goodquote" : kind === "nostatus" || kind === "unanswered" ? "ok" : kind);

// ---------------------------------------------------------------- hooks

let PRELOAD_DIR = "";
/** Writes the CPU-time and fault preloads into the run's temp root. @param {string} dir */
function writePreloads(dir) {
  PRELOAD_DIR = dir;
  writeFileSync(
    join(dir, "cpu.mjs"),
    'import { writeFileSync } from "node:fs";\nconst f = process.env.SOAK_CPU_FILE;\nconst w = writeFileSync;\nif (f) process.on("exit", () => { try { const u = process.cpuUsage(); w(f, String((u.user + u.system) / 1000)); } catch {} });\n',
  );
  writeFileSync(
    join(dir, "fault.mjs"),
    [
      'import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module";',
      'let f = null; try { f = JSON.parse(process.env.SOAK_FAULT || "null"); } catch {}',
      "if (f && f.file) {",
      '  const hit = (p) => (typeof p === "string" || p instanceof URL) && String(p).endsWith("/" + f.file);',
      '  const err = () => Object.assign(new Error("EACCES: soak fault"), { code: "EACCES" });',
      "  if (f.full) { const o = fs.readFileSync; fs.readFileSync = (p, ...a) => { if (hit(p)) throw err(); return o(p, ...a); }; }",
      '  if (f.tail) { const o = fs.openSync; fs.openSync = (p, fl, ...a) => { if (hit(p) && (fl === undefined || fl === "r" || fl === 0)) throw err(); return o(p, fl, ...a); }; }',
      '  if (f.write) for (const k of ["appendFileSync", "writeFileSync"]) { const o = fs[k]; fs[k] = (p, ...a) => { if (hit(p)) throw err(); return o(p, ...a); }; }',
      "  syncBuiltinESMExports();",
      "}",
    ].join("\n"),
  );
}

/** Environment of every hook call: no switch of the person's, small time budgets, no skill scan. */
function baseEnv() {
  /** @type {Record<string, string>} */
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !/^(ORCH_|CLAUDE_PLUGIN_|CLAUDE_ASYNC_AGENT_STALL|GIT_|NODE_OPTIONS$|NODE_TEST)/.test(k)) env[k] = v;
  return { ...env, ORCH_SKILL_HINTS: "off", ORCH_HOOK_BUDGET_S: "40", ORCH_TEST_TIMEOUT_S: "10", ORCH_WAVE_MAX: String(WAVE_CAP), CLAUDE_PLUGIN_ROOT: "" };
}
const BASE_ENV = baseEnv();

class Aborted extends Error {}

/**
 * One hook call, as Claude Code makes it. Checks I5, I6 and I9 on the spot.
 * @param {any} ctx @param {string} name script file name @param {unknown} payload @param {{ args?: string[], raw?: string, malformed?: boolean }} [o]
 */
async function hook(ctx, name, payload, o = {}) {
  if (ctx.stopped()) throw new Aborted();
  const input = o.raw !== undefined ? o.raw : JSON.stringify(payload);
  const sh = name.endsWith(".sh");
  const cpuFile = join(ctx.tmp, `cpu-${++ctx.callNo}`);
  const fault = ctx.fault && ctx.fault.kind !== "dir" ? { file: ctx.fault.file, full: ctx.fault.kind.includes("full"), tail: ctx.fault.kind.includes("tail"), write: ctx.fault.kind === "write" } : null;
  const env = { ...BASE_ENV, CLAUDE_PROJECT_DIR: ctx.dir, TMPDIR: ctx.tmp, ORCH_TEST_CMD: ctx.testCmd, SOAK_CPU_FILE: cpuFile, ...(fault ? { NODE_OPTIONS: `--import ${pathToFileURL(join(PRELOAD_DIR, "fault.mjs")).href}`, SOAK_FAULT: JSON.stringify(fault) } : {}) };
  const file = name === "planted.mjs" ? join(PRELOAD_DIR, "planted.mjs") : join(ctx.hooks, name);
  const cmd = sh ? "bash" : process.execPath;
  const argv = sh ? [file, ...(o.args ?? [])] : ["--import", pathToFileURL(join(PRELOAD_DIR, "cpu.mjs")).href, file, ...(o.args ?? [])];
  const limitS = TIMEOUT_S[name] ?? DEFAULT_TIMEOUT_S;
  const t0 = performance.now();
  const res = await new Promise((done) => {
    const child = spawn(cmd, argv, { cwd: ctx.dir, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
    ctx.children.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-(child.pid ?? 0), "SIGKILL");
      } catch {}
    }, limitS * 1000);
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    child.stdin.on("error", () => {});
    child.on("error", () => {});
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      ctx.children.delete(child);
      done({ code, signal, stdout, stderr, timedOut });
    });
    child.stdin.end(input);
  });
  const wall = performance.now() - t0;
  ctx.hookCalls++;
  if (ctx.killed) throw new Aborted();
  let cpu = null;
  try {
    cpu = Number(readFileSync(cpuFile, "utf8"));
    rmSync(cpuFile, { force: true });
  } catch {}
  const call = { name: `${name}${o.args?.length ? ` ${o.args.join(" ")}` : ""}`, code: res.code, signal: res.signal, wall: Math.round(wall), cpu, stdout: res.stdout, stderr: res.stderr, timedOut: res.timedOut, malformed: !!o.malformed };
  I5_exitCodes(ctx, call);
  I6_time(ctx, call, limitS);
  I9_onlyPlanCheckAllows(ctx, call);
  return call;
}

// ---------------------------------------------------------------- invariants

/** @param {any} ctx @param {string} inv @param {string} detail */
function violate(ctx, inv, detail) {
  if (ctx.violations.some((/** @type {any} */ v) => v.inv === inv && v.detail === detail)) return;
  ctx.violations.push({ inv, step: ctx.step, detail });
}

/** I5: exit 0 or 2, no crash; malformed input exits 0. @param {any} ctx @param {any} c */
function I5_exitCodes(ctx, c) {
  if (c.timedOut) return;
  if (c.code !== 0 && c.code !== 2) violate(ctx, "I5_exitCodes", `${c.name} exited ${c.code ?? c.signal}: ${String(c.stderr).trim().split("\n").slice(-3).join(" | ").slice(0, 300)}`);
  else if (c.malformed && c.code !== 0) violate(ctx, "I5_exitCodes", `${c.name} exited ${c.code} on malformed input`);
}
/** I6: within the registered timeout; a node hook's CPU time under the bound. @param {any} ctx @param {any} c @param {number} limitS */
function I6_time(ctx, c, limitS) {
  if (c.timedOut || c.wall > limitS * 1000) violate(ctx, "I6_time", `${c.name} ran ${c.wall} ms, over its ${limitS} s timeout`);
  if (typeof c.cpu === "number" && Number.isFinite(c.cpu) && c.cpu > CPU_BOUND_MS) violate(ctx, "I6_time", `${c.name} used ${Math.round(c.cpu)} ms of CPU, over ${CPU_BOUND_MS} ms`);
}
/** I9: only plan-check.mjs prints an allow decision. @param {any} ctx @param {any} c */
function I9_onlyPlanCheckAllows(ctx, c) {
  if (c.name.startsWith("plan-check.mjs")) return;
  if (/"(?:permissionDecision|decision)"\s*:\s*"(?:allow|approve)"/.test(c.stdout)) violate(ctx, "I9_onlyPlanCheckAllows", `${c.name} printed an allow decision`);
}
/** I1: count one refusal under its cap's key. @param {any} ctx @param {string} gate @param {string} key @param {number} cap */
function I1_caps(ctx, gate, key, cap) {
  const k = `${gate}|${key}`;
  const n = (ctx.caps.get(k) ?? 0) + 1;
  ctx.caps.set(k, n);
  if (n > cap) violate(ctx, "I1_caps", `${gate} refused ${n} times (cap ${cap}) for ${key}`);
}
/**
 * gates.jsonl replaced by a folder: no reader (node or grep) can read the test gate's count, and the gate keeps blocking
 * failing tests (not fixed, docs/data/probes-2.0.1-soak.md). The only exemption from I1, and only for the test gate.
 * @param {any} ctx
 */
const doubleFault = (ctx) => ctx.fault?.file === "gates.jsonl" && ctx.fault?.kind === "dir";
/** Reset caps whose window ends (an agent's start resets the test gate's; an implementer stop the review gate's). @param {any} ctx @param {string} prefix */
const resetCaps = (ctx, prefix) => {
  for (const k of [...ctx.caps.keys()]) if (k.startsWith(prefix)) ctx.caps.delete(k);
};
/** I8: no brief or report text in any state file. @param {any} ctx */
function I8_noText(ctx) {
  const walk = (/** @type {string} */ d) => {
    let names = [];
    try {
      names = readdirSync(d);
    } catch {
      return;
    }
    for (const n of names) {
      const p = join(d, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (st.size < 8 * 1024 * 1024) {
        try {
          if (readFileSync(p, "utf8").includes(ctx.secret)) violate(ctx, "I8_noText", `${p.slice(ctx.dir.length + 1)} holds brief or report text`);
        } catch {}
      }
    }
  };
  walk(STATE(ctx.dir));
}

// ---------------------------------------------------------------- the runner

/** Parsed lines of a state log ([] when missing or unreadable). @param {any} ctx @param {string} name @returns {any[]} */
function log(ctx, name) {
  try {
    return readFileSync(join(STATE(ctx.dir), name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter((e) => e && typeof e === "object");
  } catch {
    return [];
  }
}

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs one sequence in a fresh temp project; returns its violations.
 * @param {any} seq @param {{ root: string, hooks: string, deadline: number, killed: () => boolean, children: Set<any> }} run
 */
export async function runSequence(seq, run) {
  const dir = mkdtempSync(join(run.root, `seq-${seq.k}-`));
  const tmp = join(dir, "tmp");
  mkdirSync(tmp);
  mkdirSync(STATE(dir), { recursive: true });
  mkdirSync(join(dir, "transcripts"));
  writeFileSync(join(dir, "src.txt"), "the quick brown fox\njumps over the lazy dog\n");
  writeFileSync(join(dir, "x.txt"), "x\n");
  writeFileSync(join(dir, "t.sh"), `test -f '${join(dir, ".pass")}' && exit 0\necho 'not ok 1 - soak failing test'\nexit 1\n`);
  writeFileSync(join(dir, ".pass"), "");
  const brief = await import(pathToFileURL(join(run.hooks, "brief.mjs")).href);
  const runMod = await import(pathToFileURL(join(run.hooks, "run.mjs")).href);
  const ctx = {
    seq, dir, tmp, hooks: run.hooks, sid: `soak-${seq.k}`, secret: `SOAK-SECRET-${seq.seed}-${seq.k}`, testCmd: `sh '${join(dir, "t.sh")}'`,
    callNo: 0, hookCalls: 0, step: -1, endCheck: /** @type {Promise<void> | null} */ (null), violations: /** @type {any[]} */ ([]), caps: new Map(), fault: /** @type {any} */ (null), faultDir: false,
    children: run.children, get killed() { return run.killed(); }, stopped: () => run.killed(), toolNo: 0,
  };
  /** @type {any[]} */
  const st = seq.agents.map((/** @type {any} */ a) => ({
    ...a,
    id: a.noId ? null : `ag${seq.k}x${a.i}`,
    type: `${a.prefixed ? "orchestration:" : ""}${a.role}`,
    transcript: join(dir, "transcripts", `${a.i}.jsonl`),
    launched: false, refused: false, running: false, tainted: false, unknowable: false,
    episodes: /** @type {any[]} */ ([]),
  }));
  const tPath = (/** @type {any} */ a) => (seq.headless ? join(dir, "transcripts", "missing.jsonl") : a.transcript);
  /** Appends transcript records (interactive sessions only). @param {any} a @param {any[]} recs */
  const transcript = (a, recs) => {
    if (seq.headless) return;
    appendFileSync(a.transcript, recs.map((r) => `${JSON.stringify({ timestamp: new Date().toISOString(), ...r })}\n`).join(""));
  };
  const assistantText = (/** @type {string} */ text) => ({ type: "assistant", message: { role: "assistant", id: `m${++ctx.toolNo}`, content: [{ type: "text", text }], stop_reason: "end_turn" } });
  const common = () => ({ session_id: ctx.sid, transcript_path: join(dir, "main.jsonl"), cwd: dir, permission_mode: "auto" });
  const ids = (/** @type {any} */ a) => ({ ...(a.id ? { agent_id: a.id } : {}), agent_type: a.type });
  const taintIfFault = (/** @type {any} */ a) => {
    if (ctx.fault) a.tainted = true;
  };
  /** Running subagents as Claude Code lists them in background_tasks, in random order, plus a shell. @param {any} self */
  const background = (self) => {
    const r = prng((ctx.callNo * 7919 + seq.k) >>> 0);
    /** @type {any[]} */
    const list = st.filter((a) => a.running || a === self).map((a) => ({ id: a.id ?? `t${a.i}`, type: "subagent", status: "running", description: `soak ${a.role}`, agent_type: a.type }));
    if (r() < 0.5) list.push({ id: "sh1", type: "shell", status: "running", description: "suite", command: "npm test" });
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  };

  // ---- the steps of a worker
  /** @param {any} a @param {string} prompt */
  const launch = async (a, prompt) => {
    const tool_input = { subagent_type: a.type, description: `soak ${a.role}`, prompt, run_in_background: true, ...(a.model ? { model: a.model } : {}) };
    const tries = a.role === "reviewer" || a.badSlice ? 4 : 1;
    for (let t = 0; t < tries; t++) {
      const pc = await hook(ctx, "plan-check.mjs", { ...common(), hook_event_name: "PreToolUse", tool_name: "Agent", tool_input, tool_use_id: `toolu_L${++ctx.toolNo}` });
      if (pc.code === 2) {
        taintIfFault(a);
        const hold = log(ctx, "review-hold.jsonl").filter((e) => e.session_id === ctx.sid).at(-1);
        const plan = log(ctx, "plan-check.jsonl").filter((e) => e.session_id === ctx.sid).at(-1);
        if (/tests failed after the worker/.test(pc.stderr)) I1_caps(ctx, "reviewer hold", `${a.slice}|${hold?.agent_id ?? "?"}|${hold?.block_at ?? "?"}`, 2);
        else I1_caps(ctx, "plan check", `${plan?.reason ?? "unlogged"}|${a.slice ?? plan?.slice ?? "?"}`, 2);
        continue;
      }
      a.launched = true;
      a.running = true;
      transcript(a, [{ type: "user", message: { role: "user", content: prompt } }]);
      await hook(ctx, "telemetry.mjs", { ...common(), hook_event_name: "SubagentStart", ...ids(a) });
      await hook(ctx, "journal.mjs", { ...common(), hook_event_name: "PostToolUse", tool_name: "Agent", tool_input, tool_response: { status: "async_launched", ...(a.id ? { agentId: a.id } : {}) }, tool_use_id: `toolu_L${ctx.toolNo}` });
      resetCaps(ctx, `test gate|${a.id}`);
      taintIfFault(a);
      return true;
    }
    a.refused = true;
    return false;
  };
  /** The implementers running now, read as the plan check reads them (run.mjs implementerTestStates), fresh starts only. */
  const runningImplementers = () => {
    const now = Date.now();
    const states = runMod.implementerTestStates(log(ctx, "telemetry.jsonl").filter((e) => e.session_id === ctx.sid), [], ctx.sid);
    return [...states.values()].filter((/** @type {any} */ s) => s.start > s.stop && now - s.start <= STALE_MS).length;
  };
  /**
   * A wave: the implementers' plan checks side by side, then each allowed one starts. I1: the plan check's caps per
   * reason and slice, and the wave cap. @param {any[]} members @param {(a: any) => string} briefOf
   */
  const launchWave = async (members, briefOf) => {
    const before = log(ctx, "plan-check.jsonl").length;
    const runningBefore = runningImplementers();
    const faulted = !!ctx.fault;
    setTests("pass");
    const inputs = members.map((a) => ({ subagent_type: a.type, description: `soak ${a.role}`, prompt: briefOf(a), run_in_background: true }));
    const useIds = members.map(() => `toolu_L${++ctx.toolNo}`);
    const res = await Promise.all(members.map((a, n) => hook(ctx, "plan-check.mjs", { ...common(), hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: inputs[n], tool_use_id: useIds[n] })));
    const recs = log(ctx, "plan-check.jsonl").slice(before).filter((e) => e.session_id === ctx.sid);
    for (const [n, a] of members.entries()) {
      const pc = res[n];
      const input = inputs[n];
      if (!pc || !input) continue;
      if (pc.code === 2) {
        taintIfFault(a);
        const reason = /\bwave_full\b/.test(pc.stderr) ? "wave_full" : (recs.filter((e) => e.decision === "block" && e.slice === a.slice).at(-1)?.reason ?? "unlogged");
        I1_caps(ctx, "plan check", `${reason}|${a.slice}`, 2);
        a.refused = true;
        continue;
      }
      a.launched = true;
      a.running = true;
      transcript(a, [{ type: "user", message: { role: "user", content: input.prompt } }]);
      await hook(ctx, "telemetry.mjs", { ...common(), hook_event_name: "SubagentStart", ...ids(a) });
      await hook(ctx, "journal.mjs", { ...common(), hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: input, tool_response: { status: "async_launched", ...(a.id ? { agentId: a.id } : {}) }, tool_use_id: useIds[n] });
      resetCaps(ctx, `test gate|${a.id}`);
      taintIfFault(a);
    }
    // The wave cap: a wave never passes it together, unless a record of the wave excuses it.
    const excused = recs.some(
      (e) =>
        e.reason === "wave_full_gave_up" ||
        (Array.isArray(e.gave_up) && e.gave_up.includes("wave_full_gave_up")) ||
        /_unrecorded$/.test(String(e.reason ?? "")) ||
        e.wave?.lock === "not_taken" ||
        e.wave?.skipped === "log_unreadable" ||
        e.wave?.skipped === "wave_error",
    );
    const passed = res.filter((c) => c.code === 0).length;
    if (!faulted && !ctx.fault && !excused && runningBefore + passed > WAVE_CAP) {
      violate(ctx, "I1_caps", `wave: ${passed} of ${members.length} launched at once passed with ${runningBefore} running, over the cap of ${WAVE_CAP}`);
    }
  };
  /** A SubagentStart of a resumed or woken agent. @param {any} a */
  const start = async (a) => {
    a.running = true;
    await hook(ctx, "telemetry.mjs", { ...common(), hook_event_name: "SubagentStart", ...ids(a) });
    resetCaps(ctx, `test gate|${a.id}`);
    if (a.role === "implementer") resetCaps(ctx, "review gate|");
    taintIfFault(a);
  };
  /** The hooks of one SubagentHandback call, side by side; true when the report was delivered. @param {any} a @param {string} message */
  const handback = async (a, message) => {
    const id = `toolu_H${++ctx.toolNo}`;
    transcript(a, [{ type: "assistant", message: { role: "assistant", id: `m${ctx.toolNo}`, content: [{ type: "tool_use", id, name: "SubagentHandback", input: { message } }], stop_reason: "tool_use" } }]);
    const p = { ...common(), hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_input: { message }, tool_use_id: id, ...ids(a) };
    const [hc, qc, vs] = await Promise.all([hook(ctx, "handback-check.mjs", p), hook(ctx, "quote-check.mjs", p), hook(ctx, "verify.sh", p, { args: ["--handback"] })]);
    taintIfFault(a);
    if (hc.code === 2) I1_caps(ctx, "handback check", String(a.id), 1);
    if (qc.code === 2) I1_caps(ctx, "quote check", String(a.id), 1);
    if (vs.code === 2 && !doubleFault(ctx)) I1_caps(ctx, "test gate", String(a.id ?? `noid${a.i}`), 2);
    const ok = hc.code !== 2 && qc.code !== 2 && vs.code !== 2;
    transcript(a, [{ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: ok ? "Report delivered to your caller." : "refused", ...(ok ? {} : { is_error: true }) }] }, ...(ok ? { toolEndsTurn: true } : {}) }]);
    return ok;
  };
  /** The hooks of one SubagentStop, side by side; true when a stop hook blocked. @param {any} a @param {{ last?: string, active: boolean }} o */
  const stop = async (a, o) => {
    const p = { ...common(), hook_event_name: "SubagentStop", stop_hook_active: o.active, ...ids(a), agent_transcript_path: tPath(a), ...(o.last !== undefined ? { last_assistant_message: o.last } : {}), background_tasks: background(a), session_crons: [] };
    const before = a.role === "implementer" && a.id ? log(ctx, "gates.jsonl").filter((g) => g.gate === "test" && g.agent_id === a.id && g.at !== "handback").length : 0;
    const telemetryBefore = log(ctx, "telemetry.jsonl").filter((e) => e.agent_id === a.id);
    const calls = [hook(ctx, "telemetry.mjs", p), hook(ctx, "journal.mjs", p)];
    const gated = a.type === "implementer";
    if (gated) calls.push(hook(ctx, "verify.sh", p));
    if (a.role === "researcher") calls.push(hook(ctx, "quote-check.mjs", p));
    const res = await Promise.all(calls);
    a.running = false;
    taintIfFault(a);
    const v = gated ? res[2] : null;
    const q = a.role === "researcher" ? res[res.length - 1] : null;
    if (v?.code === 2 && !doubleFault(ctx)) I1_caps(ctx, "test gate", String(a.id ?? `noid${a.i}`), 2);
    if (q?.code === 2) I1_caps(ctx, "quote check", String(a.id), 1);
    if (a.role === "implementer") resetCaps(ctx, "review gate|");
    if (gated && a.id && !v?.timedOut) I7_stopRecord(ctx, a, before, telemetryBefore);
    return res.some((c) => c.code === 2);
  };
  /** I7: the stop left a test-gate record; a first stop since the agent's latest start pairs with it. @param {any} ctx @param {any} a @param {number} before @param {any[]} telemetryBefore */
  function I7_stopRecord(ctx, a, before, telemetryBefore) {
    if (a.tainted || ctx.fault) return;
    const gates = log(ctx, "gates.jsonl");
    const mine = gates.filter((g) => g.gate === "test" && g.agent_id === a.id && g.at !== "handback");
    if (mine.length <= before) {
      violate(ctx, "I7_stopRecord", `implementer ${a.id}: its stop left no test-gate record`);
      return;
    }
    const lastStart = telemetryBefore.filter((e) => e.hook_event_name === "SubagentStart").at(-1);
    const stopsSince = telemetryBefore.filter((e) => e.hook_event_name === "SubagentStop" && lastStart && Date.parse(e.ts) >= Date.parse(lastStart.ts));
    if (!lastStart || stopsSince.length) return;
    const states = runMod.implementerTestStates(log(ctx, "telemetry.jsonl").filter((e) => e.session_id === ctx.sid), gates, ctx.sid);
    if (!states.get(a.id)?.stopGate) violate(ctx, "I7_stopRecord", `implementer ${a.id}: stopGateOf pairs no record with its first stop since its start`);
  }
  /** Set the implementer's tests. @param {string | null} tests */
  const setTests = (tests) => {
    if (tests === null) return;
    if (tests === "pass") writeFileSync(join(dir, ".pass"), "");
    else rmSync(join(dir, ".pass"), { force: true });
  };
  /** After a blocked stop the worker fixes what it can and stops again (stop_hook_active), up to 4 more times. @param {any} a @param {any} op @param {string} kind */
  const continueAfterBlock = async (a, op, kind) => {
    for (let n = 0; n < 4; n++) {
      if (op.tests === "failfix" || (op.tests !== "failstuck" && a.role === "implementer")) setTests("pass");
      kind = fixed(kind, op.refix ?? true);
      const text = reportText(ctx, a, kind);
      a.running = true;
      transcript(a, [assistantText(text)]);
      if (!(await stop(a, { last: text, active: true }))) return kind;
    }
    return kind;
  };
  /** One hand-back with its retries; the delivered report kind or null. @param {any} a @param {any} op @param {string} kind */
  const deliver = async (a, op, kind) => {
    for (let n = 0; n < 3; n++) {
      if (await handback(a, reportText(ctx, a, kind))) return kind;
      if (a.role === "implementer" && op.tests === "failfix") setTests("pass");
      kind = fixed(kind, op.refix);
    }
    return null;
  };
  /** Records what the fold must show for this review episode. @param {any} a @param {string | null} kind */
  const episode = (a, kind) => {
    if (a.role !== "reviewer") return;
    a.episodes.push({ status: kind === null ? null : brief.parseStatus(reportText(ctx, a, kind)) });
  };

  // ---- ops
  /** An implementer's brief. @param {any} a @param {string} slice */
  const implementerBrief = (a, slice) => `SLICE: ${slice}\nFILES: ${slice}.txt\nDEPENDS: none\n${ctx.secret} brief ${a.i}`;
  /** @param {any} op */
  const apply = async (op) => {
    const a = op.a !== undefined ? st[op.a] : null;
    if (a && op.op !== "launch" && (!a.launched || a.refused)) return;
    switch (op.op) {
      case "launch": {
        const slice = a.badSlice ? "zz" : a.slice;
        const prompt =
          a.role === "implementer" ? implementerBrief(a, slice) : a.role === "reviewer" ? `SLICE: ${a.slice}\n${a.checks ? "CHECKS: C1\nC1: the tests pass\n" : ""}Review the diff.\n${ctx.secret} brief ${a.i}` : `Look into the parser.\n${ctx.secret} brief ${a.i}`;
        if (a.role === "implementer") setTests("pass");
        await launch(a, prompt);
        return;
      }
      case "wave": {
        const members = (Array.isArray(op.as) ? op.as : []).map((/** @type {number} */ i) => st[i]).filter((/** @type {any} */ m) => m && !m.launched && !m.refused);
        if (members.length) await launchWave(members, (m) => implementerBrief(m, m.slice));
        return;
      }
      case "finish": {
        setTests(op.tests === "pass" ? "pass" : op.tests ? "fail" : null);
        if (op.mode === "handback") {
          const got = await deliver(a, op, op.report);
          if (await stop(a, { active: false })) await continueAfterBlock(a, op, got ?? op.report);
          episode(a, got);
          return;
        }
        // A text stop (a session without the hand-back tool, or a resumed worker).
        let text = reportText(ctx, a, op.report);
        if (op.where === "transcript") {
          transcript(a, [assistantText(text)]);
          text = `Done; the report is above. ${ctx.secret} tail ${a.i}`;
          if (seq.headless) a.unknowable = true;
        } else if (op.where === "none") {
          text = reportText(ctx, a, "nostatus");
          if (seq.headless) a.unknowable = true;
        }
        transcript(a, [assistantText(text)]);
        const blocked = await stop(a, { last: text, active: false });
        const kind = blocked ? await continueAfterBlock(a, op, op.report) : op.report;
        episode(a, op.where === "none" ? "nostatus" : kind);
        return;
      }
      case "textstop": {
        // Auto mode: a text turn Claude Code holds back ([handback-send-enforce]); the hand-back follows (op forced).
        setTests(op.tests === "pass" ? "pass" : op.tests ? "fail" : null);
        const text = op.preamble ? `Let me sum up. ${ctx.secret} pre ${a.i}` : reportText(ctx, a, op.report);
        transcript(a, [assistantText(text)]);
        await stop(a, { last: text, active: false });
        a.running = true; // the turn goes on
        a.pendingTests = op.tests;
        return;
      }
      case "forced": {
        transcript(a, [{ type: "user", isMeta: true, message: { role: "user", content: "[handback-send-enforce] Your report has not been delivered. Call SubagentHandback({message})" } }]);
        const got = await deliver(a, { ...op, tests: a.pendingTests }, op.report);
        if (await stop(a, { active: true })) await continueAfterBlock(a, { ...op, tests: a.pendingTests }, got ?? op.report);
        episode(a, got);
        return;
      }
      case "wake": {
        if (a.running) return;
        if (op.start) await start(a);
        const pre = a.role === "implementer" ? sliceState(a.slice) : null;
        a.running = true;
        transcript(a, [
          op.by === "shell"
            ? { type: "user", message: { role: "user", content: "<task-notification><status>completed</status><summary>Background command finished</summary></task-notification>" } }
            : { type: "user", origin: { kind: "human" }, message: { role: "user", content: "continue" } },
          assistantText(`That background search only finished now, after my report was delivered. ${ctx.secret} wake ${a.i}`),
        ]);
        const blocked = await stop(a, { last: `That background search only finished now, after my report was delivered. ${ctx.secret} wake ${a.i}`, active: false });
        if (blocked) {
          await continueAfterBlock(a, { tests: "failfix", refix: true }, "ok");
          return;
        }
        const post = a.role === "implementer" ? sliceState(a.slice) : null;
        // Headless, whether a woken implementer worked is unknown, so its stop counts (docs/data/probes-2.0.1-soak.md, limits).
        if (pre && post && !a.tainted && !ctx.fault && !seq.headless) I3_wakeAddsNothing(ctx, a, pre, post);
        return;
      }
      case "resume": {
        if (a.running) return;
        await start(a);
        transcript(a, [{ type: "user", isMeta: true, origin: { kind: "coordinator" }, message: { role: "user", content: "Please check the retry and report again." } }]);
        return;
      }
      case "stopgate": {
        const bg = background(null);
        const g = await hook(ctx, "review-gate.mjs", { ...common(), hook_event_name: "Stop", stop_hook_active: false, background_tasks: bg, last_assistant_message: "Waiting." });
        const active = bg.some((t) => t.type === "subagent" && t.status === "running");
        if (active && g.code === 2) violate(ctx, "I2_canEnd", "the Stop was blocked while a subagent was listed running");
        if (g.code === 2) reviewGateCap();
        return;
      }
      case "malformed": {
        const [name, ...args] = op.hook.split(" ");
        const raw = { empty: "", garbage: "{not json", array: "[1,2]", null: "null", string: '"x"', partial: JSON.stringify({ hook_event_name: op.hook.includes("verify") ? "SubagentStop" : "PreToolUse", session_id: ctx.sid }) }[/** @type {string} */ (op.kind)];
        const c = await hook(ctx, name, null, { raw, args, malformed: op.kind !== "partial" });
        void c; // a partial payload (a JSON object without the event's fields) may be judged: exit 0 or 2 (I5_exitCodes)
        return;
      }
      case "corrupt": {
        const f = join(STATE(dir), op.file);
        try {
          if (statSync(f).isFile()) appendFileSync(f, op.kind === "truncated" ? '{"ts":"2026-11-18T00:00:0\n' : "\u0000garbage line\n");
        } catch {}
        return;
      }
      case "fault": {
        await unfault();
        ctx.fault = { file: op.file, kind: op.kind };
        if (op.kind === "dir") {
          const f = join(STATE(dir), op.file);
          try {
            if (existsSync(f)) renameSync(f, `${f}.soak-bak`);
            mkdirSync(f);
            ctx.faultDir = true;
          } catch {}
        }
        return;
      }
      case "unfault":
        await unfault();
        return;
      case "planted":
        await hook(ctx, "planted.mjs", {});
        return;
      default:
    }
  };
  const unfault = async () => {
    if (ctx.fault?.kind === "dir" && ctx.faultDir) {
      const f = join(STATE(dir), ctx.fault.file);
      try {
        rmSync(f, { recursive: true, force: true });
        if (existsSync(`${f}.soak-bak`)) renameSync(`${f}.soak-bak`, f);
      } catch {}
    }
    ctx.fault = null;
    ctx.faultDir = false;
  };
  /** I1 for the review gate: per reason since the last implementer stop; implementer_unfinished per agent. */
  const reviewGateCap = () => {
    const rec = log(ctx, "gates.jsonl").filter((g) => g.gate === "review" && g.session_id === ctx.sid).at(-1);
    if (!rec || rec.decision !== "block") {
      I1_caps(ctx, "review gate", "unlogged block", 2);
      return;
    }
    if (rec.reason === "implementer_unfinished" && Array.isArray(rec.unfinished)) for (const id of rec.unfinished) I1_caps(ctx, "unfinished", id, 2);
    else I1_caps(ctx, "review gate", String(rec.reason), 2);
  };
  /** The fold's state of a slice in the latest run that holds it. @param {string} slice */
  const sliceState = (slice) => {
    try {
      const { runs } = runMod.sessionRuns(ctx.sid, { dir: STATE(dir), env: BASE_ENV });
      const s = runs.findLast((/** @type {any} */ r) => Object.hasOwn(r.slices, slice))?.slices[slice];
      return s ? { attempts: s.attempts, current: brief.currentReviews(s).length, reviews: s.reviews.length } : null;
    } catch {
      return null;
    }
  };

  // ---- the plan review, then the ops
  try {
    const plan = { i: "P", role: "reviewer", type: "reviewer", id: `ag${seq.k}xP`, running: false };
    const planBrief = `PLAN REVIEW\nCONSTRAINTS:\nC1: the tests pass\nSLICE: x\nFILES: x.txt\nDEPENDS: none\nGOAL: fix x\nSLICE: y\nFILES: y.txt\nDEPENDS: none\nGOAL: fix y\n${ctx.secret} plan`;
    ctx.step = -1;
    const pi = { subagent_type: "reviewer", description: "plan review", prompt: planBrief, run_in_background: true };
    await hook(ctx, "plan-check.mjs", { ...common(), hook_event_name: "PreToolUse", tool_name: "Agent", tool_input: pi, tool_use_id: "toolu_P" });
    await hook(ctx, "telemetry.mjs", { ...common(), hook_event_name: "SubagentStart", agent_id: plan.id, agent_type: "reviewer" });
    await hook(ctx, "journal.mjs", { ...common(), hook_event_name: "PostToolUse", tool_name: "Agent", tool_input: pi, tool_response: { status: "async_launched", agentId: plan.id }, tool_use_id: "toolu_P" });
    await hook(ctx, "handback-check.mjs", { ...common(), hook_event_name: "PreToolUse", tool_name: "SubagentHandback", tool_input: { message: `STATUS: pass\n${ctx.secret}\nOPEN: none` }, tool_use_id: "toolu_PH", agent_id: plan.id, agent_type: "reviewer" });
    await hook(ctx, "telemetry.mjs", { ...common(), hook_event_name: "SubagentStop", stop_hook_active: false, agent_id: plan.id, agent_type: "reviewer", agent_transcript_path: join(dir, "missing.jsonl"), background_tasks: [] });
    await hook(ctx, "journal.mjs", { ...common(), hook_event_name: "SubagentStop", stop_hook_active: false, agent_id: plan.id, agent_type: "reviewer", agent_transcript_path: join(dir, "missing.jsonl"), background_tasks: [] });
    for (let i = 0; i < seq.ops.length; i++) {
      if (run.killed() || Date.now() > run.deadline) return { ctx, complete: false };
      ctx.step = i;
      await apply(seq.ops[i]);
      I8_noText(ctx);
      await sleep(2);
    }
    // The end: every agent is done; nothing runs.
    ctx.step = seq.ops.length;
    for (const a of st) a.running = false;
    I2_canEnd(ctx, () => hook(ctx, "review-gate.mjs", { ...common(), hook_event_name: "Stop", stop_hook_active: false, background_tasks: [], last_assistant_message: "Done." }), reviewGateCap);
    await ctx.endCheck;
    await unfault();
    I3_I4_reviews(ctx, st, runMod, brief);
    I8_noText(ctx);
    return { ctx, complete: true };
  } catch (e) {
    if (e instanceof Aborted) return { ctx, complete: false };
    violate(ctx, "runner", `the soak itself failed: ${/** @type {Error} */ (e).stack?.split("\n").slice(0, 3).join(" | ")}`);
    return { ctx, complete: true };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** I2: once nothing runs, the Stop goes through within STOP_TRIES tries. @param {any} ctx @param {() => Promise<any>} stopCall @param {() => void} cap */
function I2_canEnd(ctx, stopCall, cap) {
  ctx.endCheck = (async () => {
    for (let n = 1; n <= STOP_TRIES; n++) {
      const g = await stopCall();
      if (g.code !== 2) return;
      cap();
    }
    violate(ctx, "I2_canEnd", `the orchestrator's Stop was still blocked after ${STOP_TRIES} tries with nothing running`);
  })();
}

/** I3 (a wake): a woken implementer's extra stop adds no attempt and drops no current review. @param {any} ctx @param {any} a @param {any} pre @param {any} post */
function I3_wakeAddsNothing(ctx, a, pre, post) {
  if (post.attempts > pre.attempts || post.current < pre.current) violate(ctx, "I3_countedOnce", `implementer ${a.id} woken after delivery: slice ${a.slice} attempts ${pre.attempts}->${post.attempts}, current reviews ${pre.current}->${post.current}`);
}

/** I3 and I4: per reviewer, one review in the fold per episode, with its delivered status. @param {any} ctx @param {any[]} st @param {any} runMod @param {any} brief */
function I3_I4_reviews(ctx, st, runMod, brief) {
  let runs;
  try {
    ({ runs } = runMod.sessionRuns(ctx.sid, { dir: STATE(ctx.dir), env: BASE_ENV }));
  } catch (e) {
    violate(ctx, "I3_countedOnce", `the fold threw: ${String(e)}`);
    return;
  }
  for (const a of st) {
    if (a.role !== "reviewer" || !a.id || a.tainted || !a.launched || a.refused) continue;
    const reviews = runs.flatMap((/** @type {any} */ r) => Object.values(r.slices).flatMap((/** @type {any} */ s) => s.reviews.map((/** @type {any} */ v) => ({ ...v, slice: s.slice })))).filter((/** @type {any} */ v) => v.agent === a.id);
    const want = a.episodes.length;
    if (reviews.length > want) violate(ctx, "I3_countedOnce", `reviewer ${a.id}: ${want} review(s) delivered, the fold counts ${reviews.length}`);
    else if (reviews.length < want && !a.unknowable) violate(ctx, "I4_noneLost", `reviewer ${a.id}: ${want} review(s) delivered, the fold counts ${reviews.length}`);
    else if (reviews.length === want && !a.unknowable) {
      a.episodes.forEach((/** @type {any} */ e, /** @type {number} */ i) => {
        const v = reviews[i];
        if (v && v.status !== e.status) violate(ctx, "I4_noneLost", `reviewer ${a.id}: review ${i + 1} delivered ${e.status}, the fold has ${v.status}`);
      });
    }
    for (const v of reviews) if (v.implAt !== null && v.implAt > v.ts) violate(ctx, "I3_countedOnce", `reviewer ${a.id}: a review is counted for an attempt after it`);
  }
  void brief;
}

// ---------------------------------------------------------------- main

/** @param {string[]} argv @returns {Promise<number>} the exit code */
export async function main(argv) {
  const o = parseArgs(argv);
  if ("error" in o) {
    process.stderr.write(`soak-gates: ${o.error}\nusage: npm run soak -- [--minutes N (0 < N <= ${MAX_MINUTES}, default 10)] [--seed S] [--sequences K] [--concurrency C] [--replay FILE] [--save FILE] [--hooks DIR] [--plant]\n`);
    return 2;
  }
  const t0 = Date.now();
  const deadline = t0 + o.minutes * 60_000;
  const root = mkdtempSync(join(tmpdir(), "orch-soak-"));
  writePreloads(root);
  writeFileSync(join(root, "planted.mjs"), "process.exit(1);\n");
  /** @type {Set<any>} */
  const children = new Set();
  let killed = false;
  const hard = setTimeout(() => {
    killed = true;
    for (const c of children) {
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {}
    }
  }, Math.max(0, deadline - Date.now()) + 5_000);
  const onSignal = () => {
    killed = true;
    for (const c of children) {
      try {
        process.kill(-c.pid, "SIGKILL");
      } catch {}
    }
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  const runCtx = { root, hooks: o.hooks, deadline, killed: () => killed, children };
  let sequences = 0;
  let calls = 0;
  /** @type {any[]} */
  const found = [];
  /** @param {any} seq @param {any} res */
  const report = (seq, res) => {
    calls += res.ctx.hookCalls;
    if (!res.complete) return;
    sequences++;
    if (!res.ctx.violations.length) return;
    found.push({ seq, violations: res.ctx.violations });
    for (const v of res.ctx.violations) process.stdout.write(`VIOLATION ${v.inv} seed=${seq.seed} sequence=${seq.k} step=${v.step}: ${v.detail}\n`);
    process.stdout.write(`REPLAY ${JSON.stringify(seq)}\n`);
    if (o.save) appendFileSync(o.save, `${JSON.stringify(seq)}\n`);
  };
  try {
    if (o.replay) {
      const text = readFileSync(o.replay, "utf8").trim().split("\n").find((l) => l.trim()) ?? "";
      const seq = JSON.parse(text.replace(/^REPLAY\s+/, ""));
      report(seq, await runSequence(seq, runCtx));
    } else {
      let next = 0;
      const worker = async () => {
        while (!killed && Date.now() < deadline && next < o.sequences) {
          const seq = generate(o.seed, next++, { plant: o.plant });
          report(seq, await runSequence(seq, runCtx));
        }
      };
      await Promise.all(Array.from({ length: o.concurrency }, worker));
    }
  } finally {
    clearTimeout(hard);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    rmSync(root, { recursive: true, force: true });
  }
  const violations = found.reduce((n, f) => n + f.violations.length, 0);
  process.stdout.write(`soak: seed=${o.seed} minutes=${o.minutes} sequences=${sequences} hook_calls=${calls} violations=${violations} elapsed_s=${Math.round((Date.now() - t0) / 1000)}\n`);
  return violations ? 1 : 0;
}

/** Run directly (not imported by the test): real paths compared, as every entry guard here does. */
const direct = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (direct) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      process.stderr.write(`soak-gates: ${e?.stack ?? e}\n`);
      process.exit(2);
    },
  );
}
