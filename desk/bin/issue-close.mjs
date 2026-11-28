#!/usr/bin/env node
// Closes the GitHub issue a §4 Tracker none ticket (`issue-<n>`) works from once its PR has merged,
// where the PR's `Closes #<n>` did not: a merge into a base other than the default branch, or a squash
// whose message dropped the keyword. The issue gets a "Merged in #<pr>." comment. Run straight after
// the merge; a follow step the ticket left for later does not hold it open (it stays on needs-you).
// Where §3 gh-issue-close is not yes, nothing is closed and the issue is named as ready to close. Any
// other ticket, or a repo with a tracker, prints nothing.
//
//   issue-close.mjs <issue-n> --pr <n> [--repo <owner/name>]   (the repo defaults to §0 GitHub repo)
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { ticketIssue } from './closing-keywords.mjs';

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { ok: r.status === 0, out: r.stdout ?? '', err: String(r.stderr || r.error?.message || '').trim() };
};
const why = (r) => r.err.split('\n').pop() || r.out.trim().split('\n').pop() || 'no output';
const parse = (r) => { try { return JSON.parse(r.out); } catch { return undefined; } };
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// How long a keyword GitHub should act on is given to close the issue itself, read every WAIT_MS.
export const WAIT_TRIES = 6;
export const WAIT_MS = 5000;

// One line saying what happened to the issue ticket `issue-<n>` works from after PR <pr> merged:
// already closed, closed, ready to close, or left open and why. `run` is (cmd, args) -> {ok, out, err};
// `perm` is §3 gh-issue-close's value, or null when unset; `sleep` waits that many ms.
export function closeTicketIssue({ ticket, pr, repo, perm, run = sh, sleep = pause }) {
  const n = ticketIssue(ticket);
  if (n == null) return [];
  const ref = `${repo}#${n}`;
  const prRead = run('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'state,closingIssuesReferences']);
  const p = prRead.ok ? parse(prRead) : undefined;
  if (!p?.state) return [`${ref} left open: PR #${pr} could not be read (${prRead.ok ? 'no state' : why(prRead)})`];
  if (p.state !== 'MERGED') return [`${ref} left open: PR #${pr} is ${String(p.state).toLowerCase()}, not merged`];
  // GitHub acts on a keyword it honours a few seconds after the merge, so where the PR lists the issue
  // the state is read again for a while before desk closes it itself.
  const keyword = (p.closingIssuesReferences ?? []).some((i) => Number(i?.number) === n);
  let st;
  for (let i = 0; i < (keyword ? WAIT_TRIES : 1); i++) {
    if (i) sleep(WAIT_MS);
    const r = run('gh', ['issue', 'view', String(n), '--repo', repo, '--json', 'state']);
    st = r.ok ? parse(r)?.state : undefined;
    if (!st) return [`${ref} left open: its state could not be read (${r.ok ? 'no state' : why(r)})`];
    if (st !== 'OPEN') return [`${ref} already ${String(st).toLowerCase()}`];
  }
  const comment = `Merged in #${pr}.`;
  const byHand = `gh issue close ${n} --repo ${repo} --comment '${comment}'`;
  if (perm !== 'yes') return [`${ref} is ready to close, PR #${pr} merged without closing it (config §3 gh-issue-close is ${perm ?? 'unset'}): ${byHand}`];
  const closed = run('gh', ['issue', 'close', String(n), '--repo', repo, '--comment', comment]);
  return [closed.ok ? `${ref} closed: ${comment} (its closing keyword did not close it; §3 gh-issue-close)` : `${ref} not closed: ${why(closed)} — close it by hand: ${byHand}`];
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const take = (flag) => { const at = args.indexOf(flag); return at < 0 ? undefined : args.splice(at, 2)[1]; };
  const repo = take('--repo') ?? E.ghRepo();
  const pr = take('--pr');
  const [ticket] = args;
  if (!ticket || args.length > 1 || !/^[0-9]+$/.test(pr ?? '') || !/^[^/\s]+\/[^/\s]+$/.test(repo ?? '')) {
    console.error('usage: issue-close.mjs <issue-n> --pr <n> [--repo <owner/name>]'); process.exit(2);
  }
  if (E.ticketKind(ticket).kind !== 'issue') process.exit(0);
  for (const line of closeTicketIssue({ ticket, pr: Number(pr), repo, perm: E.permissionOrUnset('gh-issue-close') })) console.log(line);
}
