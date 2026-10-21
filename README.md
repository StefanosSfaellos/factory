# software-factory

A Claude Code mod plugin that runs a multi-agent pipeline over GitHub and GitLab issues: spec (approved by a human), design, plan, test-first build, independent verify, code/security/UX review, approval, and a merge/pull request the factory opens itself.

Tested with Claude Code 2.1.306.

## Install

```sh
claude --plugin-dir /path/to/software-factory        # try it from a checkout
```

or, once it is published in a marketplace (replace `<owner>/<repo>` with that marketplace):

```sh
/plugin install software-factory --marketplace <owner>/<repo>
```

Then enable it. The plugin root is the repository root.

## Setup

1. **Tokens** (environment of the process that runs Claude Code):
   - `GITHUB_TOKEN`: a token that can read the repo and write issues, branches and pull requests.
   - `GITLAB_TOKEN`: same for GitLab (scope `api`). `GITLAB_URL` defaults to `https://gitlab.com`; set it for a self-hosted instance.
   Tokens are never written to comments, logs or the UI; agent child processes do not receive them.
2. **Plugin options** (`userConfig`, set when you enable the plugin):

   | Option | Type | Default | Meaning |
   |---|---|---|---|
   | `repos` | string | empty | Comma-separated, e.g. `github:owner/name,gitlab:group/name` |
   | `workerId` | string | `worker` | Id used when taking leases; left as `worker`, each session uses `<host>-<random>` |
   | `tickMinutes` | number | 10 | How often the session ticker polls the forges |
   | `parallel` | number | 2 | Jobs one tick advances at once, per forge |
   | `slackWebhook` | string | empty | Optional Slack incoming-webhook URL for notifications |

3. **`.factory.yml`** at the root of each repository's default branch (see below).
4. Label an issue `factory::ready` (or run `/factory new <title>`).

## How a job moves

Each issue carries exactly one station label. The factory posts its output as a comment first and changes the label last, so a failed API call is retried safely on the next tick.

| Label | Meaning |
|---|---|
| `factory::ready` | Queued; next tick starts the spec |
| `factory::spec` | Spec-writer is working |
| `factory::awaiting-spec` | Spec posted; waiting for a human `/approve` or `/revise` |
| `factory::spec-approved` | Spec approved |
| `factory::design` | Designer |
| `factory::plan` | Planner |
| `factory::build` | Test-first builder |
| `factory::verify` | Independent run of the `test` command (10 minute timeout) |
| `factory::review` | Code, security and UX reviewers, as configured |
| `factory::approve` | Approver checks the evidence |
| `factory::mr-open` | The factory opened the merge/pull request |
| `factory::done` | Finished |
| `factory::blocked` | Needs a person; the latest `factory:blocked` comment says why. Zero or several station labels also land here. Fix and relabel to resume |

Labels are created by the forge when first applied.

Humans act by commenting on the issue:

- `/approve` approves the spec.
- `/revise <notes>` sends it back to the spec-writer (notes are required).
- `/retry` forces a fresh verify or review run instead of replaying the cached result.

Only trusted commenters count. On GitHub: `OWNER`, `MEMBER` or `COLLABORATOR`. On GitLab every commenter who can comment counts, so **use private projects** (on a public project anyone who can comment can approve). Marker comments (`<!-- factory:... -->`) are honoured only when written by the factory's own account.

## Commands

| Command | Does |
|---|---|
| `/factory` | Opens the pipeline pane (interactive sessions) |
| `/factory help` | Lists the commands |
| `/factory tick` | One pass over the configured repos |
| `/factory new <title> [-- body]` | Creates an issue labelled `factory::ready` |
| `/factory run <issue>` | Puts an issue on the line and ticks it now |
| `/factory approve <issue>` | Approves the spec |
| `/factory revise <issue> <notes>` | Sends the spec back with notes |
| `/factory status [issue]` | Text summary of the jobs |
| `/factory pause` / `/factory resume` | Stops or starts the session ticker |

An issue is `#42` when exactly one repo is configured, otherwise `github:owner/name#42` or `gitlab:group/name#42`.

## Running it

**Watched (interactive).** Start `claude` with the plugin; the session ticker polls every `tickMinutes`. `/factory` opens the pane; the band above the prompt shows a one-line summary and a Review button for each spec waiting on you.

**Headless from cron.** One tick per run; stdin must not be a terminal:

```sh
*/10 * * * * cd /srv/factory && GITHUB_TOKEN=... claude -p "/factory tick" --plugin-dir /path/to/software-factory < /dev/null
```

(drop `--plugin-dir` if the plugin is installed). Leases (15 minutes, renewed every 5) keep overlapping runs from working the same job.

**As a Claude scheduled task.** Schedule the prompt `/factory tick`. The plugin, the repos option and the tokens must be available in the task's environment; a task that cannot load the plugin does nothing.

## CI failure intake

`ci/factory-intake.mjs` turns a failed default-branch CI job into a `factory::ready` issue (deduplicated by a fingerprint of the log tail; the log is redacted). Copy it into the target repository as `.factory-intake.mjs` (Node 20+, no dependencies), then add the job from:

- `ci/github-action.yml`: uses the workflow's `GITHUB_TOKEN`, which needs `permissions: issues: write`.
- `ci/gitlab-ci.yml`: needs a project access token (scope `api`) in a masked CI variable `FACTORY_GITLAB_TOKEN`.


## Repository configuration (`.factory.yml`)

Read from the default branch. Required: `forge`, `test`.

| Key | Default | Meaning |
|---|---|---|
| `forge` | required | `github` or `gitlab` |
| `test` | required | Command the verify station runs; must exit 0 |
| `setup` | none | Command run before `test` |
| `reviewers` | `[code, security]` | Any of `code`, `security`, `ux`; at least one entry |
| `protectedPaths` | `[]` | Globs the builder may not change |
| `models` | see below | Per-role model overrides |
| `limits.fixLoops` | 3 | Review/verify rounds before the job is blocked |
| `limits.parallel` | 2 | Parallel jobs |
| `branchPrefix` | `factory/` | Branch is `<prefix><issue>-<slug>` |
| `allowedTools` | `[]` | Extra tools for the builder |
| `sandbox` | see below | Bash sandbox for the agents |

Default models: spec-writer `opus`, designer `opus`, planner `sonnet`, builder `sonnet`, code-reviewer `opus`, security-reviewer `opus`, ux-reviewer `sonnet`, approver `sonnet`. The factory owns a `.factory/` directory in each job's checkout; a branch that tracks `.factory/` is refused (job goes to `factory::blocked`).

See `templates/.factory.yml` for an example. The `sandbox` map controls the Bash sandbox the agents run in:

```yaml
sandbox:
  allowedDomains: ["repo.packagist.org", "*.github.com"]   # hosts agents' shell commands may reach; default none
  required: false   # true: agents fail to start where the sandbox can't run; false (default): they run unsandboxed there
```

With no `allowedDomains`, sandboxed commands have no network, so a build that installs packages needs its registries listed. With `required: false`, a host without the sandbox (for example Linux without bubblewrap) runs agents' commands unsandboxed; set `required: true` to refuse that.

## Deployment and security

Each station runs as a child `claude -p` session with this plugin loaded. Inside it, the plugin's `tool.call` gates refuse pushes, merge/pull-request creation, edits outside the job's directory, reads outside it or under `/proc`, and any shell or edit for the read-only roles. Children start without `GITHUB_TOKEN`/`GITLAB_TOKEN`/`GITLAB_URL` and with Claude Code's Bash sandbox enabled; the factory does every token-bearing git operation itself in a fresh, throw-away bare repository.

Mods run with your permissions, and the child sessions run with `--permission-mode acceptEdits`. Protect the default branch on the forge too (branch protection, required reviews): the factory only pushes its own branch and opens a merge/pull request, but the forge is the real backstop.

**The gates are guard-rails, not a security boundary.** A builder agent runs the repository's own code and tools as your OS user, and a process running as the same user as the factory can, with enough effort, reach what that user can reach — including the forge token held by the parent process. For production, run the worker as a **dedicated OS user, or in a container or VM, holding only the forge token** for the repositories it works on, with no other credentials, SSH keys or cloud configuration in its home directory.

The gates check paths textually, not via `realpath`, so a symlink committed in the worktree can point a Read at a file outside it; this falls under the same-user residual risk above, and the mitigation is the same dedicated OS user or container.

## Development

```sh
claude plugin test                 # whole suite
node --test ci/*.test.mjs          # CI intake script
claude plugin validate --strict .
```

An end-to-end check against a sandbox repo is in `scripts/smoke.md`.
