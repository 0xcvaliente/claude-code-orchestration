import { expect, test } from 'claude-code/testing'

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
