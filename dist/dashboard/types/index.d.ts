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
  /** From the brief: RISKY: yes, CHECKS ids, PATH: light. Absent on old-style briefs. */
  risky?: boolean
  checks?: string[]
  light?: boolean
  /** From the reply (docs/brief-grammar.md): one answer per checked constraint id, and the OPEN items. */
  answers?: Record<string, Answer>
  open?: string[]
}

/** One constraint answer in a reply: `C1: pass (cmd) ...`, `C1: pass (read) ...`, `C1: fail ...`. */
export type Answer = { verdict: 'pass' | 'fail'; mode: 'cmd' | 'read' | null; detail: string }

/** The run the gates would see (docs/brief-grammar.md, Run model): opened by a PLAN REVIEW launch without REPLAN, or by a light-path implementer
 * launch when none is open. Null when no run is open by those rules (agents launched without a plan review: shown as before). */
export type Run = { kind: 'planned' | 'light'; at: number; slice?: string }

export type LogEntry = {
  at: number
  /** 'triage' is the router's verdict; its label is the mode. */
  kind: 'start' | 'pass' | 'fail' | 'done' | 'triage' | 'blocked'
  role: string
  label: string
  model: string
  ms?: number
  tokens?: number
  /** Why a start happened, when it was a repeat: "retry 2 of s1" or "re-plan"; for 'blocked', the slice of the denied launch. 'blocked' is an Agent
   * launch a gate denied; its label is the reason (not_in_plan, builtin_agent_in_run, ...). */
  note?: string
}

/** The router's verdict (`npm run route`), as captured from the main loop's Bash result. */
export type TriageInfo = {
  at: number
  mode: 'plain' | 'reviewed' | 'orchestrate'
  reason: string
  facts?: { filesToTouch: number; linesToChange: number; independentSlices: number; risky: boolean; code: boolean }
}

/** The user's current piece of work: the prompt that started it and how the main session's turn ended. Set on `prompt.submit`, so it exists with no agents; null before and after (state cannot hold undefined). */
export type Work = { text: string; startedAt: number; endedAt?: number; outcome?: 'answered' | 'stopped' }

/** The orchestrator's plan: the SLICE lines (with their GOAL, RISKY and CHECKS lines) of the latest PLAN REVIEW brief that named a slice, extended by
 * a PLAN REVIEW with REPLAN. `replan` is the latest REPLAN number. Null until then and after a new run. */
export type Plan = {
  at: number
  slices: { id: string; goal?: string; risky?: boolean; checks?: string[] }[]
  replan?: number
  constraints?: Record<string, string>
}

/** What the session used, for "used in this session": kept for the whole session (a new run does not reset it). Lists keep the last 300. */
export type Used = {
  /** Skills expanded for the model, in first-use order. */
  skills: string[]
  /** MCP servers whose tools ran, by display name. */
  connectors: string[]
  /** Agents started, by bare type. */
  agents: Record<string, number>
  /** Built-in tools that ran without error, with counts (Agent and Skill are counted under agents and skills). */
  tools: Record<string, number>
  /** Paths Edit, Write or NotebookEdit changed. */
  edited: string[]
  /** Paths Read read that were not changed. */
  read: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'orchestration-dashboard': {
      agents: Agent[]; log: LogEntry[]; tick: number; main: string; triage: TriageInfo | null; work: Work | null; plan: Plan | null; used: Used; run: Run | null
    }
  }
}
