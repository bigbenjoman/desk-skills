#!/usr/bin/env node
// Worker ports as machine-wide leases (leases.mjs, the `port` kind), behind that kind's lever
// (desk-env lease mode port):
//   off     a port is picked as it always was, and nothing is leased;
//   shadow  picked as it always was, then leased, so a port a peer holds is granted and the lease log
//           records the would-refuse naming the peer and the worker;
//   on      a port another session leases is never picked.
// The pass leases the port under its own pid with a short TTL, so a pass that dies mid-spawn frees it,
// then hands the lease to the worker's pid once the worker has started, so it lapses when the worker
// exits. Running tickets' ports, other queues' running workers, port-claims.mjs and the bind probe stay
// beside the leases: the caller passes those as `taken` and `inUse`.
//
// An orchestrator leases its batch's range for its Claude session at the handshake, and renews it:
//   port-lease.mjs range <from>-<to> [--batch <name>]
// Each port in the range no other session leases is leased (or renewed) under the label
// "<repo> <batch> range". Its own pass may give a worker a port in that range: it hands that port's
// lease to the worker rather than refusing it.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EXIT_OK, EXIT_UNREADABLE, EXIT_USAGE, LeaseStoreError, claudeAncestor, kindMode, list, peek, renew, tryAcquire } from './leases.mjs';

// The pass's hold on a port while it spawns the worker.
export const PICK_TTL = 300;
// A worker's hold: its exit ends it, and nothing renews it, so this is long enough that a live worker
// keeps it (a live owner that never renews lapses at twice its TTL).
export const WORKER_TTL = 24 * 3600;
export const RANGE_TTL = 3600;

export const batchLabel = (repo, batch) => `${repo} ${batch ?? 'standing'}`;
export const workerLabel = (repo, batch, key) => `${batchLabel(repo, batch)} ${key}`;
export const rangeLabel = (repo, batch) => `${batchLabel(repo, batch)} range`;

const portReq = (port, ttl, label, pid) => ({ kind: 'port', key: String(port), units: 1, ttl, label, pid });
const brokerNote = (e) => (e instanceof LeaseStoreError
  ? `ports: leases were unreadable (${e.message}), so ports were picked without them`
  : `ports: the lease broker failed (${e.message}), so ports were picked without leases`);

// Picks a port for a worker. `taken` is the ports the legacy rule holds, `inUse(port)` the bind probe,
// `own` a resumed worker's last port (kept while it is free and, with the kind on, unleased), `floor`
// where the search starts. With `take` false (a dry run) nothing is leased or lapsed.
// -> { port, lease: id | null, mode, notes: [report lines] }.
export async function pickPort({ env, taken, inUse, own = null, floor, repo, batch, key, take = true, dir, pid = process.pid }) {
  const notes = [];
  const at = dir == null ? {} : { dir };
  const legacy = async () => {
    if (Number(own) > 0 && !taken.has(Number(own)) && !(await inUse(Number(own)))) return Number(own);
    let p = floor;
    while (taken.has(p) || await inUse(p)) p += 1;
    return p;
  };
  let mode;
  try { ({ mode } = kindMode('port', env)); } catch (e) { return { port: await legacy(), lease: null, mode: 'off', notes: [brokerNote(e)] }; }
  if (mode === 'off') return { port: await legacy(), lease: null, mode, notes };
  let leases;
  const lapsed = [];
  try { leases = take ? list({ env, ...at, lapsed }) : peek({ env, ...at }); } catch (e) {
    return { port: await legacy(), lease: null, mode, notes: [brokerNote(e)] };
  }
  for (const l of lapsed) {
    if (l.kind === 'port') notes.push(`ports: dropped the stale lease on port ${l.key} held by ${l.label} (${l.owner ? `pid ${l.owner.pid}` : 'no owner'}): ${l.why}`);
  }
  const range = rangeLabel(repo, batch);
  const label = workerLabel(repo, batch, key);
  const byPort = new Map(leases.filter((l) => l.kind === 'port').map((l) => [Number(l.key), l]));
  const refused = new Set();
  // With the kind on, a port is free to pick when no lease holds it but this batch's own range.
  const free = async (p) => !taken.has(p) && !refused.has(p)
    && (mode !== 'on' || !byPort.has(p) || byPort.get(p).label === range) && !(await inUse(p));
  for (;;) {
    let port = mode === 'on' ? null : await legacy();
    if (port == null) {
      if (Number(own) > 0 && await free(Number(own))) port = Number(own);
      for (let p = floor; port == null; p += 1) if (await free(p)) port = p;
    }
    if (!take) return { port, lease: null, mode, notes };
    try {
      const held = byPort.get(port);
      if (held?.label === range) {
        const r = renew(held.id, { ...portReq(port, PICK_TTL, label, pid), expect: { label: range } }, { env, ...at });
        if (r.code === EXIT_OK) return { port, lease: held.id, mode, notes };
      } else {
        const r = tryAcquire({ ...portReq(port, PICK_TTL, label, pid), final: true }, { env, ...at, mode });
        if (r.lease) return { port, lease: r.lease.id, mode, notes };
      }
      // Shadow grants every try. With the kind on, a port leased since the list was read is refused,
      // and the next free one is tried.
      if (mode !== 'on') return { port, lease: null, mode, notes };
      refused.add(port);
    } catch (e) {
      notes.push(brokerNote(e));
      return { port, lease: null, mode, notes };
    }
  }
}

// Hands lease `id` from the pass to the worker's process, renewing it as `req` (its kind, key, units
// and label) for WORKER_TTL under the worker's pid. A worker whose pid is unknown leaves it with the
// pass, so it lapses when the pass exits. -> null, or why it was not handed over.
export function handLeaseToWorker({ env, id, req, workerPid, dir }) {
  if (!id) return null;
  if (!(Number(workerPid) > 0)) return 'spawn-worker.sh printed no worker pid';
  try {
    const r = renew(id, { ...req, ttl: WORKER_TTL, pid: Number(workerPid) }, { env, ...(dir == null ? {} : { dir }) });
    return r.code === EXIT_OK ? null : r.why;
  } catch (e) { return e.message; }
}
// The port lease's hand-off, labelled with the worker's repo, batch and ticket.
export const handToWorker = ({ env, id, port, workerPid, label, dir }) => handLeaseToWorker({ env, id, req: portReq(port, WORKER_TTL, label, null), workerPid, dir });

// The worker pid spawn-worker.sh printed (`[spawn] ticket=… pid=<pid> …`), or null.
export const spawnedPid = (out) => {
  const m = /^\[spawn\] .*\bpid=(\d+)\b/m.exec(String(out ?? ''));
  return m ? Number(m[1]) : null;
};

// Leases each port from..to no one else holds for `owner`, renewing the ones it holds already, for
// RANGE_TTL. -> { mode, leased: [port], renewed: [port], held: [{ port, label }] }.
export function leaseRange({ env, from, to, owner, label, dir }) {
  const ttl = RANGE_TTL;
  const at = dir == null ? {} : { dir };
  const { mode } = kindMode('port', env);
  const out = { mode, leased: [], renewed: [], held: [] };
  if (mode === 'off') return out;
  const byPort = new Map(list({ env, ...at }).filter((l) => l.kind === 'port').map((l) => [Number(l.key), l]));
  for (let p = from; p <= to; p += 1) {
    const l = byPort.get(p);
    if (l && l.owner?.pid === owner && l.label === label) {
      // Checked again under the lock: the pass may have handed this port to a worker since the list.
      const r = renew(l.id, { ...portReq(p, ttl, label, owner), expect: { pid: owner, label } }, { env, ...at });
      if (r.code === EXIT_OK) out.renewed.push(p); else out.held.push({ port: p, label: r.holder ?? r.why });
      continue;
    }
    if (l) { out.held.push({ port: p, label: l.label }); continue; }
    const r = tryAcquire({ ...portReq(p, ttl, label, owner), final: true }, { env, ...at, mode: 'on' });
    if (r.lease) out.leased.push(p); else out.held.push({ port: p, label: r.refused });
  }
  return out;
}

const spans = (ports) => {
  const out = [];
  for (const p of ports) {
    const last = out[out.length - 1];
    if (last && last[1] === p - 1) last[1] = p; else out.push([p, p]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
};
const USAGE = 'usage: port-lease.mjs range <from>-<to> [--batch <name>]';

async function cli() {
  // desk-env takes `--batch <name>` out of process.argv as it loads, so the arguments are read after it.
  const E = await import('./desk-env.mjs');
  const { parseRange } = await import('./port-claims.mjs');
  const [cmd, text, extra] = process.argv.slice(2);
  if (cmd !== 'range' || extra != null) { console.error(USAGE); return EXIT_USAGE; }
  const r = parseRange(text);
  if (r.error) { console.error(`port-lease: ${r.error}. ${USAGE}`); return EXIT_USAGE; }
  const ttl = RANGE_TTL;
  if (kindMode('port', E).mode === 'off') {
    console.log('port leases are off (desk-env lease mode port): publish your range at the handshake, and take no lease');
    return EXIT_OK;
  }
  const owner = claudeAncestor(E.psRows('pid=,ppid=,args='), process.pid);
  if (owner == null) { console.error('port-lease: no Claude session was found above this command, so the range has no owner to hold it'); return EXIT_USAGE; }
  const label = rangeLabel(E.ghRepo(), E.batchName());
  try {
    const o = leaseRange({ env: E, from: r.from, to: r.to, owner, label });
    if (o.leased.length) console.log(`leased ${spans(o.leased)} to "${label}" (pid ${owner}) for ${ttl}s`);
    if (o.renewed.length) console.log(`renewed ${spans(o.renewed)} for ${ttl}s`);
    for (const h of o.held) console.log(`skipped ${h.port}: held by ${h.label}`);
    console.log(`renew it within ${ttl}s while the batch runs (the same command): a lease nobody renews lapses at twice its TTL`);
    return EXIT_OK;
  } catch (e) {
    if (e instanceof LeaseStoreError) { console.error(`port-lease: ${e.message}: publish your range at the handshake as before`); return EXIT_UNREADABLE; }
    throw e;
  }
}

const isMain = (() => {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) process.exit(await cli());
