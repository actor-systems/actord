import { expect, test } from 'claude-code/testing'

import { DEPLOY_COMMAND, GUARD_HOLD, GUARD_OUTSIDE_PROJECT, ROOM, TRACE, TRACE_UNKNOWN } from './fixtures.ts'

// What Claude Code passes a ui.render hook for the Room's pane, apart from the surface.
const PANE = {
  plugin: 'actors',
  component: 'Pane',
  requestId: 'actors-room',
  viewport: { columns: 120, rows: 40 },
  props: { title: 'Actors Room', isFocused: true, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 36 }, view: {} },
} as const

const SURFACES = ['terminal', 'desktop'] as const
const out = (doc: unknown, exitCode = 0) => ({ value: { exitCode, stdout: `${JSON.stringify(doc)}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

type Calls = { argv: string[][]; spawned: string[][]; status: Array<string | undefined>; registered: string[]; bash: string[]; asked: string[] }

/** Stubs for everything the Room calls; the CLI's answers are the recorded fixtures. */
function engine(on: any, opts: { room?: unknown; roomExit?: number; trace?: unknown; guard?: unknown; guardFails?: boolean; surfaces?: string[]; answer?: string | 'dismiss'; commands?: unknown[]; panes?: unknown[] } = {}): Calls {
  const calls: Calls = { argv: [], spawned: [], status: [], registered: [], bash: [], asked: [] }
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('command.list', () => ({ value: opts.commands ?? [] }))
  on('command.register', (_: unknown, e: { name: string }) => {
    calls.registered.push(e.name)
    return { value: { command: e.name } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.status', (_: unknown, e: { text?: string }) => {
    calls.status.push(e.text)
    return { value: undefined }
  })
  on('ui.log', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: opts.panes ?? [] }))
  on('session.surfaces', () => ({ value: opts.surfaces ?? ['terminal'] }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    calls.argv.push(e.argv.slice(1))
    const [command] = e.argv.slice(1)
    if (command === 'room') return out(opts.room ?? ROOM, opts.roomExit ?? 0)
    if (command === 'trace') return out(opts.trace ?? TRACE, (opts.trace ?? TRACE) === TRACE_UNKNOWN ? 1 : 0)
    if (command === 'guard') return opts.guardFails ? { deny: 'the actors CLI could not start' } : out(opts.guard ?? GUARD_HOLD)
    return { deny: `unexpected command ${e.argv.join(' ')}` }
  })
  on('process.spawn', async function* (_: unknown, e: { argv: string[] }) {
    calls.spawned.push(e.argv.slice(1))
    yield { stream: 'stdout', text: `${JSON.stringify(opts.room ?? ROOM)}\n` }
    return { value: { code: 0, signal: null } }
  })
  on('tool.call', (_: unknown, e: any) => {
    if (e.tool === 'AskUserQuestion') {
      calls.asked.push(e.questions[0].question)
      if (opts.answer === 'dismiss') return { deny: 'dismissed by the person' }
      return { result: { answers: { [e.questions[0].question]: opts.answer ?? 'Refuse' } } }
    }
    calls.bash.push(e.command)
    return { result: 'ran' }
  })
  return calls
}

// The person typing /<command> at the terminal prompt.
const typed = (command: string) => ({ command, args: '', origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 120 } })

const start = ($: any, isInteractive = true) => $.session.start({ cwd: '/work/release-radar', surface: isInteractive ? 'terminal' : null, isInteractive })

test('/actors-room opens the pane and draws every tab on terminal and desktop', async ($, on) => {
  const calls = engine(on)
  await start($)
  const opened = await $.command.run(typed('actors-room'))
  expect(opened.text).toContain('The actors Room is open')
  const ledger = ROOM.mailboxes.actors.find(a => a.name === 'ReleaseLedger')!
  const message = ledger.messages[ledger.messages.length - 1]!.messageId

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /release-radar/ })).toBeDefined()

    await ui.press({ key: 'tab-topology' })
    if (surface === 'terminal') {
      expect(await ui.find({ type: 'Text', text: '+ ReleaseLedger ──release.significant──▶ DigestWriter' })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: '- Notifier (deterministic) · removed' })).toBeDefined()
    } else {
      const svg = await ui.find({ type: 'Svg' })
      expect(svg).toBeDefined()
      expect(String((svg as any).props.source)).toContain('DigestWriter')
    }

    await ui.press({ key: 'tab-mailboxes' })
    expect(await ui.find({ key: `msg-${message}` })).toBeDefined()
    await ui.press({ key: `msg-${message}` })
    expect(await ui.find({ type: 'Text', text: new RegExp(`Trace ${message}`) })).toBeDefined()

    await ui.press({ key: 'tab-contracts' })
    expect(await ui.find({ type: 'Text', text: /actors check passed/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /feed\.watch@1/ })).toBeDefined()

    await ui.press({ key: 'tab-evidence' })
    expect(await ui.find({ type: 'Text', text: /Proved locally \(\d+\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Not guaranteed \(\d+\)/ })).toBeDefined()
    await ui.unmount()
  }
  expect(calls.argv).toContainEqual(['trace', message, '--json'])
})

test('the status line summarizes the project in an interactive session', async ($, on) => {
  const calls = engine(on)
  await start($)
  expect(calls.status).toContain(ROOM.status)
  expect(calls.registered).toEqual(['actors-room'])
})

test('/actors-room starts one follower, and a reloaded module restarts it only for a pane still up', async ($, on) => {
  const calls = engine(on, { panes: [{ id: 'actors-room', title: 'Actors Room', isShown: true, isFocused: false, isPlaced: true }] })
  await start($)
  expect(calls.spawned).toEqual([['room', '--follow', '--json']])
})

test('a session without the pane open starts no follower', async ($, on) => {
  const calls = engine(on)
  await start($)
  expect(calls.spawned).toEqual([])
  await $.command.run(typed('actors-room'))
  expect(calls.spawned).toEqual([['room', '--follow', '--json']])
})

test('a headless session registers the command but runs nothing at start', async ($, on) => {
  const calls = engine(on)
  await start($, false)
  expect(calls.argv).toEqual([])
  expect(calls.status).toEqual([])
})

test('a selected message nobody recorded is reported unknown', async ($, on) => {
  engine(on, { trace: TRACE_UNKNOWN })
  await start($)
  await $.command.run(typed('actors-room'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-mailboxes' })
  const first = ROOM.mailboxes.actors[0]!.messages[0]!.messageId
  await ui.press({ key: `msg-${first}` })
  expect(await ui.find({ type: 'Text', text: /^unknown: no recorded event has id no-such-message/ })).toBeDefined()
})

test('after /clear the pane reads the project again', async ($, on) => {
  const calls = engine(on)
  await $.classic.SessionStart({ source: 'clear' })
  expect(calls.argv).toContainEqual(['room', '--json'])
  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /release-radar/ })).toBeDefined()
    await ui.press({ key: 'tab-contracts' })
    expect(await ui.find({ type: 'Text', text: /feed\.poll\.due@1/ })).toBeDefined()
    await ui.unmount()
  }
})

test('outside an actor project the command says so and the pane shows nothing to draw', async ($, on) => {
  engine(on, { room: { schemaVersion: 1, projectRoot: null }, roomExit: 3 })
  await start($)
  const opened = await $.command.run(typed('actors-room'))
  expect(opened.text).toContain('No actor project here')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /No actor project loaded/ })).toBeDefined()
})

test('a CLI document of another schema version is refused, not drawn', async ($, on) => {
  engine(on, { room: { ...ROOM, schemaVersion: 2 } })
  await start($)
  await $.command.run(typed('actors-room'))
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /draws CLI schema 1; the project's actors CLI printed schema 2/ })).toBeDefined()
})

test('another plugin owning /actors-room moves the Room to /actors-room-view', async ($, on) => {
  const calls = engine(on, { commands: [{ name: 'actors-room', description: 'theirs', source: 'plugin', plugin: 'someone-else' }] })
  await start($)
  expect(calls.registered).toEqual(['actors-room-view'])
  const opened = await $.command.run(typed('actors-room-view'))
  expect(opened.text).toContain('The actors Room is open')
})

test('guard: a matching command is held, and Refuse denies it', async ($, on) => {
  const calls = engine(on, { answer: 'Refuse' })
  const result = await $.tool.call({ tool: 'Bash', command: DEPLOY_COMMAND })
  expect(result).toMatchObject({ deny: GUARD_HOLD.refusal })
  expect(calls.argv).toContainEqual(['guard', '--json', '--', DEPLOY_COMMAND])
  expect(calls.asked[0]).toContain('Deploy plan:')
  expect(calls.bash).toEqual([])
})

test('guard: dismissing the question denies the command', async ($, on) => {
  const calls = engine(on, { answer: 'dismiss' })
  const result = await $.tool.call({ tool: 'Bash', command: DEPLOY_COMMAND })
  expect(String((result as any).deny)).toContain('The question was dismissed')
  expect(calls.bash).toEqual([])
})

test('guard: an answer other than "Run it" denies the command', async ($, on) => {
  const calls = engine(on, { answer: 'sure, go ahead' })
  const result = await $.tool.call({ tool: 'Bash', command: DEPLOY_COMMAND })
  expect(result).toMatchObject({ deny: GUARD_HOLD.refusal })
  expect(calls.bash).toEqual([])
})

test('guard: a failing hook denies the command', async ($, on) => {
  const calls = engine(on, { guardFails: true })
  const result = await $.tool.call({ tool: 'Bash', command: DEPLOY_COMMAND })
  expect(String((result as any).deny)).toContain('could not judge')
  expect(calls.asked).toEqual([])
  expect(calls.bash).toEqual([])
})

test('guard: with nobody to ask, the command is refused with an instruction to ask the user', async ($, on) => {
  const calls = engine(on, { surfaces: [] })
  const result = await $.tool.call({ tool: 'Bash', command: DEPLOY_COMMAND })
  expect(String((result as any).deny)).toContain('no one to ask')
  expect(String((result as any).deny)).toContain('let them run it or approve it themselves')
  expect(calls.asked).toEqual([])
  expect(calls.bash).toEqual([])
})

test('guard: "Run it" passes the command on to Claude Code unchanged', async ($, on) => {
  const calls = engine(on, { answer: 'Run it' })
  const result = await $.tool.call({ tool: 'Bash', command: DEPLOY_COMMAND })
  expect(result).toMatchObject({ result: 'ran' })
  expect(calls.bash).toEqual([DEPLOY_COMMAND])
})

test('guard: a non-matching command passes untouched without running the CLI', async ($, on) => {
  const calls = engine(on)
  const result = await $.tool.call({ tool: 'Bash', command: 'npm test -- --run' })
  expect(result).toMatchObject({ result: 'ran' })
  expect(calls.bash).toEqual(['npm test -- --run'])
  expect(calls.argv).toEqual([])
})

test('guard: a matching command outside an actor project passes on', async ($, on) => {
  const calls = engine(on, { guard: GUARD_OUTSIDE_PROJECT })
  const result = await $.tool.call({ tool: 'Bash', command: DEPLOY_COMMAND })
  expect(result).toMatchObject({ result: 'ran' })
  expect(calls.asked).toEqual([])
})
