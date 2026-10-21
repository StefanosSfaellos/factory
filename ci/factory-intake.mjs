// Turns a failed default-branch CI job into a factory issue labelled `factory::ready`.
// Plain Node >= 20, no dependencies. Env: FORGE (github|gitlab), PROJECT, TOKEN,
// API_URL (optional), JOB_NAME, LOG_FILE.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const TAIL_LINES = 80
const MAX_PAGES = 5

export function firstErrorLine(log) {
  const lines = log.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  return lines.find((l) => /error|fail|exception|fatal/i.test(l)) ?? lines[0] ?? ''
}

export function fingerprint(jobName, log) {
  return createHash('sha256').update(jobName + firstErrorLine(log)).digest('hex')
}

const tail = (log) => log.replace(/\n+$/, '').split('\n').slice(-TAIL_LINES).join('\n')

function api(env) {
  const github = env.FORGE === 'github'
  const base = (env.API_URL || (github ? 'https://api.github.com' : 'https://gitlab.com')).replace(/\/+$/, '')
  const headers = github
    ? { Authorization: `Bearer ${env.TOKEN}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'software-factory-ci' }
    : { 'PRIVATE-TOKEN': env.TOKEN, 'Content-Type': 'application/json' }
  const root = github ? `${base}/repos/${env.PROJECT}` : `${base}/api/v4/projects/${encodeURIComponent(env.PROJECT)}`
  const call = async (method, url, body) => {
    const res = await fetch(url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    if (!res.ok) throw new Error(`${method} ${url.replace(base, '')} failed: ${res.status}`)
    return res.json()
  }
  return { github, root, call }
}

async function findOpen(a, fp) {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = a.github
      ? `${a.root}/issues?state=open&per_page=100&page=${page}`
      : `${a.root}/issues?state=opened&per_page=100&page=${page}&search=${fp}&in=description`
    const list = await a.call('GET', url)
    for (const i of list) {
      if (String(a.github ? i.body : i.description ?? '').includes(`factory-fingerprint: ${fp}`)) return a.github ? i.number : i.iid
    }
    if (list.length < 100) break
  }
  return undefined
}

export async function run(env) {
  for (const k of ['FORGE', 'PROJECT', 'TOKEN', 'JOB_NAME', 'LOG_FILE']) if (!env[k]) throw new Error(`${k} is not set`)
  if (env.FORGE !== 'github' && env.FORGE !== 'gitlab') throw new Error('FORGE must be github or gitlab')
  const log = readFileSync(env.LOG_FILE, 'utf8')
  const fp = fingerprint(env.JOB_NAME, log)
  const text = '```\n' + tail(log) + '\n```'
  const a = api(env)
  const existing = await findOpen(a, fp)
  if (existing !== undefined) {
    const body = `CI failed again on the default branch. Log tail:\n\n${text}`
    await a.call('POST', a.github ? `${a.root}/issues/${existing}/comments` : `${a.root}/issues/${existing}/notes`, { body })
    return { action: 'commented', issue: existing }
  }
  const body = `The \`${env.JOB_NAME}\` job failed on the default branch.\n\nfactory-fingerprint: ${fp}\n\nLog tail:\n\n${text}`
  const title = `CI failure: ${env.JOB_NAME}`
  const made = a.github
    ? await a.call('POST', `${a.root}/issues`, { title, body, labels: ['factory::ready'] })
    : await a.call('POST', `${a.root}/issues`, { title, description: body, labels: 'factory::ready' })
  return { action: 'created', issue: a.github ? made.number : made.iid }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(process.env)
    .then((r) => console.log(`factory-intake: ${r.action} #${r.issue}`))
    .catch((e) => { console.error(`factory-intake: ${e.message}`); process.exit(1) })
}
