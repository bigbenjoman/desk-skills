#!/usr/bin/env node
// Who merged what, at which head: one JSON line per event, machine-wide, in ~/.desk-autopilot/merges.jsonl
// (DESK_MERGE_LOG names another file). Every desk path that merges writes here, so a merger sees that
// another is already on the PR before it merges, and the person and desk-q can read who did.
//
//   merge-log.mjs claim <PR> <sha> --by <who> [--repo <owner/name>]
//       before merging: refused (exit 11, naming the other) when another merger claimed the PR in the
//       last CLAIM_MS, recorded it merged, or armed auto-merge not since disarmed; otherwise records the
//       claim (exit 0). An `armed` record is checked against GitHub at the claim: off there, it no
//       longer holds the PR, and is closed with a `disarmed` line.
//   merge-log.mjs record <PR> <sha> --by <who> --event merged|armed|disarmed|failed [--repo <owner/name>] [--why <text>]
//       after: what happened. `armed` is auto-merge armed, which GitHub merges later; whoever turns it
//       off records `disarmed`, which releases the PR.
//   merge-log.mjs show [--repo <owner/name>] [--pr <n>]
//       the events, oldest first, one line each.
// The repo defaults to §0 GitHub repo. `who` names the merger and stays the same across its own retries:
// `merge-driver <slug>` for the driver, `session <id or name>` for a session.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as E from './desk-env.mjs';
import { EXIT } from './batch-state.mjs';
import { lock, unlock } from './dir-lock.mjs';

// How long a claim holds the PR for its merger: long enough for one merge, short enough that a merger
// that died after claiming does not hold the PR for good.
export const CLAIM_MS = 10 * 60 * 1000;
export const EVENTS = ['claim', 'merged', 'armed', 'disarmed', 'failed'];
export const logPath = () => E.expandHome(process.env.DESK_MERGE_LOG ?? join(E.HOME, '.desk-autopilot', 'merges.jsonl'));

// Every event in the log, oldest first; a torn line is skipped, never fatal.
export function readLog(path = logPath()) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
const append = (e, path) => { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${JSON.stringify(e)}\n`); };
// Every read-check-append under one lock beside the log, so two mergers claiming at once cannot both
// find the PR free.
function locked(path, fn) {
  const dir = `${path}.lock.d`;
  mkdirSync(dirname(path), { recursive: true });
  lock(dir);
  try { return fn(); } finally { unlock(dir); }
}

// Another merger already on this PR, or null: one that recorded it merged, at any time; one whose last
// event on it is `armed` (auto-merge, until it is disarmed or failed: anyone who disarms it records
// `disarmed`); or one whose last event is a claim made within CLAIM_MS. The same merger's own events
// never block it.
// `notArmed`: GitHub shows the PR's auto-merge off, so no `armed` record holds it (claim reads it).
export function otherMerger(events, { repo, pr, by, now = Date.now(), notArmed = false }) {
  const mine = events.filter((e) => e.repo === repo && String(e.pr) === String(pr));
  const merged = [...mine].reverse().find((e) => e.event === 'merged');
  if (merged && merged.by !== by) return merged;
  // A disarm ends every armed auto-merge on the PR, whoever armed it: GitHub keeps one.
  const lastDisarm = mine.map((e) => e.event).lastIndexOf('disarmed');
  const last = new Map();
  mine.forEach((e, i) => last.set(e.by, { e, i }));
  for (const [who, { e, i }] of last) {
    if (who === by) continue;
    if (e.event === 'armed' && i > lastDisarm && !notArmed) return e;
    if (e.event === 'claim' && now - Date.parse(e.at) < CLAIM_MS) return e;
  }
  return null;
}
export const eventLine = (e) => `${e.at}  ${e.repo}#${e.pr}  ${e.event}  at ${String(e.sha ?? '?').slice(0, 12)}  by ${e.by}${e.why ? `  (${e.why})` : ''}`;

// Whether GitHub shows the PR's auto-merge armed now: true, false, or null when it could not be read.
export function ghArmed(repo, pr) {
  const r = spawnSync('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'autoMergeRequest'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout).autoMergeRequest != null; } catch { return null; }
}

export function claim({ repo, pr, sha, by, now = Date.now(), armedNow = ghArmed, path = logPath() }) {
  return locked(path, () => {
    const events = readLog(path);
    // An armed record is checked against GitHub, read now under the lock: auto-merge turned off
    // anywhere (GitHub's UI, GitHub itself, a disarm whose record was lost) releases it, and it is
    // closed in the log so it reads true from then on. Unreadable, the hold stands.
    let notArmed = false;
    if (otherMerger(events, { repo, pr, by, now })?.event === 'armed') {
      const armed = armedNow(repo, pr);
      if (armed === null) return { ok: false, why: `${repo}#${pr} has auto-merge armed in the merge log, and GitHub could not be read to check it is still on: not merging` };
      if (!armed) {
        append({ at: new Date(now).toISOString(), repo, pr: String(pr), sha, by, event: 'disarmed', why: 'GitHub shows auto-merge off' }, path);
        notArmed = true;
      }
    }
    const other = otherMerger(events, { repo, pr, by, now, notArmed });
    if (other) return { ok: false, why: `${repo}#${pr} is already ${other.event === 'claim' ? 'claimed' : other.event} by ${other.by} (${other.at}, at ${String(other.sha ?? '?').slice(0, 12)}): not merging` };
    append({ at: new Date(now).toISOString(), repo, pr: String(pr), sha, by, event: 'claim' }, path);
    return { ok: true };
  });
}
export function record({ repo, pr, sha, by, event, why = null, now = Date.now(), path = logPath() }) {
  locked(path, () => append({ at: new Date(now).toISOString(), repo, pr: String(pr), sha, by, event, ...(why ? { why } : {}) }, path));
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v ?? ''; };
  const repoFlag = flag('--repo'); const by = flag('--by'); const event = flag('--event'); const why = flag('--why'); const prFlag = flag('--pr');
  const [cmd, pr, sha] = args;
  const usage = 'usage: merge-log.mjs claim <PR> <sha> --by <who> | record <PR> <sha> --by <who> --event merged|armed|disarmed|failed [--why <text>] | show [--pr <n>]   [--repo <owner/name>]';
  const die = (m) => { console.error(`merge-log: ${m}`); process.exit(EXIT.SHOW_PERSON); };
  let repo = repoFlag;
  if (!repo) { try { repo = E.ghRepo(); } catch (e) { die(`no --repo, and §0 GitHub repo could not be read (${e.message})`); } }
  if (cmd === 'show') {
    for (const e of readLog()) if (e.repo === repo && (prFlag == null || String(e.pr) === String(prFlag))) console.log(eventLine(e));
    process.exit(EXIT.GO_ON);
  }
  if (!['claim', 'record'].includes(cmd) || !/^[1-9][0-9]*$/.test(pr ?? '') || !/^[0-9a-f]{7,40}$/.test(sha ?? '') || !by) die(usage);
  if (cmd === 'claim') {
    const r = claim({ repo, pr, sha, by });
    if (!r.ok) die(r.why);
    console.log(`claimed ${repo}#${pr} at ${sha.slice(0, 12)} for ${by}`);
  } else {
    if (!EVENTS.includes(event) || event === 'claim') die(usage);
    record({ repo, pr, sha, by, event, why });
    console.log(`recorded ${repo}#${pr} ${event} at ${sha.slice(0, 12)} by ${by}`);
  }
}
