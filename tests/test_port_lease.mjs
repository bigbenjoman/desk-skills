// suite: port leases (a pass picks a worker's port around the ports other sessions lease, hands the lease to the worker, and an orchestrator leases its range)
// covers: desk/bin/port-lease.mjs
// pickPort, handToWorker and leaseRange against a scratch lease directory and a fixture machine profile,
// with real sleep processes as the peer session, the worker and the orchestrator. Nothing listens on
// any port here: the bind probe is a stub that says so.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => {
  const g = typeof got === 'string' ? got : JSON.stringify(got); const w = typeof want === 'string' ? want : JSON.stringify(want);
  const ok = g === w; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${g}${ok ? '' : ` (want ${w})`}`);
};
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = scratch('port-lease-');
Object.assign(process.env, { HOME: S, DESK_CONFIG: join(S, 'none.md'), DESK_MACHINE: join(S, 'none-machine.md') });
const { psRows } = await import('../desk/bin/desk-env.mjs');
const { tryAcquire, list } = await import('../desk/bin/leases.mjs');
const P = await import('../desk/bin/port-lease.mjs');

// desk-env's exports as leases.mjs reads them, with the port kind in `mode`.
const envIn = (mode) => ({ machineValue: (k) => (k === 'lease-kinds' ? `port=${mode}` : null), testLockSlots: () => 2, psRows });
const ON = envIn('on'); const SHADOW = envIn('shadow'); const OFF = envIn('off');
let n = 0;
const fresh = () => join(S, `d${n++}`);
const F = 47801;
const owners = [];
const owner = () => { const c = spawn('sleep', ['300'], { stdio: 'ignore' }); owners.push(c); return c; };
const exited = (c) => new Promise((r) => { if (c.exitCode !== null || c.signalCode !== null) r(); else c.once('exit', r); });
// A lease on `port` held by `pid`, as another session takes one.
const hold = (dir, port, pid, label = 'peer session acme/shop') => tryAcquire({ kind: 'port', key: String(port), units: 1, ttl: 3600, label, pid, final: true }, { env: ON, dir, mode: 'on' }).lease;
const pick = (dir, env, more = {}) => P.pickPort({ env, dir, taken: new Set(), inUse: async () => false, floor: F, repo: 'acme/widgets', batch: 'B-1', key: 'T-1', ...more });
const logOf = (dir) => readFileSync(join(dir, 'leases.log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

try {
  // AC1: a port a peer leases is skipped though nothing listens on it.
  {
    const d = fresh(); const peer = owner(); hold(d, F, peer.pid);
    const r = await pick(d, ON);
    t('AC1: with the port kind on, a port a peer leases is not given out', r.port, F + 1);
    t('AC1: the port given out is leased to the pass', list({ env: ON, dir: d }).find((l) => l.key === String(F + 1))?.owner?.pid, process.pid);
  }
  // AC2: none of several workers is given a port in a peer's leased range.
  {
    const d = fresh(); const peer = owner();
    for (let p = F; p <= F + 3; p += 1) hold(d, p, peer.pid);
    const taken = new Set(); const got = [];
    for (const key of ['T-1', 'T-2', 'T-3']) {
      const r = await pick(d, ON, { key, taken });
      got.push(r.port); taken.add(r.port);
    }
    t('AC2: three workers are given ports outside the peer\'s range', got, [F + 4, F + 5, F + 6]);
  }
  // AC3 and AC4: the lease moves to the worker, with its repo, batch and ticket, and lapses when it exits.
  {
    const d = fresh(); const worker = owner();
    const r = await pick(d, ON, { key: 'T-3' });
    const why = P.handToWorker({ env: ON, dir: d, id: r.lease, port: r.port, workerPid: worker.pid, label: P.workerLabel('acme/widgets', 'B-1', 'T-3') });
    const l = list({ env: ON, dir: d }).find((x) => x.key === String(r.port));
    t('AC3: the hand-over succeeds', why, null);
    t('AC3: the lease list shows the worker\'s port held by the worker, with its repo, batch and ticket', `${l?.owner?.pid === worker.pid} ${l?.label} ${l?.ttl}`, `true acme/widgets B-1 T-3 ${P.WORKER_TTL}`);
    worker.kill(); await exited(worker);
    const next = await pick(d, ON, { key: 'T-4' });
    t('AC4: once the worker exits, its port is free for the next pass', next.port, r.port);
  }
  // AC5: a resumed worker gets its previous port back while it is free and unleased, and not otherwise.
  {
    const d = fresh();
    t('AC5: a free, unleased previous port is given back', (await pick(d, ON, { own: F + 2 })).port, F + 2);
    const peer = owner(); hold(d, F + 5, peer.pid);
    t('AC5: a previous port a peer has leased since is not', (await pick(d, ON, { own: F + 5, key: 'T-2' })).port, F);
  }
  // AC6: a lease whose owner has exited no longer blocks its port, and the report says it was dropped.
  {
    const d = fresh(); const peer = owner(); hold(d, F, peer.pid, 'peer session gone');
    peer.kill(); await exited(peer);
    const r = await pick(d, ON);
    t('AC6: a stale holder\'s port is given out', r.port, F);
    t('AC6: the report says the stale holder was dropped', r.notes.some((l) => l.startsWith(`ports: dropped the stale lease on port ${F} held by peer session gone (pid ${peer.pid}): owner exited`)), true);
  }
  // AC7: with the kind off, the pick is the legacy one and nothing is leased.
  {
    const d = fresh(); const peer = owner(); hold(d, F, peer.pid);
    const before = readFileSync(join(d, 'leases.json'), 'utf8');
    const r = await pick(d, OFF, { taken: new Set([F + 1]) });
    t('AC7: with the kind off, the legacy rule picks (the leased port, past only what the queues hold)', `${r.port} ${r.lease}`, `${F} null`);
    t('AC7: and the lease store is untouched', readFileSync(join(d, 'leases.json'), 'utf8'), before);
  }
  // AC8: in shadow, the legacy pick stands and the log records the would-refuse naming both.
  {
    const d = fresh(); const peer = owner(); hold(d, F, peer.pid);
    const r = await pick(d, SHADOW, { key: 'T-8' });
    t('AC8: in shadow, the worker gets the port the peer leases', r.port, F);
    const w = logOf(d).find((e) => e.event === 'would-refuse');
    t('AC8: the log records a would-refuse naming the peer session and the worker', `${w?.key} ${w?.label} | ${w?.holders?.map((h) => h.label).join(',')}`, `${F} acme/widgets B-1 T-8 | peer session acme/shop`);
  }
  // AC9: an unreadable store falls back to the legacy rule and says so.
  {
    const d = fresh(); const peer = owner(); hold(d, F, peer.pid);
    writeFileSync(join(d, 'leases.json'), '{not json');
    const r = await pick(d, ON);
    t('AC9: an unreadable store picks by the legacy rule', `${r.port} ${r.lease}`, `${F} null`);
    t('AC9: and the report says leases were unreadable', r.notes.some((l) => l.startsWith('ports: leases were unreadable (')), true);
  }
  // The orchestrator's range: its own pass hands a range port's lease to the worker; another batch skips it.
  {
    const d = fresh(); const orch = owner(); const worker = owner();
    const label = P.rangeLabel('acme/widgets', 'B-1');
    const o = P.leaseRange({ env: ON, dir: d, from: F, to: F + 2, owner: orch.pid, label });
    t('range: each free port in the range is leased to the orchestrator', o.leased, [F, F + 1, F + 2]);
    const mine = await pick(d, ON, { key: 'T-1' });
    t('range: its own pass gives a worker the range\'s first port, taking over that port\'s lease', `${mine.port} ${mine.lease === list({ env: ON, dir: d }).find((l) => l.key === String(F))?.id}`, `${F} true`);
    P.handToWorker({ env: ON, dir: d, id: mine.lease, port: mine.port, workerPid: worker.pid, label: P.workerLabel('acme/widgets', 'B-1', 'T-1') });
    const other = await pick(d, ON, { batch: 'B-2', key: 'X-1' });
    t('range: another batch\'s pass skips the whole range', other.port, F + 3);
    const again = P.leaseRange({ env: ON, dir: d, from: F, to: F + 2, owner: orch.pid, label });
    t('range: renewing leaves the worker\'s port to the worker', `${again.renewed} | ${again.held.map((h) => `${h.port} ${h.label}`)}`, `${F + 1},${F + 2} | ${F} acme/widgets B-1 T-1`);
    t('range: with the kind off, nothing is leased', P.leaseRange({ env: OFF, dir: fresh(), from: F, to: F, owner: orch.pid, label }).leased, []);
  }
  t('spawnedPid reads spawn-worker.sh\'s pid', [P.spawnedPid('[spawn] ticket=T-1 pid=4242 port=3201 model=default session=x'), P.spawnedPid('[spawn] ticket=T-1 pid=? port=3201')], [4242, null]);

  // AC10 and AC11: the desk-autopilot handshake leases the range by the port kind's mode.
  const sk = readFileSync(join(root, 'skills/desk-autopilot/references/sharing-the-machine.md'), 'utf8');
  t('AC10: shadow or on leases the range for the Claude session before any worker spawns, and renews it',
    /\*\*Lease your port range at Stage 0b, before any worker spawns\*\*[\s\S]*\*\*`shadow` or `on`\*\*: lease the range for your own Claude session with\s+`~\/\.claude\/desk\/bin\/port-lease\.mjs range <from>-<to>`[\s\S]*at least every 30 minutes while the batch runs/.test(sk), true);
  t('AC11: off publishes the range as before and takes no lease', /\*\*`off`\*\*: publish your range at the handshake as before, and take no lease\./.test(sk), true);
} finally {
  for (const c of owners) c.kill();
}
console.log(fails ? `\n${fails} failed` : '\nall passed');
process.exit(fails ? 1 : 0);
