import type { Reviewer, Role, RepoConfig } from './config'
import type { Forge } from './forge/types'
import { fixLoopsOf, next, specDecision, stationOf, type MachineEvent } from './machine'
import { findLatest, marker, parseMarker, parseVerdict, verdictComment } from './markers'
import { mrBody, promptFor } from './prompts'
import { redact } from './redact'
import type { Comment, Job, JobRef, Station, Verdict } from './types'
import { verify } from './verify'
import { runAgent, type SpawnFn } from './agents'
import { branchName, ensureCheckout, workDir, type RunFn } from './worktree'

// Station runner: `advance` performs one station step for one job.
// State-write order: every comment is posted first, the label changes last.
// Errors thrown by a station's work (agent failures included) are retried once
// within the same advance; a second failure blocks the job. Forge errors while
// posting the results or relabelling propagate to the caller with the label
// unchanged; the next advance finds the posted marker and only relabels.

export type Deps = {
  forge: Forge
  run: RunFn
  spawn: SpawnFn
  pluginRoot: string
  workRoot: string
  secrets: string[]
  workerId: string
  now: () => number
  onProgress: (job: JobRef, text: string) => void
  loadConfig: (ref: JobRef) => Promise<{ ok: true; config: RepoConfig } | { ok: false; error: string }>
  /** Writes a text file (used for `<worktree>/.factory/spec.md` and `.git/info/exclude`). */
  writeFile: (path: string, text: string) => Promise<void>
}

export type AdvanceResult = { from: Station; to: Station; needsHuman: boolean }

type Outcome = { posts: string[]; event: MachineEvent; failed?: Verdict[] }

const HUMAN: Station[] = ['awaiting-spec', 'mr-open', 'blocked']
const REVIEWER_ROLE: Record<Reviewer, Role> = { code: 'code-reviewer', security: 'security-reviewer', ux: 'ux-reviewer' }
const COMMAND = /^\/(approve|revise)(\s|$)/
const IDLE: Station[] = ['mr-open', 'done', 'blocked']

const at = (c: Comment) => Date.parse(c.createdAt)
const textOf = (c: Comment | undefined): string | undefined => {
  if (!c) return undefined
  const nl = c.body.indexOf('\n')
  return nl < 0 ? '' : c.body.slice(nl + 1).trim()
}
const firstLine = (s: string) => s.trim().split('\n', 1)[0].trim()
const afterFirstLine = (s: string) => {
  const t = s.trim()
  const nl = t.indexOf('\n')
  return nl < 0 ? '' : t.slice(nl + 1).trim()
}
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Drops marker comments not written by the factory itself (forged state). */
function trustedView(job: Job, me: string): Job {
  const comments = job.comments.filter((c) => !c.body.trimStart().startsWith('<!-- factory:') || c.author === me)
  return { ...job, comments }
}

/**
 * True when this station's own marker is already the newest state-bearing
 * comment (no newer factory marker and no newer /approve or /revise): the
 * station's work was posted but the relabel did not happen.
 */
function alreadyPosted(job: Job, kind: string): boolean {
  let latest: Comment | undefined
  let cmdAt = -Infinity
  for (const c of job.comments) {
    if (c.trusted !== false && COMMAND.test(c.body.trim())) cmdAt = Math.max(cmdAt, at(c))
    const p = parseMarker(c.body)
    if (!p || p.kind === 'lease') continue
    if (!latest || at(c) >= at(latest)) latest = c
  }
  return !!latest && parseMarker(latest.body)?.kind === kind && at(latest) > cmdAt
}

function failedVerdictsOfLatestRound(job: Job): { verdicts: Verdict[]; at: number } {
  let round: string | undefined
  let when = -Infinity
  for (const c of job.comments) {
    const p = parseMarker(c.body)
    if (p?.kind === 'verdict' && p.attrs.pass === 'false' && at(c) >= when) { when = at(c); round = p.attrs.round }
  }
  const verdicts = job.comments
    .filter((c) => { const p = parseMarker(c.body); return p?.kind === 'verdict' && p.attrs.pass === 'false' && p.attrs.round === round })
    .map((c) => parseVerdict(c))
    .filter((v): v is Verdict => v !== null)
  return { verdicts, at: when }
}

const formatVerdicts = (vs: Verdict[]) =>
  vs.map((v) => `### ${v.role}: ${v.pass ? 'pass' : 'fail'}\n${v.findings.trim() || '- none'}`).join('\n\n')

function latestVerdicts(job: Job): Verdict[] {
  const byRole = new Map<string, Verdict>()
  for (const c of [...job.comments].sort((a, b) => at(a) - at(b))) {
    const v = parseVerdict(c)
    if (v) byRole.set(v.role, v)
  }
  return [...byRole.values()]
}

export async function advance(ref: JobRef, deps: Deps): Promise<AdvanceResult> {
  const { forge } = deps
  const me = await forge.whoami()
  const job = trustedView(await forge.getJob(ref), me)
  const cloneUrl = forge.cloneUrl(ref.project)
  const secrets = [...deps.secrets, cloneUrl]
  const clean = (t: string) => redact(t, secrets)

  const commit = async (from: Station, to: Station, posts: string[]): Promise<AdvanceResult> => {
    for (const p of posts) await forge.comment(ref, clean(p))
    if (to !== from || posts.length > 0) await forge.setStation(ref, to)
    return { from, to, needsHuman: HUMAN.includes(to) }
  }
  const block = (from: Station, why: string, attrs: Record<string, string> = { station: from }) =>
    commit(from, 'blocked', [`${marker('blocked', attrs)}\n${why}`])

  const st = stationOf(job)
  if ('invalid' in st) {
    return block('blocked', `The factory cannot tell which station this issue is at: ${st.invalid}. Leave exactly one \`factory::<station>\` label.`, {})
  }
  const from = st.station
  if (IDLE.includes(from)) return { from, to: from, needsHuman: from !== 'done' }
  if (from === 'ready') return commit(from, 'spec', [])

  if (from === 'awaiting-spec') {
    const d = specDecision(job)
    if ('none' in d) return { from, to: from, needsHuman: true }
    if ('invalid' in d) return block(from, d.invalid)
    return commit(from, d.approve ? 'design' : 'spec', [])
  }

  const loaded = await deps.loadConfig(ref)
  if (!loaded.ok) {
    return block(from, `This repository has no usable \`.factory.yml\`: ${loaded.error}\n\nAdd a \`.factory.yml\` at the repository root (at least \`forge:\` and \`test:\`), then relabel the issue \`factory::${from}\`.`)
  }
  const cfg = loaded.config
  const ctx = {
    fixLoops: fixLoopsOf(job),
    maxFixLoops: cfg.limits.fixLoops,
    requiredReviewers: cfg.reviewers.map((r) => REVIEWER_ROLE[r]),
  }

  const dir = workDir(deps.workRoot, ref)
  const branch = branchName(ref, job.title, cfg.branchPrefix)
  const jobId = `${ref.forge}:${ref.project}#${ref.issue}`
  const art = (kind: string) => textOf(findLatest(job.comments, kind))

  const checkout = async (): Promise<string> => {
    const base = await forge.defaultBranch(ref.project)
    await ensureCheckout(deps.run, { dir, cloneUrl, branch, base, secrets: deps.secrets })
    return base
  }
  const agent = async (role: Role, artifacts: Record<string, string>): Promise<string> => {
    const r = await runAgent(deps.spawn, {
      role, prompt: promptFor(from, role, job, artifacts), cfg, pluginRoot: deps.pluginRoot, job: jobId, worktree: dir,
      onProgress: (t) => deps.onProgress(ref, clean(t)),
    })
    if (!r.ok) throw new Error(r.error ?? `${role} agent failed`)
    return r.output.trim()
  }
  const runOk = async (argv: string[], what: string) => {
    const r = await deps.run(argv, {})
    if (r.exitCode !== 0) throw new Error(clean(`${what} failed (exit ${r.exitCode}): ${`${r.stderr}\n${r.stdout}`.trim()}`))
    return r
  }

  const base = { spec: art('spec') ?? '', design: art('design') ?? '', plan: art('plan') ?? '' }

  const step = async (): Promise<Outcome> => {
    switch (from) {
      case 'spec': case 'design': case 'plan': {
        await checkout()
        const role: Role = from === 'spec' ? 'spec-writer' : from === 'design' ? 'designer' : 'planner'
        const a: Record<string, string> = { ...base }
        const d = from === 'spec' ? specDecision(job) : null
        if (d && 'notes' in d) { a.notes = d.notes; a.previousSpec = base.spec }
        const out = await agent(role, a)
        return { posts: [`${marker(from, {})}\n${out}`], event: { kind: 'artifact-posted' } }
      }
      case 'build': {
        await checkout()
        const a: Record<string, string> = { design: base.design, plan: base.plan }
        if (ctx.fixLoops > 0) {
          const report = findLatest(job.comments, 'test-report')
          const failed = failedVerdictsOfLatestRound(job)
          const reportFailed = report && parseMarker(report.body)?.attrs.passed === 'false'
          if (reportFailed && at(report) > failed.at) a.report = textOf(report) ?? ''
          else if (failed.verdicts.length > 0) a.findings = formatVerdicts(failed.verdicts)
        }
        await runOk(['mkdir', '-p', `${dir}/.factory`], 'mkdir .factory')
        await deps.writeFile(`${dir}/.factory/spec.md`, base.spec)
        const excludePath = `${dir}/.git/info/exclude`
        const existing = (await deps.run(['cat', excludePath], {})).stdout
        if (!existing.split('\n').some((l) => l.trim() === '.factory/')) {
          await deps.writeFile(excludePath, `${existing}${existing === '' || existing.endsWith('\n') ? '' : '\n'}.factory/\n`)
        }
        const out = await agent('builder', a)
        const lines = out.split('\n').map((l) => l.trim()).filter((l) => l !== '')
        if (lines[lines.length - 1] !== 'BUILD-DONE') throw new Error(`builder did not finish (no BUILD-DONE): ${lines.slice(-5).join(' / ')}`)
        await runOk(['git', '-C', dir, 'push', '-u', 'origin', branch], 'git push')
        return { posts: [], event: { kind: 'build-done' } }
      }
      case 'verify': {
        const r = await verify(deps.run, { cloneUrl, branch, scratchDir: `${dir}.verify`, cfg, secrets: deps.secrets })
        return { posts: [r.report], event: { kind: 'verify', passed: r.passed } }
      }
      case 'review': {
        const baseBranch = await checkout()
        const a = { ...base, report: art('test-report') ?? '', base: baseBranch }
        const verdicts = await Promise.all(ctx.requiredReviewers.map(async (role): Promise<Verdict> => {
          const out = await agent(role, a)
          const m = /^VERDICT:\s*(pass|fail)$/i.exec(firstLine(out))
          if (!m) throw new Error(`${role} output did not start with "VERDICT: pass|fail": ${firstLine(out).slice(0, 200)}`)
          return { role, pass: m[1].toLowerCase() === 'pass', findings: afterFirstLine(out) }
        }))
        return {
          posts: verdicts.map((v) => verdictComment(v, ctx.fixLoops)),
          event: { kind: 'verdicts', verdicts },
          failed: verdicts.filter((v) => !v.pass),
        }
      }
      case 'approve': {
        await checkout()
        const verdicts = formatVerdicts(latestVerdicts(job))
        const report = art('test-report') ?? ''
        const out = await agent('approver', { spec: base.spec, report, verdicts })
        const head = firstLine(out)
        const rej = /^REJECT:\s*(.*)$/.exec(head)
        if (rej) {
          const v: Verdict = { role: 'approver', pass: false, findings: [`- ${rej[1].trim() || 'rejected'}`, afterFirstLine(out)].filter(Boolean).join('\n\n') }
          return { posts: [verdictComment(v, ctx.fixLoops)], event: { kind: 'verdicts', verdicts: [v] }, failed: [v] }
        }
        if (head !== 'APPROVE') throw new Error(`approver output did not start with APPROVE or REJECT: ${head.slice(0, 200)}`)
        const summary = afterFirstLine(out)
        const body = clean(mrBody(job, { summary, ...base, report, verdicts }))
        const mr = await forge.openMR(ref, branch, `${job.title} (#${ref.issue})`, body)
        return { posts: [`${marker('approval', { mr: mr.url })}\n${summary}`], event: { kind: 'mr-opened' } }
      }
      default:
        return { posts: [], event: { kind: 'picked' } }
    }
  }

  // Idempotent re-entry: the artifact is already posted, only the relabel is missing.
  const kindOf: Partial<Record<Station, string>> = { spec: 'spec', design: 'design', plan: 'plan', approve: 'approval' }
  const kind = kindOf[from]
  if (kind && alreadyPosted(job, kind)) {
    const ev: MachineEvent = from === 'approve' ? { kind: 'mr-opened' } : { kind: 'artifact-posted' }
    return commit(from, next(from, ev, ctx).station, [])
  }

  let outcome: Outcome
  try {
    outcome = await step()
  } catch (first) {
    try {
      outcome = await step()
    } catch (second) {
      const to = next(from, { kind: 'error', message: errText(second), retried: true }, ctx).station
      return commit(from, to, [`${marker('blocked', { station: from })}\nStation \`${from}\` failed twice (retried once).\n\nFirst error: ${errText(first)}\n\nError: ${errText(second)}`])
    }
  }

  // The approver's REJECT is a failed review round: reuse the review transition.
  const machineStation: Station = from === 'approve' && outcome.event.kind === 'verdicts' ? 'review' : from
  const out = next(machineStation, outcome.event, ctx)
  const posts = [...outcome.posts]
  if (out.station === 'blocked') {
    const findings = outcome.failed && outcome.failed.length > 0 ? `\n\n${formatVerdicts(outcome.failed)}` : ''
    posts.push(`${marker('blocked', { station: from })}\n${out.reason ?? 'blocked'}${findings}`)
  }
  return commit(from, out.station, posts)
}
