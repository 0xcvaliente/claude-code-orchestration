import { join } from "node:path";
import type { RunAgent } from "./agent.js";
import { count, usd } from "./args.js";
import { LIMITS } from "./config.js";
import { addWorktree, commitAll, headRef, mergeAll, mergeInto, removeWorktree, sh } from "./git.js";
import { Run } from "./state.js";

export interface Slice { id: string; goal: string; files: string[]; acceptance: string; dependsOn: string[] }
export interface SliceResult {
  id: string;
  branch: string;
  status: "passed" | "failed";
  attempts: number;
  issues: string[];
}
export interface Report {
  runId: string;
  base: string;
  slices: SliceResult[];
  resultBranch?: string;
  merged: string[];
  conflicted: string[];
  spentUsd: number;
  costByRole: Record<string, number>;
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
  runBudgetUsd?: number;
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
const VERDICT_SCHEMA = {
  type: "object",
  properties: { pass: { type: "boolean" }, issues: strings(20), summary: { type: "string" } },
  required: ["pass", "issues", "summary"],
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
function parseSlices(x: unknown): Slice[] {
  if (!isRecord(x) || !Array.isArray(x.slices)) return [];
  const taken = new Set<string>();
  const finalId = new Map<string, string>(); // planner's id (normalised) -> final id
  const out: Slice[] = [];
  const rawDeps: string[][] = [];
  for (const raw of x.slices.slice(0, LIMITS.maxSlices)) {
    if (!isRecord(raw) || typeof raw.goal !== "string" || typeof raw.acceptance !== "string") continue;
    const wanted = slug(raw.id);
    let id = wanted;
    if (!id || taken.has(id)) id = `slice-${out.length + 1}`;
    taken.add(id);
    if (wanted && !finalId.has(wanted)) finalId.set(wanted, id);
    rawDeps.push(isStrings(raw.dependsOn) ? raw.dependsOn : []);
    out.push({ id, goal: raw.goal, files: isStrings(raw.files) ? raw.files : [], acceptance: raw.acceptance, dependsOn: [] });
  }
  out.forEach((s, i) => {
    const deps = rawDeps[i]!.map((d) => finalId.get(slug(d))).filter((d): d is string => !!d && d !== s.id);
    s.dependsOn = [...new Set(deps)];
  });
  return out;
}

/** Group slices into waves: a slice runs after everything it depends on. Cycles are broken by dropping their deps. */
export function waves(slices: Slice[]): Slice[][] {
  const done = new Set<string>();
  let left = [...slices];
  const out: Slice[][] = [];
  while (left.length > 0) {
    let ready = left.filter((s) => s.dependsOn.every((d) => done.has(d)));
    if (ready.length === 0) ready = left.map((s) => ({ ...s, dependsOn: [] })); // cycle: run what remains
    out.push(ready);
    for (const s of ready) done.add(s.id);
    left = left.filter((s) => !done.has(s.id));
  }
  return out;
}

function parseVerdict(x: unknown): { pass: boolean; issues: string[] } {
  if (isRecord(x) && typeof x.pass === "boolean") return { pass: x.pass, issues: isStrings(x.issues) ? x.issues : [] };
  return { pass: false, issues: ["verifier returned invalid output"] };
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

export async function orchestrate(opts: OrchestrateOptions): Promise<Report> {
  const log = opts.log ?? (() => undefined);
  const budget = usd("runBudgetUsd", opts.runBudgetUsd ?? LIMITS.runBudgetUsd);
  const concurrency = count("concurrency", opts.concurrency ?? LIMITS.concurrency, 1);
  const maxRetries = count("maxRetries", opts.maxRetries ?? LIMITS.maxRetries, 0);
  const run = new Run(new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14), opts.outRoot);
  const base = await headRef(opts.repo);
  const report: Report = {
    runId: run.id, base, slices: [], merged: [], conflicted: [], spentUsd: 0, costByRole: {},
  };
  const finish = (): Report => {
    report.spentUsd = run.spentUsd;
    report.costByRole = run.costByRole();
    run.save("report.json", report);
    return report;
  };

  // 1. Plan (strongest model) -> questions
  const p1 = await opts.run({
    role: "planner",
    cwd: opts.repo,
    schema: QUESTIONS_SCHEMA,
    prompt:
      `Task:\n${opts.task}\n\nSkim the repository just enough to list up to ${LIMITS.maxQuestions} specific questions ` +
      `a cheap read-only explorer should answer before the work is split up (where is X implemented, how are tests run, ...). ` +
      `Return an empty list if you need none.`,
  });
  run.charge("planner", "questions", p1);
  const questions = parseQuestions(p1.structured);
  log(`plan: ${questions.length} exploration question(s)`);

  // 2. Explore (cheap, read-only, parallel) -> short summaries kept in shared state
  const answers = await mapLimit(questions, concurrency, async (q) => {
    const r = await opts.run({ role: "explorer", cwd: opts.repo, prompt: q });
    run.charge("explorer", q.slice(0, 60), r);
    return { question: q, answer: r.ok ? r.text : `(exploration failed: ${r.subtype})` };
  });
  const findings = answers.map((a, i) => `Q${i + 1}: ${a.question}\nA${i + 1}: ${a.answer}`).join("\n\n");
  run.save("findings.md", findings);

  // 3. Plan (strongest model) -> independent slices
  const p2 = await opts.run({
    role: "planner",
    cwd: opts.repo,
    schema: SLICES_SCHEMA,
    prompt:
      `Task:\n${opts.task}\n\nExploration findings:\n${findings || "(none)"}\n\n` +
      `Split the task into at most ${LIMITS.maxSlices} slices that can be built in parallel and merged without conflicts: ` +
      `slices must touch disjoint files. If the task cannot be safely parallelised, return exactly one slice. ` +
      `Each slice needs a kebab-case id, a goal, the files it will likely touch, and acceptance criteria ` +
      `(ideally a command that proves it works). Prefer independent slices. If a slice needs another slice's output ` +
      `(for example it calls code the other slice creates), list that slice's id in dependsOn: it then starts from a ` +
      `worktree that already contains the dependency's changes. Otherwise use an empty dependsOn.`,
  });
  run.charge("planner", "slices", p2);
  const slices = parseSlices(p2.structured);
  run.save("plan.json", { questions, slices });
  log(`plan: ${slices.length} slice(s): ${slices.map((s) => s.id).join(", ") || "none"}`);
  if (!p2.ok || slices.length === 0) {
    report.error = p2.ok ? "planner returned no usable slices" : `planner failed: ${p2.subtype}`;
    log(`error: ${report.error}`);
    return finish();
  }
  if (opts.planOnly) return finish();

  // 4-6. Write (isolated worktree) -> cheap gate -> independent verify -> retry with feedback
  const finished = new Map<string, SliceResult>();
  const runSlice = async (slice: Slice): Promise<SliceResult> => {
    const dir = join(run.dir, "worktrees", slice.id);
    const branch = `orch/${run.id}/${slice.id}`;
    const res: SliceResult = { id: slice.id, branch, status: "failed", attempts: 0, issues: [] };

    const blocked = slice.dependsOn.filter((d) => finished.get(d)?.status !== "passed");
    if (blocked.length > 0) {
      res.issues = [`skipped: dependency failed (${blocked.join(", ")})`];
      log(`${slice.id}: ${res.issues[0]}`);
      return res;
    }
    await addWorktree(opts.repo, dir, branch, base);
    // Start from the dependencies' work; the verifier then reviews only this slice's own diff.
    const deps = slice.dependsOn.map((d) => finished.get(d)!.branch);
    const { conflicted } = await mergeAll(dir, deps);
    if (conflicted.length > 0) {
      res.issues = [`could not combine dependencies (${conflicted.join(", ")})`];
      return res;
    }
    if (opts.setupCmd) {
      const s = await sh(opts.setupCmd, dir, LIMITS.testTimeoutMs);
      if (s.code !== 0) {
        res.issues = [`setup failed (exit ${s.code}): ${s.output.slice(-1000)}`];
        log(`${slice.id}: ${res.issues[0]!.split("\n")[0]}`);
        return res;
      }
    }
    const sliceBase = await headRef(dir);
    let feedback = "";

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      if (run.overBudget(budget)) {
        res.issues = ["run budget exhausted"];
        break;
      }
      res.attempts = attempt;
      log(`${slice.id}: attempt ${attempt}`);

      const w = await opts.run({
        role: "writer",
        cwd: dir,
        prompt:
          `Overall task:\n${opts.task}\n\nYour slice (${slice.id}):\nGoal: ${slice.goal}\n` +
          `Files likely involved: ${slice.files.join(", ") || "unspecified"}\nAcceptance: ${slice.acceptance}\n\n` +
          `Exploration findings:\n${findings || "(none)"}\n` +
          (feedback ? `\nA previous attempt is already in this worktree but was rejected. Fix these problems:\n${feedback}\n` : ""),
      });
      run.charge("writer", `${slice.id}#${attempt}`, w);
      if (!w.ok) {
        feedback = `The previous attempt ended with: ${w.subtype}. ${w.text}`.trim();
        res.issues = [feedback];
        continue;
      }
      if (!(await commitAll(dir, `orchestrator: ${slice.id} (attempt ${attempt})`)) && attempt === 1) {
        feedback = "The worker made no changes. Implement the slice.";
        res.issues = [feedback];
        continue;
      }

      if (opts.testCmd) {
        const t = await sh(opts.testCmd, dir, LIMITS.testTimeoutMs);
        if (t.code !== 0) {
          feedback = `Tests failed (exit ${t.code}):\n${t.output.slice(-3000)}`;
          res.issues = [feedback];
          continue;
        }
      }

      const v = await opts.run({
        role: "verifier",
        cwd: dir,
        schema: VERDICT_SCHEMA,
        prompt:
          `Goal: ${slice.goal}\nAcceptance: ${slice.acceptance}\n\n` +
          `The change is committed on this branch. Review it with \`git diff ${sliceBase}...HEAD\`, run the tests if you can, ` +
          `and return your verdict as JSON.`,
      });
      run.charge("verifier", `${slice.id}#${attempt}`, v);
      const verdict = v.ok ? parseVerdict(v.structured) : { pass: false, issues: [`verifier failed: ${v.subtype}`] };
      if (verdict.pass) {
        res.status = "passed";
        res.issues = [];
        break;
      }
      feedback = verdict.issues.join("\n");
      res.issues = verdict.issues;
    }
    log(`${slice.id}: ${res.status}`);
    return res;
  };
  /** One slice's crash (a git error, say) fails that slice only; the other slices and the report survive. */
  const doSlice = async (slice: Slice): Promise<SliceResult> => {
    try {
      return await runSlice(slice);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`${slice.id}: error: ${msg}`);
      return { id: slice.id, branch: `orch/${run.id}/${slice.id}`, status: "failed", attempts: 0, issues: [`error: ${msg}`] };
    }
  };
  for (const wave of waves(slices)) {
    const results = await mapLimit(wave, concurrency, doSlice);
    for (const r of results) finished.set(r.id, r);
  }
  const results = slices.map((s) => finished.get(s.id)!);
  report.slices = results;

  // 7. Integrate passing slices on a fresh result branch; never pushes anything.
  const passing = results.filter((r) => r.status === "passed").map((r) => r.branch);
  if (passing.length > 0) {
    report.resultBranch = `orch/${run.id}/result`;
    try {
      const m = await mergeInto(opts.repo, join(run.dir, "worktrees", "result"), report.resultBranch, base, passing);
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
