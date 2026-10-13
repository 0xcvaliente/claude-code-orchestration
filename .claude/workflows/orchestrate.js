export const meta = {
  name: 'orchestrate',
  description: 'Plan a task, build slices with the implementer agent, review each with a fresh reviewer, merge isolated work',
  whenToUse: 'A coding task that splits into slices with runnable acceptance checks. The script, not the model, fixes the order.',
  phases: [
    { title: 'Plan', detail: 'questions, then slices' },
    { title: 'Explore', detail: 'researcher agents in parallel' },
    { title: 'Build', detail: 'implementer, then reviewer, with retries' },
    { title: 'Integrate', detail: 'merge isolated branches' },
  ],
}

// args: { task: string, maxSlices?: number, maxRetries?: number }
const task = (args && args.task) || ''
if (!task) throw new Error('pass args.task')
const MAX_SLICES = (args && args.maxSlices) || 6
const MAX_RETRIES = (args && args.maxRetries) || 2

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
const VERDICT = {
  type: 'object',
  properties: { pass: { type: 'boolean' }, gaps: { type: 'array', items: { type: 'string' } }, evidence: { type: 'string' } },
  required: ['pass', 'gaps', 'evidence'],
}

phase('Plan')
const q = await agent(
  `Task:\n${task}\n\nSkim the repository and list up to 4 specific questions a read-only explorer should answer before the work is split up. Return an empty list if you need none.`,
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
  `Task:\n${task}\n\nFindings:\n${findings || '(none)'}\n\nSplit the task into at most ${MAX_SLICES} slices with disjoint files. Each needs a kebab-case id, goal, files, a runnable acceptance command, dependsOn ids, and risky=true for security-sensitive or cross-module work. If it cannot be parallelised safely, return one slice.`,
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
for (const wave of waves) {
  // Isolate only parallel slices. Later waves run in the shared tree: worktrees branch from the default branch
  // and would not see earlier waves' work.
  const isolated = wave.length > 1
  phase('Build')
  const out = await pipeline(
    wave,
    async (s) => {
      let feedback = ''
      let work = null
      let reviews = []
      for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
        work = await agent(
          `Slice ${s.id}\nGoal: ${s.goal}\nFiles you own: ${s.files.join(', ') || 'unspecified'}\nAcceptance check: ${s.acceptance}\n` +
            `Overall task: ${task}\nFindings:\n${findings || '(none)'}\n` +
            (isolated ? 'You are in an isolated worktree: commit all changes on the current branch and report its name.\n' : 'Do not commit.\n') +
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
              `Goal: ${s.goal}\nAcceptance: ${s.acceptance}\nReview the working-tree changes (git diff HEAD), run the check, and return a verdict.`,
              { label: `review:${s.id}#${attempt}${model ? ':' + model : ''}`, phase: 'Build', agentType: 'reviewer', model, schema: VERDICT },
            ),
          ),
        )
        const gaps = reviews.flatMap((r) => (r && !r.pass ? r.gaps : r ? [] : ['reviewer failed to return']))
        if (gaps.length === 0) return { slice: s, status: 'passed', attempts: attempt, branch: '', gaps: [] }
        feedback = gaps.join('\n')
      }
      return { slice: s, status: 'failed', attempts: MAX_RETRIES + 1, branch: (work && work.branch) || '', gaps: feedback ? [feedback] : [] }
    },
  )
  const built = out.filter(Boolean)
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
