# desk-setup step 1: the pre-push hook

Read during step 1, once §4 Pre-push checks is confirmed and is not `none`. The step table in
`../SKILL.md` names this file for it. "The merge holds proposed above" are step 1's, in
`step-1-detect.md`.

### The pre-push hook

Once §4 Pre-push checks is confirmed and is not `none`, make two offers, each its own question.

**1. Commit the hook and the script.** The templates are in the desk-skills checkout that ran
`install.sh`: `$(cat ~/.claude/desk/source-checkout)/desk/templates/`, holding `.githooks/pre-push`
and `scripts/desk/pre-push.sh`. If the repo already has both and they match, say so and skip. If they
differ, show the diff and ask whether to update them. On a yes, on a new branch off `<default>` named
per §5 Branch names, never on `<default>` itself:

```bash
T="$(cat ~/.claude/desk/source-checkout)/desk/templates"
mkdir -p .githooks scripts/desk
cp "$T/.githooks/pre-push" .githooks/pre-push && cp "$T/scripts/desk/pre-push.sh" scripts/desk/pre-push.sh
git add .githooks/pre-push scripts/desk/pre-push.sh
git update-index --chmod=+x .githooks/pre-push      # git skips a hook that is not executable
git commit -m "<§5 PR title format>: add the desk pre-push hook"
```

Push it and open the PR through `desk-pr`, under §3 `git-push` and `pr-open`. Say that both paths
fall under the merge holds proposed above, so a person merges it.

**2. Set `core.hooksPath` for this clone.** First check what already runs on a push:

- **A hook manager is in charge** (`.husky/`, a `lefthook` file, `.pre-commit-config.yaml`), or
  `core.hooksPath` is already set to something other than `.githooks`: do not change it, because
  that would switch the manager off. Say so, and that `desk-pr` runs the script itself before every
  push anyway. Offer the one line for the manager's own pre-push hook,
  `bash scripts/desk/pre-push.sh "$@"`, as the user's change to make.
- **Hooks in `.git/hooks` that are not samples**: a hooks path switches them off. Name them and ask
  before setting it.
- **Otherwise**, on a yes, in the primary checkout:

  ```bash
  git config core.hooksPath .githooks     # local to this clone and shared by its worktrees; a new clone needs it again
  ```

  Git finds no hook there until the hook from offer 1 is checked out. That is harmless: the push
  runs unchecked, as it does today.

Once the script is in the checkout, run `bash scripts/desk/pre-push.sh --head` once and show each
item's time. Over about 90 s: say so, and offer to move the slowest item out of the row (CI still
runs it).
