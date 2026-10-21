import { expect, test } from 'claude-code/testing'
import { childArgv, runAgent, type SpawnFn } from '../src/agents'
import type { RepoConfig } from '../src/config'

const cfg = { models: {}, allowedTools: [], protectedPaths: [] } as unknown as RepoConfig
const base = { prompt: 'do it', cfg, pluginRoot: '/plug', job: 'gitlab:g/p#7', worktree: '/wt' }

function after(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag)
  return i < 0 ? undefined : argv[i + 1]
}

test('childArgv: env prefix, claude invocation and namespaced agent', () => {
  const a = childArgv({ ...base, role: 'planner' })
  expect(a.slice(0, 9)).toEqual([
    'env', 'FACTORY_ROLE=planner', 'FACTORY_JOB=gitlab:g/p#7', 'FACTORY_WORKTREE=/wt',
    'FACTORY_SPEC_FILE=/wt/.factory/spec.md', 'FACTORY_PROTECTED=', 'claude', '-p', 'do it',
  ])
  expect(after(a, '--plugin-dir')).toBe('/plug')
  expect(after(a, '--agent')).toBe('software-factory:planner')
  expect(after(a, '--model')).toBe('sonnet')
  expect(after(a, '--permission-mode')).toBe('acceptEdits')
  expect(after(a, '--output-format')).toBe('stream-json')
  expect(a).toContain('--verbose')
  expect(a).not.toContain('--allowedTools')
  expect(a).not.toContain('--disallowedTools')
})

test('childArgv: passes protectedPaths to the child gate as FACTORY_PROTECTED', () => {
  const c = { ...cfg, protectedPaths: ['db/migrations/**', '.gitlab-ci.yml'] } as RepoConfig
  expect(childArgv({ ...base, cfg: c, role: 'builder' })).toContain('FACTORY_PROTECTED=db/migrations/**,.gitlab-ci.yml')
})

test('childArgv: security-reviewer is read-only and uses opus', () => {
  const a = childArgv({ ...base, role: 'security-reviewer' })
  expect(after(a, '--model')).toBe('opus')
  const i = a.indexOf('--disallowedTools')
  expect(i).toBeGreaterThan(-1)
  expect(a.slice(i + 1, i + 4)).toEqual(['Edit', 'Write', 'NotebookEdit'])
})

test('childArgv: approver and other reviewers are read-only, builder is not', () => {
  for (const role of ['code-reviewer', 'ux-reviewer', 'approver'] as const) {
    expect(childArgv({ ...base, role })).toContain('--disallowedTools')
  }
  expect(childArgv({ ...base, role: 'builder' })).not.toContain('--disallowedTools')
})

test('childArgv: builder gets repo allowedTools and model override', () => {
  const c = { ...cfg, allowedTools: ['Bash(composer *)', 'Bash(php *)'], models: { builder: 'opus' } } as RepoConfig
  const a = childArgv({ ...base, cfg: c, role: 'builder' })
  const i = a.indexOf('--allowedTools')
  expect(a.slice(i + 1, i + 3)).toEqual(['Bash(composer *)', 'Bash(php *)'])
  expect(after(a, '--model')).toBe('opus')
})

const asst = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } })
const toolUse = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } })
const result = (r: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: r, ...extra })

function fakeSpawn(lines: string[], exitCode = 0) {
  const calls: { argv: string[]; cwd: string }[] = []
  const spawn: SpawnFn = async (argv, opts) => {
    calls.push({ argv, cwd: opts.cwd })
    for (const l of lines) opts.onLine(l)
    return { exitCode }
  }
  return { spawn, calls }
}

test('runAgent returns final result and reports latest assistant text', async () => {
  const f = fakeSpawn([
    JSON.stringify({ type: 'system', subtype: 'init' }),
    'not json at all',
    asst('Reading the spec'),
    toolUse,
    asst('Task 1 done\nWriting test for task 2'),
    '',
    result('All tasks complete\nBUILD-DONE'),
  ])
  const progress: string[] = []
  const r = await runAgent(f.spawn, { ...base, role: 'builder', onProgress: t => progress.push(t) })
  expect(r).toEqual({ ok: true, output: 'All tasks complete\nBUILD-DONE' })
  expect(progress).toEqual(['Reading the spec', 'Writing test for task 2'])
  expect(f.calls[0].cwd).toBe('/wt')
  expect(f.calls[0].argv).toEqual(childArgv({ ...base, role: 'builder' }))
})

test('runAgent truncates progress to 120 chars', async () => {
  const long = 'x'.repeat(300)
  const f = fakeSpawn([asst(long), result('ok')])
  const progress: string[] = []
  await runAgent(f.spawn, { ...base, role: 'planner', onProgress: t => progress.push(t) })
  expect(progress[0].length).toBeLessThanOrEqual(120)
})

test('runAgent: non-zero exit is not ok even with a result', async () => {
  const f = fakeSpawn([result('partial')], 1)
  const r = await runAgent(f.spawn, { ...base, role: 'planner', onProgress: () => {} })
  expect(r.ok).toBe(false)
  expect(r.error).toContain('1')
})

test('runAgent: missing result is not ok', async () => {
  const f = fakeSpawn([asst('thinking')], 0)
  const r = await runAgent(f.spawn, { ...base, role: 'planner', onProgress: () => {} })
  expect(r.ok).toBe(false)
  expect(r.output).toBe('')
  expect(r.error).toContain('result')
})

test('runAgent: error result is not ok', async () => {
  const f = fakeSpawn([result('API error', { subtype: 'error_during_execution', is_error: true })], 0)
  const r = await runAgent(f.spawn, { ...base, role: 'planner', onProgress: () => {} })
  expect(r.ok).toBe(false)
  expect(r.output).toBe('API error')
})

test('runAgent: spawn rejection is not ok', async () => {
  const spawn: SpawnFn = async () => { throw new Error('ENOENT claude') }
  const r = await runAgent(spawn, { ...base, role: 'planner', onProgress: () => {} })
  expect(r.ok).toBe(false)
  expect(r.error).toContain('ENOENT')
})
