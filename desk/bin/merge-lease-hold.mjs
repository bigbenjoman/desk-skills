#!/usr/bin/env node
// A session's stacked merge in the clearance merge lane, under one merge lease hold: the lease for the
// repo and base with the ticket ledger read inside it (merge-lease.mjs take), the merge log's claim, a
// read of the PR (already merged, it was someone else's merge: recorded as theirs, not enqueued),
// GitHub's enqueue-only merge call, then a poll of the PR's .merged until GitHub reports it merged or
// the settle time passes, the merge log's record and the ticket ledger's, and the release. The next PR
// in the stack is never checked against a ledger that cannot yet show this one.
//
//   merge-lease-hold.mjs <PR> <head sha> --repo <owner/name> --base <base> --by <merger> --method <merge|squash|rebase>
//                        [--ticket <KEY> [--head <branch>]]
//
// The hold waits up to 120 seconds for GitHub to report the merge, reading every 5, and up to twice the
// lease's TTL (the settle time plus a minute) for the lease. With --ticket and the kind not off, the batch holding the ticket records the merge
// (queue.mjs merged, which the ledger records with its lever on) before the lease is released; a ticket
// no batch holds has the merge log's line as its record.
//
// Exit 0 merged at the head given; 1 the enqueue was refused, GitHub did not report the PR merged in
// time, or it merged at another head; 2 usage; 3 the ledger already records a merge or an armed
// auto-merge at this head; 4 the lease store or ledger is unreadable with the kind on; 11 another merger
// claimed it in the merge log; 75 gave up waiting for the lease. By the merge kind's mode: off takes no
// lease, reads no ledger and writes no ledger record, as before; shadow takes it without waiting.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { sleepSync } from './dir-lock.mjs';
import { EXIT_OK, EXIT_USAGE, LeaseUsageError, leaseDir, release } from './leases.mjs';
import { mergeKey, repoLedger, take } from './merge-lease.mjs';
import { claim, movedLine, record, recordMerged, recordOutside } from './merge-log.mjs';
import { MISSED_PREFIX, ledgerOn } from './queue-ledger.mjs';

const SETTLE_S = 120;
const POLL_S = 5;
const EXIT_NOT_MERGED = 1;
const EXIT_CLAIMED = 11;
const METHODS = ['merge', 'squash', 'rebase'];
const BIN = dirname(fileURLToPath(import.meta.url));

const ENQUEUE_MS = 60_000;
const PRE_READ_MS = 15_000;

// One gh call, ended at `ms`: -> { status, stdout, stderr, timedOut }.
const ghRun = (args, ms) => {
  const r = spawnSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: ms, killSignal: 'SIGKILL' });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: timedOut ? `gh did not answer within ${Math.round(ms / 1000)}s` : (r.stderr ?? '').trim(), timedOut };
};

// The ledger record of the merge through queue.mjs merged, which acts on the batch holding the ticket.
// queue.mjs writes queue.json and exits 0 even when the ledger append misses, saying so on stderr, so
// that line makes it not recorded.
// `at` is when GitHub merged it (null where unread: queue.mjs then dates it now).
const queueMerged = ({ ticket, pr, head, sha, base, by, at = null }) => {
  const r = spawnSync(process.execPath, [join(BIN, 'queue.mjs'), 'merged', ticket, ...(at ? [at] : []), '--pr', String(pr), ...(head ? ['--head', head] : []), '--head-sha', sha, '--base', base, '--by', by],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const missed = (r.stderr ?? '').split('\n').find((l) => l.startsWith(MISSED_PREFIX));
  if (r.status === 0 && !missed) return { ok: true, text: (r.stdout ?? '').trim().split('\n')[0] };
  return { ok: false, text: (missed ?? (r.stderr ?? '').trim().split('\n')[0]) || `queue.mjs exit ${r.status}` };
};

// One hold. `gh(args)` -> { status, stdout, stderr }; `recordLedger` queueMerged's shape; `say(line)`
// each line to report. -> the exit code.
export function hold({ pr, sha, repo, base, by, method, ticket = null, head = null, settle = SETTLE_S, poll = POLL_S, wait = null,
  env, dir = leaseDir(), ledger = ledgerOn(), readLedger = repoLedger(env), gh = ghRun, recordLedger = queueMerged,
  logPath, now = Date.now, sleep = sleepSync, say = (l) => console.log(l), onWait = null }) {
  const pid = process.pid;
  const ttl = settle + 60;
  const key = mergeKey(repo, base);
  const t = take({ pr, sha, repo, base, by, pid, ttl, wait: wait ?? 2 * ttl, env, dir, ledger, readLedger, onWait });
  for (const l of t.lines) say(`#${pr} ${l}`);
  if (t.code !== EXIT_OK) return t.code;
  const log = logPath ? { path: logPath } : {};
  try {
    const c = claim({ repo, pr, sha, by, ...log });
    if (!c.ok) { say(`#${pr} ${c.why}`); return EXIT_CLAIMED; }
    // The PR as GitHub has it, in merge-log.mjs ghMerged's shape plus `mergedAt`, GitHub's merge time
    // (null where unmerged). Unread reads as unmerged.
    const read = (ms) => {
      const r = gh(['api', `repos/${repo}/pulls/${pr}`, '--jq', '{merged: .merged, head: .head.sha, login: .merged_by.login, merged_at: .merged_at}'], ms);
      let v = {};
      if (r.status === 0) { try { v = JSON.parse(r.stdout) ?? {}; } catch { v = {}; } }
      return { merged: v.merged === true, head: v.head ? String(v.head) : null, login: v.login ? String(v.login) : null, mergedAt: v.merged_at ? String(v.merged_at) : null };
    };
    // After the merge log's line (merge-log.mjs recordMerged), the ledger's, dated when GitHub merged it,
    // and whether it merged at the head checked.
    const done = (m, g, how) => {
      if (ticket && t.mode !== 'off') {
        const l = recordLedger({ ticket, pr, head, sha: m.at, base, by: m.who, at: g.mergedAt });
        say(l.ok ? `#${pr} ledger: ${l.text}` : `#${pr} ledger: not recorded (${l.text}); the merge log's line is its record`);
      }
      if (m.note) say(`#${pr} ${m.note.slice(2)}`);
      if (m.moved) {
        say(`#${pr} STOP: GitHub merged it ${movedLine(g.head, sha)}`);
        return EXIT_NOT_MERGED;
      }
      say(`#${pr} ${how} at ${sha.slice(0, 9)} onto ${base}; releasing the merge lease on ${key}`);
      return EXIT_OK;
    };
    // Already merged before this hold enqueued it: someone else merged it, under whatever login, so the
    // record names them as GitHub does and nothing is enqueued (merge-log.mjs recordOutside, the merge
    // driver's too, given this read). An unread PR is enqueued as before. It shares the enqueue's
    // minute, so the hold still ends within the lease's TTL.
    const start = now();
    const pre = read(PRE_READ_MS);
    const o = recordOutside({ repo, pr, sha, ...(ticket ? { ticket } : {}), read: () => pre, ...log });
    if (o) return done(o, pre, `already merged by ${o.who} (not enqueued)`);
    const q = gh(['api', '-X', 'PUT', `repos/${repo}/pulls/${pr}/merge-async`, '-f', `merge_method=${method}`], Math.max(1000, ENQUEUE_MS - (now() - start)));
    // An enqueue gh did not answer may still have reached GitHub, so its outcome is read from the PR.
    if (q.timedOut) say(`#${pr} ${q.stderr} for the enqueue: reading whether GitHub merged it`);
    else if (q.status !== 0) {
      record({ repo, pr, sha, by, event: 'failed', why: q.stderr || `gh exit ${q.status}`, ...log });
      say(`#${pr} NOT merged: GitHub refused the enqueue: ${q.stderr || `gh exit ${q.status}`}`);
      return EXIT_NOT_MERGED;
    }
    const until = now() + settle * 1000;
    for (;;) {
      // Each read is ended at the settle time's end (a second at least), so a stalled read never holds the lease past it.
      const r = read(Math.max(1000, until - now()));
      if (r.merged) return done(recordMerged({ repo, pr, sha, g: r, by, ...(ticket ? { ticket } : {}), ...log }), r, 'merged');
      if (now() >= until) {
        say(`#${pr} not reported merged within ${settle}s: releasing the merge lease on ${key}. Read gh pr view ${pr} --json state before the next PR in the stack`);
        return EXIT_NOT_MERGED;
      }
      sleep(Math.max(1, Math.min(poll * 1000, until - now())));
    }
  } finally {
    try { if (t.lease) release(t.lease, pid, { env, dir }); } catch { say(`#${pr} merge lease ${t.lease} not released: it lapses at its TTL`); }
  }
}

const USAGE = 'usage: merge-lease-hold.mjs <PR> <head sha> --repo <owner/name> --base <base> --by <merger> --method <merge|squash|rebase> [--ticket <KEY> [--head <branch>]]';
const OPTIONS = Object.fromEntries(['repo', 'base', 'by', 'method', 'ticket', 'head'].map((k) => [k, { type: 'string' }]));
const whole = (v, what, min = 0) => { if (!/^\d+$/.test(String(v ?? '')) || Number(v) < min) throw new LeaseUsageError(`${what} is a whole number${min ? ` from ${min}` : ''}, not "${v ?? ''}"`); return Number(v); };

async function cli(argv) {
  try {
    let pos, opt;
    try { ({ positionals: pos, values: opt } = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true })); }
    catch (e) { throw new LeaseUsageError(e.message); }
    if (pos.length !== 2) throw new LeaseUsageError('it takes a PR number and its head SHA');
    if (!/^[0-9a-f]{7,40}$/.test(pos[1])) throw new LeaseUsageError(`the head SHA is 7 to 40 hex digits, not "${pos[1]}"`);
    for (const f of ['repo', 'base', 'by', 'method']) if (!opt[f]) throw new LeaseUsageError(`it needs --${f}`);
    if (!METHODS.includes(opt.method)) throw new LeaseUsageError(`--method is one of ${METHODS.join(', ')}, not "${opt.method}"`);
    if (opt.head && !opt.ticket) throw new LeaseUsageError('--head goes with --ticket');
    const env = await import('./desk-env.mjs');
    return hold({ pr: whole(pos[0], 'the PR', 1), sha: pos[1], repo: opt.repo, base: opt.base, by: opt.by, method: opt.method,
      ticket: opt.ticket ?? null, head: opt.head ?? null, env,
      onWait: (why) => console.error(`${new Date().toISOString().slice(11, 19)}Z #${pos[0]} waiting for the merge lease on ${mergeKey(opt.repo, opt.base)}: ${why}`) });
  } catch (e) {
    if (e instanceof LeaseUsageError) { console.error(`merge-lease-hold: ${e.message}`); console.error(USAGE); return EXIT_USAGE; }
    throw e;
  }
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) process.exit(await cli(process.argv.slice(2)));
