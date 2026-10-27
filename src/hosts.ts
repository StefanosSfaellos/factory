import type { ForgeKind, JobRef, ListScope, Project } from './types'

// Forge hosts, their tokens, and how a job reference is keyed and shown.
// Pure: hooks/register.ts reads GITHUB_TOKEN, GITLAB_TOKEN, GITLAB_URL and
// FACTORY_TOKENS and hands the strings in.

export const GITHUB_HOST = 'github.com'
export const DEFAULT_GITLAB_URL = 'https://gitlab.com'

/** A lower-case DNS name with at least one dot (no scheme, port, path or user). */
export const HOST_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

/** The lower-case host name of a URL (no scheme, user, port or path). */
export function hostOf(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]*@/, '').replace(/[/:?#].*$/, '').toLowerCase()
}

export type HostToken = { token: string; baseUrl: string }
export type Tokens = {
  /** The host of GITLAB_URL (default gitlab.com): what `gitlab:group/name` without a host means. */
  gitlabHost: string
  /** Every host with a token: github.com (GitHub) and each GitLab host. */
  hosts: Record<string, HostToken>
  /** Bad FACTORY_TOKENS entries; never contain a token. */
  errors: string[]
  /** Every token value, plus the text of every bad FACTORY_TOKENS entry (it may hold a token). */
  secrets: string[]
  /** The error for a repo or issue whose host has no token. */
  missing: (kind: ForgeKind, host: string) => string
}

/**
 * GITHUB_TOKEN is github.com's, GITLAB_TOKEN is GITLAB_URL's host's, and
 * FACTORY_TOKENS (`host=token,host=token`) adds hosts and overrides both per host.
 */
export function resolveTokens(env: { github?: string; gitlab?: string; gitlabUrl?: string; factory?: string }): Tokens {
  const gitlabUrl = (env.gitlabUrl ?? '').trim().replace(/\/+$/, '') || DEFAULT_GITLAB_URL
  const gitlabHost = hostOf(gitlabUrl)
  const hosts: Record<string, HostToken> = {}
  const errors: string[] = []
  const secrets: string[] = []
  const base = (host: string) => (host === GITHUB_HOST ? 'https://api.github.com' : host === gitlabHost ? gitlabUrl : `https://${host}`)
  const add = (host: string, token: string) => {
    hosts[host] = { token, baseUrl: base(host) }
    secrets.push(token)
  }
  const github = (env.github ?? '').trim()
  const gitlab = (env.gitlab ?? '').trim()
  if (github) add(GITHUB_HOST, github)
  if (gitlab && gitlabHost) add(gitlabHost, gitlab)

  const entries = (env.factory ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '')
  entries.forEach((entry, i) => {
    const n = i + 1
    const eq = entry.indexOf('=')
    if (eq <= 0) {
      secrets.push(entry, entry.slice(eq + 1).trim())
      errors.push(`FACTORY_TOKENS: entry ${n} is not host=token`)
      return
    }
    const host = entry.slice(0, eq).trim().toLowerCase()
    const token = entry.slice(eq + 1).trim()
    if (!HOST_NAME.test(host)) {
      secrets.push(entry, token)
      errors.push(`FACTORY_TOKENS: entry ${n} does not start with a host name (use host=token, without https://)`)
      return
    }
    if (token === '') {
      errors.push(`FACTORY_TOKENS: entry ${n} (${host}) has no token`)
      return
    }
    add(host, token)
  })

  const missing = (kind: ForgeKind, host: string): string => {
    const entry = `add "${host}=<token>" to FACTORY_TOKENS`
    if (kind === 'github') return `no token for ${host}: set GITHUB_TOKEN or ${entry}`
    if (host === gitlabHost) return `no token for ${host}: set GITLAB_TOKEN or ${entry}`
    return `no token for ${host}: ${entry}`
  }
  return { gitlabHost, hosts, errors, secrets: [...new Set(secrets.filter((s) => s !== ''))], missing }
}

/** Hosts the builder gate treats as the forge: GitHub's, the GITLAB_URL host, every token host and every repo host. */
export function forgeHostsOf(tokens: Pick<Tokens, 'gitlabHost' | 'hosts'>, projects: Pick<Project, 'host'>[]): string[] {
  const all = [GITHUB_HOST, 'api.github.com', 'uploads.github.com', tokens.gitlabHost, ...Object.keys(tokens.hosts), ...projects.map((p) => p.host)]
  return [...new Set(all.filter((h) => h !== ''))]
}

// ---------------------------------------------------------------------------
// Repo entries and issue paths

const USAGE = 'use github:owner/name, github:owner/*, gitlab:group/name, gitlab:<host>/group/name or gitlab:<host>/group/*'

/**
 * Reads the path of a `github:`/`gitlab:` entry or issue reference. A first segment
 * containing a dot is a host; without one, GitHub means github.com and GitLab the
 * GITLAB_URL host. A trailing `*` is a wildcard when `wildcard` allows it.
 */
export function parsePath(
  forge: ForgeKind,
  path: string,
  gitlabHost: string,
  wildcard: boolean,
): { host: string; project: string; scope?: ListScope } | { error: string } {
  const segs = path.split('/')
  if (segs.some((s) => s === '' || /[\s#:]/.test(s))) return { error: USAGE }
  let host = forge === 'github' ? GITHUB_HOST : gitlabHost
  if (segs[0].includes('.')) {
    host = segs.shift()!.toLowerCase()
    if (!HOST_NAME.test(host)) return { error: `"${host}" is not a host name` }
  }
  if (forge === 'github' && host !== GITHUB_HOST) return { error: `GitHub entries are on ${GITHUB_HOST} only` }
  if (forge === 'gitlab' && host === GITHUB_HOST) return { error: `${GITHUB_HOST} is GitHub; use github:owner/name` }
  if (segs.length === 0) return { error: USAGE }
  const project = segs.join('/')
  if (segs[segs.length - 1] === '*') {
    const prefix = segs.slice(0, -1)
    if (!wildcard || prefix.some((s) => s.includes('*'))) return { error: USAGE }
    if (prefix.length === 0) return { host, project, scope: { kind: 'all' } }
    if (forge === 'github' && prefix.length !== 1) return { error: USAGE }
    return { host, project, scope: { kind: 'group', path: prefix.join('/') } }
  }
  if (segs.some((s) => s.includes('*'))) return { error: USAGE }
  if (forge === 'github' ? segs.length !== 2 : segs.length < 2) return { error: USAGE }
  return { host, project }
}

/** Reads the plugin option `repos`; `gitlabHost` is what a GitLab entry without a host means. */
export function parseRepoList(list: string, gitlabHost: string): { projects: Project[]; errors: string[] } {
  const projects: Project[] = []
  const errors: string[] = []
  const seen = new Set<string>()
  for (const raw of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(github|gitlab):(.+)$/.exec(raw)
    const r = m ? parsePath(m[1] as ForgeKind, m[2], gitlabHost, true) : { error: USAGE }
    if ('error' in r) { errors.push(`bad repo "${raw}" (${r.error})`); continue }
    const p: Project = { forge: m![1] as ForgeKind, host: r.host, project: r.project }
    if (r.scope) p.scope = r.scope
    const key = `${p.forge}:${p.host}/${p.project}`
    if (seen.has(key)) continue
    seen.add(key)
    projects.push(p)
  }
  return { projects, errors }
}

// ---------------------------------------------------------------------------
// Keys and labels

/**
 * A job's identity: `github:owner/name#42` or `gitlab:<host>/group/name#42`. GitLab keys
 * always name the host, so two hosts never share a key; every key is a valid full issue
 * reference.
 */
export const jobKey = (r: JobRef) => (r.forge === 'github' ? `github:${r.project}#${r.issue}` : `gitlab:${r.host}/${r.project}#${r.issue}`)

export const sameRef = (a: JobRef, b: JobRef) => a.forge === b.forge && a.host === b.host && a.project === b.project && a.issue === b.issue

/**
 * How a repo entry is shown: GitHub without its host; GitLab without its host only when
 * the host is the GITLAB_URL host (which is what a GitLab reference without a host means),
 * so every label reads back as the same entry.
 */
export function entryLabel(p: Pick<Project, 'forge' | 'host' | 'project'>, gitlabHost: string): string {
  if (p.forge === 'github' || p.host === gitlabHost) return `${p.forge}:${p.project}`
  return `${p.forge}:${p.host}/${p.project}`
}

/** How a job is shown to people: `gitlab:group/name#42` on the GITLAB_URL host, `gitlab:<host>/group/name#42` elsewhere. */
export const refLabel = (r: JobRef, gitlabHost: string) => `${entryLabel(r, gitlabHost)}#${r.issue}`
