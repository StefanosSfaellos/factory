# Software Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code plugin (`software-factory`) whose mod moves GitHub/GitLab issues through spec → human approval → design → plan → test-first build → independent verify → parallel review → automated approval → MR/PR, with gates, a status UI, and identical local and headless operation.

**Architecture:** The forge (issue labels + marker comments) is the only state store. `hooks/register.ts` is the only file that touches `$`; it builds plain I/O functions (`fetch`, `run`, `spawn`, `env`) and hands them to pure modules in `src/`. Each station's agent runs as a child `claude -p` process with this plugin loaded, so gates apply inside it.

**Tech Stack:** TypeScript hooks module loaded directly by Claude Code ≥ 2.1.290 (no build step, no npm imports), `claude plugin test` (`claude-code/testing`), `claude plugin validate --strict`, GitHub REST v3, GitLab REST v4.

**Spec:** `docs/superpowers/specs/2026-10-21-software-factory-design.md` (read §12 Amendments first)

## Global Constraints

- Plugin name `software-factory`; plugin root is the repo root (`.claude-plugin/plugin.json`, `hooks/hooks.json` → `["./register.ts"]`).
- Only `hooks/register.ts` may reference `$`. Files in `src/` import only relative files; no `$`, no npm packages, no Node APIs. Write every `$` call in full (`$.http.fetch`, never `const h = $.http`). Event names are string literals.
- Station labels (exact): `factory::ready`, `factory::spec`, `factory::awaiting-spec`, `factory::spec-approved`, `factory::design`, `factory::plan`, `factory::build`, `factory::verify`, `factory::review`, `factory::approve`, `factory::mr-open`, `factory::done`, `factory::blocked`.
- Marker comments start with `<!-- factory:<kind> ... -->` on their first line. Kinds: `spec`, `design`, `plan`, `test-report`, `verdict`, `approval`, `lease`, `blocked`.
- State-write order: post the comment first, change the label last.
- Default models: spec-writer `opus`, designer `opus`, planner `sonnet`, builder `sonnet`, code-reviewer `opus`, security-reviewer `opus`, ux-reviewer `sonnet`, approver `sonnet`.
- Defaults: `limits.fixLoops` 3, `limits.parallel` 2, lease 15 min renewed every 5 min, `tick.intervalMinutes` 10, verify timeout 10 min (the `$.process.run` maximum).
- Branch name: `<branchPrefix><issue>-<slug>` with `branchPrefix` default `factory/`, slug = lowercase title, non-alphanumerics → `-`, max 40 chars.
- Child env vars: `FACTORY_ROLE`, `FACTORY_JOB` (`<forge>:<project>#<issue>`), `FACTORY_WORKTREE` (absolute path).
- Tokens from `GITHUB_TOKEN`, `GITLAB_TOKEN`, `GITLAB_URL` (default `https://gitlab.com`); never written to comments, logs or UI.
- Every commit ends with:
  ```
  Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01TBkcSkrWnUahQ5wtspeVky
  ```

## Review Focus

1. **Issue with zero or two station labels** (someone relabels by hand) → job goes to `factory::blocked` with a comment naming the labels found; never crashes the tick. Test in Task 2.
2. **Forge API error between comment and label** → the label is unchanged, the next tick re-runs the station idempotently (it finds its own marker comment and only relabels). Test in Task 8.
3. **Test command that hangs** → verify fails with `timed out after 10 min` in the report instead of hanging the worker. Test in Task 6.
4. **Secrets in tool output** (test logs that echo a token) → every text posted to the forge or Slack goes through `redact()` which replaces the values of `GITHUB_TOKEN`/`GITLAB_TOKEN` and `/(ghp_|glpat-)[A-Za-z0-9_-]{10,}/` with `[redacted]`. Test in Task 3.
5. **`/revise` with no notes, or approval arriving while the spec is being rewritten** → empty notes are rejected with a message; an approval is only honoured if it is newer than the latest `spec` marker comment. Test in Task 2.

---

### Task 1: Plugin skeleton, YAML subset parser, repo config

**Files:**
- Create: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.ts`, `src/yaml.ts`, `src/config.ts`, `templates/.factory.yml`
- Test: `tests/yaml.test.ts`, `tests/config.test.ts`

**Interfaces:**
- Produces:
  - `parseYaml(text: string): unknown` — supports maps, nested maps by 2-space indent, block lists (`- x`), inline lists `[a, b]`, inline maps `{ a: b }`, quoted/unquoted strings, integers, booleans, `#` comments. Throws `Error('yaml line N: <reason>')` otherwise.
  - `type RepoConfig = { forge: 'github'|'gitlab'; test: string; setup?: string; reviewers: ('code'|'security'|'ux')[]; protectedPaths: string[]; models: Partial<Record<Role,string>>; limits: { fixLoops: number; parallel: number }; branchPrefix: string; allowedTools: string[] }`
  - `parseRepoConfig(text: string): { ok: true; config: RepoConfig } | { ok: false; error: string }` — fills defaults from Global Constraints; `reviewers` default `['code','security']`; `allowedTools` default `[]`.
  - `type Role = 'spec-writer'|'designer'|'planner'|'builder'|'code-reviewer'|'security-reviewer'|'ux-reviewer'|'approver'` (export from `src/config.ts`).
  - `modelFor(role: Role, cfg: RepoConfig): string`.
- `plugin.json` declares `userConfig`: `repos` (string, comma-separated `github:owner/name` / `gitlab:group/name`), `workerId` (string, default `"worker"`), `tickMinutes` (number, 10), `slackWebhook` (string, default `""`).
- `register.ts` in this task: a `session.start` hook that registers `/factory` and a `command.run` hook for `factory` returning `{ text: 'software-factory loaded' }`.

- [ ] **Step 1: Write failing tests**
  - `yaml.test.ts`: `parseYaml('a: 1\nb: [x, y]\nc:\n  d: true\n')` equals `{ a: 1, b: ['x','y'], c: { d: true } }`; block list `'r:\n  - code\n  - ux\n'` → `{ r: ['code','ux'] }`; `'models: { builder: sonnet }'` → `{ models: { builder: 'sonnet' } }`; `'a: "x: y" # c'` → `{ a: 'x: y' }`; tab indentation throws matching `/yaml line 1/`.
  - `config.test.ts`: the spec §8 example parses with `limits.fixLoops` 3 and `reviewers` `['code','security','ux']`; `'test: npm test\n'` (no forge) → `ok:false`, error contains `forge`; missing `test` → error contains `test`; `reviewers: [code, perf]` → error contains `perf`; `modelFor('builder', cfg)` is `sonnet`, overridden to `opus` by `models: { builder: opus }`.
- [ ] **Step 2: Run** `claude plugin test` → FAIL (modules missing).
- [ ] **Step 3: Implement** `src/yaml.ts`, `src/config.ts`, the manifest, `hooks.json`, `register.ts`, and `templates/.factory.yml` (spec §8 example).
- [ ] **Step 4: Run** `claude plugin test` → PASS; `claude plugin validate --strict .` → `Validation passed`; `claude -p "/factory" --plugin-dir . < /dev/null` prints `software-factory: software-factory loaded`.
- [ ] **Step 5: Commit** `feat: plugin skeleton and repo config`

### Task 2: Job model and state machine

**Files:**
- Create: `src/types.ts`, `src/machine.ts`
- Test: `tests/machine.test.ts`

**Interfaces:**
- Consumes: `Role`, `RepoConfig` (Task 1).
- Produces (`src/types.ts`):
  - `type Station = 'ready'|'spec'|'awaiting-spec'|'design'|'plan'|'build'|'verify'|'review'|'approve'|'mr-open'|'done'|'blocked'`
  - `type JobRef = { forge: 'github'|'gitlab'; project: string; issue: number }`
  - `type Comment = { id: string; body: string; createdAt: string; author: string }`
  - `type Job = { ref: JobRef; title: string; body: string; labels: string[]; comments: Comment[] }`
  - `type Verdict = { role: Role; pass: boolean; findings: string }`
- Produces (`src/machine.ts`):
  - `stationOf(job: Job): { station: Station } | { invalid: string }` — exactly one `factory::<station>` label (ignoring `factory::spec-approved`) else `invalid` naming the labels.
  - `type MachineEvent = { kind: 'picked' } | { kind: 'artifact-posted' } | { kind: 'spec-decision'; approve: boolean; notes?: string } | { kind: 'build-done' } | { kind: 'verify'; passed: boolean } | { kind: 'verdicts'; verdicts: Verdict[] } | { kind: 'mr-opened' } | { kind: 'error'; message: string; retried: boolean }`
  - `next(station: Station, ev: MachineEvent, ctx: { fixLoops: number; maxFixLoops: number; requiredReviewers: Role[] }): { station: Station; fixLoops: number; reason?: string }`
  - `specDecision(job: Job): { approve: true } | { approve: false; notes: string } | { none: true } | { invalid: string }` — reads `factory::spec-approved` label or the newest `/approve` / `/revise <notes>` comment newer than the newest `<!-- factory:spec` comment.
  - `fixLoopsOf(job: Job): number` — counts `<!-- factory:verdict` comments with `pass=false` plus failed `test-report` comments.

- [ ] **Step 1: Write failing tests** — a table test over every row of spec §3: `ready+picked→spec`, `spec+artifact-posted→awaiting-spec`, `awaiting-spec+approve→design`, `awaiting-spec+revise→spec`, `design→plan`, `plan→build`, `build+build-done→verify`, `verify passed→review`, `verify failed→build` (fixLoops+1), `review+all-pass verdicts→approve`, `review+one-fail→build`, `review with missing required reviewer→review` (stays), fixLoops reaching 3 → `blocked` with reason containing `fix loop`, `approve+mr-opened→mr-open`, `error retried=false→same station`, `error retried=true→blocked`. Review Focus 1: labels `[factory::build, factory::review]` → `invalid` containing both; no factory label → `invalid`. Review Focus 5: `/revise` with empty notes → `invalid` containing `notes`; an `/approve` older than the newest spec comment → `{ none: true }`.
- [ ] **Step 2: Run** `claude plugin test tests/machine.test.ts` → FAIL.
- [ ] **Step 3: Implement** `src/types.ts` and `src/machine.ts` as pure functions.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: job state machine`

### Task 3: Marker comments, lease, redaction

**Files:**
- Create: `src/markers.ts`, `src/lease.ts`, `src/redact.ts`
- Test: `tests/markers.test.ts`, `tests/lease.test.ts`, `tests/redact.test.ts`

**Interfaces:**
- Consumes: `Comment`, `Verdict` (Task 2).
- Produces:
  - `marker(kind: string, attrs: Record<string,string>): string` → `<!-- factory:<kind> k=v k=v -->`; values with spaces are rejected (throw).
  - `parseMarker(body: string): { kind: string; attrs: Record<string,string> } | null` (first line only).
  - `findLatest(comments: Comment[], kind: string): Comment | undefined` (by `createdAt`).
  - `verdictComment(v: Verdict): string` / `parseVerdict(c: Comment): Verdict | null` (attrs `role`, `pass=true|false`; findings = body after line 1).
  - `decideLease(comments: Comment[], me: string, nowMs: number): { action: 'acquire' | 'renew'; existingId?: string } | { action: 'back-off'; holder: string }` — lease attrs `worker`, `until` (ISO). Unexpired lease by another worker with earlier `createdAt` → back-off; own lease → renew; none or expired → acquire.
  - `leaseBody(me: string, nowMs: number, minutes = 15): string`.
  - `redact(text: string, secrets: string[]): string`.

- [ ] **Step 1: Write failing tests** — marker round-trip; `parseMarker('hello')` is null; verdict round-trip keeps multi-line findings; lease: other worker's lease until now+10min → back-off naming it; same with until now−1min → acquire; own lease → renew with its id; two leases → earliest wins. Review Focus 4: `redact('tok=abc123secret ghp_ABCDEFGHIJKLMN', ['abc123secret'])` → `'tok=[redacted] [redacted]'`; `glpat-xxxxxxxxxxxxxxxx` → `[redacted]`; empty secrets array still redacts patterns.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: marker comments, leases, secret redaction`

### Task 4: Forge interface and GitLab adapter

**Files:**
- Create: `src/forge/types.ts`, `src/forge/gitlab.ts`
- Test: `tests/forge-gitlab.test.ts`, `tests/fixtures/gitlab/*.json`

**Interfaces:**
- Consumes: `Job`, `JobRef`, `Comment` (Task 2).
- Produces (`src/forge/types.ts`):
  - `type HttpFn = (req: { url: string; method: 'GET'|'POST'|'PUT'; headers: Record<string,string>; body?: string }) => Promise<{ status: number; ok: boolean; text: string }>`
  - `interface Forge { listJobs(project: string): Promise<JobRef[]>; getJob(ref: JobRef): Promise<Job>; comment(ref: JobRef, body: string): Promise<Comment>; editComment(ref: JobRef, id: string, body: string): Promise<void>; setStation(ref: JobRef, station: Station): Promise<void>; createIssue(project: string, title: string, body: string): Promise<JobRef>; openMR(ref: JobRef, branch: string, title: string, body: string): Promise<{ url: string }>; defaultBranch(project: string): Promise<string>; cloneUrl(project: string): string }`
  - `class ForgeError extends Error { status: number }` — thrown for any non-2xx.
- Produces (`src/forge/gitlab.ts`): `gitlabForge(http: HttpFn, opts: { baseUrl: string; token: string }): Forge`. Project ids are URL-encoded paths. `listJobs` = open issues carrying any `factory::` station label except `done`, fetched with `per_page=100&page=N` until a page comes back empty. `setStation` removes every other `factory::<station>` label and adds the new one in one `PUT` (`add_labels`, `remove_labels`). Header `PRIVATE-TOKEN`. `cloneUrl` = `https://oauth2:<token>@<host>/<project>.git` (used only as a process argument, never logged).

- [ ] **Step 1: Write failing tests** with a fake `HttpFn` that records requests and returns fixture JSON: `getJob` maps issue + notes to `Job` (notes sorted by `created_at`, system notes excluded); `setStation(ref,'build')` sends one PUT whose body removes the other 12 station labels and adds `factory::build`; `openMR` POSTs `source_branch`, `target_branch` from `defaultBranch`, `remove_source_branch: true`; a 500 response throws `ForgeError` with status 500; base URL `https://lab.ironcloud.gr` produces URLs under `https://lab.ironcloud.gr/api/v4/`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat: GitLab forge adapter`

### Task 5: GitHub adapter

**Files:**
- Create: `src/forge/github.ts`
- Test: `tests/forge-github.test.ts`, `tests/fixtures/github/*.json`

**Interfaces:**
- Consumes: `Forge`, `HttpFn`, `ForgeError` (Task 4).
- Produces: `githubForge(http: HttpFn, opts: { token: string; apiUrl?: string }): Forge` (apiUrl default `https://api.github.com`). Headers `Authorization: Bearer`, `Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`. `listJobs` filters out pull requests (`pull_request` key present). `setStation` = GET labels, then PUT `/issues/{n}/labels` with the non-factory labels plus the new one. `openMR` → `POST /pulls`. `cloneUrl` = `https://x-access-token:<token>@github.com/<owner>/<repo>.git`.

- [ ] **Step 1: Write failing tests** mirroring Task 4's (same assertions adapted to GitHub endpoints), plus: an issue list containing a PR is filtered out; `setStation` keeps a non-factory label `bug`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat: GitHub forge adapter`

### Task 6: Worktrees and the verify station

**Files:**
- Create: `src/worktree.ts`, `src/verify.ts`
- Test: `tests/worktree.test.ts`, `tests/verify.test.ts`

**Interfaces:**
- Consumes: `JobRef`, `RepoConfig`, `redact`, `marker`.
- Produces:
  - `type RunFn = (argv: string[], opts: { cwd?: string; timeoutMs?: number }) => Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>` (register.ts converts a `$.process.run` rejection on timeout into `timedOut: true`).
  - `branchName(ref: JobRef, title: string, prefix: string): string`
  - `workDir(root: string, ref: JobRef): string` → `<root>/<forge>/<project with / → __>/<issue>`; `root` = `~/.factory/work`.
  - `ensureCheckout(run: RunFn, opts: { dir: string; cloneUrl: string; branch: string; base: string }): Promise<void>` — clone if missing, fetch, checkout `branch` (create from `origin/<base>` if absent).
  - `verify(run: RunFn, opts: { cloneUrl: string; branch: string; scratchDir: string; cfg: RepoConfig; secrets: string[] }): Promise<{ passed: boolean; report: string }>` — fresh `git clone --depth 1 --branch <branch>` into `scratchDir`, run `setup` then `test` via `['sh','-c', cmd]` with `timeoutMs` 600000; report = `marker('test-report', { passed })` + command, exit code, last 80 lines of combined output, redacted.

- [ ] **Step 1: Write failing tests** with a fake `RunFn`: branch name for title `Add .COM resale!` and issue 42 is `factory/42-add-com-resale`; 60-char titles truncate to 40-char slug; `ensureCheckout` issues `git clone` only when the dir is missing (fake `run` for `test -d` returns 1); `verify` passes when test exit is 0 and the report contains `passed=true`; fails on exit 1 with the log tail; setup failure fails without running test. Review Focus 3: fake test run returns `timedOut: true` → `passed:false`, report contains `timed out after 10 min`. Review Focus 4: a log containing the token is redacted in the report.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat: worktrees and independent verify`

### Task 7: Role agents and the child-agent runner

**Files:**
- Create: `agents/spec-writer.md`, `agents/designer.md`, `agents/planner.md`, `agents/builder.md`, `agents/code-reviewer.md`, `agents/security-reviewer.md`, `agents/ux-reviewer.md`, `agents/approver.md`, `src/agents.ts`
- Test: `tests/agents.test.ts`

**Interfaces:**
- Consumes: `Role`, `RepoConfig`, `modelFor`, `JobRef`.
- Produces:
  - `type SpawnFn = (argv: string[], opts: { cwd: string; onLine: (line: string) => void }) => Promise<{ exitCode: number }>` (wraps `$.process.spawn`; register.ts collects stdout).
  - `childArgv(opts: { role: Role; prompt: string; cfg: RepoConfig; pluginRoot: string; job: string; worktree: string }): string[]` → `['env', 'FACTORY_ROLE=<role>', 'FACTORY_JOB=<job>', 'FACTORY_WORKTREE=<worktree>', 'FACTORY_SPEC_FILE=<worktree>/.factory/spec.md', 'claude', '-p', <prompt>, '--plugin-dir', <pluginRoot>, '--agent', 'software-factory:<role>', '--model', <model>, '--permission-mode', 'acceptEdits', '--output-format', 'stream-json', '--verbose', ...('--allowedTools' + cfg.allowedTools if any)]`. Reviewers and approver add `--disallowedTools Edit Write NotebookEdit`.
  - `runAgent(spawn: SpawnFn, opts: Parameters<typeof childArgv>[0] & { onProgress: (text: string) => void }): Promise<{ ok: boolean; output: string; error?: string }>` — parses stream-json lines; `onProgress` gets the latest assistant text line (≤ 120 chars); `output` = the final `result` event's `result` text; non-zero exit or missing result → `ok:false`.
- Each `agents/<role>.md` has frontmatter `name`, `description`, `model` and a body stating: inputs it receives, the exact output format the station parses (spec: sections Goal/Scope/Acceptance criteria/Risks; builder: test first, commit per task, final line `BUILD-DONE`; reviewers: first line `VERDICT: pass` or `VERDICT: fail`, then findings; approver: `APPROVE` or `REJECT: <reason>`), and that it must not push or open MRs.

- [ ] **Step 1: Spike (no test):** with a scratch repo, run `claude -p "Reply with the word ok" --plugin-dir . --agent software-factory:planner --output-format stream-json --verbose < /dev/null` and confirm a final `{"type":"result",...}` line appears. If `--agent` rejects the namespaced name, use the bare `<role>` name and record that in `src/agents.ts`. Expected: a result line.
- [ ] **Step 2: Write failing tests:** `childArgv` for `security-reviewer` includes `--disallowedTools` and `--model opus`; for `builder` with `allowedTools: ['Bash(composer *)']` includes `--allowedTools Bash(composer *)`; `runAgent` with a fake `SpawnFn` emitting fixture stream-json returns the result text and calls `onProgress` with the last assistant text; exit 1 → `ok:false`.
- [ ] **Step 3–4:** implement → PASS.
- [ ] **Step 5: Commit** `feat: role agents and child agent runner`

### Task 8: Station runner

**Files:**
- Create: `src/stations.ts`, `src/prompts.ts`
- Test: `tests/stations.test.ts`

**Interfaces:**
- Consumes: `Forge`, `Job`, `next`, `stationOf`, `specDecision`, `fixLoopsOf`, markers, `runAgent`, `verify`, `ensureCheckout`, `branchName`, `RepoConfig`.
- Produces:
  - `type Deps = { forge: Forge; run: RunFn; spawn: SpawnFn; pluginRoot: string; workRoot: string; secrets: string[]; workerId: string; now: () => number; onProgress: (job: JobRef, text: string) => void; loadConfig: (ref: JobRef) => Promise<{ ok: true; config: RepoConfig } | { ok: false; error: string }> }`
  - `advance(ref: JobRef, deps: Deps): Promise<{ from: Station; to: Station; needsHuman: boolean }>` — one station step: load job, config (missing → blocked with instructions), act per station, post artifact (redacted), then `setStation`.
  - `promptFor(station: Station, role: Role, job: Job, artifacts: Record<string,string>): string` (`src/prompts.ts`).
- Station behaviour: `ready`→`spec` (label only); `spec` runs spec-writer, posts `spec` marker; `awaiting-spec` reads `specDecision` (none → no-op, returns `needsHuman:true`); `design`, `plan` post their marker; `build` runs builder in the worktree, requires `BUILD-DONE`, then `git push -u origin <branch>` via `run` (the push happens in the mod, not the agent); `verify` calls `verify`; `review` runs required reviewers concurrently with `Promise.all`, posts one `verdict` each; `approve` runs approver, then `forge.openMR` with a body containing links/excerpts of spec, design, plan, test report and verdicts plus the PR footer from the session reminder, posts `approval` marker; `mr-open` checks nothing (merge is human).
- Errors: any thrown error or `ok:false` agent result is retried once within the same `advance`; a second failure posts a `blocked` marker with the station and redacted error, then labels `blocked` (machine `error` event with `retried: true`).
- Idempotency: before running an agent for `spec|design|plan`, if a marker of that kind newer than the latest label change exists, skip the agent and only relabel.

- [ ] **Step 1: Write failing tests** with an in-memory fake `Forge` and fake `spawn`/`run`: ready→spec; spec posts a comment starting `<!-- factory:spec` then labels awaiting-spec (assert order); awaiting-spec with no decision returns `needsHuman:true` and changes nothing; review with code+security where security says `VERDICT: fail` → two verdict comments, station `build`; approve opens an MR whose body contains the test report and the footer `🤖 Generated with [Claude Code](https://claude.com/claude-code)`; missing `.factory.yml` → `blocked` with a comment mentioning `.factory.yml`; an agent failing twice → `blocked` marker naming the station, failing once then succeeding → normal advance. Review Focus 2: fake forge whose `setStation` throws once after `comment` succeeded → station unchanged; a second `advance` posts no second spec comment and relabels.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat: station runner`

### Task 9: Tick, commands, and hooks wiring

**Files:**
- Create: `src/tick.ts`, `src/commands.ts`
- Modify: `hooks/register.ts`
- Test: `tests/tick.test.ts`, `tests/register.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `tick(deps: Deps & { projects: { forge: 'github'|'gitlab'; project: string }[]; parallel: number }): Promise<{ advanced: { ref: JobRef; from: Station; to: Station; needsHuman: boolean }[]; skipped: { ref: JobRef; reason: string }[] }>` — list jobs, skip `done|mr-open|blocked|awaiting-spec without decision`, acquire lease (`decideLease` → `comment`/`editComment`), advance up to `parallel` jobs concurrently, keep advancing each leased job until it needs a human, ends, or hits `blocked`. Renews the lease every 5 min through `deps.now`.
  - `parseCommand(args: string): { kind: 'open' } | { kind: 'tick' } | { kind: 'new'; title: string; body: string } | { kind: 'run' | 'status' | 'approve'; issue?: string } | { kind: 'revise'; issue: string; notes: string } | { kind: 'pause' | 'resume' } | { kind: 'error'; message: string }` — issue refs accept `#42` (current repo) or `gitlab:group/name#42`.
- `register.ts` wiring: build `HttpFn` from `$.http.fetch`, `RunFn` from `$.process.run`, `SpawnFn` from `$.process.spawn`, read tokens with `$.env.get('GITHUB_TOKEN')` etc. Child sessions (`$.env.get('FACTORY_ROLE')` set) register gates only (Task 10) and return early. Parent sessions register `/factory` (`immediate: true`), handle all subcommands, and when `surface` is interactive start `$.clock.every(tickMinutes*60000, ...)` unless paused. `/factory status` returns text in every mode.

- [ ] **Step 1: Write failing tests** — `tick.test.ts` with fakes: two ready jobs and `parallel:1` advances one; a job leased by another worker is skipped with reason `leased by <worker>`; a job runs spec then stops at awaiting-spec in one tick. `register.test.ts` (kit): `$.command.run({ command: 'factory', args: 'status' })` with stubs for `env.get`, `http.fetch` (empty issue lists), `command.register` returns text containing `0 jobs`; `parseCommand('revise #4')` → `error` mentioning notes.
- [ ] **Step 2–4:** FAIL → implement → PASS; `claude plugin validate --strict .` passes.
- [ ] **Step 5: Commit** `feat: tick loop and /factory commands`

### Task 10: Gates

**Files:**
- Create: `src/gates.ts`
- Modify: `hooks/register.ts`
- Test: `tests/gates.test.ts`

**Interfaces:**
- Consumes: `Role`, `RepoConfig`.
- Produces: `gate(call: { tool: string; input: Record<string, unknown> }, ctx: { role?: Role; worktree?: string; protectedPaths: string[]; specText: string }): { allow: true } | { deny: string }`.
- Rules (spec §4.2): in any child session deny `git push`, `gh pr create`, `glab mr create`, any `mcp__*merge_request*` / `mcp__*pull_request*` create tool; always deny `git push --force|-f`, `git reset --hard`; Edit/Write/NotebookEdit with a path outside `worktree` denied; reviewer/approver roles deny Edit/Write/NotebookEdit and Bash commands matching `/\b(rm|mv|git (commit|push|reset|checkout))\b/`; builder Edit/Write on a `protectedPaths` glob (`**` and `*` only) denied unless the path appears in `specText`.
- Wiring: in child sessions `on('tool.call', ...)` calls `gate` and returns `{ deny }` or `next(e)`, with `.catch(() => ({ deny: 'factory gate failed; action blocked' }))`. `specText` is read once from `$.env.get('FACTORY_SPEC_FILE')` path via `$.fs.read` (Task 8 writes the spec to `<worktree>/.factory/spec.md` and passes the path).

- [ ] **Step 1: Write failing tests:** builder `git push origin x` → deny; reviewer `Edit` → deny; builder Edit `/w/src/a.php` with worktree `/w` → allow; `/etc/x` → deny; protected `db/migrations/**` edit denied unless spec mentions `db/migrations/2026_add.sql`; `git push -f` denied even with no role. Kit test: in a child session (`env.get` stub returns `builder`), `$.tool.call({ tool: 'Bash', command: 'git push' })` returns `{ deny }`; a hook that throws (stub `fs.read` denies) still results in a deny.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat: factory gates`

### Task 11: Status UI and in-session approvals

**Files:**
- Create: `src/ui/model.ts`, `src/ui/render.ts`
- Modify: `hooks/register.ts`
- Test: `tests/ui-model.test.ts`, `tests/ui-render.test.ts`

**Interfaces:**
- Consumes: `Job`, `Station`, `tick` results.
- Produces:
  - `type JobView = { ref: JobRef; title: string; station: Station; sinceMs: number; fixLoops: number; progress?: string; needsHuman: boolean; links: { issue: string; mr?: string } }`
  - `bandText(jobs: JobView[]): string` → e.g. `Factory · 2 building · 1 in review · 1 needs you` (omit zero groups; `Factory · idle` when empty).
  - `paneTree(el: Elements, jobs: JobView[], selected?: string, surface: string): Element` and `specReviewTree(el, job: JobView, specMarkdown: string): Element` — `Elements` is the object from `$.ui.resolve(e)`; buttons keyed `approve-<issue>`, `revise-<issue>`, `job-<issue>`; revise uses an `Input` keyed `notes-<issue>`. On `desktop`, a station strip `Svg` above the list; text fallback elsewhere.
- Wiring: parent session keeps `JobView[]` in `$.state`; tick results and `onProgress` update it and call `$.ui.invalidate('ui.render')`; `ui.render` for `AbovePrompt` shows `bandText`; `Pane` id `factory` shows `paneTree`; `Spinner` suffix ` · factory #<n> <station>` while a station runs; `$.ui.toast` on transitions with `needsHuman` or to `blocked`; Approve/Revise presses write `/approve` or `/revise <notes>` comments via the forge and re-tick.

- [ ] **Step 1: Write failing tests:** `bandText` for [build, build, review, awaiting-spec] = `Factory · 2 building · 1 in review · 1 needs you`; empty = `Factory · idle`. Kit drawing test: mount `Pane` (`requestId: 'factory'`, terminal) with state holding one awaiting-spec job; `find({ key: 'approve-42' })` defined; `press({ key: 'approve-42' })` triggers an `http.fetch` stub whose body contains `/approve`; on `desktop` an `Svg` element is found, on `terminal` it is not.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat: factory pane, band and approvals`

### Task 12: Notifications and CI intake

**Files:**
- Create: `src/notify.ts`, `ci/factory-intake.mjs`, `ci/github-action.yml`, `ci/gitlab-ci.yml`
- Modify: `hooks/register.ts`
- Test: `tests/notify.test.ts`, `ci/factory-intake.test.mjs` (plain `node --test`)

**Interfaces:**
- Produces:
  - `slackPayload(ev: { ref: JobRef; title: string; kind: 'needs-spec-review' | 'mr-opened' | 'blocked'; url: string; detail?: string }): string` — JSON `{ text }`, redacted.
  - `ci/factory-intake.mjs` (Node ≥ 20, no deps): reads `FORGE`, `PROJECT`, `TOKEN`, `API_URL`, `JOB_NAME`, `LOG_FILE`; fingerprint = sha256 of `JOB_NAME` + first error line; finds an open issue whose body contains `factory-fingerprint: <hex>` → comments the new log tail; else creates `CI failure: <JOB_NAME>` with label `factory::ready`, the fingerprint line and the last 80 log lines.
  - Snippets run it only on default-branch failures (`if: failure() && github.ref == ...` / `when: on_failure` + `rules: if $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH`).
- Wiring: when `slackWebhook` is set, register.ts POSTs `slackPayload` on those three transitions.

- [ ] **Step 1: Write failing tests:** `slackPayload` for `mr-opened` contains the URL and title; a token in `detail` is redacted. `factory-intake.test.mjs` with a mocked `fetch`: no existing issue → POST create with `factory::ready`; existing fingerprint → POST comment only.
- [ ] **Step 2–4:** FAIL → implement → PASS (`claude plugin test` and `node --test ci/`).
- [ ] **Step 5: Commit** `feat: Slack notifications and CI failure intake`

### Task 13: Docs, scheduling recipe, end-to-end smoke

**Files:**
- Create: `README.md`, `scripts/smoke.md`

**Interfaces:** none new.

- [ ] **Step 1:** `README.md`: what it is; install (`claude --plugin-dir`, or marketplace); env vars; `userConfig`; `.factory.yml`; labels; commands; running watched; running headless with `claude -p "/factory tick" < /dev/null` from cron and as a Claude scheduled task; tested Claude Code version (2.1.306); security notes (mods run with your permissions; `--permission-mode acceptEdits` in children; gates are guard-rails, protect `main` on the forge too).
- [ ] **Step 2:** `scripts/smoke.md`: manual E2E on a sandbox repo per forge — add `.factory.yml` with `test: "true"`, label an issue, run `/factory tick`, approve, tick until `mr-open`; expected results per step.
- [ ] **Step 3: Run** full suite `claude plugin test && node --test ci/ && claude plugin validate --strict .` → all pass.
- [ ] **Step 4: Commit** `docs: README and smoke test`
