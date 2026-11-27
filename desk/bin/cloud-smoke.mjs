#!/usr/bin/env node
// The cloud smoke: `node ~/.claude/desk/bin/cloud-smoke.mjs [--timeout <minutes>]`, run in the repo.
// It starts a smoke session under the repo's Subscription login and reads its results from a scratch
// branch, which it then deletes; exit 0 only when every check passed. desk-setup's Cloud environment
// step writes Worker location `cloud` only on that exit 0. The work is cloud-env.mjs's runSmoke.
import { runMain, runSmoke } from './cloud-env.mjs';

runMain(() => runSmoke(process.argv.slice(2)));
