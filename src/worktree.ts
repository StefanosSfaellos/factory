import type { JobRef } from './types'
import { redact } from './redact'

export type RunFn = (
  argv: string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>

export function branchName(ref: JobRef, title: string, prefix: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `${prefix}${ref.issue}-${slug}`
}

export function workDir(root: string, ref: JobRef): string {
  return `${root}/${ref.forge}/${ref.project.replace(/\//g, '__')}/${ref.issue}`
}

export async function ensureCheckout(
  run: RunFn,
  opts: { dir: string; cloneUrl: string; branch: string; base: string },
): Promise<void> {
  const { dir, cloneUrl, branch, base } = opts
  const git = async (argv: string[]): Promise<{ exitCode: number }> => {
    const r = await run(argv, {})
    if (r.exitCode !== 0) {
      const detail = `${r.stderr}\n${r.stdout}`.trim()
      throw new Error(redact(`git ${argv[1] === '-C' ? argv[3] : argv[1]} failed (exit ${r.exitCode}): ${detail}`, [cloneUrl]))
    }
    return r
  }
  const exists = (await run(['test', '-d', dir], {})).exitCode === 0
  if (!exists) await git(['git', 'clone', cloneUrl, dir])
  await git(['git', '-C', dir, 'fetch', 'origin'])
  const remote = await run(['git', '-C', dir, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`], {})
  const from = remote.exitCode === 0 ? branch : base
  await git(['git', '-C', dir, 'checkout', '-B', branch, `origin/${from}`])
}
