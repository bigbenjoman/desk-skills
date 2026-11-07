// suite: bench report (each arm beside the Phase 0 baseline)
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseBaseline, loadBaseline, loadRun, renderReport, median, NO_BASELINE, NOT_SCORED } from '../desk/bin/bench-report.mjs';
import { report as phase0, figureLines, totalOf } from '../desk/bin/phase0-report.mjs';

let fails = 0;
const t = (name, got, want) => { const ok = got === want; if (!ok) fails++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${got}${ok ? '' : ` (want ${want})`}`); };

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'desk', 'bin', 'bench-report.mjs');
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'bench-report-test-')));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8' });

const tok = (uncached, cacheWrite, cacheRead, output) => ({ uncached, cacheWrite, cacheRead, output });
// A bench output folder as bench.mjs leaves it. `runs` maps task -> arm -> the run's result fields,
// or 'not run'.
function benchOut(name, runs) {
  const out = join(dir, name, 'bench-out');
  const set = join(dir, name, 'tasks.json');
  mkdirSync(join(out, 'runs'), { recursive: true });
  writeFileSync(set, JSON.stringify({ tasks: Object.keys(runs).map((id) => ({ id, prompt: `Ticket ${id}` })) }));
  const tasks = Object.entries(runs).map(([task, arms]) => ({ task, order: Object.keys(arms), runs: Object.entries(arms).map(([arm, r]) => {
    if (r === 'not run') return { arm, status: 'not run', why: 'stopped: the cap was reached', dir: null };
    const d = join(out, 'runs', `${task}.${arm}.k`);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'result.json'), JSON.stringify({ task, arm, ...r }));
    return { arm, status: r.status, dir: d };
  }) }));
  writeFileSync(join(out, 'run.json'), JSON.stringify({ seed: '7', tasks }));
  return { set, out };
}
const q = (account, points) => ({ account, before: 10, after: points == null ? null : 10 + points, points });

// Two arms over the same four tasks: opus accepts three, sonnet two, one sonnet run failed.
const twoArms = benchOut('two', {
  t1: { opus: { status: 'accepted', tokens: tok(100, 1000, 5000, 300), quota: q('ben', 2) }, sonnet: { status: 'accepted', tokens: tok(50, 500, 2000, 200), quota: q('ben', 1) } },
  t2: { opus: { status: 'accepted', tokens: tok(300, 3000, 7000, 500), quota: q('ben', 4) }, sonnet: { status: 'rejected', tokens: tok(9, 9, 9, 9), quota: q('ben', 1) } },
  t3: { opus: { status: 'accepted', tokens: tok(200, 2000, 6000, 400), quota: q('work', 3) }, sonnet: { status: 'failed', why: 'timed out', tokens: null, quota: q('ben', null) } },
  t4: { opus: { status: 'rejected', tokens: tok(1, 1, 1, 1), quota: q('ben', 5) }, sonnet: { status: 'accepted', tokens: tok(70, 700, 3000, 250), quota: q('ben', 2) } },
});
const blind = join(twoArms.out, 'blind');
mkdirSync(blind, { recursive: true });
writeFileSync(join(blind, 'joined.json'), JSON.stringify({ arms: { opus: { scores: [{ task: 't1', score: 4 }, { task: 't2', score: 5 }] }, sonnet: { scores: [{ task: 't1', score: 3 }] } }, left_out: [{ task: 't4', why: 'letter B has no score' }], no_change: [] }));

// A Phase 0 baseline as phase0-report.mjs prints it, its total section from its own renderer.
const header = phase0({ slug: 'o/r', batches: [], days: 7, now: Date.parse('2026-11-05T12:00:00.000Z'), ci: false, repo: null, root: null, installed: null,
  levers: { on: [], unknown: [] }, answered: {}, contract: null, memoryIndex: null });
const f = totalOf([]);
Object.assign(f, { tickets: 5, accepted: 4, accKnown: 3, accInput: 3_000_000, accOutput: 60_000, accCost: 12, fixTries: 6, quota: { 1762300000: { min: 0.2, max: 0.5 }, 1762900000: { min: 0, max: 0.1 } } });
const baselineText = [header[0], 'main checkout: …', '', 'batch DS-1:', '  per accepted ticket: 1 input tokens · 1 output tokens · $0.01 API-equivalent, over 1 of 1', '',
  'total:', ...figureLines(f, { ci: 'not read (--no-ci)', quotaMissing: 'unreadable' }).map((l) => `  ${l}`), '', 'Usage readings name no login.'].join('\n');
writeFileSync(join(twoArms.out, 'phase0-baseline.txt'), baselineText);

// The baseline's own figures, read from its total section and not a batch's.
const b = parseBaseline(baselineText);
t('the baseline date is its last day', b.date, '2026-11-05');
t('the baseline per accepted ticket', JSON.stringify(b.perTicket), '{"input":1000000,"output":20000,"over":3}');
t('the baseline repair cycles', b.fixTries, 1.5);
t('the baseline quota points add up its windows', b.quotaPoints, 40);
const empty = parseBaseline(header.join('\n'));
t('a baseline with nothing accepted says so', `${empty.perTicketWhy} ${empty.fixTries} ${empty.quotaPoints}`, 'no ticket accepted null null');
t('text that is not a baseline is refused', parseBaseline('hello\ntotal:\n').why, 'its first line is not a PHASE 0 BASELINE header');
t('median of an even count', median([4, 1, 3, 2]), 2.5);

// AC1 to AC3: the CLI writes report.md with both arms beside the baseline.
let r = run('--tasks', twoArms.set);
if (r.status !== 0) console.log(r.stderr);
t('the report runs', r.status, 0);
const text = readFileSync(join(twoArms.out, 'report.md'), 'utf8');
t('it prints where it wrote', r.stdout.includes(`report: ${join(twoArms.out, 'report.md')}`), true);
const row = (label) => text.split('\n').find((l) => l.startsWith(`| ${label} |`))?.split(' | ').slice(1).map((c) => c.replace(/ \|$/, ''));
t('AC1 one table holds both arms', text.includes('| Figure | Phase 0 baseline | opus | sonnet |'), true);
t('AC1 tasks accepted of tasks run, a failed run in neither', row('Tasks accepted, of tasks run').slice(1).join(' / '), '3 of 4 / 2 of 3');
t('AC1 runs failed', row('Runs failed (not counted)').slice(1).join(' / '), '0 / 1');
t('AC1 mean blind score', row('Mean blind score (1 to 5)').slice(1).join(' / '), '4.50 (2 scored) / 3.00 (1 scored)');
t('AC1 a left-out sheet is named', /1 sheet\(s\) left out.*t4 \(letter B has no score\)/.test(text), true);
t('AC2 median uncached input over accepted tasks only', row('Median uncached input tokens per accepted task').slice(1).join(' / '), '200 / 60');
t('AC2 median cache-write', row('Median cache-write tokens per accepted task').slice(1).join(' / '), '2,000 / 600');
t('AC2 median cache-read', row('Median cache-read tokens per accepted task').slice(1).join(' / '), '6,000 / 2,500');
t('AC2 median output', row('Median output tokens per accepted task').slice(1).join(' / '), '400 / 225');
t('AC2 quota points per accepted task, per account', row('Quota points per accepted task (median), per account').slice(1).join(' / '), 'ben: 3 · work: 3 / ben: 1.5');
t('AC2 quota used by every run, an unreadable one named', row('Quota points used by every run, per account').slice(1).join(' / '), 'ben: 11 · work: 3 / ben: 4, 1 run(s) unreadable');
t('AC3 the baseline is named with its date', text.includes(`Phase 0 baseline: the 7 day(s) to 2026-11-05, from ${join(twoArms.out, 'phase0-baseline.txt')}`), true);
t('AC3 baseline tokens per accepted ticket', `${row('Input tokens of all kinds per accepted task (median)')[0]} / ${row('Median output tokens per accepted task')[0]}`,
  '1,000,000 (mean over 3 ticket(s)) / 20,000 (mean over 3 ticket(s))');
t('AC3 baseline quota per accepted ticket', row('Quota points per accepted task (median), per account')[0], 'signed-in login: 10.00 (40 point(s) ÷ 4 accepted)');
t('AC3 baseline repair cycles per ticket', row('Repair cycles per ticket')[0], '1.50 (fix tries per accepted ticket)');
t('the arms\' input of all kinds is beside it', row('Input tokens of all kinds per accepted task (median)').slice(1).join(' / '), '8,200 / 3,160');
t('no verdict is given', /verdict|keep|drop/i.test(text), false);

// AC4: no baseline report.
rmSync(join(twoArms.out, 'phase0-baseline.txt'));
const run2 = loadRun(twoArms.out);
const none = renderReport({ out: twoArms.out, run: run2, joined: null, baseline: loadBaseline(join(twoArms.out, 'phase0-baseline.txt')) }).text;
const baseCol = none.split('## Arms')[1].split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Figure')).map((l) => l.split(' | ')[1]);
t('AC4 every baseline cell reads "no baseline"', baseCol.length > 5 && baseCol.every((c) => c === NO_BASELINE), true);
t('AC4 and the report says how to produce one', none.includes(`node ~/.claude/desk/bin/phase0-report.mjs --days 7 > ${join(twoArms.out, 'phase0-baseline.txt')}`), true);
writeFileSync(join(dir, 'not-a-baseline.txt'), 'something else\n');
const bad = loadBaseline(join(dir, 'not-a-baseline.txt'));
t('AC4 a file that is not a baseline is no baseline', !bad.ok && /is not a Phase 0 baseline report/.test(bad.why), true);

// AC6: scores not joined yet.
t('AC6 the score reads "not scored"', none.split('\n').find((l) => l.startsWith('| Mean blind score')), `| Mean blind score (1 to 5) | ${NO_BASELINE} | ${NOT_SCORED} | ${NOT_SCORED} |`);
t('AC6 and the report says how to score', /Blind scores: not scored\. Score the sheets/.test(none), true);
t('an arm with no joined scores is not scored', renderReport({ out: 'x', run: run2, joined: { arms: { opus: { scores: [{ task: 't1', score: 2 }] } } }, baseline: { ok: false, why: 'x', path: 'p' } })
  .text.split('\n').find((l) => l.startsWith('| Mean blind score')).endsWith(`| ${NOT_SCORED} |`), true);

// AC5: the cap stopped some runs before they ran.
const capped = benchOut('capped', {
  c1: { a: { status: 'accepted', tokens: tok(1, 2, 3, 4), quota: q('ben', 1) }, b: { status: 'accepted', tokens: tok(1, 2, 3, 4), quota: q('ben', 1) } },
  c2: { a: { status: 'rejected', tokens: tok(1, 2, 3, 4), quota: q('ben', 1) }, b: 'not run' },
  c3: { a: 'not run', b: 'not run' },
});
r = run('--tasks', capped.set);
t('AC5 the report runs', r.status, 0);
const c = readFileSync(join(capped.out, 'report.md'), 'utf8');
t('AC5 each run not made is listed as not run', ['- c2 (b): stopped: the cap was reached', '- c3 (a): stopped', '- c3 (b): stopped'].every((x) => c.includes(x)), true);
t('AC5 the task table shows it', c.includes('| c2 | rejected | not run |'), true);
t('AC5 no table puts the arms side by side', c.includes('| Figure | Phase 0 baseline | a | b |'), false);
t('AC5 and the report says why', c.includes('No comparison between arms: they did not run the same tasks (a ran 2, b ran 1)'), true);
t('AC5 each arm still stands beside the baseline', c.includes('### a') && c.includes('| Figure | Phase 0 baseline | a |') && c.includes('| Figure | Phase 0 baseline | b |'), true);
const sameSkip = benchOut('same-skip', { s1: { a: { status: 'accepted', tokens: tok(1, 1, 1, 1) }, b: { status: 'failed', tokens: null } }, s2: { a: 'not run', b: 'not run' } });
t('arms that ran the same tasks are compared, a failed run included', renderReport({ out: 'x', run: loadRun(sameSkip.out), joined: null, baseline: { ok: false, why: 'x', path: 'p' } }).compared, true);

t('no --tasks refuses', /--tasks is required/.test(run().stderr), true);
t('no run.json refuses, naming it', /cannot read the bench run/.test(run('--tasks', join(dir, 'nowhere', 'tasks.json')).stderr), true);
t('nothing is written beside a missing run', existsSync(join(dir, 'nowhere')), false);

if (fails) { console.log(`FAIL ${fails} check(s) failed`); process.exit(1); }
console.log('all bench report checks passed');
