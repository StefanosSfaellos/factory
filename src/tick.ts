import { parseRepoConfig, type RepoConfig } from './config'
import type { Forge } from './forge/types'
import { decideLease, leaseBody, type LeaseDecision } from './lease'
import { specDecision, stationOf } from './machine'
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
export type TickDeps = Deps & { projects: Project[]; parallel: number; only?: JobRef[] }

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
  const held: { ref: JobRef; leaseId: string }[] = []
  for (const ref of candidates) {
    try {
      const first = await decide(ref)
      const why = idleReason(first.job)
      if (why) { skipped.push({ ref, reason: why }); continue }
      if (first.d.action === 'back-off') { skipped.push({ ref, reason: `leased by ${first.d.holder}` }); continue }
      if (held.length >= deps.parallel) { skipped.push({ ref, reason: 'parallel limit reached' }); continue }
      let mine: string
      if (first.d.action === 'renew') {
        mine = first.d.existingId!
        await forge.editComment(ref, mine, lease())
      } else {
        mine = (await forge.comment(ref, lease())).id
      }
      // Re-read: an earlier lease by another worker that raced ours wins.
      const again = await decide(ref)
      if (again.d.action === 'back-off') {
        await forge.editComment(ref, mine, lease(0))
        skipped.push({ ref, reason: `leased by ${again.d.holder}` })
        continue
      }
      held.push({ ref, leaseId: again.d.existingId ?? mine })
    } catch (e) {
      skipped.push({ ref, reason: clean(`error: ${errText(e)}`) })
    }
  }

  // 3. Advance every held job concurrently.
  await Promise.all(held.map(async ({ ref, leaseId }) => {
    let renewedAt = deps.now()
    const renewals: Promise<void>[] = []
    const renew = () => {
      renewedAt = deps.now()
      renewals.push(forge.editComment(ref, leaseId, lease()).catch(() => {}))
    }
    const jobDeps: Deps = {
      ...deps,
      // Agents stream progress while they work: renew the lease from there too,
      // so a long station never outlives it.
      onProgress: (r, text) => {
        if (deps.now() - renewedAt >= RENEW_MS) renew()
        deps.onProgress(r, text)
      },
    }
    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (step > 0 && deps.now() - renewedAt >= RENEW_MS) {
          const { d } = await decide(ref)
          if (d.action === 'back-off') { skipped.push({ ref, reason: `lease lost to ${d.holder}` }); return }
          renew()
        }
        const r = await advance(ref, jobDeps)
        advanced.push({ ref, ...r })
        if (r.needsHuman || r.to === r.from || r.to === 'done' || r.to === 'blocked') break
      }
    } catch (e) {
      skipped.push({ ref, reason: clean(`error: ${errText(e)}`) })
    } finally {
      await Promise.all(renewals)
      // Release: an expired lease is fair game for any worker.
      await forge.editComment(ref, leaseId, lease(0)).catch(() => {})
    }
  }))

  return { advanced, skipped }
}
