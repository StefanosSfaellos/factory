// The session state the factory's UI draws from. Self-contained by rule: these
// mirror JobRef/Station (src/types.ts) and JobView (src/ui/model.ts).

export type FactoryStation =
  | 'ready' | 'spec' | 'awaiting-spec' | 'design' | 'plan' | 'build'
  | 'verify' | 'review' | 'approve' | 'mr-open' | 'done' | 'blocked'

export type FactoryJobRef = { forge: 'github' | 'gitlab'; host: string; project: string; issue: number }

export type FactoryJobView = {
  ref: FactoryJobRef
  title: string
  station: FactoryStation
  sinceMs: number
  fixLoops: number
  progress?: string
  needsHuman: boolean
  links: { issue: string; mr?: string }
}

/** A station running in this session now: what the spinner suffix names. */
export type RunningStation = { ref: FactoryJobRef; station: FactoryStation }

/** The selected job's spec and dossier, read from the forge when it was selected. */
export type JobDetail = { spec: string; dossier: string; review: boolean }

declare module 'claude-code' {
  interface PluginState {
    'software-factory': {
      jobs: FactoryJobView[]
      loaded: boolean
      errors: string[]
      selected: string | null
      detail: JobDetail | null
      message: string | null
      running: RunningStation[]
    }
  }
}
