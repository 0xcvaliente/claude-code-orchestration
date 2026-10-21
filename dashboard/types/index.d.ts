export type Agent = {
  id: string
  role: string
  model: string
  /** The slice id from the brief's SLICE line; absent for plan review, research and the integrator. */
  slice?: string
  label: string
  deps: string[]
  files: number
  startedAt: number
  endedAt?: number
  status: 'running' | 'pass' | 'fail' | 'done'
  tool?: string
  /** Everything the agent used: input, output and cache tokens. */
  tokens: number
  inTokens: number
  outTokens: number
  cacheTokens: number
  /** First line of the agent's report that says what it did. */
  result?: string
}

export type LogEntry = {
  at: number
  kind: 'start' | 'pass' | 'fail' | 'done'
  role: string
  label: string
  model: string
  ms?: number
  tokens?: number
}

declare module 'claude-code' {
  interface PluginState {
    'orchestration-dashboard': { agents: Agent[]; log: LogEntry[]; tick: number; main: string }
  }
}
