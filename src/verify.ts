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
  opts: { cloneUrl: string; publicUrl: string; branch: string; scratchDir: string; cfg: RepoConfig; secrets: string[] },
): Promise<{ passed: boolean; report: string; sha?: string }> {
  const { cloneUrl, publicUrl, branch, scratchDir, cfg } = opts
  const secrets = [...opts.secrets, cloneUrl]
  let sha: string | undefined
  const finish = (passed: boolean, body: string) => {
    const attrs: Record<string, string> = { passed: passed ? 'true' : 'false' }
    if (sha) attrs.sha = sha
    return { passed, report: redact(`${marker('test-report', attrs)}\n${body}`, secrets), ...(sha ? { sha } : {}) }
  }

  if (!cfg.test || !cfg.test.trim()) return finish(false, 'No test command configured (cfg.test is blank)')
  await run(['rm', '-rf', scratchDir], {})
  const clone = await run(['git', 'clone', '--depth', '1', '--branch', branch, cloneUrl, scratchDir], {})
  if (clone.exitCode !== 0) {
    return finish(false, `Command: git clone --depth 1 --branch ${branch}\nExit code: ${clone.exitCode}\n\n${tail(`${clone.stdout}\n${clone.stderr}`.trim(), 80)}`)
  }
  // The repo's test command must not be able to read the token from the remote.
  const scrub = await run(['git', '-C', scratchDir, 'remote', 'set-url', 'origin', publicUrl], {})
  if (scrub.exitCode !== 0) return finish(false, `Command: git remote set-url origin <public url>\nExit code: ${scrub.exitCode}`)
  const head = await run(['git', '-C', scratchDir, 'rev-parse', 'HEAD'], {})
  if (head.exitCode === 0 && /^[0-9a-f]{7,64}$/.test(head.stdout.trim())) sha = head.stdout.trim()

  const fail = (cmd: string, r: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean }, out: string) =>
    finish(false, `Command: ${cmd}\nExit code: ${r.exitCode}\n${r.timedOut ? 'Result: timed out after 10 min\n' : ''}\n${out}`)
  const exec = (cmd: string) => run(['sh', '-c', cmd], { cwd: scratchDir, timeoutMs: TIMEOUT_MS })
  const logOf = (r: { stdout: string; stderr: string }) => tail(`${r.stdout}\n${r.stderr}`.trim(), 80)

  if (cfg.setup && cfg.setup.trim()) {
    const s = await exec(cfg.setup)
    if (s.timedOut || s.exitCode !== 0) return fail(cfg.setup, s, logOf(s))
  }
  const t = await exec(cfg.test)
  if (t.timedOut || t.exitCode !== 0) return fail(cfg.test, t, logOf(t))
  return finish(true, `Command: ${cfg.test}\nExit code: ${t.exitCode}\n\n${logOf(t)}`)
}
