import { expect, test } from 'claude-code/testing'
import { verify } from '../src/verify'
import type { RunFn } from '../src/worktree'
import type { RepoConfig } from '../src/config'

const cfg = { test: 'npm test', setup: 'npm ci', branchPrefix: 'factory/' } as RepoConfig
const base = { cloneUrl: 'https://x:tok123@host/r.git', branch: 'b', scratchDir: '/s', cfg, secrets: ['tok123'] }

function fake(h: (cmd: string) => { exitCode: number; stdout?: string; stderr?: string; timedOut?: boolean }) {
  const calls: string[][] = []
  const run: RunFn = async (argv) => {
    calls.push(argv)
    if (argv[0] === 'sh') { const r = h(argv[2]); return { stdout: '', stderr: '', ...r } }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { run, calls }
}

test('passes on exit 0', async () => {
  const f = fake(() => ({ exitCode: 0, stdout: 'ok' }))
  const r = await verify(f.run, base)
  expect(r.passed).toBe(true)
  expect(r.report.split('\n')[0]).toBe('<!-- factory:test-report passed=true -->')
  expect(f.calls[0]).toEqual(['rm', '-rf', '/s'])
  expect(f.calls[1]).toEqual(['git', 'clone', '--depth', '1', '--branch', 'b', base.cloneUrl, '/s'])
})
test('fails on exit 1 with log tail', async () => {
  const lines = Array.from({ length: 100 }, (_, i) => 'line' + i).join('\n')
  const f = fake((c) => (c === 'npm test' ? { exitCode: 1, stdout: lines } : { exitCode: 0 }))
  const r = await verify(f.run, base)
  expect(r.passed).toBe(false)
  expect(r.report).toContain('passed=false')
  expect(r.report).toContain('line99')
  expect(r.report).not.toContain('line10\n')
  expect(r.report).toContain('npm test')
})
test('setup failure skips test', async () => {
  const f = fake((c) => (c === 'npm ci' ? { exitCode: 2, stderr: 'boom' } : { exitCode: 0 }))
  const r = await verify(f.run, base)
  expect(r.passed).toBe(false)
  expect(f.calls.some((c) => c[2] === 'npm test')).toBe(false)
})
test('timeout', async () => {
  const f = fake(() => ({ exitCode: -1, timedOut: true }))
  const r = await verify(f.run, base)
  expect(r.passed).toBe(false)
  expect(r.report).toContain('timed out after 10 min')
})
test('redacts token in log', async () => {
  const f = fake(() => ({ exitCode: 1, stdout: 'leak tok123 ghp_ABCDEFGHIJKLMN' }))
  const r = await verify(f.run, base)
  expect(r.report).not.toContain('tok123')
  expect(r.report).not.toContain('ghp_')
})
test('clone failure is passed:false and redacted', async () => {
  const run: RunFn = async (argv) =>
    argv[1] === 'clone' ? { exitCode: 128, stdout: '', stderr: 'fatal ' + base.cloneUrl } : { exitCode: 0, stdout: '', stderr: '' }
  const r = await verify(run, base)
  expect(r.passed).toBe(false)
  expect(r.report).toContain('passed=false')
  expect(r.report).not.toContain('tok123')
})
