# Running as the `desk` plugin

Read when SKILL.md's **Plugin root** line reads as a path: the `desk` plugin (`desk@desk-skills`,
built by `desk/bin/plugin-build.mjs`) loaded this skill, and that path is the plugin's directory.
Call it `<plugin root>` below and write it out in full in every command.

- `<desk bin>` (the desk scripts) is `<plugin root>/desk/bin`, and `desk-env`, `desk-codex` and
  `desk-gh` are on PATH from the plugin's `bin`.
- `verdict.mjs` is `<plugin root>/skills/desk-review/bin/verdict.mjs`, in place of
  `~/.agents/skills/desk-review/bin/verdict.mjs`.
- Each named agent is `desk:<name>` (`desk:lena-code-reviewer`).
- With `DESK_CONFIG_FILE` set (`echo "$DESK_CONFIG_FILE"` prints a path), `EXISTS=no` is not a
  stop: that file answers the config rows SKILL.md reads, and a row it lacks reads as unset.
- That file carries no §3 permission, and with no repo config `desk-env perm` has none to read. The
  brief that started this session stands in for §3 `pr-self-review-comment` on your own PR: a brief
  that says the repo's config sets it to `yes` and tells you to post the verdict reads as `yes`
  there, and Phase 7 posts. A brief that says nothing of it reads as `no`: report only, and say so.
