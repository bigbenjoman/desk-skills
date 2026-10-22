// Borrowing idle workers: a batch may start workers above its own number, up to its §3b cap, while
// other live batches on this computer leave machine slots unused. Off unless config §3b "Borrow idle
// workers" is `on`. Each pass reads every repo's queue and writes only its own, so nothing is saved
// between passes and turning it off takes effect on the next one.
//
// Free machine slots = the machine profile's cap (autopilot-concurrency) less the workers running in
// every queue (a quiet batch's running workers still hold memory). A batch takes them for its own
// number first; it borrows only what is left after each other live batch's first claim (the part of
// its own number it has not filled, as far as it has ready tickets to fill it with). Running work is
// never stopped, so a lender that comes back to a full machine waits for slots to free. Counting and
// starting happen under one lock shared by every repo (takeBorrowLock), so two passes cannot take the
// same slot. Where the slots cannot be counted (another queue unreadable, no machine total, the lock
// not taken), a pass starts up to its own number, as it would with borrowing off, and nothing above.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as E from './desk-env.mjs';
import { batchConcurrency, describeCrash, isHeld, readJsonOrRefuse } from './batch-state.mjs';

// A heartbeat fresher than this is a live batch: queue.mjs init, desk-q and borrowing all use it,
// desk-q through liveBeat, which also counts a recorded next pass still to come.
export const LIVE_MS = 15 * 60 * 1000;

// Config §3b "Borrow idle workers": `on` or `off`, unset meaning off. Anything else is said and read
// as off: off is the side that changes nothing.
//   -> { on, bad: null | message }
export function borrowSetting(raw = E.configValue('borrow-idle')) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === '' || v === 'off') return { on: false, bad: null };
  if (v === 'on') return { on: true, bad: null };
  return { on: false, bad: `config §3b "${E.CONFIG_ROWS['borrow-idle'].row}" is "${raw}" — want \`on\` or \`off\`; read as off` };
}

// The machine's worker total: the cap in the machine profile's autopilot-concurrency, or null.
export function machineCap(value = E.machineValue('autopilot-concurrency')) {
  return value ? E.concurrencyLimits(value).cap : null;
}

// How long past its recorded next pass a batch still counts as live: a wake-up runs late, and a pass
// takes time to write its heartbeat.
export const PASS_GRACE_MS = 10 * 60 * 1000;

// The heartbeat file pass.mjs writes for one queue file.
export const beatFile = (stateDir, queuePath) => join(stateDir, 'orchestrators', `${queuePath.replace(/[^A-Za-z0-9]/g, '-')}.json`);

// A next-pass time as given on a command line: `+<seconds>` or `<seconds>` from now, or an ISO time.
//   -> epoch ms, or null for anything else
export function parseNext(word, now = Date.now()) {
  const s = String(word ?? '').trim();
  if (/^\+?\d+$/.test(s)) return now + Number(s.replace('+', '')) * 1000;
  const t = /^\d{4}-\d\d-\d\dT/.test(s) ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : null;
}

// The newest pass on `queuePath`: pass.mjs writes one heartbeat per queue file into the state
// directory, so only that queue's count. `next` is the pass it planned after, where one was recorded.
//   -> { at, next } in epoch ms (next null when none), or null with no heartbeat
export function lastBeat(stateDir, queuePath) {
  const dir = join(stateDir, 'orchestrators');
  let last = null;
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    try {
      const hb = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      const at = Date.parse(hb.at);
      const next = hb.next == null ? NaN : Date.parse(hb.next);
      if (hb.queue === queuePath && Number.isFinite(at) && (last == null || at > last.at)) last = { at, next: Number.isFinite(next) ? next : null };
    } catch { /* a torn heartbeat is no heartbeat */ }
  }
  return last;
}

// A batch is live while its last pass is fresher than LIVE_MS, or while the next pass it recorded is
// not yet PASS_GRACE_MS overdue: an orchestrator waiting longer than LIVE_MS between passes has not gone.
export const liveBeat = (beat, now = Date.now()) => beat != null
  && (now - beat.at < LIVE_MS || (beat.next != null && now < beat.next + PASS_GRACE_MS));

// Every other repo's queue under $DESK_HOME/repos, read and never written, in slug order: each is
// { slug, path, q } or { slug, path, error } for one that cannot be read or is not a queue.
export function otherQueues({ self, home = E.deskHome() } = {}) {
  const dir = join(home, 'repos');
  const out = [];
  for (const slug of existsSync(dir) ? readdirSync(dir).sort() : []) {
    const path = join(dir, slug, 'queue.json');
    if ((self && resolve(path) === resolve(self)) || !existsSync(path)) continue;
    try {
      const q = readJsonOrRefuse(path, 'restore it, or start a new batch there');
      if (q == null || typeof q !== 'object' || Array.isArray(q)) throw new Error(`${path} is not a queue (it holds ${Array.isArray(q) ? 'a list' : String(q)}): restore it, or start a new batch there`);
      out.push({ slug, path, q });
    } catch (e) { out.push({ slug, path, error: describeCrash(e) }); }
  }
  return out;
}

// The machine-wide worker budget, borrowing on or off: the machine profile's cap is a hard limit on
// the workers running in every repo together, so a pass starts at most the cap less every queue's
// running workers. A queue that cannot be read counts at its repo's own §3b cap, the most it could
// be running. With no machine total there is no budget and each repo uses its own rows.
//   running   this batch's running workers
//   wanted    the slots this pass would otherwise fill
//   queues    otherQueues()
// -> { room, line }   room is Infinity with no machine total
export function machineBudget({ running, wanted = 0, machine = machineCap(), queues = [] }) {
  if (machine == null) {
    const why = E.machineProfile() != null ? 'the machine profile has no autopilot-concurrency' : 'no machine profile';
    return { room: Infinity, line: `machine budget: none — ${why}, so this repo uses its own §3b rows` };
  }
  let all = running;
  let why = '';
  for (const o of queues) {
    if (o.error) {
      const counted = E.concurrencyLimits(E.repoConfigValue(o.slug, 'concurrency')).cap;
      why += `; ${repoName(o.slug)}'s queue cannot be read (${o.error}), so it counts at its cap of ${workers(counted)}`;
      all += counted;
    } else all += Object.values(o.q.tickets ?? {}).filter((t) => t?.state === 'running').length;
  }
  const room = Math.max(0, machine - all);
  const head = `machine budget: ${all} of the machine's ${machine} worker(s) running across every repo${why}`;
  const tail = room === 0 && wanted > 0 ? ': the machine is at its cap, so nothing starts this pass'
    : room < wanted ? `: starting at most ${room}` : '';
  return { room, line: head + tail };
}

// A ticket another batch could start now: triaged, with no question open, and not held.
const isReady = (t) => t?.state === 'triaged' && (t.open_questions ?? 0) === 0 && !isHeld(t);

// What borrowing needs from each other queue: { slug, live, running, ready, share }, or
// { slug, error }.
export function otherBatches({ self, now = Date.now(), home = E.deskHome(), stateRoot = join(E.HOME, '.desk-autopilot'), queues = otherQueues({ self, home }) } = {}) {
  return queues.map(({ slug, path, q, error }) => {
    if (error) return { slug, error };
    const tickets = Object.values(q.tickets ?? {});
    const last = lastBeat(join(stateRoot, slug), path)?.at ?? null;
    return {
      slug,
      live: last != null && now - last < LIVE_MS,
      running: tickets.filter((t) => t?.state === 'running').length,
      ready: tickets.filter(isReady).length,
      share: batchConcurrency(q, E.concurrencyLimits(E.repoConfigValue(slug, 'concurrency'))).n,
    };
  });
}

const repoName = (slug) => slug.replace('__', '/');
const workers = (n) => `${n} worker${n === 1 ? '' : 's'}`;

// How many workers this pass may start, and the report line that says why.
//   on        borrowing is on
//   share     the batch's own number (batchConcurrency)
//   cap       this repo's §3b cap
//   running   this batch's running workers
//   wanted    tickets this pass could start
//   others    otherBatches(), counted under the lock
//   machine   the machine's worker total (machineCap), or null
//   memory    { avail, start }: nothing starts, borrowed or not, below the spawn gate
//   held      any other reason nothing starts this pass, or null
//   lock      null when the lock was taken, else why it was not
// -> { slots, own, borrow, line, count }   line is null when there is nothing to say
export function borrowPlan({ on, share, cap, running, wanted, others = [], machine, memory = null, held = null, lock = null }) {
  const base = Math.max(0, share - running);
  const lowMemory = !!memory && memory.start > 0 && memory.avail < memory.start;
  if (held || lowMemory) {
    const why = lowMemory ? `available memory ${memory.avail.toFixed(1)}G is under the ${memory.start}G spawn gate` : held;
    return { slots: 0, own: 0, borrow: 0, line: on ? `borrowing: nothing starts, borrowed or not: ${why}` : null };
  }
  // A worker count of 0 is a pause, which borrowing must not undo.
  if (!on || share <= 0) return { slots: base, own: base, borrow: 0, line: null };
  // The slots cannot be counted: up to its own number, as with borrowing off, and nothing above.
  const uncounted = (why) => ({ slots: base, own: base, borrow: 0, line: `borrowing: ${why}, so the free slots cannot be counted: starting up to the batch's own number of ${share} and nothing above it` });
  const bad = others.filter((o) => o.error);
  if (bad.length) return uncounted(`another repo's queue cannot be read (${bad.map((o) => o.error).join('; ')})`);
  if (machine == null) return uncounted('the machine profile has no autopilot-concurrency, so there is no machine total');
  if (lock) return uncounted(lock);

  const runningAll = running + others.reduce((n, o) => n + o.running, 0);
  const claims = others.filter((o) => o.live).map((o) => ({ ...o, claim: Math.min(Math.max(0, o.share - o.running), o.ready) })).filter((o) => o.claim > 0);
  const claimed = claims.reduce((n, o) => n + o.claim, 0);
  const room = Math.max(0, machine - runningAll);
  const count = `machine ${machine}: ${runningAll} running, ${claimed} claimed by other batches`;
  // Its own number first, as far as the machine has room; then borrowing, after the others' claims.
  const want = Math.min(base, wanted);
  const own = Math.min(want, room);
  const borrow = own < base ? 0 : Math.max(0, Math.min(cap - Math.max(running, share), room - claimed - own, wanted - own));
  const plan = (line) => ({ slots: own + borrow, own, borrow, line, count });
  if (own < want) {
    return plan(`borrowing: starting ${own} of the ${want} the batch's own number of ${share} leaves room for: the machine is full (${count}), and the rest start as running workers finish`);
  }
  if (borrow > 0) return plan(null);
  const above = Math.max(0, running - share);
  const where = above ? `${above} above the batch's own number of ${share}, starting nothing new`
    : `at ${running + own} of the batch's own number of ${share}, starting nothing above it`;
  if (wanted <= own) return plan(above ? `borrowing: ${where}: nothing more is ready` : null);
  if (running + own >= cap) return plan(`borrowing: ${where}: it is at its §3b cap of ${cap}`);
  if (claims.length && room - own > 0) {
    return plan(`borrowing: ${where}: ${claims.map((o) => `${repoName(o.slug)} has first claim on the free slots (${o.ready} ready, ${o.running} of its ${o.share} running)`).join('; ')} (${count})`);
  }
  return plan(`borrowing: ${where}: no free machine slot (${count})`);
}

// The report line once the pass has spawned: how many of its new workers were borrowed.
export function borrowedLine(plan, { share, running, spawned }) {
  if (plan.line != null || !plan.borrow) return plan.line;
  const borrowed = Math.max(0, spawned - plan.own);
  const total = Math.max(0, running + spawned - share);
  if (!borrowed) return `borrowing: ${plan.borrow} may be borrowed, none started (${plan.count})`;
  return `borrowing: ${workers(borrowed)} borrowed this pass, ${total} above the batch's own number of ${share} (${plan.count})`;
}

// One lock shared by every repo, around counting the free slots and starting workers into them: a
// directory under DESK_LOCK_DIR, because creating one is atomic, with the holder's pid inside. A
// holder that has exited never lets go, so its lock is cleared; one with no pid yet is between its
// mkdir and its write, unless it has sat that way for a minute. It waits at most `waitMs`; a pass
// that cannot take it counts nothing that pass. -> { ok: true, release } | { ok: false, why }
export async function takeBorrowLock({ dir = E.lockDir(), name = 'desk-borrow.lock.d', waitMs = 120000, pollMs = 250, pid = process.pid } = {}) {
  const path = join(dir, name);
  const holder = () => { try { return Number(readFileSync(join(path, 'pid'), 'utf8').trim()) || null; } catch { return null; } };
  const alive = (p) => { try { process.kill(p, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  const stale = () => { const p = holder(); try { return p ? !alive(p) : Date.now() - statSync(path).mtimeMs > 60000; } catch { return false; } };
  // Takers that all saw the same stale lock must not each remove "the lock", or a slower one removes
  // the lock a faster one has just taken. So clearing takes its own lock and looks again under it
  // (queue.mjs's rule). A clearing lock older than 5 seconds is a clearer that died mid-clear.
  const clearStale = () => {
    const clearing = `${path}.clearing`;
    try { mkdirSync(clearing); } catch (e) {
      if (e.code !== 'EEXIST') return false;
      try { if (Date.now() - statSync(clearing).mtimeMs > 5000) rmSync(clearing, { recursive: true, force: true }); } catch { /* gone */ }
      return false;
    }
    try { if (stale()) rmSync(path, { recursive: true, force: true }); } finally { rmSync(clearing, { recursive: true, force: true }); }
    return true;
  };
  const until = Date.now() + waitMs;
  for (;;) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'pid'), String(pid));
      const release = () => { if (holder() === pid) rmSync(path, { recursive: true, force: true }); };
      return { ok: true, release };
    } catch (e) {
      if (e.code !== 'EEXIST') return { ok: false, why: `the borrow lock ${path} cannot be made (${e.code ?? e.message})` };
    }
    if (stale() && clearStale()) continue;
    if (Date.now() >= until) return { ok: false, why: `the borrow lock is held by pid ${holder() ?? '?'} (waited ${Math.round(waitMs / 1000)}s)` };
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => { setTimeout(r, pollMs); });
  }
}
