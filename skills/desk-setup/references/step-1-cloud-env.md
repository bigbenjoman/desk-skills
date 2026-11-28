# desk-setup step 1: the cloud environment

Read when §3b Worker location is `cloud`, or the person's answer is switching it to `cloud`. The step
table in `../SKILL.md` names this file for it. `$CE` is `node ~/.claude/desk/bin/cloud-env.mjs`, run
in the repo.

### Cloud environment

Worker location `cloud` needs a working Claude Code cloud environment for this repo, and claude.ai
has no API to create or edit one. So this step writes what the person pastes, then checks what they
made. **The row is written as `cloud` only once the cloud smoke exits 0.** Until then it stays at what it
held (`local` for a new config), and you say so.

1. **The setup script.** Run `$CE script --write`. It writes `$CREDS/cloud-setup.sh` (this repo's config
   folder, from `desk-env where`) and prints it. It finds the checkout by search, installs
   the toolchain pins directly (not through mise), runs the lockfile's install, the ORM client
   generate step, Playwright's browsers, and points Docker at `mirror.gcr.io` before pulling the
   compose images, each only where the repo has its marker. A `.tool-versions` pin for any tool
   but node, bun and python gets a step saying it is not installed: name each one, so the person
   adds its install above the block. Show the script, then say:
   - paste it into the environment's **Setup script** field, in claude.ai/code's environment
     settings, on the account this repo's Subscription row names (`desk-env subscription`);
   - **one environment should serve every desk repo**: `claude --cloud` starts in the last-used
     environment, not one matched to the repo. Where the environment already holds another repo's
     block, add this one after it, guards and all; replace only the block between this repo's own
     guard lines on a re-run. Each other repo's block is in its own `<config folder>/cloud-setup.sh`.
2. **Network and variables.** Run `$CE hosts`. Name each `HOST` line's host and the variables that
   point at it: on Limited network access, the person adds those hosts (the Clerk API host among
   them) or the dev server and tests cannot reach them. Then name every `VARS` name as one the
   environment needs set, by name only. Never read out or write a value. Then say the `NOTE` line
   plainly: every variable in the one shared environment reaches every desk repo's sessions in it,
   so a secret set for this repo is readable by the others' sessions too.
3. **The first start.** Run `$CE first-start`. It starts `claude --cloud` under this repo's
   Subscription login, so a first-run prompt (allowing environment variables) is answered now, not
   by a background start that nothing answers. Where it prints a command to run instead, ask the
   person to run it in their own terminal and answer what it asks, then go on.
4. **The smoke.** Run `node ~/.claude/desk/bin/cloud-smoke.mjs` in the repo once the person says the environment is
   saved. It starts a smoke session under the same login that checks the environment, toolchain,
   services, migrate and seed, the dev server, one unit test and one signed-in browser test, as this
   config's §4 rows name them, and reads its results from a scratch branch it then deletes. Show
   every line it prints. Exit 0: write Worker location `cloud`. Otherwise: keep the row, name each
   `FAIL` line with what to change (the setup script, network hosts, a variable), and offer to run
   the smoke again once it is changed.
