import type { Forge } from './forge/types'
import { fixLoopsOf, specDecision, stationOf } from './machine'
import { redact } from './redact'
import type { Deps } from './stations'
import { DEFAULT_GITLAB_URL, entryLabel, hostOf, jobKey, parsePath, parseRepoList, refLabel } from './hosts'
import { listEntry, ownMarkersOnly, tick, type Project, type TickResult } from './tick'
import type { ForgeKind, JobRef, Station } from './types'

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
  'Issues: #42 (when exactly one repo, not a wildcard, is configured) or a full reference:',
  '  github:owner/name#42, gitlab:group/name#42 (the GITLAB_URL host), gitlab:<host>/group/name#42.',
].join('\n')

const ISSUE = /^(?:(github|gitlab):([^\s#]+))?#(\d+)$/

const SHORT_REF_HELP = (n: string) =>
  `use a full issue reference: gitlab:group/name#${n}, gitlab:<host>/group/name#${n} or github:owner/name#${n}`

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

const DEFAULT_GITLAB_HOST = hostOf(DEFAULT_GITLAB_URL)

/**
 * Reads the plugin option `repos`. Entry forms: `github:owner/name`, `github:owner/*`,
 * `github:*`, `gitlab:group/name`, `gitlab:group/*`, `gitlab:*`, and the GitLab forms with
 * a host first (`gitlab:<host>/group/name`). A first segment with a dot is a host; GitLab
 * entries without one are on `gitlabHost` (GITLAB_URL's host).
 */
export function parseRepos(list: string, opts: { gitlabHost?: string } = {}): { projects: Project[]; errors: string[] } {
  return parseRepoList(list, opts.gitlabHost || DEFAULT_GITLAB_HOST)
}

/**
 * A full reference (`github:owner/name#42`, `gitlab:group/name#42`, `gitlab:<host>/group/name#42`),
 * or `#42` when exactly one repo is configured and it is not a wildcard.
 */
export function resolveIssue(s: string, projects: Project[], gitlabHost: string = DEFAULT_GITLAB_HOST): { ref: JobRef } | { error: string } {
  const m = ISSUE.exec(s.trim())
  if (!m) return { error: `bad issue reference "${s}" (use #42, gitlab:group/name#42 or github:owner/name#42)` }
  const issue = Number(m[3])
  if (!Number.isSafeInteger(issue) || issue < 1) return { error: `bad issue number in "${s}"` }
  if (m[1]) {
    const forge = m[1] as ForgeKind
    const r = parsePath(forge, m[2], gitlabHost, false)
    if ('error' in r) return { error: `bad project in "${s}" (${r.error})` }
    return { ref: { forge, host: r.host, project: r.project, issue } }
  }
  const p = projects[0]
  if (projects.length === 1 && !p.scope) return { ref: { forge: p.forge, host: p.host, project: p.project, issue } }
  const why = projects.length === 0 ? 'no repos are configured'
    : projects.some((x) => x.scope) ? 'a wildcard repo is configured'
    : `${projects.length} repos are configured`
  return { error: `#${issue} is ambiguous: ${why}; ${SHORT_REF_HELP(String(issue))}` }
}

// ---------------------------------------------------------------------------
// Handlers

export type Env = {
  projects: Project[]
  /** Bad `repos` entries and bad FACTORY_TOKENS entries. */
  repoErrors: string[]
  /** GITLAB_URL's host: what a GitLab entry or reference without a host means. Default gitlab.com. */
  gitlabHost?: string
  /** The forge client for a (kind, host), or the reason there is none (e.g. a missing token). */
  forgeFor: (at: { forge: ForgeKind; host: string }) => { forge: Forge } | { error: string }
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

const glHost = (env: { gitlabHost?: string }) => env.gitlabHost || DEFAULT_GITLAB_HOST
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

function noRepos(env: Env): string {
  const lines = ['no repos configured. Set the plugin option "repos" (e.g. gitlab:group/name,github:owner/*) in /config.']
  if (env.repoErrors.length) lines.push(...env.repoErrors)
  return lines.join('\n')
}

export function summarizeTick(r: TickResult, gitlabHost: string = DEFAULT_GITLAB_HOST): string {
  const label = (ref: JobRef) => refLabel(ref, gitlabHost)
  const lines: string[] = []
  for (const a of r.advanced) lines.push(`${label(a.ref)}: ${a.from} -> ${a.to}${a.needsHuman ? ' (needs you)' : ''}`)
  for (const s of r.skipped) lines.push(`${s.ref.issue === 0 ? entryLabel(s.ref, gitlabHost) : label(s.ref)}: skipped (${s.reason})`)
  const jobs = new Set(r.advanced.map((a) => jobKey(a.ref))).size
  return [`factory tick: advanced ${jobs} job${jobs === 1 ? '' : 's'} (${r.advanced.length} step${r.advanced.length === 1 ? '' : 's'}), skipped ${r.skipped.length}`, ...lines].join('\n')
}

/** Runs one tick per forge instance (kind and host) over the configured entries (or just `only`). */
async function runTick(env: Env, only?: JobRef): Promise<string> {
  const groups = new Map<string, Project[]>()
  const entries: Project[] = only ? [{ forge: only.forge, host: only.host, project: only.project }] : env.projects
  for (const p of entries) {
    const k = `${p.forge}|${p.host}`
    groups.set(k, [...(groups.get(k) ?? []), p])
  }
  const out: TickResult = { advanced: [], skipped: [] }
  for (const projects of groups.values()) {
    const f = env.forgeFor(projects[0])
    if ('error' in f) {
      for (const p of projects) out.skipped.push({ ref: { forge: p.forge, host: p.host, project: p.project, issue: only?.issue ?? 0 }, reason: f.error })
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
  return summarizeTick(out, glHost(env))
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
  const gl = glHost(env)
  const label = (r: JobRef) => refLabel(r, gl)
  if (issue) {
    const r = resolveIssue(issue, env.projects, gl)
    if ('error' in r) return r.error
    const f = env.forgeFor(r.ref)
    if ('error' in f) return f.error
    // R6: only the factory's own markers count; forged ones are ignored.
    const raw = await f.forge.getJob(r.ref)
    const job = { ...raw, comments: ownMarkersOnly(raw.comments, await f.forge.whoami()) }
    const st = stationOf(job)
    const where = 'invalid' in st ? `invalid (${st.invalid})` : st.station
    const loops = fixLoopsOf(job)
    return `${label(r.ref)} "${job.title}": ${where}${loops ? `, fix loops ${loops}` : ''}`
  }
  if (env.projects.length === 0) return noRepos(env)
  const lines: string[] = []
  let total = 0
  // A job matched by several entries (an exact one and a wildcard) is counted once, under the first.
  const seen = new Set<string>()
  for (const p of env.projects) {
    const name = entryLabel(p, gl)
    const f = env.forgeFor(p)
    if ('error' in f) { lines.push(`${name}: ${f.error}`); continue }
    try {
      const refs = (await listEntry(f.forge, p)).filter((r) => !seen.has(jobKey(r)))
      for (const r of refs) seen.add(jobKey(r))
      total += refs.length
      const byStation = new Map<string, string[]>()
      const me = refs.length > 0 ? await f.forge.whoami() : ''
      for (const ref of refs) {
        const raw = await f.forge.getJob(ref)
        const job = { ...raw, comments: ownMarkersOnly(raw.comments, me) }
        const st = stationOf(job)
        let key = 'invalid' in st ? 'invalid' : st.station
        if (key === 'awaiting-spec' && 'none' in specDecision(job)) key = 'awaiting-spec (needs you)'
        // A wildcard's jobs span projects: each is shown with its project.
        byStation.set(key, [...(byStation.get(key) ?? []), p.scope ? `${ref.project}#${ref.issue}` : `#${ref.issue}`])
      }
      const parts = [...byStation].map(([s, ns]) => `${s}: ${ns.join(' ')}`)
      lines.push(`${name}: ${refs.length} job${refs.length === 1 ? '' : 's'}${parts.length ? ` — ${parts.join('; ')}` : ''}`)
    } catch (e) {
      lines.push(`${name}: error: ${errText(e)}`)
    }
  }
  const head = `${total} job${total === 1 ? '' : 's'} in ${env.projects.length} repo${env.projects.length === 1 ? '' : 's'} (worker ${env.deps.workerId}${env.isPaused() ? ', ticker paused' : ''})`
  return [head, ...lines, ...env.repoErrors].join('\n')
}

/** The outcome of a spec decision: posted (with the job it was posted on), or why not. */
export type DecideResult = { posted: true; ref: JobRef; text: string } | { posted: false; text: string }

/** Posts `/approve` or `/revise <notes>` on a job awaiting a spec decision. Shared by the command and the pane. */
export async function decideSpec(env: Env, cmd: { kind: 'approve'; issue: string } | { kind: 'revise'; issue: string; notes: string }): Promise<DecideResult> {
  const body = cmd.kind === 'approve' ? '/approve' : `/revise ${cmd.notes}`
  const verb = cmd.kind === 'approve' ? 'approved' : 'sent back for revision'
  const secrets = env.deps.secrets
  const label = (r: JobRef) => refLabel(r, glHost(env))
  try {
    const r = resolveIssue(cmd.issue, env.projects, glHost(env))
    if ('error' in r) return { posted: false, text: redact(r.error, secrets) }
    const f = env.forgeFor(r.ref)
    if ('error' in f) return { posted: false, text: redact(f.error, secrets) }
    const job = await f.forge.getJob(r.ref)
    const st = stationOf(job)
    if ('invalid' in st || st.station !== 'awaiting-spec') {
      return { posted: false, text: redact(`${label(r.ref)} is not awaiting a spec decision (station: ${'invalid' in st ? st.invalid : st.station})`, secrets) }
    }
    await f.forge.comment(r.ref, body)
    return { posted: true, ref: r.ref, text: `${label(r.ref)}: spec ${verb}; the next tick moves it on` }
  } catch (e) {
    return { posted: false, text: redact(errText(e), secrets) }
  }
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
    case 'approve': return (await decideSpec(env, { kind: 'approve', issue: cmd.issue! })).text
    case 'revise': return (await decideSpec(env, cmd)).text
    case 'new': {
      if (env.projects.length !== 1) {
        return env.projects.length === 0 ? noRepos(env) : '/factory new needs exactly one configured repo; several are configured'
      }
      const p = env.projects[0]
      if (p.scope) return `/factory new needs one exact repo; ${entryLabel(p, glHost(env))} is a wildcard`
      const f = env.forgeFor(p)
      if ('error' in f) return f.error
      const ref = await f.forge.createIssue(p.project, cmd.title, cmd.body)
      await f.forge.setStation(ref, 'ready')
      return `created ${refLabel(ref, glHost(env))} "${cmd.title}" at factory::ready`
    }
    case 'run': {
      const label = (r: JobRef) => refLabel(r, glHost(env))
      const r = resolveIssue(cmd.issue!, env.projects, glHost(env))
      if ('error' in r) return r.error
      const f = env.forgeFor(r.ref)
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
