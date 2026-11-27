// suite: pass metrics (one line per pass, the collision warning over a series of lines)
// layer: L1
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { heldCounts, collisionStep, warningText, appendMetrics, readWarnings, metricsPath, STREAK_PASSES, parseSetupSteps, setupMedians, setupMediansText, repoStates } from '../desk/bin/pass-metrics.mjs';
import { checkin } from '../desk/bin/digest.mjs';
import { scratch } from './scratch.mjs';
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
const root = scratch('desk-metrics-');
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
// A pass that began before that check-in (08:05) and wrote its warning after it: the next one lists it.
appendMetrics(state, { ...idle, at: '2026-11-17T08:04:00.000Z', warned_at: '2026-11-17T08:06:00.000Z', warning: warningText(idle, 10) });
const d3 = await checkin({ times: ['08:00', '17:00'], now: new Date('2026-11-17T17:05:00'), dir, list: [{ slug: 'acme__widgets', batch: null, state, queue }], checkJira: () => null, promote: () => null });
t('AC4 a warning written after a check-in its pass began before is listed in the next one', readFileSync(d3.page, 'utf8').includes('H-1 (behind R-1 on src/a.ts)'), true);
// issue-1549 AC2: a ticket whose follow_on= did not read is listed under Warnings, with its raw text.
writeFileSync(queue, JSON.stringify({ batch: 'b', tickets: { 'F-3': { key: 'F-3', state: 'done', follow_on_unreadable: { raw: '{"x": 1}', error: 'not a JSON array', at: '2026-11-17T12:00:00.000Z' } } } }));
const d4 = await checkin({ times: ['08:00', '17:00'], now: new Date('2026-11-17T17:05:00'), dir: join(root, 'digest-f'), list: [{ slug: 'acme__widgets', batch: null, state, queue }], checkJira: () => null, promote: () => null });
const page4 = readFileSync(d4.page, 'utf8');
t('issue-1549 AC2 the digest lists an unreadable follow-on under Warnings', page4.slice(page4.indexOf('### Warnings')).includes('F-3: follow-on unreadable: {"x": 1}'), true);
writeFileSync(queue, JSON.stringify({ batch: 'b', tickets: {} }));
// DS-698: setup-worktree.sh's steps line, and a repo's medians per step over its new worktrees.
t('DS-698 AC1 the steps line reads as seconds per step', JSON.stringify(parseSetupSteps('[setup-worktree] done\n[setup-worktree] steps=config:1,checkout:3,install:40\n[setup-worktree] worktree=/w')), '{"config":1,"checkout":3,"install":40}');
t('DS-698 output with no steps line reads as null', parseSetupSteps('[setup-worktree] worktree=/w'), null);
const sm = join(root, 'state', 'setup__medians');
appendMetrics(sm, { at: '2026-11-20T09:00:00.000Z', setup: [{ key: 'A-1', kept: false, steps: { checkout: 2, install: 30 } }, { key: 'A-2', kept: true, steps: { checkout: 1 } }] });
appendMetrics(sm, { at: '2026-11-21T09:00:00.000Z', setup: [{ key: 'A-3', kept: false, steps: { checkout: 4, install: 90 } }, { key: 'A-4', kept: false, steps: { checkout: 3, install: 70 } }] });
appendMetrics(sm, { at: '2026-11-21T10:00:00.000Z', setup: [] });
const med = setupMedians(sm);
t('DS-698 medians are over new worktrees only, kept ones counted apart', JSON.stringify([med.new, med.kept]), '[3,1]');
t('DS-698 the median per step', JSON.stringify(med.steps), '{"checkout":{"median":3,"max":4,"n":3},"install":{"median":70,"max":90,"n":3}}');
t('DS-698 the median total', med.total, 73);
t('DS-698 the report names the repo, the span and each step', setupMediansText('setup__medians', med).split('\n')[0], 'setup__medians: 3 new worktree setups, 2026-11-20 to 2026-11-21, median total 73s (1 kept, not counted)');
// A batch pass logs under <slug>/batches/<name>/: the repo's medians read its standing and named batches together.
const ar = join(root, 'ar');
appendMetrics(join(ar, 'acme__w'), { at: '2026-11-21T09:00:00.000Z', setup: [{ key: 'B-1', kept: false, steps: { install: 10 } }] });
appendMetrics(join(ar, 'acme__w', 'batches', 'B-9'), { at: '2026-11-20T09:00:00.000Z', setup: [{ key: 'B-2', kept: false, steps: { install: 30 } }] });
mkdirSync(join(ar, 'empty__repo'), { recursive: true });
appendMetrics(join(ar, 'acme__w', 'batches', '.done', 'B-5'), { at: '2026-11-19T09:00:00.000Z', setup: [{ key: 'B-3', kept: false, steps: { install: 50 } }] });
const rs = repoStates(ar);
t('DS-698 each repo lists its standing, named and archived batches, and a repo with no metrics is left out', JSON.stringify(rs.map((r) => [r.slug, r.states.length])), '[["acme__w",3]]');
const am = setupMedians(rs[0].states);
t('DS-698 a repo\'s medians cover its named and archived batches, spanning all of them', JSON.stringify([am.new, am.steps.install.median, am.from.slice(0, 10), am.to.slice(0, 10)]), '[3,30,"2026-11-19","2026-11-21"]');
t('DS-698 a repo with no setups says so', setupMediansText('x', setupMedians(join(root, 'state', 'none'))), 'x: no new worktree setups recorded');

const bad = join(root, 'bad');
mkdirSync(metricsPath(bad), { recursive: true });
t('AC3 a metrics file that cannot be written says why, and throws nothing', appendMetrics(bad, idle).ok, false);

rmSync(root, { recursive: true, force: true });
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
