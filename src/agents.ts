import { modelFor, type Role, type RepoConfig } from './config'

// Child-agent runner. Each station runs one role agent as a child `claude -p`
// process with this plugin loaded. Pure: the process is started only through
// the injected SpawnFn (built in hooks/register.ts over $.process.spawn).
//
// Agent naming: verified on Claude Code 2.1.306 that `--agent` takes the
// plugin-namespaced name `software-factory:<role>` (bare/unknown names are
// rejected with "not found").

export type SpawnFn = (
  argv: string[],
  opts: { cwd: string; onLine: (line: string) => void },
) => Promise<{ exitCode: number }>

export type ChildOpts = {
  role: Role
  prompt: string
  cfg: RepoConfig
  pluginRoot: string
  job: string
  worktree: string
  /** Forge hosts the builder gate refuses curl/wget writes to (FACTORY_FORGE_HOSTS). */
  forgeHosts?: string[]
}

const READ_ONLY: Role[] = ['code-reviewer', 'security-reviewer', 'ux-reviewer', 'approver']
const PROGRESS_MAX = 120

export function childArgv(o: ChildOpts): string[] {
  const argv = [
    // R18: the agent never sees the forge credentials; the mod does all forge I/O.
    'env', '-u', 'GITHUB_TOKEN', '-u', 'GITLAB_TOKEN', '-u', 'GITLAB_URL',
    `FACTORY_ROLE=${o.role}`,
    `FACTORY_JOB=${o.job}`,
    `FACTORY_WORKTREE=${o.worktree}`,
    `FACTORY_SPEC_FILE=${o.worktree}/.factory/spec.md`,
    `FACTORY_PROTECTED=${(o.cfg.protectedPaths ?? []).join(',')}`,
    `FACTORY_FORGE_HOSTS=${(o.forgeHosts ?? []).join(',')}`,
    'claude', '-p', o.prompt,
    '--plugin-dir', o.pluginRoot,
    '--agent', `software-factory:${o.role}`,
    '--model', modelFor(o.role, o.cfg),
    '--permission-mode', 'acceptEdits',
    '--output-format', 'stream-json',
    '--verbose',
  ]
  if (o.cfg.allowedTools.length > 0) argv.push('--allowedTools', ...o.cfg.allowedTools)
  if (READ_ONLY.includes(o.role)) argv.push('--disallowedTools', 'Edit', 'Write', 'NotebookEdit')
  return argv
}

type StreamEvent = {
  type?: unknown
  subtype?: unknown
  is_error?: unknown
  result?: unknown
  message?: { content?: unknown }
}

function lastTextLine(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  let text: string | undefined
  for (const block of content) {
    if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') text = block.text
  }
  if (text === undefined) return undefined
  const lines = text.split('\n').map(l => l.trim()).filter(l => l !== '')
  const last = lines[lines.length - 1]
  if (last === undefined) return undefined
  return last.length > PROGRESS_MAX ? last.slice(0, PROGRESS_MAX - 1) + '…' : last
}

export async function runAgent(
  spawn: SpawnFn,
  opts: ChildOpts & { onProgress: (text: string) => void },
): Promise<{ ok: boolean; output: string; error?: string }> {
  let final: StreamEvent | undefined
  const onLine = (line: string) => {
    let ev: StreamEvent
    try {
      ev = JSON.parse(line)
    } catch {
      return
    }
    if (!ev || typeof ev !== 'object') return
    if (ev.type === 'assistant') {
      const t = lastTextLine(ev.message?.content)
      if (t !== undefined) {
        try { opts.onProgress(t) } catch { /* progress is best-effort */ }
      }
    } else if (ev.type === 'result') {
      final = ev
    }
  }

  let exitCode: number
  try {
    exitCode = (await spawn(childArgv(opts), { cwd: opts.worktree, onLine })).exitCode
  } catch (e) {
    return { ok: false, output: '', error: `failed to start ${opts.role} agent: ${e instanceof Error ? e.message : String(e)}` }
  }

  const output = final && typeof final.result === 'string' ? final.result : ''
  if (exitCode !== 0) return { ok: false, output, error: `${opts.role} agent exited with code ${exitCode}` }
  if (!final) return { ok: false, output: '', error: `${opts.role} agent produced no result event` }
  if (final.is_error === true || (typeof final.subtype === 'string' && final.subtype !== 'success')) {
    return { ok: false, output, error: `${opts.role} agent ended with ${String(final.subtype)}` }
  }
  return { ok: true, output }
}
