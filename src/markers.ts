import type { Comment, Verdict } from './types'
import type { Role } from './config'

export function marker(kind: string, attrs: Record<string, string>): string {
  const parts = [`<!-- factory:${kind}`]
  for (const [k, v] of Object.entries(attrs)) {
    if (/\s/.test(v) || /\s/.test(k) || k.includes('=')) throw new Error(`invalid marker attribute ${k}=${v}`)
    parts.push(`${k}=${v}`)
  }
  return parts.join(' ') + ' -->'
}

const FIRST = /^<!-- factory:([a-z-]+)((?:\s+[^\s=]+=\S*)*)\s*-->$/

export function parseMarker(body: string): { kind: string; attrs: Record<string, string> } | null {
  const first = body.split('\n')[0].trim()
  const m = FIRST.exec(first)
  if (!m) return null
  const attrs: Record<string, string> = {}
  for (const pair of m[2].trim().split(/\s+/).filter(Boolean)) {
    const i = pair.indexOf('=')
    attrs[pair.slice(0, i)] = pair.slice(i + 1)
  }
  return { kind: m[1], attrs }
}

export function findLatest(comments: Comment[], kind: string): Comment | undefined {
  let best: Comment | undefined
  for (const c of comments) {
    if (parseMarker(c.body)?.kind !== kind) continue
    if (!best || Date.parse(c.createdAt) >= Date.parse(best.createdAt)) best = c
  }
  return best
}

export function verdictComment(v: Verdict, round: number, sha?: string): string {
  const attrs: Record<string, string> = { role: v.role, pass: String(v.pass), round: String(round) }
  if (sha) attrs.sha = sha
  const head = marker('verdict', attrs)
  return v.findings === '' ? head : `${head}\n${v.findings}`
}

export function parseVerdict(c: Comment): Verdict | null {
  const p = parseMarker(c.body)
  if (!p || p.kind !== 'verdict') return null
  const { role, pass } = p.attrs
  if (!role || (pass !== 'true' && pass !== 'false')) return null
  const nl = c.body.indexOf('\n')
  return { role: role as Role, pass: pass === 'true', findings: nl < 0 ? '' : c.body.slice(nl + 1) }
}
