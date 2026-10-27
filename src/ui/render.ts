import { redact } from '../redact'
import type { JobRef, Station } from '../types'
import { entryLabel, refLabel } from '../hosts'
import { bandText, jobKey, sameRef, type JobView } from './model'

// Trees for the band and the pane. Pure: the element constructors come in from
// `$.ui.resolve(e)` in hooks/register.ts, the handlers as plain closures. Every
// string drawn goes through `redact` with the session's secrets.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ctor<N> = (props: any) => N
/** The element table `$.ui.resolve(e)` hands out; Input, Link and Svg are not on every surface. */
export type Elements<N> = {
  Box: Ctor<N>
  Text: Ctor<N>
  Button: Ctor<N>
  Markdown: Ctor<N>
  Link?: Ctor<N>
  Input?: Ctor<N>
  Svg?: Ctor<N>
}

/** What the buttons do; a handler may return the work it started, which the surface awaits. */
export type Actions = {
  select: (ref: JobRef) => Promise<unknown> | void
  review: (ref: JobRef) => Promise<unknown> | void
  back: () => Promise<unknown> | void
  approve: (ref: JobRef) => Promise<unknown> | void
  revise: (ref: JobRef, notes: string) => Promise<unknown> | void
  refresh: () => Promise<unknown> | void
}

export type PaneOpts = {
  actions: Actions
  secrets: string[]
  /** The selected job's spec and dossier, read from the forge when it was selected. */
  detail?: { spec: string; dossier: string; review: boolean }
  /** The last outcome of a press (approved, refused, an error). */
  message?: string
  /** Projects that could not be read. */
  errors?: string[]
  /** GITLAB_URL's host: GitLab jobs on it are shown without their host. Default gitlab.com. */
  gitlabHost?: string
  /** Set when there is nothing to work: no repos configured. */
  empty?: string
}

const LINE: Station[] = ['ready', 'spec', 'awaiting-spec', 'design', 'plan', 'build', 'verify', 'review', 'approve', 'mr-open', 'blocked']

/**
 * The id part of a job's element keys: the issue number, or the full reference
 * (punctuation folded to `-`) when two configured repos share that number.
 */
export function uiId(jobs: JobView[], ref: JobRef): string {
  const clash = jobs.some((j) => j.ref.issue === ref.issue && !sameRef(j.ref, ref))
  return clash ? `${ref.forge}-${ref.host}-${ref.project}-${ref.issue}`.replace(/[^A-Za-z0-9-]/g, '-') : String(ref.issue)
}

export function age(ms: number): string {
  const m = Math.floor(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h}h` : `${Math.floor(h / 24)}d`
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** The station strip: one dot per station, filled and counted where jobs are. */
export function stationStrip(jobs: JobView[]): string {
  const step = 56
  const w = step * LINE.length
  const parts = LINE.map((s, i) => {
    const n = jobs.filter((j) => j.station === s).length
    const x = i * step + step / 2
    const color = s === 'blocked' ? '#d1453b' : jobs.some((j) => j.station === s && j.needsHuman) ? '#d08a00' : '#3b7dd8'
    const dot = n > 0
      ? `<circle cx="${x}" cy="14" r="9" fill="${color}"/><text x="${x}" y="18" font-size="11" text-anchor="middle" fill="#fff">${n}</text>`
      : `<circle cx="${x}" cy="14" r="5" fill="none" stroke="#888"/>`
    return `${dot}<text x="${x}" y="40" font-size="9" text-anchor="middle" fill="#888">${esc(s)}</text>`
  })
  const rail = `<line x1="${step / 2}" y1="14" x2="${w - step / 2}" y2="14" stroke="#888" stroke-width="1"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="48" viewBox="0 0 ${w} 48">${rail}${parts.join('')}</svg>`
}

/** The band above the prompt: the one-line summary, and a Review button per spec waiting on a person. */
export function bandTree<N>(el: Elements<N>, jobs: JobView[], opts: { actions: Actions; secrets: string[] }): N {
  const { Box, Text, Button } = el
  const t = (s: string) => redact(s, opts.secrets)
  const waiting = jobs.filter((j) => j.station === 'awaiting-spec' && j.needsHuman)
  return Box({
    flexDirection: 'row',
    gap: 1,
    children: [
      Text({ children: t(bandText(jobs)) }),
      ...waiting.slice(0, 9).map((j, i) => Button({
        key: `review-${uiId(jobs, j.ref)}`,
        label: t(`Review spec #${j.ref.issue}`),
        hotkey: String(i + 1),
        onPress: () => opts.actions.review(j.ref),
      })),
    ],
  })
}

function jobRow<N>(el: Elements<N>, jobs: JobView[], j: JobView, opts: PaneOpts): N {
  const { Box, Text, Button } = el
  const t = (s: string) => redact(s, opts.secrets)
  const id = uiId(jobs, j.ref)
  const meta = [entryLabel(j.ref, opts.gitlabHost || 'gitlab.com'), age(j.sinceMs)]
  if (j.fixLoops > 0) meta.push(`fix loops ${j.fixLoops}`)
  if (j.needsHuman) meta.push('needs you')
  const decide = j.station === 'awaiting-spec' && j.needsHuman
  return Box({
    flexDirection: 'column',
    children: [
      Box({
        flexDirection: 'row',
        gap: 1,
        children: [
          Button({ key: `job-${id}`, plain: true, label: t(`#${j.ref.issue} ${j.title}`), onPress: () => opts.actions.select(j.ref) }),
          Text({ dimColor: true, children: t(meta.join(' · ')) }),
        ],
      }),
      j.progress !== undefined ? Text({ dimColor: true, wrap: 'truncate-end', children: t(`  > ${j.progress}`) }) : null,
      decide
        ? Box({
            flexDirection: 'row',
            gap: 1,
            children: [
              Button({ key: `approve-${id}`, label: 'Approve', variant: 'primary', onPress: () => opts.actions.approve(j.ref) }),
              Button({ key: `revise-${id}`, label: 'Revise', onPress: () => opts.actions.review(j.ref) }),
            ],
          })
        : null,
    ],
  })
}

/** The spec of a job awaiting a decision, with Approve and the notes field that sends it back. */
export function specReviewTree<N>(el: Elements<N>, job: JobView, specMarkdown: string, opts: PaneOpts & { jobs?: JobView[] }): N {
  const { Box, Text, Button, Markdown, Input } = el
  const t = (s: string) => redact(s, opts.secrets)
  const id = uiId(opts.jobs ?? [job], job.ref)
  return Box({
    flexDirection: 'column',
    gap: 1,
    children: [
      Box({
        flexDirection: 'row',
        gap: 1,
        children: [
          Button({ key: 'back', label: 'Back', onPress: () => opts.actions.back() }),
          Text({ bold: true, children: t(`Spec for #${job.ref.issue} ${job.title}`) }),
        ],
      }),
      links(el, job, opts.secrets),
      Markdown({ text: t(specMarkdown || '_No spec comment found._') }),
      Button({ key: `approve-${id}`, label: 'Approve', variant: 'primary', onPress: () => opts.actions.approve(job.ref) }),
      Input
        ? Input({
            key: `notes-${id}`,
            label: 'Revise: ',
            placeholder: 'what should change in the spec',
            submitLabel: 'send back',
            onSubmit: (value: string) => opts.actions.revise(job.ref, value),
          })
        : Text({ dimColor: true, children: t(`To send it back with notes: /factory revise ${refLabel(job.ref, opts.gitlabHost || 'gitlab.com')} <notes>`) }),
      opts.message ? Text({ children: t(opts.message) }) : null,
    ],
  })
}

function links<N>(el: Elements<N>, job: JobView, secrets: string[]): N {
  const { Box, Text, Link } = el
  const t = (s: string) => redact(s, secrets)
  const items: [string, string][] = [['issue', job.links.issue]]
  if (job.links.mr) items.push(['merge request', job.links.mr])
  return Box({
    flexDirection: 'row',
    gap: 2,
    children: items.map(([label, href]) => (Link ? Link({ href: t(href), label }) : Text({ dimColor: true, children: t(`${label}: ${href}`) }))),
  })
}

/**
 * The pipeline pane: the job list grouped by station, or the selected job's
 * dossier or spec review. `selected` is the job's `jobKey`.
 */
export function paneTree<N>(el: Elements<N>, jobs: JobView[], selected: string | undefined, surface: string, opts: PaneOpts): N {
  const { Box, Text, Button, Markdown, Svg } = el
  const t = (s: string) => redact(s, opts.secrets)
  const job = selected === undefined ? undefined : jobs.find((j) => jobKey(j.ref) === selected)

  if (job && opts.detail) {
    if (opts.detail.review && job.station === 'awaiting-spec' && job.needsHuman) {
      return specReviewTree(el, job, opts.detail.spec, { ...opts, jobs })
    }
    return Box({
      flexDirection: 'column',
      gap: 1,
      children: [
        Box({
          flexDirection: 'row',
          gap: 1,
          children: [
            Button({ key: 'back', label: 'Back', onPress: () => opts.actions.back() }),
            Text({ bold: true, children: t(`#${job.ref.issue} ${job.title}`) }),
            Text({ dimColor: true, children: t(`${job.station} · ${age(job.sinceMs)}${job.fixLoops ? ` · fix loops ${job.fixLoops}` : ''}`) }),
          ],
        }),
        links(el, job, opts.secrets),
        Markdown({ text: t(opts.detail.dossier) }),
        opts.message ? Text({ children: t(opts.message) }) : null,
      ],
    })
  }

  const groups = LINE.map((s) => [s, jobs.filter((j) => j.station === s)] as const).filter(([, js]) => js.length > 0)
  return Box({
    flexDirection: 'column',
    gap: 1,
    children: [
      Box({
        flexDirection: 'row',
        gap: 1,
        children: [
          Text({ bold: true, children: t(bandText(jobs)) }),
          Button({ key: 'refresh', label: 'Refresh', dimColor: true, onPress: () => opts.actions.refresh() }),
        ],
      }),
      surface === 'desktop' && Svg
        ? Svg({ source: stationStrip(jobs), alt: t(groups.map(([s, js]) => `${s}: ${js.length}`).join(', ') || 'no jobs') })
        : Text({ dimColor: true, children: t(groups.map(([s, js]) => `${s} ${js.length}`).join(' | ') || 'no jobs on the line') }),
      opts.empty ? Text({ children: t(opts.empty) }) : null,
      ...(opts.errors ?? []).map((e) => Text({ color: 'red', children: t(e) })),
      opts.message ? Text({ children: t(opts.message) }) : null,
      ...groups.map(([s, js]) => Box({
        flexDirection: 'column',
        children: [Text({ bold: true, children: t(s) }), ...js.map((j) => jobRow(el, jobs, j, opts))],
      })),
    ],
  })
}
