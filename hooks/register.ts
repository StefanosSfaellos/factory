import type { EngineInterface, Register } from 'claude-code'
import { handle, parseCommand, parseRepos, type Env } from '../src/commands'
import type { SpawnFn } from '../src/agents'
import type { Forge, HttpFn } from '../src/forge/types'
import { githubForge } from '../src/forge/github'
import { gitlabForge } from '../src/forge/gitlab'
import { loadRepoConfig } from '../src/tick'
import type { RunFn } from '../src/worktree'

// The only file that touches `$`. It turns the mods API into the plain
// functions src/ takes (HttpFn, RunFn, SpawnFn, writeFile) and wires the
// `/factory` command and the session ticker. Child sessions (agents the
// factory started, FACTORY_ROLE set) register nothing here.

type Engine = EngineInterface

const DEFAULT_TICK_MINUTES = 10
const DEFAULT_PARALLEL = 2

type State = {
  projects: Env['projects']
  repoErrors: string[]
  workerId: string
  minutes: number
  paused: boolean
  interactive: boolean
  ticking: boolean
  timer?: { cancel: () => void }
}

export const register: Register = (on, options) => {
  const repos = parseRepos(typeof options.repos === 'string' ? options.repos : '')
  const st: State = {
    projects: repos.projects,
    repoErrors: repos.errors,
    workerId: typeof options.workerId === 'string' && options.workerId.trim() ? options.workerId.trim() : 'worker',
    minutes: typeof options.tickMinutes === 'number' && options.tickMinutes > 0 ? options.tickMinutes : DEFAULT_TICK_MINUTES,
    paused: false,
    interactive: false,
    ticking: false,
  }

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // Child sessions (an agent the factory started): no commands, no ticker. Task 10 adds gates.
    if (await $.env.get('FACTORY_ROLE')) return started
    await $.command.register({
      name: 'factory',
      description: 'Software factory: multi-agent build pipeline',
      argumentHint: '[tick|new|run|approve|revise|status|pause|resume]',
      immediate: true,
    })
    st.interactive = e.isInteractive
    startTicker($, st)
    return started
  })

  on('command.run', { command: 'factory' }, async ($, e) => {
    const text = await handle(parseCommand(e.args), await buildEnv($, st))
    return { text }
  })
}

async function buildEnv($: Engine, st: State): Promise<Env> {
  const githubToken = (await $.env.get('GITHUB_TOKEN')) ?? ''
  const gitlabToken = (await $.env.get('GITLAB_TOKEN')) ?? ''
  const gitlabUrl = (await $.env.get('GITLAB_URL')) || 'https://gitlab.com'
  const home = (await $.env.get('HOME')) ?? ''

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
      now: () => Date.now(),
      onProgress: (ref, text) => $.ui.log(`factory ${ref.forge}:${ref.project}#${ref.issue}: ${text}`, { to: 'debug' }),
      writeFile: (path, text) => $.fs.write(path, text),
    },
    loadConfigFor: (forge) => (ref) => loadRepoConfig(forge, ref),
    parallel: DEFAULT_PARALLEL,
    setPaused: (p) => {
      st.paused = p
      if (p) stopTicker(st)
      else startTicker($, st)
    },
    isPaused: () => st.paused,
  }
}

async function timedTick($: Engine, st: State): Promise<void> {
  if (st.ticking || st.paused || st.projects.length === 0) return
  st.ticking = true
  try {
    const text = await handle({ kind: 'tick' }, await buildEnv($, st))
    $.ui.log(text, { to: 'debug' })
  } catch (err) {
    $.ui.log(`factory tick failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' })
  } finally {
    st.ticking = false
  }
}

function startTicker($: Engine, st: State): void {
  if (!st.interactive || st.paused || st.timer) return
  st.timer = $.clock.every(st.minutes * 60000, () => { void timedTick($, st) })
}

function stopTicker(st: State): void {
  st.timer?.cancel()
  st.timer = undefined
}
