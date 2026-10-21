import { STATIONS } from '../types'
import type { Comment, Job, JobRef, Station } from '../types'
import { ForgeError } from './types'
import type { Forge, HttpFn } from './types'

const LABEL_PREFIX = 'factory::'
const ALL_FACTORY_LABELS = [...STATIONS.map((s) => LABEL_PREFIX + s), LABEL_PREFIX + 'spec-approved']

export function gitlabForge(http: HttpFn, opts: { baseUrl: string; token: string }): Forge {
  const root = opts.baseUrl.replace(/\/+$/, '')
  const api = root + '/api/v4'
  const host = root.replace(/^https?:\/\//, '')

  async function call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = { 'PRIVATE-TOKEN': opts.token, Accept: 'application/json' }
    const req: { url: string; method: 'GET' | 'POST' | 'PUT'; headers: Record<string, string>; body?: string } = {
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
      throw new ForgeError(res.status, `GitLab ${method} ${path} failed: ${res.status}`)
    }
    if (!res.text) return null
    try {
      return JSON.parse(res.text)
    } catch {
      throw new ForgeError(res.status, `GitLab ${method} ${path} returned invalid JSON`)
    }
  }

  async function paged(path: string): Promise<any[]> {
    const out: any[] = []
    const sep = path.includes('?') ? '&' : '?'
    for (let page = 1; ; page++) {
      const items = await call('GET', `${path}${sep}per_page=100&page=${page}`)
      if (!Array.isArray(items) || items.length === 0) break
      out.push(...items)
    }
    return out
  }

  const pid = (project: string) => encodeURIComponent(project)
  const issuePath = (ref: JobRef) => `/projects/${pid(ref.project)}/issues/${ref.issue}`

  const toComment = (n: any): Comment => ({
    id: String(n.id),
    body: n.body ?? '',
    createdAt: n.created_at,
    author: n.author?.username ?? '',
    trusted: true,
  })

  return {
    async listJobs(project) {
      const issues = await paged(`/projects/${pid(project)}/issues?state=opened`)
      const refs: JobRef[] = []
      for (const i of issues) {
        const labels: string[] = i.labels ?? []
        const active = labels.some((l) => l.startsWith(LABEL_PREFIX) && l !== LABEL_PREFIX + 'done')
        if (active) refs.push({ forge: 'gitlab', project, issue: i.iid })
      }
      return refs
    },

    async getJob(ref) {
      const issue = await call('GET', issuePath(ref))
      const notes = await paged(`${issuePath(ref)}/notes?sort=asc&order_by=created_at`)
      const comments = notes
        .filter((n) => !n.system)
        .map(toComment)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))
      return {
        ref,
        title: issue.title ?? '',
        body: issue.description ?? '',
        labels: issue.labels ?? [],
        comments,
      } as Job
    },

    async comment(ref, body) {
      return toComment(await call('POST', `${issuePath(ref)}/notes`, { body }))
    },

    async editComment(ref, id, body) {
      await call('PUT', `${issuePath(ref)}/notes/${encodeURIComponent(id)}`, { body })
    },

    async setStation(ref, station: Station) {
      const add = LABEL_PREFIX + station
      const remove = ALL_FACTORY_LABELS.filter((l) => l !== add)
      await call('PUT', issuePath(ref), { add_labels: add, remove_labels: remove.join(',') })
    },

    async createIssue(project, title, body) {
      const i = await call('POST', `/projects/${pid(project)}/issues`, { title, description: body })
      return { forge: 'gitlab', project, issue: i.iid }
    },

    async openMR(ref, branch, title, body) {
      const target = await this.defaultBranch(ref.project)
      const mr = await call('POST', `/projects/${pid(ref.project)}/merge_requests`, {
        source_branch: branch,
        target_branch: target,
        title,
        description: body,
        remove_source_branch: true,
      })
      return { url: mr.web_url }
    },

    async defaultBranch(project) {
      const p = await call('GET', `/projects/${pid(project)}`)
      return p.default_branch
    },

    cloneUrl(project) {
      return `https://oauth2:${opts.token}@${host}/${project}.git`
    },

    publicUrl(project) {
      return `${root}/${project}.git`
    },

    async findOpenMR(project, branch) {
      const mrs = await call('GET', `/projects/${pid(project)}/merge_requests?state=opened&source_branch=${encodeURIComponent(branch)}`)
      const mr = Array.isArray(mrs) ? mrs[0] : undefined
      return mr && typeof mr.web_url === 'string' ? { url: mr.web_url } : null
    },

    async whoami() {
      const u = await call('GET', '/user')
      return u.username
    },
  }
}
