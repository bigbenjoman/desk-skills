// with-lock.sh's lease client: the slot a test, tsc, lint, browser or light run takes from the
// machine's lease broker (leases.mjs), behind the `slot` kind's lever (desk-env lease mode slot).
//
//   node slot-lease.mjs mode                                  # off, shadow or on: the slot kind's mode
//   node slot-lease.mjs take <class> --pid <owner> [--timeout <s>] -- <command...>
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
import { EXIT_GAVE_UP, EXIT_OK, EXIT_UNREADABLE, LeaseStoreError, SLOTS, capacities, kindMode, leaseDir, poolOf, tryAcquire } from './leases.mjs';

const POLL_MS = 2000;
// A slot lease's TTL. Its owner's exit, not its TTL, ends it (leases.mjs exempts a slot lease with a
// live owner from lapsing), so this only dates it. DESK_SLOT_LEASE_TTL sets it for a test fixture.
const ttl = () => (/^\d+$/.test(process.env.DESK_SLOT_LEASE_TTL ?? '') && Number(process.env.DESK_SLOT_LEASE_TTL) > 0 ? Number(process.env.DESK_SLOT_LEASE_TTL) : 600);
// The linters a worker runs as a node_modules binary under `with-lock.sh tsc` (the worker contract's
// command forms), each read by its file name.
const LINTERS = new Set(['eslint', 'biome', 'oxlint', 'stylelint']);

// Whether `words` is a lint: a linter binary, or a §4 Lint item with or without arguments added (the
// pre-push hook's rule for which items take the lock). A lint run under `tsc` holds a `lint` slot.
export function isLint(words, lintItems = []) {
  if (LINTERS.has(basename(words[0] ?? ''))) return true;
  const line = words.join(' ');
  return lintItems.some((c) => line === c || line.startsWith(`${c} `));
}
// This repo's §4 Lint commands, without their directories; [] with no config or row.
function lintItems() {
  try {
    const v = E.configValues('lint-cmd');
    return v == null || E.isNone(v) ? [] : v.map((x) => E.parseCommandItem(x).cmd);
  } catch { return []; }
}
// The slot key a run of lock class `cls` takes: the class, except a lint run under `tsc`.
export const slotKey = (cls, words, lints = lintItems) => (cls === 'tsc' && isLint(words, lints()) ? 'lint' : cls);
// The lease's label: the key, where it runs and what, cut to 160 characters.
export function label(key, cwd, words) {
  const s = `${key} ${tilde(cwd)}: ${words.join(' ')}`;
  return s.length > 160 ? `${s.slice(0, 159)}…` : s;
}

// Takes the slot for `words` run by lock class `cls`, owned by `pid`. `say` prints a line to stderr.
// -> the exit code.
export function take({ cls, pid, timeout = null, words, cwd = process.cwd(), env = E, dir = leaseDir(), say = (s) => console.error(s), now = Date.now, sleep = sleepMs }) {
  const key = slotKey(cls, words);
  if (!SLOTS[key]) { say(`with-lock.sh: no slot lease for the ${cls} lock`); return 1; }
  const { mode } = kindMode('slot', env);
  if (mode === 'off') return EXIT_OK;
  const req = { kind: 'slot', key, units: 1, ttl: ttl(), label: label(key, cwd, words), pid };
  try {
    const caps = capacities(env);
    const p = poolOf('slot', key, caps);
    if (mode === 'shadow') { tryAcquire({ ...req, final: true }, { env, dir, caps, mode }); return EXIT_OK; }
    const until = timeout == null ? Infinity : now() + timeout * 1000;
    const what = p.pool === 'slot:heavy' ? `the heavy pool (${p.capacity} slot${p.capacity === 1 ? '' : 's'})` : p.one;
    let said = false;
    for (;;) {
      const final = now() >= until;
      const r = tryAcquire({ ...req, final, waited: timeout ?? 0 }, { env, dir, caps, mode });
      if (r.lease) return EXIT_OK;
      if (final) { say(`with-lock.sh: gave up waiting for ${what} after ${timeout}s: ${r.refused}`); return EXIT_GAVE_UP; }
      if (!said) { say(`with-lock.sh: waiting for ${what}: ${r.refused}`); said = true; }
      sleep(Math.max(1, Math.min(POLL_MS, until - now())));
    }
  } catch (e) {
    if (e instanceof LeaseStoreError) { say(`with-lock.sh: leases were unreadable (${e.message}), so this run takes the ${cls} lock instead`); return EXIT_UNREADABLE; }
    say(`with-lock.sh: the lease broker failed (${e.message}), so this run takes the ${cls} lock instead`);
    return 1;
  }
}

const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export function cli(argv) {
  const [sub, ...rest] = argv;
  if (sub === 'mode') {
    try { console.log(kindMode('slot', E).mode); } catch { console.log('off'); }
    return 0;
  }
  if (sub !== 'take') { console.error('usage: slot-lease.mjs mode | take <class> --pid <pid> [--timeout <s>] -- <command...>'); return 2; }
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
if (isMain) process.exit(cli(process.argv.slice(2)));
