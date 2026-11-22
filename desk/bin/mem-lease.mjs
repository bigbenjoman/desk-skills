// Worker memory as machine-wide leases (leases.mjs, the `mem` kind), behind that kind's lever
// (desk-env lease mode mem):
//   off     nothing is reserved, and a pass judges memory as it always did;
//   shadow  each worker spawn reserves its share, and a pass spawns by the legacy rules, so a spawn
//           past the ceiling is granted and the lease log records the would-refuse;
//   on      a pass starts no worker whose share does not fit under the ceiling beside what is
//           already reserved.
// A worker's share is the machine profile's memory-ceiling-gb divided by the cap of the autopilot
// worker concurrency row, at least 1 GiB, so a pool of reservations caps workers as the machine budget
// does. An interactive session reserves for a heavy run with `desk-env lease acquire mem <what for>
// --units <GiB> --owner claude --ttl <seconds>`, and every pass counts it. The pass reserves under its
// own pid with a short TTL, then hands the reservation to the worker's pid once the worker has
// started, so it returns to the pool when the worker exits. With no memory-ceiling-gb nothing is reserved.
import { EXIT_OK, LeaseStoreError, capacities, kindMode, list, peek, renew, tryAcquire } from './leases.mjs';
import { PICK_TTL, WORKER_TTL } from './port-lease.mjs';

// A worker's share of `ceiling` GiB with a worker cap of `cap`: at least 1, null with no ceiling.
export const memShare = (ceiling, cap) => (ceiling > 0 ? Math.max(1, Math.floor(ceiling / Math.max(1, cap || 1))) : null);

const MOST_HOLDERS = 3;
const holderOf = (l) => `${l.label} ${l.units}G (${l.owner ? `pid ${l.owner.pid}` : 'no owner'})`;

// The memory pool as a pass reads it. `cap` is the worker cap of §3b "Autopilot worker concurrency";
// with `take` false (a dry run) nothing is lapsed.
// -> { mode, ceiling, share, reserved, holders: [lease], unreadable } (ceiling null with none set;
//    unreadable the store's error, with reserved and holders unset).
export function memPool({ env, cap, take = true, dir }) {
  const at = dir == null ? {} : { dir };
  let mode;
  try { ({ mode } = kindMode('mem', env)); } catch (e) { return { mode: 'shadow', ceiling: null, share: null, unreadable: e.message }; }
  if (mode === 'off') return { mode, ceiling: null, share: null };
  const ceiling = capacities(env).mem;
  const share = memShare(ceiling, cap);
  if (ceiling == null) return { mode, ceiling, share };
  let leases;
  try { leases = take ? list({ env, ...at }) : peek({ env, ...at }); } catch (e) {
    if (e instanceof LeaseStoreError) return { mode, ceiling, share, unreadable: e.message };
    throw e;
  }
  const holders = leases.filter((l) => l.kind === 'mem').sort((a, b) => b.units - a.units);
  return { mode, ceiling, share, reserved: holders.reduce((n, l) => n + l.units, 0), holders };
}

// How many workers the pool lets this pass start, and the report's line on it. `wanted` is the slots
// the pass would otherwise fill. With the kind off, or no ceiling, it limits nothing and says nothing;
// with the store unreadable it limits nothing and says so; in shadow it limits nothing and says what
// on would have done.  -> { room, line }   room is Infinity where the pool limits nothing.
export function memBudget(pool, { wanted = 0 } = {}) {
  if (!pool || pool.mode === 'off' || (pool.ceiling == null && !pool.unreadable)) return { room: Infinity, line: null };
  if (pool.unreadable) return { room: Infinity, line: `memory reservations: leases were unreadable (${pool.unreadable}), so memory is judged by the legacy rules` };
  const fits = Math.floor(Math.max(0, pool.ceiling - pool.reserved) / pool.share);
  const top = pool.holders.slice(0, MOST_HOLDERS).map(holderOf);
  const more = pool.holders.length - top.length;
  const head = `memory reservations: ${pool.reserved}G of the ${pool.ceiling}G ceiling reserved, a worker's share ${pool.share}G`
    + (top.length ? `; largest holders: ${top.join(', ')}${more > 0 ? ` and ${more} more` : ''}` : '');
  if (pool.mode === 'shadow') {
    return { room: Infinity, line: head + (fits < wanted ? `: on would start at most ${fits}; in shadow the legacy rules decide` : '') };
  }
  const tail = fits === 0 && wanted > 0 ? ": no worker's share fits under the ceiling, so nothing starts this pass"
    : fits < wanted ? `: starting at most ${fits}` : '';
  return { room: fits, line: head + tail };
}

// Reserves a worker's share for `key` under the pass's pid, for PICK_TTL, until handToWorker moves it
// to the worker. A refusal (the kind on, and a session reserved since the pass counted) or an
// unreadable store reserves nothing.  -> { id } or { why }.
export function reserveForWorker({ env, pool, label, key, pid = process.pid, dir }) {
  if (!pool || pool.mode === 'off' || pool.ceiling == null || pool.unreadable) return {};
  const at = dir == null ? {} : { dir };
  try {
    const r = tryAcquire({ kind: 'mem', key: `worker ${key}`, units: pool.share, ttl: PICK_TTL, label, pid, final: true }, { env, ...at, mode: pool.mode });
    return r.lease ? { id: r.lease.id } : { why: r.refused };
  } catch (e) { return { why: e.message }; }
}

// Hands reservation `id` from the pass to the worker's process. -> null, or why it stays with the pass.
export function handToWorker({ env, id, key, share, workerPid, label, dir }) {
  if (!id) return null;
  if (!(Number(workerPid) > 0)) return 'spawn-worker.sh printed no worker pid';
  try {
    const r = renew(id, { kind: 'mem', key: `worker ${key}`, units: share, ttl: WORKER_TTL, label, pid: Number(workerPid) }, { env, ...(dir == null ? {} : { dir }) });
    return r.code === EXIT_OK ? null : r.why;
  } catch (e) { return e.message; }
}
