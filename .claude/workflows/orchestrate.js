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

// args: { task: string, maxSlices?: number, maxRetries?: number, baseRefHead?: boolean, code?: boolean }
//   code: true (the default) = the task changes code: a parallel wave runs in worktrees, after a checkpoint commit and
//     merged by the integrator, only when baseRefHead is true; otherwise its slices run one at a time in the shared
//     folder, because each implementer's test gate runs the whole suite and parallel siblings would fail each other's.
//     Pass baseRefHead only for a git repository whose worktree.baseRef is "head": code outside git runs one at a time.
//     false = the task changes no code (research, writing, analysis, operations): no worktrees, checkpoint or
//     integrator, nobody commits, and the slices of a wave run at the same time in the shared folder (their output
//     files are disjoint and none of them is code, so no slice can break the code another slice's test gate might run).
const task = (args && args.task) || ''
if (!task) throw new Error('pass args.task')
const MAX_SLICES = (args && args.maxSlices) || 6
const MAX_RETRIES = (args && args.maxRetries) || 2
// true only for a git repository whose settings set worktree.baseRef to "head": isolated worktrees then start from the local HEAD
const BASE_REF_HEAD = !!(args && args.baseRefHead === true)
const CODE = !(args && args.code === false)

const QUESTIONS = {
  type: 'object',
  properties: { questions: { type: 'array', items: { type: 'string' }, maxItems: 4 } },
  required: ['questions'],
}
const SLICES = {
  type: 'object',
  properties: {
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
        },
        required: ['id', 'goal', 'files', 'acceptance', 'dependsOn', 'risky'],
      },
    },
  },
  required: ['slices'],
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
  properties: { pass: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'string' } }, evidence: { type: 'string' } },
  required: ['pass', 'gaps', 'evidence'],
}

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
const findings = ((q && q.questions) || [])
  .map((question, i) => `Q${i + 1}: ${question}\nA${i + 1}: ${answers[i] || '(failed)'}`)
  .join('\n\n')

const plan = await agent(
  CODE
    ? `Task:\n${task}\n\nFindings:\n${findings || '(none)'}\n\nSplit the task into at most ${MAX_SLICES} slices with disjoint files. Each needs a kebab-case id, goal, files, a runnable acceptance command, dependsOn ids, and risky=true for security-sensitive or cross-module work. If it cannot be parallelised safely, return one slice.`
    : `Task:\n${task}\n\nFindings:\n${findings || '(none)'}\n\nSplit the task into at most ${MAX_SLICES} slices with disjoint output files in this folder. Each needs a kebab-case id, goal, files (the output files it creates or changes), an acceptance check (a runnable command if the slice runs code, otherwise a checklist a reviewer can verify by reading the output and its cited sources), dependsOn ids, and risky=true when a wrong result is costly (security, payments, data deletion, production operations, content sent or published outside the team). If it cannot be parallelised safely, return one slice.`,
  { label: 'plan:slices', phase: 'Plan', effort: 'high', schema: SLICES },
)
const slices = (plan && plan.slices) || []
log(`${slices.length} slice(s): ${slices.map((s) => s.id).join(', ') || 'none'}`)
if (slices.length === 0) return { task, slices: [], note: 'planner returned no slices' }

// Group into waves: a slice runs after everything it depends on. Cycles are broken by running what remains.
const waves = []
const done = new Set()
let left = slices.slice()
while (left.length) {
  let ready = left.filter((s) => s.dependsOn.every((d) => done.has(d)))
  if (!ready.length) {
    log(`dependency cycle among ${left.map((s) => s.id).join(', ')}; running them together`)
    ready = left
  }
  waves.push(ready)
  ready.forEach((s) => done.add(s.id))
  left = left.filter((s) => !done.has(s.id))
}

const results = []
const sharedFiles = []
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
      let reviews = []
      for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        work = await agent(
          `ORCHESTRATION: workflow\nSlice ${s.id}\nGoal: ${s.goal}\nFiles you own: ${s.files.join(', ') || 'unspecified'}\nAcceptance check: ${s.acceptance}\n` +
            `Overall task: ${task}\nFindings:\n${findings || '(none)'}\n` +
            (isolated
              ? 'You are in an isolated worktree: commit all changes on the current branch and report its name.\n'
              : CODE
                ? 'Do not commit.\n'
                : 'You work in the shared folder; other slices may be writing their own files at the same time, so touch only yours. Do not commit.\n') +
            (feedback ? `A previous attempt was rejected. Fix:\n${feedback}\n` : ''),
          { label: `build:${s.id}#${attempt}`, phase: 'Build', agentType: 'implementer', isolation: isolated ? 'worktree' : undefined, schema: WORK },
        )
        if (!work || work.status !== 'pass') {
          feedback = work ? `${work.evidence}\n${work.open}` : 'the implementer failed to return'
          continue
        }
        // Isolated work is reviewed after integration, so review here only when it is in the shared tree.
        if (isolated) return { slice: s, status: 'built', attempts: attempt, branch: work.branch, gaps: [] }
        reviews = await parallel(
          (s.risky ? [undefined, 'opus'] : [undefined]).map((model) => () =>
            agent(
              CODE
                ? `Goal: ${s.goal}\nAcceptance: ${s.acceptance}\nFiles: ${s.files.join(', ') || 'unspecified'}\nIf this folder is a git work tree, review the working-tree changes (git diff HEAD and git status); otherwise read these files. Then run the acceptance check and return a verdict.`
                : `Goal: ${s.goal}\nAcceptance checklist: ${s.acceptance}\nFiles: ${s.files.join(', ') || 'unspecified'}\nReview the slice's files against the goal and the checklist (not git diff): read the output, check every item and the sources it cites, and return a verdict.`,
              { label: `review:${s.id}#${attempt}${model ? ':' + model : ''}`, phase: 'Build', agentType: 'reviewer', model, schema: VERDICT },
            ),
          ),
        )
        const gaps = reviews.flatMap((r) => (r && !r.pass ? r.gaps : r ? [] : ['reviewer failed to return']))
        if (gaps.length === 0) return { slice: s, status: 'passed', attempts: attempt, branch: '', gaps: [] }
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
          { label: 'integrate', phase: 'Integrate', agentType: 'integrator' },
        )
      : null
    log(`integrator: ${merged ? 'done' : 'nothing to merge'}`)
    // Review the merged result once per slice, in the shared tree.
    const verdicts = await parallel(
      built.filter((b) => b.status === 'built').map((b) => () =>
        agent(
          `Goal: ${b.slice.goal}\nAcceptance: ${b.slice.acceptance}\nThe work is merged into the current branch. Review it, run the check, and return a verdict.`,
          { label: `review:${b.slice.id}`, phase: 'Integrate', agentType: 'reviewer', schema: VERDICT },
        ).then((v) => ({ b, v })),
      ),
    )
    for (const r of verdicts.filter(Boolean)) {
      r.b.status = r.v && r.v.pass ? 'passed' : 'failed'
      r.b.gaps = r.v ? r.v.gaps : ['reviewer failed to return']
    }
  }
}

return {
  task,
  slices: results.map((r) => ({ id: r.slice.id, status: r.status, attempts: r.attempts, gaps: r.gaps })),
  passed: results.filter((r) => r.status === 'passed').length,
  failed: results.filter((r) => r.status === 'failed').length,
}
