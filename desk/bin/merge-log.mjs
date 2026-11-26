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
//   merge-log.mjs record ... [--ticket <key>]
//       names the ticket the PR is for, as the merge driver does.
//   merge-log.mjs record ... --event merged [--merged-by <login>]
//       a `merged` line carries `merged_by`, the login GitHub names as the merger, read from GitHub when
//       --merged-by is not given (an empty one: GitHub names none). With none named, `who` is `unknown`.
//   merge-log.mjs show [--repo <owner/name>] [--pr <n>]
//       the events, oldest first, one line each.
//   merge-log.mjs show --pr <n> --latest [--repo <owner/name>]
//       the PR's latest merged (else armed, not since disarmed or failed) event as one JSON line: its event, who,
//       head SHA, time and ticket. Nothing, exit 0, when the log has none or there is no log yet.
// The repo defaults to §0 GitHub repo. `who` names the merger and stays the same across its own retries:
// `merge-driver <slug>` for the driver, `session <id or name>` for a session, and on a `merged` line
// `github <login>` for a PR merged outside desk before its merger got to it, or `unknown` where GitHub
// names no merger.
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

// Each parsed line of the log with its position from 0, oldest first; a torn line is skipped, never fatal.
function parsed(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').flatMap((l, line) => { if (!l) return []; try { return [{ v: JSON.parse(l), line }]; } catch { return []; } });
}
// Every event in the log, oldest first.
export function readLog(path = logPath()) {
  return parsed(path).map((p) => p.v);
}
// readLog's events, each with `line`: its line's position in the log, which an append never moves, so a
// reader folding the log keeps how far it has read. Throws when the log cannot be read.
export function readLogLines(path = logPath()) {
  return parsed(path).flatMap(({ v, line }) => (v && typeof v === 'object' ? [{ ...v, line }] : []));
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
export const shortSha = (e) => String(e.sha ?? '?').slice(0, 12);
export const eventLine = (e) => `${e.at}  ${e.repo}#${e.pr}  ${e.event}  at ${shortSha(e)}  by ${e.by}${e.why ? `  (${e.why})` : ''}`;

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
    const held = otherMerger(events, { repo, pr, by, now });
    if (held?.event === 'armed') {
      const armed = armedNow(repo, pr);
      if (armed === null) return { ok: false, why: `${repo}#${pr} has auto-merge armed by ${held.by} in the merge log (${held.at}, at ${String(held.sha ?? '?').slice(0, 12)}), and GitHub could not be read to check it is still on: not merging` };
      if (!armed) {
        append({ at: new Date(now).toISOString(), repo, pr: String(pr), sha, by, event: 'disarmed', why: 'GitHub shows auto-merge off' }, path);
        notArmed = true;
      }
    }
    const other = otherMerger(events, { repo, pr, by, now, notArmed });
    if (other) return { ok: false, why: `${repo}#${pr} is already ${other.event === 'claim' ? 'claimed' : other.event} by ${other.by} (${other.at}, at ${shortSha(other)}): not merging` };
    append({ at: new Date(now).toISOString(), repo, pr: String(pr), sha, by, event: 'claim' }, path);
    return { ok: true };
  });
}
// The merger of a PR someone outside desk merged, as GitHub names them: `github <login>`, else `unknown`.
export const outsideMerger = (login) => (login ? `github ${login}` : 'unknown');

// `mergedBy`, on a `merged` record: the login GitHub names as the PR's merger, kept as `merged_by`;
// null when GitHub names none, which makes the merger `unknown` rather than `by`; undefined when
// GitHub was not read, which records `by` as before. -> the entry written.
export function record({ repo, pr, sha, by, event, ticket = null, why = null, mergedBy, now = Date.now(), path = logPath() }) {
  const named = event === 'merged' && mergedBy !== undefined;
  const e = { at: new Date(now).toISOString(), repo, pr: String(pr), sha, by: named && !mergedBy ? 'unknown' : by, event,
    ...(named ? { merged_by: mergedBy || null } : {}), ...(ticket ? { ticket } : {}), ...(why ? { why } : {}) };
  locked(path, () => append(e, path));
  return e;
}

// The login GitHub names as the PR's merger: a string, null when it names none, or undefined when it
// could not be read.
export function ghMergedBy(repo, pr) {
  const r = spawnSync('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'mergedBy'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  if (r.status !== 0) return undefined;
  try { const v = JSON.parse(r.stdout).mergedBy; return v?.login ? String(v.login) : null; } catch { return undefined; }
}

// The PR's latest `merged` event, else its latest `armed` one not ended since, else null. A disarm ends
// it whoever armed it (GitHub keeps one auto-merge); a failure ends it when its armer records it, as
// otherMerger reads it. Claims and failures are not outcomes. GitHub names repos in any case, so the
// repo matches whatever its case.
export function latest(events, { repo, pr }) {
  const mine = events.filter((e) => String(e.repo).toLowerCase() === String(repo).toLowerCase() && String(e.pr) === String(pr));
  const merged = mine.findLast((e) => e.event === 'merged');
  if (merged) return merged;
  const i = mine.findLastIndex((e) => e.event === 'armed');
  if (i < 0) return null;
  const ended = mine.slice(i + 1).some((e) => e.event === 'disarmed' || (e.event === 'failed' && e.by === mine[i].by));
  return ended ? null : mine[i];
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v ?? ''; };
  const latestFlag = args.includes('--latest'); if (latestFlag) args.splice(args.indexOf('--latest'), 1);
  const repoFlag = flag('--repo'); const by = flag('--by'); const event = flag('--event'); const why = flag('--why'); const prFlag = flag('--pr'); const ticket = flag('--ticket'); const mergedByFlag = flag('--merged-by');
  const [cmd, pr, sha] = args;
  const usage = 'usage: merge-log.mjs claim <PR> <sha> --by <who> | record <PR> <sha> --by <who> --event merged|armed|disarmed|failed [--ticket <key>] [--why <text>] [--merged-by <login>] | show [--pr <n>] | show --pr <n> --latest   [--repo <owner/name>]';
  const die = (m) => { console.error(`merge-log: ${m}`); process.exit(EXIT.SHOW_PERSON); };
  let repo = repoFlag;
  if (!repo) { try { repo = E.ghRepo(); } catch (e) { die(`no --repo, and §0 GitHub repo could not be read (${e.message})`); } }
  if (cmd === 'show' && latestFlag) {
    if (!/^[1-9][0-9]*$/.test(prFlag ?? '')) die(usage);
    const e = latest(readLog(), { repo, pr: prFlag });
    if (e) console.log(JSON.stringify(e));
    process.exit(EXIT.GO_ON);
  }
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
    const mergedBy = event !== 'merged' ? undefined : mergedByFlag !== null ? mergedByFlag || null : ghMergedBy(repo, pr);
    const e = record({ repo, pr, sha, by, event, ticket, why, mergedBy });
    console.log(`recorded ${repo}#${pr} ${event} at ${sha.slice(0, 12)} by ${e.by}${e.merged_by ? ` (GitHub: ${e.merged_by})` : ''}`);
  }
}
