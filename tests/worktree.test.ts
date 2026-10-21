import { expect, test } from 'claude-code/testing'
import { branchName, workDir, ensureCheckout, gitArgv } from '../src/worktree'
import type { RunFn } from '../src/worktree'

const ref = { forge: 'github' as const, project: 'acme/shop', issue: 42 }

test('branch name slug', () => {
  expect(branchName(ref, 'Add .COM resale!', 'factory/')).toBe('factory/42-add-com-resale')
})
test('long titles truncate to 40-char slug', () => {
  const b = branchName(ref, 'a'.repeat(60), 'factory/')
  expect(b).toBe('factory/42-' + 'a'.repeat(40))
})
test('workDir layout', () => {
  expect(workDir('/r', ref)).toBe('/r/github/acme__shop/42')
})

function fake(exists: boolean, remoteBranch: boolean, failOn?: string) {
  const calls: string[][] = []
  const run: RunFn = async (argv) => {
    calls.push(argv)
    const j = argv.join(' ')
    if (argv[0] === 'test') return { exitCode: exists ? 0 : 1, stdout: '', stderr: '' }
    if (argv.includes('rev-parse')) return { exitCode: remoteBranch ? 0 : 1, stdout: '', stderr: '' }
    if (failOn && j.includes(failOn)) return { exitCode: 128, stdout: '', stderr: 'fatal: https://x:tok123@host/r.git denied' }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}
const o = { dir: '/d', cloneUrl: 'https://x:tok123@host/r.git', publicUrl: 'https://host/r.git', branch: 'factory/1-a', base: 'main' }

test('clones only when missing', async () => {
  const f = fake(false, false)
  await ensureCheckout(f.run, o)
  expect(f.calls.some((c) => c[0] === 'git' && c.includes('clone'))).toBe(true)
  expect(f.calls.some((c) => c.join(' ') === 'git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C /d checkout -B factory/1-a origin/main')).toBe(true)
  const g = fake(true, true)
  await ensureCheckout(g.run, o)
  expect(g.calls.some((c) => c.includes('clone'))).toBe(false)
  expect(g.calls.some((c) => c.join(' ') === 'git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C /d fetch https://x:tok123@host/r.git +refs/heads/*:refs/remotes/origin/*')).toBe(true)
  expect(g.calls.some((c) => c.join(' ') === 'git -c core.hooksPath=/dev/null -c core.fsmonitor=false -C /d checkout -B factory/1-a origin/factory/1-a')).toBe(true)
})
test('errors never include the clone url', async () => {
  const f = fake(false, false, 'clone')
  let msg = ''
  try { await ensureCheckout(f.run, o) } catch (e) { msg = (e as Error).message }
  expect(msg).not.toBe('')
  expect(msg.includes('tok123')).toBe(false)
  expect(msg.includes(o.cloneUrl)).toBe(false)
})

test('empty slug falls back to issue', () => {
  expect(branchName(ref, '!!!', 'factory/')).toBe('factory/42-issue')
})
test('extra secrets redacted in checkout errors', async () => {
  const run: RunFn = async (argv) =>
    argv[0] === 'test' ? { exitCode: 1, stdout: '', stderr: '' }
      : argv.includes('clone') ? { exitCode: 128, stdout: '', stderr: 'fatal: auth failed for token SECRETX' }
      : { exitCode: 0, stdout: '', stderr: '' }
  let msg = ''
  try { await ensureCheckout(run, { ...o, secrets: ['SECRETX'] }) } catch (e) { msg = (e as Error).message }
  expect(msg).toContain('auth failed')
  expect(msg.includes('SECRETX')).toBe(false)
})

test('clone is followed immediately by set-url to the tokenless url', async () => {
  const f = fake(false, false)
  await ensureCheckout(f.run, o)
  const i = f.calls.findIndex((c) => c.includes('clone'))
  expect(f.calls[i + 1]).toEqual(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', '/d', 'remote', 'set-url', 'origin', 'https://host/r.git'])
  expect(f.calls.some((c) => c.includes('fetch') && c.includes('origin'))).toBe(false)
})

test('gitArgv hardens against planted hooks and fsmonitor; every git call is hardened', async () => {
  expect(gitArgv('/d', 'status')).toEqual(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', '/d', 'status'])
  const f = fake(false, false)
  await ensureCheckout(f.run, o)
  for (const c of f.calls.filter((x) => x[0] === 'git')) expect(c.slice(1, 5)).toEqual(['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false'])
})
