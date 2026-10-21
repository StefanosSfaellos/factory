# software-factory

A Claude Code mod plugin that runs a multi-agent pipeline over GitHub and GitLab issues: spec (approved by a human), design, plan, test-first build, independent verify, code/security/UX review, approval, and a merge/pull request the factory opens itself. Configure repos in the plugin options and a `.factory.yml` in each repository; run `/factory tick` (or let the ticker run) to advance jobs.

## Repository configuration (`.factory.yml`)

See `templates/.factory.yml` for every key. The optional `sandbox` map controls the Bash sandbox the agents run in:

```yaml
sandbox:
  allowedDomains: ["repo.packagist.org", "*.github.com"]   # hosts agents' shell commands may reach; default none
  required: false   # true: agents fail to start where the sandbox can't run; false (default): they run unsandboxed there
```

With no `allowedDomains`, sandboxed commands have no network, so a build that installs packages needs its registries listed. With `required: false`, a host without the sandbox (for example Linux without bubblewrap) runs agents' commands unsandboxed; set `required: true` to refuse that.

## Deployment and security

Each station runs as a child `claude -p` session with this plugin loaded. Inside it, the plugin's `tool.call` gates refuse pushes, merge/pull-request creation, edits outside the job's directory, reads outside it or under `/proc`, and any shell or edit for the read-only roles. Children start without `GITHUB_TOKEN`/`GITLAB_TOKEN`/`GITLAB_URL` and with Claude Code's Bash sandbox enabled; the factory does every token-bearing git operation itself in a fresh, throw-away bare repository.

**The gates are guard-rails, not a security boundary.** A builder agent runs the repository's own code and tools as your OS user, and a process running as the same user as the factory can, with enough effort, reach what that user can reach — including the forge token held by the parent process. For production, run the worker as a **dedicated OS user, or in a container or VM, holding only the forge token** for the repositories it works on, with no other credentials, SSH keys or cloud configuration in its home directory.
