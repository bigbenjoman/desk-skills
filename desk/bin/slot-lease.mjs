// with-lock.sh's lease client: the slot a test, tsc, browser or light run takes from the machine's
// lease broker (leases.mjs), behind the `slot` kind's lever (desk-env lease mode slot). A lint, which
// runs under `tsc`, is told apart and holds a `lint` slot.
//
//   node slot-lease.mjs mode                                  # off, shadow or on: the slot kind's mode
//   node slot-lease.mjs take <class> --pid <owner> [--timeout <s>] [--waited <s>] [--express <dir>] -- <command...>
//   node slot-lease.mjs note <queued|grant|gave-up> <class> --pid <wrapper pid> --waited <s> [--lane express]
//   node slot-lease.mjs holders [--light]                     # who holds the test (or light) lock, one line
//   node slot-lease.mjs in-slot <pid>                         # exit 0 when <pid> runs inside a test or light slot
//
// `take` names the lease's owner (the wrapper's own pid, which then execs into the command, or the
// command's pid where the wrapper runs it as a child), so the lease is held for as long as the command
// runs and lapses the moment it exits. In `on` it waits for the slot in the broker's queue for its
// pool, oldest first, saying once what it waits on, who holds it and its place in the queue, and gives
// up after --timeout seconds (exit 75), naming its place then; the same worktree asking again with the
// same command within leases.mjs REJOIN_S seconds takes that place back. In `shadow` it makes one try, which
// shadow always grants, logging a would-refuse when the pool was full; the wrapper has already taken
// its legacy lock and ignores how this ends; --waited is how long it waited for that lock, which the
// grant line records. With `--express` (light only), a run waiting in `on` takes the light lock's
// express lane, that lock directory, where it is free (exit 10). `note` logs a run's wait on the lock
// files where no lease line carries it; `--lane express` names the express lane on a grant line.
//
// Exit codes: 0 granted (or nothing to take), 10 took the express lane, 75 gave up waiting, 4 the lease
// store is unreadable, 1 the broker failed otherwise. The wrapper falls back to its legacy lock on 4 and 1.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import * as A from './admission.mjs';
import { LOCK_OF, lockWaitingDir } from './admit-ledger.mjs';
import { alive, tryLock } from './dir-lock.mjs';
import { tilde } from './logins.mjs';
import { EXIT_GAVE_UP, EXIT_OK, EXIT_REFUSED, EXIT_UNREADABLE, LeaseStoreError, SAMPLE_TIMEOUT_MS, acquire, capacities, kindMode, logEvent, poolOf, sampleLoad, waitFields } from './leases.mjs';

// How often a run waiting in `on` tries again: each try reads the process table.
const POLL_MS = 2000;
// `take --express`'s exit when the run took the light lock's express lane rather than a lease.
const EXIT_LANE = 10;
// A slot lease's TTL. Its owner's exit, not its TTL, ends it (leases.mjs exempts a slot lease with a
// live owner from lapsing), so this only dates it. DESK_SLOT_LEASE_TTL sets it for a test fixture.
const ttl = () => (/^\d+$/.test(process.env.DESK_SLOT_LEASE_TTL ?? '') && Number(process.env.DESK_SLOT_LEASE_TTL) > 0 ? Number(process.env.DESK_SLOT_LEASE_TTL) : 600);
const LINTERS = new Set(E.LINT_BINS);

// This repo's §4 Lint commands, without their directories; [] with no config or row.
function lintItems() {
  try {
    const v = E.configValues('lint-cmd');
    return v == null || E.isNone(v) ? [] : v.map((x) => E.parseCommandItem(x).cmd);
  } catch { return []; }
}
// Whether `words` is a lint: a linter binary, or a §4 Lint item with or without arguments added (the
// pre-push hook's rule for which items take the lock), run as it is or as the one argument of
// `bash -c` / `sh -c`, which is how the pre-push hook and the baseline runner run each item.
function isLint(words) {
  const shell = words.length === 3 && words[1] === '-c' && /^(?:ba)?sh$/.test(basename(words[0]));
  const line = shell ? words[2].trim() : words.join(' ');
  if (LINTERS.has(basename(shell ? line.split(/\s+/)[0] : words[0] ?? ''))) return true;
  return lintItems().some((c) => line === c || line.startsWith(`${c} `));
}

// ---- a run's wait: who else waits, and the line the lease log keeps -----------------------------
// Each run waiting for a lock holds a marker file named by its wrapper's pid in that lock's waiting
// directory, in the lock directory beside the lock files, from when it starts to wait until it is
// granted or gives up; with-lock.sh keeps it on the lock files, `take` while it waits for a lease. The
// queue at any moment is the markers whose pid is alive: a waiter killed mid-wait counts no longer.
export const waitingDir = (cls, dir = E.lockDir()) => lockWaitingDir(cls, dir);
// How many runs other than `self` wait for `cls`'s lock now.
function queueDepth(cls, self, dir = waitingDir(cls)) {
  let names = [];
  try { names = readdirSync(dir); } catch { return 0; }
  return names.filter((n) => /^\d+$/.test(n) && Number(n) !== self && alive(Number(n))).length;
}
const enqueue = (cls, pid) => { try { mkdirSync(waitingDir(cls), { recursive: true }); writeFileSync(join(waitingDir(cls), String(pid)), ''); } catch { /* the queue is a measurement */ } };
const dequeue = (cls, pid) => { try { unlinkSync(join(waitingDir(cls), String(pid))); } catch { /* not queued */ } };
// The git worktree this run's command runs in, else its directory.
function worktree() {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8', timeout: SAMPLE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || process.cwd(); }
  catch { return process.cwd(); }
}
// The fields of a wait line for class `cls`'s run, its wrapper `pid`, `waited` seconds in.
const waitNow = (cls, pid, waited) => waitFields({ cls, worktree: worktree(), waited, queue: queueDepth(cls, pid), sample: sampleLoad() });

// Logs a queued, grant or gave-up line for a run that waited on the lock files, not a lease: the slot
// kind is off, or a shadow lease failed. -> 0, logged or not.
function note(rest) {
  const [event, cls, ...more] = rest;
  const opt = (n) => { const i = more.indexOf(`--${n}`); return i < 0 ? null : more[i + 1]; };
  const pid = Number(opt('pid')), waited = opt('waited'), lane = opt('lane');
  if (!['queued', 'grant', 'gave-up'].includes(event) || !LOCK_OF[cls] || !Number.isInteger(pid) || pid <= 0 || !/^\d+$/.test(waited ?? '')
    || (lane != null && !(lane === 'express' && cls === 'light' && event === 'grant'))) {
    console.error('usage: slot-lease.mjs note <queued|grant|gave-up> <class> --pid <wrapper pid> --waited <s> [--lane express]'); return 2;
  }
  logEvent({ event, kind: 'slot', key: cls, ...(lane ? { lane } : {}), ...waitNow(cls, pid, Number(waited)) });
  return 0;
}

// Headroom admission's look at a run waiting for a slot lease, with lock-admission on (admission.mjs
// grantRun): every DESK_ADMIT_RECHECK_S seconds (10) at most, a test, tsc or light run asks to be let
// in above its pool's floor, which grows the pool capacities() reports by one while it runs. It prints
// the waiting line grant gives it as grant says. In the broker's queue (`at`, the run's last place in
// it) only its oldest waiter asks, so the run admission lets in is the run the slot goes to. -> look(at),
// which returns grant's key, or null with admission off.
function headroom(cls, pid, say) {
  const every = /^[1-9]\d*$/.test(process.env.DESK_ADMIT_RECHECK_S ?? '') ? Number(process.env.DESK_ADMIT_RECHECK_S) : 10;
  const judged = ['test', 'tsc', 'light'].includes(cls);
  let last = null, said = null, saidAt = null, next = 0;
  return (at = null) => {
    if (!judged || (at && at.position > 1) || Date.now() < next) return last;
    next = Date.now() + every * 1000;
    let r = null;
    try { r = A.grantRun(E, { cls, pid, last, said, saidAt }); } catch { /* no room: the floor alone */ }
    if (!r) return null;
    last = r.key;
    if (r.say) { say(`with-lock.sh: ${r.text}`); said = r.key; saidAt = r.at; }
    return last;
  };
}

// The light lock's express lane, for a small run with the slot kind on (with-lock.sh): its lock
// directory `d`, taken for the owner `pid` as with-lock.sh's mkdir path holds it, its pid file naming
// the owner, so it is held while the owner runs. A pid file naming a live pid (with-lock.sh writes two)
// is held. -> true once taken.
function takeLane(d, pid) {
  let pids = [];
  try { pids = readFileSync(join(d, 'pid'), 'utf8').split(/\s+/).filter(Boolean).map(Number); } catch { /* none written */ }
  if (pids.some(alive) || tryLock(d) !== true) return false;
  writeFileSync(join(d, 'pid'), `${pid}\n`);
  return true;
}

// A run's place in its pool's queue (leases.mjs tryAcquire's `at`), as the waiting and gave-up lines say it.
const placeText = (at) => (at ? `position ${at.position} of ${at.waiting} in its queue, ${at.held} of ${at.capacity} slot${at.capacity === 1 ? '' : 's'} held` : null);
// What makes a run the same run when it asks again: its directory and its command.
const commandHash =(words, cwd = process.cwd()) => createHash('sha256').update([cwd, ...words].join('\0')).digest('hex').slice(0, 16);

// Takes the slot for `words` run by lock class `cls`, owned by `pid`, whose wrapper has already
// waited `waited` seconds on the lock files. Its grant, refuse or gave-up line carries its wait; a
// wait here is queued and logged as it starts. In `on` the run waits its turn in the broker's queue
// for its pool, oldest first, and says its place in it as it starts to wait and as it gives up. With
// `express` (the lane's lock directory), a run the pool refuses takes the lane where it is free and it
// is the oldest small run waiting, and the wrapper logs its grant. -> the exit code, EXIT_LANE for the lane.
function take({ cls, pid, timeout, words, waited = 0, express = null }) {
  const say = (s) => console.error(s);
  const key = cls === 'tsc' && isLint(words) ? 'lint' : cls;
  const s = `${key} ${tilde(process.cwd())}: ${words.join(' ')}`;
  const label = s.length > 160 ? `${s.slice(0, 159)}…` : s;
  const t0 = Date.now();
  const sofar = () => waited + Math.round((Date.now() - t0) / 1000);
  const look = headroom(cls, pid, say);
  const queue = { worktree: worktree(), cmd: commandHash(words), express: !!express };
  const placeFields = (at) => (at ? { position: at.position, waiting: at.waiting } : {});
  try {
    const caps = capacities(E);
    const p = poolOf('slot', key, caps);
    const what = p.pool === 'slot:heavy' ? `the heavy pool (${p.capacity} slot${p.capacity === 1 ? '' : 's'})` : p.one;
    // Shadow grants every try, so it never waits, whatever `wait` says. While a run waits, each try
    // reads the pools afresh under the store lock, after its look at headroom.
    const r = acquire({ kind: 'slot', key, units: 1, ttl: ttl(), label, pid, wait: timeout ?? Infinity, queue }, {
      env: E, caps: () => capacities(E), poll: POLL_MS, beforeTry: look,
      lane: express ? () => takeLane(express, pid) : null,
      onWait: (why, at) => {
        enqueue(key, pid);
        logEvent({ event: 'queued', kind: 'slot', key, label, ...placeFields(at), ...waitNow(key, pid, sofar()) });
        const where = placeText(at);
        if (look(at) == null) say(`with-lock.sh: waiting for ${what}${where ? `, ${where}` : ''}: ${why}`);
        else if (where) say(`with-lock.sh: waiting for ${what}, ${where}`);
      },
      note: () => { dequeue(key, pid); return waitNow(key, pid, sofar()); },
    });
    if (r.lane) return EXIT_LANE;
    if (r.code === EXIT_GAVE_UP || r.code === EXIT_REFUSED) {
      const where = placeText(r.at);
      say(`with-lock.sh: gave up waiting for ${what} after ${timeout}s${where ? ` at ${where}` : ''}: ${r.why}`);
      return EXIT_GAVE_UP;
    }
    return r.code;
  } catch (e) {
    if (e instanceof LeaseStoreError) { say(`with-lock.sh: leases were unreadable (${e.message}), so this run takes the ${cls} lock instead`); return EXIT_UNREADABLE; }
    say(`with-lock.sh: the lease broker failed (${e.message}), so this run takes the ${cls} lock instead`);
    return 1;
  } finally { dequeue(key, pid); }
}

// Who holds the test lock (with --light, the light lock instead), as suite-wait.mjs's one line, or
// nothing where nobody can be named: with-lock.sh prints it when it starts to wait on its lock files.
async function holders(rest) {
  if (rest.some((a) => a !== '--light')) { console.error('usage: slot-lease.mjs holders [--light]'); return 2; }
  const S = await import('./suite-wait.mjs');
  const dir = E.lockDir(), locks = rest.includes('--light') ? 'light' : 'test';
  const runs = S.holdersNow(dir, locks);
  if (runs.length) console.log(S.holdersText(runs));
  return 0;
}
// Exit 0 when <pid> already runs inside a test or light lock slot (suite-wait.mjs inSlot), else 1.
async function inSlot(rest) {
  const pid = Number(rest[0]);
  if (rest.length !== 1 || !Number.isInteger(pid) || pid <= 0) { console.error('usage: slot-lease.mjs in-slot <pid>'); return 2; }
  const S = await import('./suite-wait.mjs');
  const dir = E.lockDir();
  return S.inSlot(pid, { procs: S.processList(), holders: S.lockHolders(dir, { locks: 'both' }), ages: S.processAges(), stamps: S.lockHolderStamps(dir, { locks: 'both' }) }) ? 0 : 1;
}

async function cli(argv) {
  const [sub, ...rest] = argv;
  if (sub === 'mode') {
    try { console.log(kindMode('slot', E).mode); } catch { console.log('off'); }
    return 0;
  }
  if (sub === 'holders') return holders(rest);
  if (sub === 'in-slot') return inSlot(rest);
  if (sub === 'note') return note(rest);
  if (sub !== 'take') { console.error('usage: slot-lease.mjs mode | holders [--light] | in-slot <pid> | note <queued|grant|gave-up> <class> --pid <pid> --waited <s> [--lane express] | take <class> --pid <pid> [--timeout <s>] [--waited <s>] [--express <dir>] -- <command...>'); return 2; }
  const at = rest.indexOf('--');
  const head = at < 0 ? rest : rest.slice(0, at);
  const words = at < 0 ? [] : rest.slice(at + 1);
  const [cls] = head;
  const opt = (n) => { const i = head.indexOf(`--${n}`); return i < 0 ? null : head[i + 1]; };
  const pid = Number(opt('pid'));
  const timeout = opt('timeout'), waited = opt('waited'), express = opt('express');
  if (!cls || !Number.isInteger(pid) || pid <= 0 || !words.length || (timeout != null && !/^\d+$/.test(timeout)) || (waited != null && !/^\d+$/.test(waited))
    || (express != null && (cls !== 'light' || !express))) {
    console.error('usage: slot-lease.mjs take <class> --pid <pid> [--timeout <s>] [--waited <s>] [--express <dir>] -- <command...>'); return 2;
  }
  return take({ cls, pid, timeout: timeout == null ? null : Number(timeout), words, waited: waited == null ? 0 : Number(waited), express });
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) process.exit(await cli(process.argv.slice(2)));
