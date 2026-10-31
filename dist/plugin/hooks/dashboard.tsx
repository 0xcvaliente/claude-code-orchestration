import { atom, read, update } from 'claude-code'
import type { Hook, Register, Timer } from 'claude-code'

import type { Agent, LogEntry, Plan, TriageInfo, Used, Work } from '../types'

const PANE = 'orchestration'
const ROLES = ['researcher', 'implementer', 'reviewer', 'integrator']
const NO_USE: Used = { skills: [], connectors: [], agents: {}, tools: {}, edited: [], read: [] }
const agents = atom({ plugin: 'orchestration', key: 'agents' } as const, [])
const log = atom({ plugin: 'orchestration', key: 'log' } as const, [])
const tick = atom({ plugin: 'orchestration', key: 'tick' } as const, 0)
const main = atom({ plugin: 'orchestration', key: 'main' } as const, '')
const triage = atom({ plugin: 'orchestration', key: 'triage' } as const, null)
const workAtom = atom({ plugin: 'orchestration', key: 'work' } as const, null)
const planAtom = atom({ plugin: 'orchestration', key: 'plan' } as const, null)
const usedAtom = atom({ plugin: 'orchestration', key: 'used' } as const, NO_USE)

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
// The orchestrator's plan, from its PLAN REVIEW brief: every SLICE line (the journal's pattern, so bullets and bold pass) is a planned slice, in order.
// Its goal is the rest of that line, else the first GOAL line under it. "plan" is the review's own SLICE line, not a slice.
const planOf = (brief: string): Plan['slices'] => {
  const out: Plan['slices'] = []
  let cur: Plan['slices'][number] | undefined
  for (const line of brief.split('\n')) {
    const m = line.match(/^[ \t>*_`#-]*SLICE:\**[ \t]*[`*]*([^\s`'"*]+)[`*]*(.*)$/i)
    if (m) {
      const id = (m[1] as string).replace(/[:,;.]+$/, '')
      const rest = (m[2] as string).replace(/^[\s*`_:|—–-]+/, '').trim()
      const own = !!id && id.toLowerCase() !== 'plan'
      cur = own ? out.find(s => s.id === id) : undefined
      if (own && !cur) out.push((cur = { id }))
      if (cur && rest && !cur.goal) cur.goal = rest
      continue
    }
    const goal = line.match(/^[ \t>*_`-]*GOAL:\**[ \t]*(.+)$/i)?.[1]?.trim()
    if (goal && cur && !cur.goal) cur.goal = goal
  }
  return out
}

// What the session used, for "used in this session": MCP servers by their name in the tool (`mcp__claude_ai_Google_Drive__x` is "Google Drive"),
// built-in tools by count, and the files the file tools read or changed. The Agent and Skill tools are left to agent.spawn and skill.prompt.
const CAP = 300
const add = (xs: string[], x: string) => (xs.includes(x) ? xs : [...xs, x].slice(-CAP))
const serverOf = (tool: string) => tool.match(/^mcp__(.+?)__/)?.[1]?.replace(/^(claude_ai|plugin)_/, '').replace(/_/g, ' ')
const CHANGES = ['Edit', 'Write', 'NotebookEdit']
const usedBy = (u: Used, e: Record<string, unknown>): Used => {
  const tool = String(e.tool ?? '')
  const server = serverOf(tool)
  if (server) return { ...u, connectors: add(u.connectors, server) }
  if (!tool || tool === 'Agent' || tool === 'Task' || tool === 'Skill') return u
  const out = { ...u, tools: { ...u.tools, [tool]: (u.tools[tool] ?? 0) + 1 } }
  const path = typeof e.file_path === 'string' ? e.file_path : typeof e.notebook_path === 'string' ? e.notebook_path : ''
  if (path && CHANGES.includes(tool)) return { ...out, edited: add(out.edited, path), read: out.read.filter(p => p !== path) }
  if (path && tool === 'Read' && !out.edited.includes(path)) return { ...out, read: add(out.read, path) }
  return out
}
const named = (counts: Record<string, number>) => Object.entries(counts).sort((p, q) => q[1] - p[1]).map(([k, n]) => `${k} ${n}`)
const base = (path: string) => path.split('/').filter(Boolean).pop() ?? path
// Names joined by " · " that fit in w, then "+N" for the rest.
const fitted = (names: string[], w: number) => {
  let shown = names.length
  const text = (k: number) => names.slice(0, k).join(' · ') + (k < names.length ? `${k ? ' · ' : ''}+${names.length - k}` : '')
  while (shown > 1 && text(shown).length > w) shown--
  return text(shown)
}
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
    .map(l => {
      // a bold line (`**GAPS:**`) loses both markers; a line that merely ends in `_` or `*` (`__init__`, `src/**`) is left alone
      const t = l.replace(/^[\s>#-]+/, '').trim()
      const bold = /^(\*\*|__)/.exec(t)?.[1]
      return (bold && t.endsWith(bold) ? t.slice(0, -bold.length) : t).replace(/^[\s>*_`#-]+/, '').trim()
    })
    .filter(l => l && !/^(STATUS|FINDINGS|OPEN|EVIDENCE|SUMMARY)\b/i.test(l) && !/^GAPS:?$/i.test(l))
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
// The stage each route enters first (3 = build, 1 = plan), and what the chosen route's box says about the run.
const ENTRY = { plain: 3, reviewed: 3, orchestrate: 1 } as const
const WORD: Record<State, string> = { running: 'running', pass: 'passed', fail: 'failed', done: 'stopped', queued: 'chosen' }
// A line from column a (coming from above) to column b (going down), as one row of box-drawing characters.
const elbow = (a: number, b: number) =>
  a === b ? `${' '.repeat(a)}│` : b > a ? `${' '.repeat(a)}└${'─'.repeat(b - a - 1)}┐` : `${' '.repeat(b)}┌${'─'.repeat(a - b - 1)}┘`

// One diagram node per attempt of a slice: its implementer and reviewer(s) grouped, plus a queued ghost for a dependency not launched yet.
// A new attempt starts with a non-reviewer agent that starts at or after the end of a failed agent of the slice; the first keeps the slice id,
// later ones are "X ↻2", "X ↻3". An attempt waits for the one before it (`retryOf`), and a dependent of the slice waits for the latest (`next` chains forward).
type Node = {
  id: string; slice: string; attempt: number; of: number; retryOf?: string; next?: string; isNew?: boolean
  deps: string[]; files: number; agents: Agent[]
}
const attemptId = (slice: string, k: number) => (k > 1 ? `${slice} ↻${k}` : slice)
// A queued ghost card stands in for a dependency not launched yet; `ghosts` false (the run is signed off) leaves them out, so a dependency
// on work from an earlier run does not hang around as a queued card.
const nodesOf = (list: Agent[], ghosts = true): Map<string, Node> => {
  const map = new Map<string, Node>()
  const bySlice = new Map<string, Agent[][]>()
  for (const a of list) {
    if (!a.slice) continue
    const groups = bySlice.get(a.slice) ?? []
    let cur = groups[groups.length - 1]
    if (!cur || (a.role !== 'reviewer' && cur.some(x => x.status === 'fail' && x.endedAt !== undefined && a.startedAt >= x.endedAt))) groups.push((cur = []))
    cur.push(a)
    bySlice.set(a.slice, groups)
  }
  const firstFail = Math.min(Infinity, ...list.filter(a => a.status === 'fail' && a.endedAt !== undefined).map(a => a.endedAt as number))
  for (const [slice, groups] of bySlice)
    groups.forEach((g, i) => {
      const last = [...g].reverse().find(a => a.role !== 'reviewer')
      map.set(attemptId(slice, i + 1), {
        id: attemptId(slice, i + 1), slice, attempt: i + 1, of: groups.length, ...(i ? { retryOf: attemptId(slice, i) } : {}),
        ...(i < groups.length - 1 ? { next: attemptId(slice, i + 2) } : {}), ...(i === 0 && (g[0] as Agent).startedAt >= firstFail ? { isNew: true } : {}),
        // a dependency on a slice that was retried waits for its latest attempt
        deps: (last?.deps ?? []).map(d => attemptId(d, bySlice.get(d)?.length ?? 1)), files: last?.files ?? 0, agents: g,
      })
    })
  if (ghosts) for (const n of [...map.values()]) for (const d of n.deps) if (!map.has(d)) map.set(d, { id: d, slice: d, attempt: 1, of: 1, deps: [], files: 0, agents: [] })
  return map
}
// What a node waits for: the attempt before it, then its dependencies.
const parentsOf = (n: Node) => (n.retryOf ? [n.retryOf, ...n.deps] : n.deps)
// An id names a slice or an attempt; a lookup for a retried slice lands on its latest attempt.
const resolve = (map: Map<string, Node>, id: string) => {
  let n = map.get(id)
  while (n?.next && map.get(n.next)) n = map.get(n.next)
  return n
}
// A dependency is satisfied when its slice is built (or reviewed) and passed; one with no card (a ghost left out once the run is signed off) is not.
const satisfiedIn = (map: Map<string, Node>, id: string) => {
  const n = resolve(map, id)
  return !!n && ['pass', 'done'].includes(stateOf(n))
}
// The retry connector into an attempt: amber while it runs, green once it passed, red while it failed or is unresolved.
const retryTone = (n: Node) => {
  const s = stateOf(n)
  return s === 'running' ? 'warning' : s === 'pass' || s === 'done' ? 'success' : 'error'
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
// A failure a later attempt made good, keyed by node id (a failed attempt that a later attempt of the slice, or else a later slice depending on it
// that started after it ended, passed) or, for an agent with no slice (a plan review), by agent id (a later agent with the same role and label
// passed). Value: what fixed it.
const fixedBy = (list: Agent[], map: Map<string, Node>) => {
  const out = new Map<string, string>()
  const ok = (x: Node) => x.agents.length > 0 && ['pass', 'done'].includes(stateOf(x))
  for (const n of map.values()) {
    if (!n.agents.length || stateOf(n) !== 'fail') continue
    const end = Math.max(...n.agents.map(a => a.endedAt ?? 0))
    let m: Node | undefined
    for (let c = n.next ? map.get(n.next) : undefined; c && !m; c = c.next ? map.get(c.next) : undefined) if (ok(c)) m = c
    m ??= [...map.values()].find(x => x.deps.includes(n.id) && ok(x) && (x.agents[0] as Agent).startedAt >= end)
    if (m) out.set(n.id, m.id)
  }
  for (const a of list) {
    if (a.slice || a.status !== 'fail') continue
    const b = list.find(x => !x.slice && x.role === a.role && x.label === a.label && x.status === 'pass' && x.startedAt >= (a.endedAt ?? Infinity))
    if (b) out.set(a.id, `a later ${a.label}`)
  }
  return out
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
    const d = Math.max(-1, ...(map.get(id) ? parentsOf(map.get(id) as Node) : []).map(x => walk(x, [...seen, id]))) + 1
    depth.set(id, d)
    return d
  }
  const layers: Node[][] = []
  for (const n of map.values()) (layers[walk(n.id, [])] ??= []).push(n)
  return layers.filter(Boolean)
}

// Exact height of a diagram card in rows, so the lines in the gutters can meet the middle of each card.
const hasTag = (n: Node) => n.of > 1 || !!n.isNew // the "attempt k/n" and "✚ new" line
const cardRows = (n: Node) => 2 + 1 + 1 + 1 + Math.min(3, parentsOf(n).length) + (parentsOf(n).length > 3 ? 1 : 0) + (hasTag(n) ? 1 : 0)
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
const rank = (c: string) => (c === 'warning' ? 4 : c === 'error' ? 3 : c === 'success' ? 2 : 1)
type GRow = { text: string; color: string; bold: boolean }
const gutterOf = (prev: Node[], next: Node[], map: Map<string, Node>, f: number): { width: number; rows: GRow[] } => {
  const ids = new Set(prev.map(p => p.id))
  const targets = next.map((t, i) => ({ t, i })).filter(x => parentsOf(x.t).some(d => ids.has(d)))
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
    for (const d of parentsOf(t)) {
      const pi = prev.findIndex(p => p.id === d)
      if (pi < 0) continue
      const rs = pc[pi] as number
      const retry = d === t.retryOf
      const color = retry ? retryTone(t) : edge(moving, satisfiedIn(map, d))
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
      if (retry) over.set(`${rt},${width - 2}`, '↻') // the retry connector carries its marker next to the arrowhead
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

// The colour of one slice card on a connector: amber running, red failed, green passed or done (or fixed later), grey queued. A retry attempt
// keeps its retry colour.
const toneOf = (n: Node, fixed = false) => {
  const s: State = fixed ? 'done' : stateOf(n)
  return s === 'queued' ? 'subtle' : n.retryOf && !fixed ? retryTone(n) : s === 'running' ? 'warning' : s === 'fail' ? 'error' : 'success'
}
// Where several cards meet in one line: running > failed > passed > queued.
const topTone = (tones: string[]) => [...tones].sort((a, b) => rank(b) - rank(a))[0] ?? 'subtle'

// A rail down the left of a layer, fed from above: it forks an arrowhead into the middle of every card in the layer, in that card's colour.
// The dot runs from the top of the rail down to the lowest running card, not further.
const trunkOf = (layer: Node[], fix: Map<string, string>, f: number): GRow[] => {
  const centers = centersOf(layer)
  const lastC = centers[centers.length - 1] as number
  const tones = layer.map(n => toneOf(n, fix.has(n.id)))
  const lowest = Math.max(-1, ...layer.map((n, i) => (stateOf(n) === 'running' ? (centers[i] as number) : -1)))
  return Array.from({ length: layerRows(layer) }, (_, r) => {
    const k = centers.indexOf(r)
    const dot = lowest > 0 && r === f % lowest && k < 0 && r < lowest
    const text = k >= 0 ? (r === lastC ? ' └▶' : ' ├▶') : r < lastC ? (dot ? ' ● ' : ' │ ') : '   '
    // a plain rail row takes the colour of the best card the rail still has to reach below it; a fork row its own card's
    const color = k >= 0 ? (tones[k] as string) : topTone(tones.filter((_, i) => (centers[i] as number) >= r))
    return { text, color, bold: dot || (k >= 0 && stateOf(layer[k] as Node) === 'running') }
  })
}

// A join under the diagram: the columns that hold a final slice drop a stub onto one bus that ends in a single arrow. Each stub has its card's
// colour; the bus itself and its arrow take the best colour of all the stubs.
type Run = { text: string; color: string }
const runsOf = (chars: string[], colors: (string | undefined)[]): Run[] => {
  const full = colors.map((c, i) => c ?? colors.slice(i + 1).find(Boolean) ?? colors.slice(0, i).reverse().find(Boolean) ?? 'subtle')
  const runs: Run[] = []
  chars.forEach((ch, i) => {
    const last = runs[runs.length - 1]
    if (last && last.color === full[i]) last.text += ch
    else runs.push({ text: ch, color: full[i] as string })
  })
  return runs
}
const busOf = (cols: number[], tones: string[]): { rows: Run[][]; mid: number } => {
  const lo = Math.min(...cols)
  const hi = Math.max(...cols)
  const mid = Math.floor((lo + hi) / 2)
  const all = topTone(tones)
  const blank = () => Array<string>(hi + 1).fill(' ')
  const line = blank()
  const tip = blank()
  const lineColor: (string | undefined)[] = Array(hi + 1).fill(undefined)
  const tipColor: (string | undefined)[] = Array(hi + 1).fill(undefined)
  for (let c = lo; c <= hi; c++) {
    const stub = cols.includes(c)
    line[c] =
      lo === hi ? '│' : c === mid && stub ? (c === lo ? '├' : c === hi ? '┤' : '┼') : c === mid ? '┬' : c === lo ? '└' : c === hi ? '┘' : stub ? '┴' : '─'
    lineColor[c] = stub && c !== mid ? tones[cols.indexOf(c)] : all
  }
  tip[mid] = '▼'
  tipColor[mid] = all
  return { rows: [runsOf(line, lineColor), runsOf(tip, tipColor)], mid }
}

// Put a dot on a block of text rows at the step of the frame along a path of [row, column] cells; an empty path leaves the rows alone.
const dotted = (rows: string[], path: [number, number][], f: number) => {
  const at = path.length ? (path[f % path.length] as [number, number]) : undefined
  return rows.map((t, r) => (at && at[0] === r ? `${t.slice(0, at[1])}●${t.slice(at[1] + 1)}` : t))
}

// The slice scene (cards, fixed failures, layers) depends on the agent list alone, which changes only when an agent does, not on every
// animation tick: keep the last one per list value.
let sceneKey: { list: Agent[]; ghosts: boolean } | undefined
let sceneVal: { map: Map<string, Node>; fix: Map<string, string>; layers: Node[][] } | undefined
const sceneOf = (list: Agent[], ghosts: boolean) => {
  if (!sceneVal || !sceneKey || sceneKey.list !== list || sceneKey.ghosts !== ghosts) {
    const map = nodesOf(list, ghosts)
    sceneVal = { map, fix: fixedBy(list, map), layers: layersOf(map) }
    sceneKey = { list, ghosts }
  }
  return sceneVal
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

// Prompts the engine queues that the person did not type (a background task's notification, a peer session, a schedule): they are not new work.
const NOT_THE_PERSON = [
  'task-notification', 'scheduled-trigger', 'peer', 'peer-send-message', 'projects-relay', 'channel', 'coordinator', 'observer', 'observer-activity',
  'auto-continuation', 'slack-ping',
]

// What a started agent adds to the log: "retry k of X" for the first agent of a retry attempt, "re-plan" for a plan review after a failed one.
const startNote = (list: Agent[], a: Agent) => {
  if (a.label === 'plan review' && list.some(x => !(x.id === a.id && x.startedAt === a.startedAt) && x.label === 'plan review' && x.status === 'fail' && x.endedAt !== undefined && a.startedAt >= x.endedAt)) return 're-plan'
  const n = a.slice ? [...nodesOf(list, false).values()].find(x => x.agents[0]?.id === a.id && x.agents[0].startedAt === a.startedAt) : undefined
  return n?.retryOf ? `retry ${n.attempt} of ${n.slice}` : undefined
}
// The record a event about an agent id belongs to: the latest one still running, else the latest.
const latestOf = (list: Agent[], id: string) => {
  for (let i = list.length - 1; i >= 0; i--) if ((list[i] as Agent).id === id && (list[i] as Agent).status === 'running') return i
  for (let i = list.length - 1; i >= 0; i--) if ((list[i] as Agent).id === id) return i
  return -1
}

type Ctx = Parameters<Hook<'agent.spawn'>>[0]
// Nothing runs and the last agent ended over two minutes ago (or none ever ran): what follows starts a new run. `force` (a new prompt from the person)
// drops the two minutes: once nothing runs, new input is new work.
const isNewRun = (list: Agent[], t: number, force = false) => !list.some(a => a.status === 'running') && (force || t - Math.max(0, ...list.map(a => a.endedAt ?? 0)) >= 120_000)

// The main turn still works: `work` exists and has no end. Stale (a killed or interrupted session whose `turn.complete` never came): agents ran, none runs,
// the last one ended over ten minutes ago. A solo run (no agents) is never stale by this rule.
// Tradeoff: a legitimate main turn that stays busy for over ten minutes after the last agent ended (a long build) counts as stale too: the pane shows
// signed off, and a following spawn passes the `newRun` guard and starts a clean run. A lost `turn.complete` is the likelier case, so this is accepted.
const STALE_MS = 600_000
const workOpen = (work: Work | null | undefined, list: Agent[], t: number) =>
  !!work && !work.endedAt && !(list.length > 0 && !list.some(a => a.status === 'running') && t - Math.max(0, ...list.map(a => a.endedAt ?? 0)) > STALE_MS)

// A new run drops the old diagram: agents, log and main. With `keepVerdict` (the spawn path) the verdict and the work line stay when they are newer than
// the old run's last agent: the person's prompt and the router both came before the first spawn of this run.
async function newRun($: Ctx, t: number, keepVerdict: boolean, force = false) {
  const before = await read($, agents)
  if (!isNewRun(before, t, force)) return
  const w = await read($, workAtom)
  if (workOpen(w, before, t)) return // the main turn still works: these agents belong to this run
  const kept = await read($, triage)
  const lastEnd = Math.max(0, ...before.map(a => a.endedAt ?? 0))
  const keep = keepVerdict && kept && kept.at > lastEnd ? kept : null
  await update($, agents, () => [])
  await update($, triage, () => keep)
  await update($, log, () => (keep ? [{ at: keep.at, kind: 'triage', role: 'router', label: keep.mode, model: '' } as LogEntry] : []))
  await update($, main, () => '')
  await update($, planAtom, () => null) // the plan belongs to its run; what the session used stays
  if (!(keepVerdict && w && w.startedAt > lastEnd)) await update($, workAtom, () => null)
  told = false
}

// Redraw four times a second for the animation while an agent runs, finished under 2.5 s ago, or the main session works; then stop.
function startTimer($: Ctx, slot: { timer?: Timer }) {
  const pulse = async () => {
    const list = await read($, agents)
    const w = await read($, workAtom)
    const t = await $.clock.now()
    if (!workOpen(w, list, t) && !list.some(a => a.status === 'running') && list.every(a => t - (a.endedAt ?? 0) > 2500)) {
      slot.timer?.cancel()
      slot.timer = undefined
      await update($, tick, n => n + 1) // a last redraw: the state that made it stop (stale work, a finished turn) is drawn, whatever the last tick saw
      return
    }
    await update($, tick, n => n + 1)
  }
  slot.timer ??= $.clock.every(250, () => {
    void pulse().catch(() => {}) // a redraw that fails (the module is gone) is skipped
  })
}

export const register: Register = on => {
  const slot: { timer?: Timer } = {} // the one redraw timer of this load

  // The prompt the person typed starts the work, with or without agents or a repository: open the pane and keep it moving.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || !e.text.trim() || NOT_THE_PERSON.includes(e.origin?.kind as string)) return next(e)
    try {
      const now = await $.clock.now()
      // a prompt while the main session still works with no answer yet is a follow-up in the same turn window: reset nothing
      const working = await read($, workAtom)
      const before = await read($, agents)
      const open = workOpen(working, before, now) // a stale one (a lost turn.complete) starts a clean run
      if (!open) await newRun($, now, false, true)
      const running = (await read($, agents)).some(a => a.status === 'running')
      if (!running && !open) {
        const line = e.text.split('\n').find(l => l.trim()) ?? ''
        await update($, workAtom, () => ({ text: line.trim().slice(0, 120), startedAt: now }))
      }
      await openPane($)
      startTimer($, slot)
    } catch {
      // the pane must never change the prompt
    }
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'orchestration', description: 'Show the orchestration agents, slice diagram and token usage in a pane' })
    // A plugin-only install has no `npm run route`: the model records the verdict through this tool. `isDeferred: false` keeps it out of ToolSearch.
    try {
      await $.tool.register({
        name: 'route',
        description: 'Record the triage verdict (mode, reason and the five facts) so the orchestration pane can show it. Call it once after sizing a task.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: { type: 'string', enum: MODES },
            reason: { type: 'string' },
            filesToTouch: { type: 'number' },
            linesToChange: { type: 'number' },
            independentSlices: { type: 'number' },
            risky: { type: 'boolean' },
            code: { type: 'boolean' },
          },
          required: ['mode', 'reason'],
        },
        isDeferred: false,
      })
    } catch {
      // the tool is a convenience: the pane works without it
    }
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
    if ('agentId' in spawned && spawned.agentId) {
      try {
        await update($, usedAtom, u => ({ ...u, agents: { ...u.agents, [role]: (u.agents[role] ?? 0) + 1 } })) // any agent type, not only the four roles
      } catch {
        // the list is a convenience: the spawn goes on
      }
    }
    if (!ROLES.includes(role) || !('agentId' in spawned) || !spawned.agentId) return spawned
    const plan = /^\s*PLAN REVIEW\b/.test(e.prompt) // the brief starts with it (the hooks read it the same way), not any later line
    const slice = plan ? undefined : sliceOf(e.prompt) // a plan review is a stage of its own, whatever SLICE line its brief carries
    const agent: Agent = {
      id: spawned.agentId, role, model: spawned.model, slice, label: slice ?? (plan ? 'plan review' : e.description),
      deps: plan ? [] : depsOf(e.prompt), files: filesOf(e.prompt), startedAt: await $.clock.now(), status: 'running',
      tokens: 0, inTokens: 0, outTokens: 0, cacheTokens: 0,
    }
    // a spawn with nothing running and the last agent done over two minutes ago starts a new run: drop the old diagram
    // (newRun leaves the run alone while the main turn is open: a slow plan review before the writers must not wipe the agents on the pane)
    if ((await read($, agents)).length > 0) await newRun($, agent.startedAt, true)
    // a spawn whose id already has a record (a resume that fires agent.spawn again) is a new record, so the earlier run stays as history
    const grown = await update($, agents, list => [...list, agent].slice(-80))
    await update($, main, () => e.parentModel)
    // The plan the review checks is the plan the progress bar follows; a brief that names no slice leaves the last plan in place.
    const planned = plan ? planOf(e.prompt) : []
    if (planned.length) await update($, planAtom, () => ({ at: agent.startedAt, slices: planned }))
    const note = startNote(grown, agent)
    await update($, log, l => [...l, { at: agent.startedAt, kind: 'start', role, label: agent.label, model: agent.model, ...(note ? { note } : {}) } as LogEntry].slice(-60))
    await openPane($)
    startTimer($, slot)
    return spawned
  })

  // The route tool (the engine names it mcp__<plugin>__route; the plugin build renames the plugin inside this one literal).
  on('tool.call', { tool: 'mcp__orchestration__route' }, async ($, e) => {
    if (e.agentId) return { result: 'ignored: only the main session records a route' }
    try {
      const t = e as unknown as Record<string, unknown>
      const input = 'input' in t ? t.input : t
      const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : undefined
      if (!o) return { result: 'ignored: the input is not an object' }
      if (!MODES.includes(o.mode as string)) return { result: 'ignored: mode must be plain, reviewed or orchestrate' }
      if (typeof o.reason !== 'string') return { result: 'ignored: reason must be text' }
      const at = await $.clock.now()
      const facts = factsOf(o)
      const found = { mode: o.mode as TriageInfo['mode'], reason: o.reason, ...(facts ? { facts } : {}) }
      await update($, usedAtom, u => usedBy(u, { tool: e.tool })) // this hook answers the call itself, so the one below never sees it
      await update($, triage, () => ({ at, ...found }))
      await update($, log, l => [...l, { at, kind: 'triage', role: 'router', label: found.mode, model: '' } as LogEntry].slice(-60))
      await openPane($)
      startTimer($, slot)
      return { result: `route recorded: ${found.mode}` }
    } catch {
      return { result: 'ignored: the pane could not record the route' }
    }
  })

  // A skill expanded for the model (`/name`, the Skill tool, a worker's preload): listed under "used in this session".
  on('skill.prompt', async ($, e, next) => {
    try {
      await update($, usedAtom, u => ({ ...u, skills: add(u.skills, e.skill) }))
    } catch {
      // the list must never change the skill
    }
    return next(e)
  })

  // What a running agent is doing: its latest tool and target. Every call that ran without error, in the main loop or an agent, counts as used in
  // this session. The main loop's `npm run route` also gives the pane its triage.
  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      const id = e.agentId
      const t = e as unknown as Record<string, unknown>
      const target = String(t.command ?? t.file_path ?? t.path ?? t.pattern ?? '').replace(/\s+/g, ' ').trim()
      const tool = cut(target ? `${e.tool} ${target}` : e.tool, 30)
      await update($, agents, list => {
        const i = list.findLastIndex(a => a.id === id && a.status === 'running')
        return i < 0 ? list : list.map((a, j) => (j === i ? { ...a, tool } : a))
      })
    }
    const ran = await next(e)
    try {
      if (!('deny' in ran && ran.deny) && !ran.isError) await update($, usedAtom, u => usedBy(u, e as unknown as Record<string, unknown>))
    } catch {
      // the list must never change the tool call
    }
    if (e.agentId || e.tool !== 'Bash' || !ROUTE_CMD.test(commandOf(e))) return ran
    // The router ran in the main loop: take its verdict from the result, and hand the result on untouched.
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
    if (!id) {
      // the main session's turn ended: the work is answered, or stopped (aborted, refused, failed)
      try {
        const now = await $.clock.now()
        const outcome = e.reason === 'answer' ? 'answered' : 'stopped'
        await update($, workAtom, w => (w && !w.endedAt ? { ...w, endedAt: now, outcome } : w))
      } catch {
        // the pane must never change the turn
      }
    }
    if (id) {
      const now = await $.clock.now()
      const u = e.usage
      const inT = u?.input_tokens ?? 0
      const outT = u?.output_tokens ?? 0
      const cacheT = (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0)
      const status = statusOf(e.answer)
      const result = resultOf(e.answer)
      const spent = { tokens: inT + outT + cacheT, inTokens: inT, outTokens: outT, cacheTokens: cacheT }
      const hold: { one?: Agent; resumed?: boolean } = {}
      const list = await update($, agents, l => {
        const i = latestOf(l, id)
        const a = l[i]
        if (!a) return l
        if (a.endedAt === undefined) {
          // the run this record opened ends
          const upd = { ...a, status, endedAt: now, tool: undefined, tokens: a.tokens + spent.tokens, inTokens: a.inTokens + inT, outTokens: a.outTokens + outT, cacheTokens: a.cacheTokens + cacheT, result: result || a.result }
          hold.one = upd
          return l.map((x, j) => (j === i ? upd : x))
        }
        // a turn ends for a record that already ended (a resume that fires no agent.spawn): the old run stays as history, the resumed run is a new record.
        // It starts when the old one ended, or after the last other end in its slice, so a retry after a reviewer's verdict starts after that verdict.
        const from = Math.max(a.endedAt, ...l.filter(x => a.slice && x.slice === a.slice && x !== a).map(x => x.endedAt ?? 0))
        const again = { ...a, startedAt: Math.min(from, now), status, endedAt: now, tool: undefined, ...spent, result: result || undefined }
        hold.one = again
        hold.resumed = true
        return [...l, again].slice(-80)
      })
      const one = hold.one
      if (one) {
        const entry: LogEntry = { at: now, kind: status, role: one.role, label: one.label, model: one.model, ms: now - one.startedAt, tokens: one.tokens }
        const note = hold.resumed ? startNote(list, one) : undefined
        if (note) await update($, log, l => [...l, { at: one.startedAt, kind: 'start', role: one.role, label: one.label, model: one.model, note } as LogEntry].slice(-60))
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
    const work = (await read($, workAtom)) ?? undefined // state holds null, not undefined
    const plan = await read($, planAtom)
    const used = (await read($, usedAtom)) ?? NO_USE
    const f = await read($, tick)
    const now = await $.clock.now()
    const g = (st: State) => (st === 'running' ? (SPIN[f % SPIN.length] as string) : GLYPH[st])
    const working = workOpen(work, list, now)
    const { map, fix, layers } = sceneOf(list, list.some(a => a.status === 'running') || working)
    const attemptOf = new Map<Agent, string>() // the diagram node (attempt) each slice agent sits in
    for (const n of map.values()) for (const a of n.agents) attemptOf.set(a, n.id)
    const fixedOf = (a: Agent) => (a.status === 'fail' ? fix.get(a.slice ? (attemptOf.get(a) ?? a.slice) : a.id) : undefined)
    // A failure that was fixed later counts as done, not as a failure.
    const eff = (a: Agent): State => (fixedOf(a) ? 'done' : a.status)
    const running = list.filter(a => a.status === 'running').length
    const failed = list.filter(a => eff(a) === 'fail').length
    const fixedN = list.filter(a => fixedOf(a)).length
    const total = list.reduce((n, a) => n + a.tokens, 0)
    const first = list[0]?.startedAt ?? now
    const last = running || working ? now : Math.max(first, ...list.map(a => a.endedAt ?? 0))
    const width = (e.props as { bodyColumns?: number } | undefined)?.bodyColumns ?? 44
    const wide = width >= 64
    const models = [...new Set([orchestrator, ...list.map(a => a.model)].filter(Boolean))]
    const boxW = Math.min(width - 1, 46)

    // Progress through the orchestrator's plan: the planned slices in plan order, then any slice that started outside the plan, each at its latest
    // attempt (a failure made good counts as done). A slice is done once it passed review, or was built with no reviewer.
    const goals = new Map((plan?.slices ?? []).map(s => [s.id, s.goal]))
    const steps = [...new Set([...(plan?.slices ?? []).map(s => s.id), ...[...map.values()].map(n => n.slice)])].map(id => {
      const n = resolve(map, id)
      return { id, goal: goals.get(id), state: (!n ? 'queued' : fix.has(n.id) ? 'done' : stateOf(n)) as State }
    })
    const stepsDone = steps.filter(s => s.state === 'pass' || s.state === 'done').length
    const stepsRunning = steps.filter(s => s.state === 'running').length
    const stepsFailed = steps.filter(s => s.state === 'fail').length
    const STEPS_SHOWN = 8
    // The bar: progW cells shared evenly by the slices, each slice's cells in its colour (done green, running amber, failed red, still to do grey).
    const progW = Math.max(10, Math.min(width - 2, 40))
    const STEP_TONE = { pass: 'success', done: 'success', running: 'warning', fail: 'error', queued: 'subtle' } as const
    const progRuns = steps.length
      ? runsOf(Array.from({ length: progW }, () => '━'), Array.from({ length: progW }, (_, i) => STEP_TONE[(steps[Math.floor((i * steps.length) / progW)] as { state: State }).state]))
      : []

    // Used in this session: what the session reached for, one row per kind, as many names as fit and then +N.
    const usedW = Math.max(4, width - 12)
    const usedRows = [
      ['skills', fitted(used.skills, usedW)],
      ['connectors', fitted(used.connectors, usedW)],
      ['agents', fitted(named(used.agents), usedW)],
      ['tools', fitted(named(used.tools), usedW)],
      ['edited', fitted([...used.edited].reverse().map(base), usedW)], // the latest first
      ['read', used.read.length ? `${used.read.length} file${used.read.length === 1 ? '' : 's'}` : ''],
    ].filter(([, v]) => v) as [string, string][]

    // A connector down the page, x cells in from the left: a dot runs along it while work moves through it.
    const down = (moving: boolean, color: string, x: number, retry = false) => {
      const pad = ' '.repeat(Math.max(0, x))
      const dot = f % 3
      return (
        <Box flexDirection="column">
          <Text color={color} bold={moving && dot === 0}>{pad}{moving && dot === 0 ? '●' : retry ? '↻' : '│'}</Text>
          <Text color={color} bold={moving && dot === 1}>{pad}{moving && dot === 1 ? '●' : '▼'}</Text>
        </Box>
      )
    }

    // Pipeline: triage -> plan -> plan review -> build -> review -> merge, each a box with a progress bar and the models in it.
    const phase = (name: string, group: Agent[], mode?: string) => {
      const done = group.filter(a => a.status !== 'running').length
      const state: State = !group.length ? 'queued' : group.some(a => a.status === 'running') ? 'running' : group.some(a => eff(a) === 'fail') ? 'fail' : 'pass'
      return { name, group, done, n: group.length, state, mode }
    }
    // The main session's own work, which exists with no agents: the prompt in a box, then running, answered or stopped.
    const solo = list.length === 0
    const workState: State = !work ? 'queued' : working ? 'running' : work.outcome === 'answered' ? 'pass' : 'done'
    const active = list.length > 0 || !!work || !!verdict
    const flow = running > 0 || working
    const mode = verdict?.mode ?? inferMode(list) ?? (work?.endedAt ? 'plain' : undefined)
    // Agents and a main turn: signed off once nothing runs and the turn ended. With no `work` (agents without a typed prompt, or background agents that woke the
    // main session) only "nothing runs" is known, so the pane can still flicker to signed off between waves there: a known limit.
    const signed = list.length > 0 ? !running && !working : !!work?.endedAt
    // The orchestrator plans itself, so the plan stage has no agent: it is done once plan review or a build has started.
    const planned = list.some(a => a.role === 'implementer' || a.label === 'plan review')
    // No integrator ran (one slice at a time in a shared tree, or no code): once the run is signed off the merge stage is skipped.
    const merges = list.filter(a => a.role === 'integrator')
    // Plain and reviewed runs do not use these stages; the build the main session does itself reads "this session".
    const unused = mode === 'plain' ? ['plan', 'plan review', 'review', 'merge'] : mode === 'reviewed' ? ['plan', 'plan review', 'merge'] : []
    const entryAt = mode ? ENTRY[mode] : -1
    const sessionBuild = unused.length > 0 && (list.length > 0 || !!work) // the main session did (or does) the build itself
    // A stage box is drawn once it is used: triage always, a stage once an agent of it started (or the session builds), the route's entry stage
    // as a dim "next" box once the mode is known. Stages the mode does not use are never drawn.
    const stages = [
      { ...phase('triage', []), state: (mode ? 'pass' : 'queued') as State, mode },
      (p => (planned && (p.state === 'queued' || p.state === 'pass') ? { ...p, state: 'pass' as State, mode: 'orchestrator' } : p))(phase('plan', list.filter(a => a.role === 'researcher'))),
      phase('plan review', list.filter(a => a.label === 'plan review')),
      phase('build', list.filter(a => a.role === 'implementer')),
      phase('review', list.filter(a => a.role === 'reviewer' && a.label !== 'plan review')),
      phase('merge', merges),
    ]
      .map((p, idx) => ({
        ...p,
        idx,
        ...(p.name === 'build' && !p.group.length && sessionBuild
          ? { state: (list.length ? (work?.outcome === 'stopped' ? 'done' : 'pass') : workState) as State, mode: 'this session' }
          : {}),
      }))
      .map(p => (p.idx === entryAt && !p.group.length && p.mode !== 'this session' && p.mode !== 'orchestrator' ? { ...p, mode: 'next' } : p))
      .filter(p => p.idx === 0 || p.group.length > 0 || p.mode === 'next' || p.mode === 'this session' || p.mode === 'orchestrator')
    type Stage = (typeof stages)[number]
    const posOf = (idx: number) => stages.findIndex(p => p.idx === idx)
    // Loops back under the stage row: a plan review that failed and was followed by another, slices that were retried, an integrator that
    // failed and was followed by a build. Red while the later attempt is unresolved or failed, amber while it runs, green once it passed.
    const tone = (sts: string[]) => (sts.includes('running') ? 'warning' : sts.every(x => x === 'pass' || x === 'done') ? 'success' : 'error')
    const loops: { from: number; to: number; label: string; color: string }[] = []
    const reviews = list.filter(a => a.label === 'plan review')
    const replanned = reviews.filter(p => reviews.some(b => b !== p && b.status === 'fail' && b.endedAt !== undefined && p.startedAt >= b.endedAt)).pop()
    if (replanned) loops.push({ from: 2, to: 1, label: '↻ re-plan', color: tone([replanned.status]) })
    const retried = [...map.values()].filter(n => n.of > 1 && !n.next)
    if (retried.length) loops.push({ from: 4, to: 3, label: `↻ retry ${retried.length}`, color: tone(retried.map(stateOf)) })
    const badMerge = merges.find(m => m.status === 'fail' && m.endedAt !== undefined && list.some(b => b.role === 'implementer' && b.startedAt >= (m.endedAt as number)))
    if (badMerge) loops.push({ from: 5, to: 3, label: '↻ rebuild', color: tone(list.filter(b => b.role === 'implementer' && b.startedAt >= (badMerge.endedAt as number)).map(b => b.status)) })
    // A loop is drawn only when both of its ends are; `from` and `to` then also name positions among the drawn boxes.
    const drawnLoops = loops
      .filter(l => posOf(l.from) >= 0 && posOf(l.to) >= 0)
      .map(l => ({ ...l, live: l.color === 'warning', fromAt: posOf(l.from), toAt: posOf(l.to) }))
    // The active path: up to the furthest stage with a running agent (the session builds in plain and reviewed; a running loop makes its target
    // active). With the main turn working and no agent running, the work sits at the furthest stage used so far.
    const activeIdx = [
      ...stages.filter(p => p.group.some(a => a.status === 'running')).map(p => p.idx),
      ...(working && unused.length ? [3] : []),
      ...drawnLoops.filter(l => l.live).map(l => l.to),
    ]
    const furthest = activeIdx.length
      ? Math.max(...activeIdx)
      : flow && mode ? Math.max(entryAt, ...stages.filter(p => p.idx > 0 && p.mode !== 'next').map(p => p.idx)) : -1
    const live = flow && furthest >= 0
    // An arrow into a stage: amber (and carrying the dot) up to the furthest active stage, grey beyond it; with nothing live, the final state.
    const into = (p?: Stage) =>
      live ? (p && p.idx <= furthest ? 'warning' : 'subtle') : !p ? 'subtle' : p.state === 'fail' ? 'error' : p.state === 'pass' || p.state === 'done' ? 'success' : 'subtle'
    const cols = width >= 100 ? 6 : width >= 40 ? 3 : 2
    const pw = Math.max(6, Math.floor((width - 3 * (cols - 1) - 1) / cols))
    const stageRows = Array.from({ length: Math.ceil(stages.length / cols) }, (_, r) => stages.slice(r * cols, r * cols + cols))
    // The return rail from the end of one row to the start of the next: down from the middle of the last box, left, then into the first.
    const railOf = (next: Stage) => {
      const first = Math.floor(pw / 2)
      const lastX = (cols - 1) * (pw + 3) + first
      const color = into(next)
      const path: [number, number][] = [[0, lastX]]
      for (let x = lastX - 1; x >= first; x--) path.push([1, x])
      path.push([2, first])
      const rows = [`${' '.repeat(lastX)}│`, `${' '.repeat(first)}┌${'─'.repeat(Math.max(0, lastX - first - 1))}┘`, `${' '.repeat(first)}▼`]
      return dotted(rows, color === 'warning' ? path : [], f).map(text => ({ text, color }))
    }

    // Slice diagram: a column per dependency layer, joined by routed lines; stacked top to bottom when the columns do not fit.
    const colMax = width >= 100 ? 26 : 19
    // Side by side only when every layer, the 3-cell rail and the routing gutters fit across at 14 cells a card or more.
    const gutterW = layers.map((l, i) => (i === 0 ? 0 : Math.max(4, l.filter(n => parentsOf(n).some(d => (layers[i - 1] as Node[]).some(p => p.id === d))).length + 3)))
    const spare = width - 3 - gutterW.reduce((t, w) => t + w, 0)
    const vertical = layers.length > 1 && Math.floor(spare / layers.length) < 14
    const colW = vertical ? Math.max(10, Math.min(30, width - 5)) : Math.max(10, Math.min(colMax, Math.floor(spare / Math.max(1, layers.length))))
    // One cell per task in a stage: the build cell is a slice's implementer, the review cell its reviewer, others one per agent.
    const stOf = (a?: Agent): State => (a ? eff(a) : 'queued')
    const cellsFor = (name: string, group: Agent[]): State[] => {
      const nodes = [...map.values()]
      if (name === 'build') return nodes.filter(n => n.agents.every(a => a.role === 'implementer' || a.role === 'reviewer')).map(n => stOf(lastOf(n, 'implementer')))
      if (name === 'review') return nodes.filter(n => n.agents.some(a => a.role === 'implementer' || a.role === 'reviewer')).map(n => stOf(lastOf(n, 'reviewer')))
      if (name === 'plan' && !group.length && planned) return ['pass']
      const own = stages.find(p => p.name === name && p.mode === 'this session')
      if (own && !group.length) return [own.state]
      return group.map(eff)
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
    const satisfied = (id: string) => satisfiedIn(map, id)
    const gutters = layers.map((l, i) => (i > 0 && !vertical ? gutterOf(layers[i - 1] as Node[], l, map, f) : undefined))
    const card = (n: Node) => {
      const s: State = fix.has(n.id) ? 'done' : stateOf(n)
      const live = n.agents.find(a => a.status === 'running')
      const spent = n.agents.reduce((t, a) => t + a.tokens, 0)
      const t0 = n.agents[0]?.startedAt ?? now
      const lines = [...(n.retryOf ? [{ text: `◀ retry of ${n.slice}`, color: retryTone(n) }] : []), ...n.deps.map(d => ({ text: `◀ ${cut(d, colW - 6)}`, color: satisfied(d) ? 'success' : 'subtle' }))]
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
          {hasTag(n) && <Text dimColor wrap="truncate-end">{[n.of > 1 ? `attempt ${n.attempt}/${n.of}` : '', n.isNew ? '✚ new' : ''].filter(Boolean).join(' · ')}</Text>}
          {lines.slice(0, 3).map(l => (
            <Text color={l.color} wrap="truncate-end">{l.text}</Text>
          ))}
          {lines.length > 3 && <Text dimColor>◀ +{lines.length - 3} more</Text>}
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
    const needed = new Set(layers.flatMap(l => l.flatMap(parentsOf)))
    const leafCols = vertical
      ? [3 + Math.floor(colW / 2)]
      : layers.flatMap((l, i) => (!needed.has((l[l.length - 1] as Node).id) ? [(xs[i] as number) + Math.floor(colW / 2)] : []))
    const leafNodes = vertical ? [...map.values()].filter(n => !needed.has(n.id)) : layers.flatMap(l => (!needed.has((l[l.length - 1] as Node).id) ? [l[l.length - 1] as Node] : []))
    const leafTones = vertical ? [topTone(leafNodes.map(n => toneOf(n, fix.has(n.id))))] : leafNodes.map(n => toneOf(n, fix.has(n.id)))
    const bus = leafCols.length ? busOf(leafCols, leafTones) : undefined

    // Tasks: one row per slice (or per agent without one) with its tokens, time, and what it reported.
    type Task = { key: string; label: string; state: State; tokens: number; ms: number; result: string; tool?: string }
    const tasks: Task[] = [
      ...[...map.values()]
        .filter(n => n.agents.length)
        .map(n => {
          const s = stateOf(n)
          const t0 = n.agents[0]?.startedAt ?? now
          const by = fix.get(n.id)
          return {
            key: n.id, label: n.id, state: by ? ('done' as State) : s, tokens: n.agents.reduce((t, a) => t + a.tokens, 0),
            ms: (s === 'running' ? now : Math.max(t0, ...n.agents.map(a => a.endedAt ?? 0))) - t0,
            result: by ? `fixed by ${by}` : ([...n.agents].reverse().find(a => a.result)?.result ?? ''), tool: n.agents.find(a => a.status === 'running')?.tool,
          }
        }),
      ...list
        .filter(a => !a.slice)
        .map(a => ({ key: a.id, label: a.label, state: eff(a), tokens: a.tokens, ms: (a.endedAt ?? now) - a.startedAt, result: fixedOf(a) ? `fixed by ${fixedOf(a)}` : (a.result ?? ''), tool: a.tool })),
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

    const mainState: State = running || working ? 'running' : solo ? workState : failed ? 'fail' : 'pass'
    const dots = '.'.repeat(1 + (f % 3))
    const bodyRows = (e.props as { scroll?: { bodyRows?: number } } | undefined)?.scroll?.bodyRows ?? 0
    const diagramRows = vertical ? layers.reduce((t, l) => t + layerRows(l) + 1, 0) : Math.max(0, ...layers.map(layerRows))

    // Triage fork: three routes side by side (stacked under 44 columns), the chosen one joined by a link to the first stage it uses.
    // Active means a mode or sizing, so the fork is drawn whenever the pane is.
    const side = width >= 44
    const rw = Math.floor((boxW - 4) / 3)
    const rc = [0, 1, 2].map(i => i * (rw + 2) + Math.floor(rw / 2))
    const k = mode ? MODES.indexOf(mode) : -1
    const forkColor = mode ? edge(flow, true) : 'subtle'
    const entryStage = stages[mode ? posOf(entryAt) : -1]
    const linkColor = mode ? into(entryStage) : 'subtle'
    // Under 16 columns pw is clamped and a row can pass the pane: no lane, the link goes straight to the first stage.
    const entry = mode && width >= 16 ? Math.max(0, posOf(entryAt)) : 0
    const left = (entry % cols) * (pw + 3)
    const fx = Math.floor(pw / 2)
    const lx = (cols - 1) * (pw + 3) + fx
    const rowW = cols * pw + 3 * (cols - 1)
    // Plain and reviewed enter build, which is in the second row below 100 columns: the link runs down a lane right of the first row.
    const lane = !!mode && Math.floor(entry / cols) >= 1 && rowW <= width - 1
    const ex = left + pw - 2
    const sx = side ? (rc[k] as number) : 1
    const tx = lane ? rowW : Math.max(1, Math.min(left + fx, width - 1))
    const linkRows = mode ? [`${' '.repeat(sx)}│`, elbow(sx, tx), `${' '.repeat(tx)}${lane ? '│' : '▼'}`] : []
    // The dot travels the link while work runs: about 12 ticks for a pass, whatever its length.
    let dotRow = -1
    if (mode && live) {
      const path: [number, number][] = [[0, sx]]
      for (let x = sx; x !== tx + (tx >= sx ? 1 : -1); x += tx >= sx ? 1 : -1) path.push([1, x])
      path.push([2, tx])
      const [r, x] = path[(f * Math.max(1, Math.ceil(path.length / 12))) % path.length] as [number, number]
      linkRows[r] = `${(linkRows[r] as string).slice(0, x)}●${(linkRows[r] as string).slice(x + 1)}`
      dotRow = r
    }
    // From the triage box to the route boxes: one line to the chosen route, or a branch to all three while sizing.
    const sizeRow = Array.from({ length: rc[2]! + 1 }, (_, x) => (x === 1 ? '└' : x === rc[2] ? '┐' : x === rc[0] || x === rc[1] ? '┬' : x > 1 ? '─' : ' ')).join('')
    const forkRows = !side ? [] : mode ? [' │', elbow(1, rc[k] as number), `${' '.repeat(rc[k] as number)}▼`] : [' │', sizeRow, Array.from({ length: rc[2]! + 1 }, (_, x) => (rc.includes(x) ? '▼' : ' ')).join('')]
    const routeBox = (name: string, w: number, ml = 0) => {
      const chosen = name === mode
      return (
        <Box borderStyle={chosen ? (signed ? 'double' : 'bold') : 'round'} borderColor={chosen && mode ? MODE_COLOR[mode] : 'gray'} borderDimColor={!chosen} flexDirection="column" width={w} marginLeft={ml}>
          <Text bold={chosen} dimColor={!chosen} color={chosen && mode ? MODE_COLOR[mode] : undefined} wrap="truncate-end">{name}</Text>
          {chosen ? <Text color={COLOR[mainState]} wrap="truncate-end">◉ {g(mainState)} {WORD[mainState]}</Text> : <Text dimColor wrap="truncate-end">{mode ? '○ not taken' : '○ …'}</Text>}
        </Box>
      )
    }
    // The return rail into the second row, with the lane running down beside it and turning in at the right of the build box.
    const laneRail = (next: Stage) => {
      const color = into(next)
      const gap = ' '.repeat(Math.max(0, rowW - lx - 1))
      const pad = ' '.repeat(Math.max(0, ex - fx - 1))
      const rail = [`${' '.repeat(lx)}│`, `${' '.repeat(fx)}┌${'─'.repeat(Math.max(0, lx - fx - 1))}┘`, `${' '.repeat(fx)}│`, `${' '.repeat(fx)}▼`]
      const beside = [`${gap}│`, `${gap}│`, `${pad}┌${'─'.repeat(Math.max(0, rowW - ex - 1))}┘`, `${pad}▼`]
      return rail.map((text, i) => [{ text, color }, { text: beside[i] as string, color: linkColor }])
    }
    // Rows the fork adds over the old two-row arrow above the stages: the fork, the route boxes, the link, and the lane's extra rail row.
    const forkHeight = !active ? 0 : side ? 3 + 4 : mode ? 2 + 1 + 4 : 3
    const needsScroll =
      bodyRows > 0 &&
      26 + (active ? 5 : 0) + (work ? 4 : 0) + stageRows.length * 5 + (stageRows.length - 1) * 3 + diagramRows + tasks.length * 2 + byModel.length + shownLog.length +
        (active ? forkHeight + linkRows.length - 2 + (lane ? 1 : 0) : 0) + drawnLoops.reduce((t, l) => t + (Math.floor(l.toAt / cols) === Math.floor(l.fromAt / cols) ? 3 : 1), 0) +
        (steps.length ? 3 + Math.min(STEPS_SHOWN, steps.length) + (steps.length > STEPS_SHOWN ? 1 : 0) : 0) + (usedRows.length ? 2 + usedRows.length : 0) > bodyRows

    return (
      <Box flexDirection="column">
        {needsScroll && <Text dimColor>↑↓ scroll · click the pane or /orchestration</Text>}
        {!active && <Text dimColor>No orchestration agents yet.</Text>}
        {list.length > 0 && (
          <Box flexWrap="wrap">
            {models.map(m => (
              <Box marginRight={2}>
                <Text color={familyColor(m)} wrap="truncate-end">■ {short(m)}</Text>
              </Box>
            ))}
          </Box>
        )}
        {steps.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold wrap="truncate-end">
              progress · {stepsDone}/{steps.length} slices · {Math.round((100 * stepsDone) / steps.length)}%{stepsRunning ? ` · ${stepsRunning} running` : ''}
              {stepsFailed ? ` · ${stepsFailed} failed` : ''}
            </Text>
            <Box>
              {progRuns.map(r => (
                <Text color={r.color} bold={r.color === 'warning' && f % 4 < 2}>{r.text}</Text>
              ))}
            </Box>
            {steps.slice(0, STEPS_SHOWN).map(s => (
              <Text color={COLOR[s.state]} wrap="truncate-end">
                {g(s.state)} {s.id}{s.goal ? ` · ${s.goal}` : ''}
              </Text>
            ))}
            {steps.length > STEPS_SHOWN && <Text dimColor>+{steps.length - STEPS_SHOWN} more</Text>}
          </Box>
        )}
        {work && (
          <Box borderStyle="round" borderDimColor flexDirection="column" width={boxW}>
            <Text wrap="truncate-end">▸ {work.text}</Text>
          </Box>
        )}
        {work && down(flow, edge(flow, true), 1)}
        {active && (
          <Box borderStyle={signed ? 'double' : 'bold'} borderColor={COLOR[mainState]} flexDirection="column" width={boxW}>
            <Text bold color={orchestrator ? familyColor(orchestrator) : undefined} wrap="truncate-end">
              {g(mainState)} {short(orchestrator || 'main')} · orchestrator
            </Text>
            <Text color={COLOR[mainState]} wrap="truncate-end">
              {running || (working && !solo)
                ? `dispatching${dots} ${running} running`
                : solo
                  ? work ? (working ? `working in this session${dots}` : work.outcome === 'answered' ? 'answered in this session' : 'stopped before an answer') : 'waiting for agents'
                  : failed ? `signed off with ${failed} failed` : fixedN ? `passed · ${fixedN} fixed on the way` : 'all agents passed'}
            </Text>
            <Text dimColor wrap="truncate-end">
              {list.length} agents · {tokens(total)} tokens · {clock(solo ? (work ? (work.endedAt ?? now) - work.startedAt : 0) : last - first)}
            </Text>
          </Box>
        )}
        {active && down(flow, edge(flow, true), 1)}
        {!verdict && solo && working && (
          <Box borderStyle="round" borderColor="gray" borderDimColor flexDirection="column" width={boxW}>
            <Text dimColor wrap="truncate-end">triage · sizing…</Text>
          </Box>
        )}
        {(verdict || list.length > 0 || work?.endedAt) && mode && (
          <Box borderStyle="round" borderColor={MODE_COLOR[mode]} borderDimColor={!verdict} flexDirection="column" width={boxW}>
            <Text bold color={MODE_COLOR[mode]} wrap="truncate-end">triage · {mode}</Text>
            {verdict?.facts && (
              <Text wrap="truncate-end">files {verdict.facts.filesToTouch} · lines {verdict.facts.linesToChange} · slices {verdict.facts.independentSlices}</Text>
            )}
            {verdict?.facts && <Text wrap="truncate-end">risky {verdict.facts.risky ? 'yes' : 'no'} · code {verdict.facts.code ? 'yes' : 'no'}</Text>}
            <Text dimColor wrap="truncate-end">{verdict ? verdict.reason : solo ? '(inferred: no agents ran)' : '(inferred from the agents)'}</Text>
          </Box>
        )}
        {active && (
          <Box flexDirection="column">
            {side ? (
              <Box flexDirection="column">
                {forkRows.map(t => (
                  <Text color={forkColor}>{t}</Text>
                ))}
                <Box>{MODES.map((n, i) => routeBox(n, rw, i ? 2 : 0))}</Box>
              </Box>
            ) : (
              <Box flexDirection="column">
                {MODES.filter(n => n !== mode).map((n, i) => (
                  <Box>
                    <Text color={forkColor}>{mode ? ' │ ' : i === 2 ? ' └ ' : ' ├ '}</Text>
                    <Text dimColor>○ {n}</Text>
                  </Box>
                ))}
                {mode && <Text color={forkColor}>{' ▼'}</Text>}
                {mode && routeBox(mode, boxW)}
              </Box>
            )}
            {linkRows.map((t, i) => (
              <Text color={linkColor} bold={i === dotRow}>{t}</Text>
            ))}
          </Box>
        )}
        {active &&
          stageRows.map((row, r) => (
            <Box flexDirection="column">
              {r > 0 &&
                (lane && r === 1 ? (
                  <Box flexDirection="column">
                    {laneRail((stageRows[1] as Stage[])[0] as Stage).map(([a, b]) => (
                      <Box>
                        <Text color={(a as { color: string }).color}>{(a as { text: string }).text}</Text>
                        <Text color={(b as { color: string }).color}>{(b as { text: string }).text}</Text>
                      </Box>
                    ))}
                  </Box>
                ) : (
                  <Box flexDirection="column">
                    {railOf(row[0] as Stage).map(x => (
                      <Text color={x.color}>{x.text}</Text>
                    ))}
                  </Box>
                ))}
              <Box>
                {row.map((p, j) => {
                  const lit = live && p.idx <= furthest
                  return (
                    <Box>
                      {j > 0 && (
                        <Box flexDirection="column" justifyContent="center" width={3}>
                          <Text color={into(p)} bold={lit}>
                            {lit ? ['●─▶', '─●▶', '──▶'][f % 3] : '──▶'}
                          </Text>
                        </Box>
                      )}
                      <Box borderStyle="round" borderColor={COLOR[p.state]} borderDimColor={(p.state === 'running' && f % 4 < 2) || p.mode === 'next'} flexDirection="column" width={pw}>
                        <Text bold color={COLOR[p.state]} wrap="truncate-end">{g(p.state)} {p.name}</Text>
                        {p.name === 'triage' ? <Text color={COLOR[p.state]} wrap="truncate-end">{'▰'.repeat(Math.max(3, pw - 4))}</Text> : cellRow(cellsFor(p.name, p.group), Math.max(3, pw - 4))}
                        <Text dimColor wrap="truncate-end">
                          {p.n && p.name !== 'triage' ? `${p.done}/${p.n} ${[...new Set(p.group.map(a => family(a.model)))].join('+')}` : (p.mode ?? '-')}
                        </Text>
                      </Box>
                    </Box>
                  )
                })}
                {lane && r === 0 && (
                  <Box flexDirection="column">
                    {[0, 1, 2, 3, 4].map(() => (
                      <Text color={linkColor}>│</Text>
                    ))}
                  </Box>
                )}
              </Box>
              {drawnLoops
                .filter(l => Math.floor(l.fromAt / cols) === r)
                .map(l => {
                  const same = Math.floor(l.toAt / cols) === r
                  const fx0 = (l.fromAt % cols) * (pw + 3) + Math.floor(pw / 2)
                  const tx0 = (l.toAt % cols) * (pw + 3) + Math.floor(pw / 2)
                  // A running loop carries the dot backward: down from the later stage, along the line, up into the earlier one.
                  const back: [number, number][] = [[0, fx0]]
                  for (let x = fx0; x >= tx0; x--) back.push([1, x])
                  back.push([0, tx0])
                  const rows = same
                    ? dotted(
                        [`${' '.repeat(tx0)}▲${' '.repeat(Math.max(0, fx0 - tx0 - 1))}│`, `${' '.repeat(tx0)}└${'─'.repeat(Math.max(0, fx0 - tx0 - 1))}┘`],
                        l.live ? back : [],
                        f,
                      ).concat(`${' '.repeat(tx0)}${cut(l.label, Math.max(1, rowW - tx0))}`)
                    : [cut(`${l.label} (back to ${stages[l.toAt]?.name})`, rowW)]
                  return (
                    <Box flexDirection="column">
                      {rows.map(t => (
                        <Box>
                          <Text color={l.color} bold={l.live} wrap="truncate-end">{t.padEnd(rowW)}</Text>
                          {lane && r === 0 && <Text color={linkColor}>│</Text>}
                        </Box>
                      ))}
                    </Box>
                  )
                })}
            </Box>
          ))}
        {active && down(layers[0] ? (layers[0] as Node[]).some(n => stateOf(n) === 'running') : flow, layers[0] ? topTone((layers[0] as Node[]).map(n => toneOf(n, fix.has(n.id)))) : edge(flow, true), 1)}
        {vertical ? (
          <Box flexDirection="column">
            {layers.map((layer, i) => (
              <Box flexDirection="column">
                {i > 0 && down(layer.some(n => stateOf(n) === 'running'), layer.some(n => n.retryOf) ? tone(layer.filter(n => n.retryOf).map(n => (retryTone(n) === 'warning' ? 'running' : retryTone(n) === 'success' ? 'pass' : 'fail'))) : topTone(layer.map(n => toneOf(n, fix.has(n.id)))), 1, layer.some(n => n.retryOf))}
                <Box>
                  <Box flexDirection="column" width={3}>
                    {trunkOf(layer, fix, f).map(r => (
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
              const gut = i === 0 ? { width: 3, rows: trunkOf(layer, fix, f) } : gutters[i]
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
                        <Text color={toneOf(layer[layer.length - 1] as Node, fix.has((layer[layer.length - 1] as Node).id))}>{' '.repeat(Math.floor(colW / 2))}│</Text>
                      ))}
                  </Box>
                </Box>
              )
            })}
          </Box>
        )}
        {bus &&
          bus.rows.map(runs => (
            <Box>
              {runs.map(r => (
                <Text color={r.color}>{r.text}</Text>
              ))}
            </Box>
          ))}
        {active && (
          <Box marginLeft={Math.min(Math.max(0, (bus?.mid ?? 0) - Math.floor(boxW / 2)), Math.max(0, width - boxW))} borderStyle={signed ? 'double' : 'round'} borderColor={signed ? COLOR[mainState] : 'gray'} flexDirection="column" width={boxW}>
            <Text bold color={signed ? COLOR[mainState] : undefined} wrap="truncate-end">
              {signed ? GLYPH[mainState] : '◌'} sign off · {short(orchestrator || 'main')}
            </Text>
            <Text dimColor wrap="truncate-end">
              {solo && work
                ? working ? 'waiting for the reply' : work.outcome === 'answered' ? 'answered in this session' : 'stopped'
                : signed ? `${list.length - failed - fixedN} passed · ${failed} failed${fixedN ? ` · ${fixedN} fixed` : ''}` : 'waiting for agents · verified findings only'}
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
                  : l.kind === 'start' && l.note
                    ? `${l.note} · ${l.label} started · ${short(l.model)}`
                    : `${l.label} ${l.kind === 'start' ? `started · ${short(l.model)}` : `${ABBR[l.role] ?? l.role} · ${clock(l.ms ?? 0)} · ${tokens(l.tokens ?? 0)}`}`
              return (
                <Text color={LOGCOLOR[l.kind]} wrap="truncate-end">
                  {clock(Math.max(0, l.at - first))} {LOGMARK[l.kind]} {cut(text, logW)}
                </Text>
              )
            })}
          </Box>
        )}
        {usedRows.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>used in this session</Text>
            {usedRows.map(([label, value]) => (
              <Box>
                <Text dimColor>{label.padEnd(11)}</Text>
                <Text wrap="truncate-end">{value}</Text>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    )
  })
}
