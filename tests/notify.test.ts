import { expect, test } from 'claude-code/testing'
import { slackPayload, slackEvents } from '../src/notify'
import type { JobRef } from '../src/types'

const ref: JobRef = { forge: 'gitlab', project: 'g/p', issue: 7 }

test('mr-opened payload carries the title and the URL', () => {
  const p = JSON.parse(slackPayload({ ref, title: 'Add login', kind: 'mr-opened', url: 'https://x/mr/1' }))
  expect(p.text).toContain('Add login')
  expect(p.text).toContain('https://x/mr/1')
})

test('a token in detail is redacted', () => {
  const p = slackPayload({ ref, title: 't', kind: 'blocked', url: 'u', detail: 'failed with glpat-abcdefghijklmnop' }, ['hooks.slack.com/T0/B0/XYZ'])
  expect(p).not.toContain('glpat-')
  expect(p).toContain('[redacted]')
})

test('a secret passed in is redacted everywhere', () => {
  const p = slackPayload({ ref, title: 'hooks.slack.com/T0/B0/XYZ', kind: 'blocked', url: 'u' }, ['hooks.slack.com/T0/B0/XYZ'])
  expect(p).not.toContain('XYZ')
})

test('slackEvents fires once per job#to and only for the three stations', async () => {
  const other: JobRef = { ...ref, issue: 8 }
  const evs = await slackEvents(
    [
      { ref, from: 'spec', to: 'awaiting-spec', needsHuman: true },
      { ref, from: 'spec', to: 'awaiting-spec', needsHuman: true },
      { ref: other, from: 'build', to: 'verify', needsHuman: false },
      { ref: other, from: 'approve', to: 'mr-open', needsHuman: true },
      { ref, from: 'plan', to: 'blocked', needsHuman: true },
    ],
    async (r) => ({ title: `job ${r.issue}`, issueUrl: 'https://i', mrUrl: r.issue === 8 ? 'https://mr' : undefined, blockedReason: 'because' }),
  )
  expect(evs.map((e) => [e.kind, e.ref.issue, e.url, e.detail])).toEqual([
    ['needs-spec-review', 7, 'https://i', undefined],
    ['mr-opened', 8, 'https://mr', undefined],
    ['blocked', 7, 'https://i', 'because'],
  ])
})

test('mr-opened falls back to the issue URL', async () => {
  const evs = await slackEvents([{ ref, from: 'approve', to: 'mr-open', needsHuman: true }], async () => ({ title: 't', issueUrl: 'https://i' }))
  expect(evs[0]?.url).toBe('https://i')
})

test('a loader failure drops that event, not the others', async () => {
  const evs = await slackEvents(
    [{ ref, from: 'a' as never, to: 'blocked', needsHuman: true }, { ref: { ...ref, issue: 9 }, from: 'a' as never, to: 'blocked', needsHuman: true }],
    async (r) => { if (r.issue === 7) throw new Error('x'); return { title: 't', issueUrl: 'i' } },
  )
  expect(evs.map((e) => e.ref.issue)).toEqual([9])
})
