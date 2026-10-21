import type { Role } from './config'

// Gates (spec §4.2, §12): what a child agent session may not do. Pure; the
// tool.call hook in hooks/register.ts builds the context from the child's env
// (FACTORY_ROLE, FACTORY_WORKTREE, FACTORY_PROTECTED, FACTORY_SPEC_FILE) and
// denies whatever this refuses. These guards stop an honest-but-wrong agent;
// they are not a sandbox (a builder runs arbitrary programs by design).

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
  /** Extra forge API hosts (e.g. the GITLAB_URL host) besides the public ones. */
  forgeHosts?: string[]
}
export type GateResult = { allow: true } | { deny: string }

const ALLOW: GateResult = { allow: true }
const deny = (why: string): GateResult => ({ deny: `software-factory: ${why}` })

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']

export function gate(call: GateCall, ctx: GateCtx): GateResult {
  const always = alwaysRules(call)
  if (always) return always
  if (ctx.role === undefined) return ALLOW

  const tool = call.tool
  // Any child: an MCP tool that changes things (a forge add_commit is a push by
  // another name) is denied; the factory alone writes to the forge.
  if (/^mcp__/i.test(tool)) {
    const name = mcpToolName(tool)
    if (!MCP_READ_VERB.test(name) && MCP_MUTATING.test(name)) {
      return deny(`${ctx.role} agents may not change anything through ${tool}; the factory itself talks to the forge.`)
    }
  }

  if (ctx.role === 'builder') {
    if (EDIT_TOOLS.includes(tool)) return builderEdit(call, ctx)
    if (tool === 'Bash') return builderBash(str(call.input.command), ctx)
    return ALLOW
  }

  // Every other role (and any unknown one) is read-only.
  if (EDIT_TOOLS.includes(tool)) return deny(`the ${ctx.role} station is read-only; ${tool} is not allowed.`)
  if (tool === 'Bash') {
    const why = readOnlyBash(str(call.input.command))
    if (why !== undefined) return deny(`the ${ctx.role} station is read-only; this command is not allowed (${why}). Use read-only commands such as git diff/log/show, cat, grep, rg, ls, find.`)
  }
  return ALLOW
}

// ---------- always rules (any session the gate is asked about) ----------

// git followed by its global options (`-C dir`, `-c k=v`, `--no-pager`, `--git-dir=x`) then a subcommand.
// Only real global options are skipped, so `git log --grep push` is not a push.
const GIT_GLOBAL = String.raw`-[Cc]\s+\S+|--(?:git-dir|work-tree|namespace|exec-path|config-env)(?:=|\s+)\S+|--no-pager|--paginate|-[pP]|--bare|--no-replace-objects|--no-optional-locks|--(?:literal|glob|noglob|icase)-pathspecs`
const GIT = String.raw`\bgit(?:\s+(?:${GIT_GLOBAL}))*\s+`
const GIT_PUSH = new RegExp(`${GIT}push\\b([^|;&\\n]*)`)
const GIT_RESET_HARD = new RegExp(`${GIT}reset\\b[^|;&\\n]*\\s--hard\\b`)
const FORCE_ARG = /(^|\s)(--force(-with-lease|-if-includes)?(=\S*)?|-[A-Za-z]*f[A-Za-z]*|\+\S+)(?=\s|$)/

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

function alwaysRules(call: GateCall): GateResult | undefined {
  const tool = call.tool
  if (/^mcp__/i.test(tool) && (MCP_CREATE.test(tool) || (MCP_MR.test(tool) && !MCP_READ.test(mcpToolName(tool))))) {
    return deny(`${tool} is not allowed: agents never create, change or merge merge/pull requests; the factory does.`)
  }
  for (const p of pathsOf(call.input)) {
    if (/(^|\/)\.git\/config$/.test(normalise(p))) return deny('reading or writing .git/config is not allowed.')
  }
  if (tool === 'Bash') {
    const cmd = str(call.input.command)
    if (cmd.includes('.git/config')) return deny('commands touching .git/config are not allowed.')
    const push = GIT_PUSH.exec(cmd)
    if (push && FORCE_ARG.test(push[1] ?? '')) return deny('git push --force is never allowed.')
    if (GIT_RESET_HARD.test(cmd)) return deny('git reset --hard is never allowed.')
  }
  return undefined
}

function pathsOf(input: Record<string, unknown>): string[] {
  const out: string[] = []
  for (const k of ['file_path', 'notebook_path', 'path']) {
    const v = input[k]
    if (typeof v === 'string') out.push(v)
  }
  return out
}

// ---------- builder ----------

const FORGE_HOSTS = ['api.github.com', 'uploads.github.com', 'github.com', 'gitlab.com']
const CURL_WRITE = /(^|\s)(-X\s*|--request[\s=]+)['"]?(POST|PUT|PATCH|DELETE)\b|(^|\s)(-d|-F|-T|--data[\w-]*|--form[\w-]*|--json|--upload-file|--post-data|--post-file|--method[\s=]+['"]?(POST|PUT|PATCH|DELETE))(?=[\s=]|$|['"@])/i
const GIT_CONFIG_RISKY = /core\.hookspath|core\.fsmonitor|core\.sshcommand|remote\.|url\.|credential\.|include(if)?\.|http\.|alias\./i
const GIT_INLINE_CONFIG = /\bgit\b[^|;&\n]*\s-c\s*['"]?(core\.hookspath|core\.fsmonitor|core\.sshcommand|remote\.|url\.|credential\.|include(if)?\.|http\.|alias\.)/i

function builderBash(cmd: string, ctx: GateCtx): GateResult {
  if (GIT_PUSH.test(cmd)) return deny('agents never push; the factory pushes the branch after review.')
  if (/\bgh\s+pr\s+(create|merge|ready|review)\b/.test(cmd) || /\bglab\s+mr\s+(create|merge|approve|update)\b/.test(cmd)) {
    return deny('agents never open or merge merge/pull requests; the factory does.')
  }
  if (/\b(gh|glab)\s+api\b/.test(cmd) && /(^|\s)(-X|--method|-f|-F|--field|--raw-field|--input)(?=[\s=]|$)/.test(cmd)) {
    return deny('writing to the forge API is not allowed; the factory talks to the forge.')
  }
  if (/\b(curl|wget)\b/.test(cmd) && CURL_WRITE.test(cmd) && mentionsForge(cmd, ctx)) {
    return deny('writing to the forge API is not allowed; the factory talks to the forge.')
  }
  if (new RegExp(`${GIT}remote\\s+(add|set-url|remove|rm|rename|set-head|set-branches)\\b`).test(cmd)) {
    return deny('changing git remotes is not allowed.')
  }
  const cfg = new RegExp(`${GIT}config\\b([^|;&\\n]*)`).exec(cmd)
  if (cfg && GIT_CONFIG_RISKY.test(cfg[1] ?? '')) return deny('changing git hooks, remotes, URLs, aliases or credentials config is not allowed.')
  if (GIT_INLINE_CONFIG.test(cmd)) return deny('git -c for hooks, remotes, URLs, aliases or credentials is not allowed.')
  if (/\.git\/hooks\b/.test(cmd)) return deny('touching .git/hooks is not allowed.')
  return ALLOW
}

function mentionsForge(cmd: string, ctx: GateCtx): boolean {
  if (/\/api\/v4\/|\/api\/graphql\b/.test(cmd)) return true
  const hosts = [...FORGE_HOSTS, ...(ctx.forgeHosts ?? [])].filter((h) => h !== '')
  return hosts.some((h) => new RegExp(`(^|[/@\\s'"])${escapeRe(h.toLowerCase())}(?=[:/\\s'"]|$)`).test(cmd.toLowerCase()))
}

function builderEdit(call: GateCall, ctx: GateCtx): GateResult {
  const raw = call.input.file_path ?? call.input.notebook_path
  if (typeof raw !== 'string' || raw === '') return deny(`${call.tool} without a file path is not allowed.`)
  if (!ctx.worktree || !ctx.worktree.startsWith('/')) return deny('no job worktree is known; edits are not allowed.')
  const wt = normalise(ctx.worktree)
  if (raw.startsWith('~')) return deny(`${raw} is outside the job worktree ${wt}.`)
  const abs = normalise(raw.startsWith('/') ? raw : `${wt}/${raw}`)
  if (!abs.startsWith(wt === '/' ? '/' : `${wt}/`)) return deny(`${raw} is outside the job worktree ${wt}; edit only files inside it.`)
  const rel = abs.slice(wt === '/' ? 1 : wt.length + 1)
  if (rel === '.git' || rel.startsWith('.git/')) return deny(`${raw} is inside .git; editing git internals is not allowed.`)
  if (rel === '.factory' || rel.startsWith('.factory/')) return deny(`${raw} is factory state; it is not editable.`)
  const hit = ctx.protectedPaths.find((g) => g.trim() !== '' && globRe(g.trim()).test(rel))
  if (hit !== undefined && !mentions(ctx.specText, rel)) {
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

// ---------- read-only Bash (allowlist) ----------

type Seg = string[]

const READ_PROGRAMS = new Set([
  'git', 'cat', 'head', 'tail', 'ls', 'grep', 'rg', 'find', 'wc', 'sort', 'uniq', 'diff', 'pwd', 'echo', 'tree', 'stat', 'file', 'which',
])
const GIT_READ = new Set(['diff', 'log', 'show', 'status', 'blame', 'grep', 'ls-files', 'rev-parse', 'branch'])
const BANNED = new Set(['xargs', 'sudo', 'env', 'sh', 'bash', 'eval'])

/** Undefined when every segment is an allowlisted read-only command; otherwise why not. */
export function readOnlyBash(cmd: string): string | undefined {
  const segs = splitShell(cmd)
  if (typeof segs === 'string') return segs
  if (segs.length === 0) return 'empty command'
  for (const words of segs) {
    const prog = words[0]
    if (prog === undefined) return 'empty command segment'
    if (BANNED.has(prog)) return `${prog} is not allowed`
    if (!READ_PROGRAMS.has(prog)) return `${prog} is not a read-only command`
    const why = checkArgs(prog, words.slice(1))
    if (why !== undefined) return why
  }
  return undefined
}

function checkArgs(prog: string, args: string[]): string | undefined {
  switch (prog) {
    case 'git': {
      const sub = args[0]
      if (sub === undefined || sub.startsWith('-')) return 'git options before the subcommand are not allowed'
      if (!GIT_READ.has(sub)) return `git ${sub} is not read-only`
      const rest = args.slice(1)
      if (sub === 'branch' && rest.some((a) => !['--list', '-a', '-r', '--show-current'].includes(a))) return 'git branch may only list'
      if (rest.some((a) => /^--(output|ext-diff|exec|open-files-in-pager)\b/.test(a) || /^-O/.test(a))) return `git ${sub} with that option is not allowed`
      return undefined
    }
    case 'find':
      if (args.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a))) return 'find may not delete, run commands or write files'
      return undefined
    case 'sort':
      if (args.some((a) => /^(-o|--output|--compress-program)/.test(a) || /^-[a-zA-Z]*o/.test(a))) return 'sort may not write files'
      return undefined
    case 'rg':
      if (args.some((a) => /^--pre(=|$)/.test(a))) return 'rg --pre is not allowed'
      return undefined
    case 'tree':
      if (args.some((a) => a === '-o' || /^-o/.test(a))) return 'tree may not write files'
      return undefined
    case 'file':
      if (args.some((a) => a === '-C' || a === '--compile')) return 'file -C is not allowed'
      return undefined
    case 'uniq':
      if (args.filter((a) => !a.startsWith('-')).length > 1) return 'uniq may not write an output file'
      return undefined
    default:
      return undefined
  }
}

/**
 * Splits a command into segments of words on `|`, `||`, `&&`, `;`, `&` and
 * newlines, honouring quotes. Returns a reason string for anything it will
 * not allow: redirection, process or command substitution, subshells.
 */
export function splitShell(cmd: string): Seg[] | string {
  const segs: Seg[] = []
  let words: string[] = []
  let word = ''
  let inWord = false
  const endWord = () => { if (inWord) words.push(word); word = ''; inWord = false }
  const endSeg = () => { endWord(); segs.push(words); words = [] }
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]
    if (c === "'") {
      const j = cmd.indexOf("'", i + 1)
      if (j < 0) return 'unterminated quote'
      word += cmd.slice(i + 1, j); inWord = true; i = j
    } else if (c === '"') {
      let j = i + 1
      for (; j < cmd.length && cmd[j] !== '"'; j++) {
        if (cmd[j] === '\\') { j++; continue }
        if (cmd[j] === '`' || (cmd[j] === '$' && cmd[j + 1] === '(')) return 'command substitution'
      }
      if (j >= cmd.length) return 'unterminated quote'
      word += cmd.slice(i + 1, j).replace(/\\(["\\$`])/g, '$1'); inWord = true; i = j
    } else if (c === '\\') {
      if (cmd[i + 1] === '\n') { i++; continue }
      word += cmd[i + 1] ?? ''; inWord = true; i++
    } else if (c === '`' || (c === '$' && cmd[i + 1] === '(')) {
      return 'command substitution'
    } else if (c === '>' || c === '<') {
      return 'redirection'
    } else if (c === '(' || c === ')' || (c === '{' && !inWord)) {
      return 'subshells and groups'
    } else if (c === '|' || c === ';' || c === '&' || c === '\n') {
      if ((c === '|' || c === '&') && cmd[i + 1] === c) i++
      endSeg()
    } else if (c === ' ' || c === '\t') {
      endWord()
    } else {
      word += c; inWord = true
    }
  }
  endSeg()
  // A trailing `;` or `&` leaves one empty segment; any other empty one is refused by the caller.
  if (segs.length > 1 && segs[segs.length - 1]?.length === 0) segs.pop()
  return segs
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
