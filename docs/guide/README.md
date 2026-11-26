# desk-skills docs

The [main README](../../README.md) is the tour. These pages are the reference.

| Page | Read it when you want to know |
|---|---|
| [Skills reference](skills.md) | Exactly what each skill does, every form of its command, the subagents, and the third-party skills and plugins |
| [Autopilot](autopilot.md) | How a batch runs, how workers are sandboxed, the preflight, and the supervisor that runs batches with no session open |
| [Configuring a repo](configuration.md) | What `/desk-setup` asks, the config file and its rules, Jira logins, a second Claude login, changing things later |
| [Install and update](install.md) | What `install.sh` writes and asks, the hooks, requirements, updating, and how skills stay one copy each |
| [Skill evals and benchmarks](benchmarks.md) | Measuring whether a skill earns its place, and comparing models on frozen tasks from real merged tickets |
| [Developing desk-skills](development.md) | The test suite, CI, how the autopilot pass is built, and where desk came from |

Other documents in [`docs/`](..):

- [`porting-contract.md`](../porting-contract.md): the rules that keep the skills repo-generic.
- [`review-2026-09-27.md`](../review-2026-09-27.md): the adversarial review the skills were hardened against.
- [`design-epic-batches.md`](../design-epic-batches.md): the design of epic feature batches.
- [`desk-config.md`](../../desk-config.md): the config template and its full rules.
