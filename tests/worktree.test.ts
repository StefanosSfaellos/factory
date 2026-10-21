import { expect, test } from 'claude-code/testing'
import { branchName, workDir, ensureCheckout } from '../src/worktree'
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
const o = { dir: '/d', cloneUrl: 'https://x:tok123@host/r.git', branch: 'factory/1-a', base: 'main' }

test('clones only when missing', async () => {
  const f = fake(false, false)
  await ensureCheckout(f.run, o)
  expect(f.calls.some((c) => c[0] === 'git' && c[1] === 'clone')).toBe(true)
  expect(f.calls.some((c) => c.join(' ') === 'git -C /d checkout -B factory/1-a origin/main')).toBe(true)
  const g = fake(true, true)
  await ensureCheckout(g.run, o)
  expect(g.calls.some((c) => c[1] === 'clone')).toBe(false)
  expect(g.calls.some((c) => c.join(' ') === 'git -C /d fetch origin')).toBe(true)
  expect(g.calls.some((c) => c.join(' ') === 'git -C /d checkout -B factory/1-a origin/factory/1-a')).toBe(true)
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
  const f = fake(false, false, 'clone')
  let msg = ''
  try { await ensureCheckout(f.run, { ...o, secrets: ['host'] }) } catch (e) { msg = (e as Error).message }
  expect(msg.includes('host')).toBe(false)
})
