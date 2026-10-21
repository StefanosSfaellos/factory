import type { JobRef } from './types'
import { redact } from './redact'

export type RunFn = (
  argv: string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>

// Every git command the mod runs ignores planted hooks (a pre-push hook would see
// the token URL) and fsmonitor, and reads no global or system config (R21): only
// the repository's own config, which for token work is a fresh bare repo the mod
// just created.
export const GIT_ENV = ['env', 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_NOSYSTEM=1']
export const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

/** Hardened git argv for a command run in `dir`. */
export function gitArgv(dir: string, ...args: string[]): string[] {
  return [...GIT_ENV, 'git', ...GIT_SAFE, '-C', dir, ...args]
}

/** Hardened git argv for a command with no working directory (clone, ls-remote, init). */
export function gitNoDir(...args: string[]): string[] {
  return [...GIT_ENV, 'git', ...GIT_SAFE, ...args]
}

export function branchName(ref: JobRef, title: string, prefix: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `${prefix}${ref.issue}-${slug || 'issue'}`
}

export function workDir(root: string, ref: JobRef): string {
  return `${root}/${ref.forge}/${ref.project.replace(/\//g, '__')}/${ref.issue}`
}

export async function ensureCheckout(
  run: RunFn,
  opts: { dir: string; cloneUrl: string; publicUrl: string; branch: string; base: string; secrets?: string[] },
): Promise<void> {
  const { dir, cloneUrl, publicUrl, branch, base } = opts
  const secrets = [...(opts.secrets ?? []), cloneUrl]
  const git = async (argv: string[]): Promise<{ exitCode: number }> => {
    const r = await run(argv, {})
    if (r.exitCode !== 0) {
      const detail = `${r.stderr}\n${r.stdout}`.trim()
      const c = argv.indexOf('-C')
      const sub = c >= 0 ? argv[c + 2] : argv[argv.indexOf('git') + GIT_SAFE.length + 1]
      throw new Error(redact(`git ${sub} failed (exit ${r.exitCode}): ${detail}`, secrets))
    }
    return r
  }
  const exists = (await run(['test', '-d', dir], {})).exitCode === 0
  if (!exists) await git(gitNoDir('clone', cloneUrl, dir))
  // Never leave the token in the checkout: agents and test commands run here.
  await git(gitArgv(dir, 'remote', 'set-url', 'origin', publicUrl))
  await git(gitArgv(dir, 'fetch', cloneUrl, '+refs/heads/*:refs/remotes/origin/*'))
  const remote = await run(gitArgv(dir, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`), {})
  const from = remote.exitCode === 0 ? branch : base
  await git(gitArgv(dir, 'checkout', '-B', branch, `origin/${from}`))
}

