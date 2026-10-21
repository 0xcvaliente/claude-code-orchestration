import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Agent, LogEntry, TriageInfo } from '../types'

const PANE = 'orchestration'
const ROLES = ['researcher', 'implementer', 'reviewer', 'integrator']
const agents = atom({ plugin: 'orchestration', key: 'agents' } as const, [])
const log = atom({ plugin: 'orchestration', key: 'log' } as const, [])
const tick = atom({ plugin: 'orchestration', key: 'tick' } as const, 0)
const main = atom({ plugin: 'orchestration', key: 'main' } as const, '')
const triage = atom({ plugin: 'orchestration', key: 'triage' } as const, null)

const GLYPH = { running: '●', pass: '✔', fail: '✖', done: '◆', queued: '◌' } as const
const SPIN = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const COLOR = { running: 'warning', pass: 'success', fail: 'error', done: 'subtle', queued: 'subtle' } as const
type State = keyof typeof GLYPH

const bare = (type: string) => type.split(':').pop() ?? type
// The brief names its slice on the first lines: "SLICE: s2", "FILES: a, b", "DEPENDS: s1, s3 | none".
const sliceOf = (prompt: string) => prompt.match(/^\s*SLICE:\s*(\S+)/m)?.[1]
const depsOf = (prompt: string) =>
  (prompt.match(/^\s*DEPENDS:\s*(.*)$/m)?.[1] ?? '').split(/[\s,;]+/).filter(d => d && !/^(none|-|n\/a)$/i.test(d))
const filesOf = (prompt: string) => (prompt.match(/^\s*FILES:\s*(.*)$/m)?.[1] ?? '').split(/[\s,;]+/).filter(Boolean).length
const statusOf = (answer: string): Agent['status'] => {
  const found = [...answer.matchAll(/^[ \t>*_`-]*STATUS:\**[ \t]*(pass|fail)\b/gim)].pop()?.[1]?.toLowerCase()
  return found === 'pass' || found === 'fail' ? found : 'done'
}
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
const short = (m: string) => m.replace(/^claude-/, '')
const family = (m: string) => (m.match(/opus|sonnet|haiku|fable/i)?.[0] ?? m).toLowerCase()
const FAMILY_COLOR: Record<string, string> = { opus: 'magenta', sonnet: 'yellow', haiku: 'cyan', fable: 'green' }
const familyColor = (m: string) => FAMILY_COLOR[family(m)] ?? 'white'
// Share bar: ▰ for the part of the maximum, ▱ for the rest.
const share = (n: number, max: number, w: number) => {
  const full = max ? Math.max(n ? 1 : 0, Math.round((w * n) / max)) : 0
  return '▰'.repeat(full) + '▱'.repeat(Math.max(0, w - full))
}
const ABBR: Record<string, string> = { researcher: 'scan', implementer: 'build', reviewer: 'review', integrator: 'merge' }
// A flow edge: amber while work moves through it, green once what feeds it is done, grey before that.
const edge = (moving: boolean, done: boolean) => (moving ? 'warning' : done ? 'success' : 'subtle')
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}~` : s)
// What an agent did, for the tasks table: its "Answer:" line, else the first report line that is not a heading,
// with absolute paths cut to their last two segments (bench/matrix).
const resultOf = (answer: string) => {
  const lines = answer
    .split('\n')
    .map(l => l.replace(/^[\s>*_`#-]+/, '').trim())
    .filter(l => l && !/^(STATUS|FINDINGS|OPEN|EVIDENCE|SUMMARY)\b/i.test(l))
  const line = lines.find(l => /^answer:/i.test(l))?.replace(/^answer:\s*/i, '') ?? lines[0] ?? ''
  return line.replace(/`/g, '').replace(/(?:\/[^\s/]+)+\/([^\s/]+\/[^\s/]+)/g, '$1')
}

// The router's verdict. The shape of a Bash result is not declared, so walk it for strings and look in each for a JSON object
// (npm may print banner lines first) whose mode and reason are the router's.
const ROUTE_CMD = /npm run (--silent )?route\b/
const commandOf = (e: unknown) => {
  const t = e as { command?: unknown; input?: { command?: unknown } }
  const c = t.command ?? t.input?.command
  return typeof c === 'string' ? c : ''
}
const MODES = ['plain', 'reviewed', 'orchestrate']
const stringsOf = (v: unknown, out: string[] = [], depth = 0): string[] => {
  if (out.length > 200 || depth > 8) return out
  if (typeof v === 'string') out.push(v)
  else if (Array.isArray(v)) for (const x of v) stringsOf(x, out, depth + 1)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) stringsOf(x, out, depth + 1)
  return out
}
const factsOf = (f: unknown): NonNullable<TriageInfo['facts']> | undefined => {
  const o = f as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return undefined
  const { filesToTouch, linesToChange, independentSlices, risky, code } = o
  return typeof filesToTouch === 'number' && typeof linesToChange === 'number' && typeof independentSlices === 'number' && typeof risky === 'boolean' && typeof code === 'boolean'
    ? { filesToTouch, linesToChange, independentSlices, risky, code }
    : undefined
}
const triageOf = (value: unknown): Omit<TriageInfo, 'at'> | undefined => {
  for (const text of stringsOf(value)) {
    const s = text.slice(0, 50_000)
    for (let i = s.indexOf('{'), tries = 0; i >= 0 && tries < 200; i = s.indexOf('{', i + 1), tries++) {
      let depth = 0
      let quoted = false
      let end = -1
      for (let j = i; j < s.length && end < 0; j++) {
        const c = s[j]
        if (quoted) quoted = c === '\\' ? (j++, true) : c !== '"'
        else if (c === '"') quoted = true
        else if (c === '{') depth++
        else if (c === '}' && --depth === 0) end = j
      }
      if (end < 0) continue
      try {
        const o = JSON.parse(s.slice(i, end + 1)) as Record<string, unknown>
        if (o && typeof o.reason === 'string' && MODES.includes(o.mode as string)) {
          const facts = factsOf(o.facts)
          return { mode: o.mode as TriageInfo['mode'], reason: o.reason, ...(facts ? { facts } : {}) }
        }
      } catch {
        // not JSON: try the next brace
      }
    }
  }
  return undefined
}
// With no verdict captured, the mode the agents imply.
const inferMode = (list: Agent[]): TriageInfo['mode'] | undefined => {
  if (list.some(a => a.role === 'implementer' || a.role === 'integrator' || a.label === 'plan review')) return 'orchestrate'
  if (list.some(a => a.role === 'reviewer')) return 'reviewed'
  return list.length ? 'orchestrate' : undefined
}
const MODE_COLOR = { plain: 'gray', reviewed: 'yellow', orchestrate: 'cyan' } as const

// One diagram node per slice: its implementer and reviewer(s) grouped, plus a queued ghost for a dependency not launched yet.
type Node = { id: string; deps: string[]; files: number; agents: Agent[] }
const nodesOf = (list: Agent[]): Map<string, Node> => {
  const map = new Map<string, Node>()
  for (const a of list) {
    if (!a.slice) continue
    const n = map.get(a.slice) ?? { id: a.slice, deps: [], files: 0, agents: [] }
    if (a.role !== 'reviewer') Object.assign(n, { deps: a.deps ?? [], files: a.files ?? 0 })
    n.agents.push(a)
    map.set(a.slice, n)
  }
  for (const n of [...map.values()]) for (const d of n.deps) if (!map.has(d)) map.set(d, { id: d, deps: [], files: 0, agents: [] })
  return map
}
const lastOf = (n: Node, role: string) => n.agents.filter(a => a.role === role).pop()
const stateOf = (n: Node): State => {
  if (!n.agents.length) return 'queued'
  if (n.agents.some(a => a.status === 'running')) return 'running'
  const review = lastOf(n, 'reviewer')
  if (review) return review.status
  const build = lastOf(n, 'implementer')
  if (build) return build.status === 'fail' ? 'fail' : 'done'
  return (n.agents[n.agents.length - 1] as Agent).status // a research or merge slice: its own report decides
}
// Stage chips of a card: build and review for a built slice, else the roles it ran.
const chipsOf = (n: Node, g: (s: State) => string) => {
  const roles = n.agents.some(a => a.role === 'implementer' || a.role === 'reviewer') ? ['implementer', 'reviewer'] : [...new Set(n.agents.map(a => a.role))]
  return roles.map(r => `${ABBR[r] ?? r} ${lastOf(n, r) ? g((lastOf(n, r) as Agent).status) : '-'}`).join(' ')
}
// Layer = longest chain of dependencies beneath the slice, so a slice sits right of everything it waits for.
const layersOf = (map: Map<string, Node>): Node[][] => {
  const depth = new Map<string, number>()
  const walk = (id: string, seen: string[]): number => {
    if (depth.has(id)) return depth.get(id) as number
    if (seen.includes(id)) return 0
    const d = Math.max(-1, ...(map.get(id)?.deps ?? []).map(x => walk(x, [...seen, id]))) + 1
    depth.set(id, d)
    return d
  }
  const layers: Node[][] = []
  for (const n of map.values()) (layers[walk(n.id, [])] ??= []).push(n)
  return layers.filter(Boolean)
}

// Exact height of a diagram card in rows, so the lines in the gutters can meet the middle of each card.
const cardRows = (n: Node) => 2 + 1 + 1 + 1 + Math.min(3, n.deps.length) + (n.deps.length > 3 ? 1 : 0)
const layerRows = (l: Node[]) => l.reduce((t, n) => t + cardRows(n), 0)
const centersOf = (layer: Node[]) => {
  let y = 0
  return layer.map(n => {
    const c = y + Math.floor(cardRows(n) / 2)
    y += cardRows(n)
    return c
  })
}

// Box-drawing lines between two layers: each source exits on the right, joins a vertical spine of its target, and enters
// the target's middle with an arrowhead. A dot runs along an edge whose target is running.
const MASK = ' ╵╷│╶└┌├╴┘┐┤─┴┬┼' // index = N(1) + S(2) + E(4) + W(8)
const rank = (c: string) => (c === 'warning' ? 3 : c === 'success' ? 2 : 1)
type GRow = { text: string; color: string; bold: boolean }
const gutterOf = (prev: Node[], next: Node[], map: Map<string, Node>, f: number): { width: number; rows: GRow[] } => {
  const ids = new Set(prev.map(p => p.id))
  const targets = next.map((t, i) => ({ t, i })).filter(x => x.t.deps.some(d => ids.has(d)))
  const width = Math.max(4, targets.length + 3)
  const height = Math.max(layerRows(prev), layerRows(next))
  const grid = Array.from({ length: height }, () => Array<number>(width).fill(0))
  const over = new Map<string, string>()
  const best: (string | undefined)[] = Array(height).fill(undefined)
  const dots = new Set<number>()
  const mark = (r: number, c: number, bits: number) => {
    const row = grid[r]
    if (row) row[c] = (row[c] ?? 0) | bits
  }
  const paint = (r: number, color: string) => {
    if (!best[r] || rank(color) > rank(best[r] as string)) best[r] = color
  }
  const pc = centersOf(prev)
  const nc = centersOf(next)
  targets.forEach(({ t, i }, k) => {
    const sx = 1 + k
    const rt = nc[i] as number
    const moving = stateOf(t) === 'running'
    for (const d of t.deps) {
      const pi = prev.findIndex(p => p.id === d)
      if (pi < 0) continue
      const rs = pc[pi] as number
      const color = edge(moving, ['pass', 'done'].includes(stateOf(map.get(d) as Node)))
      const path: [number, number][] = []
      for (let c = 0; c < sx; c++) {
        mark(rs, c, 4 | 8)
        path.push([rs, c])
      }
      mark(rs, sx, 8)
      const lo = Math.min(rs, rt)
      const hi = Math.max(rs, rt)
      for (let r = lo; r <= hi; r++) {
        mark(r, sx, (r > lo ? 1 : 0) | (r < hi ? 2 : 0))
        paint(r, color)
      }
      for (let r = rs; r !== rt + (rs <= rt ? 1 : -1); r += rs <= rt ? 1 : -1) path.push([r, sx]) // the dot walks source to target
      mark(rt, sx, 4)
      for (let c = sx + 1; c < width - 1; c++) {
        mark(rt, c, 4 | 8)
        path.push([rt, c])
      }
      over.set(`${rt},${width - 1}`, '▶')
      paint(rs, color)
      paint(rt, color)
      if (moving) {
        const [r, c] = path[f % path.length] as [number, number]
        over.set(`${r},${c}`, '●')
        dots.add(r)
      }
    }
  })
  const rows = Array.from({ length: height }, (_, r) => ({
    text: (grid[r] as number[]).map((m, c) => over.get(`${r},${c}`) ?? MASK[m]).join(''),
    color: best[r] ?? 'subtle',
    bold: dots.has(r),
  }))
  return { width, rows }
}

// A rail down the left of a layer, fed from above: it forks an arrowhead into the middle of every card in the layer.
const trunkOf = (layer: Node[], map: Map<string, Node>, f: number): GRow[] => {
  const centers = centersOf(layer)
  const lastC = centers[centers.length - 1] as number
  const colorOf = (n: Node) =>
    edge(stateOf(n) === 'running', n.deps.length ? n.deps.every(d => ['pass', 'done'].includes(stateOf(map.get(d) as Node))) : true)
  const anyMoving = layer.some(n => stateOf(n) === 'running')
  return Array.from({ length: layerRows(layer) }, (_, r) => {
    const k = centers.indexOf(r)
    const dot = anyMoving && r === f % (lastC + 1) && k < 0 && r < lastC
    const text = k >= 0 ? (r === lastC ? ' └▶' : ' ├▶') : r < lastC ? (dot ? ' ● ' : ' │ ') : '   '
    // a row is as live as the busiest card the rail still has to reach below it
    const reach = layer.filter((_, i) => (centers[i] as number) >= r).map(colorOf)
    const color = reach.sort((a, b) => rank(b) - rank(a))[0] ?? 'subtle'
    return { text, color, bold: dot || (k >= 0 && stateOf(layer[k] as Node) === 'running') }
  })
}

// A join under the diagram: the columns that hold a final slice drop a stub onto one bus that ends in a single arrow.
const busOf = (cols: number[]): { rows: string[]; mid: number } => {
  const lo = Math.min(...cols)
  const hi = Math.max(...cols)
  const mid = Math.floor((lo + hi) / 2)
  const blank = () => Array<string>(hi + 1).fill(' ')
  const line = blank()
  const tip = blank()
  for (let c = lo; c <= hi; c++) {
    const stub = cols.includes(c)
    line[c] =
      lo === hi ? '│' : c === mid && stub ? (c === lo ? '├' : c === hi ? '┤' : '┼') : c === mid ? '┬' : c === lo ? '└' : c === hi ? '┘' : stub ? '┴' : '─'
  }
  tip[mid] = '▼'
  return { rows: [line.join(''), tip.join('')], mid }
}

type PaneApi = {
  ui: { open(o: { id: string; title: string }): Promise<{ isPlaced: boolean }>; toast(text: string, o: { timeoutMs: number }): unknown }
}

let told = false // the one-line hint for a terminal too narrow to seat the pane by itself
// Unasked, a pane seats only from 144 columns; on a narrower terminal it waits, so say how to open it.
const openPane = async ($: PaneApi) => {
  const opened = await $.ui.open({ id: PANE, title: 'Orchestration' })
  if (!opened.isPlaced && !told) {
    told = true
    void $.ui.toast('Orchestration is running: type /orchestration to see the agents and slice diagram.', { timeoutMs: 8000 })
  }
}

export const register: Register = on => {
  let timer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'orchestration', description: 'Show the orchestration agents, slice diagram and token usage in a pane' })
    return next(e)
  })

  on('command.run', { command: 'orchestration' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Orchestration', focus: true })
    return { text: 'Orchestration pane opened; use the arrow keys to scroll, Esc to return to the prompt.' }
  })

  // An agent starts: record it, open the pane the first time, and redraw while any agent runs.
  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const role = bare(e.subagentType)
    if (!ROLES.includes(role) || !('agentId' in spawned) || !spawned.agentId) return spawned
    const plan = /^\s*PLAN REVIEW/m.test(e.prompt)
    const slice = sliceOf(e.prompt)
    const agent: Agent = {
      id: spawned.agentId, role, model: spawned.model, slice, label: slice ?? (plan ? 'plan review' : e.description),
      deps: depsOf(e.prompt), files: filesOf(e.prompt), startedAt: await $.clock.now(), status: 'running',
      tokens: 0, inTokens: 0, outTokens: 0, cacheTokens: 0,
    }
    // A spawn with nothing running and the last agent done over two minutes ago starts a new run: drop the old diagram.
    const fresh = (list: Agent[]) =>
      list.some(a => a.status === 'running') || agent.startedAt - Math.max(0, ...list.map(a => a.endedAt ?? 0)) < 120_000 ? list : []
    const before = await read($, agents)
    if (fresh(before).length === 0 && before.length > 0) {
      // a verdict later than the last agent's end belongs to this new run: keep it (and its log line); an older one is dropped
      const kept = await read($, triage)
      const keep = kept && kept.at > Math.max(0, ...before.map(a => a.endedAt ?? 0)) ? kept : null
      await update($, triage, () => keep)
      await update($, log, () => (keep ? [{ at: keep.at, kind: 'triage', role: 'router', label: keep.mode, model: '' } as LogEntry] : []))
      told = false
    }
    await update($, agents, list => [...fresh(list), agent].slice(-80))
    await update($, main, () => e.parentModel)
    await update($, log, l => [...l, { at: agent.startedAt, kind: 'start', role, label: agent.label, model: agent.model } as LogEntry].slice(-60))
    await openPane($)
    // Redraw four times a second for the animation while an agent runs or finished under 2.5 s ago, then stop.
    const pulse = async () => {
      const list = await read($, agents)
      const t = await $.clock.now()
      if (!list.some(a => a.status === 'running') && list.every(a => t - (a.endedAt ?? 0) > 2500)) {
        timer?.cancel()
        timer = undefined
        return
      }
      await update($, tick, n => n + 1)
    }
    timer ??= $.clock.every(250, () => {
      void pulse()
    })
    return spawned
  })

  // What a running agent is doing: its latest tool and target. The main loop's `npm run route` also gives the pane its triage.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      const t = e as unknown as Record<string, unknown>
      const target = String(t.command ?? t.file_path ?? t.path ?? t.pattern ?? '').replace(/\s+/g, ' ').trim()
      const tool = cut(target ? `${e.tool} ${target}` : e.tool, 30)
      await update($, agents, list => list.map(a => (a.id === id && a.status === 'running' ? { ...a, tool } : a)))
    }
    if (e.agentId || e.tool !== 'Bash' || !ROUTE_CMD.test(commandOf(e))) return next(e)
    // The router ran in the main loop: take its verdict from the result, and hand the result on untouched.
    const ran = await next(e)
    try {
      const found = triageOf(ran)
      if (found) {
        const at = await $.clock.now()
        await update($, triage, () => ({ at, ...found }))
        await update($, log, l => [...l, { at, kind: 'triage', role: 'router', label: found.mode, model: '' } as LogEntry].slice(-60))
        await openPane($)
      }
    } catch {
      // a verdict the pane cannot read must never change the tool call
    }
    return ran
  })

  // An agent finishes: its report's STATUS line and first result line, its tokens and its time.
  on('turn.complete', async ($, e, next) => {
    const id = e.agentId
    if (id) {
      const now = await $.clock.now()
      const u = e.usage
      const inT = u?.input_tokens ?? 0
      const outT = u?.output_tokens ?? 0
      const cacheT = (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)
      const status = statusOf(e.answer)
      const result = resultOf(e.answer)
      const list = await update($, agents, l =>
        l.map(a =>
          a.id === id
            ? {
                ...a, status, endedAt: now, tool: undefined, tokens: a.tokens + inT + outT + cacheT, inTokens: a.inTokens + inT,
                outTokens: a.outTokens + outT, cacheTokens: a.cacheTokens + cacheT, result: result || a.result,
              }
            : a,
        ),
      )
      const one = list.find(a => a.id === id)
      if (one) {
        const entry: LogEntry = { at: now, kind: status, role: one.role, label: one.label, model: one.model, ms: now - one.startedAt, tokens: one.tokens }
        await update($, log, l => [...l, entry].slice(-60))
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const lines = await read($, log)
    const orchestrator = await read($, main)
    const verdict = await read($, triage)
    const f = await read($, tick)
    const now = await $.clock.now()
    const g = (st: State) => (st === 'running' ? (SPIN[f % SPIN.length] as string) : GLYPH[st])
    const running = list.filter(a => a.status === 'running').length
    const failed = list.filter(a => a.status === 'fail').length
    const total = list.reduce((n, a) => n + a.tokens, 0)
    const first = list[0]?.startedAt ?? now
    const last = running ? now : Math.max(first, ...list.map(a => a.endedAt ?? 0))
    const width = (e.props as { bodyColumns?: number } | undefined)?.bodyColumns ?? 44
    const wide = width >= 64
    const models = [...new Set([orchestrator, ...list.map(a => a.model)].filter(Boolean))]
    const boxW = Math.min(width - 1, 46)

    // A connector down the page, x cells in from the left: a dot runs along it while work moves, green once its source is done.
    const down = (moving: boolean, ok: boolean, x: number) => {
      const pad = ' '.repeat(Math.max(0, x))
      const dot = f % 3
      return (
        <Box flexDirection="column">
          <Text color={edge(moving, ok)} bold={moving && dot === 0}>{pad}{moving && dot === 0 ? '●' : '│'}</Text>
          <Text color={edge(moving, ok)} bold={moving && dot === 1}>{pad}{moving && dot === 1 ? '●' : '▼'}</Text>
        </Box>
      )
    }

    // Pipeline: triage -> plan -> plan review -> build -> review -> merge, each a box with a progress bar and the models in it.
    const phase = (name: string, group: Agent[], mode?: string) => {
      const done = group.filter(a => a.status !== 'running').length
      const state: State = !group.length ? 'queued' : group.some(a => a.status === 'running') ? 'running' : group.some(a => a.status === 'fail') ? 'fail' : 'pass'
      return { name, group, done, n: group.length, state, mode }
    }
    const mode = verdict?.mode ?? inferMode(list)
    const stages = [
      { ...phase('triage', []), state: (mode ? 'pass' : 'queued') as State, mode },
      phase('plan', list.filter(a => a.role === 'researcher')),
      phase('plan review', list.filter(a => a.label === 'plan review')),
      phase('build', list.filter(a => a.role === 'implementer')),
      phase('review', list.filter(a => a.role === 'reviewer' && a.label !== 'plan review')),
      phase('merge', list.filter(a => a.role === 'integrator')),
    ]
    const cols = width >= 100 ? 6 : width >= 40 ? 3 : 2
    const pw = Math.max(6, Math.floor((width - 3 * (cols - 1) - 1) / cols))
    const stageRows = Array.from({ length: Math.ceil(stages.length / cols) }, (_, r) => stages.slice(r * cols, r * cols + cols))
    // The return rail from the end of one row to the start of the next: down from the middle of the last box, left, then into the first.
    const railOf = (lastStage: (typeof stages)[number]) => {
      const first = Math.floor(pw / 2)
      const lastX = (cols - 1) * (pw + 3) + first
      const color = edge(lastStage.state === 'running', lastStage.state === 'pass')
      return [
        { text: `${' '.repeat(lastX)}│`, color },
        { text: `${' '.repeat(first)}┌${'─'.repeat(Math.max(0, lastX - first - 1))}┘`, color },
        { text: `${' '.repeat(first)}▼`, color },
      ]
    }

    // Slice diagram: a column per dependency layer, joined by routed lines; stacked top to bottom when the columns do not fit.
    const map = nodesOf(list)
    const layers = layersOf(map)
    const colMax = width >= 100 ? 26 : 19
    // Side by side only when every layer, the 3-cell rail and the routing gutters fit across at 14 cells a card or more.
    const gutterW = layers.map((l, i) => (i === 0 ? 0 : Math.max(4, l.filter(n => n.deps.some(d => (layers[i - 1] as Node[]).some(p => p.id === d))).length + 3)))
    const spare = width - 3 - gutterW.reduce((t, w) => t + w, 0)
    const vertical = layers.length > 1 && Math.floor(spare / layers.length) < 14
    const colW = vertical ? Math.max(10, Math.min(30, width - 5)) : Math.max(10, Math.min(colMax, Math.floor(spare / Math.max(1, layers.length))))
    // One cell per task in a stage: the build cell is a slice's implementer, the review cell its reviewer, others one per agent.
    const stOf = (a?: Agent): State => (a ? a.status : 'queued')
    const cellsFor = (name: string, group: Agent[]): State[] => {
      const nodes = [...map.values()]
      if (name === 'build') return nodes.filter(n => n.agents.every(a => a.role === 'implementer' || a.role === 'reviewer')).map(n => stOf(lastOf(n, 'implementer')))
      if (name === 'review') return nodes.filter(n => n.agents.some(a => a.role === 'implementer' || a.role === 'reviewer')).map(n => stOf(lastOf(n, 'reviewer')))
      return group.map(a => a.status)
    }
    // The most recent cells that fit in w, then `+N` for the hidden ones; an empty stage shows dim dots.
    const cellRow = (cells: State[], w: number) => {
      if (!cells.length) return <Text dimColor wrap="truncate-end">{'·'.repeat(w)}</Text>
      let shown = Math.min(cells.length, w)
      while (shown > 0 && cells.length > shown && shown + 1 + String(cells.length - shown).length > w) shown--
      const hidden = cells.length - shown
      return (
        <Box>
          {cells.slice(cells.length - shown).map(st => (
            <Text color={COLOR[st]}>{g(st)}</Text>
          ))}
          {hidden > 0 && <Text dimColor>{`+${hidden}`}</Text>}
        </Box>
      )
    }
    const satisfied = (id: string) => ['pass', 'done'].includes(stateOf(map.get(id) as Node))
    const gutters = layers.map((l, i) => (i > 0 && !vertical ? gutterOf(layers[i - 1] as Node[], l, map, f) : undefined))
    const card = (n: Node) => {
      const s = stateOf(n)
      const live = n.agents.find(a => a.status === 'running')
      const spent = n.agents.reduce((t, a) => t + a.tokens, 0)
      const t0 = n.agents[0]?.startedAt ?? now
      const t1 = s === 'running' ? now : Math.max(t0, ...n.agents.map(a => a.endedAt ?? 0))
      const fresh = n.agents.some(a => a.endedAt && now - a.endedAt < 2000)
      const model = n.agents[0]?.model ?? ''
      const tm = n.agents.length ? clock(t1 - t0) : ''
      return (
        <Box
          borderStyle={fresh ? 'double' : 'round'}
          borderColor={COLOR[s]}
          borderDimColor={s === 'running' && f % 4 < 2}
          flexDirection="column"
          width={colW}
        >
          <Text bold color={COLOR[s]} wrap="truncate-end">
            {g(s)} {cut(n.id, colW - 5 - tm.length).padEnd(colW - 5 - tm.length)} {tm}
          </Text>
          <Text color={model ? familyColor(model) : undefined} wrap="truncate-end">{chipsOf(n, g)}</Text>
          <Text dimColor wrap="truncate-end">{live?.tool ? cut(live.tool, colW - 4) : n.agents.length ? `${tokens(spent)} tokens` : 'queued'}</Text>
          {n.deps.slice(0, 3).map(d => (
            <Text color={satisfied(d) ? 'success' : 'subtle'} wrap="truncate-end">◀ {cut(d, colW - 6)}</Text>
          ))}
          {n.deps.length > 3 && <Text dimColor>◀ +{n.deps.length - 3} more</Text>}
        </Box>
      )
    }

    // Column x offsets and the bus that joins the final slices into sign-off.
    const xs: number[] = []
    let x0 = 3
    layers.forEach((_, i) => {
      xs.push(x0)
      x0 += colW + (gutters[i + 1]?.width ?? 0)
    })
    const needed = new Set(layers.flatMap(l => l.flatMap(n => n.deps)))
    const leafCols = vertical
      ? [3 + Math.floor(colW / 2)]
      : layers.flatMap((l, i) => (!needed.has((l[l.length - 1] as Node).id) ? [(xs[i] as number) + Math.floor(colW / 2)] : []))
    const bus = leafCols.length ? busOf(leafCols) : undefined

    // Tasks: one row per slice (or per agent without one) with its tokens, time, and what it reported.
    type Task = { key: string; label: string; state: State; tokens: number; ms: number; result: string; tool?: string }
    const tasks: Task[] = [
      ...[...map.values()]
        .filter(n => n.agents.length)
        .map(n => {
          const s = stateOf(n)
          const t0 = n.agents[0]?.startedAt ?? now
          return {
            key: n.id, label: n.id, state: s, tokens: n.agents.reduce((t, a) => t + a.tokens, 0),
            ms: (s === 'running' ? now : Math.max(t0, ...n.agents.map(a => a.endedAt ?? 0))) - t0,
            result: [...n.agents].reverse().find(a => a.result)?.result ?? '', tool: n.agents.find(a => a.status === 'running')?.tool,
          }
        }),
      ...list
        .filter(a => !a.slice)
        .map(a => ({ key: a.id, label: a.label, state: a.status as State, tokens: a.tokens, ms: (a.endedAt ?? now) - a.startedAt, result: a.result ?? '', tool: a.tool })),
    ]
    const finished = tasks.filter(t => t.state !== 'running' && t.state !== 'queued').length
    const maxTok = Math.max(0, ...tasks.map(t => t.tokens))
    const barW = wide ? 8 : 5
    const taskW = Math.max(6, Math.min(28, width - barW - 15))
    const byModel = [...new Set(list.map(a => a.model))].map(m => ({ m, tokens: list.filter(a => a.model === m).reduce((t, a) => t + a.tokens, 0) }))
    // The stacked bar: every model with tokens gets one cell, the rest are shared by tokens (largest remainder), summing to stackW.
    const stackW = Math.max(10, Math.min(width - 2, 40))
    const stack = (() => {
      const used = byModel.filter(x => x.tokens > 0)
      const spare = Math.max(0, stackW - used.length)
      const exact = used.map(x => (total ? (spare * x.tokens) / total : 0))
      const cells = exact.map(v => 1 + Math.floor(v))
      let left = stackW - cells.reduce((t, c) => t + c, 0)
      const order = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((p, q) => q.r - p.r)
      for (let k = 0; left > 0 && order.length; k++, left--) cells[(order[k % order.length] as { i: number }).i]!++
      return used.map((x, i) => ({ m: x.m, cells: cells[i] as number }))
    })()
    const inTotal = list.reduce((t, a) => t + a.inTokens, 0)
    const outTotal = list.reduce((t, a) => t + a.outTokens, 0)
    const cacheTotal = list.reduce((t, a) => t + a.cacheTokens, 0)

    // Session log: time since the run began, a mark, what, how long it took and what it cost.
    const logN = wide ? 10 : 7
    const shownLog = lines.slice(-logN)
    const logW = Math.max(10, width - 2)
    const LOGMARK = { start: '▶', pass: '✔', fail: '✖', done: '◆', triage: '◇' } as const
    const LOGCOLOR = { start: 'subtle', pass: 'success', fail: 'error', done: 'subtle', triage: 'subtle' } as const

    const signed = list.length > 0 && !running
    const mainState: State = running ? 'running' : !list.length ? 'queued' : failed ? 'fail' : 'pass'
    const dots = '.'.repeat(1 + (f % 3))
    const bodyRows = (e.props as { scroll?: { bodyRows?: number } } | undefined)?.scroll?.bodyRows ?? 0
    const diagramRows = vertical ? layers.reduce((t, l) => t + layerRows(l) + 1, 0) : Math.max(0, ...layers.map(layerRows))
    const needsScroll = bodyRows > 0 && 26 + (verdict || list.length ? 5 : 0) + stageRows.length * 5 + (stageRows.length - 1) * 3 + diagramRows + tasks.length * 2 + byModel.length + shownLog.length > bodyRows

    return (
      <Box flexDirection="column">
        {needsScroll && <Text dimColor>↑↓ scroll · click the pane or /orchestration</Text>}
        {list.length === 0 && <Text dimColor>No orchestration agents yet.</Text>}
        {list.length > 0 && (
          <Box flexWrap="wrap">
            {models.map(m => (
              <Box marginRight={2}>
                <Text color={familyColor(m)} wrap="truncate-end">■ {short(m)}</Text>
              </Box>
            ))}
          </Box>
        )}
        {list.length > 0 && (
          <Box borderStyle={signed ? 'double' : 'bold'} borderColor={COLOR[mainState]} flexDirection="column" width={boxW}>
            <Text bold color={orchestrator ? familyColor(orchestrator) : undefined} wrap="truncate-end">
              {g(mainState)} {short(orchestrator || 'main')} · orchestrator
            </Text>
            <Text color={COLOR[mainState]} wrap="truncate-end">
              {running ? `dispatching${dots} ${running} running` : failed ? `signed off with ${failed} failed` : 'all agents passed'}
            </Text>
            <Text dimColor wrap="truncate-end">
              {list.length} agents · {tokens(total)} tokens · {clock(last - first)}
            </Text>
          </Box>
        )}
        {(verdict || list.length > 0) && mode && (
          <Box borderStyle="round" borderColor={MODE_COLOR[mode]} flexDirection="column" width={boxW}>
            <Text bold color={MODE_COLOR[mode]} wrap="truncate-end">triage · {mode}</Text>
            {verdict?.facts && (
              <Text wrap="truncate-end">files {verdict.facts.filesToTouch} · lines {verdict.facts.linesToChange} · slices {verdict.facts.independentSlices}</Text>
            )}
            {verdict?.facts && <Text wrap="truncate-end">risky {verdict.facts.risky ? 'yes' : 'no'} · code {verdict.facts.code ? 'yes' : 'no'}</Text>}
            <Text dimColor wrap="truncate-end">{verdict ? verdict.reason : '(inferred from the agents)'}</Text>
          </Box>
        )}
        {list.length > 0 && down(running > 0, true, 1)}
        {list.length > 0 &&
          stageRows.map((row, r) => (
            <Box flexDirection="column">
              {r > 0 && (
                <Box flexDirection="column">
                  {railOf((stageRows[r - 1] as typeof stages)[cols - 1] as (typeof stages)[number]).map(x => (
                    <Text color={x.color}>{x.text}</Text>
                  ))}
                </Box>
              )}
              <Box>
                {row.map((p, j) => {
                  const before = stages[r * cols + j - 1]
                  const moving = p.state === 'running'
                  return (
                    <Box>
                      {j > 0 && (
                        <Box flexDirection="column" justifyContent="center" width={3}>
                          <Text color={edge(moving, before?.state === 'pass')} bold={moving}>
                            {moving ? ['●─▶', '─●▶', '──▶'][f % 3] : '──▶'}
                          </Text>
                        </Box>
                      )}
                      <Box borderStyle="round" borderColor={COLOR[p.state]} borderDimColor={moving && f % 4 < 2} flexDirection="column" width={pw}>
                        <Text bold color={COLOR[p.state]} wrap="truncate-end">{g(p.state)} {p.name}</Text>
                        {p.name === 'triage' ? <Text color={COLOR[p.state]} wrap="truncate-end">{'▰'.repeat(Math.max(3, pw - 4))}</Text> : cellRow(cellsFor(p.name, p.group), Math.max(3, pw - 4))}
                        <Text dimColor wrap="truncate-end">
                          {p.name === 'triage' ? (p.mode ?? '-') : p.n ? `${p.done}/${p.n} ${[...new Set(p.group.map(a => family(a.model)))].join('+')}` : '-'}
                        </Text>
                      </Box>
                    </Box>
                  )
                })}
              </Box>
            </Box>
          ))}
        {layers.length > 0 && down(running > 0, true, 1)}
        {vertical ? (
          <Box flexDirection="column">
            {layers.map((layer, i) => (
              <Box flexDirection="column">
                {i > 0 && down(layer.some(n => stateOf(n) === 'running'), layer.every(n => n.deps.every(satisfied)), 1)}
                <Box>
                  <Box flexDirection="column" width={3}>
                    {trunkOf(layer, map, f).map(r => (
                      <Text color={r.color} bold={r.bold}>{r.text}</Text>
                    ))}
                  </Box>
                  <Box flexDirection="column">{layer.map(card)}</Box>
                </Box>
              </Box>
            ))}
          </Box>
        ) : (
          <Box>
            {layers.map((layer, i) => {
              const gut = i === 0 ? { width: 3, rows: trunkOf(layer, map, f) } : gutters[i]
              return (
                <Box>
                  {gut && (
                    <Box flexDirection="column" width={gut.width}>
                      {gut.rows.map(r => (
                        <Text color={r.color} bold={r.bold}>{r.text}</Text>
                      ))}
                    </Box>
                  )}
                  <Box flexDirection="column">
                    {layer.map(card)}
                    {!needed.has((layer[layer.length - 1] as Node).id) &&
                      Array.from({ length: Math.max(0, diagramRows - layerRows(layer)) }, () => (
                        <Text color={edge(running > 0, signed)}>{' '.repeat(Math.floor(colW / 2))}│</Text>
                      ))}
                  </Box>
                </Box>
              )
            })}
          </Box>
        )}
        {bus && bus.rows.map(r => <Text color={edge(running > 0, signed)}>{r}</Text>)}
        {list.length > 0 && (
          <Box marginLeft={Math.min(Math.max(0, (bus?.mid ?? 0) - Math.floor(boxW / 2)), Math.max(0, width - boxW))} borderStyle={signed ? 'double' : 'round'} borderColor={signed ? COLOR[mainState] : 'gray'} flexDirection="column" width={boxW}>
            <Text bold color={signed ? COLOR[mainState] : undefined} wrap="truncate-end">
              {signed ? GLYPH[mainState] : '◌'} sign off · {short(orchestrator || 'main')}
            </Text>
            <Text dimColor wrap="truncate-end">
              {signed ? `${list.length - failed} passed · ${failed} failed` : 'waiting for agents · verified findings only'}
            </Text>
          </Box>
        )}
        {tasks.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold wrap="truncate-end">
              tasks · {finished}/{tasks.length} done · {tokens(total)} tokens
            </Text>
            {tasks.map(t => (
              <Box flexDirection="column">
                <Text color={COLOR[t.state]} wrap="truncate-end">
                  {g(t.state)} {cut(t.label, taskW).padEnd(taskW)} {share(t.tokens, maxTok, barW)} {tokens(t.tokens).padStart(5)} {clock(t.ms)}
                </Text>
                {(t.result || t.tool) && <Text dimColor wrap="truncate-end">  ↳ {t.state === 'running' && t.tool ? t.tool : t.result}</Text>}
              </Box>
            ))}
            {total > 0 && (
              <Text dimColor wrap="truncate-end">
                in {tokens(inTotal)} · out {tokens(outTotal)} · cache {tokens(cacheTotal)}
              </Text>
            )}
          </Box>
        )}
        {byModel.length > 0 && total > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>usage by model</Text>
            <Box>
              {stack.map(x => (
                <Text color={familyColor(x.m)}>{'█'.repeat(x.cells)}</Text>
              ))}
            </Box>
            {byModel.map(({ m, tokens: n }) => (
              <Text color={familyColor(m)} wrap="truncate-end">
                ■ {short(m).slice(0, 12).padEnd(12)} {tokens(n).padStart(5)} {Math.round((100 * n) / total)}%
              </Text>
            ))}
            <Text dimColor>agents only; the orchestrator's own tokens are not counted</Text>
          </Box>
        )}
        {shownLog.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>session log</Text>
            {shownLog.map(l => {
              const text =
                l.kind === 'triage'
                  ? `triage ${l.label}`
                  : `${l.label} ${l.kind === 'start' ? `started · ${short(l.model)}` : `${ABBR[l.role] ?? l.role} · ${clock(l.ms ?? 0)} · ${tokens(l.tokens ?? 0)}`}`
              return (
                <Text color={LOGCOLOR[l.kind]} wrap="truncate-end">
                  {clock(Math.max(0, l.at - first))} {LOGMARK[l.kind]} {cut(text, logW)}
                </Text>
              )
            })}
          </Box>
        )}
      </Box>
    )
  })
}
