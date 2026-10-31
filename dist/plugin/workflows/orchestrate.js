// Verification status.
// TESTED with a stubbed runtime (src/workflow.test.mjs: fake agent(), parallel(), pipeline(), phase(), log()): the meta
//   block is a pure literal whose phases match the phase() titles; the stage order (plan, explore, build, review, then
//   integrate for isolated waves); the slice cap; retries with reviewer gaps and the failed result; and that every
//   implementer brief starts with `ORCHESTRATION: workflow`, which plan-check.mjs skips (run against the real hook).
// UNVERIFIED against a live run: whether this script's agent() launches reach PreToolUse hooks (plan-check.mjs,
//   journal.mjs) at all, and whether the Stop gates (verify.sh, the review gate) fire for them. Do not rely on either.
export const meta = {
  name: 'orchestrate',
  description: 'Plan a task, build slices with the implementer agent, review each with a fresh reviewer, merge isolated code branches',
  whenToUse: 'A task (code, research, writing, analysis or operations) that splits into slices, each with an acceptance check: a runnable command for code, a checklist a reviewer can verify otherwise. Pass code: false when the task changes no code (research, writing, analysis, operations): its slices then share the folder and run in parallel. The script, not the model, fixes the order.',
  phases: [
    { title: 'Plan', detail: 'questions, then slices' },
    { title: 'Explore', detail: 'researcher agents in parallel' },
    { title: 'Build', detail: 'implementer, then reviewer, with retries' },
    { title: 'Integrate', detail: 'merge isolated branches (code in git only)' },
  ],
}


// args: { task: string, maxSlices?: number, maxRetries?: number, baseRefHead?: boolean, code?: boolean, plan?: object, skip?: string[] }
//   code: true (the default) = the task changes code: a parallel wave runs in worktrees, after a checkpoint commit and
//     merged by the integrator, only when baseRefHead is true; otherwise its slices run one at a time in the shared
//     folder, because each implementer's test gate runs the whole suite and parallel siblings would fail each other's.
//     Pass baseRefHead only for a git repository whose worktree.baseRef is "head": code outside git runs one at a time.
//     false = the task changes no code (research, writing, analysis, operations): no worktrees, checkpoint or
//     integrator, nobody commits, and the slices of a wave run at the same time in the shared folder (their output
//     files are disjoint and none of them is code, so no slice can break the code another slice's test gate might run).
//   plan: a plan object as logged by an earlier run ({ constraints, slices }): skips the Plan and Explore phases.
//   skip: ids of slices that already passed (in an earlier session): they are not run and count as finished.
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
        },
        required: ['id', 'goal', 'files', 'acceptance', 'dependsOn', 'risky', 'checks'],
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
const VERDICT = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    gaps: { type: 'array', items: { type: 'string' } },
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
  ? `Each slice needs a kebab-case id, goal, files, a runnable acceptance command, dependsOn ids, risky=true for security-sensitive or cross-module work, and checks: the ids of the constraints it must satisfy. Constraints are task-wide rules a reviewer can verify (id C1, C2, ... and a one-line text); return an empty list if there are none.`
  : `Each slice needs a kebab-case id, goal, files (the output files it creates or changes), an acceptance check (a runnable command if the slice runs code, otherwise a checklist a reviewer can verify by reading the output and its cited sources), dependsOn ids, risky=true when a wrong result is costly (security, payments, data deletion, production operations, content sent or published outside the team), and checks: the ids of the constraints it must satisfy. Constraints are task-wide rules a reviewer can verify (id C1, C2, ... and a one-line text); return an empty list if there are none.`

let findings = ''
let plan = GIVEN_PLAN
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
      agent(question, { label: `explore:${question.slice(0, 30)}`, phase: 'Explore', agentType: 'orchestration:researcher' }),
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
const slices = ((plan && plan.slices) || []).filter(Boolean)
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

// One reviewer verdict: its own gaps, plus a gap for every checked id it failed or left unanswered.
const judge = (r, ids) => {
  if (!r) return { gaps: ['reviewer failed to return'], doubt: false }
  const byId = new Map()
  for (const a of Array.isArray(r.answers) ? r.answers : []) {
    const id = upper(a && a.id)
    if (id && (!byId.has(id) || a.verdict === 'fail')) byId.set(id, a)
  }
  const gaps = r.pass ? [] : (r.gaps || []).slice()
  for (const id of ids) {
    const a = byId.get(id)
    if (!a) gaps.push(`${id}: not answered`)
    else if (a.verdict !== 'pass') gaps.push(`${id}: ${a.detail || 'failed'}`)
  }
  const doubt = [...byId.values()].some((a) => a.mode === 'read') || isOpen(r.open)
  return { gaps, doubt }
}

// Reviews a slice and returns its gaps (none = passed). A risky slice gets a default and an opus reviewer at once;
// otherwise a passing review is escalated to one opus reviewer, whose verdict decides, when it shows a doubt signal
// (a read-mode answer or a non-empty open) or the slice already failed a review.
async function review(s, body, label, phaseName, retry) {
  const ids = checksOf(s)
  const prompt = checkLines(s) + body + (ids.length ? ANSWER_RULE : '') + OPEN_RULE
  const ask = (model) =>
    agent(prompt, { label: `${label}${model ? ':' + model : ''}`, phase: phaseName, agentType: 'orchestration:reviewer', model, schema: VERDICT })
  const verdicts = (await parallel((s.risky ? [undefined, 'opus'] : [undefined]).map((model) => () => ask(model)))).map((r) => judge(r, ids))
  const gaps = verdicts.flatMap((v) => v.gaps)
  if (gaps.length || s.risky || !(retry || verdicts.some((v) => v.doubt))) return gaps
  log(`${s.id}: escalating to an opus review (${retry ? 'retry' : 'doubt signal'})`)
  return judge(await ask('opus'), ids).gaps
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
  // Group into waves: a slice runs after everything it depends on. Cycles are broken by running what remains.
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
        { label: 'checkpoint', phase: 'Integrate', agentType: 'orchestration:integrator', schema: CHECKPOINT },
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
        work = await agent(
          `ORCHESTRATION: workflow\nSlice ${s.id}\n${checkLines(s)}Goal: ${s.goal}\nFiles you own: ${s.files.join(', ') || 'unspecified'}\nAcceptance check: ${s.acceptance}\n` +
            (checksOf(s).length ? 'Meet every constraint in CHECKS and say in evidence how each is met.\n' : '') +
            `Overall task: ${task}\nFindings:\n${findings || '(none)'}\n` +
            (isolated
              ? 'You are in an isolated worktree: commit all changes on the current branch and report its name.\n'
              : CODE
                ? 'Do not commit.\n'
                : 'You work in the shared folder; other slices may be writing their own files at the same time, so touch only yours. Do not commit.\n') +
            (feedback ? `A previous attempt was rejected. Fix:\n${feedback}\n` : ''),
          { label: `build:${s.id}#${attempt}`, phase: 'Build', agentType: 'orchestration:implementer', isolation: isolated ? 'worktree' : undefined, schema: WORK },
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
        failedReview = true
        feedback = gaps.join('\n')
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
            { label: 'integrate', phase: 'Integrate', agentType: 'orchestration:integrator' },
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
          b.gaps = gaps
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
  const extra = ((replan && replan.slices) || []).filter((s) => s && !taken.has(s.id))
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
