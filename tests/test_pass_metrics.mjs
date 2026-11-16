// suite: pass metrics (one line per pass, the collision warning over a series of lines)
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { heldCounts, collisionStep, warningText, appendMetrics, readWarnings, metricsPath, STREAK_PASSES } from '../desk/bin/pass-metrics.mjs';
import { checkin } from '../desk/bin/digest.mjs';
let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(got)}${ok ? '' : ` (want ${JSON.stringify(want)})`}`); };

// A pass's line: `c` tickets held on a collision, `r` of 8 slots running.
const collisions = [{ key: 'H-1', with: ['R-1'], files: ['src/a.ts'] }];
const line = (c, r) => ({ at: '2026-11-16T10:00:00.000Z', running: r, concurrency: 8, held: heldCounts({ collision: c }), collisions: c ? collisions : [] });
// Folds a series of lines, as passes do through the queue's `pass` record: the passes that warned.
const run = (series, from = {}) => {
  let prev = from;
  const warned = [];
  series.forEach((l, i) => { const s = collisionStep(prev, l); if (s.warn) warned.push(i + 1); prev = s; });
  return { warned, last: prev };
};
const idle = line(1, 1);

t('AC4 nine passes in a row give no warning', run(Array(9).fill(idle)).warned.length, 0);
t('AC4 the 10th pass in a row gives the warning', run(Array(10).fill(idle)).warned.join(','), String(STREAK_PASSES));
t('AC4 the warning names the held tickets and the files holding them', warningText(idle, 10),
  '10 passes in a row held tickets on a collision while 1 of 8 worker slots ran: H-1 (behind R-1 on src/a.ts)');
t('AC5 the condition holding for 25 passes warns once', run(Array(25).fill(idle)).warned.join(','), '10');
t('AC6 a clear pass restarts the count from one', run([...Array(9).fill(idle), line(0, 1), ...Array(9).fill(idle)]).warned.length, 0);
t('AC6 and after the clear pass, the 10th in a row warns', run([...Array(9).fill(idle), line(0, 1), ...Array(10).fill(idle)]).warned.join(','), '20');
t('AC5/AC6 a warned streak that clears and holds again warns again', run([...Array(12).fill(idle), line(1, 2), ...Array(10).fill(idle)]).warned.join(','), '10,23');
t('2 of 8 running is 25%, not fewer: the condition does not hold', run(Array(10).fill(line(1, 2))).warned.length, 0);
t('no collision hold: the condition does not hold', run(Array(10).fill(line(0, 0))).warned.length, 0);
t('a batch at concurrency 0 is paused, never warned', run(Array(10).fill({ ...idle, concurrency: 0 })).warned.length, 0);
t('a warning whose line was not written is given on the next pass', collisionStep({ streak: 10, warned: false }, idle).warn, true);
t('AC2 tickets held for memory count under memory, not collision', JSON.stringify(heldCounts({ collision: 0, unspawned: 3, why: 'memory' })), '{"collision":0,"memory":3,"lock":0,"usage":0}');
t('a ticket left unspawned by full slots counts under no reason', JSON.stringify(heldCounts({ collision: 1, unspawned: 2, why: null })), '{"collision":1,"memory":0,"lock":0,"usage":0}');

// The digest lists the warning a line carries, in its window, under its batch.
const root = mkdtempSync(join(tmpdir(), 'desk-metrics-'));
process.env.DESK_CONFIG_ROOT = join(root, 'cfg');
const state = join(root, 'state', 'acme__widgets');
const queue = join(root, 'q', 'acme__widgets', 'queue.json');
mkdirSync(join(root, 'q', 'acme__widgets'), { recursive: true });
writeFileSync(queue, JSON.stringify({ batch: 'b', tickets: {} }));
t('a line appends', appendMetrics(state, { ...idle, at: '2026-11-16T09:00:00.000Z' }).ok, true);
t('a warning line appends', appendMetrics(state, { ...idle, at: '2026-11-16T09:30:00.000Z', warning: warningText(idle, 10) }).ok, true);
writeFileSync(metricsPath(state), `${readFileSync(metricsPath(state), 'utf8')}{"at":"torn","warning\n`);
t('only the warning lines are read, a torn line skipped', readWarnings(state).length, 1);
const dir = join(root, 'digest');
const d = await checkin({ times: ['08:00', '17:00'], now: new Date('2026-11-16T17:05:00'), dir, list: [{ slug: 'acme__widgets', batch: null, state, queue }], checkJira: () => null, promote: () => null });
const page = readFileSync(d.page, 'utf8');
t('AC4 the check-in digest lists the warning once, under Warnings', page.split('H-1 (behind R-1 on src/a.ts)').length - 1, 1);
t('the page has a Warnings heading', page.includes('### Warnings'), true);
t('a warning is counted in the push', /1 warning\(s\)/.test(d.push?.text ?? ''), true);
const d2 = await checkin({ times: ['08:00', '17:00'], now: new Date('2026-11-17T08:05:00'), dir, list: [{ slug: 'acme__widgets', batch: null, state, queue }], checkJira: () => null, promote: () => null });
t('AC5 the next check-in does not list it again', readFileSync(d2.page, 'utf8').includes('H-1 (behind'), false);
const bad = join(root, 'bad');
mkdirSync(metricsPath(bad), { recursive: true });
t('AC3 a metrics file that cannot be written says why, and throws nothing', appendMetrics(bad, idle).ok, false);

rmSync(root, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
