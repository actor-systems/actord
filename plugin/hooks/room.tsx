// The Room: a pane that draws the actors CLI's view of this project, and a guard that holds deployment and
// remote-write commands for a person. It computes nothing: every snapshot, trace, question and refusal is
// CLI JSON (`actors room`, `actors trace`, `actors guard`), so the same answers exist as text without it.
// It calls no model and approves nothing: an approved command goes on to Claude Code's own permission check.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { RoomSnapshot, RoomTab, RoomTrace, RoomTraceNode } from '../types'
import { EFFECT_PATTERNS } from './effect-patterns.ts'

const PANE = 'actors-room'
const COMMAND = 'actors-room'
// Used only when another plugin already owns /actors-room.
const FALLBACK_COMMAND = 'actors-room-view'
const ROOM_DESCRIPTION = 'Open the actors Room: topology, mailboxes, contracts, and evidence for this actor project'
const SCHEMA = 1
const TABS: ReadonlyArray<[RoomTab, string]> = [
  ['topology', 'Topology'],
  ['mailboxes', 'Mailboxes'],
  ['contracts', 'Contracts'],
  ['evidence', 'Evidence'],
]
const EFFECTS = EFFECT_PATTERNS.map(p => new RegExp(p.source, p.flags))

// Change a tag when the CLI's document changes shape: a reload then declines what an older version stored.
const snapshot = atom({ plugin: 'actors', key: 'snapshot' } as const, null, { shape: 'room-1' })
const tab = atom({ plugin: 'actors', key: 'tab' } as const, 'topology')
const selected = atom({ plugin: 'actors', key: 'selected' } as const, null)
const trace = atom({ plugin: 'actors', key: 'trace' } as const, null, { shape: 'trace-1' })

const actors = ($: EngineInterface, args: string[]) =>
  $.process.run([`${$.plugin.root}/bin/actors`, ...args], { timeoutMs: 8000 })

/** One `actors room --json`: the snapshot the pane draws and the status line. */
async function refresh($: EngineInterface): Promise<RoomSnapshot | null> {
  const run = await actors($, ['room', '--json'])
  if (run.exitCode === 3) {
    await update($, snapshot, () => null)
    $.ui.status(undefined)
    return null
  }
  const snap = JSON.parse(run.stdout) as RoomSnapshot
  await show($, snap)
  return snap
}

async function show($: EngineInterface, snap: RoomSnapshot) {
  await update($, snapshot, () => snap)
  $.ui.status(snap.schemaVersion !== SCHEMA ? `actors · the Room expects CLI schema ${SCHEMA}, got ${snap.schemaVersion}` : (snap.status ?? undefined))
}

// The follower is the child behind the open pane; a reload or the pane's close ends it.
let follower: AsyncGenerator<unknown, unknown> | null = null

function follow($: EngineInterface) {
  if (follower) return
  const stream = $.process.spawn({ argv: [`${$.plugin.root}/bin/actors`, 'room', '--follow', '--json'] })
  follower = stream
  void (async () => {
    let pending = ''
    try {
      for await (const piece of stream) {
        if (piece.stream !== 'stdout') continue
        pending += piece.text
        for (let cut = pending.indexOf('\n'); cut >= 0; cut = pending.indexOf('\n')) {
          const line = pending.slice(0, cut)
          pending = pending.slice(cut + 1)
          const snap = JSON.parse(line) as RoomSnapshot
          if (snap.projectRoot) await show($, snap)
        }
      }
    } catch (err) {
      $.ui.log(`actors room --follow stopped: ${String(err)}`, { to: 'debug' })
    } finally {
      if (follower === stream) follower = null
    }
  })()
}

async function openRoom($: EngineInterface) {
  const { isPlaced } = await $.ui.open({ id: PANE, title: 'Actors Room' })
  const snap = await refresh($)
  if (!snap) return { text: 'No actor project here (no system.ts with a package.json at or above this directory), so the Room has nothing to show.' }
  follow($)
  return { text: isPlaced ? `The actors Room is open: ${snap.status ?? ''}` : 'The actors Room is open; it shows once the window is wide enough.' }
}

async function selectMessage($: EngineInterface, id: string) {
  await update($, selected, () => id)
  const run = await actors($, ['trace', id, '--json'])
  await update($, trace, () => JSON.parse(run.stdout) as RoomTrace)
}

// A Room that can't open still answers, pointing at the same view as text.
const unopened = () => ({ text: 'The actors Room could not open. `actors room` prints the same view as text.' })

const changeColor = (change: string | null) => (change === 'added' ? 'success' : change === 'removed' ? 'error' : undefined)
const outcomeColor = (outcome: string) =>
  outcome === 'handled' || outcome === 'confirmed' ? 'success' : outcome === 'in-flight' || outcome === 'pending' ? 'warning' : outcome === 'unknown' ? 'subtle' : 'error'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const taken = (await $.command.list()).some(c => c.name === COMMAND && c.plugin !== undefined && c.plugin !== $.plugin.name)
    if (taken) await $.command.register({ name: 'actors-room-view', description: ROOM_DESCRIPTION })
    else await $.command.register({ name: 'actors-room', description: ROOM_DESCRIPTION })
    // The status line is for people; a headless run (-p, the SDK, evals) has nowhere to show it.
    if (e.isInteractive) {
      await refresh($).catch(() => $.ui.status(undefined))
      // A reload runs session.start again and ends the old module's child; a pane still up gets a new one.
      if ((await $.ui.panes()).some(pane => pane.id === PANE)) follow($)
    }
    return started
  })

  // /clear resets the pane's state; read the project again so the pane and status line aren't empty.
  on('classic.SessionStart', async ($, e, next) => {
    const result = await next(e)
    if (e.source === 'clear') await refresh($).catch(() => undefined)
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async $ => openRoom($)).catch(unopened)
  on('command.run', { command: FALLBACK_COMMAND }, async $ => openRoom($)).catch(unopened)

  on('ui.close', { id: PANE }, async ($, e, next) => {
    const closing = follower
    follower = null
    await closing?.return(undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  // The effect guard. Most Bash calls fail the in-process pattern test and pass untouched; a match asks
  // `actors guard` whether to hold it (inside an actor project) and what to show.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const command = String(e.command ?? '')
    if (!EFFECTS.some(re => re.test(command))) return next(e)
    const run = await actors($, ['guard', '--json', '--', command])
    const decision = JSON.parse(run.stdout) as { hold: boolean; question: string | null; refusal: string | null }
    if (!decision.hold) return next(e)
    const refusal = decision.refusal ?? `The actors Room held \`${command}\`.`
    if ((await $.session.surfaces()).length === 0) return { deny: `${refusal} This session has no one to ask (non-interactive), so the Room refused it.` }
    let answer: string
    try {
      answer = await $.ui.ask(decision.question ?? `Run \`${command}\`?`, { header: 'Room guard', options: ['Refuse', 'Run it'] })
    } catch {
      return { deny: `${refusal} The question was dismissed.` }
    }
    return answer === 'Run it' ? next(e) : { deny: refusal }
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'The actors Room could not judge this deployment or remote-write command, so it refused it. Ask the user to run it themselves.' },
  )

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const els = $.ui.resolve(e)
    const snap = await read($, snapshot)
    const current = await read($, tab)

    const header = (
      <Box flexDirection="row" gap={1} flexWrap="wrap">
        {TABS.map(([id, label], i) => (
          <Button key={`tab-${id}`} label={label} hotkey={String(i + 1)} variant={id === current ? 'primary' : 'secondary'} onPress={() => update($, tab, () => id)} />
        ))}
        <Button key="refresh" label="Refresh" hotkey="r" onPress={() => refresh($).then(() => follow($))} />
      </Box>
    )
    if (!snap) {
      return (
        <Box flexDirection="column">
          {header}
          <Text dimColor>No actor project loaded. Open the Room from an actor project (system.ts beside package.json), or press Refresh.</Text>
        </Box>
      )
    }
    if (snap.schemaVersion !== SCHEMA) {
      return (
        <Box flexDirection="column">
          {header}
          <Text color="error">This Room draws CLI schema {SCHEMA}; the project's actors CLI printed schema {snap.schemaVersion}. Update the plugin or the project's actors-toolkit pin.</Text>
        </Box>
      )
    }

    const title = (
      <Text bold>
        {snap.system ?? 'actor system'} <Text dimColor>{snap.status ?? ''}</Text>
      </Text>
    )
    let body
    if (snap.error) {
      body = <Text color="error">The declaration doesn't load: {snap.error}</Text>
    } else if (current === 'topology') {
      const t = snap.topology
      body = !t ? (
        <Text dimColor>No topology.</Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>
            Against {t.base}: {t.changes === 0 ? 'no architectural changes' : `${t.changes} change(s); added in green, removed in red`}
          </Text>
          {e.surface !== 'terminal' && 'Svg' in els ? (
            <els.Svg source={t.svg} alt={t.alt} />
          ) : (
            t.lines.map(line => <Text color={changeColor(line.startsWith('+') ? 'added' : line.startsWith('-') ? 'removed' : null)}>{line || ' '}</Text>)
          )}
        </Box>
      )
    } else if (current === 'mailboxes') {
      const picked = await read($, selected)
      const path = await read($, trace)
      const m = snap.mailboxes
      body = (
        <Box flexDirection="column">
          {path && tracePath($, e, path)}
          {m.actors.length === 0 ? (
            <Text dimColor>No local events in {m.file} yet. Run the tests; messages appear here as they're recorded.</Text>
          ) : (
            m.actors.map(box => (
              <Box flexDirection="column" key={`box-${box.name}`}>
                <Text bold>
                  {box.name} <Text dimColor>({box.received} received, latest {box.messages.length})</Text>
                </Text>
                {box.messages.map(msg => (
                  <Button key={`msg-${msg.messageId}`} plain onPress={() => selectMessage($, msg.messageId)}>
                    {msg.messageId === picked ? '▸ ' : '  '}
                    {msg.mark} {msg.type ?? '?'} <Text dimColor>{msg.from ?? '?'} → {msg.to}</Text>
                  </Button>
                ))}
              </Box>
            ))
          )}
          {m.notable.length > 0 && <Text color="warning">Notable: {m.notable[m.notable.length - 1]}</Text>}
        </Box>
      )
    } else if (current === 'contracts') {
      const c = snap.contracts
      const check = c?.check
      body = !c ? (
        <Text dimColor>No contracts.</Text>
      ) : (
        <Box flexDirection="column">
          <Text color={check?.state === 'pass' ? 'success' : check?.state === 'fail' ? 'error' : 'warning'}>
            {check?.state === 'pass'
              ? `✓ actors check passed (${check.warnings} warning(s)) at ${check.checkedAt}`
              : check?.state === 'fail'
                ? `✗ actors check: ${check.errors} error(s): ${check.codes.join(', ')}`
                : check?.state === 'stale'
                  ? `Stale: actor files changed since the last check (${check.checkedAt}). Run actors check.`
                  : 'No check recorded yet. Run actors check.'}
          </Text>
          {c.messages.map(msg => (
            <Box flexDirection="column" key={`contract-${msg.name}`}>
              <Text bold>
                {msg.name}@{msg.version} <Text dimColor>{msg.description}</Text>
              </Text>
              <Text dimColor>  {msg.routes.length ? msg.routes.join(' · ') : 'no route'}</Text>
            </Box>
          ))}
        </Box>
      )
    } else {
      const ev = snap.evidence
      body = (
        <Box flexDirection="column">
          <Text color={ev.state === 'pass' ? 'success' : ev.state === 'fail' ? 'error' : 'warning'}>
            {ev.state === 'none'
              ? 'No verify report yet. Run actors verify.'
              : `actors verify: ${ev.state}${ev.state === 'stale' ? ' (actor files changed since; run actors verify again)' : ''} · ${ev.profile ?? ''} · ${ev.generatedAt ?? ''}`}
          </Text>
          {ev.groups.map(group => (
            <Box flexDirection="column" key={`group-${group.status}`}>
              <Text bold>
                {group.label} ({group.claims.length})
              </Text>
              {group.claims.map(claim => (
                <Text>
                  {'  '}
                  {claim.id}: <Text dimColor>{claim.statement}</Text>
                </Text>
              ))}
            </Box>
          ))}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        {header}
        {title}
        {body}
      </Box>
    )
  })
}

/** The causal path of the selected message, as `actors trace --json` printed it; unknown where coverage ends. */
function tracePath($: EngineInterface, e: Parameters<EngineInterface['ui']['resolve']>[0], t: RoomTrace) {
  const { Box, Text } = $.ui.resolve(e)
  if (!t.found || !t.root) {
    return (
      <Text color="subtle">
        unknown: no recorded event has id {t.target}. Coverage is {t.coverage.file ?? 'no log'}, local runs only.
      </Text>
    )
  }
  const rows: Array<{ depth: number; text: string; outcome: string; isTarget: boolean }> = []
  const walk = (n: RoomTraceNode, depth: number) => {
    const why = n.rejectedReason ? `: ${n.rejectedReason}` : ''
    rows.push({ depth, text: `${n.from ?? '?'} → ${n.to ?? '?'}  ${n.type ?? '?'}  ${n.outcome}${why}`, outcome: n.outcome, isTarget: n.messageId === t.target })
    for (const f of n.failures) rows.push({ depth: depth + 1, text: `! ${f}`, outcome: 'failed', isTarget: false })
    for (const fx of n.effects) {
      rows.push({ depth: depth + 1, text: `effect ${fx.effect} [${fx.key}]  ${fx.outcome}${fx.reason ? `: ${fx.reason}` : ''}`, outcome: fx.outcome, isTarget: false })
      if (fx.result) walk(fx.result, depth + 2)
    }
    for (const child of n.children) walk(child, depth + 1)
  }
  walk(t.root, 0)
  return (
    <Box flexDirection="column">
      <Text bold>
        Trace {t.target} <Text dimColor>· correlation {t.correlationId ?? '?'} · {t.coverage.file} (local only)</Text>
      </Text>
      {t.rootCauseUnknown && <Text color="subtle">? earlier cause unknown: outside recorded coverage</Text>}
      {rows.map(row => (
        <Text color={outcomeColor(row.outcome)}>
          {'  '.repeat(row.depth + 1)}
          {row.text}
          {row.isTarget ? '  ◀' : ''}
        </Text>
      ))}
    </Box>
  )
}
