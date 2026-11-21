// suite: leases (desk-env lease: acquire, refuse, wait, release, list, a lease lapsing when its owner exits or its time is up, shadow and off kinds, renew, Claude-session owners, force-release and reset)
// covers: desk/bin/leases.mjs desk/bin/dir-lock.mjs
// The real CLI against a scratch lease directory, with real child processes as owners. A reused pid is
// a live owner whose recorded start time is a fixture, and a lease's age is set by rewriting its times.
// Every kind is on unless a case says otherwise (with no lease-kinds row, every kind is shadow).
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { claudeAncestor, kindMode, leaseCli, listRow } from '../desk/bin/leases.mjs';
import { scratch } from './scratch.mjs';

let fails = 0;
const t = (name, got, want) => {
  const g = typeof got === 'string' ? got : JSON.stringify(got); const w = typeof want === 'string' ? want : JSON.stringify(want);
  const ok = g === w; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${g}${ok ? '' : ` (want ${w})`}`);
};
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = scratch('leases-');
let n = 0;
// A machine profile holding these Sizing rows, its path returned.
const machineWith = (rows) => {
  const p = join(S, `machine-${n++}.md`);
  writeFileSync(p, `## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n${Object.entries(rows).map(([k, v]) => `| \`${k}\` | \`${v}\` | test |`).join('\n')}\n`);
  return p;
};
const ALL_ON = 'port=on slot=on preview-build=on merge=on mem=on';
const ON = machineWith({ 'lease-kinds': ALL_ON });
const NO_MACHINE = join(S, 'no-machine.md');
const env = (extra = {}) => {
  const e = { ...process.env, HOME: S, DESK_MACHINE: ON, DESK_CONFIG: join(S, 'none.md'), ...extra };
  delete e.DESK_TEST_LOCK_SLOTS;
  return { ...e, ...extra };
};
// A fresh lease directory per case.
const fresh = () => join(S, `d${n++}`);
const cli = (dir, args, extra = {}) => {
  const r = spawnSync(process.execPath, [join(root, 'desk/bin/leases.mjs'), ...args], { encoding: 'utf8', env: env({ DESK_LEASE_DIR: dir, ...extra }) });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
// The same through desk-env's passthrough.
const deskEnv = (dir, args) => {
  const r = spawnSync(process.execPath, [join(root, 'desk/bin/desk-env.mjs'), 'lease', ...args], { encoding: 'utf8', cwd: S, env: env({ DESK_LEASE_DIR: dir }) });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
};
const cliAsync = (dir, args) => new Promise((resolve) => {
  const c = spawn(process.execPath, [join(root, 'desk/bin/leases.mjs'), ...args], { env: env({ DESK_LEASE_DIR: dir }) });
  let out = ''; let err = '';
  c.stdout.on('data', (d) => { out += d; }); c.stderr.on('data', (d) => { err += d; });
  c.on('close', (code) => resolve({ code, out: out.trim(), err: err.trim() }));
});
// A live owner process, killed at the end.
const owners = [];
const owner = () => { const c = spawn('sleep', ['300'], { stdio: 'ignore' }); owners.push(c); return c; };
const exited = (c) => new Promise((resolve) => { if (c.exitCode !== null || c.signalCode !== null) resolve(); else c.once('exit', resolve); });
const log = (dir) => (existsSync(join(dir, 'leases.log.jsonl')) ? readFileSync(join(dir, 'leases.log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const store = (dir) => JSON.parse(readFileSync(join(dir, 'leases.json'), 'utf8'));
const json = (dir) => cli(dir, ['list', '--json']).out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // AC1: a port lease is granted, and listed with its owner, TTL and expiry.
  {
    const d = fresh(); const a = owner();
    const r = deskEnv(d, ['acquire', 'port', '4101', '--ttl', '900', '--label', 'pass DS-1', '--pid', String(a.pid)]);
    t('AC1: acquire exits 0', r.code, 0);
    t('AC1: it prints a lease id', /^L-[0-9a-f]{10}$/.test(r.out), true);
    const [l] = json(d);
    t('AC1: the list shows the lease, its owner and TTL', `${l?.id === r.out} ${l?.kind} ${l?.key} ${l?.owner?.pid === a.pid} ${l?.ttl}`, 'true port 4101 true 900');
    t('AC1: it expires its TTL after it was acquired', Date.parse(l.expires) - Date.parse(l.acquired), 900_000);
    const plain = deskEnv(d, ['list']).out.split('\n');
    t('AC1: the plain list shows it too', plain[1], listRow(l));
    t('AC1: the plain list names the owner, TTL and expiry', plain[1].includes(`pid ${a.pid}`) && plain[1].includes('900s') && plain[1].includes(l.expires), true);
    t('AC1: the grant is logged with the store lock hold time', log(d).map((e) => `${e.event} ${e.id === r.out} ${Number.isInteger(e.hold_ms)}`), ['grant true true']);
  }

  // AC2: a second owner without waiting is refused, naming the holder.
  {
    const d = fresh(); const a = owner(); const b = owner();
    cli(d, ['acquire', 'port', '4101', '--ttl', '900', '--label', 'pass DS-1', '--pid', String(a.pid)]);
    const r = cli(d, ['acquire', 'port', '4101', '--ttl', '900', '--label', 'worker DS-2', '--pid', String(b.pid)]);
    t('AC2: exits 3', r.code, 3);
    t('AC2: names the holder\'s label and pid', r.err.includes('port 4101 is held by pass DS-1') && r.err.includes(`pid ${a.pid}`), true);
    t('AC2: the log records a refuse', log(d).map((e) => e.event), ['grant', 'refuse']);
    t('AC2: nothing was granted', json(d).length, 1);
  }

  // AC3: a waiter gets the lease once the holder releases it within the wait.
  {
    const d = fresh(); const a = owner(); const b = owner();
    const id = cli(d, ['acquire', 'port', '4101', '--ttl', '900', '--pid', String(a.pid)]).out;
    const waiting = cliAsync(d, ['acquire', 'port', '4101', '--ttl', '900', '--wait', '10', '--label', 'waiter', '--pid', String(b.pid)]);
    await sleep(1000);
    const rel = cli(d, ['release', id, '--pid', String(a.pid)]);
    const r = await waiting;
    t('AC3: the release exits 0', rel.code, 0);
    t('AC3: the waiter is granted and exits 0', `${r.code} ${/^L-/.test(r.out)}`, '0 true');
    t('AC3: the waiter holds it now', json(d).map((l) => `${l.label} ${l.owner.pid === b.pid}`), ['waiter true']);
  }

  // AC4: a waiter whose wait runs out exits 75 holding nothing.
  {
    const d = fresh(); const a = owner(); const b = owner();
    cli(d, ['acquire', 'port', '4101', '--ttl', '900', '--label', 'holder', '--pid', String(a.pid)]);
    const t0 = Date.now();
    const r = cli(d, ['acquire', 'port', '4101', '--ttl', '900', '--wait', '4', '--pid', String(b.pid)]);
    t('AC4: exits 75', r.code, 75);
    t('AC4: after the 4 seconds', Date.now() - t0 >= 4000, true);
    t('AC4: says it gave up, naming the holder', r.err.startsWith('gave up after 4s waiting: port 4101 is held by holder'), true);
    t('AC4: it holds nothing', json(d).map((l) => l.owner.pid === b.pid), [false]);
    t('AC4: the log records it gave up', log(d).map((e) => e.event), ['grant', 'gave-up']);
  }

  // AC5: the counted heavy pool refuses a fourth slot while three are held.
  {
    const d = fresh(); const o = [owner(), owner(), owner(), owner()];
    const slots = { DESK_TEST_LOCK_SLOTS: '3' };
    const got = ['test', 'tsc', 'lint'].map((k, i) => cli(d, ['acquire', 'slot', k, '--ttl', '600', '--label', `${k} run`, '--pid', String(o[i].pid)], slots).code);
    t('AC5: test, tsc and lint each take a heavy slot', got, [0, 0, 0]);
    const r = cli(d, ['acquire', 'slot', 'test', '--ttl', '600', '--pid', String(o[3].pid)], slots);
    t('AC5: a fourth exits 3', r.code, 3);
    t('AC5: the message says all 3 heavy slots are held', r.err.includes('all 3 heavy slots are held'), true);
    t('AC5: the browser slot is its own pool', cli(d, ['acquire', 'slot', 'browser', '--ttl', '600', '--pid', String(o[3].pid)], slots).code, 0);
  }

  // AC6: a lease whose owner has exited lapses at the next command.
  {
    const d = fresh(); const a = owner();
    cli(d, ['acquire', 'port', '4102', '--ttl', '900', '--label', 'gone soon', '--pid', String(a.pid)]);
    a.kill(); await exited(a);
    t('AC6: the lease is gone from the list', json(d), []);
    const lapse = log(d).find((e) => e.event === 'lapse');
    t('AC6: the log has a lapse naming the owner and "owner exited"', `${lapse?.owner?.pid === a.pid} ${lapse?.label} ${lapse?.why}`, 'true gone soon owner exited');
    t('AC6: the port is free again', cli(d, ['acquire', 'port', '4102', '--ttl', '60', '--pid', String(owner().pid)]).code, 0);
  }

  // AC7: a lease whose pid now belongs to a later process lapses as if its owner exited.
  {
    const d = fresh(); const a = owner();
    cli(d, ['acquire', 'port', '4103', '--ttl', '900', '--label', 'old owner', '--pid', String(a.pid)]);
    const s = store(d); s.leases[0].owner.start = 'a process that started earlier';
    writeFileSync(join(d, 'leases.json'), JSON.stringify(s));
    t('AC7: the lease has lapsed', json(d), []);
    const lapse = log(d).find((e) => e.event === 'lapse');
    t('AC7: logged as its owner exited, naming the pid', `${lapse?.why} ${lapse?.owner?.pid === a.pid} ${String(lapse?.detail).startsWith(`pid ${a.pid} now belongs to a process started`)}`, 'owner exited true true');
  }

  // AC8: the owner releases by id and the key is free at once.
  {
    const d = fresh(); const a = owner(); const b = owner();
    const id = cli(d, ['acquire', 'merge', 'acme/widgets@main', '--ttl', '900', '--pid', String(a.pid)]).out;
    const other = cli(d, ['release', id, '--pid', String(b.pid)]);
    t('another process may not release it', `${other.code} ${other.err.includes('only its owner releases it')}`, '3 true');
    const r = cli(d, ['release', id, '--pid', String(a.pid)]);
    t('AC8: release exits 0', r.code, 0);
    t('AC8: the key is free at once', cli(d, ['acquire', 'merge', 'acme/widgets@main', '--ttl', '900', '--pid', String(b.pid)]).code, 0);
    t('AC8: the log records the release', log(d).map((e) => `${e.event}${e.event === 'release' ? ` ${e.id === id}` : ''}`), ['grant', 'release true', 'grant']);
  }

  // AC9: releasing an id the store does not hold changes nothing.
  {
    const d = fresh(); const a = owner();
    cli(d, ['acquire', 'port', '4104', '--ttl', '900', '--pid', String(a.pid)]);
    const before = `${readFileSync(join(d, 'leases.json'), 'utf8')}|${readFileSync(join(d, 'leases.log.jsonl'), 'utf8')}`;
    const r = cli(d, ['release', 'L-0000000000', '--pid', String(a.pid)]);
    t('AC9: exits 0, saying the lease was already gone', `${r.code} ${r.out}`, '0 lease L-0000000000 was already gone');
    t('AC9: the store and the log are unchanged', `${readFileSync(join(d, 'leases.json'), 'utf8')}|${readFileSync(join(d, 'leases.log.jsonl'), 'utf8')}` === before, true);
  }

  // AC10: the JSON list prints one object per lease, and the plain list the same rows.
  {
    const d = fresh(); const a = owner();
    cli(d, ['acquire', 'port', '4105', '--ttl', '900', '--label', 'dev server', '--pid', String(a.pid)]);
    cli(d, ['acquire', 'slot', 'browser', '--ttl', '300', '--label', 'capture', '--pid', String(a.pid)]);
    const lines = cli(d, ['list', '--json']).out.split('\n');
    const objs = lines.map((l) => JSON.parse(l));
    t('AC10: one JSON object per lease', objs.map((o) => `${o.kind} ${o.key}`), ['port 4105', 'slot browser']);
    t('AC10: each has its id, kind, key, units, owner, label, acquired time and expiry',
      objs.every((o) => ['id', 'kind', 'key', 'units', 'owner', 'label', 'acquired', 'expires'].every((k) => o[k] != null)), true);
    const plain = cli(d, ['list']).out.split('\n');
    t('AC10: the plain list shows the same rows', plain.slice(1), objs.map(listRow));
  }

  // AC11: an unknown kind or a missing TTL is a usage error that takes nothing.
  {
    const d = fresh(); const a = owner();
    const k = cli(d, ['acquire', 'socket', '4101', '--ttl', '900', '--pid', String(a.pid)]);
    t('AC11: an unknown kind exits 2, named', `${k.code} ${k.err.split('\n')[0]}`, '2 desk-env lease: unknown lease kind "socket": want one of port, slot, preview-build, merge, mem');
    const ttl = cli(d, ['acquire', 'port', '4101', '--pid', String(a.pid)]);
    t('AC11: no TTL exits 2, named', `${ttl.code} ${ttl.err.split('\n')[0]}`, '2 desk-env lease: acquire needs --ttl <seconds>');
    t('AC11: nothing was taken', existsSync(join(d, 'leases.json')), false);
  }

  // AC12: a store lock left by a holder that died over 10 seconds ago is cleared.
  {
    const d = fresh(); mkdirSync(d, { recursive: true });
    const lockDir = join(d, 'leases.json.lock');
    const old = new Date(Date.now() - 11_000);
    const dead = spawnSync('true').pid;
    mkdirSync(lockDir); writeFileSync(join(lockDir, 'pid'), `${dead}\n`); utimesSync(lockDir, old, old);
    const r = cli(d, ['list']);
    t('AC12: a dead holder\'s lock is cleared and the command completes', `${r.code} ${r.out}`, '0 no leases');
    // A pid since reused by a live process does not keep it either.
    const a = owner();
    mkdirSync(lockDir); writeFileSync(join(lockDir, 'pid'), `${a.pid}\n`); utimesSync(lockDir, old, old);
    const t0 = Date.now();
    const r2 = cli(d, ['acquire', 'port', '4106', '--ttl', '60', '--pid', String(a.pid)]);
    t('AC12: an old lock whose pid is alive is cleared at once', `${r2.code} ${Date.now() - t0 < 5000}`, '0 true');
    t('AC12: the lock is let go after', existsSync(lockDir), false);
  }

  // A live owner's lease survives a command run under another TZ (macOS reads start times with ps,
  // which prints local time).
  {
    const d = fresh(); const a = owner();
    cli(d, ['acquire', 'port', '4107', '--ttl', '60', '--pid', String(a.pid)], { TZ: 'Asia/Tokyo' });
    const r = cli(d, ['list', '--json'], { TZ: 'America/New_York' });
    t('a lease taken under one TZ is still live under another', r.out.split('\n').filter(Boolean).length, 1);
  }

  // The heavy pool is sized as the test lock sizes it: a DESK_TEST_LOCK_SLOTS that is not a whole
  // number is 1 slot, not the profile's.
  {
    const d = fresh(); const a = owner(); const b = owner();
    const machine = join(S, 'machine-slots.md');
    writeFileSync(machine, `## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| \`test-lock-slots\` | \`3\` | test |\n| \`lease-kinds\` | \`${ALL_ON}\` | test |\n`);
    const bogus = { DESK_MACHINE: machine, DESK_TEST_LOCK_SLOTS: 'many' };
    cli(d, ['acquire', 'slot', 'test', '--ttl', '60', '--pid', String(a.pid)], bogus);
    const r = cli(d, ['acquire', 'slot', 'tsc', '--ttl', '60', '--pid', String(b.pid)], bogus);
    t('a bad DESK_TEST_LOCK_SLOTS is one heavy slot', `${r.code} ${r.err.startsWith('refused: the heavy slot is held by')}`, '3 true');
    t('without it the profile sizes the pool', cli(d, ['acquire', 'slot', 'tsc', '--ttl', '60', '--pid', String(b.pid)], { DESK_MACHINE: machine }).code, 0);
  }

  // preview-build-slots is set with desk-env machine set, and sizes each Vercel team's pool.
  {
    const d = fresh(); const o = [owner(), owner(), owner()];
    const machine = join(S, 'machine-preview.md');
    const set = spawnSync(process.execPath, [join(root, 'desk/bin/desk-env.mjs'), 'machine', 'set', 'preview-build-slots=2', `lease-kinds=${ALL_ON}`], { encoding: 'utf8', cwd: S, env: env({ DESK_MACHINE: machine }) });
    t('machine set writes preview-build-slots', set.status, 0);
    const got = o.map((c) => cli(d, ['acquire', 'preview-build', 'acme', '--ttl', '600', '--pid', String(c.pid)], { DESK_MACHINE: machine }));
    t('two preview builds for a team, then refused', got.map((r) => r.code), [0, 0, 3]);
    t('the refusal names the pool', got[2].err.includes('all 2 preview-build slots for acme are held'), true);
  }

  // An unreadable store is exit 4 and left as it is.
  {
    const d = fresh(); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'leases.json'), '{ not json');
    const r = cli(d, ['list']);
    t('an unreadable store exits 4, named', `${r.code} ${r.err.includes('is unreadable')}`, '4 true');
    t('and is left as it is', readFileSync(join(d, 'leases.json'), 'utf8'), '{ not json');
  }

  // ---- shadow and off kinds, grace before a hard lapse, renew, Claude-session owners,
  // force-release and reset.
  // Makes lease `id` look taken (or last renewed) `s` seconds ago, its expiry its TTL after that.
  const age = (d, id, s) => {
    const st = store(d); const l = st.leases.find((x) => x.id === id);
    const at = Date.now() - s * 1000;
    l.acquired = new Date(at).toISOString(); l.expires = new Date(at + l.ttl * 1000).toISOString();
    writeFileSync(join(d, 'leases.json'), JSON.stringify(st));
  };
  const SHADOW_PORT = machineWith({ 'lease-kinds': 'port=shadow' });

  // AC1: with no lease-kinds row, every kind is shadow.
  {
    const d = fresh();
    const r = cli(d, ['mode'], { DESK_MACHINE: NO_MACHINE });
    t('DS-908 AC1: every kind reads as shadow', r.out.split('\n'), ['port\tshadow', 'slot\tshadow', 'preview-build\tshadow', 'merge\tshadow', 'mem\tshadow']);
    t('DS-908 AC1: one kind asked alone', cli(d, ['mode', 'merge'], { DESK_MACHINE: NO_MACHINE }).out, 'shadow');
    t('DS-908 AC1: and in-process', kindMode('mem', { machineValue: () => null }).mode, 'shadow');
    const a = owner(); const b = owner();
    cli(d, ['acquire', 'port', '4130', '--ttl', '900', '--pid', String(a.pid)], { DESK_MACHINE: NO_MACHINE });
    t('DS-908 AC1: so a second holder is granted', cli(d, ['acquire', 'port', '4130', '--ttl', '900', '--pid', String(b.pid)], { DESK_MACHINE: NO_MACHINE }).code, 0);
  }

  // AC2: in shadow a second holder is granted, and the log records the would-refuse naming both.
  {
    const d = fresh(); const a = owner(); const b = owner();
    const first = cli(d, ['acquire', 'port', '4101', '--ttl', '900', '--label', 'pass DS-1', '--pid', String(a.pid)], { DESK_MACHINE: SHADOW_PORT });
    const r = cli(d, ['acquire', 'port', '4101', '--ttl', '900', '--label', 'worker DS-2', '--pid', String(b.pid)], { DESK_MACHINE: SHADOW_PORT });
    t('DS-908 AC2: granted, exit 0, printing its id', `${r.code} ${/^L-[0-9a-f]{10}$/.test(r.out)}`, '0 true');
    t('DS-908 AC2: it says what on would have refused', r.err.startsWith('shadow: granted, but on would refuse: port 4101 is held by pass DS-1'), true);
    const w = log(d).find((e) => e.event === 'would-refuse');
    t('DS-908 AC2: the log records a would-refuse before the grant', log(d).map((e) => e.event), ['grant', 'would-refuse', 'grant']);
    t('DS-908 AC2: naming the holder and the new owner', `${w?.holders?.map((h) => `${h.label} ${h.owner.pid === a.pid} ${h.id === first.out}`)} | ${w?.label} ${w?.owner?.pid === b.pid}`, 'pass DS-1 true true | worker DS-2 true');
    t('DS-908 AC2: both leases are listed', json(d).length, 2);
  }

  // AC3: with the kind off, an acquire takes nothing and says so.
  {
    const d = fresh(); const a = owner();
    const r = cli(d, ['acquire', 'port', '4102', '--ttl', '900', '--pid', String(a.pid)], { DESK_MACHINE: machineWith({ 'lease-kinds': 'port=off slot=on' }) });
    t('DS-908 AC3: exits 0 printing no lease id', `${r.code} [${r.out}]`, '0 []');
    t('DS-908 AC3: says the kind is off', r.err, 'the port lease kind is off: nothing taken');
    t('DS-908 AC3: took nothing and logged nothing', `${existsSync(join(d, 'leases.json'))} ${existsSync(join(d, 'leases.log.jsonl'))}`, 'false false');
    t('DS-908 AC3: a bad key is still a usage error', cli(d, ['acquire', 'port', 'x', '--ttl', '900'], { DESK_MACHINE: machineWith({ 'lease-kinds': 'port=off' }) }).code, 2);
    const memOff = machineWith({ 'lease-kinds': 'mem=off' });
    const m = cli(d, ['acquire', 'mem', 'suite', '--ttl', '900', '--units', '4', '--pid', String(a.pid)], { DESK_MACHINE: memOff });
    t('an off mem kind takes nothing without a memory ceiling', `${m.code} ${m.err}`, '0 the mem lease kind is off: nothing taken');
    t('and renews nothing without one', cli(d, ['renew', 'L-00000000cc', 'mem', 'suite', '--ttl', '900', '--pid', String(a.pid)], { DESK_MACHINE: memOff }).code, 0);
  }

  // AC4: a live owner that has not renewed keeps its lease through its grace (1350s of a 900s TTL).
  {
    const d = fresh(); const a = owner(); const b = owner();
    const id = cli(d, ['acquire', 'port', '4103', '--ttl', '900', '--label', 'sleeper', '--pid', String(a.pid)]).out;
    age(d, id, 1350);
    const r = cli(d, ['acquire', 'port', '4103', '--ttl', '900', '--pid', String(b.pid)]);
    t('DS-908 AC4: refused inside the grace', `${r.code} ${r.err.startsWith('refused: port 4103 is held by sleeper')}`, '3 true');
  }

  // AC5: past twice its TTL (1801s of 900s) the lease hard-lapses, and the next acquire is granted.
  {
    const d = fresh(); const a = owner(); const b = owner();
    const id = cli(d, ['acquire', 'port', '4104', '--ttl', '900', '--label', 'hung', '--pid', String(a.pid)]).out;
    age(d, id, 1801);
    const r = cli(d, ['acquire', 'port', '4104', '--ttl', '900', '--pid', String(b.pid)]);
    t('DS-908 AC5: granted', r.code, 0);
    const lapse = log(d).find((e) => e.event === 'lapse');
    t('DS-908 AC5: the log records a hard lapse naming the owner', `${lapse?.id === id} ${lapse?.owner?.pid === a.pid} ${lapse?.label} ${lapse?.why}`, 'true true hung hard lapse');
  }

  // AC6: a slot whose owner still runs is never hard-lapsed (4000s of an 1800s TTL).
  {
    const d = fresh(); const a = owner(); const b = owner();
    const id = cli(d, ['acquire', 'slot', 'test', '--ttl', '1800', '--label', 'full suite', '--pid', String(a.pid)]).out;
    age(d, id, 4000);
    const r = cli(d, ['acquire', 'slot', 'test', '--ttl', '1800', '--pid', String(b.pid)]);
    t('DS-908 AC6: refused', `${r.code} ${r.err.startsWith('refused: the heavy slot is held by full suite')}`, '3 true');
    t('DS-908 AC6: the lease stays live', json(d).map((l) => `${l.id === id} ${l.owner.pid === a.pid}`), ['true true']);
    t('DS-908 AC6: nothing lapsed', log(d).some((e) => e.event === 'lapse'), false);
  }

  // AC7: a renew hands the lease to a new owner with a fresh expiry, and the old owner's exit no
  // longer lapses it.
  {
    const d = fresh(); const a = owner(); const b = owner();
    const id = cli(d, ['acquire', 'port', '4105', '--ttl', '900', '--label', 'handed', '--pid', String(a.pid)]).out;
    age(d, id, 800);
    const r = cli(d, ['renew', id, 'port', '4105', '--ttl', '900', '--pid', String(b.pid)]);
    t('DS-908 AC7: the renew exits 0', `${r.code} ${r.out.startsWith(`renewed port 4105 (lease ${id}) until`)}`, '0 true');
    const [l] = json(d);
    t('DS-908 AC7: the list shows the new owner', `${l?.id === id} ${l?.owner?.pid === b.pid}`, 'true true');
    t('DS-908 AC7: and a fresh expiry', Date.parse(l.expires) - Date.now() > 890_000, true);
    const renewed = log(d).find((e) => e.event === 'renew');
    t('DS-908 AC7: the log records the renew and the owner it had', `${renewed?.owner?.pid === b.pid} ${renewed?.was?.pid === a.pid}`, 'true true');
    a.kill(); await exited(a);
    t('DS-908 AC7: the old owner exiting does not lapse it', json(d).map((x) => x.id === id), [true]);
  }

  // AC8: renewing a lease the store has lost re-creates it, under the same id, where its key is free.
  {
    const d = fresh(); const a = owner();
    const r = cli(d, ['renew', 'L-00000000aa', 'port', '4106', '--ttl', '900', '--label', 'woke up', '--pid', String(a.pid)]);
    t('DS-908 AC8: exits 0, saying it was re-created', `${r.code} ${r.out.startsWith('re-created port 4106 (lease L-00000000aa), which the store no longer held')}`, '0 true');
    t('DS-908 AC8: the lease is back for that owner', json(d).map((l) => `${l.id} ${l.owner.pid === a.pid} ${l.label}`), ['L-00000000aa true woke up']);
    t('DS-908 AC8: the log says it was re-created', log(d).map((e) => `${e.event} ${e.id}`), ['re-create L-00000000aa']);
  }

  // AC9: renewing a lost lease whose key another owner now holds exits 3, naming that holder.
  {
    const d = fresh(); const a = owner(); const c = owner();
    cli(d, ['acquire', 'port', '4107', '--ttl', '900', '--label', 'newcomer', '--pid', String(c.pid)]);
    const r = cli(d, ['renew', 'L-00000000bb', 'port', '4107', '--ttl', '900', '--pid', String(a.pid)]);
    t('DS-908 AC9: exits 3', r.code, 3);
    t('DS-908 AC9: names the other holder', r.err.includes('port 4107 is held by newcomer') && r.err.includes(`pid ${c.pid}`), true);
    t('DS-908 AC9: nothing was re-created', json(d).map((l) => l.owner.pid === c.pid), [true]);
    t('a renew names the lease\'s own kind and key', cli(d, ['renew', json(d)[0].id, 'port', '4108', '--ttl', '900', '--pid', String(c.pid)]).code, 2);
  }

  // AC10: a lease owned by the Claude session outlives the shell command that took it. A symlink named
  // claude to node stands in for the claude binary; it runs the acquire through sh and stays up. The
  // shell has work after the acquire, so it forks rather than execs it: the session is two hops up,
  // and neither the caller's parent nor the default owner is the session.
  {
    const d = fresh();
    const bin = join(S, 'bin'); mkdirSync(bin, { recursive: true });
    const claude = join(bin, 'claude');
    if (!existsSync(claude)) symlinkSync(process.execPath, claude);
    const cmd = `"${process.execPath}" "${join(root, 'desk/bin/leases.mjs')}" acquire port 4109 --ttl 900 --label session --owner claude; s=$?; exit $s`;
    const code = `const r = require('child_process').spawnSync('/bin/sh', ['-c', ${JSON.stringify(cmd)}], { encoding: 'utf8' }); console.log(JSON.stringify({ code: r.status, out: r.stdout.trim(), err: r.stderr.trim() })); setInterval(() => {}, 1000);`;
    const session = spawn(claude, ['-e', code], { env: env({ DESK_LEASE_DIR: d }), stdio: ['ignore', 'pipe', 'ignore'] });
    owners.push(session);
    const said = await new Promise((resolve) => { let buf = ''; session.stdout.on('data', (x) => { buf += x; if (buf.includes('\n')) resolve(JSON.parse(buf)); }); });
    t('DS-908 AC10: the acquire exits 0', `${said.code} ${/^L-/.test(said.out)}`, '0 true');
    t('DS-908 AC10: the lease is owned by the Claude session, after the shell command exited', json(d).map((l) => `${l.id === said.out} ${l.owner.pid === session.pid}`), ['true true']);
    session.kill(); await exited(session);
    t('DS-908 AC10: it lapses once the session exits', json(d), []);
  }

  // AC11: with no Claude Code process above the caller, --owner claude refuses. The process tree is a
  // fixture, since this suite may itself run under Claude Code.
  {
    const d = fresh(); const lines = [];
    const tree = [{ pid: process.pid, ppid: 900, args: 'node leases.mjs' }, { pid: 900, ppid: 901, args: '/bin/zsh -l' }, { pid: 901, ppid: 1, args: '/usr/sbin/sshd' }];
    const fakeEnv = { machineValue: (k) => (k === 'lease-kinds' ? ALL_ON : null), testLockSlots: () => 1, psRows: () => tree };
    const code = leaseCli(['acquire', 'port', '4110', '--ttl', '900', '--owner', 'claude'], { env: fakeEnv, dir: d, out: (s) => lines.push(s), err: (s) => lines.push(s) });
    t('DS-908 AC11: exits 2', code, 2);
    t('DS-908 AC11: says no Claude session was found above the caller', lines[0], 'desk-env lease: --owner claude: no Claude session was found above the caller');
    t('DS-908 AC11: nothing was taken', existsSync(join(d, 'leases.json')), false);
    const npm = [{ pid: 10, ppid: 11, args: 'sh -c x' }, { pid: 11, ppid: 12, args: 'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume' }, { pid: 12, ppid: 1, args: '/opt/homebrew/bin/claude' }];
    t('the nearest Claude Code ancestor is found, an npm install run under node included', claudeAncestor(npm, 10), 11);
    const deep = [{ pid: 20, ppid: 21, args: 'node leases.mjs' }, { pid: 21, ppid: 22, args: '/bin/sh -c x' }, { pid: 22, ppid: 23, args: 'npm run test' }, { pid: 23, ppid: 1, args: '/Users/me/.local/bin/claude --resume' }];
    t('a Claude session behind several other processes is found', claudeAncestor(deep, 20), 23);
    const linked = [{ pid: 30, ppid: 31, args: 'sh -c x' }, { pid: 31, ppid: 1, args: 'node /opt/homebrew/bin/claude' }];
    t('an npm install run through its claude link on the PATH is found', claudeAncestor(linked, 30), 31);
    const spaced = [{ pid: 50, ppid: 51, args: 'sh -c x' }, { pid: 51, ppid: 52, args: 'node /opt/Desk Tools/lib/node_modules/@anthropic-ai/claude-code/cli.js --resume' }, { pid: 52, ppid: 53, args: 'sh -c y' }, { pid: 53, ppid: 1, args: 'node --max-old-space-size=4096 /opt/Desk Tools/bin/claude' }];
    t('an npm install under a prefix holding a space is found, by its entry point', claudeAncestor(spaced, 50), 51);
    t('and by its claude link', claudeAncestor(spaced, 52), 53);
    t('node running some other script is not a session', claudeAncestor([{ pid: 60, ppid: 61, args: 'x' }, { pid: 61, ppid: 1, args: 'node /usr/lib/node_modules/npm/bin/npm-cli.js run claude-docs' }], 60), null);
    const shell = [{ pid: 40, ppid: 41, args: 'node leases.mjs' }, { pid: 41, ppid: 1, args: 'sh -c /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js --version' }];
    t('a shell that only names the Claude Code entry point is not a session', claudeAncestor(shell, 40), null);
    t('a process is not its own Claude session', claudeAncestor([{ pid: 5, ppid: 1, args: 'claude' }], 5), null);
  }

  // AC12: a preview build with no owner lapses when its TTL passes, at the next lease command.
  {
    const d = fresh();
    const id = cli(d, ['acquire', 'preview-build', 'acme', '--ttl', '1200', '--label', 'DS-12 preview', '--no-owner']).out;
    t('DS-908 AC12: an ownerless preview build is granted', json(d).map((l) => `${l.id === id} ${l.owner}`), ['true null']);
    t('DS-908 AC12: only a preview build may have no owner', cli(d, ['acquire', 'port', '4111', '--ttl', '60', '--no-owner']).code, 2);
    age(d, id, 1201);
    t('DS-908 AC12: the next command lapses it', json(d), []);
    const lapse = log(d).find((e) => e.event === 'lapse');
    t('DS-908 AC12: the log names its label and "TTL passed"', `${lapse?.label} ${lapse?.why}`, 'DS-12 preview TTL passed');
  }

  // AC13: a forced release frees the key, prints the holder, and logs the holder and the reason.
  {
    const d = fresh(); const a = owner(); const b = owner();
    const id = cli(d, ['acquire', 'slot', 'test', '--ttl', '1800', '--label', 'hung suite', '--pid', String(a.pid)]).out;
    const r = cli(d, ['force-release', id, '--reason', 'suite hung for 3 hours']);
    t('DS-908 AC13: exits 0, printing who held it', `${r.code} ${r.out}`, `0 force-released slot test (lease ${id}), held by hung suite (pid ${a.pid}, lease ${id})`);
    t('DS-908 AC13: the key is free', cli(d, ['acquire', 'slot', 'test', '--ttl', '60', '--pid', String(b.pid)]).code, 0);
    const f = log(d).find((e) => e.event === 'force-release');
    t('DS-908 AC13: the log records the forced release, the holder and the reason', `${f?.id === id} ${f?.owner?.pid === a.pid} ${f?.label} | ${f?.reason}`, 'true true hung suite | suite hung for 3 hours');
  }

  // AC14: a forced release without a reason releases nothing.
  {
    const d = fresh(); const a = owner();
    const id = cli(d, ['acquire', 'port', '4112', '--ttl', '900', '--pid', String(a.pid)]).out;
    const r = cli(d, ['force-release', id]);
    t('DS-908 AC14: exits 2, asking for the reason', `${r.code} ${r.err.split('\n')[0]}`, '2 desk-env lease: force-release needs --reason <why>: the log keeps it beside the holder');
    t('DS-908 AC14: a blank reason is no reason', cli(d, ['force-release', id, '--reason', '  ']).code, 2);
    t('DS-908 AC14: the lease is still held', json(d).map((l) => l.id === id), [true]);
  }

  // AC15: an unreadable store refuses an acquire with exit 4, says to fall back, and is kept.
  {
    const d = fresh(); mkdirSync(d, { recursive: true }); const a = owner();
    writeFileSync(join(d, 'leases.json'), '{ not json');
    const r = cli(d, ['acquire', 'port', '4113', '--ttl', '900', '--pid', String(a.pid)]);
    t('DS-908 AC15: exits 4', r.code, 4);
    t('DS-908 AC15: says the store is unreadable and to fall back', r.err.includes('is unreadable') && r.err.includes('fall back to running without the lease'), true);
    t('DS-908 AC15: the file is kept for inspection', readFileSync(join(d, 'leases.json'), 'utf8'), '{ not json');
    t('a forced release needs a readable store too', cli(d, ['force-release', 'L-0000000000', '--reason', 'x']).code, 4);
  }

  // AC16: reset moves the unreadable store aside under a dated name and starts an empty one.
  {
    const d = fresh(); mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'leases.json'), '{ not json');
    t('reset needs a reason', cli(d, ['reset']).code, 2);
    const r = cli(d, ['reset', '--reason', 'store truncated by a crash']);
    t('DS-908 AC16: exits 0', r.code, 0);
    const aside = readdirSync(d).filter((f) => /^leases\.json\.unreadable-\d{4}-\d\d-\d\dT[\d-]+Z$/.test(f));
    t('DS-908 AC16: the bad file is moved aside under a dated name', aside.length === 1 && readFileSync(join(d, aside[0]), 'utf8'), '{ not json');
    t('DS-908 AC16: a fresh empty store is written', readFileSync(join(d, 'leases.json'), 'utf8').replace(/\s/g, ''), '{"leases":[]}');
    const reset = log(d).find((e) => e.event === 'reset');
    t('DS-908 AC16: the log records the reset and the reason', `${reset?.reason} ${reset?.moved_to === join(d, aside[0])}`, 'store truncated by a crash true');
    t('a reset of a store that reads is refused', cli(d, ['reset', '--reason', 'again']).code, 3);
  }

  // AC17: an unknown kind or mode in lease-kinds reads as shadow, and is named.
  {
    const d = fresh();
    const bad = machineWith({ 'lease-kinds': 'port=on sockets=on slot=maybe' });
    const r = cli(d, ['mode'], { DESK_MACHINE: bad });
    t('DS-908 AC17: a kind with an unknown mode reads as shadow, the known entry as set', r.out.split('\n').slice(0, 2), ['port\ton', 'slot\tshadow']);
    t('a kind set on and also to an unknown mode reads as shadow', kindMode('port', { machineValue: () => 'port=on port=maybe' }).mode, 'shadow');
    t('and so does one set to a mode that is not a word', kindMode('port', { machineValue: () => 'port=on port=on!' }).mode, 'shadow');
    t('DS-908 AC17: the entries it does not know are named', r.err, 'desk-env lease: the machine profile\'s `lease-kinds` names entries it does not know: "sockets=on", "slot=maybe": want <kind>=<mode> entries, kinds port, slot, preview-build, merge, mem and modes off, shadow, on');
  }
} finally {
  for (const c of owners) c.kill();
  rmSync(S, { recursive: true, force: true });
}

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
