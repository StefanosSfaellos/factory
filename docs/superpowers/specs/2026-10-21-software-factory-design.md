# Software Factory — Design Spec

Date: 2026-10-21 · Status: awaiting review · Author: Claude with st.sfaellos

## 1. Goal

Turn a work item into a reviewed, tested merge/pull request with as little human time as possible, using Claude Code agents arranged as an assembly line. A human approves exactly two things: the **spec** (before any code) and the **final MR/PR** (before merge). Everything in between — design, planning, test-first building, independent verification, review and automated code approval — runs by itself.

### Success criteria
1. Labelling an issue `factory::ready` (GitHub or GitLab) results, without further input, in a spec comment on the issue and the job waiting at `factory::awaiting-spec`.
2. After the human approves the spec, the job reaches an open MR/PR whose description links the spec, design note, plan, test results and every reviewer verdict.
3. No code reaches the MR/PR unless (a) the factory itself re-ran the repo's tests in a clean worktree and they passed, and (b) every required reviewer station returned `pass`. A mod enforces this; an agent cannot talk its way past it.
4. The same plugin works unattended (scheduled `claude -p` / cloud session) and watched (terminal, Desktop Code tab, VS Code), and both see the same job state.
5. A watching human can see every job's station, progress and blockers at a glance, and is notified when their approval is needed.
6. Works on any repo that has a `.factory.yml`; nothing is specific to one codebase.

### Non-goals (v1)
- Webhook receiver / hosted service (polling only; webhooks are a later add-on).
- Auto-merging. The human always merges.
- Forges other than GitHub and GitLab (incl. self-hosted lab.ironcloud.gr).
- Deploying anything.

## 2. Architecture overview

```
 Intake sources                 Queue (the forge)                 Workers (Claude Code + factory plugin)
 ─────────────                  ─────────────────                 ─────────────────────────────────────
 GitHub label ─┐                                                   Headless: claude -p "/factory tick"
 GitLab label ─┼──► labelled issue = job ──► labels = station ◄──►   (scheduled cloud task or server cron)
 /factory new ─┤      comments = artifacts                         Watched: local session, same plugin,
 CI failure  ──┘      lease comment = lock                           pane + band + /factory commands
```

One rule makes "local or remote" work: **the forge is the single source of truth.** Job state lives in issue labels and factory comments, never only in mod memory or `$.store` (which is per-machine). Any worker anywhere can pick up any job by reading the issue.

The deliverable is one Claude Code plugin, `software-factory`, containing:

| Part | Kind | Purpose |
|---|---|---|
| `hooks/register.ts` + `src/` | Mod | State machine, gates, model routing, `/factory` commands, ticker, UI |
| `agents/*.md` | Subagent definitions | One per role (spec-writer, designer, planner, builder, verifier-analyst, code-reviewer, security-reviewer, ux-reviewer, approver) |
| `skills/*/SKILL.md` | Skills | Station procedures each role follows (e.g. "write a spec", "build test-first") |
| `ci/` | Snippets | GitHub Action + GitLab CI job that turn a failed pipeline into a factory issue |
| `templates/.factory.yml` | Template | Per-repo config |

## 3. The job and its stations

A **job** is an issue carrying a `factory::*` label. Its station is the single `factory::<station>` label present.

| # | Station label | Who works | Output (posted as issue comment, marked `<!-- factory:<kind> -->`) | Exit condition |
|---|---|---|---|---|
| 0 | `factory::ready` | — | — | Picked up by a worker |
| 1 | `factory::spec` | spec-writer (Opus) | Spec: goal, scope, acceptance criteria, risks | Spec comment posted |
| 2 | `factory::awaiting-spec` | **Human** | — | Human adds `factory::spec-approved` label or comments `/approve` (`/revise <notes>` sends back to 1) |
| 3 | `factory::design` | designer | Design note: components, data flow, UI sketch if UI-touching; "N/A" allowed for non-UI | Design comment posted |
| 4 | `factory::plan` | planner | Ordered task list with test-per-task | Plan comment posted |
| 5 | `factory::build` | builder(s) in an isolated worktree on branch `factory/<id>-<slug>` | Commits; tests written **before** implementation for each task | Builder reports done |
| 6 | `factory::verify` | **The mod itself** (no agent) | Test report: command, exit code, counts, log tail | Repo test command exits 0 in a fresh clean checkout of the branch |
| 7 | `factory::review` | code-reviewer, security-reviewer, ux-reviewer (as configured) — in parallel | One verdict comment each: `pass` / `fail` + findings | All required verdicts present |
| 8 | `factory::approve` | approver agent + mod check | Approval summary | All verdicts `pass` → MR opens. Any `fail` → back to 5 with findings (max `limits.fixLoops`, then `factory::blocked`) |
| 9 | `factory::mr-open` | **Human** | MR/PR with full dossier | Human merges → `factory::done` (closed) |
| — | `factory::blocked` | **Human** | Reason comment | Human fixes and relabels to any station |

Verify (6) is deliberately not an agent: the builder could claim tests pass; the mod runs them itself via `$.process.run`, so the claim is checked independently.

Failed verify returns to build with the log, counting toward the same fix-loop limit.

## 4. The mod (core of the factory)

### 4.1 Modules (`src/`)
Each file has one job and a typed interface; all are unit-testable without a session.

| Module | Responsibility | Depends on |
|---|---|---|
| `config.ts` | Load + validate `.factory.yml` and plugin `userConfig` | `$.fs` |
| `forge/types.ts` | `Forge` interface: `listJobs`, `getIssue`, `setStation`, `comment`, `findComments`, `openMR`, `createIssue`, `acquireLease`, `releaseLease` | — |
| `forge/github.ts`, `forge/gitlab.ts` | Implementations over REST via `$.http.fetch` (GitLab base URL configurable, e.g. `https://lab.ironcloud.gr`) | `$.http`, `$.env` |
| `machine.ts` | Pure state machine: `(job, event) → next station + effects`. No I/O. | — |
| `lease.ts` | Lease protocol (see 4.3) | `forge` |
| `stations.ts` | Runs one station for one job: build prompt, spawn agent(s), collect output, post comment, advance | `$.agent`, `forge`, `machine` |
| `verify.ts` | Clean checkout + run test command + parse result | `$.process` |
| `gates.ts` | `tool.call` / `tool.check` hooks that block out-of-order actions | `machine`, current job context |
| `routing.ts` | `agent.spawn` hook: role → model | `config` |
| `ticker.ts` | `/factory tick` body and the `$.clock.every` loop in watched sessions | all of the above |
| `ui/` | Pane, band, spinner suffix, toasts | `$.ui`, `$.state` |
| `notify.ts` | Optional Slack webhook message on "needs human" transitions | `$.http` |

### 4.2 Gates (what the mod refuses)
Implemented as `tool.call` hooks with a `.catch` that **fails closed** (`{ deny }`), so a crashing guard never lets an action through.

- `git push`, MR/PR creation (Bash `gh pr create`, `glab mr create`, and forge MCP tools such as `mcp__*__save_merge_request`) are denied unless the active job is at `factory::approve` and the mod itself is the caller. Agents never open MRs; the mod does.
- Edits/Writes outside the job's worktree are denied while a job is running.
- `git push --force`, `git reset --hard` on non-factory branches, and writes to the default branch are always denied.
- A builder subagent may not edit files under configured `protectedPaths` (e.g. migrations, CI config) unless the spec lists them.
- Reviewer subagents are read-only: `tool.check` denies Edit/Write/Bash-with-side-effects when `e.agentId` belongs to a reviewer.

### 4.3 Lease (no double-work between local and remote)
Before working a job, a worker posts/updates one comment `<!-- factory:lease worker=<id> until=<iso> -->` and re-reads the issue; if another unexpired lease exists with an earlier timestamp, it backs off. Leases last 15 min and are renewed every 5 min while working. An expired lease is fair game. This is good enough for a handful of workers; it is not a distributed lock and is documented as such.

### 4.4 Model routing
`agent.spawn` hook sets each role's model from config. Defaults: spec-writer `opus`, designer `opus`, planner `sonnet`, builder `sonnet`, code-reviewer `opus`, security-reviewer `opus`, ux-reviewer `sonnet`, approver `sonnet`. Per-repo overrides in `.factory.yml`.

### 4.5 Commands
| Command | Effect |
|---|---|
| `/factory` | Opens the pipeline pane |
| `/factory tick` | One pass: pick up to `limits.parallel` runnable jobs, advance each one station. Used by headless runs. |
| `/factory new <title> [-- body]` | Creates a labelled issue in the current repo's forge |
| `/factory run <issue>` | Puts an existing issue on the line (`factory::ready`) and ticks it now |
| `/factory approve <issue>` / `revise <issue> <notes>` | Spec decision from the terminal (same effect as label/comment) |
| `/factory status [issue]` | Text summary (works in `claude -p` too) |
| `/factory pause` / `resume` | Stops/starts the watched-session ticker |

### 4.6 Human approvals while watching
When a job reaches `awaiting-spec` and a watched session is open, the mod shows a toast and a band entry; pressing **Review spec** opens the spec in the pane with **Approve** / **Revise** buttons (Revise takes notes via an `Input`). The decision is written to the forge, so it's identical to approving from the forge UI or phone. In headless runs nothing waits: the job simply parks at `awaiting-spec`.

## 5. UI ("what's going on")

Three layers so it's visible wherever you are:

1. **Watched session (terminal / Desktop / VS Code)**
   - **Band above the prompt:** one line — `Factory · 2 building · 1 in review · 1 needs you` — with digit hotkeys to jump.
   - **Pipeline pane:** jobs grouped by station as columns-in-rows; each job shows repo, issue #, title, elapsed time at station, fix-loop count, and a live line from the agent currently working it. Selecting a job shows its dossier (spec, design, plan, test report, verdicts) as Markdown with links to the issue/MR.
   - **Spinner suffix** while a station runs: `· factory #42 build 3/7`.
   - **Toasts** on transitions that need a human or that fail.
2. **The forge (anywhere, incl. phone):** every transition is a label change plus a comment, so the issue timeline *is* the job log. The MR description is the final dossier.
3. **Slack (optional):** one message per "needs you" event and per MR opened, if `notify.slackWebhook` is set.

Desktop draws richer elements (`Svg`) — the pane uses a small SVG station strip there and falls back to text in the terminal.

## 6. Running it: local and remote

| Mode | How | What works |
|---|---|---|
| Watched local | `claude --plugin-dir ./software-factory` (dev) or installed plugin; `/factory` | Everything incl. UI; ticker runs every `tick.intervalMinutes` while the session is open |
| Headless on a server/laptop | cron: `claude -p "/factory tick"` with the plugin installed | All stations and gates; no drawing; human questions auto-decline safely |
| Headless in the cloud | Scheduled task (Claude scheduled tasks) running `/factory tick` in a cloud environment where the plugin is available | Same as above |

Both headless and watched can run at once; leases prevent collisions.

Credentials: `GITHUB_TOKEN` and/or `GITLAB_TOKEN` (+ `GITLAB_URL`) read through `$.env`; never written to comments or logs.

## 7. Intake details

- **GitHub/GitLab label:** ticker queries open issues with `factory::ready` in each repo listed in the worker's `repos` list (plugin userConfig).
- **`/factory new|run`:** creates/labels an issue, so it flows through the same path.
- **CI failure:** `ci/github-action.yml` and `ci/gitlab-ci.yml` add a job that, on pipeline failure on the default branch, opens (or comments on an existing open) issue titled `CI failure: <job>` with the log tail and `factory::ready`. Deduplicated by a fingerprint in the issue body.

## 8. Per-repo config: `.factory.yml`

```yaml
forge: gitlab            # github | gitlab
test: "composer test"   # command the verify station runs; must exit 0
setup: "composer install --no-interaction"   # optional, run before test
reviewers: [code, security, ux]   # which review stations are required
protectedPaths: ["db/migrations/**", ".gitlab-ci.yml"]
models: { builder: sonnet }       # optional overrides
limits: { fixLoops: 3, parallel: 2 }
branchPrefix: factory/
```

Missing `.factory.yml` → job goes to `factory::blocked` with instructions.

## 9. Error handling

- Any station error → retry once; second failure → `factory::blocked` with the error and the station it failed at.
- Forge API failures → job left untouched (state never half-written: label change happens last, after its comment is posted).
- Hook timeouts → gates fail closed; non-gate hooks fail open (UI just doesn't update).
- Lease lost mid-station (another worker took over after expiry) → stop, discard local worktree, don't post.
- Fix-loop limit hit → `factory::blocked` with all reviewer findings.

## 10. Testing

- **Unit (`claude plugin test`, `*.test.ts`):** `machine.ts` transition table (every station × event), lease protocol, config validation, gates (fire `tool.call` events and assert deny/allow), routing, UI render snapshots.
- **Forge adapters:** tested against recorded HTTP fixtures (no live calls in tests).
- **End-to-end smoke:** a sandbox repo on each forge with a trivial `.factory.yml`; a scripted run labels an issue, auto-approves the spec via the forge, and asserts an MR appears with all verdicts. Run manually before releases.
- `claude plugin validate --strict` in CI for the plugin repo.

## 11. Build order (for the implementation plan)

1. Plugin skeleton, config, pure state machine + tests.
2. Forge interface + GitLab adapter (your primary) + GitHub adapter.
3. Lease + `/factory tick|new|run|status` (headless path works end-to-end with stub stations).
4. Agents + skills for each role; stations wired; verify station.
5. Gates + routing.
6. UI: band, pane, approvals, toasts.
7. CI intake snippets, Slack notify.
8. E2E smoke on sandbox repos; docs.

## 12. Amendments from API verification (2026-10-21)
- **Agents run as child processes.** A hook may spend only 10 s of its own time awaiting, but time inside mods API calls is free. Each station therefore runs as a child `claude -p` started with `$.process.spawn`, with the factory plugin loaded (`--plugin-dir`), the role agent (`--agent software-factory:<role>`), the role's model (`--model`), and `FACTORY_ROLE` / `FACTORY_JOB` / `FACTORY_WORKTREE` in its environment. This works identically locally, on a server and in the cloud.
- **Routing** (4.4) is the `--model` flag at child launch, not an `agent.spawn` hook.
- **Gates** (4.2) run inside each child session; the mod reads `FACTORY_ROLE` to know what it is guarding. In a child session the mod runs gates only (no ticker, no UI).
- **Station procedures** live in `agents/<role>.md`; no separate skills in v1.
- **Code layout:** the hooks module may not pass `$` to imported files, so all logic in `src/` is pure and receives plain functions (`fetch`, `run`, `spawn`) built in `hooks/register.ts`.
- **`.factory.yml`** is parsed by a small built-in YAML-subset parser (mods can't import npm packages).

## 13. Open questions (defaults chosen; change if you disagree)
- Plugin lives in a new repo `software-factory` on lab.ironcloud.gr, mirrored to GitHub only if wanted. **Default: GitLab only.**
- Slack notifications on by default if a webhook is provided; off otherwise.
- `limits.parallel` default 2 per worker to keep usage predictable.
