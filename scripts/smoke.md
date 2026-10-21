# End-to-end smoke test

Manual run against a throw-away repository, once per forge (GitHub, then GitLab). Use a private sandbox project you can delete. Needs the tokens from the README, `repos` set to the sandbox, and a second account (or a non-member) for the forged-comment check.

Start Claude Code with the plugin (`claude --plugin-dir <path>`), then:

## 1. Add `.factory.yml`

Commit to the default branch:

```yaml
forge: github        # or gitlab
test: "true"
reviewers: [code]
```

Expected: nothing happens yet.

## 2. Label an issue

Create an issue ("Add a hello.txt containing hello") and add label `factory::ready` (or `/factory new Add hello.txt -- file containing hello`).

Expected: exactly one station label, `factory::ready`.

## 3. Tick

Run `/factory tick`.

Expected: label `factory::spec` while the spec-writer runs, then a comment starting with `<!-- factory:spec ... -->` containing the spec, and the label `factory::awaiting-spec`. If the issue shows `factory::blocked` instead, read the `factory:blocked` comment.

## 4. Forged-comment check (GitHub)

As a non-member (an account with no role in the repo), comment `/approve` on the issue. Run `/factory tick` again.

Expected: label stays `factory::awaiting-spec`; no `factory:approval` comment. Also post a comment whose first line is `<!-- factory:spec -->` from the same account: it must be ignored. (GitLab trusts every commenter, so skip this on GitLab and keep the project private.)

## 5. Approve

As the owner, comment `/approve` (or `/factory approve #N`).

Expected after the next tick: label `factory::design`.

## 6. Tick to `mr-open`

Run `/factory tick` repeatedly (or let the ticker run). Expected sequence of labels, each preceded by its comment:

| Label after tick | Comment posted |
|---|---|
| `factory::plan` | `factory:design` |
| `factory::build` | `factory:plan` |
| `factory::verify` | (branch `factory/<N>-<slug>` pushed) |
| `factory::review` | `factory:test-report` (pass) |
| `factory::approve` | `factory:verdict` per reviewer (pass) |
| `factory::mr-open` | `factory:approval` with the merge/pull request link |

Expected at the end: a merge/pull request from `factory/<N>-...` exists, opened by the factory account. Merging it is a human step.

## Also check

- `/factory status` lists the job; the band shows the summary while it runs.
- Relabel an issue with two station labels: next tick moves it to `factory::blocked` with a comment naming both labels.
- The first run verifies the agent naming `--agent software-factory:<role>`: if a station fails at start with an unknown agent, report it.
