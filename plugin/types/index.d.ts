// The Room's state contract: what its pane draws from, all of it CLI JSON (`actors room --json`,
// `actors trace --json`) kept as printed. Schema version 1 of the CLI's documents.

export type RoomTab = 'topology' | 'mailboxes' | 'contracts' | 'evidence'

export type RoomChange = 'added' | 'removed' | null

export type RoomSnapshot = {
  schemaVersion: number
  projectRoot: string | null
  system: string | null
  status: string | null
  error: string | null
  topology: {
    base: string
    lines: string[]
    svg: string
    alt: string
    changes: number
    actors: Array<{ name: string; kind: string; change: RoomChange }>
    routes: Array<{ from: string; message: string; to: string; change: RoomChange }>
  } | null
  contracts: {
    messages: Array<{ name: string; version: number; description: string; routes: string[] }>
    check: { state: 'pass' | 'fail' | 'stale' | 'none'; errors: number; warnings: number; codes: string[]; checkedAt: string | null }
  } | null
  mailboxes: {
    file: string
    events: number
    actors: Array<{
      name: string
      received: number
      messages: Array<{ messageId: string; type: string | null; from: string | null; to: string; outcome: string; mark: string; attempts: number; reason: string | null }>
    }>
    notable: string[]
  }
  evidence: {
    state: 'pass' | 'fail' | 'stale' | 'none' | 'blocked'
    generatedAt: string | null
    profile: string | null
    groups: Array<{ status: string; label: string; claims: Array<{ id: string; statement: string; why: string | null }> }>
  }
}

export type RoomTraceNode = {
  messageId: string
  type: string | null
  from: string | null
  to: string | null
  outcome: string
  attempts: number
  failures: string[]
  rejectedReason: string | null
  notes: string[]
  effects: Array<{ effect: string; key: string; outcome: string; attempts: number; reason: string | null; result: RoomTraceNode | null }>
  children: RoomTraceNode[]
}

export type RoomTrace = {
  schemaVersion: number
  found: boolean
  target: string
  correlationId: string | null
  rootCauseUnknown: boolean
  root: RoomTraceNode | null
  coverage: { file: string | null; events: number; note: string }
}

declare module 'claude-code' {
  interface PluginState {
    actors: {
      snapshot: Shaped<RoomSnapshot | null>
      tab: RoomTab
      selected: string | null
      trace: Shaped<RoomTrace | null>
    }
  }
}
