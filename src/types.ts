import type { Role } from './config'

export const STATIONS = [
  'ready', 'spec', 'awaiting-spec', 'design', 'plan', 'build',
  'verify', 'review', 'approve', 'mr-open', 'done', 'blocked',
] as const
export type Station = (typeof STATIONS)[number]

export type JobRef = { forge: 'github' | 'gitlab'; project: string; issue: number }
export type Comment = { id: string; body: string; createdAt: string; author: string; trusted?: boolean }
export type Job = { ref: JobRef; title: string; body: string; labels: string[]; comments: Comment[] }
export type Verdict = { role: Role; pass: boolean; findings: string }
