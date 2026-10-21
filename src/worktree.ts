import type { JobRef } from './types'
import { redact } from './redact'

export type RunFn = (
  argv: string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>

// Every git command the mod runs on a directory an agent or the repo's code can
// write to ignores planted hooks (a pre-push hook would see the token URL) and fsmonitor.
export const GIT_SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false']

/** Hardened git argv for a command run in `dir`. */
export function gitArgv(dir: string, ...args: string[]): string[] {
  return ['git', ...GIT_SAFE, '-C', dir, ...args]
}

/** Hardened git argv for a command with no working directory (clone, ls-remote). */
export function gitNoDir(...args: string[]): string[] {
  return ['git', ...GIT_SAFE, ...args]
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
      throw new Error(redact(`git ${c >= 0 ? argv[c + 2] : argv[GIT_SAFE.length + 1]} failed (exit ${r.exitCode}): ${detail}`, secrets))
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

/** The mod's own clone for a job (R20): cloned, fetched and pushed only by the mod, never an agent's cwd. */
export function modDir(workDirPath: string): string {
  return `${workDirPath}.mod`
}

/**
 * Rebuilds an agent's working directory as a fresh copy of the mod clone (R20):
 * whatever an earlier agent left in it (its .git/config, hooks, attributes) is
 * discarded before the mod or the next agent uses it. `--no-hardlinks` keeps the
 * agent from writing into the mod clone's object files through shared inodes.
 * The only git run inside `dir` is set-url on the clone just made.
 */
export async function prepareWorktree(run: RunFn, opts: { mod: string; dir: string; publicUrl: string }): Promise<void> {
  const { mod, dir, publicUrl } = opts
  const step = async (argv: string[], what: string) => {
    const r = await run(argv, {})
    if (r.exitCode !== 0) throw new Error(`${what} failed (exit ${r.exitCode}): ${`${r.stderr}\n${r.stdout}`.trim()}`)
  }
  await step(['rm', '-rf', dir], 'removing the old agent worktree')
  await step(gitNoDir('clone', '--no-hardlinks', '--quiet', mod, dir), 'git clone of the mod checkout')
  await step(gitArgv(dir, 'remote', 'set-url', 'origin', publicUrl), 'git remote set-url')
}
