#!/usr/bin/env node
// Who merged what, at which head: one JSON line per event, machine-wide, in ~/.desk-autopilot/merges.jsonl
// (DESK_MERGE_LOG names another file). Every desk path that merges writes here, so a merger sees that
// another is already on the PR before it merges, and the person and desk-q can read who did.
//
//   merge-log.mjs claim <PR> <sha> --by <who> [--repo <owner/name>]
//       before merging: refused (exit 11, naming the other) when another merger claimed the PR in the
//       last CLAIM_MS or any merger recorded it merged or armed; otherwise records the claim (exit 0).
//   merge-log.mjs record <PR> <sha> --by <who> --event merged|armed|failed [--repo <owner/name>] [--why <text>]
//       after: what happened. `armed` is auto-merge armed, which GitHub merges later.
//   merge-log.mjs show [--repo <owner/name>] [--pr <n>]
//       the events, oldest first, one line each.
// The repo defaults to §0 GitHub repo. `who` names the merger and stays the same across its own retries:
// `merge-driver <slug>` for the driver, `session <id or name>` for a session.
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { EXIT } from './batch-state.mjs';

// How long a claim holds the PR for its merger: long enough for one merge, short enough that a merger
// that died after claiming does not hold the PR for good.
export const CLAIM_MS = 10 * 60 * 1000;
export const EVENTS = ['claim', 'merged', 'armed', 'failed'];
export const logPath = () => E.expandHome(process.env.DESK_MERGE_LOG ?? join(E.HOME, '.desk-autopilot', 'merges.jsonl'));

// Every event in the log, oldest first; a torn line is skipped, never fatal.
export function readLog(path = logPath()) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
}
const append = (e, path) => { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, `${JSON.stringify(e)}\n`); };

// Another merger already on this PR, or null: one that recorded it merged or armed, at any time, or
// claimed it within CLAIM_MS and recorded nothing since. The same merger's own events never block it.
export function otherMerger(events, { repo, pr, by, now = Date.now() }) {
  const mine = events.filter((e) => e.repo === repo && String(e.pr) === String(pr));
  const done = [...mine].reverse().find((e) => e.event === 'merged' || e.event === 'armed');
  if (done && done.by !== by) return done;
  const last = new Map();
  for (const e of mine) last.set(e.by, e);
  for (const [who, e] of last) if (who !== by && e.event === 'claim' && now - Date.parse(e.at) < CLAIM_MS) return e;
  return null;
}
export const eventLine = (e) => `${e.at}  ${e.repo}#${e.pr}  ${e.event}  at ${String(e.sha ?? '?').slice(0, 12)}  by ${e.by}${e.why ? `  (${e.why})` : ''}`;

export function claim({ repo, pr, sha, by, now = Date.now(), path = logPath() }) {
  const other = otherMerger(readLog(path), { repo, pr, by, now });
  if (other) return { ok: false, why: `${repo}#${pr} is already ${other.event === 'claim' ? 'claimed' : other.event} by ${other.by} (${other.at}, at ${String(other.sha ?? '?').slice(0, 12)}): not merging` };
  append({ at: new Date(now).toISOString(), repo, pr: String(pr), sha, by, event: 'claim' }, path);
  return { ok: true };
}
export function record({ repo, pr, sha, by, event, why = null, now = Date.now(), path = logPath() }) {
  append({ at: new Date(now).toISOString(), repo, pr: String(pr), sha, by, event, ...(why ? { why } : {}) }, path);
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); if (i < 0) return null; const v = args[i + 1]; args.splice(i, 2); return v ?? ''; };
  const repoFlag = flag('--repo'); const by = flag('--by'); const event = flag('--event'); const why = flag('--why'); const prFlag = flag('--pr');
  const [cmd, pr, sha] = args;
  const usage = 'usage: merge-log.mjs claim <PR> <sha> --by <who> | record <PR> <sha> --by <who> --event merged|armed|failed [--why <text>] | show [--pr <n>]   [--repo <owner/name>]';
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
