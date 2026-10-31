import { expect, mock, test } from 'claude-code/testing'

// Written by scripts/test-dashboard.mjs from src/fixtures/briefs (the harness lets a test import only its plugin's own code files: no node:fs, no .json).
import fixtures from '../fixtures/briefs/fixtures'
import { parseHeader, parsePlan, parseReply, parseStatus } from './register'

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
  // stage cells, one glyph each: build = s1 passed, s2 running, s9 (a ghost) queued; no reviewer started, so no review box is drawn
  const cells = (await ui.findAll({ type: 'Text' })).map(x => x.text ?? '').join('|')
  expect(/\|✔\|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\|◌\|/.test(cells)).toBe(true)
  expect((await ui.findAll({ type: 'Text' })).some(x => /^[●✔✖◆◌] review$/.test(x.text ?? ''))).toBe(false)
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

test('with no verdict the pane infers the mode and draws only the stages it used (triage, build, review) at every width', async ($, on) => {
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
    for (const stage of ['triage', 'build', 'review']) expect(t.some(x => x.endsWith(` ${stage}`) && /^[●✔✖◆◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(x))).toBe(true)
    for (const stage of ['plan', 'plan review', 'merge']) expect(t.some(x => x.endsWith(` ${stage}`) && /^[●✔✖◆◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(x))).toBe(false)
    expect(t.includes('skipped')).toBe(false)
    const art = t.filter(x => /^[\s─│┌┐└┘├┤┬┴┼●▶▼╵╷╶╴]+$/.test(x))
    expect(art.length).toBeGreaterThan(0)
    expect(Math.max(...art.map(x => x.length))).toBeLessThanOrEqual(columns)
    if (columns < 40) expect(art.some(x => x.includes('▼') && x.trim() === '▼')).toBe(true) // the return rail between rows
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

  // while an agent runs the plan stage is already done (the orchestrator planned); merge is not drawn until an integrator starts
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
  expect(t.some(x => /^[●✔✖◆◌] merge$/.test(x))).toBe(false) // no integrator ran: no merge box, and no "skipped" word
  expect(t.includes('skipped')).toBe(false)

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
const boot = async ($: any, on: any, opts: { clock?: any; route?: unknown; model?: (id: string) => string } = {}) => {
  const seen: any[] = []
  const opened: any[] = []
  on('command.register', () => ({ value: { command: 'orchestration' } }))
  on('ui.open', (_: unknown, e: any) => (opened.push(e), { value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('prompt.submit', (_: unknown, e: any) => (seen.push(e), { text: e.text }))
  on('agent.spawn', (_: unknown, e: any) => ({ model: opts.model?.(e.tool_use_id) ?? 'sonnet', agentId: e.tool_use_id }))
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

test('work with no agents reads answered once the main turn ends: plain, only triage and the build drawn, this session', async ($, on) => {
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
  expect(t.includes('skipped')).toBe(false)
  for (const stage of ['plan', 'plan review', 'review', 'merge']) expect(t.some(x => x.endsWith(` ${stage}`) && /^[●✔✖◆◌] /.test(x))).toBe(false) // the stages plain does not use are never drawn
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
  expect(t.includes('skipped')).toBe(false) // no integrator ran: merge is not drawn at all
  expect(t.some(x => /^[●✔✖◆◌] merge$/.test(x))).toBe(false)
})

test('an orchestrate verdict with no agents yet draws only triage and the dim plan box as next', async ($, on) => {
  await boot($, on, { route: { stdout: ROUTE_JSON } })
  await ($ as any).prompt.submit({ text: 'big job' })
  await ($ as any).tool.call({ tool: 'Bash', command: ROUTE_CMD })
  const t = await texts($)
  expect(t.some(x => /triage · orchestrate/.test(x))).toBe(true)
  expect(t.includes('skipped')).toBe(false)
  expect(t.includes('this session')).toBe(false)
  expect(t.includes('◌ plan')).toBe(true)
  expect(t.includes('next')).toBe(true) // the entry stage waits, dim
  for (const stage of ['plan review', 'build', 'review', 'merge']) expect(t.some(x => x.endsWith(` ${stage}`) && /^[●✔✖◆◌] /.test(x))).toBe(false)
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
const geom = (width: number, mode: (typeof ROUTES)[number], entryAt = 1) => {
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
  const entry = width < 16 ? 0 : entryAt // the entry stage's place among the drawn boxes: right after triage unless an earlier stage is drawn
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

type Scene = { name: string; mode: (typeof ROUTES)[number]; word: string; flow: boolean; drawn: string[]; build: ($: any, on: any) => Promise<void> }
const recorded = async ($: any, on: any, mode: string, solo?: boolean) => {
  await boot($, on, { route: verdict(mode) })
  if (solo) return
  await $.prompt.submit({ text: PROMPT })
  await $.tool.call({ tool: 'Bash', command: ROUTE_CMD })
}
const SCENES: Scene[] = [
  { name: 'plain answered, inferred', drawn: ['triage','build'], mode: 'plain', word: 'passed', flow: false, build: async ($, on) => { await boot($, on); await $.prompt.submit({ text: PROMPT }); await $.turn.complete(mainDone('answer')) } },
  { name: 'plain stopped, inferred', drawn: ['triage','build'], mode: 'plain', word: 'stopped', flow: false, build: async ($, on) => { await boot($, on); await $.prompt.submit({ text: PROMPT }); await $.turn.complete(mainDone('aborted')) } },
  { name: 'plain chosen, nothing run yet', drawn: ['triage','build'], mode: 'plain', word: 'chosen', flow: false, build: async ($, on) => { await recorded($, on, 'plain', true); await $.tool.call({ tool: 'Bash', command: ROUTE_CMD }) } },
  { name: 'reviewed recorded, finished', drawn: ['triage','build','review'], mode: 'reviewed', word: 'passed', flow: false, build: async ($, on) => { await recorded($, on, 'reviewed'); await $.agent.spawn(spawnImpl('r1', 's1', REVIEWER)); await $.turn.complete(done('r1')); await $.turn.complete(mainDone('answer')) } },
  { name: 'reviewed recorded, running', drawn: ['triage','build','review'], mode: 'reviewed', word: 'running', flow: true, build: async ($, on) => { await recorded($, on, 'reviewed'); await $.agent.spawn(spawnImpl('r1', 's1', REVIEWER)) } },
  { name: 'orchestrate recorded, running', drawn: ['triage','plan','build'], mode: 'orchestrate', word: 'running', flow: true, build: async ($, on) => { await recorded($, on, 'orchestrate'); await $.agent.spawn(spawnImpl('t1', 's1')) } },
  { name: 'orchestrate recorded, failed', drawn: ['triage','plan','build'], mode: 'orchestrate', word: 'failed', flow: false, build: async ($, on) => { await recorded($, on, 'orchestrate'); await $.agent.spawn(spawnImpl('t1', 's1')); await $.turn.complete(failed('t1')); await $.turn.complete(mainDone('answer')) } },
  { name: 'orchestrate inferred, finished', drawn: ['triage','plan','build'], mode: 'orchestrate', word: 'passed', flow: false, build: async ($, on) => { await boot($, on); await $.agent.spawn(spawnImpl('t1', 's1')); await $.turn.complete(done('t1')) } },
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
      // no lane: the entry stage is the second drawn box, in the first row
      const lanePlain = geom(columns, 'plain', 3)
      if (lanePlain.lane) expect(t.includes(lanePlain.beside[2] as string)).toBe(false)
      for (const stage of ['triage', 'plan', 'plan review', 'build', 'review', 'merge'])
        expect(t.some(x => x.endsWith(` ${stage}`) && /^[●✔✖◆◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(x))).toBe(sc.drawn.includes(stage)) // a box only for a stage that was used
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
  // only triage and the build are drawn, so one stage row at every width (no wrap, no lane): at 60 the count is the same, 48
  expect(await hint(60, 47)).toBe(true)
  expect(await hint(60, 48)).toBe(false)
  // stacked at 36: the fork is 2 rows, the arrow, the 4-row chosen box (7), the link 3: 26 + 5 + 4 + 5 + 7 + 3 - 2 = 48
  expect(await hint(36, 47)).toBe(true)
  expect(await hint(36, 48)).toBe(false)
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

test('after the main turn completes the run is signed off: no merge box, passed counted', async ($, on) => {
  await wave($, on)
  await $.turn.complete(mainDone('answer'))
  const t = await texts($)
  expect(t.some(x => /all agents passed/.test(x))).toBe(true)
  expect(t.some(x => /1 passed · 0 failed/.test(x))).toBe(true)
  expect(t.includes('skipped')).toBe(false)
  expect(t.some(x => /^[●✔✖◆◌] merge$/.test(x))).toBe(false)
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

// ~2400 timer redraws of the live pane take about 5 s on a loaded machine, so the default 5 s limit is too tight
test('stale work: the timer draws a last redraw when it stops, so the open pane shows signed off with no other event', { timeoutMs: 15000 }, async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  await wave($, on, { clock })
  const ui = await mountLive($)
  expect((await liveTexts(ui)).some(x => /dispatching/.test(x))).toBe(true)
  for (let i = 0; i < 59; i++) await clock.advance(10_000) // 590 s of 250 ms pulses: still open
  expect((await liveTexts(ui)).some(x => /dispatching/.test(x))).toBe(true)
  for (let i = 0; i < 12; i++) await clock.advance(1000) // the pulse that finds it stale draws once more
  const t = await liveTexts(ui)
  expect(t.some(x => /dispatching|waiting for agents/.test(x))).toBe(false)
  expect(t.includes('skipped')).toBe(false)
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

// ---- retries: a failed attempt, the attempt that follows it, and the loops back ----
const IMPL = 'orchestration:implementer'
const REVQ = 'orchestration:reviewer'
const INTEG = 'orchestration:integrator'
const brief = (slice: string, deps = 'none') => `SLICE: ${slice}\nFILES: a.py\nDEPENDS: ${deps}`
const PLAN_REVIEW = 'PLAN REVIEW\nSLICE: plan\nFOCUS: gaps'
const colorOf = async (ui: any, re: RegExp) => ((await ui.findAll({ type: 'Text' })).find((x: any) => re.test(x.text ?? '')) as any)?.props?.color as string | undefined
const colorsOf = async (ui: any, re: RegExp) => ((await ui.findAll({ type: 'Text' })).filter((x: any) => re.test(x.text ?? '')) as any[]).map(x => x.props?.color as string)
const LART = /^[\s─│┌┐└┘├┤┬┴┼●▶▼▲↻╵╷╶╴]+$/
const FAIL = 'broke\nSTATUS: fail'
const PASS = 'ok\nSTATUS: pass'

// s1 built, its reviewer failed, a new implementer takes s1 again
const retried = async ($: any, on: any) => {
  await boot($, on)
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await finish($, 'b1', PASS)
  await spawnWith($, 'r1', 'SLICE: s1', REVQ)
  await finish($, 'r1', 'STATUS: fail\nGAPS:\n- off by one')
  await spawnWith($, 'b2', brief('s1'), IMPL)
}

test('a retry is its own card: attempt k/n, a red-to-amber retry connector, and the dependent hangs off the latest attempt', async ($, on) => {
  await retried($, on)
  await spawnWith($, 'c1', brief('s2', 's1'), IMPL)
  const ui = await mountLive($)
  let t = await liveTexts(ui)
  expect(t.some(x => /s1 ↻2/.test(x) && /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(x))).toBe(true) // the retry card runs
  expect(t.includes('attempt 1/2')).toBe(true)
  expect(t.includes('attempt 2/2')).toBe(true)
  expect(t.includes('◀ retry of s1')).toBe(true)
  expect(t.some(x => /◀ s1 ↻2/.test(x))).toBe(true) // s2 waits for the latest attempt
  expect(t.some(x => LART.test(x) && x.includes('↻'))).toBe(true) // the retry connector carries its marker
  expect(await colorOf(ui, /^[\s─│┌┐└┘├┤┬┴┼●▶▼↻]*↻[\s─▶]*$/)).toBe('warning') // amber while the attempt runs
  expect(await colorOf(ui, /^◀ retry of s1$/)).toBe('warning')
  await ui.unmount()
  // the retry attempt fails: red
  await finish($, 'b2', FAIL)
  const red = await mountLive($)
  expect(await colorOf(red, /^[\s─│┌┐└┘├┤┬┴┼●▶▼↻]*↻[\s─▶]*$/)).toBe('error')
  expect(await colorOf(red, /^◀ retry of s1$/)).toBe('error')
  await red.unmount()
  // a third attempt passes: green on its connector
  await spawnWith($, 'b3', brief('s1'), IMPL)
  await finish($, 'b3', PASS)
  const green = await mountLive($)
  t = await liveTexts(green)
  expect(t.includes('attempt 3/3')).toBe(true)
  expect(t.some(x => /^◆ s1 ↻3 /.test(x))).toBe(true)
  expect((await colorsOf(green, /^◀ retry of s1$/)).includes('success')).toBe(true)
  await green.unmount()
  // the tasks table has one row per attempt
  const rows = await texts($, 100)
  for (const id of ['s1', 's1 ↻2', 's1 ↻3']) expect(rows.some(x => x.startsWith('◆ ' + id + ' ') || x.startsWith('✖ ' + id + ' ') || x.startsWith('✔ ' + id + ' '))).toBe(true)
})

test('a resume that fires agent.spawn again with the same id is a new attempt; only the latest record takes the report', async ($, on) => {
  await boot($, on)
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await finish($, 'b1', FAIL)
  await spawnWith($, 'b1', brief('s1'), IMPL) // same agent id, spawned again
  let t = await texts($)
  expect(t.some(x => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] s1 ↻2 /.test(x))).toBe(true)
  expect(t.includes('attempt 2/2')).toBe(true)
  expect(t.some(x => /^✖ s1 /.test(x))).toBe(true) // the first run keeps its failure while the second runs
  await finish($, 'b1', PASS)
  t = await texts($)
  expect(t.some(x => /↳ fixed by s1 ↻2/.test(x))).toBe(true)
  expect(t.some(x => /^✔ s1 ↻2 /.test(x) || /^◆ s1 ↻2 /.test(x))).toBe(true)
})

test('a resume that fires only turn.complete for an ended record keeps the old run and adds a new one', async ($, on) => {
  await boot($, on)
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await finish($, 'b1', FAIL)
  await finish($, 'b1', PASS) // the resumed run ends: no spawn came
  const t = await texts($)
  expect(t.includes('attempt 1/2') && t.includes('attempt 2/2')).toBe(true)
  expect(t.some(x => /↳ fixed by s1 ↻2/.test(x))).toBe(true)
  expect(t.some(x => /^\S s1 ↻2 /.test(x))).toBe(true)
  expect(t.some(x => /retry 2 of s1/.test(x))).toBe(true) // and the log says so
})

test('counts: a failed attempt followed by a passing one is fixed; a failing retry leaves both failed', async ($, on) => {
  await retried($, on)
  await finish($, 'b2', PASS)
  await spawnWith($, 'r2', 'SLICE: s1', REVQ)
  await finish($, 'r2', 'STATUS: pass\nGAPS: none')
  let t = await texts($)
  expect(t.some(x => /↳ fixed by s1 ↻2/.test(x))).toBe(true)
  expect(t.some(x => /passed · 1 fixed on the way/.test(x))).toBe(true)
  expect(t.some(x => /3 passed · 0 failed · 1 fixed/.test(x))).toBe(true)
  expect(t.some(x => /^◆ s1 /.test(x))).toBe(true) // the failed attempt reads done, not failed
})

test('counts: when the retry fails too, both attempts stay failed', async ($, on) => {
  await retried($, on)
  await finish($, 'b2', FAIL)
  const t = await texts($)
  expect(t.some(x => /signed off with 2 failed/.test(x))).toBe(true)
  expect(t.some(x => /↳ fixed by/.test(x))).toBe(false)
})

test('new plan: slices that began after the first failure are tagged; retries of an old slice are not', async ($, on) => {
  await boot($, on)
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await finish($, 'b1', FAIL)
  await spawnWith($, 'b2', brief('s1'), IMPL)
  await spawnWith($, 'n1', brief('s9'), IMPL)
  const t = await texts($)
  expect(t.filter(x => x.includes('✚ new')).length).toBe(1)
  expect(t.includes('✚ new')).toBe(true) // s9 only
  expect(t.includes('attempt 2/2')).toBe(true) // the retry carries no tag
  expect(t.includes('attempt 1/2')).toBe(true)
})

test('session log: "retry k of X" on a retry spawn and "re-plan" on a plan review that follows a failed one', async ($, on) => {
  await retried($, on)
  await spawnWith($, 'p1', PLAN_REVIEW, REVQ)
  await finish($, 'p1', FAIL)
  await spawnWith($, 'p2', PLAN_REVIEW, REVQ)
  const t = await texts($)
  expect(t.some(x => /▶ retry 2 of s1/.test(x))).toBe(true)
  expect(t.some(x => /▶ re-plan · plan review started/.test(x))).toBe(true)
  expect(t.filter(x => /▶ re-plan/.test(x)).length).toBe(1) // the first plan review is a plain start
})

test('stage loops: re-plan, retry and rebuild appear when their condition is met and take the later attempt\'s colour', async ($, on) => {
  await boot($, on)
  // a failed plan review with no later one: nothing is drawn
  await spawnWith($, 'p1', PLAN_REVIEW, REVQ)
  await finish($, 'p1', FAIL)
  let t = await texts($)
  expect(t.some(x => /↻/.test(x))).toBe(false)
  // a failed integrator with no later build, and a slice-less failure: nothing either
  await spawnWith($, 'x1', 'build something', IMPL) // no SLICE line
  await finish($, 'x1', FAIL)
  await spawnWith($, 'm1', 'MERGE branches', INTEG)
  await finish($, 'm1', FAIL)
  t = await texts($)
  expect(t.some(x => /re-plan|retry|rebuild/.test(x) && /↻/.test(x))).toBe(false)
  expect(t.some(x => /^[\s─│┌┐└┘▲]+$/.test(x) && x.includes('▲'))).toBe(false)

  // a later plan review runs: re-plan, amber; it passes: green; the next fails: red
  await spawnWith($, 'p2', PLAN_REVIEW, REVQ)
  let ui = await mountLive($)
  expect(await colorOf(ui, /^ *↻ re-plan/)).toBe('warning')
  const rows = (await liveTexts(ui)).filter(x => LART.test(x) && x.includes('▲'))
  expect(rows.length).toBeGreaterThan(0)
  await ui.unmount()
  await finish($, 'p2', PASS)
  ui = await mountLive($)
  expect(await colorOf(ui, /^ *↻ re-plan/)).toBe('success')
  await ui.unmount()
  await spawnWith($, 'p3', PLAN_REVIEW, REVQ)
  await finish($, 'p3', FAIL)
  ui = await mountLive($)
  expect(await colorOf(ui, /^ *↻ re-plan/)).toBe('error')
  await ui.unmount()

  // a build after the failed integrator: rebuild, amber then green
  await spawnWith($, 'n1', brief('s5'), IMPL)
  ui = await mountLive($)
  expect(await colorOf(ui, /^ *↻ rebuild/)).toBe('warning')
  await ui.unmount()
  await finish($, 'n1', PASS)
  ui = await mountLive($)
  expect(await colorOf(ui, /^ *↻ rebuild/)).toBe('success')
  await ui.unmount()

  // a retried slice: retry 1 (the loop is drawn between the review and build boxes, so a reviewer has started)
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await finish($, 'b1', FAIL)
  await spawnWith($, 'q1', 'SLICE: s1', REVQ)
  await finish($, 'q1', FAIL)
  await spawnWith($, 'b2', brief('s1'), IMPL)
  ui = await mountLive($)
  expect(await colorOf(ui, /^ *↻ retry 1 *$/)).toBe('warning')
  await ui.unmount()
  await finish($, 'b2', FAIL)
  ui = await mountLive($)
  expect(await colorOf(ui, /^ *↻ retry 1 *$/)).toBe('error')
  await ui.unmount()
  await spawnWith($, 'b3', brief('s1'), IMPL)
  await finish($, 'b3', PASS)
  ui = await mountLive($)
  expect(await colorOf(ui, /^ *↻ retry 1 *$/)).toBe('success')
  await ui.unmount()
})

test('every width holds a scene with a retry, a re-plan and a rebuild inside the pane', async ($, on) => {
  await boot($, on)
  await spawnWith($, 'p1', PLAN_REVIEW, REVQ)
  await finish($, 'p1', FAIL)
  await spawnWith($, 'p2', PLAN_REVIEW, REVQ)
  await finish($, 'p2', PASS)
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await finish($, 'b1', PASS)
  await spawnWith($, 'r1', 'SLICE: s1', REVQ)
  await finish($, 'r1', FAIL)
  await spawnWith($, 'b2', brief('s1'), IMPL)
  await finish($, 'b2', PASS)
  await spawnWith($, 'c1', brief('s2', 's1'), IMPL)
  await spawnWith($, 'm1', 'MERGE', INTEG)
  await finish($, 'm1', FAIL)
  await spawnWith($, 'd1', brief('s3'), IMPL)
  for (const columns of [24, 32, 36, 39, 40, 52, 60, 64, 80, 99, 100, 140]) {
    const t = await texts($, columns)
    const art = t.filter(x => LART.test(x))
    expect(Math.max(...art.map(x => x.length))).toBeLessThanOrEqual(columns)
    for (const word of ['re-plan', 'retry 1', 'rebuild']) expect(t.some(x => x.includes(`↻ ${word}`))).toBe(true)
    expect(t.some(x => /^[✔✖◆⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏●] s1 ↻2 /.test(x))).toBe(true) // its row in the tasks table
    for (const word of ['sign off', 'tasks']) expect(t.some(x => x.includes(word))).toBe(true)
    // the loop labels sit inside the pane too
    expect(Math.max(...t.filter(x => /^ *↻ (re-plan|retry|rebuild)/.test(x)).map(x => x.length))).toBeLessThanOrEqual(columns)
    if (columns >= 100) expect(art.some(x => x.includes('▲') && x.includes('│'))).toBe(true) // the same-row loop connector
  }
})

// ---- the active path, stages that spawn on use, and the per-card slice connectors ----
const ARROW = /^(●─▶|─●▶|──▶)$/
const BOX = /^[●✔✖◆◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] (triage|plan review|plan|build|review|merge)$/
const arrowsOf = async (ui: any) => ((await ui.findAll({ type: 'Text' })).filter((x: any) => ARROW.test(x.text ?? '')) as any[]).map(x => ({ text: x.text as string, color: x.props?.color as string }))
const clocked = async ($: any, on: any, route?: unknown) => {
  const clock = mock.clock(on, { now: 10_000 })
  await boot($, on, { clock, ...(route ? { route } : {}) })
  return clock
}

test('active path: the arrows up to the furthest running stage are amber and carry the dot, the ones past it are grey', async ($, on) => {
  const clock = await clocked($, on)
  await $.prompt.submit({ text: PROMPT })
  await spawnWith($, 'p1', PLAN_REVIEW, REVQ)
  await finish($, 'p1', PASS)
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await finish($, 'b1', PASS)
  await spawnWith($, 'p2', PLAN_REVIEW, REVQ) // a second plan review runs after the build: the furthest active stage is plan review
  let ui = await mountLive($)
  let a = await arrowsOf(ui)
  // drawn: triage, plan, plan review, build -> arrows into plan, plan review (amber) and into build (grey)
  expect(a.map(x => x.color)).toEqual(['warning', 'warning', 'subtle'])
  expect(a.map(x => x.text)).toEqual(['●─▶', '●─▶', '──▶']) // the dot only on the live arrows
  expect(await colorOf(ui, /^ *│$/)).toBeTruthy()
  await ui.unmount()
  await clock.advance(250)
  ui = await mountLive($)
  a = await arrowsOf(ui)
  expect(a.map(x => x.text)).toEqual(['─●▶', '─●▶', '──▶']) // and it moves
  await ui.unmount()
  // the plan review ends and so does the turn: nothing runs, no dot anywhere, the final state in colour
  await finish($, 'p2', PASS)
  await $.turn.complete(mainDone('answer'))
  ui = await mountLive($)
  a = await arrowsOf(ui)
  expect(a.map(x => x.color)).toEqual(['success', 'success', 'success'])
  expect(a.every(x => x.text === '──▶')).toBe(true)
  expect((await liveTexts(ui)).some(x => x.includes('●'))).toBe(false)
  await ui.unmount()
  await clock.advance(250)
  expect((await texts($, 100)).some(x => x.includes('●'))).toBe(false)
})

test('active path: an arrow into a failed stage is red once nothing runs', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: PROMPT })
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await finish($, 'b1', FAIL)
  await $.turn.complete(mainDone('answer'))
  const ui = await mountLive($)
  expect((await arrowsOf(ui)).map(x => x.color)).toEqual(['success', 'error']) // into plan (done by the orchestrator), into the failed build
  expect((await liveTexts(ui)).some(x => x.includes('●') || x === 'skipped')).toBe(false)
  await ui.unmount()
})

test('active path: the main session working in a plain run lights the link and the arrow into build; it goes out when the turn ends', async ($, on) => {
  const clock = await clocked($, on, verdict('plain'))
  await $.prompt.submit({ text: PROMPT })
  await $.tool.call({ tool: 'Bash', command: ROUTE_CMD })
  let ui = await mountLive($)
  const a = await arrowsOf(ui)
  expect(a.map(x => x.color)).toEqual(['warning']) // triage -> build, the session builds
  expect(a[0]!.text).toBe('●─▶')
  const g = geom(100, 'plain')
  expect((await colorsOf(ui, /^ *└[─┐]*┐$| *[│▼]$|●/)).includes('warning')).toBe(true)
  expect(await colorOf(ui, /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] build$/)).toBe('warning')
  await ui.unmount()
  expect(g.link.length).toBe(3)
  await clock.advance(250)
  await $.turn.complete(mainDone('answer'))
  ui = await mountLive($)
  expect((await arrowsOf(ui)).map(x => [x.text, x.color])).toEqual([['──▶', 'success']])
  expect((await liveTexts(ui)).some(x => x.includes('●'))).toBe(false)
  await ui.unmount()
})

test('active path: the loop-back carries the dot backward while a retry runs, and the retry card and its connector still render', async ($, on) => {
  const clock = await clocked($, on)
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await finish($, 'b1', PASS)
  await spawnWith($, 'r1', 'SLICE: s1', REVQ)
  await finish($, 'r1', 'STATUS: fail\nGAPS:\n- off by one')
  await spawnWith($, 'b2', brief('s1'), IMPL) // the retry runs: the loop review -> build is live
  // 100 columns: six per row, 14 wide; drawn triage, plan, build, review -> the loop leaves review (x 58) and enters build (x 41)
  const fx = 3 * 17 + 7
  const tx = 2 * 17 + 7
  const rows = [`${' '.repeat(tx)}▲${' '.repeat(fx - tx - 1)}│`, `${' '.repeat(tx)}└${'─'.repeat(fx - tx - 1)}┘`]
  const path: [number, number][] = [[0, fx]]
  for (let x = fx; x >= tx; x--) path.push([1, x])
  path.push([0, tx])
  const seen: string[] = []
  let sawMarker = false
  for (let f = 0; f < 5; f++) {
    const ui = await mountLive($)
    const t = await liveTexts(ui)
    const [r, x] = path[f % path.length] as [number, number]
    const expected = rows.map((row, i) => (i === r ? `${row.slice(0, x)}●${row.slice(x + 1)}` : row))
    for (const row of expected) expect(t.some(y => y.trimEnd() === row)).toBe(true)
    seen.push(`${r},${x}`)
    expect(await colorOf(ui, /^ *↻ retry 1/)).toBe('warning') // the loop is lit amber
    // the arrows into plan and build are live (amber), the one into review past the furthest active stage (grey)
    expect((await arrowsOf(ui)).map(y => y.color)).toEqual(['warning', 'warning', 'subtle'])
    // regression: the retry card and its connector
    expect(t.some(y => /s1 ↻2/.test(y) && /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] /.test(y))).toBe(true)
    sawMarker ||= t.some(y => LART.test(y) && y.includes('↻')) // the dot can sit on the marker for a frame
    await ui.unmount()
    await clock.advance(250)
  }
  expect(sawMarker).toBe(true)
  expect(new Set(seen).size).toBe(5) // from the later stage, down and along the line toward the earlier one
  // the retry ends and the turn too: no dot on the loop any more
  await finish($, 'b2', PASS)
  const idle = await mountLive($)
  expect((await liveTexts(idle)).some(y => LART.test(y) && y.includes('▲') && y.includes('●'))).toBe(false)
  expect(await colorOf(idle, /^ *↻ retry 1/)).toBe('success')
  await idle.unmount()
})

test('spawn on use: before a mode is known only triage shows; a stage appears with its first agent', async ($, on) => {
  await boot($, on, { route: verdict('orchestrate') })
  await $.prompt.submit({ text: PROMPT })
  const boxes = async () => (await texts($, 100)).filter(x => BOX.test(x)).map(x => x.slice(2))
  expect(await boxes()).toEqual(['triage']) // sizing: no mode
  await $.tool.call({ tool: 'Bash', command: ROUTE_CMD })
  expect(await boxes()).toEqual(['triage', 'plan']) // the route's entry as the dim next box
  let t = await texts($, 100)
  expect(t.includes('next')).toBe(true)
  expect(t.some(x => /^◌ plan$/.test(x))).toBe(true)
  await spawnWith($, 'b1', brief('s1'), IMPL)
  expect(await boxes()).toEqual(['triage', 'plan', 'build'])
  expect((await texts($, 100)).includes('next')).toBe(false)
  await spawnWith($, 'r1', 'SLICE: s1', REVQ)
  expect(await boxes()).toEqual(['triage', 'plan', 'build', 'review'])
  await finish($, 'b1', PASS)
  await finish($, 'r1', PASS)
  await spawnWith($, 'm1', 'MERGE', INTEG)
  expect(await boxes()).toEqual(['triage', 'plan', 'build', 'review', 'merge'])
  await finish($, 'm1', PASS)
  await $.turn.complete(mainDone('answer'))
  t = await texts($, 100)
  expect(t.includes('skipped')).toBe(false)
})

test('spawn on use: plain and reviewed draw the build as the session\'s own work and skip the rest', async ($, on) => {
  await boot($, on, { route: verdict('reviewed') })
  await $.prompt.submit({ text: PROMPT })
  await $.tool.call({ tool: 'Bash', command: ROUTE_CMD })
  const boxes = async () => (await texts($, 100)).filter(x => BOX.test(x)).map(x => x.slice(2))
  expect(await boxes()).toEqual(['triage', 'build'])
  await spawnWith($, 'r1', 'SLICE: s1', REVQ)
  expect(await boxes()).toEqual(['triage', 'build', 'review'])
  expect((await texts($, 100)).includes('this session')).toBe(true)
  expect((await texts($, 100)).includes('skipped')).toBe(false)
})

test('slice diagram: trunk forks, bus stubs, the bus and the connector under a short layer take each card\'s colour; the trunk dot stops at the lowest running card', async ($, on) => {
  const clock = await clocked($, on)
  await spawnWith($, 'a1', brief('s1'), IMPL)
  await finish($, 'a1', PASS)
  await spawnWith($, 'a2', brief('s2'), IMPL) // running, independent of s1
  await spawnWith($, 'a3', brief('s3', 's1'), IMPL) // depends on s1 (layer 1)
  await finish($, 'a3', FAIL)
  const ui = await mountLive($)
  const t = await liveTexts(ui)
  expect(t.some(x => /^◆ s1 /.test(x))).toBe(true)
  // layer 0 [s1, s2]: the fork into s1 is green (passed), the last one into s2 amber (running)
  expect(await colorOf(ui, /^ ├▶$/)).toBe('success')
  expect(await colorsOf(ui, /^ └▶$/)).toContain('warning')
  // the connector under the shorter layer 1 (s3, failed) is red, and the bus: the stub of s2 amber, of s3 red, the rest of it the best colour
  expect(await colorsOf(ui, /^ {5,}│$/)).toContain('error')
  expect(await colorsOf(ui, /^┘$/)).toEqual(['error'])
  expect((await colorsOf(ui, /└[─┬]+$/)).includes('warning')).toBe(true)
  await ui.unmount()
  // the trunk dot: layer 0 is s1 and s2 (running, the last fork): the dot visits rail rows above that fork only, never a fork row
  const rowsSeen = new Set<number>()
  let lowest = -1
  let fork = -1
  for (let f = 0; f < 12; f++) {
    const u = await mountLive($)
    const trunk = (await liveTexts(u)).filter(x => /^ [│●] $|^ [├└]▶$/.test(x))
    lowest = trunk.indexOf(' └▶')
    fork = trunk.indexOf(' ├▶')
    trunk.forEach((x, i) => x === ' ● ' && rowsSeen.add(i))
    await u.unmount()
    await clock.advance(250)
  }
  expect(lowest).toBeGreaterThan(fork)
  expect([...rowsSeen].every(r => r < lowest && r !== fork)).toBe(true)
  expect(Math.max(...rowsSeen)).toBe(lowest - 1) // it reaches the row above the running card and no further
  expect(rowsSeen.size).toBeGreaterThan(2)
})

test('slice diagram: a running first card ends the trunk dot above its own fork; later cards get none', async ($, on) => {
  const clock = await clocked($, on)
  await spawnWith($, 'a2', brief('s2'), IMPL) // first card, running
  await spawnWith($, 'a1', brief('s1'), IMPL)
  await finish($, 'a1', PASS)
  const rowsSeen = new Set<number>()
  for (let f = 0; f < 8; f++) {
    const u = await mountLive($)
    const trunk = (await liveTexts(u)).filter(x => /^ [│●] $|^ [├└]▶$/.test(x))
    trunk.forEach((x, i) => x === ' ● ' && rowsSeen.add(i))
    await u.unmount()
    await clock.advance(250)
  }
  expect([...rowsSeen].every(r => r < 2)).toBe(true) // the running card's fork is on row 2
  expect(rowsSeen.size).toBe(2)
})

test('spawn on use: 1 to 6 drawn stages hold inside the pane at every width from 24 to 140', async ($, on) => {
  await boot($, on, { route: verdict('orchestrate') })
  await $.prompt.submit({ text: PROMPT })
  const WIDE = [24, 28, 32, 36, 39, 40, 44, 52, 60, 64, 80, 99, 100, 120, 140]
  const check = async (want: string[]) => {
    for (const columns of WIDE) {
      const t = await texts($, columns)
      expect(t.filter(x => BOX.test(x)).map(x => x.slice(2))).toEqual(want)
      expect(t.includes('skipped')).toBe(false)
      const art = t.filter(x => LART.test(x))
      expect(art.length).toBeGreaterThan(0)
      expect(Math.max(...art.map(x => x.length))).toBeLessThanOrEqual(columns)
      expect(t.some(x => x.includes('sign off'))).toBe(true)
    }
  }
  await check(['triage']) // 1
  await $.tool.call({ tool: 'Bash', command: ROUTE_CMD })
  await check(['triage', 'plan']) // 2
  await spawnWith($, 'p1', PLAN_REVIEW, REVQ)
  await check(['triage', 'plan', 'plan review']) // 3
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await check(['triage', 'plan', 'plan review', 'build']) // 4
  await spawnWith($, 'r1', 'SLICE: s1', REVQ)
  await check(['triage', 'plan', 'plan review', 'build', 'review']) // 5
  await spawnWith($, 'm1', 'MERGE', INTEG)
  await check(['triage', 'plan', 'plan review', 'build', 'review', 'merge']) // 6
  await finish($, 'p1', PASS)
  await finish($, 'b1', PASS)
  await finish($, 'r1', PASS)
  await finish($, 'm1', PASS)
  await $.turn.complete(mainDone('answer'))
  await check(['triage', 'plan', 'plan review', 'build', 'review', 'merge'])
})

// ---- progress through the orchestrator's plan, and what the session used ----
const PLANNED = [
  'PLAN REVIEW',
  'SLICE: plan',
  'Task: add the plan bar',
  '- **SLICE:** s1 — shared types',
  'FILES: types.ts',
  'DEPENDS: none',
  'SLICE: s2',
  'FILES: api.ts',
  'DEPENDS: s1',
  'GOAL: the handler',
  'SLICE: s3',
  'GOAL: docs',
  'SLICE: s1',
  'GOAL: not this one: s1 has its goal',
].join('\n')
const barOf = (t: string[]) => t.filter(x => /^━+$/.test(x))

test('progress: the PLAN REVIEW brief lists the planned slices; each moves along as its attempts run, pass and fail', async ($, on) => {
  await boot($, on)
  expect((await texts($)).some(x => x.startsWith('progress'))).toBe(false) // no plan, no slices: no bar
  await spawnWith($, 'p1', PLANNED, REVQ)
  let t = await texts($)
  expect(t.includes('progress · 0/3 slices · 0%')).toBe(true)
  // in plan order, with their goals; "plan" (the review's own SLICE line) is not a slice, and a repeated slice keeps its first goal
  const steps = t.filter(x => /^[●✔✖◆◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] s\d/.test(x))
  expect(steps.slice(0, 3)).toEqual(['◌ s1 · shared types', '◌ s2 · the handler', '◌ s3 · docs'])
  expect(barOf(t).join('')).toBe('━'.repeat(40))
  await finish($, 'p1', PASS)
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await finish($, 'b1', PASS)
  await spawnWith($, 'r1', 'SLICE: s1', REVQ)
  await finish($, 'r1', PASS)
  await spawnWith($, 'b2', brief('s2', 's1'), IMPL)
  await spawnWith($, 'b3', brief('s3'), IMPL)
  await finish($, 'b3', FAIL)
  const ui = await mountLive($)
  t = await liveTexts(ui)
  expect(t.includes('progress · 1/3 slices · 33% · 1 running · 1 failed')).toBe(true)
  // the bar: one third per slice, in plan order: s1 passed, s2 runs, s3 failed
  const runs = ((await ui.findAll({ type: 'Text' })) as any[]).filter(x => /^━+$/.test(x.text ?? '')).map(x => [x.text.length, x.props?.color])
  expect(runs).toEqual([[14, 'success'], [13, 'warning'], [13, 'error']])
  await ui.unmount()
  // a retry of s3 passes its review: the slice is done; a slice outside the plan joins the bar at the end
  await spawnWith($, 'b4', brief('s3'), IMPL)
  await finish($, 'b4', PASS)
  await spawnWith($, 'r4', 'SLICE: s3', REVQ)
  await finish($, 'r4', PASS)
  await finish($, 'b2', PASS)
  await spawnWith($, 'b5', brief('s4'), IMPL)
  t = await texts($)
  expect(t.includes('progress · 3/4 slices · 75% · 1 running')).toBe(true)
  expect(t.some(x => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] s4$/.test(x))).toBe(true)
  expect(t.includes('◆ s2 · the handler')).toBe(true) // built, not reviewed yet: counted done, drawn as the cards draw it
})

test('progress: a re-plan that names slices replaces the plan, one that names none keeps it, and a new run drops it', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  await boot($, on, { clock })
  await spawnWith($, 'p1', PLANNED, REVQ)
  await finish($, 'p1', FAIL)
  await spawnWith($, 'p2', 'PLAN REVIEW\nSLICE: plan\nthe same plan, fixed', REVQ)
  expect((await texts($)).includes('progress · 0/3 slices · 0%')).toBe(true)
  await finish($, 'p2', FAIL)
  await spawnWith($, 'p3', 'PLAN REVIEW\n* SLICE: `a1` | one\n* SLICE: a2: two', REVQ)
  let t = await texts($)
  expect(t.includes('progress · 0/2 slices · 0%')).toBe(true)
  expect(t.includes('◌ a1 · one')).toBe(true)
  expect(t.includes('◌ a2 · two')).toBe(true)
  await finish($, 'p3', PASS)
  // idle time alone no longer ends a run: a spawn long after joins the open run (its slices are not final)
  await clock.advance(130_000)
  await spawnWith($, 'b1', brief('a1'), IMPL)
  t = await texts($)
  expect(t.includes('progress · 0/2 slices · 0% · 1 running')).toBe(true)
  await finish($, 'b1', PASS)
  // a new plan (a PLAN REVIEW without REPLAN that names slices) closes the run: the old plan and agents go
  await spawnWith($, 'p4', 'PLAN REVIEW\nSLICE: z1 - zed', REVQ)
  t = await texts($)
  expect(t.includes('progress · 0/1 slices · 0%')).toBe(true)
  expect(t.includes('◌ z1 · zed')).toBe(true)
  expect(t.some(x => /a1|a2/.test(x))).toBe(false)
})

test('progress: at every width the bar fits and the plan lines are cut, not wrapped; more than 8 slices end in +N more', async ($, on) => {
  await boot($, on)
  const many = ['PLAN REVIEW', ...Array.from({ length: 10 }, (_, i) => `SLICE: s${i + 1}\nGOAL: ${'a long goal '.repeat(6)}`)].join('\n')
  await spawnWith($, 'p1', many, REVQ)
  for (const columns of [16, 24, 32, 44, 64, 100, 140]) {
    const t = await texts($, columns)
    expect(barOf(t).join('').length).toBe(Math.max(10, Math.min(columns - 2, 40)))
    expect(t.filter(x => /^◌ s\d+/.test(x)).length).toBe(8)
    expect(t.includes('+2 more')).toBe(true)
  }
  const tall = await texts($, 100, 200)
  expect(tall.some(x => /scroll/.test(x))).toBe(false)
  const short = await texts($, 100, 40)
  expect(short.some(x => /scroll/.test(x))).toBe(true) // the bar and its lines count toward the scroll hint
})

// Core answers: Write is denied, a read of broken.ts errors, every other call runs. Registered before boot starts the session.
const coreUse = (on: any) => {
  on('tool.call', (_: unknown, e: any) => (e.tool === 'Write' ? { deny: 'no' } : e.file_path === '/r/broken.ts' ? { result: 'x', isError: true } : { result: 'ok', text: 'ok' }))
  on('skill.prompt', (_: unknown, e: any) => ({ text: e.text }))
}
const usedOf = (t: string[]) => {
  const at = t.indexOf('used in this session')
  return at < 0 ? [] : t.slice(at + 1)
}

test('used in this session: skills, connectors, agents, tools and files, from calls that ran; a new run keeps it', async ($, on) => {
  const clock = mock.clock(on, { now: 10_000 })
  coreUse(on)
  await boot($, on, { clock })
  expect((await texts($)).includes('used in this session')).toBe(false) // nothing used yet
  const s = $ as any
  await s.skill.prompt({ skill: 'orchestration:route', text: 'size it', frontmatter: {}, source: 'plugin' })
  await s.skill.prompt({ skill: 'orchestration:route', text: 'again', frontmatter: {}, source: 'plugin' })
  await s.skill.prompt({ skill: 'plugin-authoring', text: 'x', frontmatter: {}, source: 'built-in' })
  await s.tool.call({ tool: 'Read', file_path: '/r/a.ts' })
  await s.tool.call({ tool: 'Read', file_path: '/r/b.ts' })
  await s.tool.call({ tool: 'Edit', file_path: '/r/a.ts', old_string: 'x', new_string: 'y' }) // read, then changed: counted as edited only
  await s.tool.call({ tool: 'Write', file_path: '/r/denied.ts', content: 'x' }) // denied: not used
  await s.tool.call({ tool: 'Read', file_path: '/r/broken.ts' }) // an error: not used
  await s.tool.call({ tool: 'Bash', command: 'ls' })
  await s.tool.call({ tool: 'Bash', command: 'pwd' })
  await s.tool.call({ tool: 'mcp__claude_ai_Google_Drive__search_files', query: 'q' })
  await s.tool.call({ tool: 'mcp__notion__notion-search', query: 'q' })
  await s.tool.call({ tool: 'Skill', skill: 'x' }) // counted by skill.prompt, not as a tool
  await spawnWith($, 'e1', 'look around', 'Explore') // any agent type is listed, not only the four roles
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await s.tool.call({ tool: 'Grep', pattern: 'x', agentId: 'b1' }) // an agent's tools count too
  await s.tool.call({ tool: NAME, ...VERDICT }) // the pane's own route tool is a connector too
  const want = [
    'skills     ', 'orchestration:route · plugin-authoring',
    'connectors ', 'Google Drive · notion · orchestration-dashboard',
    'agents     ', 'Explore 1 · implementer 1',
    'tools      ', 'Read 2 · Bash 2 · Edit 1 · Grep 1', // broken.ts errored, so two reads ran
    'edited     ', 'a.ts',
    'read       ', '1 file',
  ]
  expect(usedOf(await texts($))).toEqual(want)
  // a new run drops the diagram and the plan, not what the session used
  await finish($, 'b1', PASS)
  await clock.advance(130_000)
  await s.prompt.submit({ text: 'the next job' }) // nothing runs and no run is open (no plan review): new input is new work
  await spawnWith($, 'b2', brief('s9'), IMPL)
  const t = await texts($)
  expect(t.some(x => /^[●✔✖◆◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] s1$/.test(x))).toBe(false)
  expect(usedOf(t).slice(4, 6)).toEqual(['agents     ', 'implementer 2 · Explore 1'])
})

test('used in this session: on a narrow pane a row keeps as many names as fit and ends in +N', async ($, on) => {
  coreUse(on)
  await boot($, on)
  for (const f of ['alpha.ts', 'beta.ts', 'gamma.ts', 'delta.ts', 'epsilon.ts']) await ($ as any).tool.call({ tool: 'Edit', file_path: `/r/${f}`, old_string: 'a', new_string: 'b' })
  for (const columns of [24, 32, 44, 100]) {
    const rows = usedOf(await texts($, columns))
    const edited = rows[rows.indexOf('edited     ') + 1] as string
    expect(edited.startsWith('epsilon.ts')).toBe(true) // the latest first
    expect(11 + edited.length).toBeLessThanOrEqual(Math.max(columns - 1, 11 + 'epsilon.ts · +4'.length))
    if (columns < 44) expect(/\+\d$/.test(edited)).toBe(true)
  }
  expect(usedOf(await texts($, 100))).toContain('epsilon.ts · delta.ts · gamma.ts · beta.ts · alpha.ts')
})

// ---- the brief grammar (docs/brief-grammar.md): the dashboard's mirror of brief.mjs, and the run model, STATUS rule and marks built on it ----
test('brief grammar: the dashboard parser gives expected.json for every fixture in src/fixtures/briefs', async () => {
  // scripts/test-dashboard.mjs copies src/fixtures/briefs next to hooks/ and adds fixtures.ts: { texts: { name: text }, expected: expected.json }
  const { texts: sources, expected } = fixtures as unknown as { texts: Record<string, string>; expected: Record<string, any> }
  const names = Object.keys(sources).sort()
  expect(names.length).toBeGreaterThan(10)
  expect(names).toEqual(Object.keys(expected).sort())
  for (const name of names) {
    const text = sources[name] as string
    const want = expected[name]
    // the fields the pane uses: slice, files, depends, path, risky, checks (and focus, workflow, sources, read, kind, validate); isPlanReview, replan,
    // constraints and each planned slice's goal, risky and checks; status, answers, open, gaps and quotes
    expect({ name, header: parseHeader(text) }).toEqual({ name, header: want.header })
    expect({ name, plan: parsePlan(text) }).toEqual({ name, plan: want.plan })
    expect({ name, reply: parseReply(text) }).toEqual({ name, reply: want.reply })
    expect({ name, status: parseStatus(text) }).toEqual({ name, status: want.reply.status })
  }
  for (const junk of [undefined, null, 42, {}, []]) {
    expect(parseHeader(junk).slice).toBe(null)
    expect(parsePlan(junk)).toEqual({ isPlanReview: false, replan: null, constraints: {}, slices: [] })
    expect(parseReply(junk)).toEqual({ status: null, open: [], answers: {}, gaps: [], quotes: [] })
    expect(parseHeader(junk)).toEqual({ slice: null, files: [], depends: [], path: null, risky: false, checks: [], focus: null, workflow: false, sources: [], read: null, kind: null, validate: false })
  }
  // the 0.4.0 lines (SOURCES, READ, KIND, VALIDATE; GAP, QUOTE) have fixtures of their own, so the loop above covers them
  for (const name of ['researcher-brief.txt', 'impl-bugfix.txt', 'reply-gaps.txt', 'reply-quotes.txt']) expect(names.includes(name)).toBe(true)
})

const RESEARCH = 'orchestration:researcher'
test('STATUS: any fail line fails, else the first line decides; blockquotes and the template do not count', async ($, on) => {
  await boot($, on)
  const replies: [string, string][] = [
    ['q1', 'STATUS: fail\nfixed it after all\nSTATUS: pass'], // the old last-line rule read pass
    ['q2', 'STATUS: pass\n> STATUS: fail'], // a quote is not a verdict
    ['q3', 'STATUS: pass or fail'], // the template: no status
    ['q4', '**STATUS: pass**\nSTATUS: pass'],
  ]
  for (const [id, answer] of replies) {
    await spawnWith($, id, 'look around', RESEARCH)
    await finish($, id, answer)
  }
  const t = await texts($, 100, 200)
  expect(t.some(x => /^✖ q1 /.test(x))).toBe(true)
  expect(t.some(x => /^✔ q2 /.test(x))).toBe(true)
  expect(t.some(x => /^◆ q3 /.test(x))).toBe(true)
  expect(t.some(x => /^✔ q4 /.test(x))).toBe(true)
})

const PLAN1 = 'PLAN REVIEW\nSLICE: s1 - one\nFILES: a.py\nDEPENDS: none'
test('run: a new prompt does not close an open planned run; once every slice is final the next prompt starts clean', async ($, on) => {
  await boot($, on)
  const s = $ as any
  await s.prompt.submit({ text: 'build it' })
  await spawnWith($, 'p1', PLAN1, REVQ)
  await finish($, 'p1', PASS)
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await finish($, 'b1', PASS)
  await s.turn.complete(mainDone('answer'))
  // s1 is built but not reviewed: the run is open, so the prompt (a headless run's background result) keeps it and reopens the main turn
  await s.prompt.submit({ text: 'background result' })
  let t = await texts($)
  expect(t.some(x => /^\S s1 /.test(x))).toBe(true)
  expect(t.includes('▸ build it')).toBe(true)
  expect(t.some(x => /dispatching\.+ 0 running/.test(x))).toBe(true) // the main turn works again: not signed off
  await spawnWith($, 'r1', 'SLICE: s1', REVQ)
  await finish($, 'r1', PASS)
  await s.turn.complete(mainDone('answer'))
  t = await texts($)
  expect(t.some(x => /all agents passed/.test(x))).toBe(true)
  await s.prompt.submit({ text: 'the next job' }) // every slice is final: the run is closed
  t = await texts($)
  expect(t.some(x => /s1/.test(x))).toBe(false)
  expect(t.includes('▸ the next job')).toBe(true)
})

test('run: a slice whose review failed is final only after 3 implementer attempts', async ($, on) => {
  await boot($, on)
  const s = $ as any
  await spawnWith($, 'p1', PLAN1, REVQ)
  await finish($, 'p1', PASS)
  for (const k of [1, 2]) {
    await spawnWith($, `b${k}`, brief('s1'), IMPL)
    await finish($, `b${k}`, PASS)
    await spawnWith($, `r${k}`, 'SLICE: s1', REVQ)
    await finish($, `r${k}`, FAIL)
  }
  await s.prompt.submit({ text: 'what now' }) // 2 attempts, the latest review failed: not final, the run stays
  expect((await texts($)).some(x => /s1 ↻2/.test(x))).toBe(true)
  await spawnWith($, 'b3', brief('s1'), IMPL)
  await finish($, 'b3', PASS)
  await spawnWith($, 'r3', 'SLICE: s1', REVQ)
  await finish($, 'r3', FAIL)
  await s.turn.complete(mainDone('answer'))
  await s.prompt.submit({ text: 'something else' }) // failed for good after 3 attempts: final, the run is closed
  expect((await texts($)).some(x => /s1/.test(x))).toBe(false)
})

test('run: a light-path launch opens a run that a prompt keeps until its slice is reviewed', async ($, on) => {
  await boot($, on)
  const s = $ as any
  await spawnWith($, 'b1', 'SLICE: fx\nFILES: README.md\nDEPENDS: none\nPATH: light', IMPL)
  await finish($, 'b1', PASS)
  await s.prompt.submit({ text: 'and?' })
  expect((await texts($)).some(x => /^\S fx /.test(x))).toBe(true)
  await spawnWith($, 'r1', 'SLICE: fx', REVQ)
  await finish($, 'r1', PASS)
  await s.turn.complete(mainDone('answer'))
  await s.prompt.submit({ text: 'new thing' })
  expect((await texts($)).some(x => /fx/.test(x))).toBe(false)
})

test('run: REPLAN extends the open run and marks the progress bar; the agents stay', async ($, on) => {
  await boot($, on)
  await spawnWith($, 'p1', 'PLAN REVIEW\nSLICE: s1 - one\nSLICE: s2 - two', REVQ)
  await finish($, 'p1', PASS)
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await spawnWith($, 'p2', 'PLAN REVIEW\nREPLAN: 1\nSLICE: s2 - two, split\nSLICE: s3 - three', REVQ)
  const t = await texts($, 100, 200)
  expect(t.includes('progress · 0/3 slices · 0% · 1 running · ↻ replan 1')).toBe(true)
  expect(t.includes('◌ s2 · two, split')).toBe(true) // a slice named again takes the re-plan's lines
  expect(t.includes('◌ s3 · three')).toBe(true)
  expect(t.some(x => /^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] s1 /.test(x))).toBe(true) // b1's card is still there
})

test('waiting: the main turn ended with agents still running reads waiting for N agents, then signs off', async ($, on) => {
  await boot($, on)
  const s = $ as any
  await s.prompt.submit({ text: 'go' })
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await spawnWith($, 'b2', brief('s2'), IMPL)
  await s.turn.complete(mainDone('answer'))
  let t = await texts($)
  expect(t.filter(x => x === 'waiting for 2 agents').length).toBe(2) // the orchestrator box and the sign-off box
  await finish($, 'b1', PASS)
  t = await texts($)
  expect(t.filter(x => x === 'waiting for 1 agent').length).toBe(2)
  await finish($, 'b2', PASS)
  t = await texts($)
  expect(t.some(x => /waiting for/.test(x))).toBe(false)
  expect(t.some(x => /all agents passed/.test(x))).toBe(true)
})

test('marks: RISKY, the opus escalation and one constraint tick per check from the latest review', async ($, on) => {
  await boot($, on, { model: id => (id.startsWith('o') ? 'claude-opus-4' : 'sonnet') })
  const plan = ['PLAN REVIEW', 'CONSTRAINTS:', 'C1: parsing never throws', 'C2: no new dependencies', 'C3: old briefs still work',
    'SLICE: s1 - one', 'FILES: a.py', 'DEPENDS: none', 'RISKY: yes', 'CHECKS: C1, C2, C3', 'SLICE: s2 - two', 'FILES: b.py', 'DEPENDS: none'].join('\n')
  await spawnWith($, 'p1', plan, REVQ)
  await finish($, 'p1', PASS)
  let t = await texts($, 100, 200)
  expect(t.includes('◌ s1 ⚑ ⇧opus? C1· C2· C3· · one')).toBe(true) // risky asks for an opus review before anything ran
  expect(t.includes('◌ s2 · two')).toBe(true) // no marks: drawn as before
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await finish($, 'b1', PASS)
  await spawnWith($, 'r1', 'SLICE: s1\nCHECKS: C1, C2, C3', REVQ)
  await finish($, 'r1', 'STATUS: pass\nC1: pass (cmd) npm test -> 3 pass\nC2: pass (read) package.json:12\nC3: fail parse throws\nOPEN: none')
  t = await texts($, 100, 200)
  expect(t.includes('✔ s1 ⚑ ⇧opus? C1✔ C2✓ C3✖ · one')).toBe(true)
  await spawnWith($, 'o1', 'SLICE: s1\nCHECKS: C1, C2, C3', REVQ)
  await finish($, 'o1', 'STATUS: pass\nC1: pass (cmd) npm test -> 3 pass\nC2: pass (cmd) git diff package.json -> empty\nC3: pass (cmd) node old.js -> ok')
  t = await texts($, 100, 200)
  expect(t.includes('✔ s1 ⚑ ⇧opus✔ C1✔ C2✔ C3✔ · one')).toBe(true)
  // no RISKY, but OPEN items in its passing review: escalation alone
  await spawnWith($, 'b2', brief('s2'), IMPL)
  await finish($, 'b2', PASS)
  await spawnWith($, 'r2', 'SLICE: s2', REVQ)
  await finish($, 'r2', 'STATUS: pass\nOPEN: a flaky test')
  t = await texts($, 100, 200)
  expect(t.includes('✔ s2 ⇧opus? · two')).toBe(true)
})

test('counted reviews: low-confidence gaps read as a pass with doubt; the same gap failing twice reads as a stall until a REPLAN', async ($, on) => {
  await boot($, on, { model: id => (id.startsWith('q') ? 'claude-sonnet-5-5' : 'haiku') })
  const plan = ['PLAN REVIEW', 'SLICE: s1 - one', 'FILES: a.py', 'DEPENDS: none', 'SLICE: s2 - two', 'FILES: b.py', 'DEPENDS: none'].join('\n')
  await spawnWith($, 'p1', plan, REVQ)
  await finish($, 'p1', PASS)
  await spawnWith($, 'b1', brief('s1'), IMPL)
  await finish($, 'b1', PASS)
  await spawnWith($, 'r1', 'SLICE: s1', REVQ)
  await finish($, 'r1', 'STATUS: fail\nGAP: 40 a variable name could be clearer\nOPEN: none')
  let t = await texts($, 100, 200)
  expect(t.includes('✔ s1 doubt ⇧opus? · one')).toBe(true) // counted as a pass, with a doubt that asks for an opus review
  await spawnWith($, 'b2', 'SLICE: s2\nFILES: b.py\nDEPENDS: none', IMPL)
  await finish($, 'b2', PASS)
  await spawnWith($, 'r2', 'SLICE: s2', REVQ)
  await finish($, 'r2', 'STATUS: fail\nGAP: 90 missing null check in parse()')
  await spawnWith($, 'b3', 'SLICE: s2\nFILES: b.py\nDEPENDS: none', IMPL)
  await finish($, 'b3', PASS)
  await spawnWith($, 'r3', 'SLICE: s2', REVQ)
  await finish($, 'r3', 'STATUS: fail\nGAP: 95 Missing null-check in parse()!')
  t = await texts($, 100, 200)
  expect(t.includes('✖ s2 ↻replan ⇧opus? · two')).toBe(true)
  await spawnWith($, 'p2', `PLAN REVIEW\nREPLAN: 1\n${plan}`, REVQ)
  await finish($, 'p2', PASS)
  t = await texts($, 100, 200)
  expect(t.some(x => x.includes('↻replan'))).toBe(false) // the REPLAN plan review cleared the stall
  // A researcher's start line names the model it runs with (the read router may have raised it).
  await spawnWith($, 'q1', 'SOURCES: scan.pdf\nREAD: extract\nWhat is the total?', 'orchestration:researcher')
  t = await texts($, 100, 200)
  expect(t.some(x => /q1 started · sonnet-5-5/.test(x))).toBe(true)
})

test('blocked launches: a gate denial of an Agent call is logged with its reason; another denial is not', async ($, on) => {
  on('tool.call', (_: unknown, e: any) => ({
    deny: e.prompt?.includes('s9') ? 'Plan check: slice s9 is not in the plan (not_in_plan). Re-plan with REPLAN first.'
      : e.prompt?.includes('s8') ? 'Plan check: no plan review has finished in this session. Send the plan to a reviewer.'
      : e.prompt?.includes('s7') ? 'Review gate: let not_in_plan_gave_up through' : 'The user rejected this tool call',
  }))
  await boot($, on)
  const call = ($ as any).tool.call
  await spawnWith($, 'b1', brief('s1'), IMPL)
  for (const s of ['s9', 's8', 's7', 's6']) await call({ tool: 'Agent', subagent_type: 'orchestration:implementer', prompt: brief(s), description: s })
  const t = await texts($, 100, 200)
  expect(t.some(x => /⊘ blocked not_in_plan · s9 · implementer$/.test(x))).toBe(true)
  expect(t.some(x => /⊘ blocked no_plan_review · s8 · implementer$/.test(x))).toBe(true)
  expect(t.filter(x => /⊘ blocked/.test(x)).length).toBe(2) // a gave-up form and a person's denial are not gate blocks
})
