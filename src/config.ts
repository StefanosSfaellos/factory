import { parseYaml } from './yaml'

export type Role =
  | 'spec-writer'
  | 'designer'
  | 'planner'
  | 'builder'
  | 'code-reviewer'
  | 'security-reviewer'
  | 'ux-reviewer'
  | 'approver'

export type Reviewer = 'code' | 'security' | 'ux'

export type RepoConfig = {
  forge: 'github' | 'gitlab'
  test: string
  setup?: string
  reviewers: Reviewer[]
  protectedPaths: string[]
  models: Partial<Record<Role, string>>
  limits: { fixLoops: number; parallel: number }
  branchPrefix: string
  allowedTools: string[]
  /** R24: Claude Code Bash sandbox options for child agents. */
  sandbox: { allowedDomains: string[]; required: boolean }
}

const ROLES: Role[] = [
  'spec-writer', 'designer', 'planner', 'builder',
  'code-reviewer', 'security-reviewer', 'ux-reviewer', 'approver',
]
const REVIEWERS: Reviewer[] = ['code', 'security', 'ux']
const KEYS = ['forge', 'test', 'setup', 'reviewers', 'protectedPaths', 'models', 'limits', 'branchPrefix', 'allowedTools', 'sandbox']

export const DEFAULT_MODELS: Record<Role, string> = {
  'spec-writer': 'opus',
  designer: 'opus',
  planner: 'sonnet',
  builder: 'sonnet',
  'code-reviewer': 'opus',
  'security-reviewer': 'opus',
  'ux-reviewer': 'sonnet',
  approver: 'sonnet',
}

type Result = { ok: true; config: RepoConfig } | { ok: false; error: string }

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function strList(v: unknown, name: string): string[] {
  if (v === '' || v === undefined) return []
  if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) throw new Error(`${name} must be a list of strings`)
  return v as string[]
}

function posInt(v: unknown, name: string, dflt: number): number {
  if (v === undefined) return dflt
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error(`${name} must be a positive integer`)
  return v
}

export function parseRepoConfig(text: string): Result {
  try {
    const raw = parseYaml(text)
    if (!isObj(raw)) throw new Error('config must be a map')
    // A typo (`protectedPath:`) must not silently drop a control.
    for (const k of Object.keys(raw)) {
      if (!KEYS.includes(k)) throw new Error(`unknown key "${k}" in .factory.yml (expected one of ${KEYS.join(', ')})`)
    }
    if (raw.forge === undefined) throw new Error('missing required key: forge (github | gitlab)')
    if (raw.forge !== 'github' && raw.forge !== 'gitlab') throw new Error(`forge must be github or gitlab, got ${String(raw.forge)}`)
    if (raw.test === undefined || typeof raw.test !== 'string' || raw.test.trim() === '') throw new Error('missing required key: test (command the verify station runs)')
    if (raw.setup !== undefined && typeof raw.setup !== 'string') throw new Error('setup must be a string')

    const reviewers = raw.reviewers === undefined ? (['code', 'security'] as Reviewer[]) : strList(raw.reviewers, 'reviewers')
    if (reviewers.length === 0) throw new Error('reviewers must list at least one of code, security, ux')
    for (const r of reviewers) if (!REVIEWERS.includes(r as Reviewer)) throw new Error(`unknown reviewer "${r}" (expected code, security or ux)`)

    const models: Partial<Record<Role, string>> = {}
    if (raw.models !== undefined && raw.models !== '') {
      if (!isObj(raw.models)) throw new Error('models must be a map')
      for (const [k, v] of Object.entries(raw.models)) {
        if (!ROLES.includes(k as Role)) throw new Error(`unknown role "${k}" in models`)
        if (typeof v !== 'string' || v === '') throw new Error(`model for ${k} must be a string`)
        models[k as Role] = v
      }
    }

    let fixLoops = 3
    let parallel = 2
    if (raw.limits !== undefined && raw.limits !== '') {
      if (!isObj(raw.limits)) throw new Error('limits must be a map')
      fixLoops = posInt(raw.limits.fixLoops, 'limits.fixLoops', 3)
      parallel = posInt(raw.limits.parallel, 'limits.parallel', 2)
    }

    const branchPrefix = raw.branchPrefix === undefined ? 'factory/' : raw.branchPrefix
    if (typeof branchPrefix !== 'string') throw new Error('branchPrefix must be a string')

    const sandbox = { allowedDomains: [] as string[], required: false }
    if (raw.sandbox !== undefined && raw.sandbox !== '') {
      if (!isObj(raw.sandbox)) throw new Error('sandbox must be a map (allowedDomains, required)')
      for (const k of Object.keys(raw.sandbox)) {
        if (k !== 'allowedDomains' && k !== 'required') throw new Error(`unknown key "${k}" in sandbox (expected allowedDomains, required)`)
      }
      sandbox.allowedDomains = strList(raw.sandbox.allowedDomains, 'sandbox.allowedDomains')
      if (sandbox.allowedDomains.some((d) => d.trim() === '' || /[\s"']/.test(d))) throw new Error('sandbox.allowedDomains entries must be non-empty host names')
      const req = raw.sandbox.required
      if (req !== undefined && typeof req !== 'boolean') throw new Error('sandbox.required must be true or false')
      sandbox.required = req === true
    }

    const config: RepoConfig = {
      forge: raw.forge,
      test: raw.test,
      reviewers: reviewers as Reviewer[],
      protectedPaths: strList(raw.protectedPaths, 'protectedPaths'),
      models,
      limits: { fixLoops, parallel },
      branchPrefix,
      allowedTools: strList(raw.allowedTools, 'allowedTools'),
      sandbox,
    }
    if (raw.setup !== undefined) config.setup = raw.setup
    return { ok: true, config }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export function modelFor(role: Role, cfg: RepoConfig): string {
  return cfg.models[role] ?? DEFAULT_MODELS[role]
}
