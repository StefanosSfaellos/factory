import type { Role } from './config'

export type Station =
  | 'ready' | 'spec' | 'awaiting-spec' | 'design' | 'plan' | 'build'
  | 'verify' | 'review' | 'approve' | 'mr-open' | 'done' | 'blocked'

export type JobRef = { forge: 'github' | 'gitlab'; project: string; issue: number }
export type Comment = { id: string; body: string; createdAt: string; author: string }
export type Job = { ref: JobRef; title: string; body: string; labels: string[]; comments: Comment[] }
export type Verdict = { role: Role; pass: boolean; findings: string }
