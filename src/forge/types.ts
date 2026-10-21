import type { Comment, Job, JobRef, Station } from '../types'

export type HttpFn = (req: {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'PATCH'
  headers: Record<string, string>
  body?: string
}) => Promise<{ status: number; ok: boolean; text: string }>

export interface Forge {
  listJobs(project: string): Promise<JobRef[]>
  getJob(ref: JobRef): Promise<Job>
  comment(ref: JobRef, body: string): Promise<Comment>
  editComment(ref: JobRef, id: string, body: string): Promise<void>
  setStation(ref: JobRef, station: Station): Promise<void>
  createIssue(project: string, title: string, body: string): Promise<JobRef>
  openMR(ref: JobRef, branch: string, title: string, body: string): Promise<{ url: string }>
  defaultBranch(project: string): Promise<string>
  cloneUrl(project: string): string
  /** Tokenless https clone URL, safe to leave as a checkout's `origin`. */
  publicUrl(project: string): string
  /** The open MR/PR whose source is `branch`, if any. */
  findOpenMR(project: string, branch: string): Promise<{ url: string } | null>
  /** Username of the account the token belongs to. */
  whoami(): Promise<string>
  /** Raw text of a repository file at a ref; null when it does not exist (404). */
  readFile(project: string, path: string, ref: string): Promise<string | null>
}

export class ForgeError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ForgeError'
    this.status = status
  }
}
