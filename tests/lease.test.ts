import { expect, test } from 'claude-code/testing'
import { decideLease, leaseBody } from '../src/lease'
import { parseMarker } from '../src/markers'
import type { Comment } from '../src/types'

const NOW = Date.parse('2026-01-01T12:00:00Z')
const lease = (id: string, worker: string, untilMs: number, createdAt: string): Comment => ({
  id, author: 'bot', createdAt,
  body: `<!-- factory:lease worker=${worker} until=${new Date(untilMs).toISOString()} -->`,
})

test('no leases acquires', () => {
  expect(decideLease([], 'me', NOW)).toEqual({ action: 'acquire' })
})
test("other's unexpired lease backs off", () => {
  const cs = [lease('1', 'them', NOW + 10 * 60000, '2026-01-01T11:55:00Z')]
  expect(decideLease(cs, 'me', NOW)).toEqual({ action: 'back-off', holder: 'them' })
})
test("other's expired lease acquires", () => {
  const cs = [lease('1', 'them', NOW - 60000, '2026-01-01T11:40:00Z')]
  expect(decideLease(cs, 'me', NOW)).toEqual({ action: 'acquire' })
})
test('own lease renews with its id', () => {
  const cs = [lease('7', 'me', NOW + 5 * 60000, '2026-01-01T11:55:00Z')]
  expect(decideLease(cs, 'me', NOW)).toEqual({ action: 'renew', existingId: '7' })
})
test('own expired lease acquires', () => {
  const cs = [lease('7', 'me', NOW - 1000, '2026-01-01T11:40:00Z')]
  expect(decideLease(cs, 'me', NOW)).toEqual({ action: 'acquire' })
})
test('two leases: earliest wins', () => {
  const cs = [
    lease('2', 'me', NOW + 600000, '2026-01-01T11:59:00Z'),
    lease('1', 'them', NOW + 600000, '2026-01-01T11:58:00Z'),
  ]
  expect(decideLease(cs, 'me', NOW)).toEqual({ action: 'back-off', holder: 'them' })
  const cs2 = [
    lease('2', 'them', NOW + 600000, '2026-01-01T11:59:00Z'),
    lease('1', 'me', NOW + 600000, '2026-01-01T11:58:00Z'),
  ]
  expect(decideLease(cs2, 'me', NOW)).toEqual({ action: 'renew', existingId: '1' })
})
test('leaseBody is a lease marker with until = now + minutes', () => {
  const p = parseMarker(leaseBody('me', NOW))
  expect(p?.kind).toBe('lease')
  expect(p?.attrs.worker).toBe('me')
  expect(p?.attrs.until).toBe(new Date(NOW + 15 * 60000).toISOString())
  expect(parseMarker(leaseBody('me', NOW, 5))?.attrs.until).toBe(new Date(NOW + 5 * 60000).toISOString())
})
