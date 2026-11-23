#!/usr/bin/env node
// Which of a ready PR's red checks are red only because its base was, the base green since: the
// merge driver's read (merge-driver.sh stale_base), before it re-runs a red PR, of the predicate the
// pass's fix tries and outage step use (fix-tries.mjs staleChecks, over base-reads.mjs). A re-run
// replays the PR's old merge commit on the red base and fails the same way, so the driver updates the
// branch from the base instead.
//
//   node stale-base.mjs <owner/repo> <base branch> <ticket key> <head sha>   with the red check names on stdin, one a line
//
// Decides as the pass does (fix-tries.mjs staleCall), from the ticket's base red hold and base_refresh
// (DESK_QUEUE's): exit 0 printing the stale names, one a line, to update the branch from; exit 3 while
// an update made at this head waits for its new head (no rerun); exit 1 for the usual way (none stale,
// the base unread, or an update at this head refused or long past); exit 2 on a usage error.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { makeBaseReads } from './base-reads.mjs';
import { staleCall } from './fix-tries.mjs';

const [repo, branch, key, head] = process.argv.slice(2);
if (!repo || !branch || !key || !/^[0-9a-f]{40}$/.test(head ?? '')) {
  console.error('usage: stale-base.mjs <owner/repo> <base branch> <ticket key> <head sha>  (red check names on stdin)');
  process.exit(2);
}
let names = [];
try { names = [...new Set(readFileSync(0, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))]; } catch { /* none */ }
let t = { key };
try { t = JSON.parse(readFileSync(process.env.DESK_QUEUE ?? '', 'utf8')).tickets?.[key] ?? t; } catch { /* no hold to read */ }
const gh = (args) => {
  try { return { ok: true, out: execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() }; }
  catch (e) { return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() }; }
};
const c = staleCall(t, head, names, makeBaseReads({ gh, repo, branch }).forHead(head), { base: branch });
if (c?.call === 'wait') { console.log(c.why); process.exit(3); }
if (c?.call !== 'refresh') process.exit(1);
for (const n of c.checks) console.log(n);
