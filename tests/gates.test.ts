import { expect, mock, test } from 'claude-code/testing'
import { gate, type GateCtx } from '../src/gates'
import type { Role } from '../src/config'

const ctx = (role: Role | undefined, extra: Partial<GateCtx> = {}): GateCtx =>
  ({ role, worktree: '/w', protectedPaths: [], specText: '', ...extra })
const bash = (command: string) => ({ tool: 'Bash', input: { command } })
const edit = (file_path: string) => ({ tool: 'Edit', input: { file_path, old_string: 'a', new_string: 'b' } })
const denied = (r: ReturnType<typeof gate>) => 'deny' in r
const READ_ONLY: Role[] = ['spec-writer', 'designer', 'planner', 'code-reviewer', 'security-reviewer', 'ux-reviewer', 'approver']

// --- brief cases ---

test('builder git push is denied', () => {
  expect(denied(gate(bash('git push origin x'), ctx('builder')))).toBe(true)
})

test('reviewer Edit is denied', () => {
  expect(denied(gate(edit('/w/src/a.php'), ctx('code-reviewer')))).toBe(true)
})

test('builder Edit inside the worktree is allowed, outside is denied', () => {
  expect(gate(edit('/w/src/a.php'), ctx('builder'))).toEqual({ allow: true })
  expect(denied(gate(edit('/etc/x'), ctx('builder')))).toBe(true)
})

test('protected path is denied unless the spec names it', () => {
  const p = { protectedPaths: ['db/migrations/**'] }
  expect(denied(gate(edit('/w/db/migrations/2026_add.sql'), ctx('builder', p)))).toBe(true)
  expect(gate(edit('/w/db/migrations/2026_add.sql'), ctx('builder', { ...p, specText: 'Add db/migrations/2026_add.sql' }))).toEqual({ allow: true })
  expect(gate(edit('/w/src/a.php'), ctx('builder', p))).toEqual({ allow: true })
})

test('git push -f and git reset --hard are denied even with no role', () => {
  expect(denied(gate(bash('git push -f'), ctx(undefined)))).toBe(true)
  expect(denied(gate(bash('git push --force origin main'), ctx(undefined)))).toBe(true)
  expect(denied(gate(bash('git reset --hard HEAD~1'), ctx(undefined)))).toBe(true)
  expect(gate(bash('git status'), ctx(undefined))).toEqual({ allow: true })
})

// --- always rules ---

test('forge MCP create/merge tools are denied, read tools allowed (no role too)', () => {
  for (const tool of ['mcp__Gitlab__save_merge_request', 'mcp__gh__create_pull_request', 'mcp__Gitlab__accept_merge_request', 'mcp__x__merge_pull_request']) {
    expect(denied(gate({ tool, input: {} }, ctx(undefined)))).toBe(true)
  }
  for (const tool of ['mcp__Gitlab__get_merge_request', 'mcp__Gitlab__list_merge_requests', 'mcp__gh__search_pull_requests']) {
    expect(gate({ tool, input: {} }, ctx(undefined))).toEqual({ allow: true })
  }
})

test('reading .git/config is denied', () => {
  expect(denied(gate({ tool: 'Read', input: { file_path: '/w/.git/config' } }, ctx('builder')))).toBe(true)
  expect(denied(gate(bash('cat .git/config'), ctx('builder')))).toBe(true)
  expect(denied(gate({ tool: 'Read', input: { file_path: '/w/.git/config' } }, ctx(undefined)))).toBe(true)
  expect(gate({ tool: 'Read', input: { file_path: '/w/src/a.php' } }, ctx('code-reviewer'))).toEqual({ allow: true })
})

// --- builder ---

test('builder Bash: MR creation, remotes, hooks and forge writes are denied', () => {
  for (const c of [
    'gh pr create --fill', 'glab mr create -t x', 'git -C /w push', 'cd /w && git push',
    'git config core.hooksPath .hooks', 'git config remote.origin.url https://x', 'git remote set-url origin x',
    'cp evil .git/hooks/pre-commit', 'curl -X POST https://api.github.com/repos/o/r/pulls',
    'curl --data "{}" https://gitlab.com/api/v4/projects/1/merge_requests', 'wget --post-data=x https://gitlab.example/api/v4/x',
    'git config alias.p push', 'git -c alias.p=push p', 'git -c core.hooksPath=/tmp/h commit -m x', 'git --no-pager push origin HEAD',
  ]) expect(denied(gate(bash(c), ctx('builder')))).toBe(true)
})

test('builder Bash: ordinary work is allowed', () => {
  for (const c of ['composer test', 'git add -A && git commit -m "feat: x"', 'git status', 'curl -s https://example.com', 'git config user.name x', 'rm -rf build']) {
    expect(gate(bash(c), ctx('builder'))).toEqual({ allow: true })
  }
})

test('builder edits: relative paths, .. escapes, .git and .factory', () => {
  expect(gate(edit('src/a.php'), ctx('builder'))).toEqual({ allow: true })
  expect(gate({ tool: 'Write', input: { file_path: '/w/new.txt', content: 'x' } }, ctx('builder'))).toEqual({ allow: true })
  expect(denied(gate(edit('/w/../etc/passwd'), ctx('builder')))).toBe(true)
  expect(denied(gate(edit('../x'), ctx('builder')))).toBe(true)
  expect(denied(gate(edit('/wx/a'), ctx('builder')))).toBe(true)
  expect(denied(gate(edit('/w/.git/hooks/pre-push'), ctx('builder')))).toBe(true)
  expect(denied(gate(edit('/w/.factory/spec.md'), ctx('builder')))).toBe(true)
  expect(denied(gate({ tool: 'NotebookEdit', input: { notebook_path: '/tmp/n.ipynb' } }, ctx('builder')))).toBe(true)
  expect(denied(gate(edit('/w/a'), ctx('builder', { worktree: undefined })))).toBe(true)
  expect(denied(gate({ tool: 'Write', input: {} }, ctx('builder')))).toBe(true)
})

test('protected globs: * stays within a segment, ** crosses', () => {
  const p = { protectedPaths: ['.gitlab-ci.yml', 'config/*.php'] }
  expect(denied(gate(edit('/w/.gitlab-ci.yml'), ctx('builder', p)))).toBe(true)
  expect(denied(gate(edit('/w/config/db.php'), ctx('builder', p)))).toBe(true)
  expect(gate(edit('/w/config/sub/db.php'), ctx('builder', p))).toEqual({ allow: true })
})

// --- read-only roles ---

test('every non-builder role is read-only for edits', () => {
  for (const role of READ_ONLY) {
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      expect(denied(gate({ tool, input: { file_path: '/w/a', notebook_path: '/w/a' } }, ctx(role)))).toBe(true)
    }
  }
})

test('read-only roles may use only Read, Grep, Glob, LS, TodoWrite (R19)', () => {
  for (const role of READ_ONLY) {
    for (const tool of ['Read', 'Grep', 'Glob', 'LS', 'TodoWrite']) {
      expect(gate({ tool, input: { file_path: '/w/src/a.php', pattern: 'x' } }, ctx(role))).toEqual({ allow: true })
    }
    for (const tool of ['WebFetch', 'Agent', 'Task', 'mcp__Gitlab_IronCloud__get_work_item', 'Skill', 'SomethingNew']) {
      expect(denied(gate({ tool, input: {} }, ctx(role)))).toBe(true)
    }
  }
  expect((gate({ tool: 'WebFetch', input: {} }, ctx('approver')) as { deny: string }).deny).toContain('read-only')
})

test('read-only roles get no shell at all, however harmless (R19)', () => {
  for (const c of ['git diff main...HEAD', 'cat a', 'ls', 'pwd', '']) {
    for (const role of READ_ONLY) {
      for (const tool of ['Bash', 'Monitor', 'PowerShell']) expect(denied(gate({ tool, input: { command: c } }, ctx(role)))).toBe(true)
      // An unknown tool carrying a shell command is a shell too, even if named like a read tool.
      expect(denied(gate({ tool: 'Read', input: { file_path: '/w/a', command: c } }, ctx(role)))).toBe(true)
    }
  }
})

test('regression: review C1/C2 allowlist bypasses are all denied for read-only roles', () => {
  for (const c of [
    "git grep --open=sh x", 'sort --compress-p=sh a', 'sort --outp=x a', "git grep -iO'cmd' x",
    'find . -fprin{t,t} x', 'cat${IFS}a', "ls $'\\x2d'la", 'git grep -i{O,}sh x',
  ]) {
    for (const role of READ_ONLY) expect(denied(gate(bash(c), ctx(role)))).toBe(true)
  }
})

test('regression C3: Monitor and PowerShell go through the shell path and the always-rules', () => {
  expect(denied(gate({ tool: 'Monitor', input: { command: 'git push -f' } }, ctx(undefined)))).toBe(true)
  expect(denied(gate({ tool: 'Monitor', input: { command: 'git push' } }, ctx('builder')))).toBe(true)
  expect(denied(gate({ tool: 'PowerShell', input: { command: 'git reset --hard' } }, ctx(undefined)))).toBe(true)
  expect(denied(gate({ tool: 'Whatever', input: { command: 'cat .git/config' } }, ctx(undefined)))).toBe(true)
  expect(gate({ tool: 'Monitor', input: { command: 'composer test' } }, ctx('builder'))).toEqual({ allow: true })
})

test('regression I6: quoted, escaped or wrapped git/gh/glab in builder Bash is still seen', () => {
  for (const c of [
    'g"it" push', "'git' push", 'g\\it push', '/usr/bin/git push', 'env FOO=1 git push', 'command git push', 'X=1 git push',
    'sh -c "git push"', "bash -lc 'git push origin HEAD'", 'eval git push', 'echo $(git push)', 'true && (git push)',
    '{git,push}', 'git {push,}', "$'\\x67'it push", 'git${IFS}push', 'glab api -XPOST /projects/1/merge_requests', 'glab api projects/1',
    'gh api repos/o/r/pulls -f title=x', 'hub pull-request', 'cp x .git//hooks/pre-commit', 'cp x ./.git/./hooks/x',
    "cp x '.git'/hooks/x", 'cp x .GIT/hooks/x', 'git push -f', 'xargs git push < /dev/null', 'nice -n 5 git push',
  ]) expect(denied(gate(bash(c), ctx('builder')))).toBe(true)
})

test('regression I7: builder may not write code-running or redirecting git config', () => {
  for (const c of [
    'git config diff.x.textconv ./evil', 'git config diff.x.command ./evil', 'git config core.pager ./evil',
    'git config filter.x.clean ./evil', 'git config filter.x.smudge ./evil', 'git config url.https://evil/.insteadOf https://host/',
    'git config remote.origin.pushurl https://evil', 'git config --global user.name x', 'git config --file .git/config x y',
    'git config core.editor ./evil', 'git config include.path ../x', 'git config gpg.program ./evil', 'git -c diff.external=./x diff',
    'git -c core.pager=./x log', 'GIT_CONFIG_GLOBAL=./x git commit -m y', 'GIT_SSH_COMMAND=./x git fetch', 'git --exec-path=./x status',
    'git config alias.p "!sh"', 'git submodule add https://x',
  ]) expect(denied(gate(bash(c), ctx('builder')))).toBe(true)
  for (const c of ['git config user.name "Bot"', 'git config user.email b@x', 'git config --get user.name', 'git config --list', 'git -c user.name=x commit -m y']) {
    expect(gate(bash(c), ctx('builder'))).toEqual({ allow: true })
  }
})

test('regression minors: .git//config, .git/./config and case variants are denied', () => {
  for (const p of ['/w/.git//config', '/w/.git/./config', '/w/.GIT/config', '/w/sub/../.git/config']) {
    expect(denied(gate({ tool: 'Read', input: { file_path: p } }, ctx(undefined)))).toBe(true)
  }
  for (const c of ['cat .git//config', 'cat .git/./config', 'cat .GIT/config', "cat '.git'/config", 'cat .gi{t,x}/config']) {
    expect(denied(gate(bash(c), ctx('builder')))).toBe(true)
  }
  expect(denied(gate(edit('/w/.GIT/hooks/pre-push'), ctx('builder')))).toBe(true)
  expect(denied(gate(edit('/w/.Factory/spec.md'), ctx('builder')))).toBe(true)
  expect(denied(gate(edit('/w/DB/Migrations/x.sql'), ctx('builder', { protectedPaths: ['db/migrations/**'] })))).toBe(true)
})

test('builder curl/wget writes to the configured forge hosts are denied, reads allowed', () => {
  const f = { forgeHosts: ['lab.example.gr'] }
  for (const c of [
    'curl -XPOST https://lab.example.gr/x', 'curl -X PUT https://api.github.com/x', 'curl --request=DELETE https://gitlab.com/x',
    'curl -d @f https://lab.example.gr/y', 'wget --post-data=x https://lab.example.gr/y', 'curl -sSd x https://api.github.com/z',
  ]) expect(denied(gate(bash(c), ctx('builder', f)))).toBe(true)
  for (const c of ['curl -s https://lab.example.gr/raw/file', 'curl -X POST http://localhost:8080/x', 'curl -d x https://example.com']) {
    expect(gate(bash(c), ctx('builder', f))).toEqual({ allow: true })
  }
})

test('child roles: mutating MCP tools are denied, read tools allowed', () => {
  for (const role of ['builder'] as Role[]) {
    for (const tool of ['mcp__Gitlab_IronCloud__add_commit', 'mcp__Slack__slack_add_list_record', 'mcp__Gitlab_IronCloud__save_note']) {
      expect(denied(gate({ tool, input: {} }, ctx(role)))).toBe(true)
    }
    for (const tool of ['mcp__Gitlab_IronCloud__get_work_item', 'mcp__Gitlab_IronCloud__list_commits', 'mcp__Gitlab_IronCloud__search']) {
      expect(gate({ tool, input: {} }, ctx(role))).toEqual({ allow: true })
    }
  }
  expect(denied(gate({ tool: 'Grep', input: { pattern: 'x', path: '/w/.git/config' } }, ctx('code-reviewer')))).toBe(true)
})

test('read-only child: spec file is not read at all', async ($, on) => {
  let reads = 0
  mock.env(on, { FACTORY_ROLE: 'code-reviewer', FACTORY_WORKTREE: '/w', FACTORY_SPEC_FILE: '/w/.factory/spec.md', FACTORY_PROTECTED: 'db/**' })
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => { reads++; return { deny: 'no reading' } })
  on('tool.call', () => ({ result: 'ran' }))
  expect((await $.tool.call({ tool: 'Read', file_path: '/w/.factory/branch.diff' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'git diff' })).deny).toBeDefined()
  expect(reads).toBe(0)
})

test('unknown tools pass; unknown role is treated as read-only', () => {
  expect(gate({ tool: 'Glob', input: { pattern: '**/*.ts' } }, ctx('code-reviewer'))).toEqual({ allow: true })
  expect(denied(gate(edit('/w/a'), ctx('janitor' as Role)))).toBe(true)
})

// --- wiring (kit) ---

test('child session: hook denies git push', async ($, on) => {
  mock.env(on, { FACTORY_ROLE: 'builder', FACTORY_WORKTREE: '/w', FACTORY_SPEC_FILE: '/w/.factory/spec.md', FACTORY_PROTECTED: 'db/migrations/**' })
  on('fs.exists', () => ({ value: false }))
  on('tool.call', () => ({ result: 'ran' }))
  const r = await $.tool.call({ tool: 'Bash', command: 'git push' })
  expect(r.deny).toBeDefined()
  const ok = await $.tool.call({ tool: 'Bash', command: 'composer test' })
  expect(ok.deny).toBeUndefined()
})

test('child session: protected path follows FACTORY_PROTECTED and the spec file', async ($, on) => {
  mock.env(on, { FACTORY_ROLE: 'builder', FACTORY_WORKTREE: '/w', FACTORY_SPEC_FILE: '/w/.factory/spec.md', FACTORY_PROTECTED: 'db/migrations/**,ci/*' })
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ value: 'touches db/migrations/2026_add.sql' }))
  on('tool.call', () => ({ result: 'ran' }))
  expect((await $.tool.call({ tool: 'Edit', file_path: '/w/db/migrations/2026_add.sql', old_string: 'a', new_string: 'b' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Edit', file_path: '/w/db/migrations/other.sql', old_string: 'a', new_string: 'b' })).deny).toBeDefined()
  expect((await $.tool.call({ tool: 'Write', file_path: '/w/ci/x.yml', content: 'x' })).deny).toBeDefined()
})

test('child session: a gate that throws still denies', async ($, on) => {
  mock.env(on, { FACTORY_ROLE: 'builder', FACTORY_WORKTREE: '/w', FACTORY_SPEC_FILE: '/w/.factory/spec.md', FACTORY_PROTECTED: 'db/**' })
  on('fs.exists', () => ({ value: true }))
  on('fs.read', () => ({ deny: 'no reading' }))
  on('tool.call', () => ({ result: 'ran' }))
  const r = await $.tool.call({ tool: 'Bash', command: 'composer test' })
  expect(r.deny).toBe('factory gate failed; action blocked')
})

test('parent session: nothing is gated', async ($, on) => {
  mock.env(on, {})
  on('tool.call', () => ({ result: 'ran' }))
  expect((await $.tool.call({ tool: 'Bash', command: 'git push' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Edit', file_path: '/etc/x', old_string: 'a', new_string: 'b' })).deny).toBeUndefined()
})

test('parent session: a failing role read lets the call through (the user is never gated)', async ($, on) => {
  on('env.get', () => ({ deny: 'env unavailable' }))
  on('tool.call', () => ({ result: 'ran' }))
  expect((await $.tool.call({ tool: 'Bash', command: 'git push' })).deny).toBeUndefined()
})

test('child session: Monitor with git push is denied through the hook', async ($, on) => {
  mock.env(on, { FACTORY_ROLE: 'code-reviewer', FACTORY_WORKTREE: '/w' })
  on('tool.call', () => ({ result: 'ran' }))
  expect((await $.tool.call({ tool: 'Monitor', command: 'git push', description: 'x' })).deny).toBeDefined()
  expect((await $.tool.call({ tool: 'Grep', pattern: 'x', path: '/w/src' })).deny).toBeUndefined()
})

// ---- fix round 2: R23 ----
test('R23: Read/Grep/Glob/LS outside the worktree are denied for every child role, builder included', () => {
  for (const role of ['builder', ...READ_ONLY] as Role[]) {
    for (const call of [
      { tool: 'Read', input: { file_path: '/etc/passwd' } },
      { tool: 'Read', input: { file_path: '/w/../home/u/.ssh/id_rsa' } },
      { tool: 'Read', input: { file_path: '../other/x' } },
      { tool: 'Read', input: { file_path: '~/.claude.json' } },
      { tool: 'Read', input: { file_path: '/wx/a' } },
      { tool: 'Grep', input: { pattern: 'TOKEN', path: '/home/u' } },
      { tool: 'Glob', input: { pattern: '*', path: '/' } },
      { tool: 'Glob', input: { pattern: '../**/*.env' } },
      { tool: 'Glob', input: { pattern: '/etc/*' } },
      { tool: 'LS', input: { path: '/tmp' } },
    ]) expect(denied(gate(call, ctx(role)))).toBe(true)
    for (const call of [
      { tool: 'Read', input: { file_path: '/w/src/a.php' } },
      { tool: 'Read', input: { file_path: 'src/a.php' } },
      { tool: 'Grep', input: { pattern: 'x' } },
      { tool: 'Grep', input: { pattern: 'x', path: '/w/src' } },
      { tool: 'Glob', input: { pattern: 'src/**/*.php' } },
      { tool: 'LS', input: { path: '/w' } },
    ]) expect(gate(call, ctx(role))).toEqual({ allow: true })
    expect(denied(gate({ tool: 'Read', input: { file_path: '/w/a' } }, ctx(role, { worktree: undefined })))).toBe(true)
  }
})

test('R23: /proc is denied for reads and in builder shell commands', () => {
  for (const role of ['builder', 'code-reviewer'] as Role[]) {
    for (const p of ['/proc/1/environ', '/proc/self/environ', '/PROC/1/environ', '/w/../proc/1/environ']) {
      expect(denied(gate({ tool: 'Read', input: { file_path: p } }, ctx(role, { worktree: '/' })))).toBe(true)
    }
  }
  for (const c of [
    'cat /proc/$PPID/environ', "cat /proc/1/environ | tr '\\0' '\\n'", 'cd /proc && cat 1/environ', 'cat "/pr"oc/1/environ',
    'ps eww', 'xargs -0 < /proc/self/environ', 'strings /proc/*/environ', 'cat /p{r,}oc/1/cmdline',
  ]) expect(denied(gate(bash(c), ctx('builder')))).toBe(true)
  expect(gate(bash('npm test -- --env=node'), ctx('builder'))).toEqual({ allow: true })
})

// ---- Task 10 fix round 4 ----
test('fix4: builder shell allows "environment" and project proc/ paths, denies /proc and environ', () => {
  for (const c of [
    'pytest tests/test_environment.py', 'npm test -- --environment=ci', 'cat config/environments/test.rb', 'cat src/proc/handler.c',
    'make -C src/proc', 'ls ./proc/x',
  ]) expect(gate(bash(c), ctx('builder'))).toEqual({ allow: true })
  for (const c of [
    'cat /proc/1/environ', 'cd /proc && cat self/environ', 'strings /proc/$PPID/environ', 'cat "/pr"oc/1/environ',
    'ls /proc', 'xargs -0 < /proc/self/environ', 'cat x=/proc/1/cmdline', 'cat environ', 'cat ./environ',
    'cd /proc/self; cat environ', 'cat /p{r,}oc/1/cmdline',
  ]) expect(denied(gate(bash(c), ctx('builder')))).toBe(true)
})

// ---- Task 10 fix round 5 ----
test('fix5: builder shell denies relative and globbed proc entries anywhere', () => {
  for (const c of [
    'cat ../../../proc/self/env*', 'cd ../../proc && cat self/env*', 'cat /w/../proc/self/envi?on', 'cat /proc/1/environ',
    'cat proc/thread-self/status', 'cat ../proc/$PPID/cmdline', 'cat ../proc/[0-9]*/cmdline', 'cd src/proc', 'pushd ../proc/',
  ]) expect(denied(gate(bash(c), ctx('builder')))).toBe(true)
  for (const c of [
    'cat src/proc/handler.c', 'cat app/proc/x', 'pytest tests/test_environment.py', 'make -C src/proc', 'ls ./proc/x',
    'cd src/proc/sub', 'cd processing',
  ]) expect(gate(bash(c), ctx('builder'))).toEqual({ allow: true })
})

test('fix4: ps denies only BSD-style e flags', () => {
  for (const c of ['ps -o pid,user,time', 'ps -ef', 'ps aux', 'ps -p 1 -o comm', 'ps -e', 'ps --sort=-pcpu'])
    expect(gate(bash(c), ctx('builder'))).toEqual({ allow: true })
  for (const c of ['ps eww', 'ps aux e', 'ps axe', 'ps e', 'ps auxeww'])
    expect(denied(gate(bash(c), ctx('builder')))).toBe(true)
})

test('fix4: worktree containment is case-sensitive; .git/.factory checks stay case-insensitive', () => {
  for (const role of ['builder', 'code-reviewer'] as Role[]) {
    expect(denied(gate({ tool: 'Read', input: { file_path: '/W/x' } }, ctx(role)))).toBe(true)
    expect(denied(gate({ tool: 'LS', input: { path: '/W' } }, ctx(role)))).toBe(true)
    expect(gate({ tool: 'Read', input: { file_path: '/w/Src/A.php' } }, ctx(role))).toEqual({ allow: true })
    expect(denied(gate({ tool: 'Read', input: { file_path: '/PROC/1/environ' } }, ctx(role, { worktree: '/' })))).toBe(true)
    expect(denied(gate({ tool: 'Read', input: { file_path: '/w/.GIT/config' } }, ctx(role)))).toBe(true)
  }
  expect(denied(gate(edit('/W/x'), ctx('builder')))).toBe(true)
  expect(denied(gate(edit('/w/.GIT/hooks/pre-commit'), ctx('builder')))).toBe(true)
  expect(denied(gate(edit('/w/.Factory/x'), ctx('builder')))).toBe(true)
})
