import { expect, test } from 'claude-code/testing'
import { githubForge } from '../src/forge/github'
import { ForgeError } from '../src/forge/types'
import type { HttpFn } from '../src/forge/types'
import { STATIONS } from '../src/types'

type Req = Parameters<HttpFn>[0]
const A = 'https://api.github.com'
const R = `${A}/repos/own/app`

function fake(routes: (req: Req) => { status?: number; json?: unknown; text?: string } | undefined) {
  const calls: Req[] = []
  const http: HttpFn = async (req) => {
    calls.push(req)
    const r = routes(req)
    const status = r?.status ?? 404
    const text = r?.text ?? (r?.json === undefined ? '' : JSON.stringify(r.json))
    return { status, ok: status >= 200 && status < 300, text }
  }
  return { calls, forge: githubForge(http, { token: 'tok' }) }
}
const ref = { forge: 'github' as const, project: 'own/app', issue: 7 }
const lab = (...n: string[]) => n.map((name) => ({ name }))

test('getJob maps issue and comments, sorted, trusted by author_association', async () => {
  const { forge, calls } = fake((r) => {
    if (r.url === `${R}/issues/7`)
      return { status: 200, json: { number: 7, title: 'T', body: 'D', labels: lab('factory::build', 'x') } }
    if (r.url.startsWith(`${R}/issues/7/comments`)) {
      return r.url.endsWith('page=1')
        ? { status: 200, json: [
            { id: 3, body: 'later', created_at: '2026-01-02T00:00:00Z', author_association: 'MEMBER', user: { login: 'bob' } },
            { id: 4, body: 'rando', created_at: '2026-01-03T00:00:00Z', author_association: 'NONE', user: { login: 'eve' } },
            { id: 5, body: 'ghost', created_at: '2026-01-04T00:00:00Z', author_association: 'OWNER', user: null },
            { id: 2, body: 'first', created_at: '2026-01-01T12:00:00Z', author_association: 'COLLABORATOR', user: { login: 'amy' } },
            { id: 6, body: 'contrib', created_at: '2026-01-05T00:00:00Z', author_association: 'CONTRIBUTOR', user: { login: 'cy' } },
            { id: 7, body: 'owner', created_at: '2026-01-06T00:00:00Z', author_association: 'OWNER', user: { login: 'own' } },
          ] }
        : { status: 200, json: [] }
    }
  })
  const job = await forge.getJob(ref)
  expect(job.title).toBe('T')
  expect(job.body).toBe('D')
  expect(job.labels).toEqual(['factory::build', 'x'])
  expect(job.comments).toEqual([
    { id: '2', body: 'first', createdAt: '2026-01-01T12:00:00Z', author: 'amy', trusted: true },
    { id: '3', body: 'later', createdAt: '2026-01-02T00:00:00Z', author: 'bob', trusted: true },
    { id: '4', body: 'rando', createdAt: '2026-01-03T00:00:00Z', author: 'eve', trusted: false },
    { id: '5', body: 'ghost', createdAt: '2026-01-04T00:00:00Z', author: '', trusted: false },
    { id: '6', body: 'contrib', createdAt: '2026-01-05T00:00:00Z', author: 'cy', trusted: false },
    { id: '7', body: 'owner', createdAt: '2026-01-06T00:00:00Z', author: 'own', trusted: true },
  ])
  expect(calls[0].headers.Authorization).toBe('Bearer tok')
  expect(calls[0].headers.Accept).toBe('application/vnd.github+json')
  expect(calls[0].headers['X-GitHub-Api-Version']).toBe('2022-11-28')
})

test('setStation keeps non-factory labels, replaces factory ones via PUT', async () => {
  const { forge, calls } = fake((r) => {
    if (r.method === 'GET')
      return r.url.endsWith('page=1')
        ? { status: 200, json: lab('bug', 'factory::spec', 'factory::spec-approved', 'prio') }
        : { status: 200, json: [] }
    return { status: 200, json: [] }
  })
  await forge.setStation(ref, 'build')
  const put = calls.find((c) => c.method === 'PUT')!
  expect(put.url).toBe(`${R}/issues/7/labels`)
  expect(JSON.parse(put.body!)).toEqual({ labels: ['bug', 'prio', 'factory::build'] })
  expect(calls.indexOf(put)).toBe(calls.length - 1)
})

test('setStation works for every station and with no existing labels', async () => {
  for (const s of STATIONS) {
    const { forge, calls } = fake((r) => ({ status: 200, json: r.method === 'GET' ? [] : [] }))
    await forge.setStation(ref, s)
    expect(JSON.parse(calls.find((c) => c.method === 'PUT')!.body!)).toEqual({ labels: [`factory::${s}`] })
  }
})

test('openMR POSTs /pulls with head, default base, title, body', async () => {
  const { forge, calls } = fake((r) => {
    if (r.method === 'GET') return { status: 200, json: { default_branch: 'main' } }
    return { status: 201, json: { html_url: 'https://github.com/own/app/pull/3' } }
  })
  const out = await forge.openMR(ref, 'factory/7-x', 'Title', 'Body')
  expect(out.url).toBe('https://github.com/own/app/pull/3')
  const post = calls.find((c) => c.method === 'POST')!
  expect(post.url).toBe(`${R}/pulls`)
  expect(JSON.parse(post.body!)).toEqual({ head: 'factory/7-x', base: 'main', title: 'Title', body: 'Body' })
})

test('non-2xx throws ForgeError with status, without the token', async () => {
  const { forge } = fake(() => ({ status: 500 }))
  let err: unknown
  try { await forge.defaultBranch('own/app') } catch (e) { err = e }
  expect(err instanceof ForgeError).toBe(true)
  expect((err as ForgeError).status).toBe(500)
  expect((err as ForgeError).message.includes('tok')).toBe(false)
})

test('2xx non-array on a paged call throws ForgeError', async () => {
  const { forge } = fake(() => ({ status: 200, json: { message: 'weird' } }))
  let err: unknown
  try { await forge.listJobs('own/app') } catch (e) { err = e }
  expect(err instanceof ForgeError).toBe(true)
})

test('empty 2xx body where JSON expected throws ForgeError', async () => {
  const { forge } = fake(() => ({ status: 200, text: '' }))
  let err: unknown
  try { await forge.whoami() } catch (e) { err = e }
  expect(err instanceof ForgeError).toBe(true)
  let err2: unknown
  try { await forge.defaultBranch('own/app') } catch (e) { err2 = e }
  expect(err2 instanceof ForgeError).toBe(true)
})

test('invalid JSON throws ForgeError', async () => {
  const { forge } = fake(() => ({ status: 200, text: '<html>' }))
  let err: unknown
  try { await forge.whoami() } catch (e) { err = e }
  expect(err instanceof ForgeError).toBe(true)
})

test('listJobs pages, filters PRs, skips done/unlabelled', async () => {
  const { forge, calls } = fake((r) => {
    if (r.url.endsWith('page=1')) return { status: 200, json: [
      { number: 1, labels: lab('factory::spec') },
      { number: 2, labels: lab('factory::done') },
      { number: 3, labels: lab('bug') },
      { number: 9, labels: lab('factory::build'), pull_request: { url: 'x' } },
    ] }
    if (r.url.endsWith('page=2')) return { status: 200, json: [{ number: 4, labels: lab('factory::blocked') }] }
    return { status: 200, json: [] }
  })
  const jobs = await forge.listJobs('own/app')
  expect(jobs).toEqual([
    { forge: 'github', project: 'own/app', issue: 1 },
    { forge: 'github', project: 'own/app', issue: 4 },
  ])
  expect(calls.length).toBe(3)
  expect(calls[0].url).toContain(`${R}/issues?state=open`)
  expect(calls[0].url).toContain('per_page=100&page=1')
})

test('comment, editComment, createIssue, whoami, cloneUrl', async () => {
  const { forge, calls } = fake((r) => {
    if (r.url === `${A}/user`) return { status: 200, json: { login: 'factory-bot' } }
    if (r.method === 'POST' && r.url.endsWith('/comments'))
      return { status: 201, json: { id: 9, body: 'hi', created_at: '2026-01-01T00:00:00Z', author_association: 'OWNER', user: { login: 'factory-bot' } } }
    if (r.method === 'POST') return { status: 201, json: { number: 12 } }
    return { status: 200, json: {} }
  })
  expect(await forge.whoami()).toBe('factory-bot')
  expect(await forge.comment(ref, 'hi')).toEqual({
    id: '9', body: 'hi', createdAt: '2026-01-01T00:00:00Z', author: 'factory-bot', trusted: true,
  })
  await forge.editComment(ref, '9', 'edited')
  const patch = calls.find((c) => c.method === 'PATCH')!
  expect(patch.url).toBe(`${R}/issues/comments/9`)
  expect(JSON.parse(patch.body!)).toEqual({ body: 'edited' })
  expect(await forge.createIssue('own/app', 't', 'b')).toEqual({ forge: 'github', project: 'own/app', issue: 12 })
  expect(forge.cloneUrl('own/app')).toBe('https://x-access-token:tok@github.com/own/app.git')
})

test('custom apiUrl is honoured and detached methods work', async () => {
  const calls: Req[] = []
  const http: HttpFn = async (req) => {
    calls.push(req)
    return { status: 200, ok: true, text: JSON.stringify({ login: 'u' }) }
  }
  const { whoami } = githubForge(http, { token: 't', apiUrl: 'https://ghe.example/api/v3/' })
  expect(await whoami()).toBe('u')
  expect(calls[0].url).toBe('https://ghe.example/api/v3/user')
})
