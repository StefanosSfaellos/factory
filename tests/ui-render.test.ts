import { expect, mock, test } from 'claude-code/testing'

const json = (v: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(v) } })

const PANE = {
  plugin: 'software-factory',
  component: 'Pane',
  requestId: 'factory',
  props: { title: 'Factory', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 30 }, view: {} },
} as const

const BAND = {
  plugin: 'software-factory',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 10 }, view: {} },
} as const

type Note = { id: number; body: string; created_at: string; author: { username: string } }

/** A tiny GitLab in memory, answering $.http.fetch for a few issues of g/p. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function gitlab(on: any, issues: { iid: number; title: string; station: string; notes?: Note[] }[], factoryYml?: string, hold?: { armed: boolean; waiting: number; gate: Promise<void> }) {
  const store = new Map(issues.map((i) => [i.iid, { ...i, labels: [`factory::${i.station}`], notes: i.notes ?? [] }]))
  const posts: { url: string; body: string }[] = []
  const counts = { listings: 0 }
  let n = 100
  on('http.fetch', async (_: unknown, e: { url: string; init?: { method?: string; body?: string } }) => {
    // Another project's listing that waits on a gate while armed: a tick holding the lock.
    if (hold?.armed && hold.waiting === 0 && e.url.includes('/projects/g%2Fq/issues?')) { hold.waiting++; await hold.gate; return json([]) }
    if (e.url.includes('/projects/g%2Fq/')) return json([])
    const method = e.init?.method ?? 'GET'
    const u = e.url.replace('https://gitlab.com/api/v4', '')
    if (u === '/user') return json({ username: 'bot' })
    if (u === '/projects/g%2Fp') return json({ default_branch: 'main' })
    if (u.startsWith('/projects/g%2Fp/repository/files/')) {
      return factoryYml === undefined ? { value: { status: 404, ok: false, headers: {}, text: '' } } : { value: { status: 200, ok: true, headers: {}, text: factoryYml } }
    }
    if (u.startsWith('/projects/g%2Fp/issues?') && u.endsWith('page=1')) counts.listings++
    if (u.startsWith('/projects/g%2Fp/issues?')) return json(u.endsWith('page=1') ? [...store.values()].map((i) => ({ iid: i.iid, labels: i.labels })) : [])
    const m = /^\/projects\/g%2Fp\/issues\/(\d+)(.*)$/.exec(u)
    const issue = m ? store.get(Number(m[1])) : undefined
    if (!m || !issue) return { value: { status: 404, ok: false, headers: {}, text: '' } }
    const rest = m[2]
    if (rest === '' && method === 'GET') return json({ iid: issue.iid, title: issue.title, description: '', labels: issue.labels })
    if (rest === '' && method === 'PUT') {
      const b = JSON.parse(e.init!.body!)
      issue.labels = [...issue.labels.filter((l) => !String(b.remove_labels ?? '').split(',').includes(l)), b.add_labels]
      return json({})
    }
    if (rest.startsWith('/notes?')) return json(rest.endsWith('page=1') ? issue.notes : [])
    if (rest === '/notes' && method === 'POST') {
      const body = JSON.parse(e.init!.body!).body as string
      posts.push({ url: e.url, body })
      const note = { id: ++n, body, created_at: new Date(Date.UTC(2026, 9, 21, 13, 0, n)).toISOString(), author: { username: 'bot' } }
      issue.notes.push(note)
      return json(note)
    }
    if (rest.startsWith('/notes/') && method === 'PUT') {
      const note = issue.notes.find((x) => String(x.id) === rest.split('/').pop())
      if (note) note.body = JSON.parse(e.init!.body!).body
      return json(note ?? {})
    }
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  return { store, posts, counts }
}

const SPEC_NOTE: Note = { id: 1, body: '<!-- factory:spec -->\n## Goal\nRound VAT per line.', created_at: '2026-10-21T12:00:00Z', author: { username: 'bot' } }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function startParent($: any, on: any, env: Record<string, string>, surface: 'terminal' | 'desktop' = 'terminal') {
  const toasts: string[] = []
  const opened: string[] = []
  mock.env(on, env)
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 21, 12, 30) })
  on('command.register', (_: unknown, e: { name: string }) => ({ value: { command: e.name } }))
  on('ui.open', (_: unknown, e: { id: string }) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('ui.toast', (_: unknown, e: { text: string }) => { toasts.push(e.text); return { value: undefined } })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface, isInteractive: true })
  return { toasts, opened, clock }
}

test('/factory opens the pane; Approve posts /approve and re-ticks; Svg only on desktop', { options: { repos: 'gitlab:g/p', workerId: 'w1' } }, async ($, on) => {
  const g = gitlab(on, [{ iid: 42, title: 'Round VAT', station: 'awaiting-spec', notes: [SPEC_NOTE] }])
  const { opened, toasts } = await startParent($, on, { GITLAB_TOKEN: 'glpat-abcdefghijklmnop', HOME: '/home/u' })
  const r = await $.command.run({ command: 'factory', args: '' })
  expect(r.text).toBeUndefined()
  expect(opened).toEqual(['factory'])

  const desk = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await desk.find({ type: 'Svg' })).toBeDefined()
  await desk.unmount()

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect((await ui.find({ key: 'job-42' }))?.text).toBe('#42 Round VAT')
  expect(await ui.find({ key: 'approve-42' })).toBeDefined()
  expect(await ui.find({ key: 'refresh' })).toBeDefined()

  await ui.press({ key: 'approve-42' })
  expect(g.posts.some((p) => p.body.includes('/approve'))).toBe(true)
  // Re-ticked at once: the approval moves it to design, which blocks on the missing .factory.yml.
  expect(g.store.get(42)!.labels).toEqual(['factory::blocked'])
  expect(toasts).toContain('factory #42 blocked at design')
  // The views were refreshed from the forge after the tick.
  expect(await ui.find({ key: 'approve-42' })).toBeUndefined()
  await ui.unmount()
})

test('Revise takes notes in an Input; empty notes are refused with a message', { options: { repos: 'gitlab:g/p' } }, async ($, on) => {
  const g = gitlab(on, [{ iid: 42, title: 'Round VAT', station: 'awaiting-spec', notes: [SPEC_NOTE] }])
  await startParent($, on, { GITLAB_TOKEN: 'glpat-abcdefghijklmnop' })
  await $.command.run({ command: 'factory', args: '' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'revise-42' })
    // The spec review: the spec as Markdown, Approve, and the notes field.
    expect(await ui.find({ type: 'Markdown', text: /Round VAT per line/ })).toBeDefined()
    expect(await ui.find({ key: 'approve-42' })).toBeDefined()
    await ui.input({ key: 'notes-42', text: '   ' })
    expect(g.posts.length).toBe(0)
    expect(await ui.find({ type: 'Text', text: /needs notes/ })).toBeDefined()
    await ui.press({ key: 'back' })
    expect(await ui.find({ key: 'job-42' })).toBeDefined()
    await ui.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'revise-42' })
  await ui.input({ key: 'notes-42', text: 'handle refunds too' })
  // Lease comments of the re-tick aside, the one decision posted is the revise.
  expect(g.posts.map((p) => p.body).filter((b) => !b.startsWith('<!--'))).toEqual(['/revise handle refunds too'])
  await ui.unmount()
})

test('the band shows the summary; Refresh re-reads the forge, a redraw does not', { options: { repos: 'gitlab:g/p' } }, async ($, on) => {
  const g = gitlab(on, [
    { iid: 1, title: 'A', station: 'build' },
    { iid: 2, title: 'B', station: 'build' },
    { iid: 3, title: 'C', station: 'review' },
    { iid: 4, title: 'D', station: 'awaiting-spec', notes: [SPEC_NOTE] },
  ])
  await startParent($, on, { GITLAB_TOKEN: 'glpat-abcdefghijklmnop' })
  await $.command.run({ command: 'factory', args: '' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const band = await $.ui.mount({ ...BAND, surface })
    expect((await band.find({ type: 'Text', text: /^Factory/ }))?.text).toBe('Factory · 2 building · 1 in review · 1 needs you')
    expect(await band.find({ key: 'review-4' })).toBeDefined()
    await band.unmount()
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const before = g.counts.listings
  await ui.redraw()
  expect(g.counts.listings).toBe(before)
  await ui.press({ key: 'refresh' })
  expect(g.counts.listings).toBe(before + 1)
  await ui.unmount()
})

const SPINNER = {
  plugin: 'software-factory',
  component: 'Spinner',
  props: { word: 'Working', message: null, suffix: '…', mode: 'requesting' },
} as const

test('the spinner suffix shows only while a station runs; progress lines reach the pane', { options: { repos: 'gitlab:g/p', workerId: 'w1' } }, async ($, on) => {
  gitlab(on, [{ iid: 4, title: 'Add VAT', station: 'spec' }], 'forge: gitlab\ntest: "npm test"\n')
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  let release!: () => void
  const gate = new Promise<void>((r) => { release = r })
  let spawned = 0
  on('process.spawn', async function* () {
    spawned++
    yield { stream: 'stdout' as const, text: '{"type":"assistant","message":{"content":[{"type":"text","text":"Drafting the spec"}]}}\n' }
    await gate
    yield { stream: 'stdout' as const, text: '{"type":"result","subtype":"success","result":"## Goal\\nx"}\n' }
    return { value: { code: 0, signal: null } }
  } as any)
  // The engine's own spinner, beneath the plugin: word then suffix.
  on('ui.render', { component: 'Spinner' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: `${e.props.word}${e.props.suffix}` })
  })
  const { toasts, clock } = await startParent($, on, { GITLAB_TOKEN: 'glpat-abcdefghijklmnop', HOME: '/home/u' })
  await $.command.run({ command: 'factory', args: '' })
  const spin = await $.ui.mount({ ...SPINNER, surface: 'terminal' })
  expect(JSON.stringify(await spin.drawn())).not.toContain('factory #')
  const running = $.command.run({ command: 'factory', args: 'run #4' })
  for (let i = 0; i < 50 && spawned === 0; i++) await clock.settle()
  await spin.redraw()
  expect(JSON.stringify(await spin.drawn())).toContain(' · factory #4 spec')
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await pane.find({ type: 'Text', text: /Drafting the spec/ })).toBeDefined()
  release()
  await running
  await spin.redraw()
  expect(JSON.stringify(await spin.drawn())).not.toContain('factory #')
  expect(toasts).toContain('factory #4 needs you: awaiting-spec')
  await pane.unmount()
  await spin.unmount()
})

test('Approve while a tick holds the lock: posted, no deadlock, the buttons go', { options: { repos: 'gitlab:g/p,gitlab:g/q', workerId: 'w1' } }, async ($, on) => {
  // Armed later: a tick that cannot finish yet, its g/q listing waiting on the gate while it holds the shared lock.
  let release!: () => void
  const hold = { armed: false, waiting: 0, gate: new Promise<void>((r) => { release = r }) }
  const g = gitlab(on, [{ iid: 42, title: 'Round VAT', station: 'awaiting-spec', notes: [SPEC_NOTE] }], undefined, hold)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
  const { clock } = await startParent($, on, { GITLAB_TOKEN: 'glpat-abcdefghijklmnop', HOME: '/home/u' })
  await $.command.run({ command: 'factory', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 'approve-42' })).toBeDefined()
  hold.armed = true
  const tick = $.command.run({ command: 'factory', args: 'tick' })
  for (let i = 0; i < 50 && hold.waiting === 0; i++) await clock.settle()
  expect(hold.waiting).toBe(1)
  await ui.press({ key: 'approve-42' })
  expect(g.posts.map((p) => p.body).filter((b) => !b.startsWith('<!--'))).toEqual(['/approve'])
  // No re-tick ran (the lock was held), yet the job no longer asks for a decision.
  expect(await ui.find({ key: 'approve-42' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /a tick is already running/ })).toBeDefined()
  hold.armed = false
  release()
  expect((await tick).text).toContain('factory tick:')
  await ui.unmount()
})

test('no secret reaches the drawing', { options: { repos: 'gitlab:g/p' } }, async ($, on) => {
  gitlab(on, [{ iid: 5, title: 'Leaks glpat-abcdefghijklmnop here', station: 'build' }])
  await startParent($, on, { GITLAB_TOKEN: 'glpat-abcdefghijklmnop' })
  await $.command.run({ command: 'factory', args: '' })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(JSON.stringify(await ui.drawn())).not.toContain('glpat-abcdefghijklmnop')
  expect((await ui.find({ key: 'job-5' }))?.text).toBe('#5 Leaks [redacted] here')
  await ui.unmount()
})

test('/factory in a non-interactive session answers one line and opens nothing', async ($, on) => {
  const opened: string[] = []
  mock.env(on, {})
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.open', (_, e) => { opened.push(e.id); return { value: { isPlaced: true } } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const r = await $.command.run({ command: 'factory', args: '' })
  expect(r.text!.split('\n').length).toBe(1)
  expect(r.text).toContain('/factory status')
  expect(opened).toEqual([])
})

test('a child session draws nothing of its own', { options: { repos: 'gitlab:g/p' } }, async ($, on) => {
  mock.env(on, { FACTORY_ROLE: 'builder' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return Text({ children: 'engine' })
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const target of [BAND, PANE] as const) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui = await $.ui.mount({ ...(target as any), surface: 'terminal' })
    expect((await ui.find({ type: 'Text', text: /engine/ }))?.text).toBe('engine')
    expect(await ui.find({ type: 'Text', text: /Factory/ })).toBeUndefined()
    await ui.unmount()
  }
})
