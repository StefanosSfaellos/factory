import type { Reviewer, Role, RepoConfig } from './config'
import type { Forge } from './forge/types'
import { fixLoopsOf, next, specDecision, stationOf, type MachineEvent } from './machine'
import { findLatest, marker, parseMarker, parseVerdict, verdictComment } from './markers'
import { mrBody, promptFor } from './prompts'
import { redact } from './redact'
import type { Comment, Job, JobRef, Station, Verdict } from './types'
import { verify } from './verify'
import { runAgent, type SpawnFn } from './agents'
import { branchName, ensureCheckout, gitArgv, gitNoDir, modDir, prepareWorktree, workDir, type RunFn } from './worktree'

// Station runner: `advance` performs one station step for one job.
// State-write order: every comment is posted first, the label changes last.
// Errors thrown by a station's work (agent failures included) are retried once
// within the same advance; a second failure blocks the job. Forge errors while
// posting the results or relabelling propagate to the caller with the label
// unchanged; the next advance finds the posted marker and only relabels.
// Test reports and verdicts carry the tested commit (`sha=`), so evidence is
// tied to the branch head and re-entry never re-runs verify/review or
// double-counts a fix loop.

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
  /** Forge hosts passed to child agents for the builder's gate (FACTORY_FORGE_HOSTS). */
  forgeHosts?: string[]
  /** Writes a text file (used for `<worktree>/.factory/spec.md` and `.git/info/exclude`). */
  writeFile: (path: string, text: string) => Promise<void>
}

export type AdvanceResult = { from: Station; to: Station; needsHuman: boolean }

type Outcome = { posts: string[]; event: MachineEvent; failed?: Verdict[]; round?: number; approved?: string }

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

type Posted = { c: Comment; attrs: Record<string, string> }
const markersOf = (job: Job, kind: string): Posted[] =>
  job.comments.flatMap((c) => { const p = parseMarker(c.body); return p?.kind === kind ? [{ c, attrs: p.attrs }] : [] })
const newest = (xs: Posted[]): Posted | undefined => xs.reduce<Posted | undefined>((b, x) => (!b || at(x.c) >= at(b.c) ? x : b), undefined)
const toVerdict = (x: Posted) => parseVerdict(x.c)!

/** Verdicts posted after the given test report, by role (latest per role). */
function verdictsAfter(job: Job, report: Posted, roles: Role[]): { byRole: Map<Role, Posted>; round?: string } {
  const byRole = new Map<Role, Posted>()
  const after = markersOf(job, 'verdict').filter((x) => at(x.c) > at(report.c) && roles.includes(x.attrs.role as Role))
  for (const x of after.sort((a, b) => at(a.c) - at(b.c))) byRole.set(x.attrs.role as Role, x)
  return { byRole, round: newest(after)?.attrs.round }
}

/** Deterministic approve gate: a passing report for this head and passing verdicts of the current round. */
function approveGate(job: Job, roles: Role[], round: number, head: string | undefined): { ok: true; verdicts: Verdict[] } | { ok: false; why: string } {
  const report = newest(markersOf(job, 'test-report'))
  if (!report || report.attrs.passed !== 'true') return { ok: false, why: 'the latest test report is missing or failing' }
  const lastFail = newest(markersOf(job, 'verdict').filter((x) => x.attrs.pass === 'false'))
  if (lastFail && at(lastFail.c) >= at(report.c)) return { ok: false, why: 'a failing verdict is newer than the latest passing test report' }
  if (!head) return { ok: false, why: 'missing evidence sha: could not read the branch head' }
  if (!report.attrs.sha) return { ok: false, why: 'missing evidence sha: the latest test report has no sha' }
  if (report.attrs.sha !== head) return { ok: false, why: `the branch head ${head} is not the verified commit ${report.attrs.sha}` }
  const inRound = markersOf(job, 'verdict').filter((x) => x.attrs.round === String(round) && at(x.c) > at(report.c))
  if (inRound.some((x) => x.attrs.pass !== 'true')) return { ok: false, why: `a verdict in round ${round} failed` }
  const verdicts: Verdict[] = []
  for (const role of roles) {
    const all = inRound.filter((x) => x.attrs.role === role)
    if (all.some((x) => !x.attrs.sha)) return { ok: false, why: `missing evidence sha: a ${role} verdict in round ${round} has no sha` }
    const mine = all.filter((x) => x.attrs.sha === head)
    if (mine.length === 0) return { ok: false, why: `no passing ${role} verdict in round ${round} for the verified commit` }
    verdicts.push(toVerdict(newest(mine)!))
  }
  return { ok: true, verdicts }
}

export async function advance(ref: JobRef, deps: Deps): Promise<AdvanceResult> {
  const { forge } = deps
  const me = await forge.whoami()
  const job = trustedView(await forge.getJob(ref), me)
  const cloneUrl = forge.cloneUrl(ref.project)
  const publicUrl = forge.publicUrl(ref.project)
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

  // `dir` is the agents' working directory; `mod` is the mod's own clone (R20). The
  // mod runs commit, push and token-bearing fetch only in `mod`, never in `dir`,
  // whose .git/config the builder controls.
  const dir = workDir(deps.workRoot, ref)
  const mod = modDir(dir)
  const branch = branchName(ref, job.title, cfg.branchPrefix)
  const jobId = `${ref.forge}:${ref.project}#${ref.issue}`
  const art = (kind: string) => textOf(findLatest(job.comments, kind))

  /** Updates the mod clone from the forge and gives the agents a fresh copy of it. */
  const checkout = async (): Promise<string> => {
    const base = await forge.defaultBranch(ref.project)
    await ensureCheckout(deps.run, { dir: mod, cloneUrl, publicUrl, branch, base, secrets: deps.secrets })
    await prepareWorktree(deps.run, { mod, dir, publicUrl })
    return base
  }
  const shaOf = (out: string) => { const m = /^([0-9a-f]{7,64})\b/.exec(out.trim()); return m ? m[1] : undefined }
  const headSha = async () => shaOf((await deps.run(gitArgv(mod, 'rev-parse', 'HEAD'), {})).stdout)
  /** Writes the branch diff and log, computed in the mod clone, for the read-only reviewers and approver (R19). */
  const writeEvidence = async (baseBranch: string, head: string) => {
    const diff = await runOk(gitArgv(mod, 'diff', '--no-ext-diff', '--no-textconv', '--no-color', `origin/${baseBranch}...${head}`), 'git diff')
    const log = await runOk(gitArgv(mod, 'log', '--no-color', '--no-decorate', `origin/${baseBranch}..${head}`), 'git log')
    await runOk(['mkdir', '-p', `${dir}/.factory`], 'mkdir .factory')
    await deps.writeFile(`${dir}/.factory/branch.diff`, diff.stdout)
    await deps.writeFile(`${dir}/.factory/branch.log`, log.stdout)
  }
  const remoteSha = async () => shaOf((await deps.run(gitNoDir('ls-remote', cloneUrl, `refs/heads/${branch}`), {})).stdout)
  const agent = async (role: Role, artifacts: Record<string, string>): Promise<string> => {
    const r = await runAgent(deps.spawn, {
      role, prompt: promptFor(from, role, job, artifacts), cfg, pluginRoot: deps.pluginRoot, job: jobId, worktree: dir, forgeHosts: deps.forgeHosts,
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
        // Bring the builder's commits into the mod clone; everything after happens there.
        await runOk(gitArgv(mod, 'fetch', '--no-tags', dir, '+HEAD:refs/factory/build'), 'git fetch from the builder worktree')
        await runOk(gitArgv(mod, 'checkout', '-B', branch, 'refs/factory/build'), 'git checkout of the built branch')
        // After failed review findings the branch must move; after a failed test report an
        // unchanged branch is fine (verify runs fresh; each failed report counts as a fix loop).
        const lastFail = newest([...markersOf(job, 'test-report').filter((x) => x.attrs.passed === 'false'), ...markersOf(job, 'verdict').filter((x) => x.attrs.pass === 'false')])
        if (ctx.fixLoops > 0 && lastFail?.attrs.sha) {
          const sha = await headSha()
          if (lastFail.attrs.sha === sha) {
            if (parseMarker(lastFail.c.body)?.kind === 'verdict') throw new Error(`builder made no new commits since the failed review (head ${sha})`)
            // Unchanged code after a failed test run (e.g. a flaky test): an empty commit gives the
            // branch a new head so verify runs fresh instead of replaying the cached report.
            await runOk(gitArgv(mod, '-c', 'user.name=software-factory', '-c', 'user.email=software-factory@users.noreply',
              'commit', '--allow-empty', '-m', 'chore: re-verify after failed test run'), 'git commit --allow-empty')
          }
        }
        await runOk(gitArgv(mod, 'push', cloneUrl, `HEAD:refs/heads/${branch}`), 'git push')
        return { posts: [], event: { kind: 'build-done' } }
      }
      case 'verify': {
        const r = await verify(deps.run, { cloneUrl, publicUrl, branch, scratchDir: `${dir}.verify`, cfg, secrets: deps.secrets })
        return { posts: [r.report], event: { kind: 'verify', passed: r.passed } }
      }
      case 'review': {
        const baseBranch = await checkout()
        const sha = await headSha()
        if (!sha) throw new Error('could not read the branch head')
        await writeEvidence(baseBranch, sha)
        const a = { ...base, report: art('test-report') ?? '', base: baseBranch }
        const settled = await Promise.allSettled(ctx.requiredReviewers.map(async (role): Promise<Verdict> => {
          const out = await agent(role, a)
          const m = /^VERDICT:\s*(pass|fail)$/i.exec(firstLine(out))
          if (!m) throw new Error(`${role} output did not start with "VERDICT: pass|fail": ${firstLine(out).slice(0, 200)}`)
          return { role, pass: m[1].toLowerCase() === 'pass', findings: afterFirstLine(out) }
        }))
        const errors = settled.flatMap((x) => (x.status === 'rejected' ? [errText(x.reason)] : []))
        if (errors.length > 0) throw new Error(errors.join('; '))
        const verdicts = settled.flatMap((x) => (x.status === 'fulfilled' ? [x.value] : []))
        return {
          posts: verdicts.map((v) => verdictComment(v, ctx.fixLoops, sha)),
          event: { kind: 'verdicts', verdicts },
          failed: verdicts.filter((v) => !v.pass),
        }
      }
      case 'approve': {
        const verdicts = formatVerdicts(gateVerdicts)
        const report = art('test-report') ?? ''
        const out = await agent('approver', { spec: base.spec, report, verdicts })
        const head = firstLine(out)
        const rej = /^REJECT:\s*(.*)$/.exec(head)
        if (rej) {
          const v: Verdict = { role: 'approver', pass: false, findings: [`- ${rej[1].trim() || 'rejected'}`, afterFirstLine(out)].filter(Boolean).join('\n\n') }
          return { posts: [verdictComment(v, ctx.fixLoops, gateSha)], event: { kind: 'verdicts', verdicts: [v] }, failed: [v] }
        }
        if (head !== 'APPROVE') throw new Error(`approver output did not start with APPROVE or REJECT: ${head.slice(0, 200)}`)
        return { posts: [], event: { kind: 'mr-opened' }, approved: afterFirstLine(out) }
      }
      default:
        return { posts: [], event: { kind: 'picked' } }
    }
  }

  // Idempotent re-entry: the station's output is already posted, only the relabel is missing.
  const kindOf: Partial<Record<Station, string>> = { spec: 'spec', design: 'design', plan: 'plan', approve: 'approval' }
  const kind = kindOf[from]
  if (kind && alreadyPosted(job, kind)) {
    const ev: MachineEvent = from === 'approve' ? { kind: 'mr-opened' } : { kind: 'artifact-posted' }
    return commit(from, next(from, ev, ctx).station, [])
  }
  const report = newest(markersOf(job, 'test-report'))
  const settle = (o: Outcome) => finish({ ...o, posts: [] }, true)
  // A trusted `/retry` newer than the cached markers forces a fresh run instead of a replay.
  const retryAt = Math.max(-Infinity, ...job.comments
    .filter((c) => c.trusted !== false && c.body.trim().split(/\s+/, 1)[0] === '/retry').map(at))
  const replayable = (...cs: Comment[]) => cs.every((c) => at(c) > retryAt)
  if (from === 'verify' && report?.attrs.sha && replayable(report.c)) {
    const sha = await remoteSha()
    const lastFail = newest(markersOf(job, 'verdict').filter((x) => x.attrs.pass === 'false'))
    if (sha === report.attrs.sha && (!lastFail || at(report.c) > at(lastFail.c))) {
      const passed = report.attrs.passed === 'true'
      // A posted failing report is already counted by fixLoopsOf.
      return settle({ posts: [], event: { kind: 'verify', passed }, round: passed ? ctx.fixLoops : ctx.fixLoops - 1 })
    }
  }
  if (from === 'review' && report) {
    const { byRole, round } = verdictsAfter(job, report, ctx.requiredReviewers)
    if (round !== undefined && ctx.requiredReviewers.every((r) => byRole.get(r)?.attrs.round === round) && replayable(...[...byRole.values()].map((x) => x.c))) {
      const verdicts = [...byRole.values()].map(toVerdict)
      return settle({ posts: [], event: { kind: 'verdicts', verdicts }, failed: verdicts.filter((v) => !v.pass), round: Number(round) })
    }
  }
  let gateVerdicts: Verdict[] = []
  let gateSha: string | undefined
  if (from === 'approve') {
    const rej = report && verdictsAfter(job, report, ['approver']).byRole.get('approver')
    if (rej && rej.attrs.pass === 'false' && replayable(rej.c)) {
      const v = toVerdict(rej)
      return settle({ posts: [], event: { kind: 'verdicts', verdicts: [v] }, failed: [v], round: Number(rej.attrs.round) })
    }
    const prep = await attempt(async () => {
      const baseBranch = await checkout()
      const sha = await headSha()
      if (sha) await writeEvidence(baseBranch, sha)
      return sha
    })
    if (!prep.ok) return prep.blocked
    gateSha = prep.value
    const gate = approveGate(job, ctx.requiredReviewers, ctx.fixLoops, gateSha)
    if (!gate.ok) return block(from, `Refusing to run the approver: ${gate.why}. Relabel to \`factory::build\` or \`factory::verify\` to produce fresh evidence.`)
    gateVerdicts = gate.verdicts
    // An MR opened by an earlier advance whose approval comment failed: record it, never open a second.
    const open = await forge.findOpenMR(ref.project, branch)
    if (open) return commit(from, 'mr-open', [`${marker('approval', { mr: open.url })}\nMerge request already open for \`${branch}\`.`])
  }

  const done = await attempt(step)
  if (!done.ok) return done.blocked
  const outcome = done.value

  if (outcome.approved !== undefined) {
    // Outside the retried step: never open a second MR for the same branch.
    const summary = outcome.approved
    const mr = await forge.openMR(ref, branch, `${job.title} (#${ref.issue})`,
      clean(mrBody(job, { summary, ...base, report: art('test-report') ?? '', verdicts: formatVerdicts(gateVerdicts) })))
    outcome.posts.push(`${marker('approval', { mr: mr.url })}\n${summary}`)
  }
  return finish(outcome, false)

  /** Runs station work, retrying once; a second failure posts `blocked` with the station and error. */
  async function attempt<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; blocked: AdvanceResult }> {
    try {
      return { ok: true, value: await fn() }
    } catch (first) {
      try {
        return { ok: true, value: await fn() }
      } catch (second) {
        const to = next(from, { kind: 'error', message: errText(second), retried: true }, ctx).station
        return { ok: false, blocked: await commit(from, to, [`${marker('blocked', { station: from })}\nStation \`${from}\` failed twice (retried once).\n\nFirst error: ${errText(first)}\n\nError: ${errText(second)}`]) }
      }
    }
  }

  async function finish(o: Outcome, reentry: boolean): Promise<AdvanceResult> {
    // The approver's REJECT is a failed review round: reuse the review transition.
    const machineStation: Station = from === 'approve' && o.event.kind === 'verdicts' ? 'review' : from
    const out = next(machineStation, o.event, { ...ctx, fixLoops: o.round ?? ctx.fixLoops })
    const posts = [...o.posts]
    const blockedPosted = reentry && report && markersOf(job, 'blocked').some((x) => at(x.c) > at(report.c))
    if (out.station === 'blocked' && !blockedPosted) {
      const findings = o.failed && o.failed.length > 0 ? `\n\n${formatVerdicts(o.failed)}` : ''
      posts.push(`${marker('blocked', { station: from })}\n${out.reason ?? 'blocked'}${findings}`)
    }
    return commit(from, out.station, posts)
  }
}
