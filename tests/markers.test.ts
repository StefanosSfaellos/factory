import { expect, test } from 'claude-code/testing'
import { marker, parseMarker, findLatest, verdictComment, parseVerdict } from '../src/markers'
import type { Comment } from '../src/types'

const c = (id: string, body: string, createdAt: string): Comment => ({ id, body, createdAt, author: 'u' })

test('marker round-trip', () => {
  const m = marker('spec', { a: '1', b: 'x' })
  expect(m).toBe('<!-- factory:spec a=1 b=x -->')
  expect(parseMarker(m)).toEqual({ kind: 'spec', attrs: { a: '1', b: 'x' } })
})
test('marker without attrs', () => {
  expect(marker('plan', {})).toBe('<!-- factory:plan -->')
  expect(parseMarker('<!-- factory:plan -->')).toEqual({ kind: 'plan', attrs: {} })
})
test('marker rejects values with spaces', () => {
  expect(() => marker('spec', { a: 'x y' })).toThrow()
})
test('parseMarker non-marker is null', () => {
  expect(parseMarker('hello')).toBeNull()
})
test('parseMarker only looks at first line', () => {
  expect(parseMarker('hello\n<!-- factory:spec -->')).toBeNull()
  expect(parseMarker('<!-- factory:spec k=v -->\nbody')).toEqual({ kind: 'spec', attrs: { k: 'v' } })
})
test('findLatest by createdAt', () => {
  const cs = [
    c('1', '<!-- factory:spec -->', '2026-01-02T00:00:00Z'),
    c('2', '<!-- factory:spec -->', '2026-01-03T00:00:00Z'),
    c('3', '<!-- factory:plan -->', '2026-01-04T00:00:00Z'),
    c('4', 'hi', '2026-01-05T00:00:00Z'),
  ]
  expect(findLatest(cs, 'spec')?.id).toBe('2')
  expect(findLatest(cs, 'blocked')).toBeUndefined()
})
test('verdict round-trip keeps multi-line findings', () => {
  const body = verdictComment({ role: 'code-reviewer', pass: false, findings: 'a\n\n- b\n- c' }, 2)
  expect(body.split('\n')[0]).toBe('<!-- factory:verdict role=code-reviewer pass=false round=2 -->')
  expect(parseVerdict(c('1', body, 't'))).toEqual({ role: 'code-reviewer', pass: false, findings: 'a\n\n- b\n- c' })
})
test('verdict pass=true with empty findings', () => {
  const body = verdictComment({ role: 'ux-reviewer', pass: true, findings: '' }, 1)
  expect(parseVerdict(c('1', body, 't'))).toEqual({ role: 'ux-reviewer', pass: true, findings: '' })
})
test('parseVerdict rejects non-verdicts and bad attrs', () => {
  expect(parseVerdict(c('1', 'hello', 't'))).toBeNull()
  expect(parseVerdict(c('1', '<!-- factory:spec -->', 't'))).toBeNull()
  expect(parseVerdict(c('1', '<!-- factory:verdict role=code-reviewer pass=maybe -->', 't'))).toBeNull()
  expect(parseVerdict(c('1', '<!-- factory:verdict pass=true -->', 't'))).toBeNull()
})

test('verdictComment records an optional sha', () => {
  expect(verdictComment({ role: 'code-reviewer', pass: true, findings: '' }, 2, 'abc1234'))
    .toBe('<!-- factory:verdict role=code-reviewer pass=true round=2 sha=abc1234 -->')
})
