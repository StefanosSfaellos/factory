import { parseMarker } from './markers'
import { redact } from './redact'
import type { Advanced } from './tick'
import type { Job, JobRef } from './types'

export type SlackKind = 'needs-spec-review' | 'mr-opened' | 'blocked'
export type SlackEvent = { ref: JobRef; title: string; kind: SlackKind; url: string; detail?: string }
export type NotifyInfo = { title: string; issueUrl: string; mrUrl?: string; blockedReason?: string }

const HEAD: Record<SlackKind, string> = {
  'needs-spec-review': 'Spec needs your review',
  'mr-opened': 'Merge request opened',
  blocked: 'Job blocked',
}

/** The JSON body for a Slack incoming webhook: `{ text }`, redacted. */
export function slackPayload(ev: SlackEvent, secrets: string[] = []): string {
  const where = `${ev.ref.forge}:${ev.ref.project}#${ev.ref.issue}`
  const lines = [`*${HEAD[ev.kind]}*: ${ev.title} (${where})`, ev.url]
  if (ev.detail) lines.push(ev.detail)
  return JSON.stringify({ text: redact(lines.join('\n'), secrets) })
}

const KIND: Partial<Record<Advanced['to'], SlackKind>> = { 'awaiting-spec': 'needs-spec-review', 'mr-open': 'mr-opened', blocked: 'blocked' }

/**
 * The Slack events for one tick result: one per job#to, for the three stations that
 * need a person. A job whose info cannot be read is dropped, the others still go.
 */
export async function slackEvents(advanced: Advanced[], info: (ref: JobRef) => Promise<NotifyInfo>): Promise<SlackEvent[]> {
  const seen = new Set<string>()
  const out: SlackEvent[] = []
  for (const a of advanced) {
    const kind = KIND[a.to]
    if (!kind) continue
    const key = `${a.ref.forge}:${a.ref.project}#${a.ref.issue}#${a.to}`
    if (seen.has(key)) continue
    seen.add(key)
    try {
      const i = await info(a.ref)
      const ev: SlackEvent = { ref: a.ref, title: i.title, kind, url: kind === 'mr-opened' ? i.mrUrl ?? i.issueUrl : i.issueUrl }
      if (kind === 'blocked' && i.blockedReason) ev.detail = i.blockedReason
      out.push(ev)
    } catch { /* an unreadable job is not announced */ }
  }
  return out
}

/** Title, links and blocked reason of a job whose comments are the factory's own markers. */
export function notifyInfo(job: Job, issueUrl: string): NotifyInfo {
  let mr: { url: string; at: number } | undefined
  let blocked: { text: string; at: number } | undefined
  for (const c of job.comments) {
    const p = parseMarker(c.body)
    const at = Date.parse(c.createdAt)
    if (p?.kind === 'approval' && p.attrs.mr && (!mr || at >= mr.at)) mr = { url: p.attrs.mr, at }
    if (p?.kind === 'blocked' && (!blocked || at >= blocked.at)) blocked = { text: c.body.slice(c.body.indexOf('\n') + 1).trim(), at }
  }
  const info: NotifyInfo = { title: job.title, issueUrl }
  if (mr) info.mrUrl = mr.url
  if (blocked?.text) info.blockedReason = blocked.text
  return info
}
