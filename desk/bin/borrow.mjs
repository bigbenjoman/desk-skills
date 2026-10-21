// Borrowing idle workers: a batch may start workers above its own number, up to its §3b cap, while
// other live batches on this computer leave machine slots unused. Off unless config §3b "Borrow idle
// workers" is `on`. Each pass reads every repo's queue and writes only its own, so nothing is saved
// between passes and turning it off takes effect on the next one.
//
// Spare machine slots = the machine profile's cap (autopilot-concurrency), less the workers running
// in every queue (a quiet batch's running workers still hold memory), less what each other live
// batch has first claim on: the part of its own number it has not filled, as far as it has ready
// tickets to fill it with. A batch below its own number always starts up to it; borrowing only ever
// adds to that. Running work is never stopped. Counting and starting happen under one lock shared
// by every repo (takeBorrowLock), so two passes cannot claim the same slot.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as E from './desk-env.mjs';
import { batchConcurrency, describeCrash, isHeld, readJsonOrRefuse } from './batch-state.mjs';

// The same test queue.mjs init and desk-q use: a heartbeat fresher than this is a live batch.
export const LIVE_MS = 15 * 60 * 1000;
export const BORROW_ROW = 'Borrow idle workers';

// Config §3b "Borrow idle workers": `on` or `off`, unset meaning off. Anything else is said and read
// as off: off is the side that changes nothing.
//   -> { on, bad: null | message }
export function borrowSetting(raw = E.configValue('borrow-idle')) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return { on: false, bad: null };
  if (v === 'on') return { on: true, bad: null };
  return { on: false, bad: `config §3b "${BORROW_ROW}" is "${raw}" — want \`on\` or \`off\`; read as off` };
}

// The machine's worker total: the cap in the machine profile's autopilot-concurrency, or null.
export function machineCap(value = E.machineValue('autopilot-concurrency')) {
  return value ? E.concurrencyLimits(value).cap : null;
}

// A ticket another batch could start now: triaged, with no question open, and not held.
const isReady = (t) => t?.state === 'triaged' && (t.open_questions ?? 0) === 0 && !isHeld(t);

function lastPass(stateDir, queuePath) {
  const dir = join(stateDir, 'orchestrators');
  let last = null;
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    try {
      const hb = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const at = Date.parse(hb.at);
      if (hb.queue === queuePath && Number.isFinite(at) && (last == null || at > last)) last = at;
    } catch { /* a torn heartbeat is no heartbeat */ }
  }
  return last;
}

// Every other repo's queue under $DESK_HOME/repos, read and never written. Each is
// { slug, live, running, ready, share } or { slug, error } for one that will not parse.
export function otherBatches({ self, now = Date.now(), home = E.deskHome(), stateRoot = join(E.HOME, '.desk-autopilot') } = {}) {
  const dir = join(home, 'repos');
  const out = [];
  for (const slug of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const path = join(dir, slug, 'queue.json');
    if ((self && resolve(path) === resolve(self)) || !existsSync(path)) continue;
    let q;
    try { q = readJsonOrRefuse(path, 'restore it, or start a new batch there'); } catch (e) { out.push({ slug, error: describeCrash(e) }); continue; }
    const tickets = Object.values(q?.tickets ?? {});
    const last = lastPass(join(stateRoot, slug), path);
    out.push({
      slug,
      live: last != null && now - last < LIVE_MS,
      running: tickets.filter((t) => t?.state === 'running').length,
      ready: tickets.filter(isReady).length,
      share: batchConcurrency(q, E.concurrencyLimits(E.repoConfigValue(slug, 'concurrency'))).n,
    });
  }
  return out;
}

const repoName = (slug) => slug.replace('__', '/');
const workers = (n) => `${n} worker${n === 1 ? '' : 's'}`;

// How many workers this pass may start, and the report line that says why.
//   on        borrowing is on
//   share     the batch's own number (batchConcurrency)
//   cap       this repo's §3b cap
//   running   this batch's running workers
//   wanted    tickets this pass could start
//   others    otherBatches()
//   machine   the machine's worker total (machineCap), or null
//   memory    { avail, start }: nothing starts, borrowed or not, below the spawn gate
//   held      any other reason nothing starts this pass, or null
//   lock      null when the lock was taken (or not needed), else why it was not
// -> { slots, base, borrow, line }   line is null when borrowing is off and there is nothing to say
export function borrowPlan({ on, share, cap, running, wanted, others = [], machine, memory = null, held = null, lock = null }) {
  const base = Math.max(0, share - running);
  const above = Math.max(0, running - share);
  const lowMemory = !!memory && memory.start > 0 && memory.avail < memory.start;
  if (held || lowMemory) {
    const why = lowMemory ? `available memory ${memory.avail.toFixed(1)}G is under the ${memory.start}G spawn gate` : held;
    return { slots: 0, base, borrow: 0, line: on ? `borrowing: nothing starts, borrowed or not: ${why}` : null };
  }
  const plain = (line) => ({ slots: base, base, borrow: 0, line });
  // A worker count of 0 is a pause, which borrowing must not undo.
  if (!on || share <= 0) return plain(null);
  const own = above ? `${above} above the batch's own number of ${share}, starting nothing new`
    : `at ${running} of the batch's own number of ${share}, starting nothing above it`;
  const none = (why) => plain(`borrowing: ${own}: ${why}`);
  if (wanted <= base) return plain(above ? `borrowing: ${own}: nothing more is ready` : null);
  const bad = others.filter((o) => o.error);
  if (bad.length) return none(`another repo's queue cannot be read, so the free slots cannot be counted (${bad.map((o) => o.error).join('; ')})`);
  if (machine == null) return none('the machine profile has no autopilot-concurrency, so there is no machine total to borrow from');
  if (running >= cap) return none(`it is at its §3b cap of ${cap}`);
  if (lock) return none(lock);
  const runningAll = running + others.reduce((n, o) => n + o.running, 0);
  const claims = others.filter((o) => o.live).map((o) => ({ ...o, claim: Math.min(Math.max(0, o.share - o.running), o.ready) })).filter((o) => o.claim > 0);
  const claimed = claims.reduce((n, o) => n + o.claim, 0);
  const free = machine - runningAll - claimed - base;
  const borrow = Math.max(0, Math.min(cap - Math.max(running, share), free, wanted - base));
  const count = `machine ${machine}: ${runningAll} running, ${claimed} claimed by other batches`;
  if (borrow > 0) return { slots: base + borrow, base, borrow, line: null, count };
  if (claims.length && machine - runningAll - base > 0) {
    return none(`${claims.map((o) => `${repoName(o.slug)} has first claim on the free slots (${o.ready} ready, ${o.running} of its ${o.share} running)`).join('; ')} (${count})`);
  }
  return none(`no free machine slot (${count})`);
}

// The report line once the pass has spawned: how many of its new workers were borrowed.
export function borrowedLine(plan, { share, running, spawned }) {
  if (plan.line != null || !plan.borrow) return plan.line;
  const borrowed = Math.max(0, spawned - plan.base);
  const total = Math.max(0, running + spawned - share);
  if (!borrowed) return `borrowing: ${plan.borrow} may be borrowed, none started (${plan.count})`;
  return `borrowing: ${workers(borrowed)} borrowed this pass, ${total} above the batch's own number of ${share} (${plan.count})`;
}

// One lock shared by every repo, around counting the free slots and starting workers into them: a
// mkdir lock under DESK_LOCK_DIR recording the holder's pid, taken over when that process is gone
// (with-lock.sh's fallback, in-process). It waits at most `waitMs`; a pass that cannot take it
// borrows nothing that pass. -> { ok: true, release } | { ok: false, why }
export async function takeBorrowLock({ dir = E.lockDir(), waitMs = 120000, pollMs = 250, pid = process.pid } = {}) {
  const path = join(dir, 'desk-borrow.lock.d');
  const started = Date.now();
  let holder = '';
  for (;;) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'pid'), String(pid));
      const release = () => { try { if (readFileSync(join(path, 'pid'), 'utf8').trim() === String(pid)) rmSync(path, { recursive: true, force: true }); } catch { /* gone */ } };
      return { ok: true, release };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, why: `the borrow lock ${path} cannot be made (${e.code ?? e.message})` };
    }
    try { holder = readFileSync(join(path, 'pid'), 'utf8').trim(); } catch { holder = ''; }
    let stale = false;
    if (/^\d+$/.test(holder)) {
      try { process.kill(Number(holder), 0); } catch (e) { stale = e.code === 'ESRCH'; }
    } else {
      // Made but no pid written for a minute: the taker died between the two steps.
      try { stale = Date.now() - statSync(path).mtimeMs > 60000; } catch { continue; }
    }
    if (stale) {
      // Rename first: exactly one taker wins, and nobody deletes a lock a faster taker re-made.
      const grave = `${path}.stale.${pid}`;
      try { renameSync(path, grave); rmSync(grave, { recursive: true, force: true }); } catch { /* another taker won */ }
      continue;
    }
    if (Date.now() - started >= waitMs) return { ok: false, why: `the borrow lock is held by pid ${holder || '?'} (waited ${Math.round(waitMs / 1000)}s)` };
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, pollMs); });
  }
}
