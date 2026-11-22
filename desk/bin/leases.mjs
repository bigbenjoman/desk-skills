// Machine-wide leases: every desk process on this computer takes ports, lock slots, preview builds,
// merges and memory from one store, so none silently shares one. `desk-env lease …` runs this CLI.
//
//   <dir>/leases.json         { leases: [{ id, kind, key, pool, units, owner: { pid, start } | null,
//                               label, ttl, acquired, renewed?, expires }] }, rewritten whole under
//                               <dir>/leases.json.lock
//   <dir>/leases.log.jsonl    one line per change: grant, would-refuse, refuse, gave-up, renew,
//                               re-create, release, force-release, lapse, reset, trial (a restart of
//                               the shadow kinds' trial, trialOf)
//
// <dir> is DESK_LEASE_DIR, else ~/.desk-autopilot/machine. A lease's owner is a pid and that process's
// start time, read inside the store lock, so a lease whose owner has exited, or whose pid now belongs
// to a later process, lapses at the next command, in the same decision as any grant it frees.
//
// Expiry: a lease expires its TTL after it was taken or last renewed. A live owner that has not
// renewed gets one more TTL of grace and lapses at twice its TTL (a "hard lapse"), so a Mac that wakes
// renews before anyone takes its leases while a hung holder still frees its key. A slot lease is
// exempt while its owner lives: the lock wrapper execs its command and nothing renews it. A lease
// with no owner (a preview build, which runs on Vercel after its worker exits) lapses at its expiry.
//
// Each kind is off, shadow or on (the machine profile's lease-kinds row; unnamed kinds are shadow):
// off takes nothing, shadow grants what on would refuse and logs a would-refuse, on refuses.
//
// Exit codes: 0 granted (or released, or already gone, or the kind is off), 2 usage, 3 refused,
// 4 store unreadable, 75 gave up waiting (with-lock.sh's code).
//
// This module imports nothing from desk-env.mjs: desk-env's CLI imports it at run time, and a cycle
// through desk-env's top-level await never settles (node exits 13). What it needs from desk-env
// (machineValue, testLockSlots, psRows) is passed in as `env`: desk-env passes its own, and this
// file's CLI imports desk-env itself.
import { appendFileSync, existsSync, readFileSync, realpathSync, renameSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lock, sleepSync, unlock, writeJsonAtomic } from './dir-lock.mjs';
import { DEFAULT_LEASE_MODE, LEASE_KINDS, leaseKindsProblem, parseLeaseKinds } from './machine.mjs';

const HOME = process.env.HOME || homedir();
const expandHome = (p) => p.replace(/^~(?=\/|$)/, HOME);

export const EXIT_OK = 0;
export const EXIT_USAGE = 2;
export const EXIT_REFUSED = 3;
export const EXIT_UNREADABLE = 4;
export const EXIT_GAVE_UP = 75;
export const KINDS = LEASE_KINDS;
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
// Vercel team from preview-build-slots, memory from memory-ceiling-gb. `env` is desk-env's exports.
export const capacities = (env) => ({
  heavy: env.testLockSlots(),
  previewBuild: whole(env.machineValue('preview-build-slots')) ?? 1,
  mem: whole(env.machineValue('memory-ceiling-gb')),
});
// The same for a kind that is off, which takes nothing: only the key's form is checked, so a mem
// lease is not refused for a memory ceiling it would never draw on.
const offCaps = (caps) => ({ ...caps, mem: caps.mem ?? Infinity });

// A kind's mode from the machine profile's lease-kinds row: off, shadow or on. -> { mode, problem },
// `problem` naming any entry the row holds that it does not know (null when none).
export function kindMode(kind, env) {
  const raw = env.machineValue('lease-kinds');
  if (raw == null) return { mode: DEFAULT_LEASE_MODE, problem: null };
  return { mode: parseLeaseKinds(raw).modes[kind] ?? DEFAULT_LEASE_MODE, problem: leaseKindsProblem(raw) };
}

// The pool a lease of `kind` on `key` draws from: { pool, key, capacity, one, many }, `one` naming it
// when it holds one unit and `many` its units when it holds more. `caps` is capacities().
export function poolOf(kind, key, caps) {
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
// on Linux, from one ps read (`psRows`, desk-env's) for them all elsewhere. -> Map pid -> start.
export function startTimes(pids, psRows) {
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
  // lstart prints local time, so it is read in UTC and the C locale (as hooks/desk-handoff.py
  // does): a command run under another TZ must read the same string for the same process.
  for (const r of psRows('pid=,stat=,lstart=', { LC_ALL: 'C', TZ: 'UTC0' })) {
    if (out.has(r.pid) && !r.stat.startsWith('Z')) out.set(r.pid, r.lstart);
  }
  return out;
}

// A process that is a Claude Code session: the claude binary, or node running the Claude Code CLI as
// its script, named by its entry point or by the `claude` link an npm install puts on the PATH (a
// `#!/usr/bin/env node` script shows in ps as `node <the link's path>`). `args` is ps's args column,
// which joins argv with spaces, so the script's path is matched across them: an npm prefix may hold one.
const CLAUDE_ENTRY = /(^|\/)@anthropic-ai\/claude-code\/cli\.m?js(\s|$)/;
const CLAUDE_LINK = /^(\S.*?\/)?claude(\s|$)/;
const isClaudeProcess = (args) => {
  const words = String(args ?? '').trim().split(/\s+/);
  if (basename(words[0] ?? '') === 'claude') return true;
  if (!/^node(js)?$/.test(basename(words[0] ?? ''))) return false;
  const at = words.findIndex((w, i) => i > 0 && !w.startsWith('-'));
  if (at < 0) return false;
  const script = words.slice(at).join(' ');
  return CLAUDE_ENTRY.test(script) || CLAUDE_LINK.test(script);
};
// The nearest ancestor of `pid` that is a Claude Code session, or null. `rows` is
// psRows('pid=,ppid=,args=').
export function claudeAncestor(rows, pid) {
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const seen = new Set();
  for (let p = byPid.get(pid)?.ppid; p > 1 && !seen.has(p); p = byPid.get(p)?.ppid) {
    seen.add(p);
    const r = byPid.get(p);
    if (!r) return null;
    if (isClaudeProcess(r.args)) return p;
  }
  return null;
}

export function readStore(file = storeFile()) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { leases: [] };
    throw new LeaseStoreError(`the lease store ${file} is unreadable: ${e.message}`);
  }
  let s;
  try { s = JSON.parse(raw); } catch (e) { throw new LeaseStoreError(`the lease store ${file} is unreadable: ${e.message}`); }
  const ok = (l) => l && typeof l.id === 'string' && typeof l.pool === 'string' && Number.isInteger(l.units)
    && (l.owner === null || Number.isInteger(l.owner?.pid));
  if (!s || !Array.isArray(s.leases) || !s.leases.every(ok)) throw new LeaseStoreError(`the lease store ${file} is unreadable: it is not { leases: [...] } with an id, pool, units and owner on each`);
  return s;
}

const lockStore = (dir) => {
  const lockDir = `${storeFile(dir)}.lock`;
  lock(lockDir, { waitMs: STORE_LOCK_WAIT_MS, maxAgeMs: STORE_LOCK_MAX_AGE_MS,
    timeout: (pid) => new LeaseStoreError(`the lease store lock ${lockDir} is held by pid ${pid ?? '?'} past the ${STORE_LOCK_WAIT_MS / 1000}s wait`) });
  return lockDir;
};
const appendLog = (dir, entries, hold) => {
  if (entries.length) appendFileSync(logFile(dir), entries.map((e) => `${JSON.stringify({ at: new Date().toISOString(), ...e, hold_ms: hold })}\n`).join(''));
};

// fn(store, log) reads and changes the store under its lock; the store is written after if it changed,
// and each entry fn logged is appended with how long the lock was held. -> fn's result.
export function withStore(dir, fn) {
  const file = storeFile(dir);
  const lockDir = lockStore(dir);
  const t0 = performance.now();
  try {
    const store = readStore(file);
    const was = JSON.stringify(store);
    const entries = [];
    const out = fn(store, (e) => entries.push(e));
    if (JSON.stringify(store) !== was) writeJsonAtomic(file, store);
    appendLog(dir, entries, Math.round(performance.now() - t0));
    return out;
  } finally { unlock(lockDir); }
}

const brief = (l) => ({ id: l.id, kind: l.kind, key: l.key, units: l.units, owner: l.owner, label: l.label });

// Why lease `l` has lapsed at `t`, or null while it holds. `starts` holds the start times read for
// the owners (startTimes).
function lapseOf(l, starts, t) {
  const expires = Date.parse(l.expires);
  if (l.owner === null) return t > expires ? { why: 'TTL passed', detail: `no owner, and its ${l.ttl}s TTL passed at ${l.expires}` } : null;
  const now = starts.get(l.owner.pid);
  if (now == null || now !== l.owner.start) return { why: 'owner exited', ...(now != null ? { detail: `pid ${l.owner.pid} now belongs to a process started ${now}` } : {}) };
  if (l.kind !== 'slot' && t > expires + l.ttl * 1000) return { why: 'hard lapse', detail: `pid ${l.owner.pid} is alive but has not renewed it in twice its ${l.ttl}s TTL` };
  return null;
}
// Drops every lease that has lapsed, logging each, and adding each to `lapsed` when given.
function sweep(store, log, starts, t, lapsed = null) {
  store.leases = store.leases.filter((l) => {
    const gone = lapseOf(l, starts, t);
    if (gone) { log({ event: 'lapse', ...brief(l), ...gone }); lapsed?.push({ ...brief(l), ...gone }); }
    return !gone;
  });
}
const ownerStarts = (store, env, more = []) => startTimes([...store.leases.flatMap((l) => (l.owner ? [l.owner.pid] : [])), ...more], env.psRows);

const holderText = (l) => `${l.label} (${l.owner ? `pid ${l.owner.pid}` : 'no owner'}, lease ${l.id}${l.units > 1 ? `, ${l.units} units` : ''})`;
// Why an acquire of `units` from pool `p` is refused, with `holders` holding `held` units of it.
export function refusal(p, units, holders, held) {
  const who = holders.map(holderText).join('; ');
  if (p.capacity === 1) return `${p.one} is held by ${who}`;
  if (held >= p.capacity) return `all ${p.capacity} ${p.many} are held: ${who}`;
  return `${held} of ${p.capacity} ${p.many} are held, and this asks for ${units}: ${who}`;
}

const newLease = (req, p, owner, t, id = `L-${randomBytes(5).toString('hex')}`) => ({ id, kind: req.kind, key: p.key, pool: p.pool, units: req.units,
  owner, label: req.label, ttl: req.ttl, acquired: new Date(t).toISOString(), expires: new Date(t + req.ttl * 1000).toISOString() });

// Places a lease in pool `p` under the store lock, as a grant (`event` 'grant') or a renew's
// re-create. Over capacity it is refused, or in shadow granted with a would-refuse logged naming
// every holder. -> { lease, shadow? } or { refused }.
function place(store, log, req, p, owner, t, { mode, final, waited, id, event = 'grant' }) {
  const holders = store.leases.filter((l) => l.pool === p.pool);
  const held = holders.reduce((n, l) => n + l.units, 0);
  const fits = held + req.units <= p.capacity;
  const why = fits ? null : refusal(p, req.units, holders, held);
  if (!fits && mode !== 'shadow') {
    if (final) log({ event: waited ? 'gave-up' : 'refuse', kind: req.kind, key: p.key, units: req.units, owner, label: req.label, why, ...(waited ? { wait_s: waited } : {}) });
    return { refused: why };
  }
  const lease = newLease(req, p, owner, t, id);
  if (!fits) log({ event: 'would-refuse', kind: req.kind, key: p.key, units: req.units, owner, label: req.label, holders: holders.map(brief), why });
  store.leases.push(lease);
  log({ event, ...brief(lease), ttl: lease.ttl, expires: lease.expires });
  return fits ? { lease } : { lease, shadow: why };
}

// The owner a request names: { pid } for a process, or null for none (`pid` null).
function ownerOf(req, starts) {
  if (req.pid == null) return null;
  const start = starts.get(req.pid);
  if (start == null) throw usage(`the owner pid ${req.pid} is not running`);
  return { pid: req.pid, start };
}

// The live ownerless lease in pool `p` that a request with no owner and the same label already holds:
// one PR's preview builds take one unit however many pushes or reruns start them.
const sameHolder = (store, req, p) => (req.pid == null && req.label && req.label !== 'unlabelled'
  ? store.leases.find((l) => l.pool === p.pool && l.owner === null && l.label === req.label) : null);

// One try at a lease. req: { kind, key, units, ttl, label, pid (null: no owner), final, waited };
// a refused try is logged only when `final` (a refuse with no wait, else gave-up). An ownerless
// request whose label a live ownerless lease of the pool holds renews that lease instead. `env` is
// desk-env's exports. -> { lease, shadow? } or { refused: why }.
export function tryAcquire(req, { env, dir = leaseDir(), caps = capacities(env), now = Date.now, mode = kindMode(req.kind, env).mode }) {
  const p = poolOf(req.kind, req.key, caps);
  if (req.units > p.capacity) throw usage(`this asks for ${req.units} of ${p.many}, more than the ${p.capacity} there are`);
  return withStore(dir, (store, log) => {
    const t = now();
    const starts = ownerStarts(store, env, req.pid == null ? [] : [req.pid]);
    sweep(store, log, starts, t);
    const l = sameHolder(store, req, p);
    if (l) {
      Object.assign(l, { ttl: req.ttl, renewed: new Date(t).toISOString(), expires: new Date(t + req.ttl * 1000).toISOString() });
      log({ event: 'renew', ...brief(l), ttl: l.ttl, expires: l.expires });
      return { lease: l, renewed: true };
    }
    return place(store, log, req, p, ownerOf(req, starts), t, { mode, final: req.final, waited: req.waited });
  });
}

// Takes a lease, waiting up to `wait` seconds for it (Infinity: until it is granted), trying every
// `poll` ms and calling `onWait(why)` at the first refusal it waits past. With the kind off, takes nothing.
// -> { code, lease?, why? }, `why` beside a lease saying what shadow let through.
export function acquire(req, { env, dir = leaseDir(), caps = capacities(env), now = Date.now, poll = POLL_MS, onWait = null }) {
  const { mode } = kindMode(req.kind, env);
  if (mode === 'off') {
    poolOf(req.kind, req.key, offCaps(caps));
    return { code: EXIT_OK, why: `the ${req.kind} lease kind is off: nothing taken` };
  }
  const wait = req.wait ?? 0;
  const until = now() + wait * 1000;
  let waiting = false;
  for (;;) {
    const final = now() >= until;
    const r = tryAcquire({ ...req, final, waited: wait }, { env, dir, caps, now, mode });
    // A renewed unit says so (`renewed …` on stderr), so a caller whose push fails keeps a build's unit.
    if (r.lease) return { code: EXIT_OK, lease: r.lease, ...(r.shadow ? { why: `shadow: granted, but on would refuse: ${r.shadow}` } : r.renewed ? { why: `renewed ${r.lease.kind} ${r.lease.key} (lease ${r.lease.id}), which the label ${r.lease.label} already held` } : {}) };
    if (final) return wait ? { code: EXIT_GAVE_UP, why: `gave up after ${wait}s waiting: ${r.refused}` } : { code: EXIT_REFUSED, why: `refused: ${r.refused}` };
    if (!waiting) { waiting = true; onWait?.(r.refused); }
    sleepSync(Math.max(1, Math.min(poll, until - now())));
  }
}

// Renews lease `id` for its new or same owner (`req.pid`): a fresh TTL from now, the owner changed to
// `req.pid`, and the label changed to `req.label` where one is given. With `req.expect` ({ pid?, label? })
// a held lease is renewed only while its owner pid and label still match, read under the store's lock,
// so a caller deciding from an earlier list never takes back a lease handed on since. A lease the store
// does not hold is re-created under the same id where its key is free, and refused (or in shadow
// granted) where another owner holds it. -> { code, lease?, holder?, why }.
export function renew(id, req, { env, dir = leaseDir(), caps = capacities(env), now = Date.now }) {
  const { mode } = kindMode(req.kind, env);
  if (mode === 'off') {
    poolOf(req.kind, req.key, offCaps(caps));
    return { code: EXIT_OK, why: `the ${req.kind} lease kind is off: nothing renewed` };
  }
  const p = poolOf(req.kind, req.key, caps);
  return withStore(dir, (store, log) => {
    const t = now();
    const starts = ownerStarts(store, env, req.pid == null ? [] : [req.pid]);
    sweep(store, log, starts, t);
    const owner = ownerOf(req, starts);
    const l = store.leases.find((x) => x.id === id);
    if (l) {
      if (l.pool !== p.pool || l.key !== p.key) throw usage(`lease ${id} is ${l.kind} ${l.key}, not ${req.kind} ${p.key}`);
      const x = req.expect;
      if (x && ((x.pid !== undefined && (l.owner?.pid ?? null) !== x.pid) || (x.label !== undefined && l.label !== x.label))) {
        return { code: EXIT_REFUSED, holder: l.label, why: `refused: lease ${id} is now held by ${l.label} (${l.owner ? `pid ${l.owner.pid}` : 'no owner'})` };
      }
      const was = l.owner;
      // A renew that names a label gives the lease that label (a branch's unit takes its PR's number).
      Object.assign(l, { owner, ...(req.label ? { label: req.label } : {}), ttl: req.ttl, renewed: new Date(t).toISOString(), expires: new Date(t + req.ttl * 1000).toISOString() });
      log({ event: 'renew', ...brief(l), ...(JSON.stringify(was) !== JSON.stringify(owner) ? { was } : {}), ttl: l.ttl, expires: l.expires });
      return { code: EXIT_OK, lease: l, why: `renewed ${l.kind} ${l.key} (lease ${id}) until ${l.expires}` };
    }
    const r = place(store, log, { ...req, label: req.label || 'unlabelled' }, p, owner, t, { mode, final: true, id, event: 're-create' });
    if (r.refused) return { code: EXIT_REFUSED, why: `refused: lease ${id} was gone, and ${r.refused}` };
    return { code: EXIT_OK, lease: r.lease, why: `re-created ${r.lease.kind} ${r.lease.key} (lease ${id}), which the store no longer held${r.shadow ? `; shadow: on would refuse: ${r.shadow}` : ''}` };
  });
}

// Gives back lease `id`, which only its owner (`pid`) may; one with no owner anyone may. With
// `ifExpires`, only while the lease still expires then: one another taker renewed since (a PR's
// rerun joining its push's unit) is kept for that taker's build. -> { code, why }.
export function release(id, pid, { env, dir = leaseDir(), now = Date.now, ifExpires = null }) {
  return withStore(dir, (store, log) => {
    sweep(store, log, ownerStarts(store, env), now());
    const l = store.leases.find((x) => x.id === id);
    if (!l) return { code: EXIT_OK, why: `lease ${id} was already gone` };
    if (l.owner && l.owner.pid !== pid) return { code: EXIT_REFUSED, why: `refused: lease ${id} is held by pid ${l.owner.pid}, and only its owner releases it` };
    if (ifExpires && l.expires !== ifExpires) return { code: EXIT_OK, why: `kept lease ${id}: it was renewed since, until ${l.expires}` };
    store.leases = store.leases.filter((x) => x !== l);
    log({ event: 'release', ...brief(l) });
    return { code: EXIT_OK, why: `released ${l.kind} ${l.key} (lease ${id})` };
  });
}

// Frees the ownerless preview-build units of team `team` that `done` names by label, in one store
// lock, logging each release with its `reason`. A unit taken or renewed after `at` (when the PR's
// preview finished) is kept: a push or rerun since started a build those checks are not. done: [{ label, at,
// reason }] -> the items of `done` released. Throws LeaseStoreError when the store cannot be read.
export function releasePreviews(team, done, { env, dir = leaseDir(), now = Date.now }) {
  return withStore(dir, (store, log) => {
    sweep(store, log, ownerStarts(store, env), now());
    return done.filter((d) => {
      const l = store.leases.find((x) => x.kind === 'preview-build' && x.key === team && x.owner === null && x.label === d.label);
      if (!l || (d.at && Date.parse(l.renewed ?? l.acquired) > Date.parse(d.at))) return false;
      store.leases = store.leases.filter((x) => x !== l);
      log({ event: 'release', ...brief(l), reason: d.reason });
      return true;
    });
  });
}

// Frees lease `id` whoever holds it, for a person clearing a stuck lease; `reason` is required and
// logged with the holder. -> { code, why }.
export function forceRelease(id, reason, { env, dir = leaseDir(), now = Date.now }) {
  const why = String(reason ?? '').trim();
  if (!why) throw usage('force-release needs --reason <why>: the log keeps it beside the holder');
  return withStore(dir, (store, log) => {
    sweep(store, log, ownerStarts(store, env), now());
    const l = store.leases.find((x) => x.id === id);
    if (!l) return { code: EXIT_OK, why: `lease ${id} was already gone` };
    store.leases = store.leases.filter((x) => x !== l);
    log({ event: 'force-release', ...brief(l), reason: why });
    return { code: EXIT_OK, why: `force-released ${l.kind} ${l.key} (lease ${id}), held by ${holderText(l)}` };
  });
}

// Replaces an unreadable store with an empty one, moving the bad file aside under a dated name for
// inspection; `reason` is required and logged. A store that reads is refused: its leases are live,
// and force-release frees one. -> { code, why }.
export function resetStore(reason, { dir = leaseDir(), now = Date.now }) {
  const why = String(reason ?? '').trim();
  if (!why) throw usage('reset needs --reason <why>: the log keeps it');
  const file = storeFile(dir);
  const lockDir = lockStore(dir);
  const t0 = performance.now();
  try {
    try { readStore(file); return { code: EXIT_REFUSED, why: `refused: the lease store ${file} reads, so its leases are live; ${forceReleaseCommand('<id>')} frees one` }; }
    catch (e) { if (!(e instanceof LeaseStoreError)) throw e; }
    const aside = `${file}.unreadable-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`;
    renameSync(file, aside);
    writeJsonAtomic(file, { leases: [] });
    appendLog(dir, [{ event: 'reset', reason: why, moved_to: aside }], Math.round(performance.now() - t0));
    return { code: EXIT_OK, why: `moved the unreadable lease store to ${aside} and started an empty one` };
  } finally { unlock(lockDir); }
}

// The live leases, after lapsing those whose owner has gone or whose time is up; each lapsed is added
// to `lapsed` when given, as { id, kind, key, units, owner, label, why, detail? }.
export function list({ env, dir = leaseDir(), now = Date.now, lapsed = null }) {
  return withStore(dir, (store, log) => {
    sweep(store, log, ownerStarts(store, env), now(), lapsed);
    return store.leases;
  });
}
// The leases list() would leave, read without the store lock and changing nothing, for a screen that
// shows leases and never lapses one. Throws LeaseStoreError when the store cannot be read.
export function peek({ env, dir = leaseDir(), now = Date.now }) {
  const store = readStore(storeFile(dir));
  const starts = ownerStarts(store, env);
  const t = now();
  return store.leases.filter((l) => !lapseOf(l, starts, t));
}
// A held lease past its expiry: its owner is alive and has not renewed it (a slot's, while it runs).
export const overdue = (l, t) => t > Date.parse(l.expires);
export const forceReleaseCommand = (id) => `desk-env lease force-release ${id} --reason <why>`;
export const RESET_COMMAND = 'desk-env lease reset --reason <why>';

// The log as the screens read it: when it began (its first entry), the latest trial restart, and each
// would-refuse entry, oldest first, as logged. A line that is not JSON is skipped; a missing log is an
// empty one; a log that cannot be read throws LeaseStoreError.
export function readLog({ dir = leaseDir() } = {}) {
  let raw;
  try { raw = readFileSync(logFile(dir), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { first: null, restarted: null, clashes: [] };
    throw new LeaseStoreError(`the lease log ${logFile(dir)} is unreadable: ${e.message}`);
  }
  let first = null, restarted = null;
  const clashes = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const at = first == null || line.includes('"would-refuse"') || line.includes(`"${TRIAL_EVENT}"`);
    if (!at) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const t = Date.parse(e?.at);
    if (!Number.isFinite(t)) continue;
    first ??= t;
    if (e.event === TRIAL_EVENT) restarted = Math.max(restarted ?? t, t);
    else if (e.event === 'would-refuse' && KINDS.includes(e.kind)) clashes.push(e);
  }
  return { first, restarted, clashes };
}

// The trial: kinds in shadow grant what on would refuse and log each as a would-refuse, for TRIAL_DAYS
// from the log's first entry or its latest restart (an answer to the day-7 question restarts it for
// the kinds still in shadow). `log` is readLog's. -> { start, ends } in ms, or null with no log.
export const TRIAL_DAYS = 7;
export const TRIAL_EVENT = 'trial';
export function trialOf(log) {
  const start = log.restarted ?? log.first;
  return start == null ? null : { start, ends: start + TRIAL_DAYS * 86_400_000 };
}
// Restarts the trial for the kinds still in shadow, logging `reason`, under the store lock.
export function restartTrial(reason, { dir = leaseDir() } = {}) {
  const lockDir = lockStore(dir);
  try { appendLog(dir, [{ event: TRIAL_EVENT, reason: String(reason ?? '').trim() || 'restarted' }], 0); } finally { unlock(lockDir); }
}

export const listRow = (l) => [l.id, l.kind, l.key, l.units, l.owner ? `pid ${l.owner.pid}` : 'no owner', l.label, `${l.ttl}s`, l.acquired, l.expires].join('\t');
const LIST_HEAD = ['ID', 'KIND', 'KEY', 'UNITS', 'OWNER', 'LABEL', 'TTL', 'ACQUIRED', 'EXPIRES'].join('\t');
const listJson = (l) => JSON.stringify({ id: l.id, kind: l.kind, key: l.key, units: l.units, owner: l.owner, label: l.label, ttl: l.ttl, acquired: l.acquired, ...(l.renewed ? { renewed: l.renewed } : {}), expires: l.expires });

// `lease list --clashes`: each would-refuse of the last CLASH_DAYS days (or --days), oldest first,
// with who asked and who held it.
const CLASH_DAYS = 7;
const CLASH_HEAD = ['KIND', 'KEY', 'AT', 'REQUESTER', 'HOLDER'].join('\t');
const clashRow = (e) => ({ kind: e.kind, key: e.key, at: e.at, requester: e.label ?? 'unlabelled',
  holder: (e.holders ?? []).map((h) => h.label ?? 'unlabelled').join('; ') || 'unknown' });

export const LEASE_USAGE = `usage: desk-env lease acquire <kind> <key> --ttl <seconds> [--units <n>] [--wait <seconds>] [--label <text>] [<owner>]
       desk-env lease renew <lease id> <kind> <key> --ttl <seconds> [--units <n>] [--label <text>] [<owner>]
       desk-env lease release <lease id> [--pid <owner pid>] [--if-expires <its expires, unrenewed since>]
       ${forceReleaseCommand('<lease id>')}
       ${RESET_COMMAND}
       desk-env lease list [--json] [--clashes [--days <n>]]
       desk-env lease mode [<kind>]
kinds: port <number> | slot ${Object.keys(SLOTS).join('|')} | preview-build <vercel team> | merge <owner>/<repo>@<base> | mem <what for> (units in GiB)
<owner>: --pid <pid>, --owner claude (the nearest Claude Code session above the caller), or --no-owner
(preview-build only: it lapses when its TTL passes). By default the owner is the calling process.
An ownerless acquire whose --label a live ownerless lease of that pool holds renews that lease, so one
PR's builds hold one unit; a renew with no --label keeps the lease's label.
A live owner that does not renew loses its lease at twice its TTL, except a slot's.
Each kind is off, shadow or on from the machine profile's lease-kinds row (desk-env machine set lease-kinds=port=on); unnamed kinds are ${DEFAULT_LEASE_MODE}.
force-release and reset are for a person clearing a stuck lease or an unreadable store.`;
const FALL_BACK = `fall back to running without the lease; a person moves the bad store aside with ${RESET_COMMAND}`;

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
// The owner pid an acquire or renew names: --pid, --owner claude, --no-owner (null), or the caller.
function requestedOwner(opt, kind, env) {
  const given = ['pid', 'owner', 'no-owner'].filter((k) => opt[k] != null);
  if (given.length > 1) throw usage(`name one owner, not ${given.map((k) => `--${k}`).join(' and ')}`);
  if (opt['no-owner']) {
    if (kind !== 'preview-build') throw usage(`only a preview-build lease may have no owner, not a ${kind} lease`);
    return null;
  }
  if (opt.owner != null) {
    if (opt.owner !== 'claude') throw usage(`--owner takes claude, not "${opt.owner}"`);
    const pid = claudeAncestor(env.psRows('pid=,ppid=,args='), process.pid);
    if (pid == null) throw usage('--owner claude: no Claude session was found above the caller');
    return pid;
  }
  return ownerPid(opt.pid);
}
// The --ttl, --units and --label an acquire or renew takes; a renew with no --label keeps its label.
function sizing(opt, sub) {
  if (opt.ttl == null) throw usage(`${sub} needs --ttl <seconds>`);
  const ttl = whole(opt.ttl);
  if (!ttl) throw usage(`--ttl is a whole number of seconds, 1 or more, not "${opt.ttl}"`);
  const units = opt.units == null ? 1 : whole(opt.units);
  if (!units) throw usage(`--units is a whole number, 1 or more, not "${opt.units}"`);
  return { ttl, units, label: String(opt.label ?? '').trim() || (sub === 'renew' ? null : 'unlabelled') };
}

// The CLI: prints what happened and returns the exit code. `env` is desk-env's exports.
export function leaseCli(args, { env, dir = leaseDir(), out = (s) => console.log(s), err = (s) => console.error(s) }) {
  const [sub, ...rest] = args;
  try {
    if (sub === 'acquire' || sub === 'renew') {
      const { pos, opt } = parseArgs(rest, ['ttl', 'units', 'wait', 'label', 'pid', 'owner'].filter((k) => sub === 'acquire' || k !== 'wait'), ['no-owner']);
      const [id, kind, key, extra] = sub === 'acquire' ? [null, ...pos] : pos;
      if (extra != null) throw usage(`${sub} takes ${sub === 'renew' ? 'a lease id, ' : ''}a kind and a key, not "${extra}"`);
      if (sub === 'renew' && !id) throw usage('renew takes a lease id, a kind and a key');
      const caps = capacities(env);
      const { mode, problem } = kindMode(kind, env);
      poolOf(kind, key, mode === 'off' ? offCaps(caps) : caps); // a bad kind or key is named before a missing --ttl
      const s = sizing(opt, sub);
      if (opt.wait != null && !/^\d+(\.\d+)?$/.test(opt.wait)) throw usage(`--wait is a number of seconds, not "${opt.wait}"`);
      if (problem) err(`desk-env lease: the machine profile's ${problem}`);
      const req = { kind, key, ...s, wait: opt.wait == null ? 0 : Number(opt.wait), pid: requestedOwner(opt, kind, env) };
      const onWait = (why) => err(`desk-env lease: waiting for ${poolOf(kind, key, caps).one}: ${why}`);
      const r = sub === 'acquire' ? acquire(req, { env, dir, caps, onWait }) : renew(id, req, { env, dir, caps });
      if (sub === 'acquire' && r.lease) out(r.lease.id);
      if (r.why) (r.code === EXIT_OK && sub === 'renew' ? out : err)(r.why);
      return r.code;
    }
    if (sub === 'release') {
      const { pos, opt } = parseArgs(rest, ['pid', 'if-expires']);
      if (pos.length !== 1) throw usage('release takes one lease id');
      const r = release(pos[0], ownerPid(opt.pid), { env, dir, ifExpires: opt['if-expires'] ?? null });
      (r.code === EXIT_OK ? out : err)(r.why);
      return r.code;
    }
    if (sub === 'force-release') {
      const { pos, opt } = parseArgs(rest, ['reason']);
      if (pos.length !== 1) throw usage('force-release takes one lease id');
      const r = forceRelease(pos[0], opt.reason, { env, dir });
      out(r.why);
      return r.code;
    }
    if (sub === 'reset') {
      const { pos, opt } = parseArgs(rest, ['reason']);
      if (pos.length) throw usage(`reset takes no arguments, not "${pos[0]}"`);
      const r = resetStore(opt.reason, { dir });
      (r.code === EXIT_OK ? out : err)(r.why);
      return r.code;
    }
    if (sub === 'list') {
      const { pos, opt } = parseArgs(rest, ['days'], ['json', 'clashes']);
      if (pos.length) throw usage(`list takes no arguments, not "${pos[0]}"`);
      if (opt.days != null && !opt.clashes) throw usage('--days goes with --clashes');
      if (opt.clashes) {
        const days = opt.days == null ? CLASH_DAYS : whole(opt.days);
        if (!days) throw usage(`--days is a whole number of days, 1 or more, not "${opt.days}"`);
        const t = Date.now();
        const rows = readLog({ dir }).clashes.filter((e) => t - Date.parse(e.at) < days * 86_400_000);
        if (opt.json) for (const e of rows) out(JSON.stringify(clashRow(e)));
        else if (!rows.length) out(`no clashes in the last ${days} days`);
        else { out(CLASH_HEAD); for (const e of rows) out(Object.values(clashRow(e)).join('\t')); }
        return EXIT_OK;
      }
      const leases = list({ env, dir });
      if (opt.json) for (const l of leases) out(listJson(l));
      else if (!leases.length) out('no leases');
      else { out(LIST_HEAD); for (const l of leases) out(listRow(l)); }
      return EXIT_OK;
    }
    if (sub === 'mode') {
      const { pos } = parseArgs(rest, []);
      if (pos.length > 1) throw usage('mode takes at most one kind');
      if (pos[0] != null && !KINDS.includes(pos[0])) throw usage(`unknown lease kind "${pos[0]}": want one of ${KINDS.join(', ')}`);
      const kinds = pos.length ? pos : KINDS;
      const { problem } = kindMode(kinds[0], env);
      if (problem) err(`desk-env lease: the machine profile's ${problem}`);
      for (const k of kinds) out(pos.length ? kindMode(k, env).mode : `${k}\t${kindMode(k, env).mode}`);
      return EXIT_OK;
    }
    throw usage(sub ? `unknown lease command "${sub}"` : 'which lease command?');
  } catch (e) {
    if (e instanceof LeaseUsageError) { err(`desk-env lease: ${e.message}`); err(LEASE_USAGE); return EXIT_USAGE; }
    if (e instanceof LeaseStoreError) { err(`desk-env lease: ${e.message}`); err(`desk-env lease: ${FALL_BACK}`); return EXIT_UNREADABLE; }
    throw e;
  }
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
// Run directly, nothing is mid-evaluation, so desk-env can be imported here.
if (isMain) process.exit(leaseCli(process.argv.slice(2), { env: await import('./desk-env.mjs') }));
