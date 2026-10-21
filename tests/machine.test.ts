import { expect, test } from 'claude-code/testing'
import { stationOf, next, specDecision, fixLoopsOf } from '../src/machine'
import type { Job, Comment, Verdict } from '../src/types'
import type { Role } from '../src/config'

const job = (labels: string[], comments: Comment[] = []): Job => ({
  ref: { forge: 'github', project: 'o/r', issue: 1 },
  title: 't', body: '', labels, comments,
})
const c = (id: string, body: string, createdAt: string): Comment => ({ id, body, createdAt, author: 'u' })
const ctx = (fixLoops = 0, req: Role[] = ['code-reviewer', 'security-reviewer']) => ({ fixLoops, maxFixLoops: 3, requiredReviewers: req })
const v = (role: Role, pass: boolean): Verdict => ({ role, pass, findings: '' })

test('stationOf single label', () => {
  expect(stationOf(job(['bug', 'factory::build']))).toEqual({ station: 'build' })
})
test('stationOf ignores spec-approved', () => {
  expect(stationOf(job(['factory::awaiting-spec', 'factory::spec-approved']))).toEqual({ station: 'awaiting-spec' })
})
test('stationOf two labels invalid names both', () => {
  const r = stationOf(job(['factory::build', 'factory::review'])) as { invalid: string }
  expect(r.invalid).toContain('factory::build')
  expect(r.invalid).toContain('factory::review')
})
test('stationOf none invalid', () => {
  expect('invalid' in stationOf(job(['bug']))).toBe(true)
})
test('stationOf unknown factory label invalid', () => {
  expect('invalid' in stationOf(job(['factory::bogus']))).toBe(true)
})

const rows: [string, Parameters<typeof next>[0], Parameters<typeof next>[1], string, number][] = [
  ['ready+picked', 'ready', { kind: 'picked' }, 'spec', 0],
  ['spec+artifact', 'spec', { kind: 'artifact-posted' }, 'awaiting-spec', 0],
  ['awaiting+approve', 'awaiting-spec', { kind: 'spec-decision', approve: true }, 'design', 0],
  ['awaiting+revise', 'awaiting-spec', { kind: 'spec-decision', approve: false, notes: 'x' }, 'spec', 0],
  ['design', 'design', { kind: 'artifact-posted' }, 'plan', 0],
  ['plan', 'plan', { kind: 'artifact-posted' }, 'build', 0],
  ['build done', 'build', { kind: 'build-done' }, 'verify', 0],
  ['verify pass', 'verify', { kind: 'verify', passed: true }, 'review', 0],
  ['verify fail', 'verify', { kind: 'verify', passed: false }, 'build', 1],
  ['review all pass', 'review', { kind: 'verdicts', verdicts: [v('code-reviewer', true), v('security-reviewer', true)] }, 'approve', 0],
  ['review one fail', 'review', { kind: 'verdicts', verdicts: [v('code-reviewer', true), v('security-reviewer', false)] }, 'build', 1],
  ['review missing', 'review', { kind: 'verdicts', verdicts: [v('code-reviewer', true)] }, 'review', 0],
  ['approve+mr', 'approve', { kind: 'mr-opened' }, 'mr-open', 0],
  ['error not retried', 'build', { kind: 'error', message: 'm', retried: false }, 'build', 0],
  ['error retried', 'build', { kind: 'error', message: 'm', retried: true }, 'blocked', 0],
]
for (const [name, st, ev, want, loops] of rows) {
  test(`next: ${name}`, () => {
    const r = next(st, ev, ctx())
    expect(r.station).toBe(want)
    expect(r.fixLoops).toBe(loops)
  })
}

test('fix loop limit blocks (verify)', () => {
  const r = next('verify', { kind: 'verify', passed: false }, ctx(2))
  expect(r.station).toBe('blocked')
  expect(r.reason).toContain('fix loop')
})
test('fix loop limit blocks (review)', () => {
  const r = next('review', { kind: 'verdicts', verdicts: [v('code-reviewer', false), v('security-reviewer', true)] }, ctx(2))
  expect(r.station).toBe('blocked')
  expect(r.reason).toContain('fix loop')
})
test('irrelevant event stays', () => {
  expect(next('plan', { kind: 'mr-opened' }, ctx()).station).toBe('plan')
})

test('specDecision label approves', () => {
  expect(specDecision(job(['factory::awaiting-spec', 'factory::spec-approved']))).toEqual({ approve: true })
})
test('specDecision /approve newer than spec', () => {
  const j = job([], [c('1', '<!-- factory:spec -->\nspec', '2026-01-01T00:00:00Z'), c('2', '/approve', '2026-01-02T00:00:00Z')])
  expect(specDecision(j)).toEqual({ approve: true })
})
test('specDecision /approve older than spec is none', () => {
  const j = job([], [c('2', '/approve', '2026-01-01T00:00:00Z'), c('1', '<!-- factory:spec -->\nspec', '2026-01-02T00:00:00Z')])
  expect(specDecision(j)).toEqual({ none: true })
})
test('specDecision /revise with notes', () => {
  const j = job([], [c('1', '<!-- factory:spec -->', '2026-01-01T00:00:00Z'), c('2', '/revise add auth', '2026-01-02T00:00:00Z')])
  expect(specDecision(j)).toEqual({ approve: false, notes: 'add auth' })
})
test('specDecision /revise empty notes invalid', () => {
  const j = job([], [c('1', '<!-- factory:spec -->', '2026-01-01T00:00:00Z'), c('2', '/revise', '2026-01-02T00:00:00Z')])
  expect((specDecision(j) as { invalid: string }).invalid).toContain('notes')
})
test('specDecision newest wins', () => {
  const j = job([], [c('1', '<!-- factory:spec -->', '2026-01-01T00:00:00Z'), c('2', '/revise x', '2026-01-02T00:00:00Z'), c('3', '/approve', '2026-01-03T00:00:00Z')])
  expect(specDecision(j)).toEqual({ approve: true })
})
test('specDecision no comments none', () => {
  expect(specDecision(job([]))).toEqual({ none: true })
})

test('fixLoopsOf counts failed verdicts and test reports', () => {
  const j = job([], [
    c('1', '<!-- factory:verdict role=code-reviewer pass=false -->\nbad', 't1'),
    c('2', '<!-- factory:verdict role=code-reviewer pass=true -->', 't2'),
    c('3', '<!-- factory:test-report passed=false exit=1 -->', 't3'),
    c('4', '<!-- factory:test-report passed=true exit=0 -->', 't4'),
    c('5', 'mentions <!-- factory:verdict pass=false --> not first line'.replace('mentions ', 'hello\n'), 't5'),
    c('6', '<!-- factory:spec -->', 't6'),
  ])
  expect(fixLoopsOf(j)).toBe(2)
})
