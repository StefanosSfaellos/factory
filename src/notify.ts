import { parseMarker } from './markers'
import { redact } from './redact'
import type { Advanced } from './tick'
import { jobKey, refLabel } from './hosts'
import type { Job, JobRef } from './types'

export type SlackKind = 'needs-spec-review' | 'mr-opened' | 'blocked'
export type SlackEvent = { ref: JobRef; title: string; kind: SlackKind; url: string; detail?: string }
export type NotifyInfo = { title: string; issueUrl: string; mrUrl?: string; blockedReason?: string }

const HEAD: Record<SlackKind, string> = {
  'needs-spec-review': 'Spec needs your review',
  'mr-opened': 'Merge request opened',
  blocked: 'Job blocked',
}

const MAX_DETAIL = 500

/** Slack's mrkdwn control characters: no live <!channel>, <@U..> or <url|label> from user text. */
export const escapeSlack = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The JSON body for a Slack incoming webhook: `{ text }`, redacted. */
export function slackPayload(ev: SlackEvent, secrets: string[] = [], gitlabHost = 'gitlab.com'): string {
  const where = escapeSlack(refLabel(ev.ref, gitlabHost))
  const lines = [`*${HEAD[ev.kind]}*: ${escapeSlack(ev.title)} (${where})`, escapeSlack(ev.url)]
  if (ev.detail) lines.push(escapeSlack(redact(ev.detail, secrets).slice(0, MAX_DETAIL)))
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
    const key = `${jobKey(a.ref)}#${a.to}`
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
