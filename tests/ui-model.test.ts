import { expect, test } from 'claude-code/testing'
import { bandText, dossierMarkdown, issueUrl, latestSpec, loadViews, mergeProgress, spinnerSuffix, toView, transitionToast, type JobView } from '../src/ui/model'
import type { Forge } from '../src/forge/types'
import type { Comment, Job, JobRef, Station } from '../src/types'

const T0 = Date.UTC(2026, 9, 21, 12)
const MIN = 60000
const iso = (ms: number) => new Date(ms).toISOString()
const ref = (issue: number): JobRef => ({ forge: 'gitlab', project: 'g/p', issue })

function view(issue: number, station: Station, needsHuman = false): JobView {
  return { ref: ref(issue), title: `Job ${issue}`, station, sinceMs: 0, fixLoops: 0, needsHuman, links: { issue: `https://gitlab.com/g/p/-/issues/${issue}` } }
}

function job(issue: number, labels: string[], comments: Comment[] = [], title = `Job ${issue}`): Job {
  return { ref: ref(issue), title, body: '', labels, comments }
}
const c = (id: string, body: string, at: number, author = 'bot'): Comment => ({ id, body, createdAt: iso(at), author, trusted: true })

test('bandText groups by what the factory is doing and omits empty groups', () => {
  expect(bandText([view(1, 'build'), view(2, 'build'), view(3, 'review'), view(4, 'awaiting-spec', true)]))
    .toBe('Factory · 2 building · 1 in review · 1 needs you')
  expect(bandText([])).toBe('Factory · idle')
  expect(bandText([view(1, 'verify')])).toBe('Factory · 1 building')
  expect(bandText([view(1, 'spec'), view(2, 'plan'), view(3, 'approve'), view(4, 'blocked', true), view(5, 'mr-open', true)]))
    .toBe('Factory · 2 planning · 1 in review · 2 need you')
  expect(bandText([view(1, 'done')])).toBe('Factory · idle')
})

test('toView: station, needsHuman, fix loops, elapsed time and links', () => {
  const opts = { now: T0 + 30 * MIN, secrets: [], issueUrl: (r: JobRef) => `https://gitlab.com/${r.project}/-/issues/${r.issue}` }
  const awaiting = toView(job(42, ['factory::awaiting-spec'], [
    c('1', '<!-- factory:lease worker=w until=2026-10-21T12:15:00Z -->', T0 + 25 * MIN),
    c('2', '<!-- factory:spec -->\n## Goal\nRound VAT.', T0 + 10 * MIN),
  ]), opts)
  expect(awaiting.station).toBe('awaiting-spec')
  expect(awaiting.needsHuman).toBe(true)
  // Leases are edited in place all the time: they do not count as the station's start.
  expect(awaiting.sinceMs).toBe(20 * MIN)
  expect(awaiting.links).toEqual({ issue: 'https://gitlab.com/g/p/-/issues/42' })

  const decided = toView(job(42, ['factory::awaiting-spec'], [c('2', '<!-- factory:spec -->\nx', T0), c('3', '/approve', T0 + MIN, 'human')]), opts)
  expect(decided.needsHuman).toBe(false)

  const mr = toView(job(7, ['factory::mr-open'], [c('9', '<!-- factory:approval mr=https://gitlab.com/g/p/-/merge_requests/3 -->\nok', T0)]), opts)
  expect(mr.needsHuman).toBe(true)
  expect(mr.links.mr).toBe('https://gitlab.com/g/p/-/merge_requests/3')

  const loops = toView(job(8, ['factory::build'], [
    c('1', '<!-- factory:verdict role=code-reviewer pass=false round=1 -->\nbad', T0),
    c('2', '<!-- factory:verdict role=code-reviewer pass=false round=2 -->\nbad', T0 + MIN),
  ]), opts)
  expect(loops.fixLoops).toBe(2)
  expect(loops.needsHuman).toBe(false)

  const invalid = toView(job(9, ['factory::build', 'factory::review']), opts)
  expect(invalid.station).toBe('blocked')
  expect(invalid.needsHuman).toBe(true)
  expect(invalid.sinceMs).toBe(0)
})

test('toView redacts secrets out of the title', () => {
  const v = toView(job(1, ['factory::build'], [], 'leak glpat-abcdefghijklmnop and s3cret'), { now: T0, secrets: ['s3cret'], issueUrl: () => 'https://x/1' })
  expect(v.title).toBe('leak [redacted] and [redacted]')
})

test('issueUrl builds the web URL from the tokenless clone URL', () => {
  expect(issueUrl('https://gitlab.example.com/g/sub/p.git', { forge: 'gitlab', project: 'g/sub/p', issue: 4 })).toBe('https://gitlab.example.com/g/sub/p/-/issues/4')
  expect(issueUrl('https://github.com/o/r.git', { forge: 'github', project: 'o/r', issue: 4 })).toBe('https://github.com/o/r/issues/4')
})

test('latestSpec and dossierMarkdown read the factory marker comments', () => {
  const j = job(4, ['factory::awaiting-spec'], [
    c('1', '<!-- factory:spec -->\nold spec', T0),
    c('2', '<!-- factory:lease worker=w until=x -->', T0 + MIN),
    c('3', '<!-- factory:spec -->\n## Goal\nnew spec', T0 + 2 * MIN),
    c('4', 'a plain comment', T0 + 3 * MIN),
    c('5', '<!-- factory:design -->\nboxes', T0 + 4 * MIN),
  ])
  expect(latestSpec(j)).toBe('## Goal\nnew spec')
  expect(latestSpec(job(5, []))).toBe('')
  const d = dossierMarkdown(j)
  expect(d).toContain('### spec\n\n## Goal\nnew spec')
  expect(d).toContain('### design\n\nboxes')
  expect(d).not.toContain('old spec')
  expect(d).not.toContain('lease')
  expect(d).not.toContain('a plain comment')
})

test('mergeProgress keeps the live progress line of a job still at the same station', () => {
  const prev = [{ ...view(1, 'build'), progress: 'writing tests' }, { ...view(2, 'spec'), progress: 'drafting' }]
  const next = [view(1, 'build'), view(2, 'awaiting-spec', true)]
  const out = mergeProgress(next, prev)
  expect(out[0].progress).toBe('writing tests')
  expect(out[1].progress).toBeUndefined()
})

test('transitionToast: only real moves that need a human or block', () => {
  expect(transitionToast({ ref: ref(42), from: 'spec', to: 'awaiting-spec', needsHuman: true })).toBe('factory #42 needs you: awaiting-spec')
  expect(transitionToast({ ref: ref(42), from: 'verify', to: 'blocked', needsHuman: true })).toBe('factory #42 blocked at verify')
  expect(transitionToast({ ref: ref(42), from: 'awaiting-spec', to: 'awaiting-spec', needsHuman: true })).toBeNull()
  expect(transitionToast({ ref: ref(42), from: 'plan', to: 'build', needsHuman: false })).toBeNull()
})

test('spinnerSuffix names the running job and station', () => {
  expect(spinnerSuffix({ issue: 42, station: 'build' })).toBe(' · factory #42 build')
  expect(spinnerSuffix(null)).toBe('')
})

test('loadViews reads every configured project and reports forge errors per project', async () => {
  const jobs = new Map<number, Job>([
    [1, job(1, ['factory::build'], [c('1', '<!-- factory:plan -->\nsteps', T0, 'mallory'), c('2', '<!-- factory:plan -->\nreal', T0 + MIN)])],
    [2, job(2, ['factory::awaiting-spec'], [c('3', '<!-- factory:spec -->\nx', T0)])],
  ])
  const forge = {
    listJobs: async () => [...jobs.values()].map((j) => j.ref),
    getJob: async (r: JobRef) => jobs.get(r.issue)!,
    whoami: async () => 'bot',
    publicUrl: (p: string) => `https://gitlab.com/${p}.git`,
  } as unknown as Forge
  const r = await loadViews(
    [{ forge: 'gitlab', project: 'g/p' }, { forge: 'github', project: 'o/r' }],
    (kind) => (kind === 'gitlab' ? { forge } : { error: 'GITHUB_TOKEN is not set' }),
    { now: T0 + 5 * MIN, secrets: [] },
  )
  expect(r.views.map((v) => [v.ref.issue, v.station, v.needsHuman])).toEqual([[1, 'build', false], [2, 'awaiting-spec', true]])
  // Another account's marker is not the station's start.
  expect(r.views[0].sinceMs).toBe(4 * MIN)
  expect(r.views[1].links.issue).toBe('https://gitlab.com/g/p/-/issues/2')
  expect(r.errors).toEqual(['github:o/r: GITHUB_TOKEN is not set'])
})
