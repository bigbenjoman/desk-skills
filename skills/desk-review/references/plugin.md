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
