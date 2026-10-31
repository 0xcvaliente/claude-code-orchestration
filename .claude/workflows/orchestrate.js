// Verification status.
// TESTED with a stubbed runtime (src/workflow.test.mjs: fake agent(), parallel(), pipeline(), phase(), log()): the meta
//   block is a pure literal whose phases match the phase() titles; the stage order (plan, explore, build, review, then
//   integrate for isolated waves); the slice cap; retries with reviewer gaps and the failed result; and that every
//   implementer brief starts with `ORCHESTRATION: workflow`, which plan-check.mjs skips (run against the real hook).
// VERIFIED live on Claude Code 2.1.314 (docs/data/live-checks-2026-10-31.md): SubagentStart and SubagentStop fire for
//   this script's agent() launches, with agent_type equal to the agentType given, so the test gate (verify.sh) and the
//   review gate see them. No PreToolUse(Agent) fires, because the script launches agents directly, so plan-check.mjs
//   and journal.mjs launch records do not see them. The agents' own tool calls do fire PreToolUse and PostToolUse.
export const meta = {
  name: 'orchestrate',
  description: 'Plan a task, build slices with the implementer agent, review each with a fresh reviewer, merge isolated code branches',
  whenToUse: 'A task (code, research, writing, analysis or operations) that splits into slices, each with an acceptance check: a runnable command for code, a checklist a reviewer can verify otherwise. Pass code: false when the task changes no code (research, writing, analysis, operations): its slices then share the folder and run in parallel. The script, not the model, fixes the order.',
  phases: [
    { title: 'Plan', detail: 'questions, slices, plan check and plan review' },
    { title: 'Explore', detail: 'researcher agents in parallel' },
    { title: 'Build', detail: 'implementer, then reviewer, with retries' },
    { title: 'Integrate', detail: 'merge isolated branches (code in git only)' },
  ],
}


// args: { task: string, maxSlices?: number, maxRetries?: number, baseRefHead?: boolean, code?: boolean, plan?: object, skip?: string[],
//         gapMin?: number, planCheck?: boolean, planReview?: boolean, refute?: boolean, escalateLast?: boolean }
//   code: true (the default) = the task changes code: a parallel wave runs in worktrees, after a checkpoint commit and
//     merged by the integrator, only when baseRefHead is true; otherwise its slices run one at a time in the shared
//     folder, because each implementer's test gate runs the whole suite and parallel siblings would fail each other's.
//     Pass baseRefHead only for a git repository whose worktree.baseRef is "head": code outside git runs one at a time.
//     false = the task changes no code (research, writing, analysis, operations): no worktrees, checkpoint or
//     integrator, nobody commits, and the slices of a wave run at the same time in the shared folder (their output
//     files are disjoint and none of them is code, so no slice can break the code another slice's test gate might run).
//   plan: a plan object as logged by an earlier run ({ constraints, slices }): skips the Plan and Explore phases.
//   skip: ids of slices that already passed (in an earlier session): they are not run and count as finished.
//   gapMin (default 80): a reviewer gap fails a slice (or a plan review) only at this confidence (0-100) or above; 0
//     makes every gap count. A failed constraint answer always fails. Gaps below it are logged and ignored.
//   planCheck (default true; false turns it off): after plan:slices and after a replan, paths are normalised and
//     overlapping files, unknown dependsOn ids, duplicate ids and dependency cycles are flagged; the planner is asked once
//     more, then what is still wrong is fixed in code and each fix is logged. A plan given in args.plan is fixed in code.
//   planReview (default true): a reviewer checks the plan; a gap at or above gapMin sends it back to the planner once.
//   refute (default true): before a retry a reviewer tries to refute the gaps against the changes; only standing gaps go
//     to the implementer, and a slice whose gaps are all refuted passes.
//   escalateLast (default true): the last implementer attempt (attempt maxRetries+1) runs on opus.
// The plan is logged once as `plan: <JSON>` (and again as `plan after replan: <JSON>` if a replan happens), so a new
// session can resume with args.plan and args.skip.
const task = (args && args.task) || ''
if (!task) throw new Error('pass args.task')
const MAX_SLICES = (args && args.maxSlices) || 6
const MAX_RETRIES = (args && args.maxRetries) || 2
// true only for a git repository whose settings set worktree.baseRef to "head": isolated worktrees then start from the local HEAD
const BASE_REF_HEAD = !!(args && args.baseRefHead === true)
const CODE = !(args && args.code === false)
const GIVEN_PLAN = args && args.plan && typeof args.plan === 'object' ? args.plan : null
const SKIP_ASKED = new Set(Array.isArray(args && args.skip) ? args.skip.map((x) => String(x)) : [])
const GAP_MIN = args && typeof args.gapMin === 'number' && args.gapMin >= 0 ? args.gapMin : 80
const PLAN_CHECK = !(args && args.planCheck === false)
const PLAN_REVIEW = !(args && args.planReview === false)
const REFUTE = !(args && args.refute === false)
const ESCALATE_LAST = !(args && args.escalateLast === false)
const KINDS = ['feature', 'bugfix', 'refactor', 'docs', 'other']

const QUESTIONS = {
  type: 'object',
  properties: { questions: { type: 'array', items: { type: 'string' }, maxItems: 4 } },
  required: ['questions'],
}
const SLICES = {
  type: 'object',
  properties: {
    constraints: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
    },
    slices: {
      type: 'array',
      maxItems: MAX_SLICES,
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          goal: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
          acceptance: { type: 'string' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          risky: { type: 'boolean' },
          checks: { type: 'array', items: { type: 'string' } },
          kind: { type: 'string', enum: KINDS },
        },
        required: ['id', 'goal', 'files', 'acceptance', 'dependsOn', 'risky', 'checks', 'kind'],
      },
    },
  },
  required: ['constraints', 'slices'],
}
const WORK = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'fail'] },
    branch: { type: 'string' },
    evidence: { type: 'string' },
    open: { type: 'string' },
  },
  required: ['status', 'branch', 'evidence', 'open'],
}
const CHECKPOINT = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['pass', 'fail'] },
    commit: { type: 'string' },
    open: { type: 'string' },
  },
  required: ['status', 'commit', 'open'],
}
// A gap with the reviewer's confidence (0-100) that it is a real problem.
const GAP = {
  type: 'object',
  properties: { text: { type: 'string' }, confidence: { type: 'integer', minimum: 0, maximum: 100 } },
  required: ['text', 'confidence'],
}
const PLAN_VERDICT = {
  type: 'object',
  properties: { pass: { type: 'boolean' }, gaps: { type: 'array', items: GAP } },
  required: ['pass', 'gaps'],
}
const REFUTED = {
  type: 'object',
  properties: {
    gaps: {
      type: 'array',
      items: {
        type: 'object',
        properties: { n: { type: 'integer' }, stands: { type: 'boolean' }, reason: { type: 'string' } },
        required: ['n', 'stands', 'reason'],
      },
    },
  },
  required: ['gaps'],
}
const VERDICT = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    gaps: { type: 'array', items: GAP },
    evidence: { type: 'string' },
    answers: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['pass', 'fail'] },
          mode: { type: 'string', enum: ['cmd', 'read'] },
          detail: { type: 'string' },
        },
        required: ['id', 'verdict', 'mode', 'detail'],
      },
    },
    open: { type: 'string' },
  },
  required: ['pass', 'gaps', 'evidence', 'answers', 'open'],
}

const PLAN_RULES = CODE
  ? `Each slice needs a kebab-case id, goal, files, a runnable acceptance command, dependsOn ids, risky=true for security-sensitive or cross-module work, checks: the ids of the constraints it must satisfy, and kind (feature, bugfix, refactor, docs or other; bugfix when the slice fixes a defect, so its implementer writes a failing reproduction test first). Constraints are task-wide rules a reviewer can verify (id C1, C2, ... and a one-line text); return an empty list if there are none.`
  : `Each slice needs a kebab-case id, goal, files (the output files it creates or changes), an acceptance check (a runnable command if the slice runs code, otherwise a checklist a reviewer can verify by reading the output and its cited sources), dependsOn ids, risky=true when a wrong result is costly (security, payments, data deletion, production operations, content sent or published outside the team), checks: the ids of the constraints it must satisfy, and kind (feature, bugfix, refactor, docs or other). Constraints are task-wide rules a reviewer can verify (id C1, C2, ... and a one-line text); return an empty list if there are none.`

// Plan check (args.planCheck). Paths lose a leading ./ and a trailing /; '.' is the whole folder.
const normPath = (p) => {
  let x = String(p || '').trim()
  while (x.startsWith('./')) x = x.slice(2)
  while (x.length > 1 && x.endsWith('/')) x = x.slice(0, -1)
  return x
}
// Equal paths, or one a folder prefix of the other at a path-segment boundary.
const pathsOverlap = (a, b) => a === b || a === '.' || b === '.' || b.startsWith(a + '/') || a.startsWith(b + '/')
// Checks a list of slices and returns a fixed copy plus each problem found and the fix applied to it. `external` holds
// ids that exist outside the list (finished slices on a replan): a slice may depend on them.
function checkPlan(list, external) {
  const problems = []
  const out = list.filter(Boolean).map((s) => ({
    ...s,
    id: String(s.id || '').trim(),
    files: [...new Set((Array.isArray(s.files) ? s.files : []).map(normPath).filter(Boolean))],
    dependsOn: [...new Set((Array.isArray(s.dependsOn) ? s.dependsOn : []).map((d) => String(d).trim()).filter(Boolean))],
  }))
  // Duplicate or missing ids: the later slice is renamed, so dependencies on the id keep pointing at the first.
  const all = new Set([...external, ...out.map((s) => s.id)])
  const seen = new Set()
  out.forEach((s, i) => {
    if (s.id && !seen.has(s.id)) return seen.add(s.id)
    const base = s.id || 'slice'
    let n = 2
    while (all.has(`${base}-${n}`)) n++
    const id = `${base}-${n}`
    problems.push({ problem: s.id ? `duplicate id ${s.id} (slice ${i + 1})` : `slice ${i + 1} has no id`, fix: `renamed it to ${id}` })
    all.add(id)
    seen.add(id)
    s.id = id
  })
  // Unknown dependencies.
  const known = new Set([...external, ...seen])
  for (const s of out) {
    for (const d of s.dependsOn.filter((x) => !known.has(x))) {
      problems.push({ problem: `${s.id} depends on unknown id ${d}`, fix: `dropped that dependency` })
      s.dependsOn = s.dependsOn.filter((x) => x !== d)
    }
  }
  // Dependency cycles: a depth-first walk in plan order drops each edge that closes a cycle.
  const byId = new Map(out.map((s) => [s.id, s]))
  const state = new Map()
  const visit = (s) => {
    state.set(s.id, 1)
    for (const d of s.dependsOn.slice()) {
      const t = byId.get(d)
      if (!t) continue
      if (state.get(d) === 1) {
        problems.push({ problem: `dependency cycle: ${s.id} depends on ${d}, which depends on ${s.id}${d === s.id ? '' : ' through others'}`, fix: `dropped the dependency of ${s.id} on ${d}` })
        s.dependsOn = s.dependsOn.filter((x) => x !== d)
      } else if (!state.has(d)) visit(t)
    }
    state.set(s.id, 2)
  }
  for (const s of out) if (!state.has(s.id)) visit(s)
  // Overlapping files between two slices with no dependency path between them: the later one waits for the earlier.
  const reaches = (from, to) => {
    const stack = [from]
    const met = new Set()
    while (stack.length) {
      const x = byId.get(stack.pop())
      if (!x || met.has(x.id)) continue
      met.add(x.id)
      for (const d of x.dependsOn) {
        if (d === to) return true
        stack.push(d)
      }
    }
    return false
  }
  for (let j = 1; j < out.length; j++) {
    for (let i = 0; i < j; i++) {
      const a = out[i]
      const b = out[j]
      let pair = null
      for (const fa of a.files) for (const fb of b.files) if (!pair && pathsOverlap(fa, fb)) pair = [fa, fb]
      if (!pair || reaches(b.id, a.id) || reaches(a.id, b.id)) continue
      problems.push({ problem: `${a.id} and ${b.id} both own ${pair[0] === pair[1] ? pair[0] : `${pair[0]} and ${pair[1]}`} with no dependency between them`, fix: `${b.id} now depends on ${a.id}` })
      b.dependsOn.push(a.id)
    }
  }
  return { slices: out, problems }
}
// Checks a plan; when something is wrong, asks the planner once more (unless ask is false), then fixes what is still
// wrong in code and logs each fix. `keep` filters the slices the planner returns (a replan drops ids already taken).
async function checkedPlan(p, external, label, ask, keep = () => true) {
  const slicesOf = (x) => ((x && x.slices) || []).filter((s) => s && keep(s))
  let r = checkPlan(slicesOf(p), external)
  if (!r.problems.length) return { ...p, slices: r.slices }
  log(`${label}: plan check found ${r.problems.length} problem(s): ${r.problems.map((x) => x.problem).join('; ')}`)
  if (ask) {
    const again = await agent(
      `Task:\n${task}\n\nThe plan below has problems:\n${r.problems.map((x) => `- ${x.problem}`).join('\n')}\n\nPlan:\n${JSON.stringify({ constraints: (p && p.constraints) || [], slices: slicesOf(p) })}\n\n` +
        `Return the whole plan again with these problems fixed: unique ids, dependsOn only on planned${external.length ? ' or finished' : ''} ids (finished: ${external.join(', ') || 'none'}), no dependency cycles, and slices that own the same file or folder ordered by dependsOn. At most ${MAX_SLICES} slices. ${PLAN_RULES}`,
      { label: `${label}:recheck`, phase: 'Plan', effort: 'high', schema: SLICES },
    )
    if (slicesOf(again).length) {
      p = { constraints: [...((p && p.constraints) || []), ...((again && again.constraints) || [])], slices: again.slices }
      r = checkPlan(slicesOf(p), external)
      if (!r.problems.length) log(`${label}: the planner fixed the plan`)
    } else log(`${label}: the planner returned no plan; fixing in code`)
  }
  for (const x of r.problems) log(`${label}: plan fix: ${x.problem}: ${x.fix}`)
  return { ...p, slices: r.slices }
}
const withKind = (s) => (KINDS.includes(s.kind) ? s : { ...s, kind: 'other' })
const gapOf = (g) =>
  typeof g === 'string'
    ? { text: g, confidence: 100 }
    : { text: String((g && g.text) || ''), confidence: g && typeof g.confidence === 'number' ? g.confidence : 100 }

let findings = ''
let plan = GIVEN_PLAN
if (plan && PLAN_CHECK) plan = await checkedPlan(plan, [], 'plan', false)
if (!plan) {
  phase('Plan')
  const q = await agent(
    CODE
      ? `Task:\n${task}\n\nSkim the repository and list up to 4 specific questions a read-only explorer should answer before the work is split up. Return an empty list if you need none.`
      : `Task:\n${task}\n\nSkim the folder and list up to 4 specific questions a read-only researcher (local files and the web) should answer before the work is split up. Return an empty list if you need none.`,
    { label: 'plan:questions', effort: 'high', schema: QUESTIONS },
  )

  phase('Explore')
  const answers = await parallel(
    ((q && q.questions) || []).map((question) => () =>
      agent(question, { label: `explore:${question.slice(0, 30)}`, phase: 'Explore', agentType: 'researcher' }),
    ),
  )
  findings = ((q && q.questions) || [])
    .map((question, i) => `Q${i + 1}: ${question}\nA${i + 1}: ${answers[i] || '(failed)'}`)
    .join('\n\n')

  plan = await agent(
    CODE
      ? `Task:\n${task}\n\nFindings:\n${findings || '(none)'}\n\nSplit the task into at most ${MAX_SLICES} slices with disjoint files. ${PLAN_RULES} If it cannot be parallelised safely, return one slice.`
      : `Task:\n${task}\n\nFindings:\n${findings || '(none)'}\n\nSplit the task into at most ${MAX_SLICES} slices with disjoint output files in this folder. ${PLAN_RULES} If it cannot be parallelised safely, return one slice.`,
    { label: 'plan:slices', phase: 'Plan', effort: 'high', schema: SLICES },
  )
  if (PLAN_CHECK) plan = await checkedPlan(plan, [], 'plan:slices', true)

  // Plan review (args.planReview): ownership, order, constraint coverage and runnable checks, before any work starts.
  if (PLAN_REVIEW && ((plan && plan.slices) || []).length) {
    const pr = await agent(
      `Review this plan before any work starts.\nTask:\n${task}\n\nConstraints:\n${((plan && plan.constraints) || []).map((c) => `${c.id}: ${c.text}`).join('\n') || '(none)'}\n\nSlices:\n${JSON.stringify(plan.slices)}\n\n` +
        `Check: file ownership (slices that can run at the same time, with no dependsOn path between them, never own the same file or folder); order (dependsOn puts each slice after the work it needs); constraint coverage (each constraint is in the checks of every slice it applies to); and that each acceptance check is runnable as written (${CODE ? 'a command that works in this repository' : 'a command, or a checklist a reviewer can verify by reading'}). Skim the ${CODE ? 'repository' : 'folder'} as needed. Return pass, and each gap with a confidence from 0 to 100 that it is a real problem.`,
      { label: 'plan:review', phase: 'Plan', agentType: 'reviewer', schema: PLAN_VERDICT },
    )
    const gaps = pr && !pr.pass ? (pr.gaps || []).map(gapOf) : []
    const high = gaps.filter((g) => g.confidence >= GAP_MIN)
    const low = gaps.filter((g) => g.confidence < GAP_MIN)
    if (!pr) log('plan review: the reviewer returned nothing; keeping the plan')
    if (low.length) log(`plan review: ignoring ${low.length} gap(s) below confidence ${GAP_MIN}: ${low.map((g) => `${g.text} (${g.confidence})`).join('; ')}`)
    if (high.length) {
      log(`plan review: ${high.length} gap(s); the planner revises once`)
      const revised = await agent(
        `Task:\n${task}\n\nFindings:\n${findings || '(none)'}\n\nPlan:\n${JSON.stringify(plan)}\n\nA plan review found these gaps:\n${high.map((g) => `- ${g.text}`).join('\n')}\n\nReturn the whole plan revised to close them, in at most ${MAX_SLICES} slices with disjoint files. ${PLAN_RULES}`,
        { label: 'plan:revise', phase: 'Plan', effort: 'high', schema: SLICES },
      )
      if (revised && ((revised.slices || []).filter(Boolean)).length) {
        plan = { constraints: (revised.constraints || []).length ? revised.constraints : (plan && plan.constraints) || [], slices: revised.slices }
        if (PLAN_CHECK) plan = await checkedPlan(plan, [], 'plan:revise', true)
      } else log('plan review: the planner returned no revised plan; keeping the plan')
    }
  }
}

const upper = (x) => String(x || '').trim().toUpperCase()
// Constraint texts by id (upper-cased; a repeated id keeps its first text, as in docs/brief-grammar.md).
const constraints = new Map()
const addConstraints = (list) => {
  for (const c of Array.isArray(list) ? list : []) {
    const id = upper(c && c.id)
    const text = String((c && c.text) || '').trim()
    if (id && text && !constraints.has(id)) constraints.set(id, text)
  }
}
addConstraints(plan && plan.constraints)
const slices = ((plan && plan.slices) || []).filter(Boolean).map(withKind)
log(`${slices.length} slice(s): ${slices.map((s) => s.id).join(', ') || 'none'}`)
if (slices.length === 0) return { task, slices: [], note: 'planner returned no slices' }
log(`plan: ${JSON.stringify({ constraints: [...constraints].map(([id, text]) => ({ id, text })), slices })}`)

const checksOf = (s) => [...new Set((Array.isArray(s.checks) ? s.checks : []).map(upper).filter(Boolean))]
// The CHECKS line and the constraint texts in the brief grammar (docs/brief-grammar.md): `CHECKS: C1, C2` then `C1: <text>`.
const checkLines = (s) => {
  const ids = checksOf(s)
  if (!ids.length) return ''
  return `CHECKS: ${ids.join(', ')}\n` + ids.map((id) => (constraints.has(id) ? `${id}: ${constraints.get(id)}\n` : '')).join('')
}
const ANSWER_RULE =
  'Answer every id in CHECKS in answers: verdict pass or fail; mode cmd when you ran a command (detail: `<command> -> <result>`), read when you checked by reading (detail: the file:line or URL). An id you do not answer fails the review.\n'
const OPEN_RULE = 'Put anything unresolved in open (empty when nothing is).\n'
const isOpen = (o) => !/^\s*(none|n\/a|nothing|-)?\.?\s*$/i.test(String(o || ''))

// One reviewer verdict. A failing verdict's gaps count at confidence GAP_MIN or above (a gap without a confidence counts
// as 100); the rest are returned as low and ignored. Every checked id it failed or left unanswered is a hard gap, which
// always counts and is never refuted.
const judge = (r, ids) => {
  if (!r) return { gaps: [{ text: 'reviewer failed to return', confidence: 100, hard: true }], low: [], doubt: false }
  const byId = new Map()
  for (const a of Array.isArray(r.answers) ? r.answers : []) {
    const id = upper(a && a.id)
    if (id && (!byId.has(id) || a.verdict === 'fail')) byId.set(id, a)
  }
  const all = r.pass ? [] : (Array.isArray(r.gaps) ? r.gaps : []).map(gapOf)
  const gaps = all.filter((g) => g.confidence >= GAP_MIN)
  const low = all.filter((g) => g.confidence < GAP_MIN)
  for (const id of ids) {
    const a = byId.get(id)
    if (!a) gaps.push({ text: `${id}: not answered`, confidence: 100, hard: true })
    else if (a.verdict !== 'pass') gaps.push({ text: `${id}: ${a.detail || 'failed'}`, confidence: 100, hard: true })
  }
  const doubt = [...byId.values()].some((a) => a.mode === 'read') || isOpen(r.open)
  return { gaps, low, doubt }
}
const texts = (gaps) => gaps.map((g) => g.text)

// Reviews a slice and returns its gaps (none = passed). A risky slice gets a default and an opus reviewer at once;
// otherwise a passing review is escalated to one opus reviewer, whose verdict decides, when it shows a doubt signal
// (a read-mode answer or a non-empty open) or the slice already failed a review.
async function review(s, body, label, phaseName, retry) {
  const ids = checksOf(s)
  const bugfix =
    s.kind === 'bugfix'
      ? 'KIND: bugfix. Check that the reproduction test fails without the fix and passes with it: run it now, and run it against the code before the fix without discarding the changes (for example in a temporary copy), or compare the failing output the implementer recorded.\n'
      : ''
  const prompt = checkLines(s) + bugfix + body + (ids.length ? ANSWER_RULE : '') + OPEN_RULE
  const ask = (model) =>
    agent(prompt, { label: `${label}${model ? ':' + model : ''}`, phase: phaseName, agentType: 'reviewer', model, schema: VERDICT })
  const logLow = (low) => {
    if (low.length) log(`${s.id}: ignoring ${low.length} reviewer gap(s) below confidence ${GAP_MIN}: ${low.map((g) => `${g.text} (${g.confidence})`).join('; ')}`)
  }
  const verdicts = (await parallel((s.risky ? [undefined, 'opus'] : [undefined]).map((model) => () => ask(model)))).map((r) => judge(r, ids))
  logLow(verdicts.flatMap((v) => v.low))
  const gaps = verdicts.flatMap((v) => v.gaps)
  if (gaps.length || s.risky || !(retry || verdicts.some((v) => v.doubt))) return gaps
  log(`${s.id}: escalating to an opus review (${retry ? 'retry' : 'doubt signal'})`)
  const v = judge(await ask('opus'), ids)
  logLow(v.low)
  return v.gaps
}

// Refute pass (args.refute): a reviewer tries to disprove each refutable gap against the slice's changes and returns the
// gaps that still stand. Hard gaps (failed constraint answers, a reviewer that returned nothing) always stand.
async function refute(s, gaps, label) {
  const soft = gaps.filter((g) => !g.hard)
  if (!REFUTE || !soft.length) return gaps
  const r = await agent(
    `Slice ${s.id}\nGoal: ${s.goal}\nAcceptance: ${s.acceptance}\nFiles: ${(s.files || []).join(', ') || 'unspecified'}\nA reviewer rejected this slice with these gaps:\n${soft.map((g, i) => `${i + 1}. ${g.text} (confidence ${g.confidence})`).join('\n')}\n` +
      (CODE
        ? 'Look at the changes (git diff HEAD and git status if this folder is a git work tree, otherwise the files above)'
        : "Read the slice's files") +
      ' and try to refute each gap: a gap stands only when the changes really show the problem. Return one entry per gap: n (its number), stands, and the reason.\n',
    { label, phase: 'Build', agentType: 'reviewer', schema: REFUTED },
  )
  if (!r) {
    log(`${s.id}: the refute pass returned nothing; every gap stands`)
    return gaps
  }
  const refuted = new Set((Array.isArray(r.gaps) ? r.gaps : []).filter((x) => x && x.stands === false).map((x) => Number(x.n)))
  const standing = soft.filter((_g, i) => !refuted.has(i + 1))
  const dropped = soft.filter((_g, i) => refuted.has(i + 1))
  if (dropped.length) log(`${s.id}: refute pass dropped ${dropped.length} gap(s): ${texts(dropped).join('; ')}`)
  return [...gaps.filter((g) => g.hard), ...standing]
}

const results = []
const sharedFiles = []
// args.skip: ids not in the plan are ignored; a slice is skipped only when every slice it depends on is skipped too
// (otherwise it runs again). Skipped slices count as passed.
const planned = new Map(slices.map((s) => [s.id, s]))
const unknownSkip = [...SKIP_ASKED].filter((id) => !planned.has(id))
if (unknownSkip.length) log(`skip: ignoring ids not in the plan: ${unknownSkip.join(', ')}`)
const SKIP = new Set()
for (let changed = true; changed; ) {
  changed = false
  for (const id of SKIP_ASKED) {
    const s = planned.get(id)
    if (s && !SKIP.has(id) && (s.dependsOn || []).every((d) => SKIP.has(d))) {
      SKIP.add(id)
      changed = true
    }
  }
}
const rerun = [...SKIP_ASKED].filter((id) => planned.has(id) && !SKIP.has(id))
if (rerun.length) log(`skip: running again because a slice they depend on is not skipped: ${rerun.join(', ')}`)
const finished = new Set(SKIP)
for (const s of slices) if (SKIP.has(s.id)) results.push({ slice: s, status: 'skipped', attempts: 0, branch: '', gaps: [] })

// Runs a list of slices in dependency waves. `done` holds ids that count as finished before the first wave.
async function runSlices(list, done) {
  // Group into waves: a slice runs after everything it depends on. With planCheck on, the plan has no cycles or unknown
  // ids; with it off, a cycle (or an unknown id) is broken by running what remains.
  const waves = []
  let left = list.slice()
  while (left.length) {
    let ready = left.filter((s) => (s.dependsOn || []).every((d) => done.has(d)))
    if (!ready.length) {
      log(`dependency cycle among ${left.map((s) => s.id).join(', ')}; running them together`)
      ready = left
    }
    waves.push(ready)
    ready.forEach((s) => done.add(s.id))
    left = left.filter((s) => !done.has(s.id))
  }

  for (const wave of waves) {
    // Isolate only parallel slices of code, and only with baseRefHead (callers pass it for a git repository whose
    // worktree.baseRef is "head"): worktrees see only committed work, and only from the local HEAD then. Otherwise a code
    // wave runs in the shared tree, one slice at a time. A task that changes no code has no worktrees, checkpoint or
    // integrator: its wave runs in the shared folder (below).
    let isolated = CODE && wave.length > 1 && BASE_REF_HEAD
    if (CODE && wave.length > 1 && !BASE_REF_HEAD) {
      log(`wave ${wave.map((s) => s.id).join(', ')}: baseRefHead is not set (worktree.baseRef is not "head", so worktrees would branch from the remote default branch, or this is not a git repository); running one after another in the shared tree`)
    }
    if (isolated) {
      // Checkpoint the shared-tree slices' files (no-op when nothing is staged) so worktrees see them from the local HEAD.
      const cp = await agent(
        `CHECKPOINT after-earlier-waves\nFiles owned by finished shared-tree slices: ${sharedFiles.join(', ') || '(none)'}\nStage only these paths, commit, run no merges and report the commit hash (or "none" if nothing was committed).`,
        { label: 'checkpoint', phase: 'Integrate', agentType: 'integrator', schema: CHECKPOINT },
      )
      const hasCommit = !!(cp && cp.status === 'pass' && cp.commit && !/^none$/i.test(cp.commit.trim()))
      if (sharedFiles.length && !hasCommit) {
        // Worktrees branch from HEAD, so without the commit they would not contain the earlier slices' work.
        isolated = false
        log(`wave ${wave.map((s) => s.id).join(', ')}: checkpoint ${cp ? `failed or committed nothing (${cp.open || cp.status})` : 'returned nothing'} while shared-tree files were pending (${sharedFiles.join(', ')}); running one after another in the shared tree`)
      }
    }
    phase('Build')
    const runSlice = async (s) => {
      let feedback = ''
      let work = null
      let failedReview = false
      for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        // escalateLast: the final attempt goes to a fresh opus implementer with the standing gaps.
        const last = ESCALATE_LAST && attempt > 1 && attempt === MAX_RETRIES + 1
        if (last) log(`${s.id}: last attempt ${attempt} runs on opus`)
        work = await agent(
          `ORCHESTRATION: workflow\n${s.kind === 'bugfix' ? 'KIND: bugfix\n' : ''}Slice ${s.id}\n${checkLines(s)}Goal: ${s.goal}\nFiles you own: ${s.files.join(', ') || 'unspecified'}\nAcceptance check: ${s.acceptance}\n` +
            (checksOf(s).length ? 'Meet every constraint in CHECKS and say in evidence how each is met.\n' : '') +
            (s.kind === 'bugfix'
              ? 'This slice fixes a bug. First write a test that reproduces it, run it and record its failing output in evidence; then fix the bug; then run the test again and show it passing.\n'
              : '') +
            `Overall task: ${task}\nFindings:\n${findings || '(none)'}\n` +
            (isolated
              ? 'You are in an isolated worktree: commit all changes on the current branch and report its name.\n'
              : CODE
                ? 'Do not commit.\n'
                : 'You work in the shared folder; other slices may be writing their own files at the same time, so touch only yours. Do not commit.\n') +
            (last ? 'This is the last attempt, given to you as a fresh agent after earlier attempts were rejected.\n' : '') +
            (feedback ? `A previous attempt was rejected. Fix:\n${feedback}\n` : ''),
          { label: `build:${s.id}#${attempt}`, phase: 'Build', agentType: 'implementer', model: last ? 'opus' : undefined, isolation: isolated ? 'worktree' : undefined, schema: WORK },
        )
        if (!work || work.status !== 'pass') {
          feedback = work ? `${work.evidence}\n${work.open}` : 'the implementer failed to return'
          continue
        }
        // Isolated work is reviewed after integration, so review here only when it is in the shared tree.
        if (isolated) return { slice: s, status: 'built', attempts: attempt, branch: work.branch, gaps: [] }
        const gaps = await review(
          s,
          CODE
            ? `Goal: ${s.goal}\nAcceptance: ${s.acceptance}\nFiles: ${s.files.join(', ') || 'unspecified'}\nIf this folder is a git work tree, review the working-tree changes (git diff HEAD and git status); otherwise read these files. Then run the acceptance check and return a verdict.\n`
            : `Goal: ${s.goal}\nAcceptance checklist: ${s.acceptance}\nFiles: ${s.files.join(', ') || 'unspecified'}\nReview the slice's files against the goal and the checklist (not git diff): read the output, check every item and the sources it cites, and return a verdict.\n`,
          `review:${s.id}#${attempt}`,
          'Build',
          failedReview,
        )
        if (gaps.length === 0) return { slice: s, status: 'passed', attempts: attempt, branch: '', gaps: [] }
        const standing = await refute(s, gaps, `refute:${s.id}#${attempt}`)
        if (standing.length === 0) {
          log(`${s.id}: no reviewer gap stands after the refute pass; passing`)
          return { slice: s, status: 'passed', attempts: attempt, branch: '', gaps: [] }
        }
        failedReview = true
        feedback = texts(standing).join('\n')
      }
      return { slice: s, status: 'failed', attempts: MAX_RETRIES + 1, branch: (work && work.branch) || '', gaps: feedback ? [feedback] : [] }
    }
    // Isolated slices run at the same time in their own worktrees. Without code the output files of a wave are disjoint
    // and none is code, so its slices share the folder and also run at the same time. Code in the shared tree goes one
    // at a time: each implementer's test gate runs the whole suite, which another slice's half-written files would fail.
    let out
    if (isolated || wave.length === 1 || !CODE) {
      out = await pipeline(wave, runSlice)
    } else {
      out = []
      for (const s of wave) out.push(await runSlice(s))
    }
    const built = out.filter(Boolean)
    if (CODE && !isolated) built.forEach((r) => sharedFiles.push(...r.slice.files))
    results.push(...built)

    if (isolated) {
      phase('Integrate')
      const branches = built.filter((b) => b.status === 'built' && b.branch).map((b) => b.branch)
      const merged = branches.length
        ? await agent(
            `Merge these branches in order and run the checks:\n${branches.join('\n')}\nChecks:\n${built.map((b) => `${b.slice.id}: ${b.slice.acceptance}`).join('\n')}`,
            { label: 'integrate', phase: 'Integrate', agentType: 'integrator' },
          )
        : null
      log(`integrator: ${merged ? 'done' : 'nothing to merge'}`)
      // Review the merged result once per slice, in the shared tree.
      await parallel(
        built.filter((b) => b.status === 'built').map((b) => async () => {
          const gaps = await review(
            b.slice,
            `Goal: ${b.slice.goal}\nAcceptance: ${b.slice.acceptance}\nThe work is merged into the current branch. Review it, run the check, and return a verdict.\n`,
            `review:${b.slice.id}`,
            'Integrate',
            false,
          )
          b.status = gaps.length ? 'failed' : 'passed'
          b.gaps = texts(gaps)
        }),
      )
    }
  }
}

await runSlices(slices.filter((s) => !SKIP.has(s.id)), new Set(finished))

// One replan pass: slices that failed for good go back to the planner, which plans only the missing work.
const failedForGood = results.filter((r) => r.status === 'failed')
if (failedForGood.length) {
  const passed = results.filter((r) => r.status === 'passed' || r.status === 'skipped')
  const doneIds = new Set(passed.map((r) => r.slice.id))
  phase('Plan')
  const replan = await agent(
    `Task:\n${task}\n\nFindings:\n${findings || '(none)'}\n\n` +
      `Finished slices (passed; do not redo them):\n${passed.map((r) => `- ${r.slice.id}: ${r.slice.goal || '(passed earlier)'} [${(r.slice.files || []).join(', ')}]`).join('\n') || '(none)'}\n\n` +
      `Failed slices (gave up after ${MAX_RETRIES + 1} attempts):\n${failedForGood.map((r) => `- ${r.slice.id}: ${r.slice.goal} [${r.slice.files.join(', ')}]\n  gaps: ${r.gaps.join(' | ') || '(none)'}`).join('\n')}\n\n` +
      `Constraints so far:\n${[...constraints].map(([id, text]) => `${id}: ${text}`).join('\n') || '(none)'}\n\n` +
      `Plan only the work still missing, in at most ${MAX_SLICES} slices with disjoint files, avoiding the approach that failed. Use new ids, not the ids above; a new slice may depend on finished slices. ${PLAN_RULES} Return an empty list if the missing work cannot be done.`,
    { label: 'plan:replan', phase: 'Plan', effort: 'high', schema: SLICES },
  )
  addConstraints(replan && replan.constraints)
  const taken = new Set(results.map((r) => r.slice.id))
  let extra = ((replan && replan.slices) || []).filter((s) => s && !taken.has(s.id))
  if (PLAN_CHECK && extra.length) {
    const checked = await checkedPlan({ constraints: [], slices: extra }, [...taken], 'plan:replan', true, (s) => !taken.has(s.id))
    addConstraints(checked.constraints)
    extra = checked.slices
  }
  extra = extra.map(withKind)
  log(`replan: ${extra.length} slice(s): ${extra.map((s) => s.id).join(', ') || 'none'}`)
  // A replanned slice that depends, directly or through another replanned slice, on a slice that failed for good is
  // reported failed and never scheduled, so the cycle fallback cannot run it with that dependency unmet.
  const failedDep = new Map(failedForGood.map((r) => [r.slice.id, r.slice.id]))
  for (let changed = true; changed; ) {
    changed = false
    for (const s of extra) {
      const d = failedDep.has(s.id) ? undefined : (s.dependsOn || []).find((x) => failedDep.has(x))
      if (d !== undefined) {
        failedDep.set(s.id, d)
        changed = true
      }
    }
  }
  const runnable = extra.filter((s) => !failedDep.has(s.id))
  for (const s of extra) {
    if (!failedDep.has(s.id)) continue
    log(`${s.id}: not run, depends on failed ${failedDep.get(s.id)}`)
    results.push({ slice: s, status: 'failed', attempts: 0, branch: '', gaps: [`depends on failed ${failedDep.get(s.id)}`] })
  }
  if (runnable.length) {
    for (const r of failedForGood) r.status = 'replanned'
    log(`plan after replan: ${JSON.stringify({ constraints: [...constraints].map(([id, text]) => ({ id, text })), slices: [...slices.filter((s) => !failedForGood.some((r) => r.slice.id === s.id)), ...runnable] })}`)
    await runSlices(runnable, doneIds)
  }
}

return {
  task,
  slices: results.map((r) => ({ id: r.slice.id, status: r.status, attempts: r.attempts, gaps: r.gaps })),
  passed: results.filter((r) => r.status === 'passed' || r.status === 'skipped').length,
  failed: results.filter((r) => r.status === 'failed').length,
}
