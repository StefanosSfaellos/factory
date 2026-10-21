import type { Role } from './config'
import { STATIONS } from './types'
import type { Job, Station, Verdict } from './types'
const PREFIX = 'factory::'

export function stationOf(job: Job): { station: Station } | { invalid: string } {
  const found = job.labels.filter((l) => l.startsWith(PREFIX) && l !== 'factory::spec-approved')
  if (found.length === 0) return { invalid: 'no factory:: station label found' }
  if (found.length > 1) return { invalid: `multiple station labels found: ${found.join(', ')}` }
  const name = found[0].slice(PREFIX.length)
  if (!(STATIONS as readonly string[]).includes(name)) return { invalid: `unknown station label: ${found[0]}` }
  return { station: name as Station }
}

export type MachineEvent =
  | { kind: 'picked' }
  | { kind: 'artifact-posted' }
  | { kind: 'spec-decision'; approve: boolean; notes?: string }
  | { kind: 'build-done' }
  | { kind: 'verify'; passed: boolean }
  | { kind: 'verdicts'; verdicts: Verdict[] }
  | { kind: 'mr-opened' }
  | { kind: 'error'; message: string; retried: boolean }

type Ctx = { fixLoops: number; maxFixLoops: number; requiredReviewers: Role[] }
type Out = { station: Station; fixLoops: number; reason?: string }

function failLoop(ctx: Ctx, why: string): Out {
  const loops = ctx.fixLoops + 1
  // R27: maxFixLoops is the number of loops back to build; the next failure blocks.
  if (loops > ctx.maxFixLoops) {
    return { station: 'blocked', fixLoops: loops, reason: `fix loop limit reached (${loops}/${ctx.maxFixLoops}): ${why}` }
  }
  return { station: 'build', fixLoops: loops, reason: why }
}

export function next(station: Station, ev: MachineEvent, ctx: Ctx): Out {
  const stay: Out = { station, fixLoops: ctx.fixLoops }
  if (ev.kind === 'error') {
    return ev.retried
      ? { station: 'blocked', fixLoops: ctx.fixLoops, reason: `error after retry: ${ev.message}` }
      : stay
  }
  const go = (s: Station): Out => ({ station: s, fixLoops: ctx.fixLoops })
  switch (station) {
    case 'ready': return ev.kind === 'picked' ? go('spec') : stay
    case 'spec': return ev.kind === 'artifact-posted' ? go('awaiting-spec') : stay
    case 'awaiting-spec':
      return ev.kind === 'spec-decision' ? go(ev.approve ? 'design' : 'spec') : stay
    case 'design': return ev.kind === 'artifact-posted' ? go('plan') : stay
    case 'plan': return ev.kind === 'artifact-posted' ? go('build') : stay
    case 'build': return ev.kind === 'build-done' ? go('verify') : stay
    case 'verify':
      if (ev.kind !== 'verify') return stay
      return ev.passed ? go('review') : failLoop(ctx, 'verify failed')
    case 'review': {
      if (ev.kind !== 'verdicts') return stay
      const failed = ev.verdicts.filter((x) => !x.pass)
      if (failed.length > 0) return failLoop(ctx, `review failed: ${failed.map((x) => x.role).join(', ')}`)
      const have = new Set(ev.verdicts.map((x) => x.role))
      const missing = ctx.requiredReviewers.filter((r) => !have.has(r))
      if (missing.length > 0) return { ...stay, reason: `waiting for verdicts: ${missing.join(', ')}` }
      return go('approve')
    }
    case 'approve': return ev.kind === 'mr-opened' ? go('mr-open') : stay
    default: return stay
  }
}

function firstLine(body: string): string {
  return body.split('\n', 1)[0].trim()
}

const SPEC_MARKER = /^<!-- factory:spec(\s|-->)/

export function specDecision(
  job: Job,
): { approve: true } | { approve: false; notes: string } | { none: true } | { invalid: string } {
  if (job.labels.includes('factory::spec-approved')) return { approve: true }
  const t = (s: string) => Date.parse(s)
  let specAt = -Infinity
  for (const c of job.comments) {
    if (SPEC_MARKER.test(c.body.trimStart())) specAt = Math.max(specAt, t(c.createdAt))
  }
  let best: { at: number; body: string } | null = null
  for (const c of job.comments) {
    const body = c.body.trim()
    if (c.trusted === false) continue
    if (!/^\/(approve|revise)(\s|$)/.test(body)) continue
    const at = t(c.createdAt)
    if (!(at > specAt)) continue
    if (!best || at >= best.at) best = { at, body }
  }
  if (!best) return { none: true }
  if (/^\/approve(\s|$)/.test(best.body)) return { approve: true }
  const notes = best.body.slice('/revise'.length).trim()
  if (!notes) return { invalid: '/revise requires notes, e.g. "/revise add error handling"' }
  return { approve: false, notes }
}

const VERDICT_MARKER = /^<!-- factory:verdict(\s|-->)/
const REPORT_MARKER = /^<!-- factory:test-report(\s|-->)/

export function fixLoopsOf(job: Job): number {
  let n = 0
  const rounds = new Set<string>()
  for (const c of job.comments) {
    const line = firstLine(c.body)
    if (VERDICT_MARKER.test(line) && /\bpass=false\b/.test(line)) {
      const m = /\bround=(\S+)/.exec(line)
      if (m) rounds.add(m[1])
      else n++
    } else if (REPORT_MARKER.test(line) && /\bpassed=false\b/.test(line)) n++
  }
  return n + rounds.size
}
