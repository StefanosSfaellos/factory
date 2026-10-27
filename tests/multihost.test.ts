import { expect, mock, test } from 'claude-code/testing'
import { handle, parseRepos, resolveIssue, type Env } from '../src/commands'
import { gitlabForge } from '../src/forge/gitlab'
import { githubForge } from '../src/forge/github'
import type { Forge, HttpFn } from '../src/forge/types'
import { entryLabel, forgeHostsOf, jobKey, refLabel, resolveTokens, sameRef } from '../src/hosts'
import { childArgv, childSettings } from '../src/agents'
import { NO_TOKENS, workDir } from '../src/worktree'
import { tick } from '../src/tick'
import { slackEvents, slackPayload } from '../src/notify'
import { loadViews } from '../src/ui/model'
import type { Deps } from '../src/stations'
import type { JobRef } from '../src/types'
import { parseRepoConfig } from '../src/config'

// ---------------------------------------------------------------------------
// parseRepos

test('parseRepos: exact entries keep their old meaning, with the host filled in', () => {
  expect(parseRepos(' github:o/r , gitlab:g/sub/p ')).toEqual({
    projects: [
      { forge: 'github', host: 'github.com', project: 'o/r' },
      { forge: 'gitlab', host: 'gitlab.com', project: 'g/sub/p' },
    ],
    errors: [],
  })
  // The GITLAB_URL host is the default for gitlab entries without a host.
  expect(parseRepos('gitlab:g/p', { gitlabHost: 'lab.ironcloud.gr' }).projects).toEqual([{ forge: 'gitlab', host: 'lab.ironcloud.gr', project: 'g/p' }])
})

test('parseRepos: a first segment with a dot is a host (lower-cased)', () => {
  expect(parseRepos('gitlab:Lab.IronCloud.gr/group/sub/name').projects).toEqual([{ forge: 'gitlab', host: 'lab.ironcloud.gr', project: 'group/sub/name' }])
  expect(parseRepos('github:github.com/o/r').projects).toEqual([{ forge: 'github', host: 'github.com', project: 'o/r' }])
})

test('parseRepos: wildcard forms', () => {
  const r = parseRepos('github:*,github:Acme/*,gitlab:*,gitlab:group/sub/*,gitlab:lab.x.gr/*,gitlab:lab.x.gr/team/*', { gitlabHost: 'gitlab.example.com' })
  expect(r.errors).toEqual([])
  expect(r.projects).toEqual([
    { forge: 'github', host: 'github.com', project: '*', scope: { kind: 'all' } },
    { forge: 'github', host: 'github.com', project: 'Acme/*', scope: { kind: 'group', path: 'Acme' } },
    { forge: 'gitlab', host: 'gitlab.example.com', project: '*', scope: { kind: 'all' } },
    { forge: 'gitlab', host: 'gitlab.example.com', project: 'group/sub/*', scope: { kind: 'group', path: 'group/sub' } },
    { forge: 'gitlab', host: 'lab.x.gr', project: '*', scope: { kind: 'all' } },
    { forge: 'gitlab', host: 'lab.x.gr', project: 'team/*', scope: { kind: 'group', path: 'team' } },
  ])
})

test('parseRepos: bad entries are reported, good ones kept', () => {
  const r = parseRepos('bitbucket:x/y,o/r,gitlab:lab.x.gr,gitlab:lab.x.gr/onlyone,github:o/r/extra,github:ghe.corp.com/o/r,gitlab:g/*/x,gitlab:g//p,gitlab:github.com/o/r,github:o/*x,gitlab:g/p')
  expect(r.projects).toEqual([{ forge: 'gitlab', host: 'gitlab.com', project: 'g/p' }])
  expect(r.errors.length).toBe(10)
  expect(r.errors[0]).toBe('bad repo "bitbucket:x/y" (use github:owner/name, github:owner/*, gitlab:group/name, gitlab:<host>/group/name or gitlab:<host>/group/*)')
  expect(r.errors[5]).toContain('github.com')
})

test('parseRepos: duplicate entries are kept once', () => {
  expect(parseRepos('gitlab:g/p,gitlab:gitlab.com/g/p').projects).toEqual([{ forge: 'gitlab', host: 'gitlab.com', project: 'g/p' }])
})

// ---------------------------------------------------------------------------
// tokens

test('resolveTokens: GITHUB_TOKEN and GITLAB_TOKEN/GITLAB_URL as before', () => {
  const r = resolveTokens({ github: 'gh1', gitlab: 'gl1', gitlabUrl: 'https://Lab.Ironcloud.gr/', factory: '' })
  expect(r.gitlabHost).toBe('lab.ironcloud.gr')
  expect(r.hosts).toEqual({
    'github.com': { token: 'gh1', baseUrl: 'https://api.github.com' },
    'lab.ironcloud.gr': { token: 'gl1', baseUrl: 'https://Lab.Ironcloud.gr' },
  })
  expect(r.errors).toEqual([])
  expect(r.secrets).toEqual(['gh1', 'gl1'])
  // no GITLAB_URL: gitlab.com
  expect(resolveTokens({ gitlab: 'gl1' }).hosts).toEqual({ 'gitlab.com': { token: 'gl1', baseUrl: 'https://gitlab.com' } })
})

test('resolveTokens: FACTORY_TOKENS extends and overrides per host (spaces, case)', () => {
  const r = resolveTokens({
    github: 'gh-env', gitlab: 'gl-env', gitlabUrl: 'https://lab.a.gr',
    factory: ' Lab.B.gr = tok-b ,github.com=gh-ft,, lab.a.gr=tok-a=with=equals ',
  })
  expect(r.hosts).toEqual({
    'github.com': { token: 'gh-ft', baseUrl: 'https://api.github.com' },
    'lab.a.gr': { token: 'tok-a=with=equals', baseUrl: 'https://lab.a.gr' },
    'lab.b.gr': { token: 'tok-b', baseUrl: 'https://lab.b.gr' },
  })
  expect(r.errors).toEqual([])
  for (const s of ['gh-env', 'gl-env', 'tok-b', 'gh-ft', 'tok-a=with=equals']) expect(r.secrets).toContain(s)
})

test('resolveTokens: bad FACTORY_TOKENS pairs are reported without their token; their text is still a secret', () => {
  const r = resolveTokens({ factory: 'lab.x.gr:glsecret1,=tok2,lab.y.gr=,https://lab.z.gr=tok3,lab.ok.gr=good' })
  expect(Object.keys(r.hosts)).toEqual(['lab.ok.gr'])
  expect(r.errors.length).toBe(4)
  for (const e of r.errors) {
    expect(e).toContain('FACTORY_TOKENS')
    for (const s of ['glsecret1', 'tok2', 'tok3', 'good']) expect(e).not.toContain(s)
  }
  for (const s of ['lab.x.gr:glsecret1', 'tok2', 'tok3', 'good']) expect(r.secrets).toContain(s)
})

test('the missing-token error names the host and the FACTORY_TOKENS entry', async () => {
  const r = resolveTokens({ gitlab: 'gl', gitlabUrl: 'https://lab.a.gr' })
  expect(r.missing('gitlab', 'lab.c.gr')).toBe('no token for lab.c.gr: add "lab.c.gr=<token>" to FACTORY_TOKENS')
  expect(r.missing('github', 'github.com')).toBe('no token for github.com: set GITHUB_TOKEN or add "github.com=<token>" to FACTORY_TOKENS')
  expect(r.missing('gitlab', 'lab.a.gr')).toBe('no token for lab.a.gr: set GITLAB_TOKEN or add "lab.a.gr=<token>" to FACTORY_TOKENS')
})

test('forgeHostsOf lists github hosts, the GITLAB_URL host, token hosts and repo hosts', () => {
  const t = resolveTokens({ gitlabUrl: 'https://lab.a.gr', factory: 'lab.b.gr=x' })
  const projects = parseRepos('gitlab:lab.c.gr/g/p', { gitlabHost: 'lab.a.gr' }).projects
  expect(forgeHostsOf(t, projects)).toEqual(['github.com', 'api.github.com', 'uploads.github.com', 'lab.a.gr', 'lab.b.gr', 'lab.c.gr'])
})

// ---------------------------------------------------------------------------
// refs: keys and labels

test('jobKey always names the GitLab host; refLabel shortens only the GITLAB_URL host', () => {
  const a: JobRef = { forge: 'gitlab', host: 'lab.a.gr', project: 'g/p', issue: 42 }
  const b: JobRef = { forge: 'gitlab', host: 'lab.b.gr', project: 'g/p', issue: 42 }
  const gh: JobRef = { forge: 'github', host: 'github.com', project: 'o/r', issue: 42 }
  expect(jobKey(a)).toBe('gitlab:lab.a.gr/g/p#42')
  expect(jobKey(a)).not.toBe(jobKey(b))
  expect(sameRef(a, b)).toBe(false)
  expect(jobKey(gh)).toBe('github:o/r#42')
  expect(refLabel(a, 'lab.a.gr')).toBe('gitlab:g/p#42')
  expect(refLabel(b, 'lab.a.gr')).toBe('gitlab:lab.b.gr/g/p#42')
  expect(refLabel(gh, 'lab.a.gr')).toBe('github:o/r#42')
  expect(entryLabel({ forge: 'gitlab', host: 'lab.b.gr', project: 'team/*' }, 'lab.a.gr')).toBe('gitlab:lab.b.gr/team/*')
  // Every label and key resolves back to its ref.
  for (const ref of [a, b, gh]) {
    expect(resolveIssue(jobKey(ref), [], 'lab.a.gr')).toEqual({ ref })
    expect(resolveIssue(refLabel(ref, 'lab.a.gr'), [], 'lab.a.gr')).toEqual({ ref })
  }
})

test('resolveIssue: #N needs exactly one exact repo; wildcards need a full ref', () => {
  const exact = parseRepos('gitlab:lab.b.gr/g/p').projects
  expect(resolveIssue('#7', exact)).toEqual({ ref: { forge: 'gitlab', host: 'lab.b.gr', project: 'g/p', issue: 7 } })
  for (const list of ['gitlab:lab.b.gr/*', 'gitlab:g/p,gitlab:lab.b.gr/*', 'github:o/*']) {
    const r = resolveIssue('#7', parseRepos(list).projects)
    expect('error' in r && r.error).toContain('full issue reference')
  }
  expect('error' in resolveIssue('gitlab:lab.b.gr/*#7', [])).toBe(true)
  expect('error' in resolveIssue('gitlab:lab.b.gr/onlyone#7', [])).toBe(true)
  expect(resolveIssue('github:o/r#3', [])).toEqual({ ref: { forge: 'github', host: 'github.com', project: 'o/r', issue: 3 } })
})

// ---------------------------------------------------------------------------
// GitLab listJobsIn

type Req = { url: string; headers: Record<string, string> }
function fakeHttp(routes: (url: string) => unknown): { http: HttpFn; reqs: Req[] } {
  const reqs: Req[] = []
  const http: HttpFn = async (req) => {
    reqs.push({ url: req.url, headers: req.headers })
    const v = routes(req.url)
    if (v === undefined) return { status: 404, ok: false, text: '' }
    return { status: 200, ok: true, text: JSON.stringify(v) }
  }
  return { http, reqs }
}
const ACTIVE = ['ready', 'spec', 'awaiting-spec', 'design', 'plan', 'build', 'verify', 'review', 'approve', 'mr-open', 'blocked']
const enc = (s: string) => encodeURIComponent(`factory::${s}`)

const MEMBERS = 'projects?membership=true&min_access_level=30&simple=true'
/** GitLab's member-projects listing, filtered by min_access_level the way the server does. */
function membersRoute(api: string, projects: { id: number; path: string; level: number }[], url: string): unknown {
  const m = new RegExp(`^${api.replace(/[.]/g, '\\.')}/projects\\?membership=true&min_access_level=(\\d+)&simple=true&per_page=100&page=(\\d+)$`).exec(url)
  if (!m) return undefined
  const all = projects.filter((p) => p.level >= Number(m[1])).map((p) => ({ id: p.id, path_with_namespace: p.path }))
  return all.slice((Number(m[2]) - 1) * 100, Number(m[2]) * 100)
}

test('GitLab listJobsIn all: one paged query per active station label, union and dedupe', async () => {
  const api = 'https://lab.a.gr/api/v4'
  const members = [{ id: 1, path: 'g/a', level: 30 }, { id: 2, path: 'g/sub/b', level: 40 }, { id: 3, path: 'g/c', level: 50 }]
  const { http, reqs } = fakeHttp((url) => {
    if (url === `${api}/issues?scope=all&state=opened&labels=${enc('ready')}&per_page=100&page=1`) {
      return Array.from({ length: 100 }, (_, i) => ({ iid: i + 1, project_id: 1, references: { full: `g/a#${i + 1}` } }))
    }
    if (url === `${api}/issues?scope=all&state=opened&labels=${enc('ready')}&per_page=100&page=2`) return [{ iid: 101, project_id: 2, references: { full: 'g/sub/b#101' } }]
    // #1 of g/a also carries factory::build (an invalid job): listed once.
    if (url === `${api}/issues?scope=all&state=opened&labels=${enc('build')}&per_page=100&page=1`) return [{ iid: 1, project_id: 1, references: { full: 'g/a#1' } }, { iid: 1, project_id: 3, references: { full: 'g/c#1' } }]
    if (url.startsWith(`${api}/issues?`)) return []
    return membersRoute(api, members, url)
  })
  const f = gitlabForge(http, { baseUrl: 'https://lab.a.gr', token: 't' })
  const refs = await f.listJobsIn({ kind: 'all' })
  expect(refs.length).toBe(102)
  expect(refs.every((r) => r.forge === 'gitlab' && r.host === 'lab.a.gr')).toBe(true)
  expect(refs).toContainEqual({ forge: 'gitlab', host: 'lab.a.gr', project: 'g/sub/b', issue: 101 })
  expect(refs).toContainEqual({ forge: 'gitlab', host: 'lab.a.gr', project: 'g/c', issue: 1 })
  expect(refs.filter((r) => r.project === 'g/a' && r.issue === 1).length).toBe(1)
  // every active label queried, done never
  for (const s of ACTIVE) expect(reqs.some((q) => q.url.includes(`labels=${enc(s)}&`))).toBe(true)
  expect(reqs.some((q) => q.url.includes(enc('done')))).toBe(false)
})

test('GitLab listJobsIn group: include_subgroups; project path falls back to the member listing', async () => {
  const api = 'https://gitlab.com/api/v4'
  // 150 member projects: the listing is paged.
  const members = [...Array.from({ length: 148 }, (_, i) => ({ id: 1000 + i, path: `x/p${i}`, level: 30 })), { id: 77, path: 'team/sub/x', level: 30 }, { id: 78, path: 'team/sub/y', level: 30 }]
  const { http, reqs } = fakeHttp((url) => {
    if (url === `${api}/groups/team%2Fsub/issues?state=opened&include_subgroups=true&labels=${enc('plan')}&per_page=100&page=1`) {
      return [{ iid: 3, project_id: 77 }, { iid: 4, project_id: 77 }, { iid: 5, project_id: 78, references: {} }]
    }
    if (url.startsWith(`${api}/groups/team%2Fsub/issues?`)) return []
    return membersRoute(api, members, url)
  })
  const f = gitlabForge(http, { baseUrl: 'https://gitlab.com', token: 't' })
  const refs = await f.listJobsIn({ kind: 'group', path: 'team/sub' })
  expect(refs).toEqual([
    { forge: 'gitlab', host: 'gitlab.com', project: 'team/sub/x', issue: 3 },
    { forge: 'gitlab', host: 'gitlab.com', project: 'team/sub/x', issue: 4 },
    { forge: 'gitlab', host: 'gitlab.com', project: 'team/sub/y', issue: 5 },
  ])
  expect(reqs.some((q) => /\/projects\/\d+$/.test(q.url))).toBe(false)
  expect(reqs.filter((q) => q.url.includes(MEMBERS)).map((q) => q.url.slice(-6))).toEqual(['page=1', 'page=2', 'page=3'])
  expect(reqs.every((q) => q.headers['PRIVATE-TOKEN'] === 't')).toBe(true)
})

// Fix 1: GitLab wildcards cover only projects where the token's user has Developer (30) access or more.
function accessWorld() {
  const api = 'https://lab.a.gr/api/v4'
  const members = [{ id: 1, path: 'team/dev', level: 30 }, { id: 2, path: 'team/rep', level: 20 }]
  // project 3 (others/public) is public: its issues show in /issues?scope=all, but it is no member project.
  const issues = [
    { iid: 1, project_id: 1, references: { full: 'team/dev#1' } },
    { iid: 2, project_id: 2, references: { full: 'team/rep#2' } },
    { iid: 3, project_id: 3, references: { full: 'others/public#3' } },
  ]
  return fakeHttp((url) => {
    if (url === `${api}/issues?scope=all&state=opened&labels=${enc('ready')}&per_page=100&page=1`) return issues
    if (url === `${api}/groups/team/issues?state=opened&include_subgroups=true&labels=${enc('ready')}&per_page=100&page=1`) return issues.slice(0, 2)
    if (url.includes('/issues?')) return []
    return membersRoute(api, members, url)
  })
}

test('GitLab wildcard: a labelled issue in a public project the user is no member of is ignored', async () => {
  const f = gitlabForge(accessWorld().http, { baseUrl: 'https://lab.a.gr', token: 't' })
  expect((await f.listJobsIn({ kind: 'all' })).map((r) => r.project)).not.toContain('others/public')
})

test('GitLab wildcard: a member project with Reporter (20) access is ignored', async () => {
  const { http, reqs } = accessWorld()
  const f = gitlabForge(http, { baseUrl: 'https://lab.a.gr', token: 't' })
  expect((await f.listJobsIn({ kind: 'all' })).map((r) => r.project)).not.toContain('team/rep')
  expect((await f.listJobsIn({ kind: 'group', path: 'team' })).map((r) => r.project)).not.toContain('team/rep')
  expect(reqs.some((q) => q.url.endsWith(`/api/v4/${MEMBERS}&per_page=100&page=1`))).toBe(true)
})

test('GitLab wildcard: a Developer (30) member project is included; the member listing is read once per tick', async () => {
  const { http, reqs } = accessWorld()
  const f = gitlabForge(http, { baseUrl: 'https://lab.a.gr', token: 't' })
  expect(await f.listJobsIn({ kind: 'all' })).toEqual([{ forge: 'gitlab', host: 'lab.a.gr', project: 'team/dev', issue: 1 }])
  expect(await f.listJobsIn({ kind: 'group', path: 'team' })).toEqual([{ forge: 'gitlab', host: 'lab.a.gr', project: 'team/dev', issue: 1 }])
  expect(reqs.filter((q) => q.url.includes(`${MEMBERS}&per_page=100&page=1`)).length).toBe(1)
})

test('GitLab wildcard: a failing membership call yields no jobs and an error (fail closed)', async () => {
  const api = 'https://lab.a.gr/api/v4'
  const { http } = fakeHttp((url) => {
    if (url.includes('/projects?membership=')) return undefined // 404
    if (url.endsWith('/user')) return { username: 'bot' }
    if (url.includes('/issues?') && url.includes(enc('ready')) && url.endsWith('page=1')) return [{ iid: 1, project_id: 1, references: { full: 'team/dev#1' } }]
    if (url.includes('/issues?')) return []
    return undefined
  })
  const f = gitlabForge(http, { baseUrl: 'https://lab.a.gr', token: 't' })
  let err = ''
  try { await f.listJobsIn({ kind: 'all' }) } catch (e) { err = String(e) }
  expect(err).toContain('membership')
  // through the commands: status and tick show the error line and run nothing
  const env = {
    projects: parseRepos('gitlab:lab.a.gr/*').projects, repoErrors: [], gitlabHost: 'gitlab.com',
    forgeFor: () => ({ forge: f }), deps: { secrets: [], workerId: 'w' }, isPaused: () => false,
    loadConfigFor: () => async () => parseRepoConfig('forge: gitlab\ntest: x\n'), lock: { busy: false }, parallel: 2,
  } as unknown as Env
  const st = await handle({ kind: 'status' }, env)
  expect(st).toContain('0 jobs')
  expect(st).toMatch(/gitlab:lab\.a\.gr\/\*: error: .*membership/)
  const tk = await handle({ kind: 'tick' }, env)
  expect(tk).toContain('advanced 0 jobs')
  expect(tk).toMatch(/gitlab:lab\.a\.gr\/\*: skipped \(list failed: .*membership/)
  void api
})

test('GitLab refs, clone and public URLs use the instance host', async () => {
  const { http } = fakeHttp((url) => (url.includes('/issues?') ? (url.endsWith('page=1') ? [{ iid: 9, labels: ['factory::ready'] }] : []) : undefined))
  const f = gitlabForge(http, { baseUrl: 'https://Lab.B.gr', token: 'tk' })
  expect(await f.listJobs('g/p')).toEqual([{ forge: 'gitlab', host: 'lab.b.gr', project: 'g/p', issue: 9 }])
  expect(f.cloneUrl('g/p')).toBe('https://oauth2:tk@Lab.B.gr/g/p.git')
  expect(f.publicUrl('g/p')).toBe('https://Lab.B.gr/g/p.git')
})

// ---------------------------------------------------------------------------
// GitHub listJobsIn

test('GitHub listJobsIn all: per-label /issues?filter=all, PRs skipped, union by repo and number', async () => {
  const api = 'https://api.github.com'
  const { http } = fakeHttp((url) => {
    if (url === `${api}/issues?filter=all&state=open&labels=${enc('ready')}&per_page=100&page=1`) {
      return [
        { number: 1, repository: { full_name: 'acme/shop' } },
        { number: 2, repository: { full_name: 'acme/shop' }, pull_request: { url: 'x' } },
        { number: 1, repository: { full_name: 'other/lib' } },
      ]
    }
    if (url === `${api}/issues?filter=all&state=open&labels=${enc('blocked')}&per_page=100&page=1`) return [{ number: 1, repository: { full_name: 'acme/shop' } }]
    if (url.startsWith(`${api}/issues?`)) return []
    return undefined
  })
  const f = githubForge(http, { token: 't' })
  expect(await f.listJobsIn({ kind: 'all' })).toEqual([
    { forge: 'github', host: 'github.com', project: 'acme/shop', issue: 1 },
    { forge: 'github', host: 'github.com', project: 'other/lib', issue: 1 },
  ])
})

test('GitHub listJobsIn owner: keeps only that owner, case-insensitively', async () => {
  const { http } = fakeHttp((url) => {
    if (url.includes(`labels=${enc('build')}&`) && url.endsWith('page=1')) {
      return [{ number: 5, repository: { full_name: 'Acme/shop' } }, { number: 6, repository: { full_name: 'acmex/shop' } }, { number: 7, repository: { full_name: 'other/acme' } }]
    }
    if (url.includes('/issues?')) return []
    return undefined
  })
  const f = githubForge(http, { token: 't' })
  expect(await f.listJobsIn({ kind: 'group', path: 'acme' })).toEqual([{ forge: 'github', host: 'github.com', project: 'Acme/shop', issue: 5 }])
})

// ---------------------------------------------------------------------------
// tick: wildcard + exact dedupe

test('tick dedupes a job matched by an exact entry and a wildcard', async () => {
  const ref: JobRef = { forge: 'gitlab', host: 'lab.a.gr', project: 'g/p', issue: 4 }
  const forge = {
    listJobs: async () => [ref],
    listJobsIn: async () => [ref, { ...ref, project: 'g/q' }],
    getJob: async (r: JobRef) => ({ ref: r, title: 'T', body: '', labels: ['factory::awaiting-spec'], comments: [] }),
    whoami: async () => 'bot',
  } as unknown as Forge
  const r = await tick({
    forge, loadConfig: async () => parseRepoConfig('forge: gitlab\ntest: x\n'), secrets: [], workerId: 'w', now: () => 0,
    projects: [{ forge: 'gitlab', host: 'lab.a.gr', project: 'g/p' }, { forge: 'gitlab', host: 'lab.a.gr', project: 'g/*', scope: { kind: 'group', path: 'g' } }],
    parallel: 2,
  } as unknown as Deps & Parameters<typeof tick>[0])
  expect(r.skipped.map((s) => jobKey(s.ref))).toEqual(['gitlab:lab.a.gr/g/p#4', 'gitlab:lab.a.gr/g/q#4'])
})

// ---------------------------------------------------------------------------
// Security: tokens never reach children

test('NO_TOKENS, childArgv and the child sandbox strip FACTORY_TOKENS', () => {
  expect(NO_TOKENS).toContain('FACTORY_TOKENS')
  expect(NO_TOKENS[NO_TOKENS.indexOf('FACTORY_TOKENS') - 1]).toBe('-u')
  const cfg = parseRepoConfig('forge: gitlab\ntest: x\n')
  if (!cfg.ok) throw new Error('cfg')
  const argv = childArgv({ role: 'builder', prompt: 'p', cfg: cfg.config, pluginRoot: '/p', job: 'j', worktree: '/w' })
  const claude = argv.indexOf('claude')
  expect(argv.slice(0, claude).join(' ')).toContain('-u FACTORY_TOKENS')
  const s = JSON.parse(childSettings(cfg.config))
  expect(s.sandbox.credentials.envVars).toContainEqual({ name: 'FACTORY_TOKENS', mode: 'deny' })
})

test('workDir separates the same project on two hosts', () => {
  const a: JobRef = { forge: 'gitlab', host: 'lab.a.gr', project: 'g/p', issue: 4 }
  expect(workDir('/w', a)).toBe('/w/gitlab/lab.a.gr/g__p/4')
  expect(workDir('/w', { ...a, host: 'lab.b.gr' })).not.toBe(workDir('/w', a))
})

test('Slack: the dedupe key and the text carry the host', async () => {
  const a: JobRef = { forge: 'gitlab', host: 'lab.a.gr', project: 'g/p', issue: 4 }
  const b: JobRef = { ...a, host: 'lab.b.gr' }
  const evs = await slackEvents(
    [{ ref: a, from: 'spec', to: 'blocked', needsHuman: true }, { ref: b, from: 'spec', to: 'blocked', needsHuman: true }],
    async (r) => ({ title: 'T', issueUrl: `https://${r.host}/x` }),
  )
  expect(evs.length).toBe(2)
  expect(JSON.parse(slackPayload(evs[1], [], 'lab.a.gr')).text).toContain('gitlab:lab.b.gr/g/p#4')
  expect(JSON.parse(slackPayload(evs[0], [], 'lab.a.gr')).text).toContain('(gitlab:g/p#4)')
})

test('loadViews reads wildcard entries, routes per host and dedupes', async () => {
  const mk = (host: string, refs: JobRef[]) => ({
    listJobs: async () => refs.slice(0, 1),
    listJobsIn: async () => refs,
    getJob: async (r: JobRef) => ({ ref: r, title: `${r.host} ${r.project}`, body: '', labels: ['factory::ready'], comments: [] }),
    whoami: async () => 'bot',
    publicUrl: (p: string) => `https://${host}/${p}.git`,
  }) as unknown as Forge
  const a = mk('lab.a.gr', [{ forge: 'gitlab', host: 'lab.a.gr', project: 'g/p', issue: 1 }, { forge: 'gitlab', host: 'lab.a.gr', project: 'g/q', issue: 2 }])
  const projects = parseRepos('gitlab:g/p,gitlab:g/*,gitlab:lab.c.gr/x/y', { gitlabHost: 'lab.a.gr' }).projects
  const r = await loadViews(projects, (p) => (p.host === 'lab.a.gr' ? { forge: a } : { error: `no token for ${p.host}` }), { now: 0, secrets: [], gitlabHost: 'lab.a.gr' })
  expect(r.views.map((v) => v.links.issue)).toEqual(['https://lab.a.gr/g/p/-/issues/1', 'https://lab.a.gr/g/q/-/issues/2'])
  expect(r.errors).toEqual(['gitlab:lab.c.gr/x/y: no token for lab.c.gr'])
})

// ---------------------------------------------------------------------------
// handle(): status per host

test('/factory status: a host without a token is an error line; the other repos are still listed', async () => {
  const ref: JobRef = { forge: 'gitlab', host: 'lab.a.gr', project: 'g/p', issue: 4 }
  const forge = {
    listJobs: async () => [ref],
    getJob: async (r: JobRef) => ({ ref: r, title: 'T', body: '', labels: ['factory::ready'], comments: [] }),
    whoami: async () => 'bot',
  } as unknown as Forge
  const t = resolveTokens({ gitlab: 'x', gitlabUrl: 'https://lab.a.gr' })
  const env = {
    projects: parseRepos('gitlab:g/p,gitlab:lab.c.gr/x/y', { gitlabHost: 'lab.a.gr' }).projects,
    repoErrors: [], gitlabHost: 'lab.a.gr',
    forgeFor: (p: { forge: 'github' | 'gitlab'; host: string }) => (p.host === 'lab.a.gr' ? { forge } : { error: t.missing(p.forge, p.host) }),
    deps: { secrets: [], workerId: 'w' }, isPaused: () => false,
  } as unknown as Env
  const text = await handle({ kind: 'status' }, env)
  expect(text).toContain('gitlab:g/p: 1 job — ready: #4')
  expect(text).toContain('gitlab:lab.c.gr/x/y: no token for lab.c.gr: add "lab.c.gr=<token>" to FACTORY_TOKENS')
})

// ---------------------------------------------------------------------------
// register: several hosts in one session

const json = (v: unknown) => ({ value: { status: 200, ok: true, headers: {}, text: JSON.stringify(v) } })
const notFound = { value: { status: 404, ok: false, headers: {}, text: '' } }

/** Three forges in memory: each answers one awaiting-spec issue #4 in its project. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function threeForges(on: any) {
  const seen: { host: string; auth: string; url: string }[] = []
  on('http.fetch', (_: unknown, e: { url: string; init?: { headers?: Record<string, string> } }) => {
    const u = new URL(e.url)
    const h = e.init?.headers ?? {}
    seen.push({ host: u.host, auth: h['PRIVATE-TOKEN'] ?? h.Authorization ?? '', url: e.url })
    const p = e.url.replace(/^https:\/\/[^/]+/, '')
    if (u.host === 'api.github.com') {
      if (p === '/user') return json({ login: 'bot' })
      if (p.startsWith('/repos/o/r/issues?')) return json(p.endsWith('page=1') ? [{ number: 4, labels: [{ name: 'factory::awaiting-spec' }] }] : [])
      if (p === '/repos/o/r/issues/4') return json({ number: 4, title: 'GH', body: '', labels: [{ name: 'factory::awaiting-spec' }] })
      if (p.startsWith('/repos/o/r/issues/4/comments')) return json([])
      return notFound
    }
    if (p === '/api/v4/user') return json({ username: 'bot' })
    if (p.startsWith('/api/v4/projects/g%2Fp/issues?')) return json(p.endsWith('page=1') ? [{ iid: 4, labels: ['factory::awaiting-spec'] }] : [])
    if (p === '/api/v4/projects/g%2Fp/issues/4') return json({ iid: 4, title: u.host, description: '', labels: ['factory::awaiting-spec'] })
    if (p.startsWith('/api/v4/projects/g%2Fp/issues/4/notes')) return json([])
    return notFound
  })
  return seen
}

test('one session ticks two GitLab hosts and GitHub, each job on its own forge instance', { options: { repos: 'gitlab:g/p,gitlab:lab.b.gr/g/p,github:o/r', workerId: 'w1' } }, async ($, on) => {
  mock.env(on, { GITLAB_URL: 'https://lab.a.gr', GITLAB_TOKEN: 'tok-a', FACTORY_TOKENS: 'lab.b.gr=tok-b, GitHub.com=tok-gh', HOME: '/home/u' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  const seen = threeForges(on)
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const r = await $.command.run({ command: 'factory', args: 'tick' })
  expect(r.text).toContain('gitlab:g/p#4: skipped (awaiting spec decision)')
  expect(r.text).toContain('gitlab:lab.b.gr/g/p#4: skipped (awaiting spec decision)')
  expect(r.text).toContain('github:o/r#4: skipped (awaiting spec decision)')
  const want: Record<string, string> = { 'lab.a.gr': 'tok-a', 'lab.b.gr': 'tok-b', 'api.github.com': 'Bearer tok-gh' }
  for (const q of seen) expect(q.auth).toBe(want[q.host])
  for (const host of Object.keys(want)) expect(seen.some((q) => q.host === host && /issues\/4$/.test(q.url))).toBe(true)
  // status names each host's job once
  const s = await $.command.run({ command: 'factory', args: 'status' })
  expect(s.text).toContain('3 jobs in 3 repos')
  expect(s.text).toContain('gitlab:lab.b.gr/g/p: 1 job')
  // a full host ref reaches that host only
  const one = await $.command.run({ command: 'factory', args: 'status gitlab:lab.b.gr/g/p#4' })
  expect(one.text).toContain('"lab.b.gr": awaiting-spec')
})

test('a host with no token is a status and tick error line, not a crash', { options: { repos: 'gitlab:g/p,gitlab:lab.c.gr/x/y', workerId: 'w1' } }, async ($, on) => {
  mock.env(on, { GITLAB_TOKEN: 'glpat-real-token-123', HOME: '/home/u' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', (_, e) => (e.url.endsWith('/user') ? json({ username: 'bot' }) : json([])))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const s = await $.command.run({ command: 'factory', args: 'status' })
  expect(s.text).toContain('gitlab:g/p: 0 jobs')
  expect(s.text).toContain('gitlab:lab.c.gr/x/y: no token for lab.c.gr: add "lab.c.gr=<token>" to FACTORY_TOKENS')
  const t = await $.command.run({ command: 'factory', args: 'tick' })
  expect(t.text).toContain('gitlab:lab.c.gr/x/y: skipped (no token for lab.c.gr: add "lab.c.gr=<token>" to FACTORY_TOKENS)')
})

test('FACTORY_TOKENS values are redacted from what the commands answer', { options: { repos: 'gitlab:lab.b.gr/x/y' } }, async ($, on) => {
  mock.env(on, { FACTORY_TOKENS: 'lab.b.gr=plainsecret987', HOME: '/home/u' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // An issue title that echoes the token: what the command answers is redacted.
  on('http.fetch', (_, e) => {
    if (e.url.endsWith('/user')) return json({ username: 'bot' })
    if (e.url === 'https://lab.b.gr/api/v4/projects/x%2Fy/issues/4') return json({ iid: 4, title: 'leak plainsecret987', labels: ['factory::ready'] })
    return json([])
  })
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const s = await $.command.run({ command: 'factory', args: 'status gitlab:lab.b.gr/x/y#4' })
  expect(s.text).toContain('[redacted]')
  expect(s.text).not.toContain('plainsecret987')
})

test('bad FACTORY_TOKENS pairs show in status', { options: { repos: 'gitlab:g/p' } }, async ($, on) => {
  mock.env(on, { GITLAB_TOKEN: 'x', FACTORY_TOKENS: 'lab.b.gr:oops123', HOME: '/home/u' })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('http.fetch', () => json([]))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  const s = await $.command.run({ command: 'factory', args: 'status' })
  expect(s.text).toContain('FACTORY_TOKENS')
  expect(s.text).not.toContain('oops123')
})
