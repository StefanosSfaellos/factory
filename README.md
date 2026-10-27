# software-factory

A Claude Code mod plugin that runs a multi-agent pipeline over GitHub and GitLab issues: spec (approved by a human), design, plan, test-first build, independent verify, code/security/UX review, approval, and a merge/pull request the factory opens itself.

Unit-tested against Claude Code 2.1.306; run scripts/smoke.md on your worker before relying on it.

## Install

```sh
claude --plugin-dir /path/to/software-factory        # try it from a checkout
```

or from a marketplace (one must exist and list the plugin first):

```sh
claude plugin install software-factory@<marketplace>
```

Then enable it. The plugin root is the repository root.

## Setup

1. **Tokens** (environment of the process that runs Claude Code; see [Repos and tokens](#repos-and-tokens)):
   - `GITHUB_TOKEN`: github.com.
   - `GITLAB_TOKEN` + `GITLAB_URL`: one GitLab host (`GITLAB_URL` defaults to `https://gitlab.com`).
   - `FACTORY_TOKENS`: any number of hosts, `host=token,host=token`.
   Tokens are never written to comments, logs or the UI; agent child processes do not receive them.
2. **Plugin options** (`userConfig`, set when you enable the plugin):

   | Option | Type | Default | Meaning |
   |---|---|---|---|
   | `repos` | string | empty | Comma-separated entries, e.g. `github:owner/*,gitlab:group/name,gitlab:lab.example.gr/team/*` (forms below) |
   | `workerId` | string | `worker` | Id used when taking leases; left as `worker`, each session uses `<host>-<random>` |
   | `tickMinutes` | number | 10 | How often the session ticker polls the forges |
   | `parallel` | number | 2 | Global cap on jobs a tick leases and advances at once |
   | `slackWebhook` | string | empty | Optional Slack incoming-webhook URL for notifications |

3. **`.factory.yml`** at the root of each repository's default branch (see below).
4. Label an issue `factory::ready` (or run `/factory new <title>`).

## Repos and tokens

One session can work github.com and several GitLab servers at once.

**`repos` entries** (comma-separated):

| Entry | Means |
|---|---|
| `github:owner/name` | that repository |
| `github:owner/*` | every repository of that user or organisation the token can see |
| `github:*` | every repository the token can see |
| `gitlab:group/name` | that project on the `GITLAB_URL` host (`gitlab.com` by default) |
| `gitlab:group/*`, `gitlab:*` | that group (with its subgroups), or every project the token can see, on the `GITLAB_URL` host |
| `gitlab:<host>/group/sub/name` | that project on `<host>`, e.g. `gitlab:lab.example.gr/team/app` |
| `gitlab:<host>/group/*` | that group on `<host>`, with its subgroups |
| `gitlab:<host>/*` | every project on `<host>` the token can see |

A first path segment that contains a dot is a host, and so is one equal to the `GITLAB_URL` host (which may have no dot, e.g. `http://gitlab:8080`: write `gitlab:gitlab/group/name` or `gitlab:gitlab:8080/group/name`). A GitLab group in the first segment that contains a dot, or is named like that host, needs the host written first: `gitlab:gitlab.com/my.group/app`. Host and project paths are matched without regard to case (`github:acme/app` and `github:Acme/*` find one job). A wildcard costs one paged search per station label per tick (11 queries), and the factory only ever touches a project when one of its open issues carries a `factory::` label. A labelled issue in a project without a `.factory.yml` is blocked with a comment saying so. GitLab wildcards (`gitlab:<host>/*`, `gitlab:<host>/group/*`) cover only projects where the token's user is a member with **Developer access or more**, and in those only open issues carrying a `factory::` label: public projects of others on the same instance, and projects where the user is only Guest or Reporter, are ignored. The member list is read once per tick and host; if that read fails, the wildcard yields no jobs that tick and the error shows in `/factory status` and the tick output. GitHub wildcards (`github:*`, `github:owner/*`) use `/issues?filter=all`, which GitHub already limits to repositories the user owns, is a collaborator on, or reaches through an organisation membership. On gitlab.com prefer group wildcards (`gitlab:group/*`) to `gitlab:*`: the whole-instance search returns every public issue carrying a `factory::` label before the membership filter drops them, which is slow and wasteful there.

**Tokens**, one per host:

| Variable | Host |
|---|---|
| `GITHUB_TOKEN` | `github.com` |
| `GITLAB_TOKEN` | the host of `GITLAB_URL` (default `https://gitlab.com`) |
| `FACTORY_TOKENS` | `host=token,host=token`: host names without `https://` (compared lower-case); an entry here overrides the two above for its host. `github.com=<token>` is GitHub; any other host is a GitLab server, always reached over `https://<host>`. A FACTORY_TOKENS host must contain a dot and have no port; a GitLab on a dotless host, a port or plain http goes in `GITLAB_URL` + `GITLAB_TOKEN` |

Every token needs to read the repositories and write issues, branches and merge/pull requests (GitLab scope `api`). Wildcards need a **personal or group access token**: a project access token sees only its own project. A repo whose host has no token is reported in `/factory status` and in each tick (`no token for lab.example.gr: add "lab.example.gr=<token>" to FACTORY_TOKENS`); the other repos still run.

Full `~/.claude/settings.json` example:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/software-factory",
    "GITHUB_TOKEN": "ghp_...",
    "GITLAB_URL": "https://gitlab.com",
    "GITLAB_TOKEN": "glpat-...",
    "FACTORY_TOKENS": "lab.example.gr=glpat-...,git.example.com=glpat-..."
  },
  "pluginConfigs": {
    "software-factory@inline": {
      "options": {
        "repos": "github:acme/*,gitlab:group/app,gitlab:lab.example.gr/team/*,gitlab:git.example.com/ops/infra"
      }
    }
  }
}
```

**Issue references.** A job is shown as `github:owner/name#42`, as `gitlab:group/name#42` when it is on the `GITLAB_URL` host, and as `gitlab:<host>/group/name#42` on any other GitLab host. A GitLab project whose first segment has a dot (or is named like the `GITLAB_URL` host) is always shown with its host. Every form shown can be typed back into `/factory run|status|approve|revise`. A full reference works on any project the host's token can reach, whether or not `repos` lists it: `/factory run gitlab:lab.example.gr/other/app#3` labels and runs that issue. `#42` alone works only when exactly one repo is configured and it is not a wildcard.

## How a job moves

Each issue carries exactly one station label. The factory posts its output as a comment first and changes the label last, so a failed API call is retried safely on the next tick.

| Label | Meaning |
|---|---|
| `factory::ready` | Queued; the next tick runs the spec-writer through to `factory::awaiting-spec` |
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

GitHub and GitLab create missing labels when the factory applies them; if your forge settings prevent that, create the 13 labels first. One tick advances a job through stations until it reaches a human gate (`awaiting-spec`, `mr-open`), a failure, `blocked`, or a 30-step cap.

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
| `/factory run <issue>` | Puts an issue on the line and ticks it now (a full reference works on any project the token can reach, not only those in `repos`) |
| `/factory approve <issue>` | Approves the spec |
| `/factory revise <issue> <notes>` | Sends the spec back with notes |
| `/factory status [issue]` | Text summary of the jobs |
| `/factory pause` / `/factory resume` | Stops or starts the session ticker |

An issue is `#42` when exactly one repo (not a wildcard) is configured, otherwise `github:owner/name#42`, `gitlab:group/name#42` (the `GITLAB_URL` host) or `gitlab:<host>/group/name#42`.

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
| `limits.fixLoops` | 3 | How many times a failed verify/review may loop back to build; the next failure blocks the job (with 3, the 4th failure blocks) |
| `limits.parallel` | 2 | Currently ignored; use the `parallel` plugin option |
| `branchPrefix` | `factory/` | Branch is `<prefix><issue>-<slug>` |
| `allowedTools` | `[]` | Extra tools for the builder (it always gets `Bash`) |
| `sandbox` | see below | Bash sandbox for the agents |

Default models: spec-writer `opus`, designer `opus`, planner `sonnet`, builder `sonnet`, code-reviewer `opus`, security-reviewer `opus`, ux-reviewer `sonnet`, approver `sonnet`. The factory owns a `.factory/` directory in each job's checkout; a branch that tracks `.factory/` is refused (job goes to `factory::blocked`).

See `templates/.factory.yml` for an example. The `sandbox` map controls the Bash sandbox the agents run in:

```yaml
sandbox:
  allowedDomains: ["repo.packagist.org", "*.github.com"]   # hosts agents' shell commands may reach; default none
  required: false   # true: agents fail to start where the sandbox can't run; false (default): see below
```

With no `allowedDomains`, sandboxed commands have no network, so a build that installs packages needs its registries listed.

The builder is always allowed `Bash` (plus the repo's `allowedTools`), because a `claude -p` child in `acceptEdits` mode would otherwise be refused Bash and could not run tests or commit. Every builder command is filtered by the factory's `tool.call` gates; where Claude Code's Bash sandbox is available it also contains them. Read-only roles get no shell at all. With `required: false` (default), a host without the sandbox (for example Linux without bubblewrap) runs the builder's commands without that containment, still filtered by the gates; set `required: true` to make agents fail closed there instead.

## Deployment and security

Each station runs as a child `claude -p` session with this plugin loaded. Inside it, the plugin's `tool.call` gates refuse pushes, merge/pull-request creation, edits outside the job's directory, reads outside it or under `/proc`, and any shell or edit for the read-only roles. Children, and the repository's `setup`/`test` commands the verify station runs, start without `GITHUB_TOKEN`/`GITLAB_TOKEN`/`GITLAB_URL`/`FACTORY_GITLAB_TOKEN`/`FACTORY_TOKENS`; children also get Claude Code's Bash sandbox where the host supports it; the factory does every token-bearing git operation itself in a fresh, throw-away bare repository.

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
