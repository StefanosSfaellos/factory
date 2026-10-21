import type { Comment, Job, JobRef, Station } from '../types'

export type HttpFn = (req: {
  url: string
  method: 'GET' | 'POST' | 'PUT'
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
  /** Username of the account the token belongs to. */
  whoami(): Promise<string>
}

export class ForgeError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'ForgeError'
    this.status = status
  }
}
