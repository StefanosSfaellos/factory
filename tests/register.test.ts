import { expect, mock, test } from 'claude-code/testing'
import { parseCommand } from '../src/commands'

const json = (v: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(v) } })

test('/factory status lists 0 jobs for a configured repo with no issues', { options: { repos: 'gitlab:g/p' } }, async ($, on) => {
  const registered: string[] = []
  const urls: string[] = []
  mock.env(on, { GITLAB_TOKEN: 'glpat-test-token-123456', HOME: '/home/u' })
  on('command.register', (_, e) => { registered.push(e.name); return { value: { command: e.name } } })
  on('http.fetch', (_, e) => { urls.push(e.url); return json([]) })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  expect(registered).toEqual(['factory'])
  const r = await $.command.run({ command: 'factory', args: 'status' })
  expect(r.text).toContain('0 jobs')
  expect(urls[0]).toBe('https://gitlab.com/api/v4/projects/g%2Fp/issues?state=opened&per_page=100&page=1')
})

test('/factory status with no repos configured answers with text', async ($, on) => {
  mock.env(on, {})
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const r = await $.command.run({ command: 'factory', args: 'status' })
  expect(r.text).toContain('no repos configured')
})

test('/factory status without a token says which variable is missing', { options: { repos: 'github:o/r' } }, async ($, on) => {
  mock.env(on, {})
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const r = await $.command.run({ command: 'factory', args: 'status' })
  expect(r.text).toContain('GITHUB_TOKEN')
})

test('/factory with no args returns help; bad subcommand returns an error', async ($, on) => {
  mock.env(on, {})
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  expect((await $.command.run({ command: 'factory', args: '' })).text).toContain('/factory tick')
  expect((await $.command.run({ command: 'factory', args: 'revise #4' })).text).toContain('notes')
})

test('a child session registers no commands and starts no ticker', { options: { repos: 'gitlab:g/p' } }, async ($, on) => {
  const registered: string[] = []
  let fetches = 0
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 21) })
  mock.env(on, { FACTORY_ROLE: 'builder', GITLAB_TOKEN: 'x', HOME: '/home/u' })
  on('command.register', (_, e) => { registered.push(e.name); return { value: { command: e.name } } })
  on('http.fetch', () => { fetches++; return json([]) })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(30 * 60000)
  expect(registered).toEqual([])
  expect(fetches).toBe(0)
})

test('an interactive session ticks every tickMinutes until paused', { options: { repos: 'gitlab:g/p', tickMinutes: 10 } }, async ($, on) => {
  const listings: string[] = []
  const clock = mock.clock(on, { now: Date.UTC(2026, 9, 21) })
  mock.env(on, { GITLAB_TOKEN: 'x', HOME: '/home/u' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('http.fetch', (_, e) => { if (e.url.includes('/issues?')) listings.push(e.url); return json([]) })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(10 * 60000)
  expect(listings.length).toBe(1)
  expect((await $.command.run({ command: 'factory', args: 'pause' })).text).toContain('paused')
  await clock.advance(30 * 60000)
  expect(listings.length).toBe(1)
  expect((await $.command.run({ command: 'factory', args: 'resume' })).text).toContain('resumed')
  await clock.advance(10 * 60000)
  expect(listings.length).toBe(2)
})

test('/factory approve posts /approve on an issue awaiting a spec decision', { options: { repos: 'gitlab:g/p' } }, async ($, on) => {
  const posts: { url: string; method?: string; body?: string }[] = []
  mock.env(on, { GITLAB_TOKEN: 'x', HOME: '/home/u' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('http.fetch', (_, e) => {
    if (e.init?.method === 'POST') { posts.push({ url: e.url, method: e.init.method, body: e.init.body }); return json({ id: 1, body: '/approve', created_at: '2026-10-21T00:00:00Z', author: { username: 'me' } }) }
    if (e.url.endsWith('/issues/4')) return json({ iid: 4, title: 'T', description: '', labels: ['factory::awaiting-spec'] })
    return json([])
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const r = await $.command.run({ command: 'factory', args: 'approve #4' })
  expect(r.text).toContain('approved')
  expect(posts.length).toBe(1)
  expect(posts[0].url).toBe('https://gitlab.com/api/v4/projects/g%2Fp/issues/4/notes')
  expect(JSON.parse(posts[0].body!)).toEqual({ body: '/approve' })
})

test('parseCommand("revise #4") is an error mentioning notes', () => {
  const r = parseCommand('revise #4')
  expect(r.kind).toBe('error')
  expect(r.kind === 'error' && r.message).toContain('notes')
})

/** A tiny GitLab in memory, answering $.http.fetch for one issue. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function gitlab(on: any, station: string) {
  const issue = { labels: [`factory::${station}`] as string[], notes: [] as { id: number; body: string; created_at: string; author: { username: string } }[] }
  const reqs: { method: string; url: string; body?: string }[] = []
  let n = 0
  on('http.fetch', (_: unknown, e: { url: string; init?: { method?: string; body?: string; headers?: Record<string, string> } }) => {
    const method = e.init?.method ?? 'GET'
    reqs.push({ method, url: e.url, body: e.init?.body })
    const u = e.url.replace('https://gitlab.com/api/v4', '')
    if (u === '/user') return json({ username: 'bot' })
    if (u === '/projects/g%2Fp') return json({ default_branch: 'main' })
    if (u.startsWith('/projects/g%2Fp/repository/files/.factory.yml/raw')) return { value: { status: 200, ok: true, headers: {}, text: 'forge: gitlab\ntest: "npm test"\n' } }
    if (u.startsWith('/projects/g%2Fp/issues?')) return json(u.endsWith('page=1') ? [{ iid: 4, labels: issue.labels }] : [])
    if (u === '/projects/g%2Fp/issues/4' && method === 'GET') return json({ iid: 4, title: 'Add VAT', description: 'x', labels: issue.labels })
    if (u === '/projects/g%2Fp/issues/4' && method === 'PUT') {
      const b = JSON.parse(e.init!.body!)
      issue.labels = [...issue.labels.filter((l) => !b.remove_labels.split(',').includes(l)), b.add_labels]
      return json({})
    }
    if (u.startsWith('/projects/g%2Fp/issues/4/notes?')) return json(u.endsWith('page=1') ? issue.notes : [])
    if (u === '/projects/g%2Fp/issues/4/notes' && method === 'POST') {
      const note = { id: ++n, body: JSON.parse(e.init!.body!).body, created_at: new Date(Date.UTC(2026, 9, 21, 12, 0, n)).toISOString(), author: { username: 'bot' } }
      issue.notes.push(note)
      return json(note)
    }
    if (u.startsWith('/projects/g%2Fp/issues/4/notes/') && method === 'PUT') {
      const note = issue.notes.find((x) => String(x.id) === u.split('/').pop())!
      note.body = JSON.parse(e.init!.body!).body
      return json(note)
    }
    return { value: { status: 404, ok: false, headers: {}, text: '' } }
  })
  return { issue, reqs }
}

test('/factory run drives a station through $.process.run and $.process.spawn', { options: { repos: 'gitlab:g/p', workerId: 'w1' } }, async ($, on) => {
  const argvs: string[][] = []
  let spawned: { argv: readonly string[]; cwd?: string } | undefined
  mock.env(on, { GITLAB_TOKEN: 'glpat-abcdefghijklmnop', HOME: '/home/u' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const g = gitlab(on, 'spec')
  on('process.run', (_, e) => { argvs.push([...e.argv]); return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } })
  // A stand-in for a call on $ answers { value }; a streaming one yields its pieces first.
  on('process.spawn', async function* (_: unknown, e: { argv: readonly string[]; cwd?: string }) {
    spawned = { argv: e.argv, cwd: e.cwd }
    yield { stream: 'stdout' as const, text: '{"type":"result","subtype":"success",' }
    yield { stream: 'stderr' as const, text: 'noise\n' }
    yield { stream: 'stdout' as const, text: '"result":"## Goal\\nRound VAT."}\n' }
    return { value: { code: 0, signal: null } }
  } as any)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const r = await $.command.run({ command: 'factory', args: 'run #4' })
  expect(r.text).toContain('gitlab:g/p#4: spec -> awaiting-spec (needs you)')
  expect(g.issue.labels).toEqual(['factory::awaiting-spec'])
  expect(g.issue.notes.map((x) => x.body.split(' ')[0].split('\n')[0])).toEqual(['<!--', '<!--'])
  expect(g.issue.notes[1].body).toBe('<!-- factory:spec -->\n## Goal\nRound VAT.')
  expect(spawned!.cwd).toBe('/home/u/.factory/work/gitlab/g__p/4')
  expect(spawned!.argv).toContain('--plugin-dir')
  expect(argvs[0]).toEqual(['test', '-d', '/home/u/.factory/work/gitlab/g__p/4'])
  // the lease note (id 1) is edited in place at the end: released with until = now
  expect(g.reqs.some((q) => q.method === 'PUT' && q.url.includes('/notes/1'))).toBe(true)
})

test('a $.process.run timeout becomes timedOut, never a crash; other rejections carry the message', { options: { repos: 'gitlab:g/p', workerId: 'w1' } }, async ($, on) => {
  mock.env(on, { GITLAB_TOKEN: 'glpat-abcdefghijklmnop', HOME: '/home/u' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const g = gitlab(on, 'spec')
  on('process.run', (_, e) => {
    if (e.argv[0] === 'test') return { deny: 'boom: cannot start' }
    return { deny: `$.process.run(${e.argv[0]}) aborted: still running after 600000ms` }
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const r = await $.command.run({ command: 'factory', args: 'run #4' })
  expect(r.text).toContain('spec -> blocked')
  const blocked = g.issue.notes.at(-1)!.body
  expect(blocked.startsWith('<!-- factory:blocked station=spec -->')).toBe(true)
  expect(blocked).toContain('failed (exit -1): timed out')
})
