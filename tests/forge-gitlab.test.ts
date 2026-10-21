import { expect, test } from 'claude-code/testing'
import { gitlabForge } from '../src/forge/gitlab'
import { ForgeError } from '../src/forge/types'
import type { HttpFn } from '../src/forge/types'
import { STATIONS } from '../src/types'

type Req = Parameters<HttpFn>[0]
const BASE = 'https://lab.ironcloud.gr'
const A = `${BASE}/api/v4`

function fake(routes: (req: Req) => { status?: number; json?: unknown } | undefined) {
  const calls: Req[] = []
  const http: HttpFn = async (req) => {
    calls.push(req)
    const r = routes(req)
    const status = r?.status ?? 404
    return { status, ok: status >= 200 && status < 300, text: r?.json === undefined ? '' : JSON.stringify(r.json) }
  }
  return { calls, forge: gitlabForge(http, { baseUrl: BASE, token: 'tok' }) }
}
const ref = { forge: 'gitlab' as const, project: 'grp/app', issue: 7 }

test('getJob maps issue and notes, sorted, system notes excluded', async () => {
  const { forge, calls } = fake((r) => {
    if (r.url === `${A}/projects/grp%2Fapp/issues/7`)
      return { status: 200, json: { iid: 7, title: 'T', description: 'D', labels: ['factory::build', 'x'] } }
    if (r.url.startsWith(`${A}/projects/grp%2Fapp/issues/7/notes`)) {
      return r.url.endsWith('page=1')
        ? { status: 200, json: [
            { id: 3, body: 'later', created_at: '2026-01-02T00:00:00Z', system: false, author: { username: 'bob' } },
            { id: 1, body: 'moved label', created_at: '2026-01-01T00:00:00Z', system: true, author: { username: 'bob' } },
            { id: 2, body: 'first', created_at: '2026-01-01T12:00:00Z', system: false, author: { username: 'amy' } },
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
  ])
  expect(calls[0].headers['PRIVATE-TOKEN']).toBe('tok')
})

test('setStation sends one PUT removing the other 12 labels', async () => {
  const { forge, calls } = fake(() => ({ status: 200, json: {} }))
  await forge.setStation(ref, 'build')
  expect(calls.length).toBe(1)
  expect(calls[0].method).toBe('PUT')
  expect(calls[0].url).toBe(`${A}/projects/grp%2Fapp/issues/7`)
  const body = JSON.parse(calls[0].body!)
  expect(body.add_labels).toBe('factory::build')
  const removed = body.remove_labels.split(',')
  expect(removed.length).toBe(12)
  expect(removed.includes('factory::build')).toBe(false)
  expect(removed.includes('factory::spec-approved')).toBe(true)
  for (const s of STATIONS) if (s !== 'build') expect(removed.includes(`factory::${s}`)).toBe(true)
})

test('openMR posts source, default target branch and remove_source_branch', async () => {
  const { forge, calls } = fake((r) => {
    if (r.method === 'GET') return { status: 200, json: { default_branch: 'main' } }
    return { status: 201, json: { web_url: 'https://lab.ironcloud.gr/grp/app/-/merge_requests/3' } }
  })
  const out = await forge.openMR(ref, 'factory/7-x', 'Title', 'Body')
  expect(out.url).toBe('https://lab.ironcloud.gr/grp/app/-/merge_requests/3')
  const post = calls.find((c) => c.method === 'POST')!
  expect(post.url).toBe(`${A}/projects/grp%2Fapp/merge_requests`)
  expect(JSON.parse(post.body!)).toEqual({
    source_branch: 'factory/7-x', target_branch: 'main', title: 'Title', description: 'Body', remove_source_branch: true,
  })
})

test('non-2xx throws ForgeError with status', async () => {
  const { forge } = fake(() => ({ status: 500 }))
  let err: unknown
  try { await forge.defaultBranch('grp/app') } catch (e) { err = e }
  expect(err instanceof ForgeError).toBe(true)
  expect((err as ForgeError).status).toBe(500)
})

test('listJobs pages until empty and skips done/unlabelled', async () => {
  const { forge, calls } = fake((r) => {
    if (r.url.endsWith('page=1')) return { status: 200, json: [
      { iid: 1, labels: ['factory::spec'] }, { iid: 2, labels: ['factory::done'] }, { iid: 3, labels: ['bug'] },
    ] }
    if (r.url.endsWith('page=2')) return { status: 200, json: [{ iid: 4, labels: ['factory::blocked'] }] }
    return { status: 200, json: [] }
  })
  const jobs = await forge.listJobs('grp/app')
  expect(jobs.map((j) => j.issue)).toEqual([1, 4])
  expect(calls.length).toBe(3)
  expect(calls[0].url).toContain('per_page=100&page=1')
})

test('comment, editComment, createIssue, whoami, cloneUrl', async () => {
  const { forge, calls } = fake((r) => {
    if (r.url === `${A}/user`) return { status: 200, json: { username: 'factory-bot' } }
    if (r.method === 'POST' && r.url.endsWith('/notes'))
      return { status: 201, json: { id: 9, body: 'hi', created_at: '2026-01-01T00:00:00Z', author: { username: 'factory-bot' } } }
    if (r.method === 'POST') return { status: 201, json: { iid: 12 } }
    return { status: 200, json: {} }
  })
  expect(await forge.whoami()).toBe('factory-bot')
  expect(await forge.comment(ref, 'hi')).toEqual({
    id: '9', body: 'hi', createdAt: '2026-01-01T00:00:00Z', author: 'factory-bot', trusted: true,
  })
  await forge.editComment(ref, '9', 'edited')
  const put = calls.find((c) => c.method === 'PUT')!
  expect(put.url).toBe(`${A}/projects/grp%2Fapp/issues/7/notes/9`)
  expect(JSON.parse(put.body!)).toEqual({ body: 'edited' })
  expect(await forge.createIssue('grp/app', 't', 'b')).toEqual({ forge: 'gitlab', project: 'grp/app', issue: 12 })
  expect(forge.cloneUrl('grp/app')).toBe('https://oauth2:tok@lab.ironcloud.gr/grp/app.git')
})

test('findOpenMR queries opened MRs by source branch; publicUrl is tokenless', async () => {
  const { forge, calls } = fake((r) =>
    r.url.includes('/merge_requests?') ? { status: 200, json: [{ web_url: 'https://lab.ironcloud.gr/grp/app/-/merge_requests/4' }] } : undefined)
  expect(await forge.findOpenMR('grp/app', 'factory/7-x')).toEqual({ url: 'https://lab.ironcloud.gr/grp/app/-/merge_requests/4' })
  expect(calls[0].method).toBe('GET')
  expect(calls[0].url).toBe(`${A}/projects/grp%2Fapp/merge_requests?state=opened&source_branch=${encodeURIComponent('factory/7-x')}`)
  expect(forge.publicUrl('grp/app')).toBe('https://lab.ironcloud.gr/grp/app.git')
  const none = fake(() => ({ status: 200, json: [] }))
  expect(await none.forge.findOpenMR('grp/app', 'b')).toBe(null)
})
