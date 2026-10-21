import type { Forge } from './forge/types'
import { fixLoopsOf, specDecision, stationOf } from './machine'
import { redact } from './redact'
import type { Deps } from './stations'
import { tick, type Project, type TickResult } from './tick'
import type { JobRef, Station } from './types'

// `/factory` subcommands: parsing, issue-ref resolution and the handlers.
// Pure: the forges and the station deps come in from hooks/register.ts.

export type Command =
  | { kind: 'open' }
  | { kind: 'help' }
  | { kind: 'tick' }
  | { kind: 'new'; title: string; body: string }
  | { kind: 'run' | 'status' | 'approve'; issue?: string }
  | { kind: 'revise'; issue: string; notes: string }
  | { kind: 'pause' | 'resume' }
  | { kind: 'error'; message: string }

export const HELP = [
  'Software factory commands:',
  '  /factory tick                       one pass over the configured repos',
  '  /factory new <title> [-- body]      create a factory issue (factory::ready)',
  '  /factory run <issue>                put an issue on the line and tick it now',
  '  /factory approve <issue>            approve the spec of an issue',
  '  /factory revise <issue> <notes>     send the spec back with notes',
  '  /factory status [issue]             text summary of the jobs',
  '  /factory pause | resume             stop or start the session ticker',
  '  /factory                            open the pipeline pane (interactive sessions)',
  'Issues: #42 (when exactly one repo is configured) or gitlab:group/name#42 / github:owner/name#42.',
].join('\n')

const ISSUE = /^(?:(github|gitlab):([^\s#]+))?#(\d+)$/

const SHORT_REF_HELP = (n: string) =>
  `use a full issue reference: gitlab:group/name#${n} or github:owner/name#${n}`

export function parseCommand(args: string): Command {
  const text = args.trim()
  const sp = text.search(/\s/)
  const word = (sp < 0 ? text : text.slice(0, sp)).toLowerCase()
  const rest = sp < 0 ? '' : text.slice(sp).trim()
  const err = (message: string): Command => ({ kind: 'error', message })
  const checkIssue = (s: string): string | null => {
    if (ISSUE.test(s)) return null
    if (/^\d+$/.test(s)) return `issue must look like #${s} or gitlab:group/name#${s}`
    return `bad issue reference "${s}" (use #42, gitlab:group/name#42 or github:owner/name#42)`
  }

  switch (word) {
    case '': return { kind: 'open' }
    case 'help': return rest ? err('/factory help takes no arguments') : { kind: 'help' }
    case 'tick': case 'pause': case 'resume':
      return rest ? err(`/factory ${word} takes no arguments`) : { kind: word }
    case 'new': {
      const i = rest.indexOf('--')
      const title = (i < 0 ? rest : rest.slice(0, i)).trim()
      const body = i < 0 ? '' : rest.slice(i + 2).trim()
      if (!title) return err('/factory new needs a title: /factory new <title> [-- body]')
      return { kind: 'new', title, body }
    }
    case 'run': case 'approve': case 'status': {
      if (!rest) return word === 'status' ? { kind: 'status' } : err(`/factory ${word} needs an issue, e.g. /factory ${word} #42`)
      if (/\s/.test(rest)) return err(`/factory ${word} takes one issue reference`)
      const bad = checkIssue(rest)
      return bad ? err(bad) : { kind: word, issue: rest }
    }
    case 'revise': {
      if (!rest) return err('/factory revise needs an issue and notes, e.g. /factory revise #42 handle refunds')
      const s2 = rest.search(/\s/)
      const issue = s2 < 0 ? rest : rest.slice(0, s2)
      const notes = s2 < 0 ? '' : rest.slice(s2).trim()
      const bad = checkIssue(issue)
      if (bad) return err(bad)
      if (!notes) return err(`/factory revise needs notes saying what to change, e.g. /factory revise ${issue} handle refunds`)
      return { kind: 'revise', issue, notes }
    }
    default:
      return err(`unknown subcommand "${word}"\n\n${HELP}`)
  }
}

export function parseRepos(list: string): { projects: Project[]; errors: string[] } {
  const projects: Project[] = []
  const errors: string[] = []
  for (const raw of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    const m = /^(github|gitlab):([^\s#:]+\/[^\s#:]+)$/.exec(raw)
    if (m) projects.push({ forge: m[1] as Project['forge'], project: m[2] })
    else errors.push(`bad repo "${raw}" (use github:owner/name or gitlab:group/name)`)
  }
  return { projects, errors }
}

export function resolveIssue(s: string, projects: Project[]): { ref: JobRef } | { error: string } {
  const m = ISSUE.exec(s.trim())
  if (!m) return { error: `bad issue reference "${s}" (use #42, gitlab:group/name#42 or github:owner/name#42)` }
  const issue = Number(m[3])
  if (!Number.isSafeInteger(issue) || issue < 1) return { error: `bad issue number in "${s}"` }
  if (m[1]) {
    if (!/^[^/]+(\/[^/]+)+$/.test(m[2])) return { error: `bad project in "${s}" (use group/name)` }
    return { ref: { forge: m[1] as JobRef['forge'], project: m[2], issue } }
  }
  if (projects.length === 1) return { ref: { forge: projects[0].forge, project: projects[0].project, issue } }
  const why = projects.length === 0 ? 'no repos are configured' : `${projects.length} repos are configured`
  return { error: `#${issue} is ambiguous: ${why}; ${SHORT_REF_HELP(String(issue))}` }
}

// ---------------------------------------------------------------------------
// Handlers

export type Env = {
  projects: Project[]
  repoErrors: string[]
  /** The forge client for a forge kind, or the reason there is none (e.g. a missing token). */
  forgeFor: (kind: Project['forge']) => { forge: Forge } | { error: string }
  /** Station deps (everything but the forge), for tick and run. */
  deps: Omit<Deps, 'forge' | 'loadConfig'>
  /** Builds Deps.loadConfig for a forge. */
  loadConfigFor: (forge: Forge) => Deps['loadConfig']
  parallel: number
  /**
   * One in-flight flag shared by the session ticker and every command that
   * advances jobs: two ticks of one worker would both "renew" the same lease.
   */
  lock: { busy: boolean }
  /** Set when jobs cannot run here (e.g. HOME is empty); tick and run answer it. */
  workError?: string
  setPaused: (paused: boolean) => void
  isPaused: () => boolean
  /** Told every tick's result before the command answers (toasts, a refresh of the session UI). */
  onTick?: (r: TickResult) => Promise<void> | void
  /** Passed to tick: which station a job is running (the session UI's spinner). */
  onStep?: (ref: JobRef, station: Station | null) => void
}

/** What `/factory` alone answers where no pane can open (a `-p` run, an SDK host). */
export const OPEN_HEADLESS = 'factory: the pane needs an interactive session; use /factory status for a summary (/factory help lists every command)'

const label = (r: JobRef) => `${r.forge}:${r.project}#${r.issue}`
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function noRepos(env: Env): string {
  const lines = ['no repos configured. Set the plugin option "repos" (e.g. gitlab:group/name,github:owner/name) in /config.']
  if (env.repoErrors.length) lines.push(...env.repoErrors)
  return lines.join('\n')
}

export function summarizeTick(r: TickResult): string {
  const lines: string[] = []
  for (const a of r.advanced) lines.push(`${label(a.ref)}: ${a.from} -> ${a.to}${a.needsHuman ? ' (needs you)' : ''}`)
  for (const s of r.skipped) lines.push(`${s.ref.issue === 0 ? `${s.ref.forge}:${s.ref.project}` : label(s.ref)}: skipped (${s.reason})`)
  const jobs = new Set(r.advanced.map((a) => label(a.ref))).size
  return [`factory tick: advanced ${jobs} job${jobs === 1 ? '' : 's'} (${r.advanced.length} step${r.advanced.length === 1 ? '' : 's'}), skipped ${r.skipped.length}`, ...lines].join('\n')
}

/** Runs one tick per forge kind over the configured projects (or just `only`). */
async function runTick(env: Env, only?: JobRef): Promise<string> {
  const kinds = [...new Set(env.projects.map((p) => p.forge))]
  if (only && !kinds.includes(only.forge)) kinds.push(only.forge)
  const out: TickResult = { advanced: [], skipped: [] }
  for (const kind of kinds) {
    const f = env.forgeFor(kind)
    const projects = only
      ? (only.forge === kind ? [{ forge: kind, project: only.project }] : [])
      : env.projects.filter((p) => p.forge === kind)
    if (projects.length === 0) continue
    if ('error' in f) {
      for (const p of projects) out.skipped.push({ ref: { ...p, issue: only?.issue ?? 0 }, reason: f.error })
      continue
    }
    const r = await tick({
      ...env.deps, forge: f.forge, loadConfig: env.loadConfigFor(f.forge),
      projects, parallel: env.parallel, only: only ? [only] : undefined, onStep: env.onStep,
    })
    out.advanced.push(...r.advanced)
    out.skipped.push(...r.skipped)
  }
  if (env.onTick) {
    try { await env.onTick(out) } catch { /* the UI is best-effort */ }
  }
  return summarizeTick(out)
}

const BUSY = 'a tick is already running; try again when it ends'

/** Runs `fn` holding the shared tick lock, or answers that a tick is already running. */
async function exclusive(env: Env, fn: () => Promise<string>): Promise<string> {
  if (env.lock.busy) return BUSY
  env.lock.busy = true
  try {
    return await fn()
  } finally {
    env.lock.busy = false
  }
}

async function status(env: Env, issue?: string): Promise<string> {
  if (issue) {
    const r = resolveIssue(issue, env.projects)
    if ('error' in r) return r.error
    const f = env.forgeFor(r.ref.forge)
    if ('error' in f) return f.error
    const job = await f.forge.getJob(r.ref)
    const st = stationOf(job)
    const where = 'invalid' in st ? `invalid (${st.invalid})` : st.station
    const loops = fixLoopsOf(job)
    return `${label(r.ref)} "${job.title}": ${where}${loops ? `, fix loops ${loops}` : ''}`
  }
  if (env.projects.length === 0) return noRepos(env)
  const lines: string[] = []
  let total = 0
  for (const p of env.projects) {
    const f = env.forgeFor(p.forge)
    if ('error' in f) { lines.push(`${p.forge}:${p.project}: ${f.error}`); continue }
    try {
      const refs = await f.forge.listJobs(p.project)
      total += refs.length
      const byStation = new Map<string, number[]>()
      for (const ref of refs) {
        const job = await f.forge.getJob(ref)
        const st = stationOf(job)
        let key = 'invalid' in st ? 'invalid' : st.station
        if (key === 'awaiting-spec' && 'none' in specDecision(job)) key = 'awaiting-spec (needs you)'
        byStation.set(key, [...(byStation.get(key) ?? []), ref.issue])
      }
      const parts = [...byStation].map(([s, ns]) => `${s}: ${ns.map((n) => `#${n}`).join(' ')}`)
      lines.push(`${p.forge}:${p.project}: ${refs.length} job${refs.length === 1 ? '' : 's'}${parts.length ? ` — ${parts.join('; ')}` : ''}`)
    } catch (e) {
      lines.push(`${p.forge}:${p.project}: error: ${errText(e)}`)
    }
  }
  const head = `${total} job${total === 1 ? '' : 's'} in ${env.projects.length} repo${env.projects.length === 1 ? '' : 's'} (worker ${env.deps.workerId}${env.isPaused() ? ', ticker paused' : ''})`
  return [head, ...lines, ...env.repoErrors].join('\n')
}

async function decide(env: Env, issue: string, body: string, verb: string): Promise<string> {
  const r = resolveIssue(issue, env.projects)
  if ('error' in r) return r.error
  const f = env.forgeFor(r.ref.forge)
  if ('error' in f) return f.error
  const job = await f.forge.getJob(r.ref)
  const st = stationOf(job)
  if ('invalid' in st || st.station !== 'awaiting-spec') {
    return `${label(r.ref)} is not awaiting a spec decision (station: ${'invalid' in st ? st.invalid : st.station})`
  }
  await f.forge.comment(r.ref, body)
  return `${label(r.ref)}: spec ${verb}; the next tick moves it on`
}

export async function handle(cmd: Command, env: Env): Promise<string> {
  const secrets = env.deps.secrets
  try {
    const text = await dispatch(cmd, env)
    return redact(text, secrets)
  } catch (e) {
    return redact(errText(e), secrets)
  }
}

async function dispatch(cmd: Command, env: Env): Promise<string> {
  switch (cmd.kind) {
    case 'error': return cmd.message
    case 'open': return OPEN_HEADLESS
    case 'help': return HELP
    case 'pause': env.setPaused(true); return 'ticker paused'
    case 'resume': env.setPaused(false); return 'ticker resumed'
    case 'status': return status(env, cmd.issue)
    case 'tick':
      if (env.projects.length === 0) return noRepos(env)
      if (env.workError) return env.workError
      return exclusive(env, () => runTick(env))
    case 'approve': return decide(env, cmd.issue!, '/approve', 'approved')
    case 'revise': return decide(env, cmd.issue, `/revise ${cmd.notes}`, 'sent back for revision')
    case 'new': {
      if (env.projects.length !== 1) {
        return env.projects.length === 0 ? noRepos(env) : '/factory new needs exactly one configured repo; several are configured'
      }
      const p = env.projects[0]
      const f = env.forgeFor(p.forge)
      if ('error' in f) return f.error
      const ref = await f.forge.createIssue(p.project, cmd.title, cmd.body)
      await f.forge.setStation(ref, 'ready')
      return `created ${label(ref)} "${cmd.title}" at factory::ready`
    }
    case 'run': {
      const r = resolveIssue(cmd.issue!, env.projects)
      if ('error' in r) return r.error
      const f = env.forgeFor(r.ref.forge)
      if ('error' in f) return f.error
      if (env.workError) return env.workError
      const forge = f.forge
      const ref = r.ref
      return exclusive(env, async () => {
        const job = await forge.getJob(ref)
        if (!job.labels.some((l) => l.startsWith('factory::') && l !== 'factory::spec-approved')) await forge.setStation(ref, 'ready')
        const st = stationOf(job)
        if (!('invalid' in st) && (st.station === 'blocked' || st.station === 'done')) {
          return `${label(ref)} is at ${st.station}; to retry, relabel it to a station (e.g. factory::build) or comment /retry`
        }
        const open = await forge.listJobs(ref.project)
        if (!open.some((o) => o.issue === ref.issue)) return `${label(ref)} not found among open factory issues`
        return runTick(env, ref)
      })
    }
  }
}
