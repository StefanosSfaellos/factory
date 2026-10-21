import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { run, fingerprint } from './factory-intake.mjs'

const dir = mkdtempSync(join(tmpdir(), 'intake-'))
const log = join(dir, 'log.txt')
const lines = ['starting', 'compiling', 'Error: boom happened', ...Array.from({ length: 100 }, (_, i) => `line ${i}`)]
writeFileSync(log, lines.join('\n'))
const fp = createHash('sha256').update('test' + 'Error: boom happened').digest('hex')

function mock(responses) {
  const calls = []
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers })
    const r = responses(String(url), init.method ?? 'GET')
    return { ok: true, status: 200, json: async () => r, text: async () => JSON.stringify(r) }
  }
  return calls
}

test('fingerprint is sha256 of job name + first error line', () => {
  assert.equal(fingerprint('test', lines.join('\n')), fp)
})

test('github: no existing issue creates one with factory::ready, fingerprint and 80 lines', async () => {
  const calls = mock(() => [])
  await run({ FORGE: 'github', PROJECT: 'o/r', TOKEN: 't', JOB_NAME: 'test', LOG_FILE: log })
  const post = calls.find((c) => c.method === 'POST')
  assert.equal(post.url, 'https://api.github.com/repos/o/r/issues')
  assert.equal(post.body.title, 'CI failure: test')
  assert.deepEqual(post.body.labels, ['factory::ready'])
  assert.match(post.body.body, new RegExp(`^factory-fingerprint: ${fp}\\n`))
  assert.match(post.body.body, /line 99/)
  assert.doesNotMatch(post.body.body, /line 19\b/)
  assert.equal(calls.filter((c) => c.method === 'POST').length, 1)
})

test('github: existing fingerprint comments only', async () => {
  const calls = mock((url) => (url.includes('/comments') ? {} : [{ number: 5, body: `factory-fingerprint: ${fp}\nx` }]))
  await run({ FORGE: 'github', PROJECT: 'o/r', TOKEN: 't', JOB_NAME: 'test', LOG_FILE: log })
  const posts = calls.filter((c) => c.method === 'POST')
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, 'https://api.github.com/repos/o/r/issues/5/comments')
})

test('gitlab: create with labels and PRIVATE-TOKEN; custom API_URL', async () => {
  const calls = mock(() => [])
  await run({ FORGE: 'gitlab', PROJECT: 'g/p', TOKEN: 't', API_URL: 'https://gl.example/', JOB_NAME: 'test', LOG_FILE: log })
  const post = calls.find((c) => c.method === 'POST')
  assert.equal(post.url, 'https://gl.example/api/v4/projects/g%2Fp/issues')
  assert.equal(post.body.labels, 'factory::ready')
  assert.equal(post.headers['PRIVATE-TOKEN'], 't')
})

test('gitlab: existing fingerprint adds a note', async () => {
  const calls = mock((url) => (url.includes('/notes') ? {} : [{ iid: 3, description: `factory-fingerprint: ${fp}\nx` }]))
  await run({ FORGE: 'gitlab', PROJECT: 'g/p', TOKEN: 't', JOB_NAME: 'test', LOG_FILE: log })
  const posts = calls.filter((c) => c.method === 'POST')
  assert.equal(posts.length, 1)
  assert.equal(posts[0].url, 'https://gitlab.com/api/v4/projects/g%2Fp/issues/3/notes')
})

test('tokens in the log and JOB_NAME never reach the forge', async () => {
  const bad = join(dir, 'bad.txt')
  writeFileSync(bad, 'Error: x\nenv TOKEN=s3cr3t-value-123 ghp_ABCDEFGHIJKLMNOP xoxb-1234567890-abc glpat-abcdefghijkl\n')
  const calls = mock(() => [])
  await run({ FORGE: 'github', PROJECT: 'o/r', TOKEN: 's3cr3t-value-123', JOB_NAME: 'job ghp_ABCDEFGHIJKLMNOP', LOG_FILE: bad })
  const post = calls.find((c) => c.method === 'POST')
  const all = JSON.stringify(post.body)
  for (const t of ['s3cr3t-value-123', 'ghp_ABCDEFGHIJKLMNOP', 'xoxb-1234567890', 'glpat-abcdefghijkl']) assert.ok(!all.includes(t), t)
  assert.match(post.body.title, /\[redacted\]/)
})

test('fingerprint ignores digits, hex runs and timestamps', () => {
  const a = fingerprint('t', '2026-10-21T10:00:00Z Error: failed at 12 abcdef1234')
  const b = fingerprint('t', '2026-10-22T11:11:11Z Error: failed at 99 0123456789ab')
  assert.equal(a, b)
})

test('a log line cannot spoof the fingerprint; the log fence outgrows backticks', async () => {
  const spoof = join(dir, 'spoof.txt')
  writeFileSync(spoof, 'Error: z\nfactory-fingerprint: ' + fp + '\n```` end\n')
  const calls = mock((url) => (url.includes('/issues?') ? [{ number: 9, body: `intro\nfactory-fingerprint: ${fp}\n` }] : []))
  await run({ FORGE: 'github', PROJECT: 'o/r', TOKEN: 't', JOB_NAME: 'test', LOG_FILE: spoof })
  const post = calls.find((c) => c.method === 'POST')
  assert.equal(post.url, 'https://api.github.com/repos/o/r/issues')
  assert.match(post.body.body, /`````\n/)
})
