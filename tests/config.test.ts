import { expect, test } from 'claude-code/testing'
import { parseRepoConfig, modelFor } from '../src/config'

const SPEC = `forge: gitlab            # github | gitlab
test: "composer test"   # command the verify station runs; must exit 0
setup: "composer install --no-interaction"   # optional, run before test
reviewers: [code, security, ux]   # which review stations are required
protectedPaths: ["db/migrations/**", ".gitlab-ci.yml"]
models: { builder: sonnet }       # optional overrides
limits: { fixLoops: 3, parallel: 2 }
branchPrefix: factory/
`

test('spec example parses', () => {
  const r = parseRepoConfig(SPEC)
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.config.limits.fixLoops).toBe(3)
  expect(r.config.reviewers).toEqual(['code', 'security', 'ux'])
  expect(r.config.protectedPaths).toEqual(['db/migrations/**', '.gitlab-ci.yml'])
  expect(r.config.allowedTools).toEqual([])
})
test('defaults', () => {
  const r = parseRepoConfig('forge: github\ntest: npm test\n')
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.config.reviewers).toEqual(['code', 'security'])
  expect(r.config.limits).toEqual({ fixLoops: 3, parallel: 2 })
  expect(r.config.branchPrefix).toBe('factory/')
})
test('missing forge', () => {
  const r = parseRepoConfig('test: npm test\n')
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toContain('forge')
})
test('missing test', () => {
  const r = parseRepoConfig('forge: github\n')
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toContain('test')
})
test('bad reviewer', () => {
  const r = parseRepoConfig('forge: github\ntest: x\nreviewers: [code, perf]\n')
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toContain('perf')
})
test('yaml error is reported, not thrown', () => {
  const r = parseRepoConfig('\tforge: github')
  expect(r.ok).toBe(false)
})
test('modelFor', () => {
  const a = parseRepoConfig('forge: github\ntest: x\n')
  const b = parseRepoConfig('forge: github\ntest: x\nmodels: { builder: opus }\n')
  if (!a.ok || !b.ok) throw new Error('parse')
  expect(modelFor('builder', a.config)).toBe('sonnet')
  expect(modelFor('spec-writer', a.config)).toBe('opus')
  expect(modelFor('builder', b.config)).toBe('opus')
})
