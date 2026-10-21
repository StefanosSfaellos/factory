import { expect, test } from 'claude-code/testing'
import { redact } from '../src/redact'

test('redacts secret values and token patterns', () => {
  expect(redact('tok=abc123secret ghp_ABCDEFGHIJKLMN', ['abc123secret'])).toBe('tok=[redacted] [redacted]')
})
test('redacts gitlab pat', () => {
  expect(redact('glpat-xxxxxxxxxxxxxxxx', [])).toBe('[redacted]')
})
test('empty secrets array still redacts patterns', () => {
  expect(redact('a ghp_ABCDEFGHIJKLMN b', [])).toBe('a [redacted] b')
})
test('ignores empty secret strings and redacts all occurrences', () => {
  expect(redact('x s3cret y s3cret', ['', 's3cret'])).toBe('x [redacted] y [redacted]')
})
test('leaves clean text alone', () => {
  expect(redact('nothing here', ['zzz'])).toBe('nothing here')
})
