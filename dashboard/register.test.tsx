import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'orchestration-dashboard',
  component: 'Pane',
  requestId: 'orchestration',
  props: { title: 'Orchestration', isFocused: false, bodyColumns: 100, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
} as const

test('the pane follows an implementer from start to its STATUS line', async ($, on) => {
  on('command.register', () => ({ value: { command: 'orchestration' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('agent.spawn', (_, e) => ({ model: 'sonnet', agentId: e.tool_use_id === 't2' ? 'a2' : 'a1' }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  let now = 1000
  on('clock.now', () => ({ value: (now += 1000) }))
  on('clock.every', () => ({ value: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({
    tool_use_id: 't1',
    prompt: 'SLICE: s1\nFILES: a.py\nDEPENDS: none',
    description: 'build a',
    subagentType: 'orchestration:implementer',
    provider: { plugin: 'orchestration', tier: 'user' },
    parentModel: 'opus',
  } as never)

  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] s1/ })).toBeTruthy()
  await ui.unmount()

  await $.agent.spawn({
    tool_use_id: 't2', prompt: 'SLICE: s2\nFILES: b.py, c.py\nDEPENDS: s1, s9', description: 'build b',
    subagentType: 'orchestration:implementer', provider: { plugin: 'orchestration', tier: 'user' }, parentModel: 'opus',
  } as never)

  await $.turn.complete({ turnId: 'x', agentId: 'a1', answer: 'built a.py\nSTATUS: pass', durationMs: 5, isAborted: false, reason: 'answer', usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0, model: 'sonnet' } } as never)
  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // the diagram: s1 is built and unreviewed, s2 runs and waits for s1 and for s9, which was never launched (a queued ghost)
  expect(await ui.find({ type: 'Text', text: /◆ s1/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /build ✔ review -/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /◌ s9/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] s2/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /◀ s9/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /↳ built a\.py/ })).toBeTruthy() // what s1 did
  expect(await ui.find({ type: 'Text', text: /6k/ })).toBeTruthy() // 1000 + 200 + 5000 tokens
  expect(await ui.find({ type: 'Text', text: /in 1k · out 200 · cache 5k/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /\d:\d\d ✔ s1 /.source ? /\d:\d\d ✔ s1 / : /x/ })).toBeTruthy() // the log line
  expect(await ui.find({ type: 'Text', text: /[┐┘┤├]/ })).toBeTruthy() // routed edge into s2
  expect(await ui.find({ type: 'Text', text: /opus · orchestrator/ })).toBeTruthy()
  expect(await ui.find({ type: 'Text', text: /sign off/ })).toBeTruthy()
  // stage cells, one glyph each: build = s1 passed, s2 running, s9 (a ghost) queued; review has no reviewer yet for s1 and s2
  const cells = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('|')
  expect(/\|✔\|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\|◌\|/.test(cells)).toBe(true)
  expect(/\|◌\|◌\|/.test(cells)).toBe(true)
  expect(/▰▱|▱▰/.test(cells.split('|').filter(x => x.length > 3 && /^[▰▱]+$/.test(x)).join(''))).toBe(false) // no proportional stage bar left
  await ui.unmount()

  // resized: at every width nothing is cut off the screen or dropped, however the layers are laid out
  await $.agent.spawn({
    tool_use_id: 't3', prompt: 'SLICE: s3\nFILES: c.py\nDEPENDS: s2', description: 'build c',
    subagentType: 'orchestration:implementer', provider: { plugin: 'orchestration', tier: 'user' }, parentModel: 'opus',
  } as never)
  for (const columns of [24, 32, 40, 52, 64, 80, 100, 140]) {
    const sized = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns } })
    const texts = (await sized.findAll({ type: 'Text' })).map(x => x.text ?? '')
    // text that wraps or truncates is cut by the pane; the line art (rail, gutters, bus, connectors) is not, so it must fit
    const art = texts.filter(x => /^[\s─│┌┐└┘├┤┬┴┼●▶▼╵╷╶╴]+$/.test(x))
    expect(art.length).toBeGreaterThan(0)
    expect(Math.max(...art.map(x => x.length))).toBeLessThanOrEqual(columns)
    expect(texts.filter(x => /^█+$/.test(x)).reduce((t, x) => t + x.length, 0)).toBeLessThanOrEqual(columns)
    for (const word of ['s1', 's2', 's3', 'sign off', 'tasks']) expect(texts.some(x => x.includes(word))).toBe(true)
    await sized.unmount()
  }

  // a narrow, short pane: the slices stack top to bottom, nothing is dropped, and the pane says it scrolls
  const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 36, scroll: { offset: 0, bodyRows: 10 } } })
  expect(await narrow.find({ type: 'Text', text: /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] s2/ })).toBeTruthy()
  expect(await narrow.find({ type: 'Text', text: /◀ s9/ })).toBeTruthy()
  expect(await narrow.find({ type: 'Text', text: /scroll/ })).toBeTruthy()
  await narrow.unmount()
})

const ROUTE_JSON = JSON.stringify({
  mode: 'orchestrate',
  reason: 'four independent slices, "risky" {braces} in text',
  facts: { filesToTouch: 12, linesToChange: 340, independentSlices: 4, risky: true, code: true },
})
const BANNER = '\n> claude-code-orchestration@1.0.0 route\n> tsx src/route.ts {--repo}\n\n'
const ROUTE_CMD = 'cd ~/orch && npm run --silent route -- --repo . --task "x"'

const setup = async ($: any, on: any, output: unknown) => {
  on('command.register', () => ({ value: { command: 'orchestration' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: output, text: 'ok' }))
  let now = 1000
  on('clock.now', () => ({ value: (now += 1000) }))
  on('clock.every', () => ({ value: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
}
const texts = async ($: any, columns = 100) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns } })
  const out = (await ui.findAll({ type: 'Text' })).map((x: any) => x.text ?? '')
  await ui.unmount()
  return out as string[]
}

test('the router run in the main loop shows its triage and leaves the tool result alone', async ($, on) => {
  const output = { stdout: `${BANNER}${ROUTE_JSON}\n`, stderr: '' }
  await setup($, on, output)
  const out = await ($ as any).tool.call({ tool: 'Bash', command: ROUTE_CMD })
  expect(out.result).toEqual(output) // handed on exactly as next(e) returned it
  expect(out.text).toBe('ok')
  const t = await texts($)
  expect(t.some(x => /triage · orchestrate/.test(x))).toBe(true)
  expect(t.some(x => /files 12 · lines 340 · slices 4/.test(x))).toBe(true)
  expect(t.some(x => /risky yes · code yes/.test(x))).toBe(true)
  expect(t.some(x => /◇ triage orchestrate/.test(x))).toBe(true)
  expect(t.some(x => /\(inferred/.test(x))).toBe(false)
})

const CASES: [string, unknown, string][] = [
  ['unbalanced garbage', { stdout: `${BANNER}{ not json {{ "mode": "orchestrate"` }, ROUTE_CMD],
  ['an unknown mode', { stdout: '{"mode":"nonsense","reason":"x"}' }, ROUTE_CMD],
  ['a reason that is not text', { stdout: '{"mode":"plain","reason":5}' }, ROUTE_CMD],
  ['a null result', null, ROUTE_CMD],
  ['a command that only looks like the router', { stdout: `${BANNER}${ROUTE_JSON}` }, 'echo npm run routes'],
  ['another command', { stdout: `${BANNER}${ROUTE_JSON}` }, 'ls'],
]
for (const [name, output, command] of CASES) {
  test(`${name} shows no triage and the result is untouched`, async ($, on) => {
    await setup($, on, output)
    const out = await ($ as any).tool.call({ tool: 'Bash', command })
    expect(out.result).toEqual(output)
    expect((await texts($)).some(x => /triage/.test(x))).toBe(false)
  })
}

test('a Bash call from a sub-agent is not the router', async ($, on) => {
  await setup($, on, { stdout: `${BANNER}${ROUTE_JSON}` })
  // agentId rides on the hook's event; $.tool.call drops it, so raise the event itself where the kit allows
  const raise = ($ as any).tool.call
  const out = await raise({ tool: 'Bash', command: ROUTE_CMD, agentId: 'a9' })
  expect(out.result).toBeTruthy()
  expect((await texts($)).some(x => /triage/.test(x))).toBe(false)
})

test('a verdict without facts shows its reason; with no verdict the mode is inferred', async ($, on) => {
  await setup($, on, { stdout: '{"mode":"reviewed","reason":"small change, one reviewer"}' })
  await ($ as any).tool.call({ tool: 'Bash', command: ROUTE_CMD })
  const t = await texts($)
  expect(t.some(x => /triage · reviewed/.test(x))).toBe(true)
  expect(t.some(x => /small change, one reviewer/.test(x))).toBe(true)
})

test('with no verdict the pane infers the mode and shows all six stages at every width', async ($, on) => {
  on('command.register', () => ({ value: { command: 'orchestration' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'r1' }))
  on('clock.now', () => ({ value: 5000 }))
  on('clock.every', () => ({ value: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn({
    tool_use_id: 't1', prompt: 'SLICE: s1\nFILES: a.py\nDEPENDS: none', description: 'review a',
    subagentType: 'orchestration:reviewer', provider: { plugin: 'orchestration', tier: 'user' }, parentModel: 'opus',
  } as never)
  for (const columns of [24, 32, 39, 40, 52, 64, 80, 99, 100, 140]) {
    const t = await texts($, columns)
    expect(t.some(x => /triage · reviewed/.test(x))).toBe(true)
    expect(t.some(x => /\(inferred/.test(x))).toBe(true)
    for (const stage of ['triage', 'plan', 'plan review', 'build', 'review', 'merge']) expect(t.some(x => x.endsWith(` ${stage}`) && /^[●✔✖◆◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(x))).toBe(true)
    const art = t.filter(x => /^[\s─│┌┐└┘├┤┬┴┼●▶▼╵╷╶╴]+$/.test(x))
    expect(art.length).toBeGreaterThan(0)
    expect(Math.max(...art.map(x => x.length))).toBeLessThanOrEqual(columns)
    if (columns < 100) expect(art.some(x => x.includes('▼') && x.trim() === '▼')).toBe(true) // the return rail between rows
  }
})

const spawnImpl = (id: string, slice: string, type = 'orchestration:implementer') =>
  ({
    tool_use_id: id, prompt: `SLICE: ${slice}\nFILES: a.py\nDEPENDS: none`, description: id, subagentType: type,
    provider: { plugin: 'orchestration', tier: 'user' }, parentModel: 'opus',
  }) as never

test('a stage with more cells than fit shows the latest and +N', async ($, on) => {
  on('command.register', () => ({ value: { command: 'orchestration' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: 'sonnet', agentId: e.tool_use_id }))
  on('clock.now', () => ({ value: 5000 }))
  on('clock.every', () => ({ value: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (let i = 1; i <= 12; i++) await $.agent.spawn(spawnImpl(`t${i}`, `s${i}`))
  // 100 columns: boxes 14 wide, 10 cells inner; 12 slices -> 8 latest cells and +4
  const t = await texts($, 100)
  expect(t.includes('+4')).toBe(true)
})

test('usage by model is one stacked bar with a legend row per model and no bars', async ($, on) => {
  on('command.register', () => ({ value: { command: 'orchestration' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: e.tool_use_id === 't1' ? 'claude-opus-4' : 'claude-sonnet-4', agentId: e.tool_use_id }))
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer }))
  on('clock.now', () => ({ value: 5000 }))
  on('clock.every', () => ({ value: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.agent.spawn(spawnImpl('t1', 's1'))
  await $.agent.spawn(spawnImpl('t2', 's2'))
  const done = (agentId: string, input_tokens: number) =>
    ($ as any).turn.complete({ turnId: agentId, agentId, answer: 'ok\nSTATUS: pass', durationMs: 5, isAborted: false, reason: 'answer', usage: { input_tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' } })
  await done('t1', 3000)
  await done('t2', 1000)
  for (const [columns, width] of [[100, 40], [30, 28], [12, 10]]) {
    const t = await texts($, columns)
    const segs = t.filter(x => /^█+$/.test(x))
    expect(segs.length).toBe(2)
    expect(segs.reduce((n, x) => n + x.length, 0)).toBe(width)
  }
  const t = await texts($, 100)
  expect((t.filter(x => /^█+$/.test(x))[0] as string).length).toBe(30) // opus holds 3/4 of the tokens
  const legend = t.filter(x => x.startsWith('■ ') && /%$/.test(x))
  expect(legend.length).toBe(2)
  expect(legend.some(x => /opus-4\s+3k 75%/.test(x))).toBe(true)
  expect(legend.some(x => /sonnet-4\s+1k 25%/.test(x))).toBe(true)
  expect(legend.every(x => !/[▰▱]/.test(x))).toBe(true)
  expect(t.some(x => /usage by model/.test(x))).toBe(true)
  expect(t.some(x => /agents only/.test(x))).toBe(true)
})

test('a failure a later slice made good shows as fixed; a bare GAPS heading is skipped; plan and merge are labelled', async ($, on) => {
  on('command.register', () => ({ value: { command: 'orchestration' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: 'sonnet', agentId: e.tool_use_id }))
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer }))
  let now = 1000
  on('clock.now', () => ({ value: (now += 1000) }))
  on('clock.every', () => ({ value: {} }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const spawn = (id: string, slice: string, deps: string, type: string) =>
    $.agent.spawn({
      tool_use_id: id, prompt: `SLICE: ${slice}\nFILES: ${slice}.py\nDEPENDS: ${deps}`, description: id, subagentType: type,
      provider: { plugin: 'orchestration', tier: 'user' }, parentModel: 'opus',
    } as never)
  const done = (agentId: string, answer: string) =>
    ($ as any).turn.complete({ turnId: agentId, agentId, answer, durationMs: 5, isAborted: false, reason: 'answer', usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' } })
  const IMPL = 'orchestration:implementer'
  const REV = 'orchestration:reviewer'

  // while an agent runs the plan stage is already done (the orchestrator planned) but merge is not "skipped" yet
  await spawn('a', 'bad', 'none', IMPL)
  let t = await texts($, 100)
  expect(t.includes('orchestrator')).toBe(true)
  expect(t.includes('skipped')).toBe(false)
  await done('a', 'tried\nSTATUS: fail')
  await spawn('ra', 'bad', 'none', REV)
  await done('ra', 'STATUS: fail\nGAPS:\n- the limit is wrong')
  // slice "good" depends on "bad", started after it ended and passes
  await spawn('b', 'good', 'bad', IMPL)
  await done('b', 'fixed it\nSTATUS: pass')
  await spawn('rb', 'good', 'bad', REV)
  await done('rb', 'STATUS: pass\nGAPS: none')
  // a failure nothing fixed, with a bare GAPS heading
  await spawn('c', 'other', 'none', IMPL)
  await done('c', 'built\nSTATUS: pass')
  await spawn('rc', 'other', 'none', REV)
  await done('rc', 'STATUS: fail\nGAPS:\n- off by one in other.py')

  t = await texts($, 100)
  expect(t.some(x => /↳ fixed by good/.test(x))).toBe(true)
  expect(t.some(x => /↳ off by one in other\.py/.test(x))).toBe(true)
  expect(t.some(x => /^↳ GAPS:?$/.test(x.trim()))).toBe(false)
  expect(t.some(x => /signed off with 1 failed/.test(x))).toBe(true)
  expect(t.some(x => /3 passed · 1 failed · 2 fixed/.test(x))).toBe(true)
  expect(t.some(x => /^◆ bad /.test(x))).toBe(true) // the fixed slice is done, not failed
  expect(t.some(x => /^[✔●] plan$/.test(x) || /^✔ plan$/.test(x))).toBe(true)
  expect(t.includes('orchestrator')).toBe(true)
  expect(t.some(x => /^◆ merge$/.test(x))).toBe(true)
  expect(t.includes('skipped')).toBe(true)

  // with every failure fixed (the reviewer of "other" failed, "other2" depends on it and passed) the orchestrator box says so
  await spawn('d', 'other2', 'other', IMPL)
  await done('d', 'ok\nSTATUS: pass')
  await spawn('rd', 'other2', 'other', REV)
  await done('rd', 'STATUS: pass\nGAPS: none')
  t = await texts($, 100)
  expect(t.some(x => /passed · 3 fixed on the way/.test(x))).toBe(true)
  expect(t.some(x => /signed off with/.test(x))).toBe(false)
})

// The main session's own work: a prompt starts it with no repository and no agents, and the main turn's end finishes it.
const boot = async ($: any, on: any, opts: { clock?: any; route?: unknown } = {}) => {
  const seen: any[] = []
  const opened: any[] = []
  on('command.register', () => ({ value: { command: 'orchestration' } }))
  on('ui.open', (_: unknown, e: any) => (opened.push(e), { value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: unknown, e: any) => (seen.push(e), { text: e.text }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: 'sonnet', agentId: e.tool_use_id }))
  on('turn.complete', (_: unknown, e: any) => ({ text: e.answer }))
  if (opts.route) on('tool.call', () => ({ result: opts.route, text: 'ok' }))
  if (!opts.clock) {
    let now = 1000
    on('clock.now', () => ({ value: (now += 1000) }))
    on('clock.every', () => ({ value: {} }))
  }
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true }) // not a git repository
  return { seen, opened }
}
const mainDone = (reason: string) =>
  ({ turnId: 'm', answer: 'the reply', durationMs: 5, isAborted: reason === 'aborted', reason, usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' } }) as never
const PROMPT = 'research the tide tables\nand write two lines'

test('a prompt in a folder that is not a repository opens the pane and shows the input box', async ($, on) => {
  const { opened } = await boot($, on)
  expect(opened.length).toBe(0)
  const out = await ($ as any).prompt.submit({ text: PROMPT })
  expect(out.text).toBe(PROMPT) // handed on unchanged
  expect(opened.length).toBe(1)
  const t = await texts($)
  expect(t.includes('▸ research the tide tables')).toBe(true)
  expect(t.some(x => /working in this session/.test(x))).toBe(true)
  expect(t.some(x => /No orchestration agents yet/.test(x))).toBe(false)
  expect(t.some(x => /triage · sizing/.test(x))).toBe(true)
  expect(t.some(x => /waiting for the reply/.test(x))).toBe(true)
  expect(t.some(x => /0 agents/.test(x))).toBe(true)
  expect(t.some(x => /tasks|usage by model|session log/.test(x))).toBe(false)
})

test('a slash command, a meta prompt and a blank prompt neither open the pane nor start work', async ($, on) => {
  const { seen, opened } = await boot($, on)
  const raise = ($ as any).prompt.submit
  for (const extra of [{ text: '/review the diff', command: { name: 'review', args: 'the diff' } }, { text: 'a hint', isMeta: true }, { text: '  \n ' }]) {
    const out = await raise(extra as never)
    expect(out.text).toBe(extra.text)
  }
  expect(seen.length).toBe(3)
  expect(seen.some(e => e.command)).toBe(true) // the fields reached the hook
  expect(seen.some(e => e.isMeta)).toBe(true)
  expect(opened.length).toBe(0)
  expect((await texts($)).some(x => /No orchestration agents yet/.test(x))).toBe(true)
})

test('work with no agents reads answered once the main turn ends: plain, skipped stages, this session', async ($, on) => {
  await boot($, on)
  await ($ as any).prompt.submit({ text: PROMPT })
  let t = await texts($)
  expect(t.some(x => /\(inferred/.test(x))).toBe(false) // still sizing: no mode yet, every stage queued
  expect(t.includes('skipped')).toBe(false)
  await ($ as any).turn.complete(mainDone('answer'))
  t = await texts($)
  expect(t.filter(x => /answered in this session/.test(x)).length).toBe(2) // orchestrator box and sign-off
  expect(t.some(x => /triage · plain/.test(x))).toBe(true)
  expect(t.some(x => /\(inferred: no agents ran\)/.test(x))).toBe(true)
  expect(t.filter(x => x === 'skipped').length).toBe(4) // plan, plan review, review, merge
  for (const stage of ['plan', 'plan review', 'review', 'merge']) expect(t.some(x => x === `◆ ${stage}`)).toBe(true)
  expect(t.some(x => x === '✔ build')).toBe(true)
  expect(t.includes('this session')).toBe(true)
  expect(t.some(x => /working in this session/.test(x))).toBe(false)
})

test('an aborted main turn reads stopped before an answer', async ($, on) => {
  await boot($, on)
  await ($ as any).prompt.submit({ text: PROMPT })
  const out = await ($ as any).turn.complete(mainDone('aborted'))
  expect(out.text).toBe('the reply')
  const t = await texts($)
  expect(t.some(x => /stopped before an answer/.test(x))).toBe(true)
  expect(t.some(x => x === 'stopped')).toBe(true) // sign-off
  expect(t.some(x => x === '◆ build')).toBe(true)
  expect(t.some(x => /answered in this session/.test(x))).toBe(false)
})

test('a follow-up soon after a finished run keeps its diagram', async ($, on) => {
  await boot($, on)
  await $.agent.spawn(spawnImpl('t1', 's1'))
  await ($ as any).turn.complete({ turnId: 'a', agentId: 't1', answer: 'built\nSTATUS: pass', durationMs: 5, isAborted: false, reason: 'answer', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' } })
  expect((await texts($)).some(x => /◆ s1|✔ s1/.test(x))).toBe(true)
  // the clock steps one second per read: a prompt right after leaves the run alone
  await ($ as any).prompt.submit({ text: 'and now a follow-up' })
  expect((await texts($)).some(x => /s1/.test(x))).toBe(true)
})

test('a prompt over two minutes after the last agent ended starts a clean run', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  await boot($, on, { clock })
  await $.agent.spawn(spawnImpl('t1', 's1'))
  await ($ as any).turn.complete({ turnId: 'a', agentId: 't1', answer: 'built\nSTATUS: pass', durationMs: 5, isAborted: false, reason: 'answer', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' } })
  expect((await texts($)).some(x => /s1/.test(x))).toBe(true)
  await clock.advance(121_000)
  await ($ as any).prompt.submit({ text: 'something new' })
  const t = await texts($)
  expect(t.some(x => /s1/.test(x))).toBe(false)
  expect(t.includes('▸ something new')).toBe(true)
  expect(t.some(x => /1 agents|tasks/.test(x))).toBe(false)
})

test('with agents present the input box shows and the orchestrate run is unchanged', async ($, on) => {
  await boot($, on)
  await ($ as any).prompt.submit({ text: 'build the thing' })
  await $.agent.spawn(spawnImpl('t1', 's1'))
  await ($ as any).prompt.submit({ text: 'a follow-up while it runs' }) // keeps the first line
  let t = await texts($)
  expect(t.includes('▸ build the thing')).toBe(true)
  expect(t.some(x => /follow-up/.test(x))).toBe(false)
  expect(t.some(x => /dispatching\.* 1 running/.test(x))).toBe(true)
  expect(t.some(x => /triage · orchestrate/.test(x))).toBe(true)
  expect(t.includes('skipped')).toBe(false)
  expect(t.includes('this session')).toBe(false)
  await ($ as any).turn.complete({ turnId: 'a', agentId: 't1', answer: 'ok\nSTATUS: pass', durationMs: 5, isAborted: false, reason: 'answer', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' } })
  await ($ as any).turn.complete(mainDone('answer'))
  t = await texts($)
  expect(t.some(x => /all agents passed/.test(x))).toBe(true)
  expect(t.includes('skipped')).toBe(true) // merge, once signed off, as before
  expect(t.filter(x => x === 'skipped').length).toBe(1)
})

test('an orchestrate verdict with no agents yet shows every stage queued', async ($, on) => {
  await boot($, on, { route: { stdout: ROUTE_JSON } })
  await ($ as any).prompt.submit({ text: 'big job' })
  await ($ as any).tool.call({ tool: 'Bash', command: ROUTE_CMD })
  const t = await texts($)
  expect(t.some(x => /triage · orchestrate/.test(x))).toBe(true)
  expect(t.includes('skipped')).toBe(false)
  expect(t.includes('this session')).toBe(false)
  for (const stage of ['plan', 'plan review', 'build', 'review', 'merge']) expect(t.some(x => x === `◌ ${stage}`)).toBe(true)
})

test('the arrows join input, orchestrator, triage, stages and sign-off at every width, inside both boxes', async ($, on) => {
  await boot($, on)
  await ($ as any).prompt.submit({ text: PROMPT })
  await ($ as any).turn.complete(mainDone('answer'))
  for (const columns of [24, 32, 40, 52, 64, 80, 100, 140]) {
    const t = await texts($, columns)
    const art = t.filter(x => /^[\s─│┌┐└┘├┤┬┴┼●▶▼╵╷╶╴]+$/.test(x))
    expect(Math.max(...art.map(x => x.length))).toBeLessThanOrEqual(columns)
    const arrows = art.filter(x => x.trim() === '▼')
    expect(arrows.length).toBeGreaterThanOrEqual(4) // input, orchestrator, triage, last stage row -> sign-off (plus the return rails)
    expect(arrows.filter(x => x.indexOf('▼') === 1).length).toBe(4) // x=1 lies inside every box above and below (all are at least 6 wide)
    for (const w of ['sign off', 'triage', 'orchestrator', 'build']) expect(t.some(x => x.includes(w))).toBe(true)
  }
})

test('the redraw timer keeps running with no agent, once', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  await boot($, on, { clock })
  const head = async () => (await texts($)).find(x => /main · orchestrator/.test(x)) as string
  await ($ as any).prompt.submit({ text: PROMPT })
  expect(await head()).toBe('⠋ main · orchestrator')
  await clock.advance(1000) // four pulses although no agent ever ran
  expect(await head()).toBe('⠼ main · orchestrator')
  await ($ as any).prompt.submit({ text: 'again' }) // a second prompt must not start a second timer
  await clock.advance(1000)
  expect(await head()).toBe('⠇ main · orchestrator') // tick 8, not 12 (⠹)
  await ($ as any).turn.complete(mainDone('answer'))
  await clock.advance(1000)
  expect((await texts($)).some(x => /0 agents · 0 tokens · 0:02/.test(x))).toBe(true) // ended: the time stands still, counted from the first prompt
})

const done = (id: string) => ({ turnId: 'a', agentId: id, answer: 'built\nSTATUS: pass', durationMs: 5, isAborted: false, reason: 'answer', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' } }) as never

test('a first spawn long after the old run keeps the input box and the verdict the new prompt came with', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  await boot($, on, { clock, route: { stdout: ROUTE_JSON } })
  await $.agent.spawn(spawnImpl('t1', 's1'))
  await ($ as any).turn.complete(done('t1'))
  await clock.advance(60_000) // inside two minutes: the diagram stays and the prompt starts its work
  await ($ as any).prompt.submit({ text: 'the next big job' })
  await ($ as any).tool.call({ tool: 'Bash', command: ROUTE_CMD })
  await clock.advance(70_000) // now 3 minutes past the old run's last agent
  await $.agent.spawn(spawnImpl('t2', 's2'))
  const t = await texts($)
  expect(t.includes('▸ the next big job')).toBe(true)
  expect(t.some(x => /triage · orchestrate/.test(x))).toBe(true)
  expect(t.some(x => /s1/.test(x))).toBe(false) // the old agents are gone
  expect(t.some(x => /s2/.test(x))).toBe(true)
})

test('a second prompt while solo work runs keeps the verdict and the start time', async ($, on) => {
  const clock = mock.clock(on, { now: 500_000 })
  await boot($, on, { clock, route: { stdout: ROUTE_JSON } })
  await ($ as any).prompt.submit({ text: 'first line' })
  await ($ as any).tool.call({ tool: 'Bash', command: ROUTE_CMD })
  await clock.advance(30_000)
  await ($ as any).prompt.submit({ text: 'and one more thing' })
  const t = await texts($)
  expect(t.includes('▸ first line')).toBe(true)
  expect(t.some(x => /triage · orchestrate/.test(x))).toBe(true)
  expect(t.some(x => /0:3\d/.test(x))).toBe(true) // the clock was not restarted
})

const NAME = 'mcp__orchestration-dashboard__route'
const bootRoute = async ($: any, on: any) => {
  const registered: any[] = []
  on('tool.register', (_: unknown, e: any) => (registered.push(e), { value: { tool: NAME } }))
  await boot($, on)
  return registered
}
const VERDICT = { mode: 'orchestrate', reason: 'four independent slices', filesToTouch: 12, linesToChange: 340, independentSlices: 4, risky: true, code: true }

test('the route tool is registered undeferred and its call is shown in the pane', async ($, on) => {
  const registered = await bootRoute($, on)
  expect(registered.length).toBe(1)
  expect(registered[0].name).toBe('route')
  expect(registered[0].isDeferred).toBe(false)
  expect(registered[0].inputSchema.required).toEqual(['mode', 'reason'])
  const out = await ($ as any).tool.call({ tool: NAME, ...VERDICT })
  expect(out.result).toBe('route recorded: orchestrate')
  const t = await texts($)
  expect(t.some(x => /triage · orchestrate/.test(x))).toBe(true)
  expect(t.some(x => /four independent slices/.test(x))).toBe(true)
  expect(t.some(x => /files 12 · lines 340 · slices 4/.test(x))).toBe(true)
  expect(t.some(x => /risky yes · code yes/.test(x))).toBe(true)
})

test('route input that is not valid, or from a sub-agent, is ignored with a result', async ($, on) => {
  await bootRoute($, on)
  const call = ($ as any).tool.call
  for (const bad of [{ mode: 'nonsense', reason: 'x' }, { mode: 'plain' }, { mode: 'plain', reason: 5 }, { input: 'junk' }]) {
    const out = await call({ tool: NAME, ...bad })
    expect(out.deny).toBeUndefined()
    expect(String(out.result)).toMatch(/^ignored: /)
  }
  const sub = await call({ tool: NAME, agentId: 'a1', ...VERDICT })
  expect(sub.result).toBe('ignored: only the main session records a route')
  expect((await texts($)).some(x => /triage/.test(x))).toBe(false)
})
