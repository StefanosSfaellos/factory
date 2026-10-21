import type { Forge } from '../forge/types'
import { fixLoopsOf, specDecision, stationOf } from '../machine'
import { parseMarker } from '../markers'
import { redact } from '../redact'
import { ownMarkersOnly, type Advanced, type Project } from '../tick'
import type { Comment, Job, JobRef, Station } from '../types'

// What the session UI shows of a job, and the plain functions that build it.
// Pure: forges come in as values, nothing here touches `$`.

export type JobView = {
  ref: JobRef
  title: string
  station: Station
  /** How long the job had been at its station when the view was read from the forge. */
  sinceMs: number
  fixLoops: number
  /** The last line of the agent working the job in this session, while its station runs. */
  progress?: string
  needsHuman: boolean
  links: { issue: string; mr?: string }
}

/** The job whose station runs in this session right now. */
export type Running = { ref: JobRef; station: Station }

/** The job opened in the pane, with its spec and dossier as read from the forge. */
export type Selected = { key: string; spec: string; dossier: string }

/** `<forge>:<project>#<issue>`: a job's identity in the UI, and its full issue reference. */
export const jobKey = (r: JobRef) => `${r.forge}:${r.project}#${r.issue}`
export const sameRef = (a: JobRef, b: JobRef) => a.forge === b.forge && a.project === b.project && a.issue === b.issue

const at = (c: Comment) => Date.parse(c.createdAt)
const COMMAND = /^\/(approve|revise|retry)(\s|$)/

/** The web URL of an issue, from the project's tokenless clone URL. */
export function issueUrl(publicUrl: string, ref: JobRef): string {
  const base = publicUrl.replace(/\.git$/, '')
  return ref.forge === 'github' ? `${base}/issues/${ref.issue}` : `${base}/-/issues/${ref.issue}`
}

/**
 * A job as the UI shows it. `job.comments` should hold only the factory's own
 * markers (see `ownMarkersOnly`): the newest non-lease marker or human command
 * is when the job reached its station (leases are edited in place all the time).
 */
export function toView(job: Job, opts: { now: number; secrets: string[]; issueUrl: (ref: JobRef) => string }): JobView {
  const st = stationOf(job)
  const station: Station = 'invalid' in st ? 'blocked' : st.station
  let needsHuman = station === 'blocked' || station === 'mr-open'
  if (station === 'awaiting-spec') needsHuman = 'none' in specDecision(job)

  let since = -Infinity
  let mr: string | undefined
  let mrAt = -Infinity
  for (const c of job.comments) {
    const p = parseMarker(c.body)
    if (p?.kind === 'approval' && p.attrs.mr && at(c) >= mrAt) { mr = p.attrs.mr; mrAt = at(c) }
    if ((p && p.kind !== 'lease') || (!p && c.trusted !== false && COMMAND.test(c.body.trim()))) since = Math.max(since, at(c))
  }
  const links: JobView['links'] = { issue: opts.issueUrl(job.ref) }
  if (mr) links.mr = mr
  return {
    ref: job.ref,
    title: redact(job.title, opts.secrets),
    station,
    sinceMs: Number.isFinite(since) ? Math.max(0, opts.now - since) : 0,
    fixLoops: fixLoopsOf(job),
    needsHuman,
    links,
  }
}

const afterFirstLine = (body: string) => {
  const nl = body.indexOf('\n')
  return nl < 0 ? '' : body.slice(nl + 1).trim()
}

function latestOf(job: Job, kind: string): Comment | undefined {
  let best: Comment | undefined
  for (const c of job.comments) {
    if (parseMarker(c.body)?.kind === kind && (!best || at(c) >= at(best))) best = c
  }
  return best
}

/** The text of the newest spec marker comment, without its marker line; '' when there is none. */
export function latestSpec(job: Job): string {
  const c = latestOf(job, 'spec')
  return c ? afterFirstLine(c.body) : ''
}

/** The job's dossier as Markdown: the newest artifact of each kind, and the latest round of verdicts. */
export function dossierMarkdown(job: Job): string {
  const parts: string[] = []
  for (const kind of ['spec', 'design', 'plan', 'test-report']) {
    const c = latestOf(job, kind)
    if (c) parts.push(`### ${kind}\n\n${afterFirstLine(c.body) || '(empty)'}`)
  }
  const verdicts = job.comments.filter((c) => parseMarker(c.body)?.kind === 'verdict')
  const round = verdicts.reduce<string | undefined>((r, c) => {
    const n = parseMarker(c.body)!.attrs.round
    return r === undefined || Number(n) > Number(r) ? n : r
  }, undefined)
  for (const c of verdicts.filter((v) => parseMarker(v.body)!.attrs.round === round)) {
    const a = parseMarker(c.body)!.attrs
    parts.push(`### verdict: ${a.role} ${a.pass === 'true' ? 'pass' : 'fail'}\n\n${afterFirstLine(c.body) || '(no findings)'}`)
  }
  for (const kind of ['approval', 'blocked']) {
    const c = latestOf(job, kind)
    if (c) parts.push(`### ${kind}\n\n${afterFirstLine(c.body) || '(empty)'}`)
  }
  return parts.length ? parts.join('\n\n') : '_Nothing posted yet._'
}

type Group = { label: (n: number) => string; stations: Station[] }
const GROUPS: Group[] = [
  { label: (n) => `${n} queued`, stations: ['ready'] },
  { label: (n) => `${n} planning`, stations: ['spec', 'awaiting-spec', 'design', 'plan'] },
  { label: (n) => `${n} building`, stations: ['build', 'verify'] },
  { label: (n) => `${n} in review`, stations: ['review', 'approve'] },
]

/** `Factory · 2 building · 1 in review · 1 needs you`; zero groups left out; `Factory · idle` with nothing on the line. */
export function bandText(jobs: JobView[]): string {
  const parts: string[] = []
  for (const g of GROUPS) {
    const n = jobs.filter((j) => !j.needsHuman && g.stations.includes(j.station)).length
    if (n > 0) parts.push(g.label(n))
  }
  const human = jobs.filter((j) => j.needsHuman).length
  if (human > 0) parts.push(`${human} ${human === 1 ? 'needs' : 'need'} you`)
  return parts.length ? `Factory · ${parts.join(' · ')}` : 'Factory · idle'
}

/** Fresh views from the forge keep the live progress line of a job still at the same station. */
export function mergeProgress(next: JobView[], prev: JobView[]): JobView[] {
  return next.map((v) => {
    const old = prev.find((p) => sameRef(p.ref, v.ref) && p.station === v.station)
    return old?.progress !== undefined ? { ...v, progress: old.progress } : v
  })
}

/** The toast for one tick step: a move that needs a human, or that blocked; null otherwise. */
export function transitionToast(a: Advanced): string | null {
  if (a.from === a.to) return null
  if (a.to === 'blocked') return `factory #${a.ref.issue} blocked at ${a.from}`
  if (a.needsHuman) return `factory #${a.ref.issue} needs you: ${a.to}`
  return null
}

/** The spinner suffix while a station runs in this session: ` · factory #42 build`. */
export function spinnerSuffix(r: { issue: number; station: Station } | null): string {
  return r ? ` · factory #${r.issue} ${r.station}` : ''
}

/** Reads every configured project's jobs from its forge; a project that fails is reported, not thrown. */
export async function loadViews(
  projects: Project[],
  forgeFor: (kind: Project['forge']) => { forge: Forge } | { error: string },
  opts: { now: number; secrets: string[] },
): Promise<{ views: JobView[]; errors: string[] }> {
  const views: JobView[] = []
  const errors: string[] = []
  const clean = (t: string) => redact(t, opts.secrets)
  for (const p of projects) {
    const f = forgeFor(p.forge)
    if ('error' in f) { errors.push(clean(`${p.forge}:${p.project}: ${f.error}`)); continue }
    try {
      const me = await f.forge.whoami()
      const url = f.forge.publicUrl(p.project)
      for (const ref of await f.forge.listJobs(p.project)) {
        const raw = await f.forge.getJob(ref)
        const job = { ...raw, comments: ownMarkersOnly(raw.comments, me) }
        views.push(toView(job, { now: opts.now, secrets: opts.secrets, issueUrl: (r) => issueUrl(url, r) }))
      }
    } catch (e) {
      errors.push(clean(`${p.forge}:${p.project}: ${e instanceof Error ? e.message : String(e)}`))
    }
  }
  return { views, errors }
}
