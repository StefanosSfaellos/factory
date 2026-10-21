// Minimal YAML subset: maps, 2-space nested maps, block lists, inline lists/maps,
// quoted/unquoted strings, integers, booleans, `#` comments.

type Line = { n: number; indent: number; text: string }

function fail(n: number, reason: string): never {
  throw new Error(`yaml line ${n}: ${reason}`)
}

// Remove a trailing comment, respecting quotes.
function stripComment(s: string): string {
  let q = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === '\\' && q === '"') i++
      else if (c === q) q = ''
    } else if (c === '"' || c === "'") q = c
    else if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i)
  }
  return s
}

function parseScalar(raw: string, n: number): unknown {
  const s = raw.trim()
  if (s === '') return ''
  if (s[0] === '"') {
    if (s.length < 2 || s[s.length - 1] !== '"') fail(n, 'unterminated string')
    return s.slice(1, -1).replace(/\\(["\\nt])/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c))
  }
  if (s[0] === "'") {
    if (s.length < 2 || s[s.length - 1] !== "'") fail(n, 'unterminated string')
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s[0] === '[' || s[0] === '{') return parseInline(s, n)
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return parseInt(s, 10)
  return s
}

// Split on top-level commas (outside quotes and nested brackets).
function splitTop(s: string, n: number): string[] {
  const parts: string[] = []
  let depth = 0
  let q = ''
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      cur += c
      if (c === '\\' && q === '"') cur += s[++i] ?? ''
      else if (c === q) q = ''
    } else if (c === '"' || c === "'") {
      q = c
      cur += c
    } else if (c === '[' || c === '{') {
      depth++
      cur += c
    } else if (c === ']' || c === '}') {
      depth--
      cur += c
    } else if (c === ',' && depth === 0) {
      parts.push(cur)
      cur = ''
    } else cur += c
  }
  if (q || depth !== 0) fail(n, 'unbalanced brackets or quotes')
  if (cur.trim() !== '' || parts.length > 0) parts.push(cur)
  return parts
}

// Index of the key/value colon (followed by space or end), outside quotes/brackets.
function colonIndex(s: string): number {
  let q = ''
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (q) {
      if (c === '\\' && q === '"') i++
      else if (c === q) q = ''
    } else if (c === '"' || c === "'") q = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    else if (c === ':' && depth === 0 && (i === s.length - 1 || s[i + 1] === ' ')) return i
  }
  return -1
}

function parseKey(k: string, n: number): string {
  const v = parseScalar(k, n)
  if (typeof v !== 'string' || v === '') fail(n, 'invalid key')
  return v
}

function parseInline(s: string, n: number): unknown {
  const open = s[0]
  const close = open === '[' ? ']' : '}'
  if (s[s.length - 1] !== close) fail(n, `expected ${close}`)
  const inner = s.slice(1, -1)
  const parts = splitTop(inner, n)
  if (open === '[') return parts.map(p => parseScalar(p, n))
  const out: Record<string, unknown> = {}
  for (const p of parts) {
    const i = colonIndex(p.trim())
    if (i < 0) fail(n, 'expected "key: value" in inline map')
    const t = p.trim()
    out[parseKey(t.slice(0, i), n)] = parseScalar(t.slice(i + 1), n)
  }
  return out
}

export function parseYaml(text: string): unknown {
  const lines: Line[] = []
  text.split(/\r?\n/).forEach((full, idx) => {
    const n = idx + 1
    const m = /^[ \t]*/.exec(full)![0]
    if (m.includes('\t')) {
      if (stripComment(full).trim() === '') return
      fail(n, 'tab indentation is not allowed')
    }
    const body = stripComment(full).replace(/\s+$/, '')
    if (body.trim() === '') return
    lines.push({ n, indent: m.length, text: body.trim() })
  })
  if (lines.length === 0) return {}
  let pos = 0

  function block(indent: number): unknown {
    const first = lines[pos]
    if (first.indent !== indent) fail(first.n, 'bad indentation')
    return first.text === '-' || first.text.startsWith('- ') ? list(indent) : map(indent)
  }

  function list(indent: number): unknown[] {
    const out: unknown[] = []
    while (pos < lines.length && lines[pos].indent === indent) {
      const l = lines[pos]
      if (!(l.text === '-' || l.text.startsWith('- '))) fail(l.n, 'expected list item')
      const rest = l.text.slice(1).trim()
      pos++
      if (rest === '') {
        if (pos < lines.length && lines[pos].indent > indent) out.push(block(lines[pos].indent))
        else out.push('')
      } else if (colonIndex(rest) >= 0 && rest[0] !== '"' && rest[0] !== "'" && rest[0] !== '[' && rest[0] !== '{') {
        fail(l.n, 'maps inside block lists are not supported')
      } else out.push(parseScalar(rest, l.n))
    }
    if (pos < lines.length && lines[pos].indent > indent) fail(lines[pos].n, 'bad indentation')
    return out
  }

  function map(indent: number): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    while (pos < lines.length && lines[pos].indent === indent) {
      const l = lines[pos]
      const i = colonIndex(l.text)
      if (i < 0) fail(l.n, 'expected "key: value"')
      const key = parseKey(l.text.slice(0, i), l.n)
      if (key in out) fail(l.n, `duplicate key "${key}"`)
      const rest = l.text.slice(i + 1).trim()
      pos++
      if (rest !== '') out[key] = parseScalar(rest, l.n)
      else if (pos < lines.length && lines[pos].indent > indent) out[key] = block(lines[pos].indent)
      else if (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) out[key] = list(indent)
      else out[key] = ''
    }
    if (pos < lines.length && lines[pos].indent > indent) fail(lines[pos].n, 'bad indentation')
    return out
  }

  const result = block(lines[0].indent)
  if (pos < lines.length) fail(lines[pos].n, 'bad indentation')
  return result
}
