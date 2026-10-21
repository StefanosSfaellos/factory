import type { RepoConfig } from './config'
import { marker } from './markers'
import { redact } from './redact'
import type { RunFn } from './worktree'

const TIMEOUT_MS = 600000

function tail(text: string, n: number): string {
  const lines = text.split('\n')
  return lines.slice(-n).join('\n')
}

export async function verify(
  run: RunFn,
  opts: { cloneUrl: string; branch: string; scratchDir: string; cfg: RepoConfig; secrets: string[] },
): Promise<{ passed: boolean; report: string }> {
  const { cloneUrl, branch, scratchDir, cfg } = opts
  const secrets = [...opts.secrets, cloneUrl]
  const finish = (passed: boolean, body: string) => ({
    passed,
    report: redact(`${marker('test-report', { passed: passed ? 'true' : 'false' })}\n${body}`, secrets),
  })

  await run(['rm', '-rf', scratchDir], {})
  const clone = await run(['git', 'clone', '--depth', '1', '--branch', branch, cloneUrl, scratchDir], {})
  if (clone.exitCode !== 0) {
    return finish(false, `Command: git clone --depth 1 --branch ${branch}\nExit code: ${clone.exitCode}\n\n${tail(`${clone.stdout}\n${clone.stderr}`.trim(), 80)}`)
  }

  const cmds = [cfg.setup, cfg.test].filter((c): c is string => !!c)
  for (let i = 0; i < cmds.length; i++) {
    const cmd = cmds[i]
    const r = await run(['sh', '-c', cmd], { cwd: scratchDir, timeoutMs: TIMEOUT_MS })
    const out = tail(`${r.stdout}\n${r.stderr}`.trim(), 80)
    if (r.timedOut) return finish(false, `Command: ${cmd}\nExit code: ${r.exitCode}\nResult: timed out after 10 min\n\n${out}`)
    if (r.exitCode !== 0) return finish(false, `Command: ${cmd}\nExit code: ${r.exitCode}\n\n${out}`)
    if (i === cmds.length - 1) return finish(true, `Command: ${cmd}\nExit code: ${r.exitCode}\n\n${out}`)
  }
  return finish(false, 'No test command configured')
}
