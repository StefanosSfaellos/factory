import type { Role } from './config'

export const STATIONS = [
  'ready', 'spec', 'awaiting-spec', 'design', 'plan', 'build',
  'verify', 'review', 'approve', 'mr-open', 'done', 'blocked',
] as const
export type Station = (typeof STATIONS)[number]

export type ForgeKind = 'github' | 'gitlab'
/** `host` is the forge's lower-case host name: github.com, gitlab.com, lab.example.gr. */
export type JobRef = { forge: ForgeKind; host: string; project: string; issue: number }
/** What a wildcard repo entry lists: every visible project, or one group/owner (GitLab: with subgroups). */
export type ListScope = { kind: 'all' } | { kind: 'group'; path: string }
/** A `repos` entry: one project, or (with `scope`) a wildcard whose `project` is its pattern (`*`, `group/*`). */
export type Project = { forge: ForgeKind; host: string; project: string; scope?: ListScope }
export type Comment = { id: string; body: string; createdAt: string; author: string; trusted?: boolean }
export type Job = { ref: JobRef; title: string; body: string; labels: string[]; comments: Comment[] }
export type Verdict = { role: Role; pass: boolean; findings: string }
