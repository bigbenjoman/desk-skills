// suite: leases (desk-env lease: acquire, refuse, wait, release, list, and a lease lapsing when its owner exits)
// covers: desk/bin/leases.mjs desk/bin/dir-lock.mjs
// The real CLI against a scratch lease directory, with real child processes as owners. A reused pid is
// a live owner whose recorded start time is a fixture.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { listRow } from '../desk/bin/leases.mjs';

let fails = 0;
const t = (name, got, want) => {
  const g = typeof got === 'string' ? got : JSON.stringify(got); const w = typeof want === 'string' ? want : JSON.stringify(want);
  const ok = g === w; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${g}${ok ? '' : ` (want ${w})`}`);
};
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const S = mkdtempSync(join(tmpdir(), 'leases-'));
let n = 0;
const env = (extra = {}) => {
  const e = { ...process.env, HOME: S, DESK_MACHINE: join(S, 'no-machine.md'), DESK_CONFIG: join(S, 'none.md'), ...extra };
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
    writeFileSync(machine, '## Sizing\n\n| Key | Value | Why |\n|---|---|---|\n| `test-lock-slots` | `3` | test |\n');
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
    const set = spawnSync(process.execPath, [join(root, 'desk/bin/desk-env.mjs'), 'machine', 'set', 'preview-build-slots=2'], { encoding: 'utf8', cwd: S, env: env({ DESK_MACHINE: machine }) });
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
} finally {
  for (const c of owners) c.kill();
  rmSync(S, { recursive: true, force: true });
}

if (fails) { console.log(`${fails} check(s) did not pass`); process.exit(1); }
console.log('all passed');
