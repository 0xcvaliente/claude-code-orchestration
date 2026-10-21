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
