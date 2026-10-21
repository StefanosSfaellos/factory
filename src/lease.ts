import type { Comment } from './types'
import { marker, parseMarker } from './markers'

export type LeaseDecision =
  | { action: 'acquire' | 'renew'; existingId?: string }
  | { action: 'back-off'; holder: string }

export function decideLease(comments: Comment[], me: string, nowMs: number): LeaseDecision {
  const live: { c: Comment; worker: string }[] = []
  for (const c of comments) {
    const p = parseMarker(c.body)
    if (!p || p.kind !== 'lease') continue
    const until = Date.parse(p.attrs.until ?? '')
    if (!p.attrs.worker || Number.isNaN(until) || until <= nowMs) continue
    live.push({ c, worker: p.attrs.worker })
  }
  if (live.length === 0) return { action: 'acquire' }
  live.sort((a, b) => Date.parse(a.c.createdAt) - Date.parse(b.c.createdAt))
  const winner = live[0]
  if (winner.worker === me) return { action: 'renew', existingId: winner.c.id }
  return { action: 'back-off', holder: winner.worker }
}

export function leaseBody(me: string, nowMs: number, minutes = 15): string {
  return marker('lease', { worker: me, until: new Date(nowMs + minutes * 60000).toISOString() })
}
