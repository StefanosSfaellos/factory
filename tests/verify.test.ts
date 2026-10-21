import { expect, test } from 'claude-code/testing'
import { verify } from '../src/verify'
import type { RunFn } from '../src/worktree'
import type { RepoConfig } from '../src/config'

const cfg = { test: 'npm test', setup: 'npm ci', branchPrefix: 'factory/' } as RepoConfig
const NO_TOKENS = ['env', '-u', 'GITHUB_TOKEN', '-u', 'GITLAB_TOKEN', '-u', 'GITLAB_URL', '-u', 'FACTORY_GITLAB_TOKEN']
/** The shell command of a repo-controlled run (`... sh -c <cmd>`), or undefined. */
const shOf = (argv: string[]) => { const i = argv.indexOf('sh'); return i >= 0 && argv[i + 1] === '-c' ? argv[i + 2] : undefined }
const base = { cloneUrl: 'https://x:tok123@host/r.git', publicUrl: 'https://host/r.git', branch: 'b', scratchDir: '/s', cfg, secrets: ['tok123'] }

function fake(h: (cmd: string) => { exitCode: number; stdout?: string; stderr?: string; timedOut?: boolean }) {
  const calls: string[][] = []
  const opts: { cwd?: string; timeoutMs?: number }[] = []
  const run: RunFn = async (argv, o) => {
    calls.push(argv)
    opts.push(o)
    const cmd = shOf(argv)
    if (cmd !== undefined) { const r = h(cmd); return { stdout: '', stderr: '', ...r } }
    return { exitCode: 0, stdout: '', stderr: '' }
  }
  return { run, calls, opts }
}

test('passes on exit 0', async () => {
  const f = fake(() => ({ exitCode: 0, stdout: 'ok' }))
  const r = await verify(f.run, base)
  expect(r.passed).toBe(true)
  expect(r.report.split('\n')[0]).toBe('<!-- factory:test-report passed=true -->')
  expect(f.calls[0]).toEqual(['rm', '-rf', '/s'])
  expect(f.calls[1]).toEqual(['env', '-u', 'GITHUB_TOKEN', '-u', 'GITLAB_TOKEN', '-u', 'GITLAB_URL', '-u', 'FACTORY_GITLAB_TOKEN', 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_NOSYSTEM=1', 'git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', '/', 'clone', '--depth', '1', '--branch', 'b', base.cloneUrl, '/s'])
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
  expect(f.calls.some((c) => shOf(c) === 'npm test')).toBe(false)
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
test('clone failure is a station error (thrown, redacted), not a failed test report', async () => {
  const run: RunFn = async (argv) =>
    argv.includes('clone') ? { exitCode: 128, stdout: '', stderr: 'fatal ' + base.cloneUrl } : { exitCode: 0, stdout: '', stderr: '' }
  let msg = ''
  try { await verify(run, base); msg = 'did not throw' } catch (e) { msg = (e as Error).message }
  expect(msg).toContain('git clone failed')
  expect(msg).not.toContain('tok123')
  expect(msg).not.toContain('passed=false')
})

test('clone timeout is a station error too', async () => {
  const run: RunFn = async (argv) =>
    argv.includes('clone') ? { exitCode: -1, stdout: '', stderr: 'timed out', timedOut: true } : { exitCode: 0, stdout: '', stderr: '' }
  let msg = ''
  try { await verify(run, base); msg = 'did not throw' } catch (e) { msg = (e as Error).message }
  expect(msg).toContain('git clone failed')
})

test('remote scrub failure is a station error, never runs the test command', async () => {
  const calls: string[][] = []
  const run: RunFn = async (argv) => {
    calls.push(argv)
    return argv.includes('set-url') ? { exitCode: 1, stdout: '', stderr: 'no' } : { exitCode: 0, stdout: '', stderr: '' }
  }
  let msg = ''
  try { await verify(run, base); msg = 'did not throw' } catch (e) { msg = (e as Error).message }
  expect(msg).toContain('set-url')
  expect(calls.some((c) => shOf(c) !== undefined)).toBe(false)
})

test('the network clone gets the 10 min timeout (not the 30 s default)', async () => {
  const f = fake(() => ({ exitCode: 0 }))
  await verify(f.run, base)
  const i = f.calls.findIndex((c) => c.includes('clone'))
  expect(f.opts[i]).toEqual({ timeoutMs: 600000 })
})

test('R18: setup and test run without forge tokens in their environment', async () => {
  const f = fake(() => ({ exitCode: 0 }))
  await verify(f.run, base)
  const sh = f.calls.filter((c) => shOf(c) !== undefined)
  expect(sh).toEqual([[...NO_TOKENS, 'sh', '-c', 'npm ci'], [...NO_TOKENS, 'sh', '-c', 'npm test']])
})

test('setup then test run in order with cwd and timeout', async () => {
  const f = fake(() => ({ exitCode: 0 }))
  await verify(f.run, base)
  const sh = f.calls.map((c, i) => ({ c, o: f.opts[i] })).filter((x) => shOf(x.c) !== undefined)
  expect(sh.map((x) => shOf(x.c))).toEqual(['npm ci', 'npm test'])
  for (const x of sh) expect(x.o).toEqual({ cwd: '/s', timeoutMs: 600000 })
})
test('blank test command fails without running', async () => {
  const f = fake(() => ({ exitCode: 0 }))
  const r = await verify(f.run, { ...base, cfg: { ...cfg, test: ' ' } as RepoConfig })
  expect(r.passed).toBe(false)
  expect(r.report).toContain('passed=false')
  expect(f.calls.some((c) => shOf(c) !== undefined)).toBe(false)
  expect(f.calls.some((c) => c.includes('git') && c.includes('clone'))).toBe(false)
})
test('setup passes, test times out', async () => {
  const f = fake((c) => (c === 'npm test' ? { exitCode: -1, timedOut: true } : { exitCode: 0 }))
  const r = await verify(f.run, base)
  expect(r.passed).toBe(false)
  expect(r.report).toContain('timed out after 10 min')
})

test('clone is followed immediately by set-url to the tokenless url', async () => {
  const f = fake(() => ({ exitCode: 0 }))
  await verify(f.run, base)
  const i = f.calls.findIndex((c) => c.includes('clone'))
  expect(f.calls[i + 1]).toEqual(['env', '-u', 'GITHUB_TOKEN', '-u', 'GITLAB_TOKEN', '-u', 'GITLAB_URL', '-u', 'FACTORY_GITLAB_TOKEN', 'GIT_CONFIG_GLOBAL=/dev/null', 'GIT_CONFIG_NOSYSTEM=1', 'git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', '/s', 'remote', 'set-url', 'origin', 'https://host/r.git'])
})

test('report records the tested commit sha', async () => {
  const run: RunFn = async (argv) =>
    argv.includes('rev-parse') ? { exitCode: 0, stdout: 'abc1234\n', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }
  const r = await verify(run, base)
  expect(r.sha).toBe('abc1234')
  expect(r.report.split('\n')[0]).toBe('<!-- factory:test-report passed=true sha=abc1234 -->')
})
