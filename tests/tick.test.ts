import { expect, test } from 'claude-code/testing'
import { tick, ownMarkersOnly, loadRepoConfig } from '../src/tick'
import type { Deps } from '../src/stations'
import type { Forge } from '../src/forge/types'
import type { Comment, Job, JobRef, Station } from '../src/types'
import type { SpawnFn } from '../src/agents'
import { leaseBody } from '../src/lease'

const ME = 'factory-bot'
const T0 = Date.UTC(2026, 9, 21, 12)
const MIN = 60000

type World = {
  jobs: Map<number, Job>
  log: string[]
  clock: { now: number }
  edits: { id: string; body: string }[]
}

const iso = (ms: number) => new Date(ms).toISOString()

function world(jobs: { issue: number; station: string; comments?: Comment[]; title?: string }[], opts: {
  agents?: Record<string, string>
  /** Called after every forge.comment so a test can inject a racing lease. */
  afterComment?: (w: World, ref: JobRef, body: string) => void
  /** Minutes the clock moves on every spawned agent run. */
  agentMinutes?: number
} = {}) {
  const w: World = { jobs: new Map(), log: [], clock: { now: T0 }, edits: [] }
  let seq = 0
  for (const j of jobs) {
    const ref: JobRef = { forge: 'gitlab', host: 'gitlab.com', project: 'g/p', issue: j.issue }
    w.jobs.set(j.issue, { ref, title: j.title ?? `Job ${j.issue}`, body: '', labels: [`factory::${j.station}`], comments: j.comments ?? [] })
  }
  const forge: Forge = {
    listJobs: async () => [...w.jobs.values()].filter((j) => !j.labels.includes('factory::done')).map((j) => j.ref),
    listJobsIn: async () => { throw new Error('unused') },
    getJob: async (ref) => JSON.parse(JSON.stringify(w.jobs.get(ref.issue)!)),
    comment: async (ref, body) => {
      const c: Comment = { id: `c${++seq}`, body, createdAt: iso(w.clock.now + seq), author: ME }
      w.jobs.get(ref.issue)!.comments.push(c)
      w.log.push(`#${ref.issue} comment:${body.split('\n')[0].split(' ')[0]}`)
      opts.afterComment?.(w, ref, body)
      return c
    },
    editComment: async (ref, id, body) => {
      const c = w.jobs.get(ref.issue)!.comments.find((x) => x.id === id)!
      c.body = body
      w.edits.push({ id, body })
      w.log.push(`#${ref.issue} edit:${id}`)
    },
    setStation: async (ref, s: Station) => {
      const j = w.jobs.get(ref.issue)!
      j.labels = [...j.labels.filter((l) => !l.startsWith('factory::')), `factory::${s}`]
      w.log.push(`#${ref.issue} label:${s}`)
    },
    createIssue: async () => { throw new Error('unused') },
    openMR: async () => { throw new Error('unused') },
    defaultBranch: async () => 'main',
    cloneUrl: () => 'https://oauth2:tok@host/g/p.git',
    publicUrl: () => 'https://host/g/p.git',
    findOpenMR: async () => null,
    whoami: async () => ME,
    readFile: async () => 'forge: gitlab\ntest: "npm test"\n',
  }
  const spawn: SpawnFn = async (argv, o) => {
    const role = argv.find((a) => a.startsWith('FACTORY_ROLE='))!.slice('FACTORY_ROLE='.length)
    w.clock.now += (opts.agentMinutes ?? 0) * MIN
    const out = opts.agents?.[role] ?? '## Goal\nDo it.'
    o.onLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'working' }] } }))
    o.onLine(JSON.stringify({ type: 'result', subtype: 'success', result: out }))
    return { exitCode: 0 }
  }
  const deps: Deps = {
    forge,
    run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    spawn,
    pluginRoot: '/plug',
    workRoot: '/work',
    secrets: ['tok'],
    workerId: 'w1',
    now: () => w.clock.now,
    onProgress: () => {},
    loadConfig: async () => ({ ok: true, config: {
      forge: 'gitlab', test: 'npm test', reviewers: ['code'], protectedPaths: [], models: {},
      limits: { fixLoops: 3, parallel: 2 }, branchPrefix: 'factory/', allowedTools: [],
    } }),
    writeFile: async () => {},
  }
  return { w, deps, forge }
}

const projects = [{ forge: 'gitlab' as const, host: 'gitlab.com', project: 'g/p' }]
const lease = (worker: string, untilMs: number, id = 'L', author = ME): Comment =>
  ({ id, body: `<!-- factory:lease worker=${worker} until=${iso(untilMs)} -->`, createdAt: iso(T0 - 5 * MIN), author })

test('two ready jobs with parallel:1 advances only one', async () => {
  const { w, deps } = world([{ issue: 1, station: 'ready' }, { issue: 2, station: 'ready' }])
  const r = await tick({ ...deps, projects, parallel: 1 })
  const issues = new Set(r.advanced.map((a) => a.ref.issue))
  expect([...issues]).toEqual([1])
  expect(r.skipped).toContainEqual({ ref: { forge: 'gitlab', host: 'gitlab.com', project: 'g/p', issue: 2 }, reason: 'parallel limit reached' })
  expect(w.jobs.get(2)!.labels).toEqual(['factory::ready'])
  expect(w.jobs.get(2)!.comments).toEqual([])
})

test('a job leased by another worker is skipped with "leased by <worker>"', async () => {
  const { w, deps } = world([{ issue: 3, station: 'ready', comments: [lease('w2', T0 + 10 * MIN)] }])
  const r = await tick({ ...deps, projects, parallel: 2 })
  expect(r.advanced).toEqual([])
  expect(r.skipped).toEqual([{ ref: { forge: 'gitlab', host: 'gitlab.com', project: 'g/p', issue: 3 }, reason: 'leased by w2' }])
  expect(w.log).toEqual([])
})

test('a job runs spec then stops at awaiting-spec in one tick', async () => {
  const { w, deps } = world([{ issue: 4, station: 'ready' }])
  const r = await tick({ ...deps, projects, parallel: 2 })
  expect(r.advanced.map((a) => [a.from, a.to, a.needsHuman])).toEqual([
    ['ready', 'spec', false],
    ['spec', 'awaiting-spec', true],
  ])
  expect(w.jobs.get(4)!.labels).toEqual(['factory::awaiting-spec'])
  // lease first, then the spec marker, then the label; the lease is released at the end
  expect(w.log[0]).toBe('#4 comment:<!--')
  expect(w.jobs.get(4)!.comments[0].body.startsWith('<!-- factory:lease worker=w1 ')).toBe(true)
  expect(w.log.at(-1)).toBe('#4 edit:c1')
  expect(w.edits.at(-1)!.body).toBe(leaseBody('w1', w.clock.now, 0))
})

test('done, mr-open, blocked and undecided awaiting-spec jobs are skipped without a lease', async () => {
  const { w, deps } = world([
    { issue: 5, station: 'mr-open' }, { issue: 6, station: 'blocked' },
    { issue: 7, station: 'awaiting-spec', comments: [{ id: 's', body: '<!-- factory:spec -->\nx', createdAt: iso(T0 - MIN), author: ME }] },
  ])
  const r = await tick({ ...deps, projects, parallel: 2 })
  expect(r.advanced).toEqual([])
  expect(r.skipped.map((s) => [s.ref.issue, s.reason])).toEqual([
    [5, 'at mr-open'], [6, 'at blocked'], [7, 'awaiting spec decision'],
  ])
  expect(w.log).toEqual([])
})

test('awaiting-spec with an /approve is picked up and advanced', async () => {
  const { w, deps } = world([{ issue: 8, station: 'awaiting-spec', comments: [
    { id: 's', body: '<!-- factory:spec -->\nx', createdAt: iso(T0 - 2 * MIN), author: ME },
    { id: 'a', body: '/approve', createdAt: iso(T0 - MIN), author: 'alice', trusted: true },
  ] }], { agents: { designer: 'N/A', planner: '1. x', builder: 'nope' } })
  const r = await tick({ ...deps, projects, parallel: 2 })
  expect(r.advanced[0]).toEqual({ ref: w.jobs.get(8)!.ref, from: 'awaiting-spec', to: 'design', needsHuman: false })
})

test('an expired lease of another worker is fair game; own live lease is renewed by edit', async () => {
  const { w, deps } = world([
    { issue: 9, station: 'ready', comments: [lease('w2', T0 - MIN, 'old')] },
    { issue: 10, station: 'ready', comments: [lease('w1', T0 + 10 * MIN, 'mine')] },
  ])
  await tick({ ...deps, projects, parallel: 2 })
  expect(w.jobs.get(9)!.comments.some((c) => c.id !== 'old' && c.body.includes('worker=w1'))).toBe(true)
  expect(w.edits.find((e) => e.id === 'mine')).toEqual({ id: 'mine', body: leaseBody('w1', T0) })
  expect(w.jobs.get(10)!.comments.filter((c) => c.body.includes('factory:lease')).length).toBe(1)
})

test('a forged lease by another author is ignored', async () => {
  const { w, deps } = world([{ issue: 11, station: 'ready', comments: [lease('w2', T0 + 10 * MIN, 'f', 'mallory')] }])
  const r = await tick({ ...deps, projects, parallel: 2 })
  expect(r.advanced.length).toBeGreaterThan(0)
  expect(w.jobs.get(11)!.labels).toEqual(['factory::awaiting-spec'])
})

test('losing the lease race after acquiring skips the job', async () => {
  const { w, deps } = world([{ issue: 12, station: 'ready' }], {
    afterComment: (wd, ref, body) => {
      if (!body.includes('factory:lease')) return
      // another worker's lease, created earlier, appears on re-read
      wd.jobs.get(ref.issue)!.comments.unshift({ id: 'rival', body: leaseBody('w2', T0 + 15 * MIN), createdAt: iso(T0 - 1000), author: ME })
    },
  })
  const r = await tick({ ...deps, projects, parallel: 2 })
  expect(r.advanced).toEqual([])
  expect(r.skipped).toEqual([{ ref: { forge: 'gitlab', host: 'gitlab.com', project: 'g/p', issue: 12 }, reason: 'leased by w2' }])
  expect(w.jobs.get(12)!.labels).toEqual(['factory::ready'])
})

test('the lease is renewed every 5 minutes while a job keeps advancing', async () => {
  const { w, deps } = world([{ issue: 13, station: 'design', comments: [
    { id: 's', body: '<!-- factory:spec -->\nx', createdAt: iso(T0 - 2 * MIN), author: ME },
  ] }], { agents: { designer: 'N/A', planner: '1. x', builder: 'not done' }, agentMinutes: 6 })
  await tick({ ...deps, projects, parallel: 2 })
  const leaseId = w.jobs.get(13)!.comments.find((c) => c.body.includes('factory:lease'))!.id
  const renewals = w.edits.filter((e) => e.id === leaseId && !e.body.includes(`until=${iso(w.clock.now)}`))
  expect(renewals.length).toBeGreaterThanOrEqual(2)
})

test('forge errors during advance are reported as skipped, never thrown', async () => {
  const { w, deps, forge } = world([{ issue: 14, station: 'ready' }, { issue: 15, station: 'ready' }])
  const setStation = forge.setStation
  forge.setStation = async (ref, s) => { if (ref.issue === 14) throw new Error('bad gateway'); return setStation(ref, s) }
  const r = await tick({ ...deps, projects, parallel: 2 })
  expect(r.skipped).toContainEqual({ ref: { forge: 'gitlab', host: 'gitlab.com', project: 'g/p', issue: 14 }, reason: 'error: bad gateway' })
  expect(w.jobs.get(15)!.labels).toEqual(['factory::awaiting-spec'])
})

test('a listing failure is reported per project', async () => {
  const { deps, forge } = world([])
  forge.listJobs = async () => { throw new Error('401 Unauthorized') }
  const r = await tick({ ...deps, projects, parallel: 2 })
  expect(r.skipped).toEqual([{ ref: { forge: 'gitlab', host: 'gitlab.com', project: 'g/p', issue: 0 }, reason: 'list failed: 401 Unauthorized' }])
})

test('only: restricts the tick to the given jobs', async () => {
  const { deps } = world([{ issue: 16, station: 'ready' }, { issue: 17, station: 'ready' }])
  const r = await tick({ ...deps, projects, parallel: 2, only: [{ forge: 'gitlab', host: 'gitlab.com', project: 'g/p', issue: 17 }] })
  expect([...new Set(r.advanced.map((a) => a.ref.issue))]).toEqual([17])
})

test('ownMarkersOnly drops factory markers by other authors only', () => {
  const cs: Comment[] = [
    { id: '1', body: '<!-- factory:lease worker=x until=y -->', createdAt: iso(T0), author: 'mallory' },
    { id: '2', body: '  <!-- factory:spec -->', createdAt: iso(T0), author: ME },
    { id: '3', body: '/approve', createdAt: iso(T0), author: 'alice' },
  ]
  expect(ownMarkersOnly(cs, ME).map((c) => c.id)).toEqual(['2', '3'])
})

test('loadRepoConfig reads .factory.yml at the default branch', async () => {
  const { forge } = world([])
  const seen: string[] = []
  forge.defaultBranch = async () => 'trunk'
  forge.readFile = async (p, path, ref) => { seen.push(`${p}:${path}@${ref}`); return 'forge: gitlab\ntest: "make test"\n' }
  const ok = await loadRepoConfig(forge, { forge: 'gitlab', host: 'gitlab.com', project: 'g/p', issue: 1 })
  expect(seen).toEqual(['g/p:.factory.yml@trunk'])
  expect(ok.ok && ok.config.test).toBe('make test')
  forge.readFile = async () => null
  expect(await loadRepoConfig(forge, { forge: 'gitlab', host: 'gitlab.com', project: 'g/p', issue: 1 })).toEqual({ ok: false, error: 'no .factory.yml on trunk' })
})

test('a step longer than the renewal interval still renews (with a re-read) before the next step', async () => {
  // The designer's run takes 12 minutes and streams nothing but its final result line.
  const { w, deps } = world([{ issue: 20, station: 'design', comments: [
    { id: 's', body: '<!-- factory:spec -->\nx', createdAt: iso(T0 - 2 * MIN), author: ME },
  ] }], { agents: { designer: 'N/A', planner: '1. x', builder: 'not done' }, agentMinutes: 12 })
  const reads: number[] = []
  const getJob = deps.forge.getJob
  deps.forge.getJob = async (ref) => { reads.push(w.clock.now); return getJob(ref) }
  const r = await tick({ ...deps, projects, parallel: 2 })
  expect(r.advanced.map((a) => a.to)).toEqual(['plan', 'build', 'blocked'])
  const leaseId = w.jobs.get(20)!.comments.find((c) => c.body.includes('factory:lease'))!.id
  // Before step 2 (plan) and step 3 (build): a re-read, then a renewal good for 15 min from then.
  const afterDesign = T0 + 12 * MIN
  expect(reads).toContain(afterDesign)
  expect(w.edits).toContainEqual({ id: leaseId, body: leaseBody('w1', afterDesign) })
  expect(w.edits).toContainEqual({ id: leaseId, body: leaseBody('w1', afterDesign + 12 * MIN) })
})

test('a host command that may outlast the lease renews before it starts', async () => {
  // A verify station: its 10-minute test run streams nothing, so the lease is renewed first.
  const { w, deps } = world([{ issue: 21, station: 'verify' }])
  const seen: { argv: string; renewedBefore: boolean }[] = []
  const run = deps.run
  deps.run = async (argv, o) => {
    const renewedBefore = w.edits.length > 0
    seen.push({ argv: argv.join(' '), renewedBefore })
    if (argv.includes('sh') && argv[argv.indexOf('sh') + 1] === '-c') w.clock.now += 9 * MIN
    return run(argv, o)
  }
  await tick({ ...deps, projects, parallel: 2 })
  const test = seen.find((x) => x.argv.includes(' sh -c '))!
  expect(test.renewedBefore).toBe(true)
  expect(w.edits[0].body).toContain('factory:lease worker=w1')
  expect(w.edits[0].body).not.toBe(leaseBody('w1', w.clock.now, 0))
})

test('another worker taking the lease between steps stops the job (spec §9)', async () => {
  const { w, deps } = world([{ issue: 22, station: 'design', comments: [
    { id: 's', body: '<!-- factory:spec -->\nx', createdAt: iso(T0 - 2 * MIN), author: ME },
  ] }], { agents: { designer: 'N/A', planner: '1. x' }, agentMinutes: 20 })
  // During the design step w2 posts a lease that wins (an earlier createdAt than ours, as in a race).
  const spawn = deps.spawn
  deps.spawn = async (argv, o) => {
    const r = await spawn(argv, o)
    w.jobs.get(22)!.comments.push({ id: 'w2', body: leaseBody('w2', w.clock.now + 15 * MIN), createdAt: iso(T0 - 1000), author: ME })
    return r
  }
  const r = await tick({ ...deps, projects, parallel: 2 })
  expect(r.advanced.map((a) => a.to)).toEqual(['plan'])
  expect(r.skipped).toContainEqual({ ref: w.jobs.get(22)!.ref, reason: 'lease lost to w2' })
  expect(w.jobs.get(22)!.labels).toEqual(['factory::plan'])
})

test('agent output renews the lease at most once per 5 minutes', async () => {
  const { w, deps } = world([{ issue: 23, station: 'ready' }])
  deps.spawn = async (_argv, o) => {
    for (let i = 0; i < 12; i++) { w.clock.now += MIN; o.onLine('{"type":"system"}') }
    o.onLine(JSON.stringify({ type: 'result', subtype: 'success', result: '## Goal\nx' }))
    return { exitCode: 0 }
  }
  await tick({ ...deps, projects, parallel: 2 })
  const leaseId = w.jobs.get(23)!.comments.find((c) => c.body.includes('factory:lease'))!.id
  const during = w.edits.filter((e) => e.id === leaseId).map((e) => e.body)
  // The renewal before the spec step, one before the clone (a network git call may run 10 min),
  // then from 12 one-minute lines (non-text lines too) at +5 and +10, then the release.
  expect(during).toEqual([leaseBody('w1', T0), leaseBody('w1', T0), leaseBody('w1', T0 + 5 * MIN), leaseBody('w1', T0 + 10 * MIN), leaseBody('w1', T0 + 12 * MIN, 0)])
})

test('the newest own expired lease is reused instead of posting another', async () => {
  const { w, deps } = world([{ issue: 24, station: 'ready', comments: [lease('w1', T0 - MIN, 'old1'), lease('w1', T0 - MIN, 'old2')] }])
  w.jobs.get(24)!.comments[1].createdAt = iso(T0 - 2 * MIN)
  await tick({ ...deps, projects, parallel: 2 })
  const leases = w.jobs.get(24)!.comments.filter((c) => c.body.includes('factory:lease'))
  expect(leases.map((c) => c.id)).toEqual(['old1', 'old2'])
  expect(w.edits[0]).toEqual({ id: 'old2', body: leaseBody('w1', T0) })
})

test('a failing re-read after acquiring releases the lease', async () => {
  const { w, deps } = world([{ issue: 25, station: 'ready' }])
  let n = 0
  const getJob = deps.forge.getJob
  deps.forge.getJob = async (ref) => { if (++n === 2) throw new Error('502'); return getJob(ref) }
  const r = await tick({ ...deps, projects, parallel: 2 })
  expect(r.skipped).toEqual([{ ref: w.jobs.get(25)!.ref, reason: 'error: 502' }])
  expect(w.edits).toEqual([{ id: 'c1', body: leaseBody('w1', T0, 0) }])
})

test('an exact entry and a wildcard with differently-cased paths advance the job once', async () => {
  const { deps, forge } = world([{ issue: 1, station: 'ready' }])
  const lower = await forge.listJobs('g/p')
  forge.listJobs = async () => lower.map((r) => ({ ...r, project: 'g/p' }))
  forge.listJobsIn = async () => lower.map((r) => ({ ...r, project: 'G/P' }))
  const r = await tick({
    ...deps, parallel: 2,
    projects: [{ forge: 'gitlab', host: 'gitlab.com', project: 'G/*', scope: { kind: 'group', path: 'G' } }, { forge: 'gitlab', host: 'gitlab.com', project: 'g/p' }],
  })
  expect(r.advanced.filter((a) => a.from === 'ready').length).toBe(1)
  expect(new Set(r.advanced.map((a) => a.ref.project.toLowerCase() + a.ref.issue)).size).toBe(1)
  expect(r.skipped).toEqual([])
})
