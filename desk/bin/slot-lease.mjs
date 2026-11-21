// with-lock.sh's lease client: the slot a test, tsc, browser or light run takes from the machine's
// lease broker (leases.mjs), behind the `slot` kind's lever (desk-env lease mode slot). A lint, which
// runs under `tsc`, is told apart and holds a `lint` slot.
//
//   node slot-lease.mjs mode                                  # off, shadow or on: the slot kind's mode
//   node slot-lease.mjs take <class> --pid <owner> [--timeout <s>] -- <command...>
//   node slot-lease.mjs holders [--light]                     # who holds the test (or light) lock, one line
//   node slot-lease.mjs in-slot <pid>                         # exit 0 when <pid> runs inside a test or light slot
//
// `take` names the lease's owner (the wrapper's own pid, which then execs into the command, or the
// command's pid where the wrapper runs it as a child), so the lease is held for as long as the command
// runs and lapses the moment it exits. In `on` it waits for the slot, saying once what it waits on and
// who holds it, and gives up after --timeout seconds (exit 75). In `shadow` it makes one try, which
// shadow always grants, logging a would-refuse when the pool was full; the wrapper has already taken
// its legacy lock and ignores how this ends.
//
// Exit codes: 0 granted (or nothing to take), 75 gave up waiting, 4 the lease store is unreadable,
// 1 the broker failed otherwise. The wrapper falls back to its legacy lock on 4 and 1.
import { realpathSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as E from './desk-env.mjs';
import { tilde } from './logins.mjs';
import { EXIT_GAVE_UP, EXIT_OK, EXIT_REFUSED, EXIT_UNREADABLE, LeaseStoreError, acquire, capacities, kindMode, poolOf } from './leases.mjs';

// How often a run waiting in `on` tries again: each try reads the process table.
const POLL_MS = 2000;
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

// Takes the slot for `words` run by lock class `cls`, owned by `pid`. -> the exit code.
function take({ cls, pid, timeout, words }) {
  const say = (s) => console.error(s);
  const key = cls === 'tsc' && isLint(words) ? 'lint' : cls;
  const s = `${key} ${tilde(process.cwd())}: ${words.join(' ')}`;
  const label = s.length > 160 ? `${s.slice(0, 159)}…` : s;
  try {
    const caps = capacities(E);
    const p = poolOf('slot', key, caps);
    const what = p.pool === 'slot:heavy' ? `the heavy pool (${p.capacity} slot${p.capacity === 1 ? '' : 's'})` : p.one;
    // Shadow grants every try, so it never waits, whatever `wait` says.
    const r = acquire({ kind: 'slot', key, units: 1, ttl: ttl(), label, pid, wait: timeout ?? Infinity }, {
      env: E, caps, poll: POLL_MS, onWait: (why) => say(`with-lock.sh: waiting for ${what}: ${why}`),
    });
    if (r.code === EXIT_GAVE_UP || r.code === EXIT_REFUSED) { say(`with-lock.sh: gave up waiting for ${what} after ${timeout}s: ${r.why}`); return EXIT_GAVE_UP; }
    return r.code;
  } catch (e) {
    if (e instanceof LeaseStoreError) { say(`with-lock.sh: leases were unreadable (${e.message}), so this run takes the ${cls} lock instead`); return EXIT_UNREADABLE; }
    say(`with-lock.sh: the lease broker failed (${e.message}), so this run takes the ${cls} lock instead`);
    return 1;
  }
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
  if (sub !== 'take') { console.error('usage: slot-lease.mjs mode | holders [--light] | in-slot <pid> | take <class> --pid <pid> [--timeout <s>] -- <command...>'); return 2; }
  const at = rest.indexOf('--');
  const head = at < 0 ? rest : rest.slice(0, at);
  const words = at < 0 ? [] : rest.slice(at + 1);
  const [cls] = head;
  const opt = (n) => { const i = head.indexOf(`--${n}`); return i < 0 ? null : head[i + 1]; };
  const pid = Number(opt('pid'));
  const timeout = opt('timeout');
  if (!cls || !Number.isInteger(pid) || pid <= 0 || !words.length || (timeout != null && !/^\d+$/.test(timeout))) {
    console.error('usage: slot-lease.mjs take <class> --pid <pid> [--timeout <s>] -- <command...>'); return 2;
  }
  return take({ cls, pid, timeout: timeout == null ? null : Number(timeout), words });
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) process.exit(await cli(process.argv.slice(2)));
