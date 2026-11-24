#!/usr/bin/env node
// The merge driver's hold around one merge: the merge lease for the repo and base (leases.mjs, the
// `merge` kind), with the ticket ledger read inside it, so two desk paths never both read "not merged
// yet" and both act on one PR. The lease is held only for one check, merge and record, never for the
// driver's life, and with the kind on the driver bounds the merge call (desk_timeout) so the hold is too.
//
//   merge-lease.mjs take <PR> <head sha> --repo <owner/name> --base <base> --by <merger> --pid <owner pid>
//                        [--wait <seconds>]
//       prints one JSON line: { lease, mode, unreadable, lines }. `lease` is the lease id to release
//       after the record (null where none was taken; the driver releases it with leases.mjs release),
//       `unreadable` whether the lease store could not be read, `lines` what to log. While it waits,
//       says on stderr who holds the lease. The ledger is that of the queue $DESK_QUEUE names.
//       Exit 0 merge, 3 the ledger already records a merge or an armed auto-merge at this head, 4 the
//       lease store or the ledger is unreadable with the kind on, 75 gave up waiting, 2 usage.
//
// By the kind's mode (desk-env lease mode merge):
//   off     nothing is taken and the ledger is not read: the merge goes as before.
//   shadow  the lease is taken as shadow takes any; a ledger record that on would refuse is logged to
//           the lease log as a would-refuse naming the earlier path, and the merge goes. A store that
//           cannot be read lets the merge go without the lease.
//   on      a ledger record at this head refuses the merge; a store or ledger that cannot be read
//           refuses it too, because a double merge cannot be undone.
// The ledger is read only with the ledger lever on (desk-env levers ledger).
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXIT_GAVE_UP, EXIT_OK, EXIT_REFUSED, EXIT_UNREADABLE, EXIT_USAGE, LeaseStoreError, LeaseUsageError, RESET_COMMAND, acquire, kindMode, leaseDir, logEvent, release } from './leases.mjs';
import { fold } from './ticket-ledger.mjs';
import { ledgerOn, ledgerTarget } from './queue-ledger.mjs';

// The lease's TTL: the bound on the merge call inside it (the driver's MERGE_DRIVER_MERGE_SECS default).
const HOLD_S = 120;
// A holder that hangs lapses at twice its TTL, so this wait outlasts it.
const WAIT_S = 2 * HOLD_S;

const mergeKey = (repo, base) => `${repo}@${base}`;
const sameHead = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length >= 7 && b.length >= 7 && (a.startsWith(b) || b.startsWith(a));

// The ledger's record of PR `pr` merged or armed for auto-merge at head `sha`, from folded state
// `state`: { event: 'merged' | 'armed', by, key, head_sha }, or null.
function ledgerRecord(state, pr, sha) {
  for (const t of Object.values(state?.tickets ?? {})) {
    if (t.merge && Number(t.merge.pr) === Number(pr) && sameHead(t.merge.head_sha, sha)) return { event: 'merged', by: t.merge.by, key: t.key, head_sha: t.merge.head_sha };
    if (t.automerge && Number(t.automerge.pr) === Number(pr) && sameHead(t.automerge.head_sha, sha)) return { event: 'armed', by: t.automerge.by, key: t.key, head_sha: t.automerge.head_sha };
  }
  return null;
}
const recordText = (r) => `the ticket ledger records it ${r.event === 'merged' ? 'merged' : 'armed for auto-merge'} by ${r.by} at ${String(r.head_sha).slice(0, 9)}${r.key ? ` (${r.key})` : ''}`;

// One hold's start: the lease, then the ledger check inside it. `env` is desk-env's exports; `ledger`
// whether the ledger lever is on; `readLedger()` the folded ledger. -> { code, lease, mode, unreadable,
// lines }; a refused or failed take has released any lease it took.
function take({ pr, sha, repo, base, by, pid, wait, env, dir = leaseDir(), ledger, readLedger, onWait }) {
  const key = mergeKey(repo, base);
  const { mode } = kindMode('merge', env);
  let unreadable = false;
  const out = (code, lease, lines) => ({ code, lease, mode, unreadable, lines });
  if (mode === 'off') return out(EXIT_OK, null, []);
  const lines = [];
  let lease = null;
  try {
    const r = acquire({ kind: 'merge', key, units: 1, ttl: HOLD_S, label: `${by} #${pr}`, pid, wait }, { env, dir, onWait });
    // Busy with no wait is a give-up, not a refusal: 3 is the ledger's, which the driver backs off on.
    if (r.code !== EXIT_OK) return out(r.code === EXIT_REFUSED ? EXIT_GAVE_UP : r.code, null, [`the merge lease for ${key}: ${r.why}`]);
    lease = r.lease?.id ?? null;
    if (r.why) lines.push(`the merge lease for ${key}: ${r.why}`);
  } catch (e) {
    if (!(e instanceof LeaseStoreError)) throw e;
    unreadable = true;
    if (mode === 'on') return out(EXIT_UNREADABLE, null, [`merges wait for the lease store: ${e.message}; a person moves it aside with ${RESET_COMMAND}`]);
    lines.push(`leases were unreadable (${e.message}): merging without the merge lease`);
  }
  const free = () => { try { if (lease) release(lease, pid, { env, dir }); } catch { /* it lapses at its TTL */ } };
  if (!ledger) return out(EXIT_OK, lease, [...lines, 'the ledger lever is off: no ledger check']);
  let rec;
  try { rec = ledgerRecord(readLedger(), pr, sha); } catch (e) {
    if (mode === 'on') { free(); return out(EXIT_UNREADABLE, null, [...lines, `the ticket ledger could not be read (${e.message}): not merging`]); }
    return out(EXIT_OK, lease, [...lines, `the ticket ledger could not be read (${e.message}): merging as before`]);
  }
  if (!rec) return out(EXIT_OK, lease, lines);
  if (mode === 'on') { free(); return out(EXIT_REFUSED, null, [...lines, `NOT merged: ${recordText(rec)}`]); }
  const why = recordText(rec);
  logEvent({ event: 'would-refuse', kind: 'merge', key, units: 1, owner: { pid }, label: `${by} #${pr}`, holders: [{ label: rec.by, ledger: rec.event }], why }, { dir });
  return out(EXIT_OK, lease, [...lines, `shadow: ${why}, which on would refuse; merging as before`]);
}

const USAGE = 'usage: merge-lease.mjs take <PR> <head sha> --repo <owner/name> --base <base> --by <merger> --pid <owner pid> [--wait <seconds>]';

function flags(args, takes) {
  const pos = []; const opt = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const name = a.slice(2);
    if (!takes.includes(name) || args[i + 1] == null) throw new LeaseUsageError(`--${name}: ${takes.includes(name) ? 'needs a value' : 'unknown option'}`);
    opt[name] = args[++i];
  }
  return { pos, opt };
}
const whole = (v, what) => { if (!/^\d+$/.test(String(v ?? ''))) throw new LeaseUsageError(`${what} is a whole number, not "${v ?? ''}"`); return Number(v); };

async function cli(argv) {
  const [sub, ...rest] = argv;
  try {
    if (sub !== 'take') throw new LeaseUsageError(sub ? `unknown command "${sub}"` : 'which command?');
    const { pos, opt } = flags(rest, ['repo', 'base', 'by', 'pid', 'wait']);
    if (pos.length !== 2) throw new LeaseUsageError('take takes a PR number and its head SHA');
    for (const f of ['repo', 'base', 'by']) if (!opt[f]) throw new LeaseUsageError(`take needs --${f}`);
    const pr = whole(pos[0], 'the PR');
    const queue = process.env.DESK_QUEUE;
    const key = mergeKey(opt.repo, opt.base);
    const onWait = (why) => console.error(`${new Date().toISOString().slice(11, 19)}Z #${pr} waiting for the merge lease on ${key}: ${why}`);
    const r = take({ pr, sha: pos[1], repo: opt.repo, base: opt.base, by: opt.by, pid: whole(opt.pid, '--pid'),
      wait: opt.wait == null ? WAIT_S : whole(opt.wait, '--wait'), env: await import('./desk-env.mjs'), ledger: ledgerOn(), onWait,
      readLedger: () => { if (!queue) throw new Error('no queue file names the ledger'); return fold(ledgerTarget(queue).repoDir); } });
    // One log line each: a JSON parse error's message spans lines.
    const lines = r.lines.map((l) => l.replace(/\s*\n\s*/g, ' '));
    console.log(JSON.stringify({ lease: r.lease, mode: r.mode, unreadable: r.unreadable, lines }));
    return r.code;
  } catch (e) {
    if (e instanceof LeaseUsageError) { console.error(`merge-lease: ${e.message}`); console.error(USAGE); return EXIT_USAGE; }
    throw e;
  }
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) process.exit(await cli(process.argv.slice(2)));
