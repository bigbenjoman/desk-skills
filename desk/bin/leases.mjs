// Machine-wide leases: every desk process on this computer takes ports, lock slots, preview builds,
// merges and memory from one store, so none silently shares one. `desk-env lease …` runs this CLI.
//
//   <dir>/leases.json         { leases: [{ id, kind, key, pool, units, owner: { pid, start }, label,
//                               ttl, acquired, expires }] }, rewritten whole under <dir>/leases.json.lock
//   <dir>/leases.log.jsonl    one line per change: grant, refuse, gave-up, release, lapse
//
// <dir> is DESK_LEASE_DIR, else ~/.desk-autopilot/machine. A lease's owner is a pid and that process's
// start time, read inside the store lock, so a lease whose owner has exited, or whose pid now belongs
// to a later process, lapses at the next command, in the same decision as any grant it frees. The
// TTL and expiry are recorded; nothing lapses a lease for passing them yet.
//
// Exit codes: 0 granted (or released, or already gone), 2 usage, 3 refused, 4 store unreadable,
// 75 gave up waiting (with-lock.sh's code).
import { appendFileSync, existsSync, readFileSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lock, sleepSync, unlock, writeJsonAtomic } from './dir-lock.mjs';
import { HOME, expandHome, machineValue, testLockSlots } from './desk-env.mjs';

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;
export const EXIT_UNREADABLE = 4;
export const EXIT_GAVE_UP = 75;
export const KINDS = Object.freeze(['port', 'slot', 'preview-build', 'merge', 'mem']);
// test, tsc and lint share the heavy pool; browser and light are one slot each.
export const SLOTS = Object.freeze({ test: 'heavy', tsc: 'heavy', lint: 'heavy', browser: 'browser', light: 'light' });
// No operation holds the store lock for more than a second, so one this old was left by a holder that
// died, whatever process its pid names now.
export const STORE_LOCK_MAX_AGE_MS = 10_000;
const STORE_LOCK_WAIT_MS = 15_000;
const POLL_MS = 250;

export class LeaseUsageError extends Error {}
export class LeaseStoreError extends Error {}
const usage = (m) => new LeaseUsageError(m);

export const leaseDir = () => expandHome(process.env.DESK_LEASE_DIR || join(HOME, '.desk-autopilot', 'machine'));
export const storeFile = (dir = leaseDir()) => join(dir, 'leases.json');
export const logFile = (dir = leaseDir()) => join(dir, 'leases.log.jsonl');

const whole = (v) => (/^\d+$/.test(String(v ?? '').trim()) && Number(v) > 0 ? Number(v) : null);
// The pools' sizes: the heavy slots as the test lock has them (testLockSlots), preview builds per
// Vercel team from preview-build-slots, memory from memory-ceiling-gb.
export const capacities = () => ({
  heavy: testLockSlots(),
  previewBuild: whole(machineValue('preview-build-slots')) ?? 1,
  mem: whole(machineValue('memory-ceiling-gb')),
});

// The pool a lease of `kind` on `key` draws from: { pool, key, capacity, one, many }, `one` naming it
// when it holds one unit and `many` its units when it holds more.
export function poolOf(kind, key, caps = capacities()) {
  const k = String(key ?? '').trim();
  if (!KINDS.includes(kind)) throw usage(`unknown lease kind "${kind ?? ''}": want one of ${KINDS.join(', ')}`);
  if (!k) throw usage(`a ${kind} lease needs a key`);
  switch (kind) {
    case 'port': {
      const n = whole(k);
      if (!n || n > 65535) throw usage(`a port lease's key is a port number from 1 to 65535, not "${k}"`);
      return { pool: `port:${n}`, key: String(n), capacity: 1, one: `port ${n}`, many: `leases on port ${n}` };
    }
    case 'slot': {
      const p = SLOTS[k];
      if (!p) throw usage(`a slot lease's key is one of ${Object.keys(SLOTS).join(', ')}, not "${k}"`);
      return p === 'heavy'
        ? { pool: 'slot:heavy', key: k, capacity: caps.heavy, one: 'the heavy slot', many: 'heavy slots' }
        : { pool: `slot:${p}`, key: k, capacity: 1, one: `the ${p} slot`, many: `${p} slots` };
    }
    case 'preview-build':
      return { pool: `preview-build:${k}`, key: k, capacity: caps.previewBuild, one: `the preview-build slot for ${k}`, many: `preview-build slots for ${k}` };
    case 'merge':
      if (!/^[\w.-]+\/[\w.-]+@\S+$/.test(k)) throw usage(`a merge lease's key is <owner>/<repo>@<base>, not "${k}"`);
      return { pool: `merge:${k}`, key: k, capacity: 1, one: `merges into ${k}`, many: `merges into ${k}` };
    default: // mem
      if (caps.mem == null) throw usage("a mem lease needs the machine profile's memory-ceiling-gb, which is unset (desk-env machine get memory-ceiling-gb)");
      return { pool: 'mem', key: k, capacity: caps.mem, one: '1 GiB of memory', many: 'GiB of memory' };
  }
}

// Each pid's process start time, or null for one not running (a zombie counts as exited): from /proc
// on Linux, from one ps call for them all elsewhere. -> Map pid -> start.
export function startTimes(pids) {
  const want = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  const out = new Map(want.map((p) => [p, null]));
  if (!want.length) return out;
  if (existsSync('/proc/self/stat')) {
    for (const p of want) {
      try {
        const s = readFileSync(`/proc/${p}/stat`, 'utf8');
        const f = s.slice(s.lastIndexOf(')') + 2).split(' '); // f[0] is field 3, the state
        if (f[0] !== 'Z') out.set(p, f[19]); // field 22, starttime
      } catch { /* not running */ }
    }
    return out;
  }
  let text;
  try {
    // lstart prints local time, so it is read in UTC and the C locale (as hooks/desk-handoff.py
    // does): a command run under another TZ must read the same string for the same process.
    text = execFileSync('ps', ['-o', 'pid=,stat=,lstart=', '-p', want.join(',')], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', TZ: 'UTC0' }, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    if (e.status !== 1) throw new Error(`could not read process start times with ps: ${e.message}`);
    text = String(e.stdout ?? ''); // ps exits 1 when some pid is not running
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (m && out.has(Number(m[1])) && !m[2].startsWith('Z')) out.set(Number(m[1]), m[3]);
  }
  return out;
}

export function readStore(file = storeFile()) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { leases: [] };
    throw new LeaseStoreError(`the lease store ${file} is unreadable: ${e.message}`);
  }
  let s;
  try { s = JSON.parse(raw); } catch (e) { throw new LeaseStoreError(`the lease store ${file} is unreadable: ${e.message}`); }
  const ok = (l) => l && typeof l.id === 'string' && typeof l.pool === 'string' && Number.isInteger(l.owner?.pid) && Number.isInteger(l.units);
  if (!s || !Array.isArray(s.leases) || !s.leases.every(ok)) throw new LeaseStoreError(`the lease store ${file} is unreadable: it is not { leases: [...] } with an id, pool, units and owner pid on each`);
  return s;
}

// fn(store, log) reads and changes the store under its lock; the store is written after if it changed,
// and each entry fn logged is appended with how long the lock was held. -> fn's result.
export function withStore(dir, fn) {
  const file = storeFile(dir);
  const lockDir = `${file}.lock`;
  lock(lockDir, { waitMs: STORE_LOCK_WAIT_MS, maxAgeMs: STORE_LOCK_MAX_AGE_MS,
    timeout: (pid) => new LeaseStoreError(`the lease store lock ${lockDir} is held by pid ${pid ?? '?'} past the ${STORE_LOCK_WAIT_MS / 1000}s wait`) });
  const t0 = performance.now();
  try {
    const store = readStore(file);
    const was = JSON.stringify(store);
    const entries = [];
    const out = fn(store, (e) => entries.push(e));
    if (JSON.stringify(store) !== was) writeJsonAtomic(file, store);
    const hold = Math.round(performance.now() - t0);
    if (entries.length) appendFileSync(logFile(dir), entries.map((e) => `${JSON.stringify({ at: new Date().toISOString(), ...e, hold_ms: hold })}\n`).join(''));
    return out;
  } finally { unlock(lockDir); }
}

const brief = (l) => ({ id: l.id, kind: l.kind, key: l.key, units: l.units, owner: l.owner, label: l.label });

// Drops every lease whose owner is not the process that took it, logging each as a lapse. `starts`
// holds the start times read for the owners (startTimes).
function sweep(store, log, starts) {
  store.leases = store.leases.filter((l) => {
    const now = starts.get(l.owner.pid);
    if (now != null && now === l.owner.start) return true;
    log({ event: 'lapse', ...brief(l), why: 'owner exited', ...(now != null ? { detail: `pid ${l.owner.pid} now belongs to a process started ${now}` } : {}) });
    return false;
  });
}
const ownerStarts = (store, more = []) => startTimes([...store.leases.map((l) => l.owner.pid), ...more]);

const holderText = (l) => `${l.label} (pid ${l.owner.pid}, lease ${l.id}${l.units > 1 ? `, ${l.units} units` : ''})`;
// Why an acquire of `units` from pool `p` is refused, with `holders` holding `held` units of it.
export function refusal(p, units, holders, held) {
  const who = holders.map(holderText).join('; ');
  if (p.capacity === 1) return `${p.one} is held by ${who}`;
  if (held >= p.capacity) return `all ${p.capacity} ${p.many} are held: ${who}`;
  return `${held} of ${p.capacity} ${p.many} are held, and this asks for ${units}: ${who}`;
}

// One try at a lease. req: { kind, key, units, ttl, label, pid, final, waited }; a refused try is
// logged only when `final` (a refuse with no wait, else gave-up). -> { lease } or { refused: why }.
export function tryAcquire(req, { dir = leaseDir(), caps = capacities(), now = Date.now } = {}) {
  const p = poolOf(req.kind, req.key, caps);
  if (req.units > p.capacity) throw usage(`this asks for ${req.units} of ${p.many}, more than the ${p.capacity} there are`);
  return withStore(dir, (store, log) => {
    const starts = ownerStarts(store, [req.pid]);
    sweep(store, log, starts);
    const start = starts.get(req.pid);
    if (start == null) throw usage(`the owner pid ${req.pid} is not running`);
    const holders = store.leases.filter((l) => l.pool === p.pool);
    const held = holders.reduce((n, l) => n + l.units, 0);
    if (held + req.units <= p.capacity) {
      const t = now();
      const lease = { id: `L-${randomBytes(5).toString('hex')}`, kind: req.kind, key: p.key, pool: p.pool, units: req.units,
        owner: { pid: req.pid, start }, label: req.label, ttl: req.ttl, acquired: new Date(t).toISOString(), expires: new Date(t + req.ttl * 1000).toISOString() };
      store.leases.push(lease);
      log({ event: 'grant', ...brief(lease), ttl: lease.ttl, expires: lease.expires });
      return { lease };
    }
    const why = refusal(p, req.units, holders, held);
    if (req.final) log({ event: req.waited ? 'gave-up' : 'refuse', kind: req.kind, key: p.key, units: req.units, owner: { pid: req.pid, start }, label: req.label, why, ...(req.waited ? { wait_s: req.waited } : {}) });
    return { refused: why };
  });
}

// Takes a lease, waiting up to `wait` seconds for it. -> { code, lease?, why? }.
export function acquire(req, { dir = leaseDir(), caps = capacities(), now = Date.now } = {}) {
  const wait = req.wait ?? 0;
  const until = now() + wait * 1000;
  for (;;) {
    const final = now() >= until;
    const r = tryAcquire({ ...req, final, waited: wait }, { dir, caps, now });
    if (r.lease) return { code: EXIT_OK, lease: r.lease };
    if (final) return wait ? { code: EXIT_GAVE_UP, why: `gave up after ${wait}s waiting: ${r.refused}` } : { code: EXIT_REFUSED, why: `refused: ${r.refused}` };
    sleepSync(Math.max(1, Math.min(POLL_MS, until - now())));
  }
}

// Gives back lease `id`, which only its owner (`pid`) may. -> { code, why }.
export function release(id, pid, { dir = leaseDir() } = {}) {
  return withStore(dir, (store, log) => {
    sweep(store, log, ownerStarts(store));
    const l = store.leases.find((x) => x.id === id);
    if (!l) return { code: EXIT_OK, why: `lease ${id} was already gone` };
    if (l.owner.pid !== pid) return { code: EXIT_REFUSED, why: `refused: lease ${id} is held by pid ${l.owner.pid}, and only its owner releases it` };
    store.leases = store.leases.filter((x) => x !== l);
    log({ event: 'release', ...brief(l) });
    return { code: EXIT_OK, why: `released ${l.kind} ${l.key} (lease ${id})` };
  });
}

// The live leases, after lapsing those whose owner has gone.
export function list({ dir = leaseDir() } = {}) {
  return withStore(dir, (store, log) => {
    sweep(store, log, ownerStarts(store));
    return store.leases;
  });
}
export const listRow = (l) => [l.id, l.kind, l.key, l.units, `pid ${l.owner.pid}`, l.label, `${l.ttl}s`, l.acquired, l.expires].join('\t');
const LIST_HEAD = ['ID', 'KIND', 'KEY', 'UNITS', 'OWNER', 'LABEL', 'TTL', 'ACQUIRED', 'EXPIRES'].join('\t');
const listJson = (l) => JSON.stringify({ id: l.id, kind: l.kind, key: l.key, units: l.units, owner: l.owner, label: l.label, ttl: l.ttl, acquired: l.acquired, expires: l.expires });

export const LEASE_USAGE = `usage: desk-env lease acquire <kind> <key> --ttl <seconds> [--units <n>] [--wait <seconds>] [--label <text>] [--pid <owner pid>]
       desk-env lease release <lease id> [--pid <owner pid>]
       desk-env lease list [--json]
kinds: port <number> | slot ${Object.keys(SLOTS).join('|')} | preview-build <vercel team> | merge <owner>/<repo>@<base> | mem <what for> (units in GiB)
The owner is the calling process unless --pid names it; its lease lapses when it exits.`;

// Parses `args` into positionals and the options `takes` names (value options; `flags` take none).
function parseArgs(args, takes, flags = []) {
  const pos = []; const opt = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const eq = a.indexOf('=');
    const name = a.slice(2, eq > 0 ? eq : undefined);
    if (flags.includes(name) && eq < 0) { opt[name] = true; continue; }
    if (!takes.includes(name)) throw usage(`unknown option --${name}`);
    const v = eq > 0 ? a.slice(eq + 1) : args[++i];
    if (v == null) throw usage(`--${name} needs a value`);
    opt[name] = v;
  }
  return { pos, opt };
}
const ownerPid = (v) => {
  if (v == null) return process.ppid;
  const n = whole(v);
  if (!n) throw usage(`--pid is a process id, not "${v}"`);
  return n;
};

// The CLI: prints what happened and returns the exit code.
export function leaseCli(args, { dir = leaseDir(), out = (s) => console.log(s), err = (s) => console.error(s) } = {}) {
  const [sub, ...rest] = args;
  try {
    if (sub === 'acquire') {
      const { pos, opt } = parseArgs(rest, ['ttl', 'units', 'wait', 'label', 'pid']);
      const [kind, key, extra] = pos;
      if (extra != null) throw usage(`acquire takes a kind and a key, not "${extra}"`);
      poolOf(kind, key); // a bad kind or key is named before a missing --ttl
      if (opt.ttl == null) throw usage('acquire needs --ttl <seconds>');
      const ttl = whole(opt.ttl);
      if (!ttl) throw usage(`--ttl is a whole number of seconds, 1 or more, not "${opt.ttl}"`);
      const units = opt.units == null ? 1 : whole(opt.units);
      if (!units) throw usage(`--units is a whole number, 1 or more, not "${opt.units}"`);
      if (opt.wait != null && !/^\d+(\.\d+)?$/.test(opt.wait)) throw usage(`--wait is a number of seconds, not "${opt.wait}"`);
      const wait = opt.wait == null ? 0 : Number(opt.wait);
      const r = acquire({ kind, key, units, ttl, wait, label: String(opt.label ?? '').trim() || 'unlabelled', pid: ownerPid(opt.pid) }, { dir });
      if (r.lease) out(r.lease.id); else err(r.why);
      return r.code;
    }
    if (sub === 'release') {
      const { pos, opt } = parseArgs(rest, ['pid']);
      if (pos.length !== 1) throw usage('release takes one lease id');
      const r = release(pos[0], ownerPid(opt.pid), { dir });
      (r.code === EXIT_OK ? out : err)(r.why);
      return r.code;
    }
    if (sub === 'list') {
      const { pos, opt } = parseArgs(rest, [], ['json']);
      if (pos.length) throw usage(`list takes no arguments, not "${pos[0]}"`);
      const leases = list({ dir });
      if (opt.json) for (const l of leases) out(listJson(l));
      else if (!leases.length) out('no leases');
      else { out(LIST_HEAD); for (const l of leases) out(listRow(l)); }
      return EXIT_OK;
    }
    throw usage(sub ? `unknown lease command "${sub}"` : 'which lease command?');
  } catch (e) {
    if (e instanceof LeaseUsageError) { err(`desk-env lease: ${e.message}`); err(LEASE_USAGE); return EXIT_USAGE; }
    if (e instanceof LeaseStoreError) { err(`desk-env lease: ${e.message}`); return EXIT_UNREADABLE; }
    throw e;
  }
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (isMain) process.exit(leaseCli(process.argv.slice(2)));
