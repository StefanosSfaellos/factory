import { expect, test } from 'claude-code/testing'
import { parseCommand, parseRepos, resolveIssue } from '../src/commands'

test('parseCommand covers every subcommand', () => {
  expect(parseCommand('')).toEqual({ kind: 'open' })
  expect(parseCommand('  tick ')).toEqual({ kind: 'tick' })
  expect(parseCommand('new Fix VAT rounding -- Totals are off\nby a cent')).toEqual({ kind: 'new', title: 'Fix VAT rounding', body: 'Totals are off\nby a cent' })
  expect(parseCommand('new Just a title')).toEqual({ kind: 'new', title: 'Just a title', body: '' })
  expect(parseCommand('run #42')).toEqual({ kind: 'run', issue: '#42' })
  expect(parseCommand('status')).toEqual({ kind: 'status' })
  expect(parseCommand('status gitlab:group/sub/name#42')).toEqual({ kind: 'status', issue: 'gitlab:group/sub/name#42' })
  expect(parseCommand('approve github:o/r#7')).toEqual({ kind: 'approve', issue: 'github:o/r#7' })
  expect(parseCommand('revise #4 handle refunds too')).toEqual({ kind: 'revise', issue: '#4', notes: 'handle refunds too' })
  expect(parseCommand('pause')).toEqual({ kind: 'pause' })
  expect(parseCommand('resume')).toEqual({ kind: 'resume' })
})

test('parseCommand rejects malformed input', () => {
  const err = (s: string) => { const r = parseCommand(s); return r.kind === 'error' ? r.message : `not an error: ${r.kind}` }
  expect(err('frobnicate')).toContain('unknown subcommand')
  expect(err('new')).toContain('title')
  expect(err('new -- body only')).toContain('title')
  expect(err('run')).toContain('issue')
  expect(err('approve')).toContain('issue')
  expect(err('run 42')).toContain('#42')
  expect(err('revise #4')).toContain('notes')
  expect(err('revise')).toContain('issue')
  expect(err('tick now')).toContain('tick')
})

test('parseRepos reads forge:project lists and reports bad entries', () => {
  expect(parseRepos('')).toEqual({ projects: [], errors: [] })
  expect(parseRepos(' github:o/r , gitlab:g/sub/p ')).toEqual({
    projects: [{ forge: 'github', project: 'o/r' }, { forge: 'gitlab', project: 'g/sub/p' }], errors: [],
  })
  expect(parseRepos('bitbucket:x/y,o/r').errors).toEqual([
    'bad repo "bitbucket:x/y" (use github:owner/name or gitlab:group/name)',
    'bad repo "o/r" (use github:owner/name or gitlab:group/name)',
  ])
})

test('resolveIssue: #N needs exactly one configured repo; full refs always work', () => {
  const one = [{ forge: 'gitlab' as const, project: 'g/p' }]
  const two = [...one, { forge: 'github' as const, project: 'o/r' }]
  expect(resolveIssue('#42', one)).toEqual({ ref: { forge: 'gitlab', project: 'g/p', issue: 42 } })
  for (const ps of [[], two]) {
    const r = resolveIssue('#42', ps)
    expect('error' in r && r.error).toContain('gitlab:group/name#42')
    expect('error' in r && r.error).toContain('github:owner/name#42')
  }
  expect(resolveIssue('github:o/r#7', [])).toEqual({ ref: { forge: 'github', project: 'o/r', issue: 7 } })
  expect(resolveIssue('gitlab:a/b/c#9', two)).toEqual({ ref: { forge: 'gitlab', project: 'a/b/c', issue: 9 } })
  expect('error' in resolveIssue('gitlab:#9', one)).toBe(true)
  expect('error' in resolveIssue('#0', one)).toBe(true)
})
