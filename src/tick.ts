import { parseRepoConfig, type RepoConfig } from './config'
import type { Forge } from './forge/types'
import { decideLease, leaseBody, type LeaseDecision } from './lease'
import { specDecision, stationOf } from './machine'
import { parseMarker } from './markers'
import { redact } from './redact'
import { advance, type Deps } from './stations'
import type { Comment, Job, JobRef, Station } from './types'

// The tick: one pass over the configured projects of one forge. It lists the
// open factory jobs, skips the ones that wait on a human, takes a lease on up
// to `parallel` runnable jobs and advances each leased job station by station
// until it needs a human, ends, blocks or stops moving. Everything here is a
// chain of awaited forge/agent calls; nothing waits on time.

export type Project = { forge: 'github' | 'gitlab'; project: string }
export type Advanced = { ref: JobRef; from: Station; to: Station; needsHuman: boolean }
export type Skipped = { ref: JobRef; reason: string }
export type TickResult = { advanced: Advanced[]; skipped: Skipped[] }
export type TickDeps = Deps & {
  projects: Project[]
  parallel: number
  only?: JobRef[]
  /** Told the station a held job is about to run, and `null` once its steps end (the session UI). */
  onStep?: (ref: JobRef, station: Station | null) => void
}

const RENEW_MS = 5 * 60000
/** Safety stop: a job never takes more steps than this in one tick. */
const MAX_STEPS = 30
const IDLE: Station[] = ['done', 'mr-open', 'blocked']

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))
const sameRef = (a: JobRef, b: JobRef) => a.forge === b.forge && a.project === b.project && a.issue === b.issue

/** Drops factory marker comments not written by the factory's own account (forged state). */
export function ownMarkersOnly(comments: Comment[], me: string): Comment[] {
  return comments.filter((c) => !c.body.trimStart().startsWith('<!-- factory:') || c.author === me)
}

/** Reads and validates `.factory.yml` from the project's default branch. */
export async function loadRepoConfig(forge: Forge, ref: JobRef): Promise<{ ok: true; config: RepoConfig } | { ok: false; error: string }> {
  const branch = await forge.defaultBranch(ref.project)
  const text = await forge.readFile(ref.project, '.factory.yml', branch)
  if (text === null) return { ok: false, error: `no .factory.yml on ${branch}` }
  return parseRepoConfig(text)
}

/** The newest lease comment of this worker (expired ones included), to reuse instead of posting another. */
function newestOwnLease(comments: Comment[], workerId: string): string | undefined {
  let best: Comment | undefined
  for (const c of comments) {
    const p = parseMarker(c.body)
    if (p?.kind !== 'lease' || p.attrs.worker !== workerId) continue
    if (!best || Date.parse(c.createdAt) >= Date.parse(best.createdAt)) best = c
  }
  return best?.id
}

/** Why a job is not runnable now, or null when it is. Invalid labels are runnable: advance blocks them. */
function idleReason(job: Job): string | null {
  const st = stationOf(job)
  if ('invalid' in st) return null
  if (IDLE.includes(st.station)) return `at ${st.station}`
  if (st.station === 'awaiting-spec' && 'none' in specDecision(job)) return 'awaiting spec decision'
  return null
}

export async function tick(deps: TickDeps): Promise<TickResult> {
  const { forge } = deps
  const advanced: Advanced[] = []
  const skipped: Skipped[] = []
  const clean = (t: string) => redact(t, deps.secrets)
  let me: string | undefined
  const whoami = async () => (me ??= await forge.whoami())
  const lease = (minutes?: number) => leaseBody(deps.workerId, deps.now(), minutes)
  /** An expired lease is fair game for any worker. */
  const release = (ref: JobRef, id: string) => forge.editComment(ref, id, lease(0)).catch(() => {})
  const decide = async (ref: JobRef): Promise<{ job: Job; d: LeaseDecision }> => {
    const raw = await forge.getJob(ref)
    const job = { ...raw, comments: ownMarkersOnly(raw.comments, await whoami()) }
    return { job, d: decideLease(job.comments, deps.workerId, deps.now()) }
  }

  // 1. Candidates: open jobs that are not waiting on a human.
  const candidates: JobRef[] = []
  for (const p of deps.projects) {
    let refs: JobRef[]
    try {
      refs = await forge.listJobs(p.project)
    } catch (e) {
      skipped.push({ ref: { forge: p.forge, project: p.project, issue: 0 }, reason: clean(`list failed: ${errText(e)}`) })
      continue
    }
    if (deps.only) refs = refs.filter((r) => deps.only!.some((o) => sameRef(o, r)))
    candidates.push(...refs)
  }

  // 2. Leases, one job at a time, until `parallel` jobs are held.
  const held: { ref: JobRef; leaseId: string; job: Job }[] = []
  for (const ref of candidates) {
    let mine: string | undefined
    try {
      const first = await decide(ref)
      const why = idleReason(first.job)
      if (why) { skipped.push({ ref, reason: why }); continue }
      if (first.d.action === 'back-off') { skipped.push({ ref, reason: `leased by ${first.d.holder}` }); continue }
      if (held.length >= deps.parallel) { skipped.push({ ref, reason: 'parallel limit reached' }); continue }
      const reuse = first.d.action === 'renew' ? first.d.existingId! : newestOwnLease(first.job.comments, deps.workerId)
      if (reuse !== undefined) {
        mine = reuse
        await forge.editComment(ref, mine, lease())
      } else {
        mine = (await forge.comment(ref, lease())).id
      }
      // Re-read: an earlier lease by another worker that raced ours wins.
      const again = await decide(ref)
      if (again.d.action === 'back-off') {
        await release(ref, mine)
        skipped.push({ ref, reason: `leased by ${again.d.holder}` })
        continue
      }
      held.push({ ref, leaseId: again.d.existingId ?? mine, job: again.job })
    } catch (e) {
      if (mine !== undefined) await release(ref, mine)
      skipped.push({ ref, reason: clean(`error: ${errText(e)}`) })
    }
  }

  // 3. Advance every held job concurrently.
  const step = (ref: JobRef, job: Job | null) => {
    if (!deps.onStep) return
    const st = job ? stationOf(job) : null
    try { deps.onStep(ref, st && !('invalid' in st) ? st.station : null) } catch { /* the UI is best-effort */ }
  }
  await Promise.all(held.map(async ({ ref, leaseId, job: first }) => {
    let renewedAt = deps.now()
    const renewals: Promise<void>[] = []
    const renew = () => {
      renewedAt = deps.now()
      renewals.push(forge.editComment(ref, leaseId, lease()).catch(() => {}))
    }
    // Blind renewal from inside a step (agent output, each host command), at most every RENEW_MS.
    const keepAlive = () => { if (deps.now() - renewedAt >= RENEW_MS) renew() }
    const jobDeps: Deps = {
      ...deps,
      spawn: (argv, o) => deps.spawn(argv, { ...o, onLine: (line) => { keepAlive(); o.onLine(line) } }),
      // A host command may run up to its timeout with no output (verify: 10 min): renew first
      // whenever the lease could otherwise age past RENEW_MS before the command ends.
      run: (argv, o) => {
        if (deps.now() - renewedAt + (o.timeoutMs ?? 30000) >= RENEW_MS) renew()
        return deps.run(argv, o)
      },
    }
    try {
      for (let n = 0; n < MAX_STEPS; n++) {
        let job = first
        if (n > 0) {
          // Before every step: re-read, and renew only while the lease is still ours (spec §9).
          const again = await decide(ref)
          if (again.d.action === 'back-off') { skipped.push({ ref, reason: `lease lost to ${again.d.holder}` }); return }
          job = again.job
          renewedAt = deps.now()
          await forge.editComment(ref, leaseId, lease())
        }
        step(ref, job)
        const r = await advance(ref, jobDeps)
        advanced.push({ ref, ...r })
        if (r.needsHuman || r.to === r.from || r.to === 'done' || r.to === 'blocked') break
      }
    } catch (e) {
      skipped.push({ ref, reason: clean(`error: ${errText(e)}`) })
    } finally {
      step(ref, null)
      await Promise.all(renewals)
      await release(ref, leaseId)
    }
  }))

  return { advanced, skipped }
}
