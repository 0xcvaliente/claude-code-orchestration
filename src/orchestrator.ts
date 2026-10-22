import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { RunAgent } from "./agent.js";
import { count } from "./args.js";
import { LIMITS } from "./config.js";
import { deleteBranch, headRef, mergeInto, removeWorktree } from "./git.js";
import { newRunId, Run } from "./state.js";
import { runSlice, type Slice, type SliceContext, type SliceResult } from "./slice.js";

export type { Slice, SliceResult };

export interface Report {
  runId: string;
  base: string;
  slices: SliceResult[];
  resultBranch?: string;
  merged: string[];
  conflicted: string[];
  /** How many times the planner was asked to plan the missing work after failures. */
  replans: number;
  resumed: boolean;
  spentTokens: number;
  tokensByRole: Record<string, number>;
  /** Set when the run could not do its job (planning or integration failed); the CLI exits non-zero. */
  error?: string;
}
export interface OrchestrateOptions {
  repo: string;
  task: string;
  outRoot: string;
  run: RunAgent;
  testCmd?: string;
  /** Runs once in each new slice worktree before the writer starts, e.g. `npm ci` (worktrees have no node_modules). */
  setupCmd?: string;
  /** Keep every slice worktree after the run. By default passing slices and the result worktree are removed; branches always stay. */
  keepWorktrees?: boolean;
  planOnly?: boolean;
  /** Continue a crashed or failed run: its id, the same `outRoot`. Skips planning and finished slices; failed slices start over. */
  resume?: string;
  /** After a pass that leaves failed slices, ask the planner for the missing work this many times (0 to 3, default 0). */
  maxReplans?: number;
  /**
   * Optional cap on total tokens (input + output + cache read + cache write, over every model), summed over every worker.
   * Unset: no cap; turns, timeouts and retries still bound the run.
   */
  runBudgetTokens?: number;
  concurrency?: number;
  maxRetries?: number;
  log?: (line: string) => void;
}

const strings = (max: number) => ({ type: "array", items: { type: "string" }, maxItems: max });
const QUESTIONS_SCHEMA = {
  type: "object",
  properties: { questions: strings(LIMITS.maxQuestions) },
  required: ["questions"],
  additionalProperties: false,
};
const SLICES_SCHEMA = {
  type: "object",
  properties: {
    slices: {
      type: "array",
      maxItems: LIMITS.maxSlices,
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          goal: { type: "string" },
          files: strings(50),
          acceptance: { type: "string" },
          dependsOn: strings(LIMITS.maxSlices),
        },
        required: ["id", "goal", "files", "acceptance", "dependsOn"],
        additionalProperties: false,
      },
    },
  },
  required: ["slices"],
  additionalProperties: false,
};
// Model output is untrusted input: validate shapes before using them.
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const isStrings = (x: unknown): x is string[] => Array.isArray(x) && x.every((s) => typeof s === "string");

function parseQuestions(x: unknown): string[] {
  return isRecord(x) && isStrings(x.questions) ? x.questions.slice(0, LIMITS.maxQuestions) : [];
}

const slug = (id: unknown) =>
  String(id ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

/** Slice ids become branch and directory names, so normalise and de-duplicate them. */
/** `known` are ids of slices that already exist (a replan): new ids avoid them and may depend on them. */
function parseSlices(x: unknown, known: ReadonlySet<string> = new Set()): Slice[] {
  if (!isRecord(x) || !Array.isArray(x.slices)) return [];
  const taken = new Set<string>(known);
  const finalId = new Map<string, string>(); // planner's id (normalised) -> final id
  const out: Slice[] = [];
  const rawDeps: string[][] = [];
  for (const raw of x.slices.slice(0, LIMITS.maxSlices)) {
    if (!isRecord(raw) || typeof raw.goal !== "string" || typeof raw.acceptance !== "string") continue;
    const wanted = slug(raw.id);
    let id = wanted;
    for (let n = out.length + 1; !id || taken.has(id); n++) id = `slice-${n}`;
    taken.add(id);
    if (wanted && !finalId.has(wanted)) finalId.set(wanted, id);
    rawDeps.push(isStrings(raw.dependsOn) ? raw.dependsOn : []);
    out.push({ id, goal: raw.goal, files: isStrings(raw.files) ? raw.files : [], acceptance: raw.acceptance, dependsOn: [] });
  }
  out.forEach((s, i) => {
    const deps = rawDeps[i]!.map((d) => finalId.get(slug(d)) ?? (known.has(slug(d)) ? slug(d) : undefined)).filter((d): d is string => !!d && d !== s.id);
    s.dependsOn = [...new Set(deps)];
  });
  return out;
}

/** Group slices into waves: a slice runs after everything it depends on. Cycles are broken by dropping their deps. */
export function waves(slices: Slice[], already: ReadonlySet<string> = new Set()): Slice[][] {
  const done = new Set<string>(already);
  let left = [...slices];
  const out: Slice[][] = [];
  while (left.length > 0) {
    let ready = left.filter((s) => s.dependsOn.every((d) => done.has(d)));
    if (ready.length === 0) ready = left.map((s) => ({ ...s, dependsOn: [] })); // cycle: run what remains
    out.push(ready);
    for (const s of ready) done.add(s.id);
    const ids = new Set(ready.map((s) => s.id));
    left = left.filter((s) => !ids.has(s.id));
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i] as T);
    }
  });
  await Promise.all(lanes);
  return out;
}

interface Journal {
  task: string;
  base: string;
  questions: string[];
  findings: string;
  slices: Slice[];
  finished: SliceResult[];
  replans: number;
}

function readJournal(dir: string): Journal | undefined {
  try {
    const j: unknown = JSON.parse(readFileSync(join(dir, "journal.json"), "utf8"));
    if (!isRecord(j) || typeof j.task !== "string" || typeof j.base !== "string" || !Array.isArray(j.slices) || !Array.isArray(j.finished)) return undefined;
    return j as unknown as Journal;
  } catch {
    return undefined;
  }
}

const replanPrompt = (task: string, findings: string, done: Slice[], failed: SliceResult[], byId: Map<string, Slice>) =>
  `Task:\n${task}\n\nExploration findings:\n${findings || "(none)"}\n\n` +
  `Finished and merged-ready slices (their work exists on branches; do not repeat it):\n` +
  `${done.map((s) => `- ${s.id}: ${s.goal}`).join("\n") || "(none)"}\n\n` +
  `Slices that failed:\n` +
  `${failed.map((r) => `- ${r.id}: ${byId.get(r.id)?.goal ?? ""}\n  why: ${r.issues[0]?.slice(0, 400) ?? "unknown"}`).join("\n")}\n\n` +
  `Plan only the missing work as at most ${LIMITS.maxSlices} new slices with kebab-case ids that are not used above. ` +
  `A new slice may depend on a finished slice by listing its id in dependsOn. Choose a different approach where the failure suggests the old one was wrong.`;

export async function orchestrate(opts: OrchestrateOptions): Promise<Report> {
  const log = opts.log ?? (() => undefined);
  const budget = opts.runBudgetTokens === undefined ? undefined : count("runBudgetTokens", opts.runBudgetTokens, 1);
  const concurrency = count("concurrency", opts.concurrency ?? LIMITS.concurrency, 1);
  const maxRetries = count("maxRetries", opts.maxRetries ?? LIMITS.maxRetries, 0);
  const maxReplans = Math.min(3, count("maxReplans", opts.maxReplans ?? 0, 0));
  const run = new Run(opts.resume ?? newRunId(), opts.outRoot);
  const journal = opts.resume ? readJournal(run.dir) : undefined;
  const task = journal?.task ?? opts.task;
  // The judge's authority is only what the user typed on this invocation, never the journal: journal.json sits in the
  // run folder, above every worktree, so a worker could rewrite it. A resume with no task passed gives the judge an
  // empty request, which makes it refuse pushes and recursive deletes (pass the task again to allow them).
  const judgeTask = opts.task ?? "";
  if (journal && judgeTask && judgeTask !== journal.task) log("warning: the task passed differs from the journal's; the judge uses the one passed");
  const base = journal?.base ?? (await headRef(opts.repo));
  const report: Report = {
    runId: run.id, base, slices: [], merged: [], conflicted: [], replans: 0, resumed: Boolean(journal),
    spentTokens: 0, tokensByRole: {},
  };
  const finish = (): Report => {
    report.spentTokens = run.spentTokens;
    report.tokensByRole = run.tokensByRole();
    run.save("report.json", report);
    return report;
  };
  if (opts.resume && !journal) {
    report.error = `cannot resume ${opts.resume}: no readable journal.json in ${run.dir}`;
    log(`error: ${report.error}`);
    return finish();
  }

  let questions: string[] = journal?.questions ?? [];
  let findings = journal?.findings ?? "";
  const slices: Slice[] = journal ? [...journal.slices] : [];
  const finished = new Map<string, SliceResult>((journal?.finished ?? []).map((r) => [r.id, r]));
  let replans = journal?.replans ?? 0;
  const saveJournal = () =>
    run.save("journal.json", { task, base, questions, findings, slices, finished: [...finished.values()], replans } satisfies Journal);

  if (journal) {
    log(`resume: ${slices.length} slice(s), ${[...finished.values()].filter((r) => r.status === "passed").length} already passed`);
  } else {
    // 1. Plan (strongest model) -> questions
    const p1 = await opts.run({
      role: "planner",
      cwd: opts.repo,
      schema: QUESTIONS_SCHEMA,
      prompt:
        `Task:\n${task}\n\nSkim the repository just enough to list up to ${LIMITS.maxQuestions} specific questions ` +
        `a cheap read-only explorer should answer before the work is split up (where is X implemented, how are tests run, ...). ` +
        `Return an empty list if you need none.`,
    });
    run.charge("planner", "questions", p1);
    questions = parseQuestions(p1.structured);
    log(`plan: ${questions.length} exploration question(s)`);

    // 2. Explore (cheap, read-only, parallel) -> short summaries kept in shared state
    const answers = await mapLimit(questions, concurrency, async (q) => {
      const r = await opts.run({ role: "explorer", cwd: opts.repo, prompt: q });
      run.charge("explorer", q.slice(0, 60), r);
      return { question: q, answer: r.ok ? r.text : `(exploration failed: ${r.subtype})` };
    });
    findings = answers.map((a, i) => `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer}`).join("\n\n");
    run.save("findings.md", findings);

    // 3. Plan (strongest model) -> independent slices
    const p2 = await opts.run({
      role: "planner",
      cwd: opts.repo,
      schema: SLICES_SCHEMA,
      prompt:
        `Task:\n${task}\n\nExploration findings:\n${findings || "(none)"}\n\n` +
        `Split the task into at most ${LIMITS.maxSlices} slices that can be built in parallel and merged without conflicts: ` +
        `slices must touch disjoint files. If the task cannot be safely parallelised, return exactly one slice. ` +
        `Each slice needs a kebab-case id, a goal, the files it will likely touch, and acceptance criteria ` +
        `(ideally a command that proves it works). Prefer independent slices. If a slice needs another slice's output ` +
        `(for example it calls code the other slice creates), list that slice's id in dependsOn: it then starts from a ` +
        `worktree that already contains the dependency's changes. Otherwise use an empty dependsOn.`,
    });
    run.charge("planner", "slices", p2);
    slices.push(...parseSlices(p2.structured));
    run.save("plan.json", { questions, slices });
    log(`plan: ${slices.length} slice(s): ${slices.map((s) => s.id).join(", ") || "none"}`);
    if (!p2.ok || slices.length === 0) {
      report.error = p2.ok ? "planner returned no usable slices" : `planner failed: ${p2.subtype}`;
      log(`error: ${report.error}`);
      return finish();
    }
    saveJournal();
    if (opts.planOnly) return finish();
  }

  // 4-6. Write (isolated worktree) -> cheap gate -> independent verify -> retry with feedback
  const ctx: SliceContext = {
    run: opts.run, state: run, repo: opts.repo, base, task, judgeTask, findings, maxRetries, budget,
    setupCmd: opts.setupCmd, testCmd: opts.testCmd, resumed: Boolean(journal), finished, log,
  };
  /** One slice's crash (a git error, say) fails that slice only; the other slices and the report survive. */
  const doSlice = async (slice: Slice): Promise<SliceResult> => {
    let r: SliceResult;
    try {
      r = await runSlice(ctx, slice);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`${slice.id}: error: ${msg}`);
      r = { id: slice.id, branch: `orch/${run.id}/${slice.id}`, status: "failed", attempts: 0, issues: [`error: ${msg}`] };
    }
    finished.set(r.id, r); // recorded at once, so a crash later in the run keeps this slice's result for --resume
    saveJournal();
    return r;
  };
  const isSettled = (id: string) => ["passed", "replaced"].includes(finished.get(id)?.status ?? "");
  const passedIds = () => new Set([...finished.values()].filter((r) => r.status === "passed").map((r) => r.id));

  let active = slices.filter((s) => !isSettled(s.id));
  for (;;) {
    for (const wave of waves(active, passedIds())) {
      await mapLimit(wave, concurrency, doSlice);
    }

    // Replan: when slices failed for a reason more work could fix, plan only what is missing.
    const failed = active.map((s) => finished.get(s.id)).filter((r): r is SliceResult => r?.status === "failed");
    const exhausted = budget !== undefined && run.overBudget(budget);
    if (failed.length === 0 || replans >= maxReplans || exhausted) break;
    const byId = new Map(slices.map((s) => [s.id, s]));
    const p3 = await opts.run({
      role: "planner",
      cwd: opts.repo,
      schema: SLICES_SCHEMA,
      prompt: replanPrompt(task, findings, slices.filter((s) => finished.get(s.id)?.status === "passed"), failed, byId),
    });
    run.charge("planner", `replan${replans + 1}`, p3);
    const fresh = p3.ok ? parseSlices(p3.structured, new Set(slices.map((s) => s.id))) : [];
    if (fresh.length === 0) {
      log("replan: the planner returned no usable slices");
      break;
    }
    for (const r of failed) r.status = "replaced";
    slices.push(...fresh);
    replans++;
    run.save("plan.json", { questions, slices });
    saveJournal();
    log(`replan ${replans}: ${fresh.length} new slice(s): ${fresh.map((s) => s.id).join(", ")}`);
    active = fresh;
  }
  report.replans = replans;
  const results = slices.map((s) => finished.get(s.id)!);
  report.slices = results;

  // 7. Integrate passing slices on a fresh result branch; never pushes anything.
  const passing = results.filter((r) => r.status === "passed").map((r) => r.branch);
  if (passing.length > 0) {
    report.resultBranch = `orch/${run.id}/result`;
    try {
      const resultDir = join(run.dir, "worktrees", "result");
      if (journal) {
        await removeWorktree(opts.repo, resultDir);
        await deleteBranch(opts.repo, report.resultBranch);
      }
      const m = await mergeInto(opts.repo, resultDir, report.resultBranch, base, passing);
      report.merged = m.merged;
      report.conflicted = m.conflicted;
    } catch (err) {
      report.error = `integration failed: ${err instanceof Error ? err.message : String(err)}`;
      log(`error: ${report.error}`);
    }
  }

  // Passing slices live on in their branches; failed worktrees stay for debugging.
  if (!opts.keepWorktrees) {
    const done = results.filter((r) => r.status === "passed").map((r) => join(run.dir, "worktrees", r.id));
    for (const dir of [...done, join(run.dir, "worktrees", "result")]) await removeWorktree(opts.repo, dir);
  }
  return finish();
}
