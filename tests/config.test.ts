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

test('empty reviewers list is rejected', () => {
  const r = parseRepoConfig('forge: github\ntest: x\nreviewers: []\n')
  expect(r.ok).toBe(false)
  if (!r.ok) expect(r.error).toContain('reviewers')
})

// ---- R24: sandbox ----
test('sandbox defaults: no domains, not required', () => {
  const r = parseRepoConfig('forge: github\ntest: npm test\n')
  expect(r.ok).toBe(true)
  if (!r.ok) return
  expect(r.config.sandbox).toEqual({ allowedDomains: [], required: false })
})
test('sandbox example parses (block and inline forms)', () => {
  const block = parseRepoConfig('forge: gitlab\ntest: composer test\nsandbox:\n  allowedDomains: ["repo.packagist.org", "*.github.com"]\n  required: true\n')
  expect(block.ok).toBe(true)
  if (block.ok) expect(block.config.sandbox).toEqual({ allowedDomains: ['repo.packagist.org', '*.github.com'], required: true })
  const inline = parseRepoConfig('forge: gitlab\ntest: composer test\nsandbox: { allowedDomains: [registry.npmjs.org] }\n')
  expect(inline.ok).toBe(true)
  if (inline.ok) expect(inline.config.sandbox).toEqual({ allowedDomains: ['registry.npmjs.org'], required: false })
})
test('the template/README sandbox example parses', () => {
  const r = parseRepoConfig(TEMPLATE_WITH_SANDBOX)
  expect(r.ok).toBe(true)
  if (r.ok) expect(r.config.sandbox.allowedDomains).toEqual(['repo.packagist.org', '*.github.com'])
})
test('sandbox validation: non-string domain, non-boolean required, non-map', () => {
  const bad = (y: string) => parseRepoConfig(`forge: github\ntest: npm test\n${y}`)
  const d = bad('sandbox: { allowedDomains: [ok.example, 3] }\n')
  expect(d.ok).toBe(false)
  if (!d.ok) expect(d.error).toContain('sandbox.allowedDomains')
  const q = bad('sandbox: { required: yes }\n')
  expect(q.ok).toBe(false)
  if (!q.ok) expect(q.error).toContain('sandbox.required')
  expect(bad('sandbox: [a]\n').ok).toBe(false)
  const u = bad('sandbox: { allowedDomain: [x] }\n')
  expect(u.ok).toBe(false)
  if (!u.ok) expect(u.error).toContain('allowedDomain')
})

const TEMPLATE_WITH_SANDBOX = `forge: gitlab
test: "composer test"
sandbox:
  allowedDomains: ["repo.packagist.org", "*.github.com"]
  required: false
`
