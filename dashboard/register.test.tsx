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
const texts = async ($: any, columns = 100, bodyRows = 20) => {
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: columns, scroll: { offset: 0, bodyRows } } })
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

test('a new prompt right after a finished run starts a clean run (new input is new work)', async ($, on) => {
  await boot($, on)
  await $.agent.spawn(spawnImpl('t1', 's1'))
  await ($ as any).turn.complete({ turnId: 'a', agentId: 't1', answer: 'built\nSTATUS: pass', durationMs: 5, isAborted: false, reason: 'answer', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' } })
  expect((await texts($)).some(x => /◆ s1|✔ s1/.test(x))).toBe(true)
  // the clock steps one second per read: well inside two minutes, yet nothing runs, so the new input starts a new run
  await ($ as any).prompt.submit({ text: 'and now something else' })
  const t = await texts($)
  expect(t.some(x => /s1/.test(x))).toBe(false)
  expect(t.includes('▸ and now something else')).toBe(true)
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
    // x=1 lies inside every box above and below (all are at least 6 wide): input, orchestrator and last stage row -> sign-off stay at x 1;
    // triage -> stages is now the fork and the link, whose arrowheads sit at the route centre and the stage (only the stacked fork's ' ▼' is at x 1)
    expect(arrows.filter(x => x.indexOf('▼') === 1).length).toBeGreaterThanOrEqual(3)
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

// The triage fork: three route boxes, the chosen one marked and joined by a link to the first stage it uses.
const ROUTES = ['plain', 'reviewed', 'orchestrate'] as const
const ART = /^[\s─│┌┐└┘├┤┬┴┼●▶▼╵╷╶╴]+$/
// The same layout as the pane, worked out again here from the widths alone.
const tElbow = (a: number, b: number) => (a === b ? `${' '.repeat(a)}│` : b > a ? `${' '.repeat(a)}└${'─'.repeat(b - a - 1)}┐` : `${' '.repeat(b)}┌${'─'.repeat(a - b - 1)}┘`)
const geom = (width: number, mode: (typeof ROUTES)[number]) => {
  const boxW = Math.min(width - 1, 46)
  const side = width >= 44
  const rw = Math.floor((boxW - 4) / 3)
  const rx = [0, 1, 2].map(i => i * (rw + 2))
  const rc = rx.map(x => x + Math.floor(rw / 2))
  const cols = width >= 100 ? 6 : width >= 40 ? 3 : 2
  const pw = Math.max(6, Math.floor((width - 3 * (cols - 1) - 1) / cols))
  const rowW = cols * pw + 3 * (cols - 1)
  const first = Math.floor(pw / 2)
  const lastX = (cols - 1) * (pw + 3) + first
  const k = ROUTES.indexOf(mode)
  const sx = side ? (rc[k] as number) : 1
  const entry = width < 16 ? 0 : mode === 'orchestrate' ? 1 : 3
  const left = (entry % cols) * (pw + 3)
  const lane = Math.floor(entry / cols) >= 1
  const ex = left + pw - 2
  const tx = lane ? rowW : Math.min(left + first, width - 1)
  const link = [`${' '.repeat(sx)}│`, tElbow(sx, tx), `${' '.repeat(tx)}${lane ? '│' : '▼'}`]
  const gap = ' '.repeat(rowW - lastX - 1)
  const pad = ' '.repeat(ex - first - 1)
  const rail = [`${' '.repeat(lastX)}│`, `${' '.repeat(first)}┌${'─'.repeat(lastX - first - 1)}┘`, `${' '.repeat(first)}│`, `${' '.repeat(first)}▼`]
  const beside = [`${gap}│`, `${gap}│`, `${pad}┌${'─'.repeat(rowW - ex - 1)}┘`, `${pad}▼`]
  return { boxW, side, rw, rx, rc, cols, pw, rowW, first, lastX, k, sx, left, lane, ex, tx, link, rail, beside }
}
const failed = (id: string) => ({ turnId: 'a', agentId: id, answer: 'broke\nSTATUS: fail', durationMs: 5, isAborted: false, reason: 'answer', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' } }) as never
const verdict = (mode: string) => ({ stdout: JSON.stringify({ mode, reason: `${mode} chosen`, facts: { filesToTouch: 2, linesToChange: 40, independentSlices: 1, risky: true, code: true } }) })
const REVIEWER = 'orchestration:reviewer'

type Scene = { name: string; mode: (typeof ROUTES)[number]; word: string; flow: boolean; build: ($: any, on: any) => Promise<void> }
const recorded = async ($: any, on: any, mode: string, solo?: boolean) => {
  await boot($, on, { route: verdict(mode) })
  if (solo) return
  await $.prompt.submit({ text: PROMPT })
  await $.tool.call({ tool: 'Bash', command: ROUTE_CMD })
}
const SCENES: Scene[] = [
  { name: 'plain answered, inferred', mode: 'plain', word: 'passed', flow: false, build: async ($, on) => { await boot($, on); await $.prompt.submit({ text: PROMPT }); await $.turn.complete(mainDone('answer')) } },
  { name: 'plain stopped, inferred', mode: 'plain', word: 'stopped', flow: false, build: async ($, on) => { await boot($, on); await $.prompt.submit({ text: PROMPT }); await $.turn.complete(mainDone('aborted')) } },
  { name: 'plain chosen, nothing run yet', mode: 'plain', word: 'chosen', flow: false, build: async ($, on) => { await recorded($, on, 'plain', true); await $.tool.call({ tool: 'Bash', command: ROUTE_CMD }) } },
  { name: 'reviewed recorded, finished', mode: 'reviewed', word: 'passed', flow: false, build: async ($, on) => { await recorded($, on, 'reviewed'); await $.agent.spawn(spawnImpl('r1', 's1', REVIEWER)); await $.turn.complete(done('r1')); await $.turn.complete(mainDone('answer')) } },
  { name: 'reviewed recorded, running', mode: 'reviewed', word: 'running', flow: true, build: async ($, on) => { await recorded($, on, 'reviewed'); await $.agent.spawn(spawnImpl('r1', 's1', REVIEWER)) } },
  { name: 'orchestrate recorded, running', mode: 'orchestrate', word: 'running', flow: true, build: async ($, on) => { await recorded($, on, 'orchestrate'); await $.agent.spawn(spawnImpl('t1', 's1')) } },
  { name: 'orchestrate recorded, failed', mode: 'orchestrate', word: 'failed', flow: false, build: async ($, on) => { await recorded($, on, 'orchestrate'); await $.agent.spawn(spawnImpl('t1', 's1')); await $.turn.complete(failed('t1')); await $.turn.complete(mainDone('answer')) } },
  { name: 'orchestrate inferred, finished', mode: 'orchestrate', word: 'passed', flow: false, build: async ($, on) => { await boot($, on); await $.agent.spawn(spawnImpl('t1', 's1')); await $.turn.complete(done('t1')) } },
]
const WIDTHS = [24, 32, 36, 40, 43, 44, 47, 52, 60, 64, 80, 99, 100, 140]

for (const sc of SCENES) {
  test(`triage fork: ${sc.name}`, async ($, on) => {
    await sc.build($, on)
    const others = ROUTES.filter(r => r !== sc.mode)
    for (const columns of WIDTHS) {
      const t = await texts($, columns)
      const g = geom(columns, sc.mode)
      // the chosen route carries the marker and the status word; the others do not
      const marked = t.filter(x => x.startsWith('◉ '))
      expect(marked.length).toBe(1)
      expect(marked[0]!.endsWith(` ${sc.word}`)).toBe(true)
      expect(t.includes(sc.mode)).toBe(true)
      // the running dot is only on the link while work runs: the fork rows and the route boxes carry none
      expect(t.some(x => /^[◉○] .*●/.test(x))).toBe(false)
      if (g.side) {
        expect(t.filter(x => x === '○ not taken').length).toBe(2)
        for (const o of others) expect(t.includes(o)).toBe(true)
        // the fork: a line down, across to the chosen route's centre, and an arrowhead onto it
        for (const row of [' │', tElbow(1, g.rc[g.k] as number), `${' '.repeat(g.rc[g.k] as number)}▼`]) expect(t.includes(row)).toBe(true)
        expect(g.sx).toBeGreaterThanOrEqual((g.rx[g.k] as number) + 1) // the link leaves from inside the chosen box
        expect(g.sx).toBeLessThanOrEqual((g.rx[g.k] as number) + g.rw - 2)
      } else {
        for (const o of others) expect(t.includes(`○ ${o}`)).toBe(true)
        expect(t.includes(`○ ${sc.mode}`)).toBe(false)
        expect(t.filter(x => x === ' │ ').length).toBeGreaterThanOrEqual(2) // the slice diagram's trunk can add more
        expect(t.includes(' ▼')).toBe(true)
        expect(g.sx).toBe(1)
      }
      // the link: exact rows when nothing moves along it
      if (!sc.flow) for (const row of g.link) expect(t.includes(row)).toBe(true)
      if (!g.lane) {
        // direct: the arrowhead lies inside the first stage's box
        expect(g.tx).toBeGreaterThanOrEqual(g.left + 1)
        expect(g.tx).toBeLessThanOrEqual(g.left + g.pw - 2)
      } else {
        // the lane: the rail beside it, row by row, and the lane's own column
        for (let i = 0; i < 4; i++) {
          expect(t.includes(g.rail[i] as string)).toBe(true)
          expect(t.includes(g.beside[i] as string)).toBe(true)
          expect((g.rail[i] as string).length + (g.beside[i] as string).length).toBeLessThanOrEqual(columns)
        }
        expect(t.filter(x => x === '│').length).toBeGreaterThanOrEqual(5)
        expect(g.ex).toBeGreaterThanOrEqual(g.left + 1)
        expect(g.ex).toBeLessThanOrEqual(g.left + g.pw - 2)
      }
      if (sc.mode === 'orchestrate' || columns >= 100) {
        // no lane: orchestrate enters plan in the first row, and one row holds all six stages from 100 columns
        const asPlain = geom(columns, 'plain')
        if (asPlain.lane || columns < 100) expect(t.includes(asPlain.beside[2] as string)).toBe(false)
      }
      for (const stage of ['triage', 'plan', 'plan review', 'build', 'review', 'merge']) expect(t.some(x => x.endsWith(` ${stage}`) && /^[●✔✖◆◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(x))).toBe(true)
      const art = t.filter(x => ART.test(x))
      expect(Math.max(...art.map(x => x.length))).toBeLessThanOrEqual(columns)
    }
  })
}

test('triage fork: sizing draws all three routes dim, with no marker and no link', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: PROMPT })
  for (const columns of [24, 36, 43, 44, 60, 100, 140]) {
    const t = await texts($, columns)
    const g = geom(columns, 'plain')
    expect(t.some(x => x.includes('◉'))).toBe(false)
    expect(t.some(x => /triage · sizing/.test(x))).toBe(true)
    if (g.side) {
      expect(t.filter(x => x === '○ …').length).toBe(3)
      for (const r of ROUTES) expect(t.includes(r)).toBe(true)
      const [a, b, c] = g.rc as [number, number, number]
      expect(t.includes(`${' '.repeat(a)}▼${' '.repeat(b - a - 1)}▼${' '.repeat(c - b - 1)}▼`)).toBe(true)
      expect(t.includes(`└${'─'.repeat(a - 2)}┬${'─'.repeat(b - a - 1)}┬${'─'.repeat(c - b - 1)}┐`.padStart(c + 1))).toBe(true)
    } else {
      for (const r of ROUTES) expect(t.includes(`○ ${r}`)).toBe(true)
      expect(t.filter(x => x === ' ├ ').length).toBe(2)
      expect(t.filter(x => x === ' └ ').length).toBe(1)
    }
    // no link: nothing from a route to a stage (the first link row, a bare line down, also reads like the plain connectors)
    for (const row of geom(columns, 'orchestrate').link.slice(1)) expect(t.includes(row)).toBe(false)
  }
})

test('triage fork: every width from 16 to 200 stays inside the pane and the link lands inside its stage', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: PROMPT })
  await $.turn.complete(mainDone('answer'))
  for (let columns = 16; columns <= 200; columns++) {
    for (const m of ROUTES) {
      const g = geom(columns, m)
      expect(g.rowW).toBeLessThanOrEqual(columns - 1)
      expect(g.tx).toBeLessThanOrEqual(columns - 1)
      if (!g.lane) {
        expect(g.tx).toBeGreaterThanOrEqual(g.left + 1)
        expect(g.tx).toBeLessThanOrEqual(g.left + g.pw - 2)
      } else {
        expect(g.first).toBeLessThan(g.ex)
        expect(g.ex).toBeLessThan(g.rowW)
        expect(g.lastX).toBeLessThan(g.rowW)
        expect(g.sx).toBeLessThan(g.rowW)
        expect(g.ex).toBeGreaterThanOrEqual(g.left + 1)
      }
    }
    const t = await texts($, columns)
    const art = t.filter(x => ART.test(x))
    expect(Math.max(...art.map(x => x.length))).toBeLessThanOrEqual(columns)
    const g = geom(columns, 'plain')
    for (const row of g.link) expect(t.includes(row)).toBe(true)
  }
})

test('triage fork: under 16 columns there is no lane and the link goes straight to the first stage', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: PROMPT })
  await $.turn.complete(mainDone('answer'))
  for (const columns of [8, 10, 12, 15]) {
    const t = await texts($, columns)
    const g = geom(columns, 'plain')
    expect(g.lane).toBe(false)
    for (const row of g.link) expect(row.length).toBeLessThanOrEqual(columns)
    for (const row of g.link) expect(t.includes(row)).toBe(true)
    expect(t.includes(`${' '.repeat(g.tx)}▼`)).toBe(true)
    expect(t.includes(g.beside[2] as string)).toBe(false) // no lane segment
  }
  // the same for orchestrate, which enters plan (stage 1) everywhere else
  await $.agent.spawn(spawnImpl('t1', 's1'))
  await $.turn.complete(done('t1'))
  const g = geom(12, 'orchestrate')
  const t = await texts($, 12)
  expect(g.tx).toBe(3)
  for (const row of g.link) expect(t.includes(row)).toBe(true)
})

test('triage fork: the dot runs along the link while work runs and stops when it is signed off', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  await boot($, on, { clock, route: verdict('orchestrate') })
  await $.prompt.submit({ text: PROMPT })
  await $.tool.call({ tool: 'Bash', command: ROUTE_CMD })
  await $.agent.spawn(spawnImpl('t1', 's1'))
  const g = geom(100, 'orchestrate')
  // the cells the dot visits, in travel order: down from the box, along the elbow, onto the stage
  const path: [number, number][] = [[0, g.sx]]
  for (let x = g.sx; x !== g.tx - 1; x--) path.push([1, x])
  path.push([2, g.tx])
  const step = Math.max(1, Math.ceil(path.length / 12))
  expect(path.length).toBe(g.sx - g.tx + 3)
  const seen = new Set<string>()
  for (let f = 0; f < 4; f++) {
    const t = await texts($, 100)
    expect(t.find(x => /orchestrator$/.test(x))!.startsWith(['⠋', '⠙', '⠹', '⠸'][f] as string)).toBe(true) // which tick this is
    const [r, x] = path[(f * step) % path.length] as [number, number]
    const expected = g.link.map((row, i) => (i === r ? `${row.slice(0, x)}●${row.slice(x + 1)}` : row))
    for (const row of expected) expect(t.includes(row)).toBe(true)
    seen.add(`${r},${x}`)
    await clock.advance(250)
  }
  expect(seen.size).toBe(4) // it moved every tick
  await $.turn.complete(done('t1'))
  await $.turn.complete(mainDone('answer'))
  const t = await texts($, 100)
  for (const row of g.link) expect(t.includes(row)).toBe(true) // the plain link, no dot
  expect(t.some(x => ART.test(x) && x.includes('●') && x.length > 3)).toBe(false)
})

test('the scroll hint counts the fork, the route boxes, the link and the lane', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: PROMPT })
  const hint = async (columns: number, bodyRows: number) => (await texts($, columns, bodyRows)).some(x => /scroll/.test(x))
  // sizing at 100: 26 + 5 (orchestrator box) + 4 (input box) + 5 (one stage row) = 40, plus the 3 fork rows and 4 route rows, less the old 2-row arrow = 45
  expect(await hint(100, 44)).toBe(true)
  expect(await hint(100, 45)).toBe(false)
  expect(await hint(100, 50)).toBe(false)
  await $.turn.complete(mainDone('answer'))
  // plain at 100: 40 + 3 + 4 + 3 link rows - 2 = 48
  expect(await hint(100, 47)).toBe(true)
  expect(await hint(100, 48)).toBe(false)
  // at 60 the stages wrap (two rows of 5 and a 3-row rail = 13) and the lane adds a rail row: 26 + 5 + 4 + 13 + 3 + 4 + 3 - 2 + 1 = 57
  expect(await hint(60, 56)).toBe(true)
  expect(await hint(60, 57)).toBe(false)
  // stacked at 36: three stage rows (15 + 6 = 21), the fork is 2 rows, the arrow, the 4-row chosen box, the link 3 and the lane 1: 26 + 5 + 4 + 21 + 7 + 3 - 2 + 1 = 65
  expect(await hint(36, 64)).toBe(true)
  expect(await hint(36, 65)).toBe(false)
})

const finish = ($: any, agentId: string, answer: string) =>
  $.turn.complete({ turnId: agentId, agentId, answer, durationMs: 5, isAborted: false, reason: 'answer', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'x' } })
const spawnWith = ($: any, id: string, prompt: string, type: string) =>
  $.agent.spawn({ tool_use_id: id, prompt, description: id, subagentType: type, provider: { plugin: 'orchestration', tier: 'user' }, parentModel: 'opus' } as never)

test('a plan review is the plan review stage even when its brief has a SLICE line', async ($, on) => {
  await boot($, on)
  await spawnWith($, 'p1', 'PLAN REVIEW\nSLICE: plan\nFOCUS: gaps', 'orchestration:reviewer')
  await finish($, 'p1', 'STATUS: pass\nGAPS: none')
  await spawnWith($, 'b1', 'SLICE: s1\nFILES: a.py\nDEPENDS: none', 'orchestration:implementer')
  const t = await texts($)
  expect(t.includes('✔ plan review')).toBe(true) // the stage counts it
  expect(t.some(x => /^\S plan {2,}\d/.test(x))).toBe(false) // not a slice card called "plan"
  expect(t.some(x => /^✔ plan review\s+[▰▱]*\s*\S+\s+\d:\d\d$/.test(x) || /^✔ plan review /.test(x))).toBe(true) // a row of its own in the tasks table
})

test('a bold GAPS heading is skipped so the finding under it is the result', async ($, on) => {
  await boot($, on)
  await spawnWith($, 'b1', 'SLICE: s1\nFILES: a.py\nDEPENDS: none', 'orchestration:implementer')
  await finish($, 'b1', 'built\nSTATUS: pass')
  await spawnWith($, 'r1', 'SLICE: s1', 'orchestration:reviewer')
  await finish($, 'r1', '**STATUS: fail**\n\n**GAPS:**\n- the limit is off by one\n')
  const t = await texts($)
  expect(t.some(x => /↳ the limit is off by one/.test(x))).toBe(true)
  expect(t.some(x => /↳ GAPS/.test(x))).toBe(false)
  // a line that merely ends in `_` or `*` is not damaged
  await spawnWith($, 'b2', 'SLICE: s2\nFILES: b.py\nDEPENDS: none', 'orchestration:implementer')
  await finish($, 'b2', 'wrote src/__init__\nSTATUS: pass')
  expect((await texts($)).some(x => /↳ wrote src\/__init__$/.test(x))).toBe(true)
})

test('a brief that only mentions PLAN REVIEW on a later line is still a slice', async ($, on) => {
  await boot($, on)
  await spawnWith($, 'b1', 'SLICE: s1\nFOCUS: x\nPLAN REVIEW passed earlier; check the code', 'orchestration:reviewer')
  const t = await texts($)
  expect(t.some(x => /^\S s1 /.test(x))).toBe(true) // its slice card stays
  expect(t.includes('● plan review') || t.some(x => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] plan review$/.test(x))).toBe(false) // and the plan review stage is not running
})

test('a dependency never launched shows as a queued card only while the run is going', async ($, on) => {
  await boot($, on)
  await spawnWith($, 'b2', 'SLICE: s2\nFILES: b.py\nDEPENDS: s9', 'orchestration:implementer')
  expect((await texts($)).some(x => /◌ s9/.test(x))).toBe(true)
  await finish($, 'b2', 'built\nSTATUS: pass')
  const t = await texts($)
  expect(t.some(x => /s2/.test(x))).toBe(true)
  expect(t.some(x => /◌ s9/.test(x))).toBe(false) // signed off: no ghost for work from an earlier run
  expect(t.some(x => /◀ s9/.test(x))).toBe(true) // the dependency is still named on the card
})

test('a prompt that is a background notification or a peer message is not new work', async ($, on) => {
  const { opened } = await boot($, on)
  for (const kind of ['task-notification', 'peer', 'scheduled-trigger']) {
    await ($ as any).prompt.submit({ text: 'Another Claude session sent a message', origin: { kind } })
  }
  expect(opened.length).toBe(0)
  expect((await texts($)).some(x => /▸ Another Claude/.test(x))).toBe(false)
})

// Between two waves (plan review done, writers not launched yet) the main turn still works: the run is not signed off.
const wave = async ($: any, on: any, opts: { clock?: any } = {}) => {
  await boot($, on, opts)
  await $.prompt.submit({ text: PROMPT })
  await spawnWith($, 'b1', 'SLICE: s1\nFILES: a.py\nDEPENDS: s9', 'orchestration:implementer') // s9 is a queued ghost
  await finish($, 'b1', 'built\nSTATUS: pass')
}

test('between two waves the orchestrator reads dispatching, the sign-off waits and merge is not skipped', async ($, on) => {
  await wave($, on)
  const t = await texts($)
  expect(t.some(x => /dispatching\.+ 0 running/.test(x))).toBe(true)
  expect(t.some(x => /waiting for agents/.test(x))).toBe(true)
  expect(t.some(x => /all agents passed|1 passed/.test(x))).toBe(false)
  expect(t.includes('skipped')).toBe(false)
  expect(t.some(x => /◌ s9/.test(x))).toBe(true) // the queued card stays
})

test('after the main turn completes the run is signed off: merge skipped, passed counted', async ($, on) => {
  await wave($, on)
  await $.turn.complete(mainDone('answer'))
  const t = await texts($)
  expect(t.some(x => /all agents passed/.test(x))).toBe(true)
  expect(t.some(x => /1 passed · 0 failed/.test(x))).toBe(true)
  expect(t.includes('skipped')).toBe(true)
  expect(t.some(x => /dispatching/.test(x))).toBe(false)
})

test('agents with no typed prompt still sign off when nothing runs', async ($, on) => {
  await boot($, on)
  await spawnWith($, 'b1', 'SLICE: s1\nFILES: a.py\nDEPENDS: none', 'orchestration:implementer')
  await finish($, 'b1', 'built\nSTATUS: pass')
  const t = await texts($)
  expect(t.some(x => /all agents passed/.test(x))).toBe(true)
  expect(t.some(x => /1 passed · 0 failed/.test(x))).toBe(true)
})

test('a spawn over two minutes after the last agent, while the main turn is open, keeps the run', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  await wave($, on, { clock })
  await clock.advance(130_000)
  await spawnWith($, 'b2', 'SLICE: s2\nFILES: b.py\nDEPENDS: none', 'orchestration:implementer')
  await finish($, 'b2', 'built\nSTATUS: pass')
  const t = await texts($)
  expect(t.some(x => /s1/.test(x))).toBe(true) // the first wave is still there
  expect(t.some(x => /s2/.test(x))).toBe(true)
  expect(t.includes(`▸ ${PROMPT.split('\n')[0]}`)).toBe(true) // work survives
  expect(t.some(x => /dispatching\.+ 0 running/.test(x))).toBe(true)
})

test('stale work (no turn.complete, last agent over ten minutes ago) is signed off and a prompt starts clean', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  await wave($, on, { clock })
  await clock.advance(300_000) // five minutes: still open
  expect((await texts($)).some(x => /dispatching/.test(x))).toBe(true)
  await clock.advance(400_000) // over ten minutes
  let t = await texts($)
  expect(t.some(x => /all agents passed/.test(x))).toBe(true)
  expect(t.some(x => /dispatching/.test(x))).toBe(false)
  await $.prompt.submit({ text: 'a fresh job' })
  t = await texts($)
  expect(t.some(x => /s1/.test(x))).toBe(false)
  expect(t.includes('▸ a fresh job')).toBe(true)
})

const mountLive = ($: any) => $.ui.mount({ ...PANE, surface: 'terminal' })
const liveTexts = async (ui: any) => (await ui.findAll({ type: 'Text' })).map((x: any) => x.text ?? '') as string[]

test('stale work: the timer draws a last redraw when it stops, so the open pane shows signed off with no other event', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  await wave($, on, { clock })
  const ui = await mountLive($)
  expect((await liveTexts(ui)).some(x => /dispatching/.test(x))).toBe(true)
  for (let i = 0; i < 59; i++) await clock.advance(10_000) // 590 s of 250 ms pulses: still open
  expect((await liveTexts(ui)).some(x => /dispatching/.test(x))).toBe(true)
  for (let i = 0; i < 12; i++) await clock.advance(1000) // the pulse that finds it stale draws once more
  const t = await liveTexts(ui)
  expect(t.some(x => /dispatching|waiting for agents/.test(x))).toBe(false)
  expect(t.includes('skipped')).toBe(true)
  expect(t.some(x => /1 passed · 0 failed/.test(x))).toBe(true)
  const head = t.find(x => /main · orchestrator/.test(x))
  await clock.advance(2000) // and the timer is gone: nothing redraws any more
  expect((await liveTexts(ui)).find(x => /main · orchestrator/.test(x))).toBe(head)
  await ui.unmount()
})

test('the timer ticks while work is open with no agents and stops, after a last redraw, at the main turn.complete', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  await boot($, on, { clock })
  const ui = await mountLive($)
  const head = async () => (await liveTexts(ui)).find(x => /main · orchestrator/.test(x)) as string
  await ($ as any).prompt.submit({ text: PROMPT })
  const a = await head()
  await clock.advance(250)
  const b = await head()
  await clock.advance(250)
  expect(new Set([a, b, await head()]).size).toBe(3) // the spinner glyph advances every pulse
  await ($ as any).turn.complete(mainDone('answer'))
  await clock.advance(250) // the pulse that stops draws the ended state
  const ended = await head()
  expect(/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/.test(ended)).toBe(false)
  await clock.advance(1000)
  expect(await head()).toBe(ended)
  await ui.unmount()
})

test('known tradeoff: a main turn busy over ten minutes after the last agent counts as stale; a following spawn starts a clean run', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  await wave($, on, { clock })
  await clock.advance(700_000) // a long build, no turn.complete yet
  let t = await texts($)
  expect(t.some(x => /all agents passed/.test(x))).toBe(true)
  expect(t.some(x => /dispatching/.test(x))).toBe(false)
  await spawnWith($, 'b2', 'SLICE: s2\nFILES: b.py\nDEPENDS: none', 'orchestration:implementer')
  t = await texts($)
  expect(t.some(x => /s1/.test(x))).toBe(false) // the old run is dropped
  expect(t.some(x => /s2/.test(x))).toBe(true)
})

test('with a recorded verdict, a spawn over two minutes after the last agent while the main turn is open keeps agents and work', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  await boot($, on, { clock, route: verdict('orchestrate') })
  await $.prompt.submit({ text: PROMPT })
  await $.tool.call({ tool: 'Bash', command: ROUTE_CMD })
  await spawnWith($, 'b1', 'SLICE: s1\nFILES: a.py\nDEPENDS: none', 'orchestration:implementer')
  await finish($, 'b1', 'built\nSTATUS: pass')
  await clock.advance(130_000)
  await spawnWith($, 'b2', 'SLICE: s2\nFILES: b.py\nDEPENDS: none', 'orchestration:implementer')
  const t = await texts($)
  expect(t.some(x => /s1/.test(x)) && t.some(x => /s2/.test(x)) && t.includes(`▸ ${PROMPT.split('\n')[0]}`) && t.some(x => /triage · orchestrate/.test(x))).toBe(true)
})
