import { STATIONS } from '../types'
import type { Comment, Job, JobRef, Station } from '../types'
import { ForgeError } from './types'
import type { Forge, HttpFn } from './types'

const LABEL_PREFIX = 'factory::'
const ALL_FACTORY_LABELS = [...STATIONS.map((s) => LABEL_PREFIX + s), LABEL_PREFIX + 'spec-approved']
const TRUSTED = ['OWNER', 'MEMBER', 'COLLABORATOR']
/** The labels a wildcard listing queries, one at a time (GitHub ANDs several): every station but done. */
const ACTIVE_LABELS = STATIONS.filter((s) => s !== 'done').map((s) => LABEL_PREFIX + s)
const HOST = 'github.com'

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

export function githubForge(http: HttpFn, opts: { token: string; apiUrl?: string }): Forge {
  const api = (opts.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '')

  async function call(method: Method, path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    const req: { url: string; method: Method; headers: Record<string, string>; body?: string } = {
      url: api + path,
      method,
      headers,
    }
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      req.body = JSON.stringify(body)
    }
    const res = await http(req)
    if (res.status < 200 || res.status >= 300) {
      throw new ForgeError(res.status, `GitHub ${method} ${path} failed: ${res.status}`)
    }
    if (!res.text) throw new ForgeError(res.status, `GitHub ${method} ${path} returned an empty body`)
    try {
      return JSON.parse(res.text)
    } catch {
      throw new ForgeError(res.status, `GitHub ${method} ${path} returned invalid JSON`)
    }
  }

  async function paged(path: string): Promise<any[]> {
    const out: any[] = []
    const sep = path.includes('?') ? '&' : '?'
    for (let page = 1; ; page++) {
      const items = await call('GET', `${path}${sep}per_page=100&page=${page}`)
      if (!Array.isArray(items)) throw new ForgeError(200, `GitHub GET ${path} returned a non-array page`)
      if (items.length === 0) break
      out.push(...items)
    }
    return out
  }

  const repo = (project: string) => `/repos/${project}`
  const issuePath = (ref: JobRef) => `${repo(ref.project)}/issues/${ref.issue}`
  const labelNames = (labels: any): string[] =>
    (Array.isArray(labels) ? labels : []).map((l: any) => (typeof l === 'string' ? l : l?.name)).filter((n: any) => typeof n === 'string')

  const toComment = (c: any): Comment => ({
    id: String(c.id),
    body: c.body ?? '',
    createdAt: c.created_at,
    author: c.user?.login ?? '',
    trusted: !!c.user && TRUSTED.includes(c.author_association),
  })

  async function defaultBranch(project: string): Promise<string> {
    const p = await call('GET', repo(project))
    return p.default_branch
  }

  return {
    async listJobs(project) {
      const issues = await paged(`${repo(project)}/issues?state=open`)
      const refs: JobRef[] = []
      for (const i of issues) {
        if (i.pull_request) continue
        const active = labelNames(i.labels).some((l) => l.startsWith(LABEL_PREFIX) && l !== LABEL_PREFIX + 'done')
        if (active) refs.push({ forge: 'github', host: HOST, project, issue: i.number })
      }
      return refs
    },

    async listJobsIn(scope) {
      const owner = scope.kind === 'group' ? scope.path.toLowerCase() : undefined
      const seen = new Set<string>()
      const refs: JobRef[] = []
      for (const label of ACTIVE_LABELS) {
        for (const i of await paged(`/issues?filter=all&state=open&labels=${encodeURIComponent(label)}`)) {
          if (i.pull_request) continue
          const project = i.repository?.full_name
          if (typeof project !== 'string' || !project.includes('/')) continue
          if (owner !== undefined && project.split('/')[0].toLowerCase() !== owner) continue
          const key = `${project.toLowerCase()}#${i.number}`
          if (seen.has(key)) continue
          seen.add(key)
          refs.push({ forge: 'github', host: HOST, project, issue: i.number })
        }
      }
      return refs
    },

    async getJob(ref) {
      const issue = await call('GET', issuePath(ref))
      const raw = await paged(`${issuePath(ref)}/comments`)
      const comments = raw
        .map(toComment)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      return {
        ref,
        title: issue.title ?? '',
        body: issue.body ?? '',
        labels: labelNames(issue.labels),
        comments,
      } as Job
    },

    async comment(ref, body) {
      return toComment(await call('POST', `${issuePath(ref)}/comments`, { body }))
    },

    async editComment(ref, id, body) {
      await call('PATCH', `${repo(ref.project)}/issues/comments/${encodeURIComponent(id)}`, { body })
    },

    async setStation(ref, station: Station) {
      const current = labelNames(await paged(`${issuePath(ref)}/labels`))
      const keep = current.filter((l) => !ALL_FACTORY_LABELS.includes(l))
      await call('PUT', `${issuePath(ref)}/labels`, { labels: [...keep, LABEL_PREFIX + station] })
    },

    async createIssue(project, title, body) {
      const i = await call('POST', `${repo(project)}/issues`, { title, body })
      return { forge: 'github', host: HOST, project, issue: i.number }
    },

    async openMR(ref, branch, title, body) {
      const base = await defaultBranch(ref.project)
      const pr = await call('POST', `${repo(ref.project)}/pulls`, { head: branch, base, title, body })
      return { url: pr.html_url }
    },

    defaultBranch,

    cloneUrl(project) {
      return `https://x-access-token:${opts.token}@github.com/${project}.git`
    },

    publicUrl(project) {
      return `https://github.com/${project}.git`
    },

    async findOpenMR(project, branch) {
      const owner = project.split('/')[0]
      const prs = await call('GET', `${repo(project)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`)
      const pr = Array.isArray(prs) ? prs[0] : undefined
      return pr && typeof pr.html_url === 'string' ? { url: pr.html_url } : null
    },

    async whoami() {
      const u = await call('GET', '/user')
      return u.login
    },

    async readFile(project, path, ref) {
      const p = `${repo(project)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`
      const res = await http({
        url: api + p,
        method: 'GET',
        headers: { Authorization: `Bearer ${opts.token}`, Accept: 'application/vnd.github.raw', 'X-GitHub-Api-Version': '2022-11-28' },
      })
      if (res.status === 404) return null
      if (res.status < 200 || res.status >= 300) throw new ForgeError(res.status, `GitHub GET ${p} failed: ${res.status}`)
      return res.text
    },
  }
}
