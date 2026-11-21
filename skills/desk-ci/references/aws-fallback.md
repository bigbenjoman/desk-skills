# desk-ci: aws-fallback

Read before `aws-fallback status` or `off`, or when an `AWS fallback on for` issue the watchdog opened comes
up, and no other step's file with it. The overview, the placement rule and the red flags every
command shares are in `../SKILL.md`, already loaded.

## aws-fallback

A repo whose CI runs on its own AWS runners reads the repo variable `DESK_AWS_FALLBACK` in every AWS
job's `runs-on`: at `on`, those jobs run on GitHub-hosted runners instead. When the AWS runners stop
taking jobs (a broken stack, a quota, an AWS outage), the watchdog turns it on, and only the user
turns it off.

**The watchdog** is desk-skills' `.github/workflows/aws-fallback-watch.yml`, every 10 minutes. For
each repo in the desk-skills variable `DESK_AWS_WATCHED_REPOS` (comma-separated `owner/name`) it reads
the AWS runner labels the repo's `.github/desk-ci.yml` declares (*A repo's AWS runners*, in
`../SKILL.md`) at its default branch, then:

| The repo | The watchdog |
|---|---|
| a job queued on a declared label for over 15 minutes | sets `DESK_AWS_FALLBACK` to `on`, opens an issue `AWS fallback on for <repo>` in desk-skills naming the repo, the time and the oldest queued job, then cancels every run with a job queued on a declared label and re-runs its cancelled jobs (only those, so a job that passed does not run twice); a comment on the issue names any run left cancelled, to re-run by hand |
| every job on a declared label started within 15 minutes | changes nothing |
| its fallback already on | leaves it on and opens no second issue; it opens one only when none was opened since the fallback went on (the first failed to open, or someone turned it on by hand) |
| declares no AWS runner labels | changes nothing |
| its `.github/desk-ci.yml` cannot be read (no file, or an API error) | changes nothing, names the repo and the error in the run's log, and fails the run once every repo is checked |

It reads and writes the watched repos with the desk-skills secret `DESK_AWS_FALLBACK_TOKEN`, a
fine-grained token with Variables and Actions write and Contents read on each of them. With no secret
the run fails and changes nothing.

**Status and off** run from the user's machine with their own `gh` login:

```bash
node ~/.claude/desk/bin/desk-ci.mjs aws-fallback status [--repo owner/name]
node ~/.claude/desk/bin/desk-ci.mjs aws-fallback off --repo owner/name
```

`status` prints, for the named repo or every repo the watchdog watches, whether its fallback is on and
since when (the variable's last update), then when the watchdog last ran and how it ended. `off`
deletes the repo's `DESK_AWS_FALLBACK` and reads it back, so its next runs queue for its AWS runners
again; if they still do not start, the watchdog turns it on again and opens a new issue.

Run `off` only when the user says to: whether the AWS runners work again is theirs to say. Nothing
moves a repo back to AWS on its own.
