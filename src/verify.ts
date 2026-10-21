import type { RepoConfig } from './config'
import { marker } from './markers'
import { redact } from './redact'
import { gitArgv, gitNoDir, NET_TIMEOUT_MS, NO_TOKENS, type RunFn } from './worktree'

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
  // A failed clone or scrub is a station error (retried, then blocked), never a failed
  // test report: it says nothing about the code and must not count as a fix loop.
  const clone = await run(gitNoDir('clone', '--depth', '1', '--branch', branch, cloneUrl, scratchDir), { timeoutMs: NET_TIMEOUT_MS })
  if (clone.exitCode !== 0 || clone.timedOut) {
    throw new Error(redact(`git clone failed (exit ${clone.exitCode}${clone.timedOut ? ', timed out' : ''}): ${tail(`${clone.stderr}\n${clone.stdout}`.trim(), 20)}`, secrets))
  }
  // The repo's test command must not be able to read the token from the remote.
  const scrub = await run(gitArgv(scratchDir, 'remote', 'set-url', 'origin', publicUrl), {})
  if (scrub.exitCode !== 0) throw new Error(redact(`git remote set-url origin <public url> failed (exit ${scrub.exitCode})`, secrets))
  const head = await run(gitArgv(scratchDir, 'rev-parse', 'HEAD'), {})
  if (head.exitCode === 0 && /^[0-9a-f]{7,64}$/.test(head.stdout.trim())) sha = head.stdout.trim()

  const fail = (cmd: string, r: { exitCode: number; stdout: string; stderr: string; timedOut?: boolean }, out: string) =>
    finish(false, `Command: ${cmd}\nExit code: ${r.exitCode}\n${r.timedOut ? 'Result: timed out after 10 min\n' : ''}\n${out}`)
  // R18: the repo's own commands never see the forge credentials.
  const exec = (cmd: string) => run([...NO_TOKENS, 'sh', '-c', cmd], { cwd: scratchDir, timeoutMs: TIMEOUT_MS })
  const logOf = (r: { stdout: string; stderr: string }) => tail(`${r.stdout}\n${r.stderr}`.trim(), 80)

  if (cfg.setup && cfg.setup.trim()) {
    const s = await exec(cfg.setup)
    if (s.timedOut || s.exitCode !== 0) return fail(cfg.setup, s, logOf(s))
  }
  const t = await exec(cfg.test)
  if (t.timedOut || t.exitCode !== 0) return fail(cfg.test, t, logOf(t))
  return finish(true, `Command: ${cfg.test}\nExit code: ${t.exitCode}\n\n${logOf(t)}`)
}
