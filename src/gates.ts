import type { Role } from './config'

// Gates (spec §4.2, §12, rulings R7/R19): what a child agent session may not do.
// Pure; the tool.call hook in hooks/register.ts builds the context from the
// child's env and denies whatever this refuses.
//
// - Read-only roles (everything but the builder, unknown roles included) may
//   use only READ_ONLY_TOOLS and never a shell: string-parsing a shell
//   allowlist cannot be made safe (R19).
// - The builder may edit inside its worktree (not .git/.factory, not protected
//   paths the spec does not name) and run shell commands, checked against a
//   denylist over de-quoted, brace-expanded words. That denylist stops an
//   honest-but-wrong agent, not a hostile one: the builder has no forge token
//   (R18), a tokenless remote (R8), and the mod never runs push/commit in its
//   worktree (R20).
// - Always (any role): no force push, no reset --hard, no MR/PR create/merge
//   MCP tools, no .git/config access.

export type GateCall = { tool: string; input: Record<string, unknown> }
export type GateCtx = {
  /** The child's role; undefined means only the always-rules apply. */
  role?: Role
  /** Absolute worktree path the builder may edit inside. */
  worktree?: string
  /** `.factory.yml` protectedPaths globs (`**` and `*` only), relative to the worktree. */
  protectedPaths: string[]
  /** The approved spec; a protected path it names may be edited. */
  specText: string
  /** Forge hosts (FACTORY_FORGE_HOSTS) the builder may not write to with curl/wget. */
  forgeHosts?: string[]
}
export type GateResult = { allow: true } | { deny: string }

const ALLOW: GateResult = { allow: true }
const deny = (why: string): GateResult => ({ deny: `software-factory: ${why}` })

export const READ_ONLY_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'TodoWrite']
const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']
const SHELL_TOOLS = ['Bash', 'Monitor', 'PowerShell']

/** A tool that runs a shell command: Bash, Monitor, PowerShell, or any tool whose input has a string `command`. */
export function isShellTool(call: GateCall): boolean {
  return SHELL_TOOLS.includes(call.tool) || typeof call.input.command === 'string'
}

const READ_PATH_TOOLS = ['Read', 'Grep', 'Glob', 'LS']

export function gate(call: GateCall, ctx: GateCtx): GateResult {
  const always = alwaysRules(call)
  if (always) return always
  if (ctx.role === undefined) return ALLOW
  const tool = call.tool

  // R23: every child reads only inside its worktree, and never /proc (another
  // process's environ would hold the parent's forge token).
  if (READ_PATH_TOOLS.includes(tool)) {
    const why = outsideWorktree(call, ctx)
    if (why) return deny(why)
  }

  if (ctx.role !== 'builder') {
    if (READ_ONLY_TOOLS.includes(tool) && !isShellTool(call)) return ALLOW
    return deny(`the ${ctx.role} station is read-only and may use only ${READ_ONLY_TOOLS.join(', ')}; ${tool} is not allowed. The branch diff and log are in .factory/branch.diff and .factory/branch.log.`)
  }

  if (/^mcp__/i.test(tool)) {
    const name = mcpToolName(tool)
    if (!MCP_READ_VERB.test(name) && MCP_MUTATING.test(name)) {
      return deny(`the builder may not change anything through ${tool}; the factory itself talks to the forge.`)
    }
    return ALLOW
  }
  if (isShellTool(call)) return builderShell(str(call.input.command), ctx)
  if (EDIT_TOOLS.includes(tool)) return builderEdit(call, ctx)
  return ALLOW
}

// ---------- always rules ----------

const MCP_MR = /^mcp__.*(merge_request|pull_request)/i
const MCP_READ = /get|list|search|read/i
/** A tool whose name starts with a read verb (`get_x`, `list_x`); `add_list_record` is not one. */
const MCP_READ_VERB = /^(get|list|search|read|find|fetch|query|describe|view)(_|$)/i
const MCP_CREATE = /create_pr|create_mr/i
const MCP_MUTATING = /create|save|add|update|delete|remove|merge|accept|approve|fork|push|commit|post|send|write|edit|upload|close|reopen|link|set_|schedule|complete/i

/** `mcp__<server>__<tool>` → `<tool>` (the server name may itself contain `_`). */
function mcpToolName(tool: string): string {
  const parts = tool.split('__')
  return parts.length >= 3 ? parts.slice(2).join('__') : tool
}

/** `.git/config` after collapsing `//` and `/./`, any case. */
const GIT_CONFIG_PATH = /(^|[^\w])\.git\/config(\b|$)/
const GIT_HOOKS_PATH = /(^|[^\w])\.git\/hooks(\/|\b|$)/

function alwaysRules(call: GateCall): GateResult | undefined {
  const tool = call.tool
  if (/^mcp__/i.test(tool) && (MCP_CREATE.test(tool) || (MCP_MR.test(tool) && !MCP_READ.test(mcpToolName(tool))))) {
    return deny(`${tool} is not allowed: agents never create, change or merge merge/pull requests; the factory does.`)
  }
  for (const p of pathsOf(call.input)) {
    const n = normalise(p).toLowerCase()
    if (GIT_CONFIG_PATH.test(n)) return deny('reading or writing .git/config is not allowed.')
    if (tool === 'Grep' && /(^|\/)\.git(\/|$)/.test(n)) return deny('searching inside .git is not allowed.')
  }
  if (isShellTool(call)) {
    const cmd = str(call.input.command)
    if (touches(cmd, GIT_CONFIG_PATH)) return deny('commands touching .git/config are not allowed.')
    for (const words of commandSegments(cmd)) {
      const g = gitInvocation(words)
      if (!g) continue
      if (g.sub === 'push' && g.args.some(isForceArg)) return deny('git push --force is never allowed.')
      if (g.sub === 'reset' && g.args.includes('--hard')) return deny('git reset --hard is never allowed.')
    }
  }
  return undefined
}

function isForceArg(a: string): boolean {
  return /^--force(-with-lease|-if-includes)?(=.*)?$/.test(a) || /^-[A-Za-z]*f[A-Za-z]*$/.test(a) || /^\+./.test(a) || a === '--mirror' || a === '--delete' || a === '-d'
}

function pathsOf(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const k of ['file_path', 'notebook_path', 'path']) {
    const v = input[k]
    if (typeof v === 'string') out.push(v)
  }
  return out
}

/** Whether any de-quoted word of the command, or the flattened command, names a path matching `re`. */
function touches(cmd: string, re: RegExp): boolean {
  if (re.test(flatten(cmd))) return true
  return commandSegments(cmd).some((ws) => ws.some((w) => re.test(normalise(w).toLowerCase()) || re.test(collapse(w).toLowerCase())))
}

// ---------- builder shell ----------

const DEFAULT_FORGE_HOSTS = ['github.com', 'api.github.com', 'uploads.github.com', 'gitlab.com']
const GIT_ENV_DENY = /^(GIT_CONFIG\w*|GIT_SSH\w*|GIT_ASKPASS|GIT_EXEC_PATH|GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_TEMPLATE_DIR|GIT_PROXY_COMMAND|GIT_EXTERNAL_DIFF|GIT_PAGER|PAGER|SSH_ASKPASS)$/i
/** Config the builder may set (git config / git -c); anything else could run code or redirect remotes. */
const GIT_CONFIG_OK = /^(user\.(name|email)|commit\.gpgsign|tag\.gpgsign|color\.[\w.-]+|advice\.[\w.-]+|core\.(autocrlf|filemode|quotepath|safecrlf|eol|ignorecase)|init\.defaultbranch|i18n\.[\w.-]+|log\.[\w.-]+|status\.[\w.-]+)$/i
const WRAPPERS = new Set(['env', 'command', 'exec', 'nohup', 'nice', 'time', 'sudo', 'xargs', 'timeout', 'stdbuf', 'builtin', 'doas', 'unbuffer', 'then', 'do', 'else', 'if', 'while', 'until', '!'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish', 'busybox'])
const FORGE_CLIS = new Set(['gh', 'glab', 'hub', 'lab'])
const HTTP_CLIS = new Set(['curl', 'wget', 'http', 'https', 'xh'])

function builderShell(cmd: string, ctx: GateCtx): GateResult {
  // R23: /proc/<pid>/environ of the parent mod process holds the forge token.
  const f = flatten(cmd)
  // `/proc` only as an absolute path at a word start (not `src/proc/x`), `environ`
  // only as a word (not `environment`).
  if (/(^|[\s=:'"(<>;|&])\/proc(?=[/\s;|&)<>]|$)/.test(f) || /\benviron\b/.test(f) || procEntry(f)) {
    return deny('reading /proc or process environments is not allowed.')
  }
  if (touches(cmd, GIT_HOOKS_PATH)) return deny('touching .git/hooks is not allowed.')
  if (/\b(core\.hookspath|insteadof|pushurl|textconv|core\.fsmonitor|core\.sshcommand|core\.pager|diff\.external)\b/.test(flatten(cmd))) {
    return deny('setting git hooks, URL rewrites, pagers, diff/textconv drivers or ssh commands is not allowed.')
  }
  for (const raw of commandSegments(cmd)) {
    const words = unwrap(raw)
    if (typeof words === 'string') return deny(words)
    const prog = basename(words[0] ?? '')
    if (prog === 'git') {
      const why = builderGit(words)
      if (why) return deny(why)
    } else if (prog === 'ps' && psShowsEnv(words.slice(1))) {
      return deny('ps with BSD `e` (process environments) is not allowed.')
    } else if (FORGE_CLIS.has(prog)) {
      return deny(`${prog} is not available to the builder; the factory talks to the forge.`)
    } else if (HTTP_CLIS.has(prog) && httpWrite(words) && mentionsForge(words, ctx)) {
      return deny('writing to the forge API is not allowed; the factory talks to the forge.')
    }
  }
  return ALLOW
}

/**
 * A proc entry anywhere in the flattened command, relative or absolute: `proc/self`,
 * `proc/thread-self`, `proc/<digits>`, `proc/$PPID`, or a glob right after `proc/`
 * (`../../proc/s*`); or `cd`/`pushd` into a path whose last segment is `proc`.
 * Project paths such as `src/proc/handler.c` stay allowed.
 */
function procEntry(f: string): boolean {
  const re = /(?<![a-z0-9_.-])proc\/+([^/\s;|&<>()]*)/g
  for (let m = re.exec(f); m; m = re.exec(f)) {
    if (/^(self|thread-self|\d|\$)/.test(m[1]) || /[*?[]/.test(m[1])) return true
  }
  return /(^|[\s;|&(])(cd|pushd)(\s+-\S*)*\s+(\S*\/)?proc\/*(?=[\s;|&)]|$)/.test(f)
}

/** ps options whose next word is a value (`-o pid,user`), never a BSD flag group. */
const PS_VALUE_OPTS = new Set(['-o', '-O', '-p', '-q', '-u', '-U', '-g', '-G', '-t', '-C', '-s', '-k', '--format', '--sort', '--pid', '--ppid', '--user', '--group', '--tty', '--cols', '--columns', '--rows', '--lines', '--width'])
/** BSD flag letters taking a value in the next word when they end a group (`ps axo user`). */
const PS_BSD_VALUE = /[oOpqtUk]$/

/** True for a BSD-style `e` flag (`ps e`, `ps axe`, `ps aux e`): process environments. */
function psShowsEnv(args: string[]): boolean {
  for (let i = 0; i < args.length; i++) {
    const w = args[i]
    if (w.startsWith('-')) {
      if (PS_VALUE_OPTS.has(w)) i++
      continue
    }
    if (!/^[A-Za-z]+$/.test(w)) continue
    if (w.includes('e')) return true
    if (PS_BSD_VALUE.test(w)) i++
  }
  return false
}

/**
 * Segments of de-quoted words, with `sh -c '...'` and `eval ...` bodies
 * parsed as segments of their own (to a fixed depth).
 */
export function commandSegments(cmd: string, depth = 0): string[][] {
  const out: string[][] = []
  for (const seg of shellSegments(cmd)) {
    out.push(seg)
    if (depth >= 4) continue
    const words = unwrap(seg)
    if (typeof words === 'string' || words.length === 0) continue
    const prog = basename(words[0])
    if (SHELLS.has(prog)) {
      const c = words.findIndex((w, i) => i > 0 && /^-[A-Za-z]*c[A-Za-z]*$/.test(w))
      if (c > 0 && words[c + 1] !== undefined) out.push(...commandSegments(words[c + 1], depth + 1))
    } else if (prog === 'eval' || prog === 'source' || prog === '.') {
      out.push(...commandSegments(words.slice(1).join(' '), depth + 1))
    }
  }
  return out
}

/** Drops env assignments and wrapper programs; the real command words, or why it is refused. */
function unwrap(words: string[]): string[] | string {
  let i = 0
  for (;;) {
    while (i < words.length && /^[A-Za-z_]\w*=/.test(words[i])) {
      const name = words[i].slice(0, words[i].indexOf('='))
      if (GIT_ENV_DENY.test(name)) return `setting ${name} is not allowed.`
      i++
    }
    const w = words[i]
    if (w === undefined) return []
    if (!WRAPPERS.has(basename(w))) return words.slice(i)
    i++
    // Skip the wrapper's options (and an option argument for `env -u X`, `nice -n 5`, `timeout 5`).
    while (i < words.length && (words[i].startsWith('-') || /^\d+(\.\d+)?[smhd]?$/.test(words[i]))) {
      if (/^-(u|n|C|S|P|I|s|k|g|L)$/.test(words[i]) && i + 1 < words.length) i++
      i++
    }
  }
}

type GitCall = { sub: string; args: string[]; inline: string[]; globals: string[] }

/** Parses `git [global options] <sub> args...` from a segment's words (wrappers included). */
function gitInvocation(raw: string[]): GitCall | undefined {
  const words = unwrap(raw)
  if (typeof words === 'string' || basename(words[0] ?? '') !== 'git') return undefined
  const inline: string[] = []
  const globals: string[] = []
  let i = 1
  while (i < words.length && words[i].startsWith('-')) {
    const w = words[i]
    globals.push(w)
    if (['-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env', '--super-prefix'].includes(w)) {
      if (w === '-c' && words[i + 1] !== undefined) inline.push(words[i + 1])
      i += 2
    } else {
      if (w.startsWith('-c') && w.length > 2) inline.push(w.slice(2))
      i++
    }
  }
  return { sub: words[i] ?? '', args: words.slice(i + 1), inline, globals }
}

function builderGit(words: string[]): string | undefined {
  const g = gitInvocation(words)
  if (!g) return undefined
  for (const kv of g.inline) {
    const key = kv.split('=', 1)[0]
    if (!GIT_CONFIG_OK.test(key)) return `git -c ${key} is not allowed.`
  }
  if (g.globals.some((w) => /^--(exec-path|config-env|git-dir|work-tree)/.test(w))) return 'git --git-dir/--work-tree/--exec-path/--config-env are not allowed.'
  switch (g.sub) {
    case 'push': case 'send-pack':
      return 'agents never push; the factory pushes the branch after review.'
    case 'remote':
      if (['add', 'set-url', 'remove', 'rm', 'rename', 'set-head', 'set-branches', 'update', 'prune'].includes(g.args[0] ?? '')) return 'changing git remotes is not allowed.'
      return undefined
    case 'config': {
      if (g.args.some((a) => /^--(global|system|file|blob|edit|worktree|includes)$|^-[fe]$/.test(a))) return 'git config may change only this repository and only safe keys.'
      const read = g.args.some((a) => /^(--get|--get-all|--get-regexp|--list|-l|--show-origin|--show-scope|--name-only|get|list)$/.test(a))
      if (read) return undefined
      const key = g.args.find((a) => !a.startsWith('-') && a !== 'set' && a !== 'unset')
      if (key !== undefined && !GIT_CONFIG_OK.test(key)) return `git config ${key} is not allowed; only user identity and display settings.`
      return undefined
    }
    case 'submodule':
      return 'git submodule is not allowed.'
    default:
      return undefined
  }
}

function httpWrite(words: string[]): boolean {
  for (let i = 1; i < words.length; i++) {
    const w = words[i]
    const method = /^(?:-[A-Za-z]*X|--request=?|--method=?)(.*)$/.exec(w)
    if (method) {
      const m = (method[1] || words[i + 1] || '').toUpperCase()
      if (!['GET', 'HEAD', 'OPTIONS'].includes(m)) return true
      continue
    }
    if (/^-[A-Za-z]*[dFT]/.test(w) && !w.startsWith('--')) return true
    if (/^--(data|form|json|upload-file|post-data|post-file|body-data|body-file)/.test(w)) return true
  }
  return false
}

function mentionsForge(words: string[], ctx: GateCtx): boolean {
  const hosts = [...DEFAULT_FORGE_HOSTS, ...(ctx.forgeHosts ?? [])].map((h) => h.trim().toLowerCase()).filter((h) => h !== '')
  return words.some((w) => {
    const l = w.toLowerCase()
    if (/\/api\/v[34](\/|$)|\/api\/graphql\b/.test(l)) return true
    const host = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]*@)?([^/:?#]+)/.exec(l)?.[1] ?? ''
    return hosts.some((h) => host === h || host.endsWith(`.${h}`))
  })
}

/** R23: Read/Grep/Glob/LS paths resolve inside the worktree (relative paths against it). */
function outsideWorktree(call: GateCall, ctx: GateCtx): string | undefined {
  if (!ctx.worktree || !ctx.worktree.startsWith('/')) return 'no job worktree is known; reads are not allowed.'
  // Containment is case-sensitive (Linux); only the /proc check folds case.
  const wt = normalise(ctx.worktree)
  const raws = pathsOf(call.input)
  for (const raw of raws) {
    if (raw.startsWith('~')) return `${raw} is outside the job worktree.`
    const abs = normalise(raw.startsWith('/') ? raw : `${ctx.worktree}/${raw}`)
    const labs = abs.toLowerCase()
    if (labs === '/proc' || labs.startsWith('/proc/')) return 'reading /proc is not allowed.'
    if (abs !== wt && !abs.startsWith(wt === '/' ? '/' : `${wt}/`)) return `${raw} is outside the job worktree ${ctx.worktree}; read only files inside it.`
  }
  // A glob pattern that climbs out (`../**`, `/etc/*`) is outside too.
  const pattern = call.input.pattern
  if (call.tool === 'Glob' && typeof pattern === 'string') {
    if (pattern.startsWith('/') || pattern.startsWith('~') || pattern.split('/').includes('..')) return `glob ${pattern} reaches outside the job worktree.`
  }
  return undefined
}

// ---------- builder edits ----------

function builderEdit(call: GateCall, ctx: GateCtx): GateResult {
  const raw = call.input.file_path ?? call.input.notebook_path
  if (typeof raw !== 'string' || raw === '') return deny(`${call.tool} without a file path is not allowed.`)
  if (!ctx.worktree || !ctx.worktree.startsWith('/')) return deny('no job worktree is known; edits are not allowed.')
  const wt = normalise(ctx.worktree)
  if (raw.startsWith('~')) return deny(`${raw} is outside the job worktree ${wt}.`)
  const abs = normalise(raw.startsWith('/') ? raw : `${wt}/${raw}`)
  if (!abs.startsWith(wt === '/' ? '/' : `${wt}/`)) return deny(`${raw} is outside the job worktree ${wt}; edit only files inside it.`)
  const rel = abs.slice(wt === '/' ? 1 : wt.length + 1)
  // Compared lower-case: on a case-insensitive filesystem `.GIT/hooks` is `.git/hooks`.
  const lrel = rel.toLowerCase()
  if (lrel === '.git' || lrel.startsWith('.git/')) return deny(`${raw} is inside .git; editing git internals is not allowed.`)
  if (lrel === '.factory' || lrel.startsWith('.factory/')) return deny(`${raw} is factory state; it is not editable.`)
  const hit = ctx.protectedPaths.find((g) => g.trim() !== '' && globRe(g.trim().toLowerCase()).test(lrel))
  if (hit !== undefined && !mentions(ctx.specText.toLowerCase(), lrel)) {
    return deny(`${rel} is protected (${hit}) and the approved spec does not list it; leave it unchanged or explain why it must change.`)
  }
  return ALLOW
}

/** Resolves `.` and `..` segments and duplicate slashes of an absolute or relative path. */
export function normalise(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

/** `**` crosses directories, `*` stays within one segment; a trailing `/` means everything under it. */
export function globRe(glob: string): RegExp {
  let g = glob.replace(/^\.\//, '').replace(/^\/+/, '')
  if (g.endsWith('/')) g += '**'
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
    } else if (c === '*') {
      re += '[^/]*'
    } else {
      re += escapeRe(c)
    }
  }
  return new RegExp(`^${re}$`)
}

function mentions(text: string, rel: string): boolean {
  let from = 0
  for (;;) {
    const i = text.indexOf(rel, from)
    if (i < 0) return false
    // Whole-path match: `db/x.sql` is not named by `old_db/x.sql` or `db/x.sql.bak`; `./db/x.sql` counts.
    const lead = i >= 2 && text.slice(i - 2, i) === './' ? i - 2 : i
    const before = lead === 0 ? '' : text[lead - 1] ?? ''
    const end = i + rel.length
    if (!/[\w.\/-]/.test(before) && !/[\w\/-]/.test(text[end] ?? '') && !/^\.\w/.test(text.slice(end, end + 2))) return true
    from = i + 1
  }
}

// ---------- shell tokenising (feeds a denylist: over-approximate, never refuse) ----------

/**
 * Splits a command into segments of de-quoted words. Separators: `|`, `&`,
 * `;`, newlines, `(`, `)`, `{`/`}` used as group words, backticks and `$(`,
 * so substituted commands are segments of their own. `$'..'` is decoded,
 * `$IFS`/`${IFS}` split words, and `{a,b}` brace lists expand into every
 * alternative.
 */
export function shellSegments(cmd: string): string[][] {
  const segs: string[][] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  const endWord = () => {
    if (inWord && (word === '{' || word === '}')) { word = ''; inWord = false; if (words.length > 0) { segs.push(words); words = [] } return }
    if (inWord) words.push(...expandBraces(word))
    word = ''; inWord = false
  }
  const endSeg = () => { endWord(); if (words.length > 0) segs.push(words); words = [] }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === '$' && cmd[i + 1] === "'") {
      const j = closingAnsi(cmd, i + 2)
      word += decodeAnsi(cmd.slice(i + 2, j)); inWord = true; i = j
    } else if (c === '$' && cmd.startsWith('${IFS}', i)) {
      endWord(); i += 5
    } else if (c === '$' && cmd.startsWith('$IFS', i)) {
      endWord(); i += 3
    } else if (c === "'") {
      const j = cmd.indexOf("'", i + 1)
      const end = j < 0 ? cmd.length : j
      word += cmd.slice(i + 1, end); inWord = true; i = end
    } else if (c === '"') {
      let j = i + 1
      let inner = ''
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === '\\' && j + 1 < cmd.length) { inner += cmd[j + 1]; j++; continue }
        inner += cmd[j]
      }
      // A substitution inside double quotes is also checked as its own segment.
      for (const m of inner.matchAll(/\$\(([^)]*)\)|`([^`]*)`/g)) segs.push(...shellSegments(m[1] ?? m[2] ?? ''))
      word += inner; inWord = true; i = j
    } else if (c === '\\') {
      if (cmd[i + 1] !== '\n') { word += cmd[i + 1] ?? ''; inWord = true }
      i++
    } else if (c === '|' || c === ';' || c === '&' || c === '\n' || c === '(' || c === ')' || c === '`') {
      endSeg()
    } else if (c === '$' && cmd[i + 1] === '(') {
      endSeg(); i++
    } else if (c === ' ' || c === '\t' || c === '<' || c === '>') {
      endWord()
    } else {
      word += c; inWord = true
    }
  }
  endSeg()
  return segs
}

function closingAnsi(cmd: string, from: number): number {
  for (let j = from; j < cmd.length; j++) {
    if (cmd[j] === '\\') { j++; continue }
    if (cmd[j] === "'") return j
  }
  return cmd.length
}

function decodeAnsi(s: string): string {
  return s.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{1,4}|[0-7]{1,3}|.)/g, (_, e: string) => {
    if (e[0] === 'x' || e[0] === 'u') return String.fromCharCode(parseInt(e.slice(1), 16))
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8))
    return ({ n: '\n', t: '\t', r: '\r', e: '\x1b', a: '\x07', b: '\b', f: '\f', v: '\v' } as Record<string, string>)[e] ?? e
  })
}

/** Bash brace expansion of `{a,b}` lists (nested too, capped); `{}` and `{x}` stay literal. */
export function expandBraces(w: string, depth = 0): string[] {
  if (depth > 8) return [w]
  let open = -1
  let level = 0
  for (let i = 0; i < w.length; i++) {
    if (w[i] === '{') { if (level === 0) open = i; level++ }
    else if (w[i] === '}' && level > 0) {
      level--
      if (level === 0) {
        const alts = splitTop(w.slice(open + 1, i))
        if (alts.length > 1) {
          const pre = w.slice(0, open)
          const post = w.slice(i + 1)
          return alts.flatMap((a) => expandBraces(pre + a + post, depth + 1)).slice(0, 64)
        }
        open = -1
      }
    }
  }
  return [w]
}

function splitTop(s: string): string[] {
  const out: string[] = []
  let level = 0
  let cur = ''
  for (const ch of s) {
    if (ch === '{') level++
    if (ch === '}') level--
    if (ch === ',' && level === 0) { out.push(cur); cur = ''; continue }
    cur += ch
  }
  out.push(cur)
  return out
}

/** `//` and `/./` collapsed. */
function collapse(p: string): string {
  return p.replace(/\/(\.?\/)+/g, '/')
}

/** The command with quoting, `$'..'`, `$IFS` and brace syntax removed and paths collapsed; lower-case. */
function flatten(cmd: string): string {
  return collapse(cmd
    .replace(/\$'((?:\\.|[^'])*)'/g, (_, s: string) => decodeAnsi(s))
    .replace(/\$\{IFS\}|\$IFS/g, ' ')
    .replace(/["'\\]/g, '')
    .replace(/[{},]/g, ''))
    .toLowerCase()
}

function basename(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1)
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
