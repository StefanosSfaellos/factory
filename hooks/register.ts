import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'
import { decideSpec, handle, parseCommand, parseRepos, type Env } from '../src/commands'
import type { SpawnFn } from '../src/agents'
import type { Forge, HttpFn } from '../src/forge/types'
import { githubForge } from '../src/forge/github'
import { gitlabForge } from '../src/forge/gitlab'
import { loadRepoConfig, ownMarkersOnly, type TickResult } from '../src/tick'
import { gate, type GateCtx } from '../src/gates'
import type { Role } from '../src/config'
import type { RunFn } from '../src/worktree'
import { redact } from '../src/redact'
import type { JobRef, Station } from '../src/types'
import { dossierMarkdown, isWorking, jobKey, latestSpec, loadViews, mergeProgress, sameRef, spinnerSuffix, transitionToast } from '../src/ui/model'
import { bandTree, paneTree, type Actions, type Elements } from '../src/ui/render'
import type { JobDetail, RunningStation } from '../types'

// The only file that touches `$`. It turns the mods API into the plain
// functions src/ takes (HttpFn, RunFn, SpawnFn, writeFile) and wires the
// `/factory` command, the session ticker and the session UI (band, pane,
// spinner suffix, toasts). Child sessions (agents the factory started,
// FACTORY_ROLE set) get no commands, ticker or UI, only the gate.
//
// What the UI draws lives in `$.state` (job views read from the forge, the
// selection, the stations running here); nothing that matters is kept in
// `$.store`, since a job's state lives in the forge. Views are re-read from
// the forge when `/factory` opens the pane, after every tick, and on the
// pane's Refresh button, never on a redraw.

type Engine = EngineInterface

const DEFAULT_TICK_MINUTES = 10
const DEFAULT_PARALLEL = 2
const PANE = 'factory'

const jobsAtom = atom({ plugin: 'software-factory', key: 'jobs' } as const, [])
const loadedAtom = atom({ plugin: 'software-factory', key: 'loaded' } as const, false)
const errorsAtom = atom({ plugin: 'software-factory', key: 'errors' } as const, [])
const selectedAtom = atom({ plugin: 'software-factory', key: 'selected' } as const, null)
const detailAtom = atom({ plugin: 'software-factory', key: 'detail' } as const, null)
const messageAtom = atom({ plugin: 'software-factory', key: 'message' } as const, null)
const runningAtom = atom({ plugin: 'software-factory', key: 'running' } as const, [])

type State = {
  projects: Env['projects']
  repoErrors: string[]
  workerId: string
  minutes: number
  paused: boolean
  interactive: boolean
  parallel: number
  lock: { busy: boolean }
  timer?: { cancel: () => void }
  /** The user's own session (not a child the factory started): the only one that draws. */
  parent: boolean
  /** The forge tokens, for redacting what the UI draws. */
  secrets: string[]
  /** Spinner and progress writes, applied one after another in the order the tick raised them. */
  uiQueue: Promise<void>
  /** Ticks this session finished; a press tells by it whether its re-tick ran. */
  ticks: number
}

export const register: Register = (on, options) => {
  const repos = parseRepos(typeof options.repos === 'string' ? options.repos : '')
  const st: State = {
    projects: repos.projects,
    repoErrors: repos.errors,
    // Resolved at session start: the default 'worker' would be shared by every machine.
    workerId: typeof options.workerId === 'string' ? options.workerId.trim() : '',
    minutes: typeof options.tickMinutes === 'number' && options.tickMinutes > 0 ? options.tickMinutes : DEFAULT_TICK_MINUTES,
    paused: false,
    interactive: false,
    // Per-repo `limits.parallel` is not used: a tick spans repos and reads no config before leasing.
    parallel: typeof options.parallel === 'number' && options.parallel >= 1 ? Math.floor(options.parallel) : DEFAULT_PARALLEL,
    lock: { busy: false },
    parent: false,
    secrets: [],
    uiQueue: Promise.resolve(),
    ticks: 0,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Child sessions (an agent the factory started): no commands, no ticker. Task 10 adds gates.
    if (await $.env.get('FACTORY_ROLE')) return started
    st.parent = true
    st.secrets = await sessionSecrets($)
    if (st.workerId === '' || st.workerId === 'worker') st.workerId = await sessionWorkerId($)
    await $.command.register({
      name: 'factory',
      description: 'Software factory: multi-agent build pipeline',
      argumentHint: '[tick|new|run|approve|revise|status|pause|resume|help]',
      immediate: true,
    })
    st.interactive = e.isInteractive
    startTicker($, st)
    // One view refresh as the session opens, so the band has counts before the first tick.
    // Work that outlives the hook starts from session.start on a $.clock timer.
    if (st.interactive && st.projects.length > 0) {
      $.clock.after(0, () => { void refresh($, st).catch(() => { /* the UI is best-effort */ }) })
    }
    return started
  })

  // Gates (spec §4.2, §12): registered in every session, active only in a child
  // (FACTORY_ROLE set). The user's own session is never gated. Fails closed.
  // `child` records what the role read found: a failure to read it in the user's own
  // session lets the call through; once the session is known to be a child, any
  // failure denies.
  const spec: { path?: string; text?: string } = {}
  const child = { known: false }
  on('tool.call', async ($, e, next) => {
    let role: string | undefined
    try {
      role = await $.env.get('FACTORY_ROLE')
    } catch {
      if (!child.known) return next(e)
      throw new Error('factory gate: cannot read FACTORY_ROLE')
    }
    if (!role) return next(e)
    child.known = true
    const ctx = await gateCtx($, role as Role, spec)
    const { tool, ...input } = e
    const verdict = gate({ tool, input: input as Record<string, unknown> }, ctx)
    return 'deny' in verdict ? { deny: verdict.deny } : next(e)
  }).catch(($, e, next) => (next.called ? next(e) : { deny: 'factory gate failed; action blocked' }))

  on('command.run', { command: 'factory' }, async ($, e) => {
    const cmd = parseCommand(e.args)
    if (cmd.kind === 'open' && st.parent && st.interactive) {
      await openPane($)
      await refresh($, st)
      return {}
    }
    const text = await handle(cmd, await buildEnv($, st))
    return { text }
  })

  // The band above the prompt: one summary line, and a Review button per spec waiting on a person.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (!st.parent || e.props.hasSurvey || st.projects.length === 0) return next(e)
    if (!(await read($, loadedAtom))) return next(e)
    const jobs = await read($, jobsAtom)
    const el = $.ui.resolve(e) as unknown as Elements<RenderElement>
    return bandTree(el, jobs, { actions: uiActions($, st), secrets: st.secrets })
  })

  // The pipeline pane `/factory` opens.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (!st.parent) return next(e)
    const jobs = await read($, jobsAtom)
    const selected = await read($, selectedAtom)
    const detail = await read($, detailAtom)
    const message = await read($, messageAtom)
    const errors = await read($, errorsAtom)
    const el = $.ui.resolve(e) as unknown as Elements<RenderElement>
    return paneTree(el, jobs, selected ?? undefined, e.surface, {
      actions: uiActions($, st),
      secrets: st.secrets,
      detail: detail ?? undefined,
      message: message ?? undefined,
      errors: [...errors, ...st.repoErrors],
      empty: st.projects.length === 0 ? 'No repos configured. Set the plugin option "repos" (e.g. gitlab:group/name) in /config.' : undefined,
    })
  })

  // The spinner names the station running in this session, and only while it runs.
  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (!st.parent) return next(e)
    const running = await read($, runningAtom)
    const first = running[0]
    if (!first) return next(e)
    const suffix = redact(spinnerSuffix({ issue: first.ref.issue, station: first.station }), st.secrets)
    return next({ ...e, props: { ...e.props, suffix: `${e.props.suffix}${suffix}` } })
  })
}

function openPane($: Engine): Promise<unknown> {
  return $.ui.open({ id: PANE, title: 'Factory' })
}

/** Re-reads every configured project's jobs from the forge into `$.state`. */
async function refresh($: Engine, st: State): Promise<void> {
  const env = await buildEnv($, st)
  const r = await loadViews(st.projects, env.forgeFor, { now: await $.clock.now(), secrets: st.secrets })
  await update($, jobsAtom, (prev) => mergeProgress(r.views, prev))
  await update($, errorsAtom, () => r.errors)
  await update($, loadedAtom, () => true)
}

/** What the band's and the pane's buttons do: every one writes to the forge or to `$.state`. */
function uiActions($: Engine, st: State): Actions {
  const say = (text: string | null) => update($, messageAtom, () => text === null ? null : redact(text, st.secrets))
  const show = async (ref: JobRef, review: boolean) => {
    await update($, selectedAtom, () => jobKey(ref))
    await say(null)
    const env = await buildEnv($, st)
    const f = env.forgeFor(ref.forge)
    if ('error' in f) { await say(f.error); return }
    try {
      const raw = await f.forge.getJob(ref)
      const job = { ...raw, comments: ownMarkersOnly(raw.comments, await f.forge.whoami()) }
      const detail: JobDetail = { spec: redact(latestSpec(job), st.secrets), dossier: redact(dossierMarkdown(job), st.secrets), review }
      await update($, detailAtom, () => detail)
    } catch (err) {
      await update($, detailAtom, () => ({ spec: '', dossier: '', review }))
      await say(`could not read ${jobKey(ref)}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  const back = async () => {
    await update($, selectedAtom, () => null)
    await update($, detailAtom, () => null)
  }
  /**
   * Posts the decision through the forge, marks the job decided at once, then
   * re-ticks it under the shared lock. When no tick ran (one was in flight, or
   * the run refused), the views are re-read so the buttons go anyway.
   */
  const decide = async (cmd: { kind: 'approve'; issue: string } | { kind: 'revise'; issue: string; notes: string }) => {
    const env = await buildEnv($, st)
    const d = await decideSpec(env, cmd)
    await back()
    await say(d.text)
    if (!d.posted) return
    await update($, jobsAtom, (jobs) => jobs.map((j) => (sameRef(j.ref, d.ref) ? { ...j, needsHuman: false } : j)))
    const ticks = st.ticks
    const ran = await handle({ kind: 'run', issue: jobKey(d.ref) }, env)
    if (st.ticks === ticks) {
      await say(`${d.text}\n${ran}`)
      await refresh($, st)
    }
  }
  const actions: Actions = {
    select: (ref) => show(ref, false),
    review: async (ref) => {
      await openPane($)
      await show(ref, true)
    },
    back: async () => {
      await back()
      await say(null)
    },
    approve: (ref) => decide({ kind: 'approve', issue: jobKey(ref) }),
    revise: (ref, notes) => {
      if (notes.trim() === '') return say('Revise needs notes: say what should change in the spec.')
      return decide({ kind: 'revise', issue: jobKey(ref), notes: notes.trim() })
    },
    refresh: () => refresh($, st),
  }
  return actions
}

function enqueue(st: State, fn: () => Promise<void>): void {
  st.uiQueue = st.uiQueue.then(fn).catch(() => { /* the UI is best-effort */ })
}

/** After every tick of this session: toasts for moves a person must act on, then fresh views. */
async function afterTick($: Engine, st: State, r: TickResult): Promise<void> {
  st.ticks++
  await st.uiQueue
  for (const a of r.advanced) {
    const text = transitionToast(a)
    if (text) $.ui.toast(redact(text, st.secrets))
  }
  await refresh($, st)
  $.ui.invalidate('ui.render')
}

async function stepChanged($: Engine, ref: JobRef, station: Station | null): Promise<void> {
  await update($, runningAtom, (list) => {
    const rest = list.filter((r) => !sameRef(r.ref, ref))
    return station ? [...rest, { ref, station } satisfies RunningStation] : rest
  })
  // A job's progress line belongs to the station running it: gone once it ends.
  if (!station) await update($, jobsAtom, (jobs) => jobs.map((j) => (sameRef(j.ref, ref) && j.progress !== undefined ? { ...j, progress: undefined } : j)))
}

async function progressed($: Engine, st: State, ref: JobRef, text: string): Promise<void> {
  const line = redact(text, st.secrets)
  await update($, jobsAtom, (jobs) => jobs.map((j) => (sameRef(j.ref, ref) ? { ...j, progress: line } : j)))
}

async function sessionSecrets($: Engine): Promise<string[]> {
  return [(await $.env.get('GITHUB_TOKEN')) ?? '', (await $.env.get('GITLAB_TOKEN')) ?? ''].filter((s) => s !== '')
}

async function gateCtx($: Engine, role: Role, spec: { path?: string; text?: string }): Promise<GateCtx> {
  const worktree = (await $.env.get('FACTORY_WORKTREE')) || undefined
  const protectedPaths = ((await $.env.get('FACTORY_PROTECTED')) ?? '').split(',').map((g) => g.trim()).filter((g) => g !== '')
  // R18: the child has no forge tokens or GITLAB_URL; the parent passes the hosts.
  const forgeHosts = ((await $.env.get('FACTORY_FORGE_HOSTS')) ?? '').split(',').map((h) => h.trim()).filter((h) => h !== '')
  // The spec is written before the child starts; it is read once, at the child's first
  // tool call, so a later change to the file by the agent itself cannot widen what it
  // may edit. A missing file means no exceptions; a failing read fails the gate closed.
  // Only a builder with protected paths needs it.
  const path = (await $.env.get('FACTORY_SPEC_FILE')) ?? ''
  if (role === 'builder' && protectedPaths.length > 0 && (spec.text === undefined || spec.path !== path)) {
    spec.path = path
    spec.text = path !== '' && (await $.fs.exists(path)) ? await $.fs.read(path) : ''
  }
  return { role, worktree, protectedPaths, specText: spec.text ?? '', forgeHosts }
}

async function buildEnv($: Engine, st: State): Promise<Env> {
  if (st.workerId === '' || st.workerId === 'worker') st.workerId = await sessionWorkerId($)
  const githubToken = (await $.env.get('GITHUB_TOKEN')) ?? ''
  const gitlabToken = (await $.env.get('GITLAB_TOKEN')) ?? ''
  const gitlabUrl = (await $.env.get('GITLAB_URL')) || 'https://gitlab.com'
  const home = (await $.env.get('HOME')) ?? ''
  st.secrets = [githubToken, gitlabToken].filter((x) => x !== '')
  // Only the user's own interactive session draws: toasts, views, the spinner.
  const ui = st.parent && st.interactive

  const http: HttpFn = async (req) => {
    const init: { method: string; headers: Record<string, string>; body?: string } = { method: req.method, headers: req.headers }
    if (req.body !== undefined) init.body = req.body
    const res = await $.http.fetch(req.url, init)
    return { status: res.status, ok: res.ok, text: res.text }
  }

  const run: RunFn = async (argv, opts) => {
    const init: { cwd?: string; timeoutMs?: number } = {}
    if (opts.cwd !== undefined) init.cwd = opts.cwd
    if (opts.timeoutMs !== undefined) init.timeoutMs = opts.timeoutMs
    try {
      const r = await $.process.run(argv, init)
      return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // $.process.run rejects "... aborted: still running after <ms>ms" on timeout.
      if (/still running after/.test(message)) return { exitCode: -1, stdout: '', stderr: 'timed out', timedOut: true }
      return { exitCode: -1, stdout: '', stderr: message }
    }
  }

  const spawn: SpawnFn = async (argv, opts) => {
    const child = $.process.spawn({ argv, cwd: opts.cwd })
    let buf = ''
    for await (const chunk of child) {
      if (chunk.stream !== 'stdout') continue
      buf += chunk.text
      let nl = buf.indexOf('\n')
      while (nl >= 0) {
        opts.onLine(buf.slice(0, nl))
        buf = buf.slice(nl + 1)
        nl = buf.indexOf('\n')
      }
    }
    if (buf !== '') opts.onLine(buf)
    const end = await child.result
    return { exitCode: end.code ?? -1 }
  }

  const forges: Partial<Record<'github' | 'gitlab', Forge>> = {}
  if (githubToken) forges.github = githubForge(http, { token: githubToken })
  if (gitlabToken) forges.gitlab = gitlabForge(http, { baseUrl: gitlabUrl, token: gitlabToken })

  return {
    projects: st.projects,
    repoErrors: st.repoErrors,
    forgeFor: (kind) => {
      const f = forges[kind]
      return f ? { forge: f } : { error: `${kind === 'github' ? 'GITHUB_TOKEN' : 'GITLAB_TOKEN'} is not set` }
    },
    deps: {
      run,
      spawn,
      pluginRoot: $.plugin.root,
      workRoot: `${home}/.factory/work`,
      secrets: [githubToken, gitlabToken].filter((s) => s !== ''),
      workerId: st.workerId,
      forgeHosts: forgeHostsOf(gitlabUrl),
      now: () => Date.now(),
      onProgress: (ref, text) => {
        $.ui.log(`factory ${ref.forge}:${ref.project}#${ref.issue}: ${text}`, { to: 'debug' })
        if (ui) enqueue(st, async () => {
          await progressed($, st, ref, text)
          // $.state writes redraw their readers; the brief also asks for an explicit invalidate here.
          $.ui.invalidate('ui.render')
        })
      },
      writeFile: (path, text) => $.fs.write(path, text),
    },
    loadConfigFor: (forge) => (ref) => loadRepoConfig(forge, ref),
    parallel: st.parallel,
    lock: st.lock,
    workError: home === '' ? 'HOME is not set; the factory needs it for its work directory (~/.factory/work)' : undefined,
    setPaused: (p) => {
      st.paused = p
      if (p) stopTicker(st)
      else startTicker($, st)
    },
    isPaused: () => st.paused,
    onTick: ui ? (r) => afterTick($, st, r) : undefined,
    onStep: ui ? (ref, station) => enqueue(st, () => stepChanged($, ref, station && isWorking(station) ? station : null)) : undefined,
  }
}

/** Hosts the builder gate treats as the forge: GitHub's and the configured GitLab's. */
function forgeHostsOf(gitlabUrl: string): string[] {
  const gitlab = gitlabUrl.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^[^@/]*@/, '').replace(/[/:?#].*$/, '').toLowerCase()
  return [...new Set(['github.com', 'api.github.com', 'uploads.github.com', gitlab].filter((h) => h !== ''))]
}

async function timedTick($: Engine, st: State): Promise<void> {
  // The shared lock in handle() skips a period while any tick or /factory run is in flight.
  if (st.lock.busy || st.paused || st.projects.length === 0) return
  try {
    const text = await handle({ kind: 'tick' }, await buildEnv($, st))
    $.ui.log(text, { to: 'debug' })
  } catch (err) {
    $.ui.log(`factory tick failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  }
}

/** `<HOSTNAME|USER|host>-<6 hex>`, once per session, so no two sessions share a lease identity. */
async function sessionWorkerId($: Engine): Promise<string> {
  const host = (await $.env.get('HOSTNAME')) || (await $.env.get('USER')) || 'host'
  const bytes = new Uint8Array(3)
  crypto.getRandomValues(bytes)
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${host.replace(/[^A-Za-z0-9._-]/g, '-')}-${hex}`
}

function startTicker($: Engine, st: State): void {
  if (!st.interactive || st.paused || st.timer) return
  st.timer = $.clock.every(st.minutes * 60000, () => { void timedTick($, st) })
}

function stopTicker(st: State): void {
  st.timer?.cancel()
  st.timer = undefined
}
